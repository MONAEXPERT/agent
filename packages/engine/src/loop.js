// TaskLoop: the bounded plan → act → reflect → answer loop.
//
// Injectable think() and runTool() make it fully testable offline and
// provider-agnostic (any brain can drive it). Guarantees:
//   - every step emits progress (never silent)
//   - tool calls are policy-checked before execution
//   - budget degradation steers toward cheaper profiles
//   - corrective nudges repair malformed replies (max 3)
//   - forced conclusion when the step budget runs out (never hangs)

import { EventEmitter } from 'node:events';
import { Policy } from './policy.js';
import { Budget } from './budget.js';

const MAX_CORRECTIONS = 3;

// ── Brain-reply parsing ───────────────────────────────────────────
// The brain answers in one of three shapes:
//   {reasoning, tool, args}     → tools
//   {reasoning, answer}         → answer
//   plain text                  → text
// Valid JSON with the wrong shape → malformed (corrective nudge)
// Prose wrapping any of those   → detected via balanced-brace extraction
// Broken JSON with a readable answer → salvaged leniently (no raw JSON leaks)

/** Extract the balanced JSON object starting at `start` (escape-aware). */
export function extractBalancedJson(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/**
 * Lenient salvage: LLMs often emit a JSON answer with an unescaped quote
 * inside the string (e.g. German quotes), breaking strict parsing. Extract
 * the string value of `key` by scanning with escape awareness. Returns the
 * decoded string, or null when the field cannot be found.
 */
export function lenientStringField(text, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"');
  const m = re.exec(String(text || ''));
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '\\') out += '\\';
      else if (n === '"') out += '"';
      else out += (n ?? '');
      i += 2;
      continue;
    }
    if (c === '"') return out;
    out += c;
    i++;
  }
  return out !== '' ? out : null;
}

function classify(obj) {
  if (typeof obj.answer === 'string' && obj.answer.trim()) {
    return { kind: 'answer', answer: obj.answer.trim(), reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' };
  }
  if (typeof obj.text === 'string' && obj.text.trim()) {
    return { kind: 'text', text: obj.text.trim() };
  }
  // Multi-tool steps: {tool: [call, ...]} or {calls: [call, ...]}
  if (Array.isArray(obj.tool) && obj.tool.length && obj.tool.every((x) => x && typeof x.tool === 'string')) {
    return { kind: 'tools', calls: obj.tool.map((c) => ({ tool: c.tool, args: c.args || {}, reasoning: c.reasoning || '' })) };
  }
  if (Array.isArray(obj.calls) && obj.calls.length) {
    return { kind: 'tools', calls: obj.calls.map((c) => ({ tool: c.tool, args: c.args || {}, reasoning: c.reasoning || '' })) };
  }
  if (typeof obj.tool === 'string' && obj.tool) {
    return { kind: 'tools', calls: [{ tool: obj.tool, args: obj.args || {}, reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '' }] };
  }
  return { kind: 'malformed' };
}

/** Lenient brain-reply parser: fenced JSON, plain object, prose-wrapped, or bare text. */
export function parseBrainReply(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'empty' };

  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return o;
    } catch { /* not JSON */ }
    return null;
  };

  // Fenced blocks
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const o = tryParse(m[1]);
    if (o) return classify(o);
  }

  // Whole body is JSON (a bare array is never a valid reply → malformed)
  const whole = tryParse(t);
  if (whole) return classify(whole);

  // Embedded JSON in prose — balanced-brace scan for tool/answer objects
  for (const key of ['"tool"', '"answer"', '"calls"']) {
    let idx = 0;
    while ((idx = t.indexOf(key, idx)) !== -1) {
      const start = t.lastIndexOf('{', idx);
      if (start !== -1) {
        const json = extractBalancedJson(t, start);
        if (json) {
          const o = tryParse(json);
          if (o) {
            const c = classify(o);
            if (c.kind !== 'malformed') return c;
          }
        }
      }
      idx += key.length;
    }
  }

  // Lenient salvage: broken JSON (unescaped quotes) but a readable answer —
  // deliver the answer instead of leaking raw JSON.
  if (t.startsWith('{')) {
    const answer = lenientStringField(t, 'answer');
    if (answer !== null && answer.trim() !== '') {
      const reasoning = lenientStringField(t, 'reasoning');
      return { kind: 'answer', answer: answer.trim(), reasoning: reasoning ?? '' };
    }
  }

  return { kind: 'text', text: t };
}

export class TaskLoop extends EventEmitter {
  constructor({ think, runTool, policy, budget, maxSteps = 8, temperature = 0.4 } = {}) {
    super();
    this.thinkFn = think;
    this.runToolFn = runTool;
    this.policy = policy instanceof Policy ? policy : new Policy(null);
    this.budget = budget instanceof Budget ? budget : new Budget({});
    this.maxSteps = Math.min(16, Math.max(2, Number(maxSteps) || 8));
    this.baseTemperature = temperature;
  }

