import { Provider, estimateTokens } from './provider.mjs';

export class GoogleProvider extends Provider {
  constructor(meta = {}) {
    super({ slug: 'google', name: 'Google AI', kind: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', ...meta });
  }
  body({ messages, system, temperature, maxTokens }) {
    return {
      contents: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }],
      })),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
  }
  async authenticate(credential) { await this.listModels(credential); return { ok: true, detail: 'Key accepted.' }; }
  async listModels(credential) {
    const data = await this.request(`${this.baseUrl}/models?key=${encodeURIComponent(credential)}`, { timeoutMs: 15000 });
    return (data.models || []).map(m => ({
      slug: String(m.name).replace(/^models\//, ''), displayName: m.displayName || m.name,
      family: 'Gemini', contextWindow: m.inputTokenLimit, maxOutput: m.outputTokenLimit,
    }));
  }
  async chat(req) {
    const started = Date.now();
    const url = `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(req.credential)}`;
    const data = await this.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body(req), signal: req.signal });
    const cand = data.candidates?.[0];
    return {
      text: (cand?.content?.parts || []).map(p => p.text || '').join(''),
      finishReason: (cand?.finishReason || 'STOP').toLowerCase(),
      usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
      latencyMs: Date.now() - started,
      model: req.model,
    };
  }
  async *stream(req) {
    const url = `${this.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.credential)}`;
    const res = await this.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body(req), signal: req.signal, stream: true });
    let usage = null, finish = 'stop', out = '';
    for await (const evt of this.readSse(res)) {
      const cand = evt.candidates?.[0];
      const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
      if (text) { out += text; yield { type: 'delta', text }; }
      if (cand?.finishReason) finish = String(cand.finishReason).toLowerCase();
      if (evt.usageMetadata) usage = { inputTokens: evt.usageMetadata.promptTokenCount ?? 0, outputTokens: evt.usageMetadata.candidatesTokenCount ?? 0 };
    }
    yield { type: 'usage', usage: usage || { inputTokens: 0, outputTokens: estimateTokens(out), estimated: true } };
    yield { type: 'done', finishReason: finish };
  }
}
