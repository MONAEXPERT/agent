// Configuration & credential management.
// IMPORTANT: only the agent.mona.expert API key lives locally.
// No LLM provider keys (OpenAI, Anthropic, etc.) are ever stored on this device.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.mona-agent');
const CRED_FILE = join(DIR, 'credentials.json');
const CONFIG_FILE = join(DIR, 'config.json');

// ── Cloud endpoints ───────────────────────────────────────────────
export const CLOUD = Object.freeze({
  base: process.env.MONA_CLOUD || 'https://agent.mona.expert',
  ws:   process.env.MONA_CLOUD_WS || null, // derived below if not set
  get wsUrl() {
    if (this.ws) return this.ws;
    const proto = this.base.startsWith('https') ? 'wss' : 'ws';
    return `${proto}://${new URL(this.base).host}/?role=device`;
  },
});

// ── Agent defaults ────────────────────────────────────────────────
export const DEFAULTS = Object.freeze({
  metricsIntervalMs: 10_000,
  reconnectMinMs:    1_000,
  reconnectMaxMs:    30_000,
  version:           '1.0.0',
});

// ── Credential management ─────────────────────────────────────────
export function loadCreds() {
  if (!existsSync(CRED_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CRED_FILE, 'utf8'));
    if (!raw.apiKey) return null;
    return { apiKey: raw.apiKey, agentId: raw.agentId || null };
  } catch {
    return null;
  }
}

export function saveCreds(creds) {
  mkdirSync(DIR, { recursive: true });
  const safe = { apiKey: creds.apiKey, agentId: creds.agentId || null };
  writeFileSync(CRED_FILE, JSON.stringify(safe, null, 2), { mode: 0o600 });
  return CRED_FILE;
}

export function requireCreds() {
  const c = loadCreds();
  if (!c?.apiKey) {
    process.stderr.write('No agent.mona.expert API key. Run: mona-agent login\n');
    process.exit(1);
  }
  return c;
}

// ── Local config (non-secret preferences) ─────────────────────────
export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

export const PATHS = Object.freeze({
  dir: DIR,
  creds: CRED_FILE,
  config: CONFIG_FILE,
});
