import { Provider, estimateTokens } from './provider.mjs';

/**
 * Local models. Modelled as an ordinary provider so a laptop GPU and a hosted
 * frontier model are the same kind of thing to routing, permissions and usage.
 * llama.cpp, vLLM and LM Studio all expose an OpenAI-shaped API — point
 * OpenAIProvider at their base URL and register it under a new slug.
 */
export class OllamaProvider extends Provider {
  constructor(meta = {}) {
    super({ slug: 'ollama', name: 'Ollama (local)', kind: 'local', requiresCredential: false, baseUrl: 'http://127.0.0.1:11434', ...meta });
  }
  async authenticate() { await this.listModels(); return { ok: true, detail: 'Local runtime reachable.' }; }
  async listModels() {
    const data = await this.request(`${this.baseUrl}/api/tags`, { timeoutMs: 5000 });
    return (data.models || []).map(m => ({ slug: m.name, displayName: m.name, family: m.details?.family || 'local' }));
  }
  body({ model, messages, system, temperature, maxTokens, stream }) {
    return {
      model, stream,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
      options: { temperature, num_predict: maxTokens },
    };
  }
  async chat(req) {
    const started = Date.now();
    const data = await this.request(`${this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body({ ...req, stream: false }), signal: req.signal,
    });
    return {
      text: data.message?.content || '',
      finishReason: data.done_reason || 'stop',
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      latencyMs: Date.now() - started,
      model: data.model || req.model,
    };
  }
  /** Ollama streams newline-delimited JSON rather than SSE. */
  async *stream(req) {
    const res = await this.request(`${this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body({ ...req, stream: true }), signal: req.signal, stream: true,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', out = '', usage = null, finish = 'stop';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        const text = evt.message?.content;
        if (text) { out += text; yield { type: 'delta', text }; }
        if (evt.done) { finish = evt.done_reason || 'stop'; usage = { inputTokens: evt.prompt_eval_count ?? 0, outputTokens: evt.eval_count ?? 0 }; }
      }
    }
    yield { type: 'usage', usage: usage || { inputTokens: 0, outputTokens: estimateTokens(out), estimated: true } };
    yield { type: 'done', finishReason: finish };
  }
}
