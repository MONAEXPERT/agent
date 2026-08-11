// HTTP API client — direct communication with the mona.expert control plane.
// Works alongside the WebSocket control channel. Use for:
//   - Sending chat messages and getting responses
//   - Executing tools directly  
//   - Testing connectivity
//   - Managing agent registration

import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

const UA = `mona-agent/${DEFAULTS.version}`;

// ── Generic fetch with auth ───────────────────────────────────────
async function apiFetch(apiKey, path, { method = 'GET', body, signal } = {}) {
  const url = CLOUD.base + path;
  const res = await fetch(url, {
    method,
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'user-agent': UA,
      'x-mona-agent': DEFAULTS.version,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ── Health check ──────────────────────────────────────────────────
export async function checkHealth(apiKey) {
  try {
    const res = await apiFetch(apiKey, '/health');
    const data = await res.json();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Verify API key ────────────────────────────────────────────────
export async function verifyKey(apiKey) {
  const res = await apiFetch(apiKey, '/v1/auth/verify', { method: 'GET' });
  return res.json();
}

// ── Send chat message ─────────────────────────────────────────────
export async function sendChat(apiKey, agentId, message) {
  const res = await apiFetch(apiKey, `/api/agents/${agentId}/chat`, {
    method: 'POST',
    body: { message },
  });
  return res.json();
}

// ── Execute tool directly via API ─────────────────────────────────
export async function execTool(apiKey, agentId, tool, args) {
  const res = await apiFetch(apiKey, `/api/agents/${agentId}/tool`, {
    method: 'POST',
    body: { tool, args },
  });
  return res.json();
}

// ── List agents ───────────────────────────────────────────────────
export async function listAgents(apiKey) {
  const res = await apiFetch(apiKey, '/api/agents');
  return res.json();
}

// ── Get agent status ──────────────────────────────────────────────
export async function getAgent(apiKey, agentId) {
  const res = await apiFetch(apiKey, `/api/agents/${agentId}`);
  return res.json();
}

// ── Stream reasoning from cloud (SSE) ─────────────────────────────
export async function think({ apiKey, messages, tools, onChunk, onUsage, signal }) {
  const res = await apiFetch(apiKey, '/v1/agent/think', {
    method: 'POST',
    body: { messages, tools, stream: true },
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return full;
        try {
          const j = JSON.parse(payload);
          if (j.delta) {
            full += j.delta;
            onChunk?.(j.delta);
          }
          if (j.usage) onUsage?.(j.usage);
        } catch {
          // Skip malformed keepalive lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

// ── Force connection test ─────────────────────────────────────────
export async function testConnection(apiKey) {
  const results = {};

  // 1. Health check
  log.info('Testing HTTP health...');
  results.health = await checkHealth(apiKey);

  // 2. Verify auth
  log.info('Verifying API key...');
  try {
    results.auth = await verifyKey(apiKey);
  } catch (err) {
    results.auth = { error: err.message };
  }

  // 3. List agents
  log.info('Listing agents...');
  try {
    results.agents = await listAgents(apiKey);
  } catch (err) {
    results.agents = { error: err.message };
  }

  return results;
}
