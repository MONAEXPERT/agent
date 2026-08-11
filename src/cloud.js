// All LLM reasoning happens remotely on agent.mona.expert.
// This client sends prompts/steps up and receives streamed reasoning back.
import { CLOUD } from './config.js';

async function apiFetch(path, { apiKey, method = 'POST', body } = {}) {
  const res = await fetch(CLOUD.base + path, {
    method,
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-mona-agent': '0.1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`cloud ${res.status}: ${t.slice(0, 200)}`);
  }
  return res;
}

export async function verifyKey(apiKey) {
  const res = await apiFetch('/v1/auth/verify', { apiKey, method: 'GET' });
  return res.json(); // { agentId, plan, ... }
}

// Stream reasoning tokens from the cloud brain. onChunk(text) called per token.
export async function think({ apiKey, messages, tools, onChunk }) {
  const res = await apiFetch('/v1/agent/think', {
    apiKey,
    body: { messages, tools, stream: true },
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        if (j.delta) onChunk?.(j.delta);
      } catch { /* ignore keepalive */ }
    }
  }
}
