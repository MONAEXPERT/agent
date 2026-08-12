import { Provider, estimateTokens } from './provider.mjs';

export class AnthropicProvider extends Provider {
  constructor(meta = {}) {
    super({ slug: 'anthropic', name: 'Anthropic', kind: 'cloud', baseUrl: 'https://api.anthropic.com/v1', ...meta });
  }
  headers(credential) {
    return { 'x-api-key': credential, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  }
  body({ model, messages, system, temperature, maxTokens, stream = false }) {
    return {
      model, max_tokens: maxTokens || 2048, temperature,
      ...(system ? { system } : {}),
      messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      stream,
    };
  }
  async authenticate(credential) { await this.listModels(credential); return { ok: true, detail: 'Key accepted.' }; }
  async listModels(credential) {
    const data = await this.request(`${this.baseUrl}/models`, { headers: this.headers(credential), timeoutMs: 15000 });
    return (data.data || []).map(m => ({ slug: m.id, displayName: m.display_name || m.id, family: 'Claude' }));
  }
  async chat(req) {
    const started = Date.now();
    const data = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(req.credential), body: this.body(req), signal: req.signal,
    });
    return {
      text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
      finishReason: data.stop_reason || 'end_turn',
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      latencyMs: Date.now() - started,
      model: data.model || req.model,
    };
  }
  async *stream(req) {
    const res = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(req.credential), body: this.body({ ...req, stream: true }), signal: req.signal, stream: true,
    });
    let inputTokens = 0, outputTokens = 0, finish = 'end_turn', out = '';
    for await (const evt of this.readSse(res)) {
      if (evt.type === 'message_start') inputTokens = evt.message?.usage?.input_tokens ?? 0;
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') { out += evt.delta.text; yield { type: 'delta', text: evt.delta.text }; }
      if (evt.type === 'message_delta') { outputTokens = evt.usage?.output_tokens ?? outputTokens; finish = evt.delta?.stop_reason || finish; }
      if (evt.type === 'error') yield { type: 'error', code: 'PROVIDER_ERROR', message: 'The provider ended the stream early.' };
    }
    yield { type: 'usage', usage: { inputTokens, outputTokens: outputTokens || estimateTokens(out), estimated: !outputTokens } };
    yield { type: 'done', finishReason: finish };
  }
}
