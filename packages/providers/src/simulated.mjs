import { Provider, estimateTokens } from './provider.mjs';

/**
 * Simulated provider — development and CI only.
 *
 * This is NOT a language model and never claims to be one. It exercises the full
 * gateway path (auth → policy → routing → streaming → usage → audit) without a
 * network or a paid key, so the platform can be tested end to end offline.
 *
 * Every response it produces is prefixed with a simulation banner, its models are
 * named "Simulated …", and `SIMULATED_PROVIDER_ENABLED=true` is refused at boot in
 * production (see assertProductionReady in @mona/core).
 */
const BANNER = '**Simulated response** — no language model was called. Routing, authentication, streaming and usage accounting are real.';

const MODELS = [
  { slug: 'mona-sim-fast',  displayName: 'Simulated · Fast',      family: 'Simulated', contextWindow: 32000,  maxOutput: 4096, msPerToken: 6 },
  { slug: 'mona-sim-long',  displayName: 'Simulated · Long context', family: 'Simulated', contextWindow: 200000, maxOutput: 8192, msPerToken: 14 },
  { slug: 'mona-sim-local', displayName: 'Simulated · On-device',  family: 'Simulated', contextWindow: 8000,   maxOutput: 2048, msPerToken: 22 },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Deterministic per-prompt jitter so repeated runs are reproducible in CI. */
function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function compose({ messages, system, model, agentName }) {
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const turn = messages.filter(m => m.role === 'user').length;
  const words = last.trim().split(/\s+/).filter(Boolean);
  const seed = seedOf(last);
  const lines = [BANNER, ''];

  if (/```|\bfunction\b|\bclass\b|\bdef \b|\bimport \b|=>/.test(last) || /\bcode\b|\brefactor\b|\bbug\b/i.test(last)) {
    lines.push(`Reading the ${words.length}-word request as a code question. A real model would answer here; the simulator returns a structured stand-in so Markdown, fenced blocks and syntax highlighting are exercised in the client.`, '');
    lines.push('```js');
    lines.push('// Echo of the routing decision that produced this response');
    lines.push(`const route = {`);
    lines.push(`  agent: ${JSON.stringify(agentName || 'unnamed')},`);
    lines.push(`  model: ${JSON.stringify(model)},`);
    lines.push(`  provider: 'simulated',`);
    lines.push(`  systemPrompt: ${system ? `${system.length} chars` : 'none'},`);
    lines.push(`  contextMessages: ${messages.length},`);
    lines.push('};');
    lines.push('```', '');
    lines.push('Set a provider key under **Security → Provider keys** and switch the agent to a live model to get a real answer.');
  } else if (/^\s*(hi|hello|hey|good (morning|evening))/i.test(last)) {
    lines.push(`Connected. This request travelled device → \`agent.mona.expert\` → policy check → provider adapter, and back over SSE.`, '');
    lines.push(`| Stage | Result |`, `| --- | --- |`, `| Agent credential | verified |`, `| Scope \`chat\` | granted |`, `| Provider | simulated |`, `| Model | \`${model}\` |`, '');
    lines.push('Ask something else, or run `/help` to see the command set.');
  } else if (/\?\s*$/.test(last.trim())) {
    lines.push(`That question reached turn ${turn} of this conversation with ${messages.length} messages in context.`, '');
    lines.push(`A live provider would answer it. The simulator confirms instead that:`, '');
    lines.push(`- the agent's credential passed verification`, `- the \`chat\` scope was granted`, `- \`${model}\` was selected by the routing policy`, `- usage for this request will appear on the dashboard within a second`);
  } else {
    lines.push(`Received ${words.length} words and ${last.length} characters across ${messages.length} context messages.`, '');
    lines.push(`Echoing the opening for verification: *${words.slice(0, 12).join(' ')}${words.length > 12 ? '…' : ''}*`, '');
    lines.push(`Latency for this response is synthetic (seed \`${seed.toFixed(4)}\`) so streaming behaviour looks realistic without a network call.`);
  }
  return lines.join('\n');
}

export class SimulatedProvider extends Provider {
  constructor() {
    super({ slug: 'simulated', name: 'Mona Simulator', kind: 'simulated', requiresCredential: false });
  }
  async authenticate() { return { ok: true, detail: 'Simulator needs no credential.' }; }
  async listModels() { return MODELS.map(({ msPerToken, ...m }) => m); }
  async healthCheck() { return { status: 'operational', latencyMs: 1 }; }

  async chat(req) {
    const started = Date.now();
    const text = compose(req);
    const spec = MODELS.find(m => m.slug === req.model) || MODELS[0];
    await sleep(120 + Math.floor(seedOf(text) * 260));
    return {
      text,
      finishReason: 'stop',
      usage: { inputTokens: estimateTokens(JSON.stringify(req.messages) + (req.system || '')), outputTokens: estimateTokens(text), estimated: true },
      latencyMs: Date.now() - started,
      model: spec.slug,
      simulated: true,
    };
  }

  async *stream(req) {
    const text = compose(req);
    const spec = MODELS.find(m => m.slug === req.model) || MODELS[0];
    await sleep(90 + Math.floor(seedOf(text) * 180));                 // time-to-first-token
    const chunks = text.match(/\s*\S+|\s+/g) || [text];
    for (const chunk of chunks) {
      if (req.signal?.aborted) { yield { type: 'done', finishReason: 'stopped' }; return; }
      await sleep(spec.msPerToken);
      yield { type: 'delta', text: chunk };
    }
    yield { type: 'usage', usage: { inputTokens: estimateTokens(JSON.stringify(req.messages) + (req.system || '')), outputTokens: estimateTokens(text), estimated: true } };
    yield { type: 'done', finishReason: 'stop' };
  }

  async embeddings({ input }) {
    const items = Array.isArray(input) ? input : [input];
    return {
      vectors: items.map(text => {
        const s = seedOf(String(text));
        return Array.from({ length: 32 }, (_, i) => Math.sin((i + 1) * s * Math.PI) / 2);
      }),
      usage: { inputTokens: items.reduce((n, t) => n + estimateTokens(t), 0), outputTokens: 0 },
    };
  }
}

export const SIMULATED_MODELS = MODELS;
