import { providerError, unavailable } from '@mona/core';

/**
 * Provider contract.
 *
 * The gateway knows only this interface. Adding Mistral, Bedrock or a private
 * enterprise endpoint means writing one adapter file and one registry line —
 * no routing, auth or usage code changes.
 *
 *   authenticate(credential) -> { ok, detail }
 *   listModels(credential)   -> ModelDescriptor[]
 *   chat(request)            -> ChatResult
 *   stream(request)          -> AsyncIterable<StreamChunk>
 *   embeddings(request)      -> { vectors, usage }
 *   healthCheck(credential)  -> { status, latencyMs }
 *
 * StreamChunk: { type: 'delta'|'usage'|'done'|'error', text?, usage?, finishReason?, code?, message? }
 */
export class Provider {
  /** @param {{slug:string,name:string,kind:'cloud'|'local'|'simulated',baseUrl?:string,requiresCredential?:boolean,timeoutMs?:number}} meta */
  constructor(meta) {
    this.slug = meta.slug;
    this.name = meta.name;
    this.kind = meta.kind || 'cloud';
    this.baseUrl = meta.baseUrl || '';
    this.requiresCredential = meta.requiresCredential !== false;
    this.timeoutMs = meta.timeoutMs || 120000;
  }
  async authenticate() { throw new Error(`${this.slug}: authenticate() not implemented`); }
  async listModels()   { throw new Error(`${this.slug}: listModels() not implemented`); }
  async chat()         { throw new Error(`${this.slug}: chat() not implemented`); }
  async *stream()      { throw new Error(`${this.slug}: stream() not implemented`); }
  async embeddings()   { throw providerError(`${this.name} does not offer embeddings.`); }
  async healthCheck(credential) {
    const started = Date.now();
    try { await this.listModels(credential); return { status: 'operational', latencyMs: Date.now() - started }; }
    catch (e) { return { status: 'degraded', latencyMs: Date.now() - started, detail: e.message }; }
  }

  /** Shared fetch with timeout, no retries on non-idempotent calls, no secret logging. */
  async request(url, { method = 'GET', headers = {}, body = null, signal = null, timeoutMs = this.timeoutMs, stream = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => controller.abort(new Error('client aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': 'Mona.Expert-Gateway/1.0', ...headers },
        body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw this.mapError(res.status, text);
      }
      return stream ? res : await res.json();
    } catch (e) {
      if (e?.status) throw e;
      if (String(e?.message).includes('timeout')) throw providerError(`${this.name} did not respond in time.`);
      if (String(e?.message).includes('aborted')) { const err = providerError('The request was cancelled.'); err.aborted = true; throw err; }
      throw unavailable(`${this.name} could not be reached.`, { internal: String(e?.message || e) });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Upstream errors are translated, never forwarded verbatim — bodies can echo keys. */
  mapError(status, rawBody) {
    let detail = '';
    try { const j = JSON.parse(rawBody); detail = j?.error?.message || j?.message || ''; } catch { detail = ''; }
    const safe = detail.replace(/(sk-[A-Za-z0-9_-]{6,}|Bearer\s+\S+)/g, '[redacted]').slice(0, 240);
    if (status === 401 || status === 403) return providerError(`${this.name} rejected the stored credential. Check the API key in Security → Provider keys.`);
    if (status === 404) return providerError(`${this.name} does not recognise that model.`);
    if (status === 429) { const e = providerError(`${this.name} is rate limiting this key. Try again shortly.`); e.status = 429; e.code = 'PROVIDER_RATE_LIMITED'; return e; }
    if (status >= 500) return unavailable(`${this.name} is currently unavailable.`, { internal: safe });
    return providerError(`${this.name} rejected the request${safe ? `: ${safe}` : '.'}`);
  }

  /** Line-oriented SSE reader shared by every streaming adapter. */
  async *readSse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data === '[DONE]') return;
            try { yield JSON.parse(data); } catch { /* skip non-JSON keep-alives */ }
          } else if (line.startsWith('event:')) {
            yield { __event: line.slice(6).trim() };
          }
        }
      }
    } finally { try { await reader.cancel(); } catch {} }
  }
}

export class ProviderRegistry {
  constructor() { this.map = new Map(); }
  register(provider) { this.map.set(provider.slug, provider); return this; }
  get(slug) {
    const p = this.map.get(slug);
    if (!p) throw providerError(`No adapter is registered for "${slug}".`);
    return p;
  }
  has(slug) { return this.map.has(slug); }
  list() { return [...this.map.values()]; }
}

/** Rough token estimate used only when a provider omits usage. Marked as estimated. */
export const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 3.8));
