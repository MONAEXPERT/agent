// Central config. IMPORTANT: only the agent.mona.expert API key lives locally.
// No OpenAI/Anthropic/etc. keys are ever stored on this device.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.mona-agent');
const FILE = join(DIR, 'credentials.json');

export const CLOUD = {
  base: process.env.MONA_CLOUD || 'https://agent.mona.expert',
  ws: process.env.MONA_CLOUD_WS || 'wss://agent.mona.expert/stream',
};

export function loadCreds() {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCreds(creds) {
  mkdirSync(dirname(FILE), { recursive: true });
  // Only the mona.expert API key + agent id. Never third-party LLM keys.
  const safe = { apiKey: creds.apiKey, agentId: creds.agentId || null };
  writeFileSync(FILE, JSON.stringify(safe, null, 2), { mode: 0o600 });
  return FILE;
}

export function requireKey() {
  const c = loadCreds();
  if (!c || !c.apiKey) {
    console.error('No agent.mona.expert API key. Run: mona-agent login');
    process.exit(1);
  }
  return c;
}

export const CRED_PATH = FILE;
