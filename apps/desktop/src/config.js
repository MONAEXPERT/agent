// Configuration & credential management.
// Supports:
//   - api.remoteagent.online (sngine-based cloud) — default
//   - Self-hosted Docker platform (port 4300)
//   - Custom control planes via RA_CLOUD / RA_CLOUD_WS
//
// IMPORTANT: only the remoteagent.online API key lives locally.
// No LLM provider keys (OpenAI, Anthropic, etc.) are ever stored on this device.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version.js';
import { createCredentialStore } from './credentials.js';
import { env, assertSecureEndpoint, assertSecureWs, DEFAULT_CLOUD_HOSTS } from '@remoteagent/engine';

const DIR = join(homedir(), '.remoteagent');
const CRED_FILE = join(DIR, 'credentials.json');
const CONFIG_FILE = join(DIR, 'config.json');

// ── Cloud endpoints ───────────────────────────────────────────────
//
// The endpoint guard (packages/engine/src/endpoints.js) is the single
// choke point for where this device dials out. It enforces, in order:
//   • TLS on every non-loopback connection (https/wss only)
//   • the remoteagent.online host allowlist — anything else must be
//     named explicitly via RA_CLOUD_ALLOWLIST (comma-separated, supports
//     *.domain wildcards)
//   • no credentials in URLs, no raw IP literals off-loopback
// A daemon that cannot trust its endpoint refuses to start.
const CLOUD_ALLOWLIST = Object.freeze([
  ...DEFAULT_CLOUD_HOSTS,
  ...String(env('CLOUD_ALLOWLIST') || '').split(',').map((s) => s.trim()).filter(Boolean),
]);

const baseUrl = assertSecureEndpoint(
  env('CLOUD') || 'https://api.remoteagent.online',
  { allowlist: CLOUD_ALLOWLIST }
);

// Auto-detect platform type from URL
function detectPlatform(url) {
  try {
    // hostname, not host: host includes the port (127.0.0.1:4300).
    const host = new URL(url).hostname;
    // Local control planes (Docker platform, local dev): localhost / 127.0.0.1 / :4300
    if (host === 'localhost' || host === '127.0.0.1' || url.includes(':4300')) return 'docker';
    // Sngine-based: api.remoteagent.online (and subdomains)
    return 'sngine'; // default
  } catch { return 'sngine'; }
}

const PLATFORM = detectPlatform(baseUrl);

export const CLOUD = {
  base:    baseUrl,
  ws:      env('CLOUD_WS') || null,
  platform: PLATFORM,

  get wsUrl() {
    if (this.ws) return assertSecureWs(this.ws, { allowlist: CLOUD_ALLOWLIST });
    const proto = this.base.startsWith('https') ? 'wss' : 'ws';
    const host = new URL(this.base).host;

    if (PLATFORM === 'docker') {
      // Loopback self-host keeps plaintext ws; any other host is wss
      // (the endpoint guard already forced https off-loopback above).
      return `${proto}://${host}/ws?type=agent`;
    }
    // Sngine: WebSocket relay on same host, port 4390
    // Nginx proxies /ws to localhost:4390
    return `${proto}://${host}/ws?role=device`;
  },

  // API paths — vary by platform
  get paths() {
    if (PLATFORM === 'docker') {
      return {
        verifyKey:  '/api/keys/verify',
        think:      '/api/llm/think',
        health:     '/health',
        agents:     '/api/agents',
        chat:       (id) => `/api/agents/${id}/chat`,
        toolExec:   (id) => `/api/agents/${id}/tool`,
        auditAnchor: '/api/agents/audit-anchor',
      };
    }
    // Sngine/remoteagent.online
    return {
      verifyKey:  '/api/v1/agent/verify',
      think:      '/api/v1/agent/think',
      toolResult: '/api/v1/agent/tool-result',
      health:     '/api/v1/mona/system',       // uses system endpoint as health check
      agents:     '/api/v1/mona/agents',
      chat:       (id) => `/api/v1/mona/agents/${id}/chat`,
      toolExec:   (id) => `/api/v1/mona/agents/${id}/tool`,
      auditAnchor: '/api/v1/agent/audit-anchor',
    };
  },
};

Object.freeze(CLOUD);

// ── Agent defaults ────────────────────────────────────────────────
export const DEFAULTS = Object.freeze({
  metricsIntervalMs: 10_000,
  reconnectMinMs:    1_000,
  reconnectMaxMs:    30_000,
  version:           VERSION,
});

// ── Credential management ─────────────────────────────────────────
const credentialStore = createCredentialStore({ homeDir: homedir(), allowFileFallback: true });

export function loadCreds() {
  return credentialStore.load();
}

export function saveCreds(creds) {
  credentialStore.save(creds);
  return CRED_FILE;
}

export function credentialStatus() {
  return credentialStore.metadata();
}

export function requireCreds() {
  const c = loadCreds();
  if (!c?.apiKey) {
    process.stderr.write('No remoteagent.online API key. Run: remoteagent login\n');
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
