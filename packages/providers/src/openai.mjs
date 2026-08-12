import { Provider, estimateTokens } from './provider.mjs';

/** OpenAI-compatible Chat Completions. Also the base for OpenRouter and any drop-in clone. */
export class OpenAIProvider extends Provider {
  constructor(meta = {}) {
    super({ slug: 'openai', name: 'OpenAI', kind: 'cloud', baseUrl: 'https://api.openai.com/v1', ...meta });
  }
  headers(credential) {
    return { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(this.extraHeaders || {}) };
  }
  body({ model, messages, system, temperature, maxTokens, stream = false }) {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    return { model, messages: msgs, temperature, max_tokens: maxTokens, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) };
  }
  async authenticate(credential) {
    await this.listModels(credential);
    return { ok: true, detail: 'Key accepted.' };
  }
  async listModels(credential) {
    const data = await this.request(`${this.baseUrl}/models`, { headers: this.headers(credential), timeoutMs: 15000 });
    return (data.data || []).map(m => ({ slug: m.id, displayName: m.id, family: (m.id.split('-')[0] || '').toUpperCase() }));
  }
  async chat(req) {
    const started = Date.now();
    const data = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(req.credential), body: this.body(req), signal: req.signal,
    });
    const choice = data.choices?.[0] || {};
    return {
      text: choice.message?.content || '',
      finishReason: choice.finish_reason || 'stop',
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, estimated: !data.usage },
      latencyMs: Date.now() - started,
      model: data.model || req.model,
    };
  }
  async *stream(req) {
    const res = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(req.credential), body: this.body({ ...req, stream: true }), signal: req.signal, stream: true,
    });
    let usage = null, finish = 'stop', out = '';
    for await (const evt of this.readSse(res)) {
      if (evt.usage) usage = { inputTokens: evt.usage.prompt_tokens ?? 0, outputTokens: evt.usage.completion_tokens ?? 0 };
      const d = evt.choices?.[0];
      if (d?.finish_reason) finish = d.finish_reason;
      const text = d?.delta?.content;
      if (text) { out += text; yield { type: 'delta', text }; }
    }
    yield { type: 'usage', usage: usage || { inputTokens: estimateTokens(JSON.stringify(req.messages)), outputTokens: estimateTokens(out), estimated: true } };
    yield { type: 'done', finishReason: finish };
  }
  async embeddings({ credential, model, input }) {
    const data = await this.request(`${this.baseUrl}/embeddings`, {
      method: 'POST', headers: this.headers(credential), body: { model, input },
    });
    return { vectors: (data.data || []).map(d => d.embedding), usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
  }
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor() {
    super({ slug: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' });
    this.extraHeaders = { 'http-referer': 'https://mona.expert', 'x-title': 'Mona.Expert' };
  }
}
