import { estimateTokens } from './sse.mjs';

/**
 * Simulated engine — development and CI only, never production
 * (assertProductionReady refuses SIMULATED_ENGINE_ENABLED=true in prod).
 *
 * It is NOT a language model. It exercises the full engine loop offline:
 * gateway auth  conversation history  engine call  tool_calls  command 
 * device  tool result  engine continuation  streaming  usage  audit.
 *
 * Tool-call trigger: a user message containing `tool: <name>` (e.g. `tool: sysinfo`)
 * issues one tool_call for the named device tool; the tool result is echoed into
 * the final answer. Everything else is a deterministic stand-in response.
 */
const BANNER = '**Simulated engine response** — no language model was called. Auth, the command loop, streaming and usage accounting are real.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

const TOOL_RE = /(?:^|\s)tool:\s*([a-z][a-z0-9_.-]*)/i;

function compose({ messages, system, agentName }) {
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const words = last.trim().split(/\s+/).filter(Boolean);
  const lines = [BANNER, ''];
  lines.push(`Received ${words.length} words across ${messages.length} context messages.`);
  lines.push(`Agent: **${agentName || 'unnamed'}** · system prompt: ${system ? `${system.length} chars` : 'none'}.`);
  lines.push('');
  lines.push(`The mona.expert engine would answer here and pick the model itself.`);
  lines.push(`Echo for verification: *${words.slice(0, 12).join(' ')}${words.length > 12 ? '…' : ''}*`);
  if (/hi|hello|hey/i.test(last)) {
    lines.push('', 'Connected end to end: device  gateway  engine  back. Try `tool: sysinfo` to run a real command on the device.');
  }
  return lines.join('\n');
}

function composeToolFollowup({ toolResult, messages }) {
  const lines = ['**Simulated engine** — tool executed on the device.', ''];
  lines.push('```');
  lines.push(String(toolResult).slice(0, 800));
  lines.push('```');
  return lines.join('\n');
}

export class SimulatedEngine {
  constructor({ log = null } = {}) { this.log = log; }
  get mode() { return 'simulated'; }
  get name() { return 'Mona Simulator (dev only)'; }

  async authenticate() { return { ok: true, detail: 'Simulated engine needs no key.' }; }

  async chat(req) {
    const started = Date.now();
    const text = compose(req);
    await sleep(80 + Math.floor(seedOf(text) * 200));
    return {
      text, finishReason: 'stop', model: 'mona-sim',
      usage: { inputTokens: estimateTokens(JSON.stringify(req.messages)), outputTokens: estimateTokens(text), estimated: true },
      latencyMs: Date.now() - started,
    };
  }

  async *stream(req) {
    // Tool-call turns: a "tool" role message means the engine is deciding what to do with a result.
    const hasToolResult = req.messages?.some(m => m.role === 'tool');
    const text = hasToolResult
      ? composeToolFollowup({ toolResult: req.messages.at(-1)?.content ?? '', messages: req.messages })
      : compose(req);

    // Issue one tool_call when the user explicitly asks for a device tool.
    if (!hasToolResult) {
      const last = [...req.messages].reverse().find(m => m.role === 'user')?.content || '';
      const m = TOOL_RE.exec(last);
      if (m && req.tools?.some(t => (t.name || t) === m[1])) {
        yield { type: 'tool_call', id: `sim-${Date.now()}`, tool: m[1], args: {} };
        return;
      }
    }

    await sleep(70 + Math.floor(seedOf(text) * 180));
    const chunks = text.match(/\s*\S+|\s+/g) || [text];
    for (const chunk of chunks) {
      if (req.signal?.aborted) { yield { type: 'done', finishReason: 'stopped' }; return; }
      await sleep(4);
      yield { type: 'delta', text: chunk };
    }
    yield { type: 'usage', usage: { inputTokens: estimateTokens(JSON.stringify(req.messages) + (req.system || '')), outputTokens: estimateTokens(text), estimated: true, model: 'mona-sim' } };
    yield { type: 'done', finishReason: 'stop', text };
  }
}
