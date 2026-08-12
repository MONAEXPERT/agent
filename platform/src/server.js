#!/usr/bin/env node
/**
 * agent.mona.expert — Platform Control Plane
 *
 * Manages Docker containers, API keys, LLM proxying, audit logging,
 * and serves the web dashboard. Agents connect via WebSocket.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';

import { initDB, startAutoSave } from './db.js';
import { Vault } from './vault.js';
import { ContainerManager } from './containers.js';
import { LLMProxy } from './llm-proxy.js';
import { AuditLog } from './audit.js';
import { AgentConnection } from './agent-connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4300;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// ── Init ──────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static dashboard
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// Init subsystems
const db = await initDB(DATA_DIR);
startAutoSave(30_000); // Auto-save every 30s
const vault = new Vault(db);
const containers = new ContainerManager(db);
const audit = new AuditLog(db);
const agentConn = new AgentConnection(wss, { vault, containers, audit });

// ── REST API ──────────────────────────────────────────────────────

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── API Keys ──────────────────────────────────────────────────────
app.get('/api/keys', (_req, res) => {
  const keys = vault.list().map(k => ({ id: k.id, provider: k.provider, label: k.label, masked: k.masked, created: k.created }));
  res.json(keys);
});

app.post('/api/keys', (req, res) => {
  const { provider, label, key } = req.body;
  if (!provider || !key) return res.status(400).json({ error: 'provider and key required' });
  const id = vault.add(provider, label || `${provider}-key`, key);
  audit.record('key:create', { provider, label, id });
  res.json({ id });
});

app.delete('/api/keys/:id', (req, res) => {
  const ok = vault.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'key not found' });
  audit.record('key:delete', { id: req.params.id });
  res.json({ ok: true });
});

// ── Agents (Container Management) ─────────────────────────────────
app.get('/api/agents', async (_req, res) => {
  const agents = await containers.list();
  res.json(agents);
});

app.post('/api/agents', async (req, res) => {
  const { name, model, systemPrompt, tools } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const agent = await containers.create({ name, model: model || 'openai/gpt-4o', systemPrompt, tools: tools || ['files', 'web', 'shell'] });
    audit.record('agent:create', { name, id: agent.id });
    res.json(agent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/start', async (req, res) => {
  try {
    await containers.start(req.params.id);
    audit.record('agent:start', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:id/stop', async (req, res) => {
  try {
    await containers.stop(req.params.id);
    audit.record('agent:stop', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    await containers.remove(req.params.id);
    audit.record('agent:delete', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/logs', async (req, res) => {
  try {
    const logs = await containers.logs(req.params.id, parseInt(req.query.tail) || 200);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat with agent ───────────────────────────────────────────────
app.post('/api/agents/:id/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    // Send message to agent via WebSocket, get response
    const reply = await agentConn.sendMessage(req.params.id, message);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LLM Proxy (direct, no agent) ──────────────────────────────────
app.post('/api/llm', async (req, res) => {
  const { provider, model, messages, temperature, maxTokens, keyId } = req.body;
  if (!provider || !messages) return res.status(400).json({ error: 'provider and messages required' });

  try {
    const result = await LLMProxy.call(vault, { provider, model, messages, temperature, maxTokens, keyId });
    audit.record('llm:call', { provider, model, messageCount: messages.length, tokenUsage: result.usage });
    res.json(result);
  } catch (err) {
    audit.record('llm:error', { provider, model, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Audit ─────────────────────────────────────────────────────────
app.get('/api/audit', (req, res) => {
  const { type, limit, offset } = req.query;
  const entries = audit.query({ type, limit: parseInt(limit) || 100, offset: parseInt(offset) || 0 });
  res.json(entries);
});

// ── System info ───────────────────────────────────────────────────
app.get('/api/system', async (_req, res) => {
  try {
    const info = await containers.systemInfo();
    const agents = await containers.list();
    res.json({
      docker: info,
      agentsRunning: agents.filter(a => a.status === 'running').length,
      agentsTotal: agents.length,
      keysStored: vault.list().length,
      uptime: process.uptime()
    });
  } catch (err) {
    res.json({ error: err.message, docker: false });
  }
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🧠 agent.mona.expert platform → http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
