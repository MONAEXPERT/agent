// Cloud API client — all LLM reasoning runs remotely on agent.mona.expert.
// Supports both sngine-based (agent.mona.expert) and Docker-based platforms.
// This device sends prompts up and receives streamed reasoning back.
// No LLM provider keys are ever stored or used locally.

import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

const UA = `mona-agent/${DEFAULTS.version}`;
const P = CLOUD.paths; // platform-aware API paths

// ── Generic API fetch ─────────────────────────────────────────────
async function apiFetch(path, { apiKey, method = 'POST', body, signal, headers: extraHeaders } = {}) {
  const url = CLOUD.base + path;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'content-type':  'application/json',
    'user-agent':    UA,
    'x-mona-agent':  DEFAULTS.version,
    ...(extraHeaders || {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Cloud API ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ── Verify API key ────────────────────────────────────────────────
export async function verifyKey(apiKey) {
  const res = await apiFetch(P.verifyKey, { apiKey, method: 'GET' });
  return res.json();
}

// ── Stream reasoning from cloud brain ─────────────────────────────
// Calls the cloud LLM endpoint and streams tokens back via SSE.
// onChunk(text)  — called per delta token
// onUsage(usage) — called with final token counts (if provided)
// Returns the full assembled response text.
export async function think({ apiKey, messages, tools, onChunk, onUsage, signal }) {
  const res = await apiFetch(P.think, {
    apiKey,
    body: { messages, tools, stream: true },
    signal,
  });

  // Handle both SSE streaming and plain JSON responses
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    // SSE streaming
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
            // Skip malformed or keepalive lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return full;
  }

  // Plain JSON response
  const data = await res.json();
  return data.content || data.text || JSON.stringify(data);
}

// ── Report tool result to cloud ───────────────────────────────────
export async function reportToolResult(apiKey, agentId, tool, result) {
  return apiFetch(P.toolResult, {
    apiKey,
    body: { agentId, tool, result },
  });
}

// ── Cloud task queue (sngine platform — device polls for work) ────
export async function pollTasks(apiKey) {
  const res = await apiFetch('/api/v1/agent/tasks', { apiKey, method: 'GET' });
  const data = await res.json();
  return data?.tasks || [];
}

export async function claimTask(apiKey, id) {
  return apiFetch('/api/v1/agent/tasks/claim', { apiKey, body: { id } });
}

export async function taskResult(apiKey, id, { result, steps }) {
  return apiFetch(`/api/v1/agent/tasks/${id}/result`, { apiKey, body: { result, steps } });
}

export async function postActivity(apiKey, type, detail, runId, agentId) {
  return apiFetch('/api/v1/agent/activity', { apiKey, body: { type, detail, runId, agentId } });
}
