import { unavailable, providerError } from './errors.mjs';
import { estimateTokens, readSse } from './sse.mjs';

/**
 * mona.expert AI engine — the ONLY brain in this system.
 *
 * The engine decides everything: which model to use, what an agent is allowed
 * to do, and what direction/execution commands to issue. The gateway sends it
 * conversation context plus the device's capabilities; the engine answers with
 * either text or tool_calls that the gateway relays to the device as commands.
 *
 * One credential exists for it — the mona.expert key — held server-side,
 * encrypted by the keyring, never sent to a device, never logged.
 *
 *   POST {base}/v1/think      body: { messages, system?, tools?, stream? }
 *   Authorization: Bearer <mona.expert key>
 *
 * Stream chunks (same shape for remote and simulated engines):
 *   { type: 'delta', text }
 *   { type: 'tool_call', id, tool, args }
 *   { type: 'usage', usage: { inputTokens, outputTokens, model?, estimated? } }
 *   { type: 'done', finishReason, text }
 */
export class EngineClient {
  constructor({ url, key, timeoutMs = 120000, log = null }) {
    this.url = String(url || '').replace(/\/$/, '');
    this.key = key || '';
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  get mode() { return 'remote'; }
  get name() { return 'mona.expert engine'; }

  async authenticate(keyOverride) {
    const key = keyOverride || this.key;
    if (!key) return { ok: false, detail: 'No mona.expert key is stored. Add it under Settings  Engine key.' };
    try {
      await this.request('/v1/health', { key, timeoutMs: 10000 });
      return { ok: true, detail: 'Engine reachable.' };
    } catch (e) { return { ok: false, detail: e.message }; }
  }

  async request(path, { method = 'GET', body = null, signal = null, timeoutMs = this.timeoutMs, stream = false, key = null } = {}) {
    if (!this.url) throw unavailable('The engine URL is not configured.');
    const authKey = key ?? this.key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(new Error('client aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(this.url + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mona.Expert-Gateway/2.0',
          ...(authKey ? { authorization: `Bearer ${authKey}` } : {}),
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw this.mapError(res.status, text);
      }
      return stream ? res : await res.json();
    } catch (e) {
      if (e?.status) throw e;
      if (String(e?.message).includes('timeout')) throw providerError('The mona.expert engine did not respond in time.');
      if (String(e?.message).includes('aborted')) { const err = providerError('The request was cancelled.'); err.aborted = true; throw err; }
      throw unavailable('The mona.expert engine could not be reached.', { internal: String(e?.message || e) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  mapError(status, rawBody) {
    let detail = '';
    try { const j = JSON.parse(rawBody); detail = j?.error?.message || j?.message || ''; } catch { detail = ''; }
    const safe = detail.replace(/(mona_[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g, '[redacted]').slice(0, 240);
    if (status === 401 || status === 403) return providerError(`The mona.expert engine rejected the stored key. ${safe}`);
    if (status === 429) { const e = providerError('The mona.expert engine is rate limiting this account.'); e.status = 429; return e; }
    if (status >= 500) return unavailable('The mona.expert engine is currently unavailable.', { internal: safe });
    return providerError(`The engine rejected the request${safe ? `: ${safe}` : '.'}`);
  }

  async chat(req) {
    const started = Date.now();
    const data = await this.request('/v1/think', {
      method: 'POST', body: this.body(req, false), signal: req.signal, key: req.credential,
    });
    return {
      text: data.text ?? data.content ?? '',
      finishReason: data.finish_reason || data.finishReason || 'stop',
      usage: data.usage || { inputTokens: estimateTokens(JSON.stringify(req.messages)), outputTokens: estimateTokens(data.text ?? ''), estimated: true },
      latencyMs: Date.now() - started,
      model: data.model || 'engine',
      toolCalls: data.tool_calls || data.toolCalls || null,
    };
  }

  async *stream(req) {
    const res = await this.request('/v1/think', {
      method: 'POST', body: this.body(req, true), signal: req.signal, stream: true, key: req.credential,
    });
    let full = '', finish = 'stop';
    for await (const evt of readSse(res)) {
      if (evt.type === 'tool_call' || evt.tool_call) {
        const tc = evt.type === 'tool_call' ? evt : evt.tool_call;
        yield { type: 'tool_call', id: tc.id || String(Date.now()), tool: tc.tool, args: tc.args || tc.arguments || {} };
        continue;
      }
      if (evt.type === 'delta' || typeof evt.delta === 'string') {
        const text = evt.type === 'delta' ? evt.text : evt.delta;
        full += text;
        yield { type: 'delta', text };
        continue;
      }
      if (evt.type === 'usage' || evt.usage) { yield { type: 'usage', usage: evt.usage }; continue; }
      if (evt.type === 'done') { finish = evt.finishReason || finish; continue; }
      if (typeof evt.done === 'boolean' && evt.done) { finish = evt.finish_reason || finish; continue; }
    }
    yield { type: 'done', finishReason: finish, text: full };
  }

  body({ messages, system, tools, stream, agentName, temperature, maxTokens }) {
    const b = { messages, stream };
    if (system) b.system = system;
    if (tools?.length) b.tools = tools;
    if (agentName) b.agent = agentName;
    if (temperature != null) b.temperature = temperature;
    if (maxTokens != null) b.max_tokens = maxTokens;
    return b;
  }
}