  /** Effective profile under budget pressure. */
  #profile(profile) {
    const level = this.budget.level();
    if (level === 'critical') return { profile: 'cheap', temperature: 0.3, reason: 'budget-critical' };
    if (level === 'eco' && profile !== 'cheap') return { profile: 'cheap', temperature: 0.3, reason: 'budget-eco' };
    return { profile: profile || 'standard', temperature: this.baseTemperature, reason: '' };
  }

  /**
   * Run one bounded task.
   *
   * @param {string} task            the user's request
   * @param {object} [opts]
   * @param {string} [opts.system]   system prompt prepended to the messages
   * @param {string} [opts.profile]  reasoning profile ('standard' | 'cheap' | 'complex')
   * @param {number} [opts.maxSteps] step budget for this run (clamped by constructor max)
   * @param {Function} [opts.conclude] async (messages) => finalText — called when the
   *                                 step budget runs out so the caller can force one
   *                                 last brain call ("never give up"); falls back to a
   *                                 static conclusion when absent or failing.
   */
  async run(task, { system, profile = 'standard', maxSteps, conclude } = {}) {
    const steps = Math.min(this.maxSteps, Number(maxSteps) || this.maxSteps);
    const usage = { input: 0, output: 0, total: 0, costUsd: 0 };
    const trace = [];
    let final = '';
    let corrections = 0;

    const messages = [];

    if (!this.budget.canRun()) {
      const s = this.budget.summary();
      this.emit('blocked', 'budget', s);
      return { answer: `Daily budget exhausted (${s.tokens} tokens, $${s.costUsd.toFixed(4)}). Budget resets tomorrow.`, steps: 0, usage, trace, blocked: 'budget', messages };
    }

    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(task) });

    for (let i = 0; i < steps; i++) {
      this.emit('step', i + 1, steps);

      const prof = this.#profile(profile);
      if (prof.reason) this.emit('profile', prof);

      let thinkRes;
      try {
        thinkRes = await this.thinkFn(messages, prof);
      } catch (err) {
        this.emit('error', err);
        return { answer: `Brain error: ${err.message}`, steps: i, usage, trace, blocked: 'error', messages };
      }
      const text = thinkRes?.text ?? '';
      if (thinkRes?.usage) {
        usage.input += thinkRes.usage.input || 0;
        usage.output += thinkRes.usage.output || 0;
        usage.total += thinkRes.usage.total || 0;
        usage.costUsd += thinkRes.usage.costUsd || 0;
        this.budget.spend(thinkRes.usage.total || 0, thinkRes.usage.costUsd || 0);
      }
      this.emit('think', text);

      const reply = parseBrainReply(text);

      if (reply.kind === 'answer') {
        final = reply.answer;
        trace.push({ kind: 'answer', summary: reply.answer.slice(0, 120) });
        break;
      }
      if (reply.kind === 'text') {
        final = reply.text;
        trace.push({ kind: 'answer', summary: reply.text.slice(0, 120) });
        break;
      }
      if (reply.kind === 'tools') {
        corrections = 0;
        const results = [];
        for (const call of reply.calls) {
          this.emit('tool', call.tool, call.args);
          const verdict = this.policy.check(call.tool, call.args);
          let out;
          if (!verdict.allowed) {
            out = { error: verdict.reason, policy: verdict.tier };
            this.emit('tool:denied', call.tool, verdict);
          } else {
            if (call.tool === 'shell') {
              const sv = this.policy.shellCheck(call.args.cmd || '');
              if (!sv.allowed) {
                out = { error: sv.reason, policy: sv.tier };
                this.emit('tool:denied', call.tool, sv);
              } else {
                out = await this.#runTool(call.tool, call.args);
              }
            } else {
              out = await this.#runTool(call.tool, call.args);
            }
          }
          results.push(`TOOL RESULT (${call.tool}):\n${JSON.stringify(out)}`);
          this.emit('tool:result', call.tool, out);
          trace.push({ kind: 'tool', tool: call.tool, summary: String(out?.error || 'ok').slice(0, 120) });
        }
        const anyFailed = results.some((r) => /"error"/.test(r));
        messages.push({ role: 'assistant', content: text });
        messages.push({
          role: 'user',
          content: results.join('\n\n') +
            (anyFailed ? '\n\nOne or more tools errored. Diagnose and retry with a different approach.' : '') +
            '\n\nREFLECT: if the goal is met, answer now. Otherwise take the next action.',
        });
        continue;
      }

      // Empty or malformed → corrective nudge
      const looksLikeAttempt = /"(tool|answer)"\s*:/.test(text);
      if (corrections >= MAX_CORRECTIONS) {
        final = text.trim() ? text : 'The brain produced no usable reply.';
        trace.push({ kind: 'forced', summary: 'max corrections reached' });
        break;
      }
      corrections++;
      this.emit('nudge', looksLikeAttempt ? 'malformed' : 'empty');
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: looksLikeAttempt
          ? 'Reply with ONLY one JSON object: {"reasoning":"...","tool":"name","args":{...}} or {"reasoning":"...","answer":"..."}, or plain text.'
          : 'Your reply was empty or not actionable. Give the final answer in plain text, or emit a JSON tool call.',
      });
    }

    // Step budget exhausted → never hang: force one last conclusion. The
    // caller may provide `conclude` to ask the brain itself for a final
    // summary (e.g. "no more tools, conclude now").
    if (!final) {
      const forced = { kind: 'forced' };
      if (typeof conclude === 'function') {
        try {
          const text = await conclude(messages);
          if (text && String(text).trim()) {
            final = String(text).trim();
            forced.summary = 'concluded by caller';
          }
        } catch { /* caller's conclude failed → static fallback */ }
      }
      if (!final) {
        final = 'The task hit its step limit. Review the trace for what was done.';
        forced.summary = 'step limit reached';
      }
      trace.push(forced);
    }

    this.emit('answer', final);
    return { answer: final, steps: trace.length, usage, trace, blocked: '', messages };
  }

  async #runTool(name, args) {
    try {
      return await this.runToolFn(name, args);
    } catch (err) {
      return { error: err.message };
    }
  }
}
