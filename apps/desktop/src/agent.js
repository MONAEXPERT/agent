// Agent daemon runtime — the core loop.
// Receives commands from the website via the control channel,
// delegates reasoning to the cloud brain, executes local tools,
// and streams everything back.

import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { think, pollTasks, claimTask, taskResult, postActivity, runStart, runStep, runFinish } from './cloud.js';
import { ControlChannel } from './control.js';
import { tools } from './tools/index.js';
import { security as shellSecurity } from './tools/shell.js';
import { CLOUD } from './config.js';
import { log } from './log.js';

const MAX_ITERS = 8;         // max tool steps per task
const MAX_RETRIES = 3;       // transient failures (network, 429, 5xx)
const MAX_CORRECTIONS = 2;   // malformed/empty brain replies per task
const TASK_POLL_MS = 2000;   // sngine platform: poll the cloud task queue
const TOOL_OUT_MAX = 4000;   // chars of tool output fed back to the brain

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the persistent memory directory into a compact context block the
 * brain sees at task start — facts, preferences and lessons accumulate
 * across tasks and restarts. Capped to keep the prompt lean.
 */
export function loadMemoryContext(dir = process.env.MONA_MEMORY_DIR || join(homedir(), '.mona-agent', 'memory'), maxChars = 3000) {
  try {
    if (!existsSync(dir)) return '';
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    if (!files.length) return '';
    const parts = files.map((f) => {
      try {
        const raw = readFileSync(join(dir, f), 'utf8').trim();
        return raw ? `[${f}] ${raw.slice(0, 800)}` : '';
      } catch { return ''; }
    }).filter(Boolean);
    if (!parts.length) return '';
    const ctx = parts.join('\n').slice(0, maxChars);
    return `\n\n## Known context (persistent memory)\n${ctx}\n(Keep this up to date with the memory tool: save user preferences and important facts.)`;
  } catch { return ''; }
}
const RETRIABLE = /429|5\d\d|fetch failed|network|ECONN|ETIMEDOUT|socket|timeout/i;

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…(truncated)' : s;
}

/** Extract a {tool, args} JSON call from a model reply (plain, fenced, or with prose around it). */
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

/** Legacy parser: extract tool calls from a model reply. */
export function parseToolCall(text) {
  if (!text) return null;
  const bodies = [text];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) bodies.push(m[1]);
  for (const b of bodies) {
    const t = b.trim();
    // Single object
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.tool === 'string') return [o];
      if (Array.isArray(o) && o.length && o.every((x) => x && typeof x.tool === 'string')) return o;
    } catch { /* prose around it */ }
    let idx = 0;
    while ((idx = t.indexOf('"tool"', idx)) !== -1) {
      const start = t.lastIndexOf('{', idx);
      if (start !== -1) {
        const json = extractBalancedJson(t, start);
        if (json) {
          try {
            const o = JSON.parse(json);
            if (Array.isArray(o) && o.length && o.every((x) => x && typeof x.tool === 'string')) return o;
            if (o && typeof o === 'object' && typeof o.tool === 'string') return [o];
          } catch { /* keep scanning */ }
        }
      }
      idx += 5;
    }
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

/**
 * Reasoning-protocol parser: the brain answers in one of three shapes:
 *   {reasoning, tool, args}      → {kind:'tools',  calls:[...]}
 *   {reasoning, answer}          → {kind:'answer', answer, reasoning}
 *   plain text                   → {kind:'text',   text}
 *   valid JSON, wrong shape      → null (malformed → corrective nudge)
 *   prose wrapping any of those  → detected via balanced-brace extraction
 *   broken JSON with an answer   → salvaged leniently (no raw JSON leaks)
 */
export function parseBrainReply(text) {
  if (!text) return null;
  const bodies = [text];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) bodies.push(m[1]);

  const classify = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (Array.isArray(o.tool) && o.tool.length && o.tool.every((x) => x && typeof x.tool === 'string')) {
      return { kind: 'tools', calls: o.tool };
    }
    if (typeof o.tool === 'string') return { kind: 'tools', calls: [o] };
    if (typeof o.answer === 'string') {
      return { kind: 'answer', answer: o.answer, reasoning: typeof o.reasoning === 'string' ? o.reasoning : '' };
    }
    return null;
  };

  for (const b of bodies) {
    const t = b.trim();
    // Whole body is JSON
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        const c = classify(o);
        if (c) return c;
        return null; // valid JSON but not tool/answer shaped → malformed
      }
      if (Array.isArray(o)) return null; // a bare JSON array is never a valid reply
    } catch { /* scan for embedded JSON */ }

    // Scan for embedded tool objects
    let idx = 0;
    while ((idx = t.indexOf('"tool"', idx)) !== -1) {
      const start = t.lastIndexOf('{', idx);
      if (start !== -1) {
        const json = extractBalancedJson(t, start);
        if (json) {
          try {
            const c = classify(JSON.parse(json));
            if (c) return c;
          } catch { /* keep scanning */ }
        }
      }
      idx += 5;
    }
    // Scan for embedded answer objects
    let ai = 0;
    while ((ai = t.indexOf('"answer"', ai)) !== -1) {
      const start = t.lastIndexOf('{', ai);
      if (start !== -1) {
        const json = extractBalancedJson(t, start);
        if (json) {
          try {
            const c = classify(JSON.parse(json));
            if (c) return c;
          } catch { /* keep scanning */ }
        }
      }
      ai += 6;
    }
  }
  // Lenient salvage: broken JSON (unescaped quotes etc.) but a readable
  // answer field — deliver the answer instead of leaking raw JSON.
  if (text.trim().startsWith('{')) {
    const answer = lenientStringField(text, 'answer');
    if (answer !== null && answer.trim() !== '') {
      const reasoning = lenientStringField(text, 'reasoning');
      return { kind: 'answer', answer, reasoning: reasoning ?? '' };
    }
  }
  return { kind: 'text', text };
}

export class AgentDaemon extends EventEmitter {
  #creds;
  #control;
  #messages = [];
  #stats = { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 };
  #currentTask = null;
  #taskPoll = null;
  #polling = false;
  // Owner-configurable reasoning profile (set from the cloud per poll).
  #brain = { maxSteps: 8, temperature: 0.4, extraRules: '', verify: true };

  constructor(creds) {
    super();
    this.#creds = creds;

    this.#control = new ControlChannel(creds.apiKey, creds.agentId, {
      tools: tools.list(),
      shell: shellSecurity,
    });

    // Forward control events
    this.#control.on('connected',    ()    => this.emit('connected'));
    this.#control.on('disconnected', (c)   => this.emit('disconnected', c));
    this.#control.on('auth-failed',  (c)   => this.emit('auth-failed', c));
    this.#control.on('metrics',      (m)   => this.emit('metrics', m));
    this.#control.on('error',        (err) => this.emit('error', err));
    this.#control.on('command',      (cmd) => this.#onCommand(cmd));
  }

  /** Start the daemon — connect to cloud and begin accepting commands. */
  start() {
    log.info(`Agent starting`, { agentId: this.#creds.agentId });
    log.info(`Tools: ${tools.names().join(', ')}`);
    this.#control.connect();
    this.#startTaskPoll();
    return this;
  }

  get stats() { return { ...this.#stats }; }
  get currentTask() { return this.#currentTask; }
  get connected() { return this.#control.connected; }

  // ── Command dispatcher ──────────────────────────────────────────
  async #onCommand(cmd) {
    const { runId, action, payload } = cmd;
    try {
      switch (action) {
        case 'run':
          await this.#runTask(payload?.task, runId);
          break;

        case 'tool':
          await this.#runTool(payload?.tool, payload?.args, runId);
          break;

        case 'ping':
          this.#control.result(runId, { pong: true, ts: Date.now() });
          break;

        case 'reset':
          this.#messages = [];
          log.info('Conversation history cleared');
          this.#control.result(runId, { ok: true, action: 'reset' });
          break;

        default:
          log.warn(`Unknown action: ${action}`);
          this.#control.result(runId, { error: `Unknown action: ${action}` });
      }
    } catch (err) {
      this.#stats.errors++;
      log.error(`${action} failed: ${err.message}`);
      this.#control.result(runId, { error: err.message });
      this.emit('error', err);
    }
  }

  // ── Cloud task queue (sngine platform — no inbound WS) ──────────
  #startTaskPoll() {
    if (CLOUD.platform !== 'sngine' || this.#taskPoll) return;
    this.#taskPoll = setInterval(() => this.#pollTasks(), TASK_POLL_MS);
    this.#pollTasks();
  }

  async #pollTasks() {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const data = await pollTasks(this.#creds.apiKey);
      this.#mergeBrain(data.brain);
      const tasks = data.tasks || [];
      for (const t of tasks) {
        if (t.status !== 'pending') continue;
        // Multi-device claim: only the device that actually wins the claim runs
        // the task — the server answers claimed:false for everyone else.
        const claimRes = await claimTask(this.#creds.apiKey, t.id).catch(() => null);
        if (!claimRes) continue;
        let claim = null;
        try { claim = await claimRes.json(); } catch { /* non-JSON — treat as claimed */ }
        if (claim && claim.claimed === false) {
          log.info(`Task ${t.id} claimed by another device — skipping`);
          continue;
        }
        await this.#runTask(t.task, t.run_id, t);
      }
    } catch (err) {
      log.debug(`Task poll failed: ${err.message}`);
    } finally {
      this.#polling = false;
    }
  }

  /** Merge the owner's brain config from the cloud (clamped, safe defaults). */
  #mergeBrain(brain) {
    if (!brain || typeof brain !== 'object') return;
    if (Number.isFinite(+brain.maxSteps)) this.#brain.maxSteps = Math.min(16, Math.max(2, +brain.maxSteps));
    if (Number.isFinite(+brain.temperature)) this.#brain.temperature = Math.min(1, Math.max(0, +brain.temperature));
    if (typeof brain.extraRules === 'string') this.#brain.extraRules = brain.extraRules.slice(0, 2000);
    if (typeof brain.verify === 'boolean') this.#brain.verify = brain.verify;
    if (typeof brain.mode === 'string') this.#brain.mode = brain.mode;
  }

  // ── Task execution (cloud reasoning + local tools) ──────────────
  /** think() with auto-retry for transient failures — fail is never allowed. */
  async #thinkWithRetry(messages, runId, opts = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await think({
          apiKey:  this.#creds.apiKey,
          messages,
          tools:   tools.list(),
          temperature: opts.temperature ?? this.#brain.temperature,
          profile: opts.profile ?? null,
          onChunk: (delta) => {
            this.#control.token(delta, runId);
            this.emit('task:token', delta, runId);
          },
          onUsage: (usage) => this.emit('task:usage', usage),
        });
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const retriable = RETRIABLE.test(msg);
        log.warn(`Think attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
        await postActivity(this.#creds.apiKey, 'auto.retry', { attempt, error: msg.slice(0, 200) }, runId, this.#creds.agentId).catch(() => {});
        if (!retriable || attempt === MAX_RETRIES) throw err;
        await sleep(500 * attempt + Math.random() * 400);
      }
    }
    throw lastErr ?? new Error('think failed');
  }

  /** Report the result with retries so the cloud conversation is never left dangling. */
  async #reportResult(cloudTask, result, steps, extra = {}) {
    for (let a = 1; a <= 3; a++) {
      try {
        await taskResult(this.#creds.apiKey, cloudTask.id, { result, steps, ...extra });
        return;
      } catch (err) {
        log.warn(`Task result POST attempt ${a} failed: ${err.message}`);
        await sleep(800 * a);
      }
    }
    log.error('Could not report task result to cloud');
  }

  /** Auto-debug: capture a system snapshot when things go wrong. */
  async #debugSnapshot(runId, why) {
    try {
      const info = await tools.run('sysinfo', {});
      const uname = await tools.run('shell', { cmd: 'uname -a && which node && node -v' });
      await postActivity(this.#creds.apiKey, 'auto.debug', {
        why,
        sysinfo: truncate(JSON.stringify(info), 300),
        uname: truncate(JSON.stringify(uname), 300),
      }, runId, this.#creds.agentId).catch(() => {});
    } catch { /* never break the task for debugging */ }
  }

  async #runTask(task, runId, cloudTask = null) {
    if (!task) {
      this.#control.result(runId, { error: 'No task provided' });
      return;
    }

    this.#currentTask = { task, runId, startedAt: Date.now(), tokens: 0 };
    this.#control.step('task.start', { task, runId });
    this.emit('task:start', this.#currentTask);
    log.info(`Task: "${task.slice(0, 100)}"`);

    const steps = [];
    let final = '';
    const sngine = CLOUD.platform === 'sngine';
    // Per-task brain: the cloud decides mode-aware settings for each task
    // (auto = best of smart & cheap, computed server-side per task).
    const brain = {
      maxSteps: this.#brain.maxSteps,
      temperature: this.#brain.temperature,
      verify: this.#brain.verify,
      extraRules: this.#brain.extraRules,
      profile: null,
      ...(cloudTask?.brain || {}),
    };
    const t0 = Date.now();
    const usageTotals = { input: 0, output: 0, total: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 };
    let lastModel = '';
    let lastProvider = '';
    let traceStepNo = 0;

    // Best-effort deep-insight reporting — the loop never depends on it.
    const trace = async (kind, extra) => {
      if (!sngine || !runId) return;
      traceStepNo += 1;
      try {
        await runStep(this.#creds.apiKey, runId, { stepNo: traceStepNo, kind, ...extra });
      } catch (err) {
        log.debug(`runStep ${kind} failed: ${err.message}`);
      }
    };
    const addUsage = (u) => {
      if (!u) return;
      usageTotals.input += +u.input || 0;
      usageTotals.output += +u.output || 0;
      usageTotals.total += +u.total || 0;
      usageTotals.reasoning += +u.reasoning || 0;
      usageTotals.cacheRead += +u.cacheRead || 0;
      usageTotals.cacheCreation += +u.cacheCreation || 0;
    };

    if (sngine && runId) {
      try {
        await runStart(this.#creds.apiKey, {
          runId, agentId: this.#creds.agentId, taskId: cloudTask?.id ?? 0, message: task,
        });
      } catch (err) {
        log.debug(`runStart failed: ${err.message}`);
      }
    }

    try {
      if (CLOUD.platform === 'docker') {
        // Docker platform: single-shot LLM proxy over the control channel.
        this.#messages.push({ role: 'user', content: task });
        const res = await this.#control.llmRequest({ messages: this.#messages });
        final = res.content || '';
        this.#messages.push({ role: 'assistant', content: final });
      } else {
        // Sngine platform: agentic loop — brain reasons deeply:
        // plan → act (tools) → observe → reflect → answer → verify.
        const memoryCtx = loadMemoryContext();
        const systemPrompt = this.#toolsPrompt(cloudTask, brain, memoryCtx);
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task },
        ];

        let corrections = 0;
        for (let i = 0; i < brain.maxSteps; i++) {
          const tThink = Date.now();
          const thinkRes = await this.#thinkWithRetry(messages, runId, { temperature: brain.temperature, profile: brain.profile });
          const answer = thinkRes.text ?? thinkRes ?? '';
          const thinkMs = Date.now() - tThink;
          if (thinkRes.usage) addUsage(thinkRes.usage);
          if (thinkRes.model) lastModel = thinkRes.model;
          if (thinkRes.provider) lastProvider = thinkRes.provider;
          const reply = parseBrainReply(answer);

          // Direct final answer (protocol shape)
          if (reply && reply.kind === 'answer') {
            final = reply.answer;
            await trace('answer', {
              summary: truncate(reply.reasoning || reply.answer, 500),
              detail: truncate(answer, 6000),
              model: thinkRes.model || '',
              provider: thinkRes.provider || '',
              usage: thinkRes.usage || null,
              durationMs: thinkMs,
            });
            break;
          }
          // Plain-text final answer
          if (reply && reply.kind === 'text') {
            final = reply.text;
            await trace('answer', {
              summary: truncate(reply.text, 500),
              detail: truncate(reply.text, 6000),
              model: thinkRes.model || '',
              provider: thinkRes.provider || '',
              usage: thinkRes.usage || null,
              durationMs: thinkMs,
            });
            break;
          }

          // Tool calls
          if (reply && reply.kind === 'tools') {
            corrections = 0;
            await trace('think', {
              summary: truncate(reply.calls[0]?.reasoning || `${reply.calls.length} tool call(s)`, 500),
              detail: truncate(answer, 6000),
              model: thinkRes.model || '',
              provider: thinkRes.provider || '',
              usage: thinkRes.usage || null,
              durationMs: thinkMs,
            });
            messages.push({ role: 'assistant', content: answer });

            // Execute every requested tool (JSON arrays = multi-tool steps)
            const resultLines = [];
            for (const toolCall of reply.calls) {
              steps.push({ type: 'tool.call', tool: toolCall.tool, args: toolCall.args });
              this.#control.step('tool.call', { tool: toolCall.tool });
              this.emit('tool:start', toolCall.tool, toolCall.args);
              log.info(`Tool call: ${toolCall.tool}`);
              await postActivity(this.#creds.apiKey, 'tool.call', { tool: toolCall.tool, args: toolCall.args }, runId, this.#creds.agentId).catch(() => {});
              await trace('tool.call', { summary: toolCall.tool, detail: JSON.stringify(toolCall.args || {}, null, 2) });

              const tTool = Date.now();
              let result;
              try {
                result = await tools.run(toolCall.tool, toolCall.args || {});
              } catch (err) {
                result = { error: err.message };
              }
              this.#stats.toolCalls++;

              const out = truncate(JSON.stringify(result), TOOL_OUT_MAX);
              steps.push({ type: 'tool.result', tool: toolCall.tool, output: truncate(out, 400) });
              await postActivity(this.#creds.apiKey, 'tool.result', { tool: toolCall.tool, output: truncate(out, 200) }, runId, this.#creds.agentId).catch(() => {});
              await trace('tool.result', {
                summary: truncate(out, 500),
                detail: truncate(out, 4000),
                durationMs: Date.now() - tTool,
              });
              log.info(`Tool result (${toolCall.tool}): ${truncate(out, 120)}`);

              const failed = result && (result.error || result.exitCode);
              if (failed) await this.#debugSnapshot(runId, `tool ${toolCall.tool} failed`);
              resultLines.push(`TOOL RESULT (${toolCall.tool}):\n${out}`);
            }

            // Reflect phase: force a deliberate decision — done, or next action?
            const anyFailed = resultLines.some((l) => /"error"|exitCode":[1-9]/.test(l));
            const debugHint = anyFailed
              ? `\n\nAt least one tool returned an error. Diagnose it, then either fix the call or use a different tool/approach. Do not give up — verify your fix by running it again.`
              : '';
            messages.push({ role: 'user', content: resultLines.join('\n\n') + debugHint +
              `\n\nREFLECT: check the tool results against the user's goal. If the goal is now satisfied, answer immediately. If something is missing or failed, state your reasoning and take the next action.` });
            continue;
          }

          // Empty or malformed reply → corrective nudge (auto-reasoning)
          const hasText = answer && answer.trim();
          const looksLikeAttempt = hasText && /"(tool|answer)"\s*:/.test(answer);
          if (corrections >= MAX_CORRECTIONS) {
            final = hasText ? answer : 'The brain produced no usable reply. Check the activity feed for the trace.';
            break;
          }
          corrections++;
          const hint = looksLikeAttempt
            ? 'Your last message was not valid JSON. Reply with ONLY one JSON object: {"reasoning":"...","tool":"<tool name>","args":{...}} — or {"reasoning":"...","answer":"..."} when done, or plain text.'
            : 'Your reply was empty or not actionable. Either give the final answer in plain text, or emit ONE JSON object with "tool" or "answer".';
          messages.push({ role: 'assistant', content: answer });
          messages.push({ role: 'user', content: hint });
          await trace('correct', { summary: looksLikeAttempt ? 'malformed reply — corrective nudge' : 'empty reply — corrective nudge' });
          await postActivity(this.#creds.apiKey, 'auto.correct', { reason: looksLikeAttempt ? 'malformed' : 'empty', attempt: corrections }, runId, this.#creds.agentId).catch(() => {});
        }

        // Never give up: one forced conclusion when steps run out
        if (!final) {
          messages.push({ role: 'user', content: 'Step limit reached. Reply {"reasoning":"brief summary of what you did","answer":"..."} — or plain text. No more tools.' });
          try {
            const tThink = Date.now();
            const thinkRes = await this.#thinkWithRetry(messages, runId, { temperature: brain.temperature, profile: brain.profile });
            const r2 = parseBrainReply(thinkRes.text ?? '');
            if (r2 && r2.kind === 'answer') final = r2.answer;
            else if (r2 && r2.kind === 'text') final = r2.text;
            else final = (thinkRes.text ?? '').trim() || 'The agent hit its step limit. See the activity feed for the full execution trace.';
            if (thinkRes.usage) addUsage(thinkRes.usage);
            if (thinkRes.model) lastModel = thinkRes.model;
            if (thinkRes.provider) lastProvider = thinkRes.provider;
            await trace('final', {
              summary: truncate(final, 500),
              detail: truncate(final, 6000),
              model: thinkRes.model || '',
              provider: thinkRes.provider || '',
              usage: thinkRes.usage || null,
              durationMs: Date.now() - tThink,
            });
          } catch {
            final = 'The agent hit its step limit. See the activity feed for the full execution trace.';
          }
        }

        // Self-verification pass: the brain re-checks its own answer against
        // the evidence before it reaches the user (fixes premature or sloppy answers).
        if (final && brain.verify) {
          try {
            messages.push({ role: 'assistant', content: final });
            messages.push({ role: 'user', content: 'VERIFY: You are about to send this answer to the user. Check it against the tool results above: is every claim factual, complete and direct? If something is wrong or missing, fix it. Reply {"reasoning":"what you checked","answer":"<corrected or unchanged answer>"}.' });
            const tThink = Date.now();
            const vRes = await this.#thinkWithRetry(messages, runId, { temperature: brain.temperature, profile: 'complex' });
            const vr = parseBrainReply(vRes.text ?? '');
            if (vr && vr.kind === 'answer' && vr.answer.trim()) final = vr.answer;
            else if (vr && vr.kind === 'text' && (vRes.text ?? '').trim()) final = vRes.text;
            if (vRes.usage) addUsage(vRes.usage);
            if (vRes.model) lastModel = vRes.model;
            if (vRes.provider) lastProvider = vRes.provider;
            await trace('verify', {
              summary: truncate((vr && vr.reasoning) || 'answer re-checked against tool results', 500),
              detail: truncate(vRes.text ?? '', 6000),
              model: vRes.model || '',
              provider: vRes.provider || '',
              usage: vRes.usage || null,
              durationMs: Date.now() - tThink,
            });
          } catch {
            // verification is best-effort — keep the original answer
          }
        }
      }
    } catch (err) {
      this.#stats.errors++;
      this.#currentTask = null;
      this.#control.step('task.error', { error: err.message });
      this.emit('task:error', err);
      log.error(`Think failed: ${err.message}`);
      await this.#debugSnapshot(runId, 'task error: ' + err.message);
      const msg = `I hit an error and could not complete the task: ${err.message}. A debug snapshot was captured — retry the request or check the activity feed.`;
      if (sngine && runId) {
        try {
          await runFinish(this.#creds.apiKey, runId, {
            status: 'failed',
            error: truncate(err.message, 2000),
            model: lastModel,
            provider: lastProvider,
            usage: usageTotals,
            durationMs: Date.now() - t0,
          });
        } catch (fe) {
          log.debug(`runFinish failed: ${fe.message}`);
        }
      }
      if (cloudTask) await this.#reportResult(cloudTask, msg, steps, { runId, usage: usageTotals, model: lastModel, provider: lastProvider });
      return;
    }

    this.#stats.tasks++;
    this.#stats.tokens += final.length;

    this.#currentTask = null;
    if (cloudTask) {
      await this.#reportResult(cloudTask, final, steps, { runId, usage: usageTotals, model: lastModel, provider: lastProvider });
    }
    if (sngine && runId) {
      try {
        await runFinish(this.#creds.apiKey, runId, {
          status: 'done',
          model: lastModel,
          provider: lastProvider,
          usage: usageTotals,
          durationMs: Date.now() - t0,
        });
      } catch (fe) {
        log.debug(`runFinish failed: ${fe.message}`);
      }
    }
    this.#control.result(runId, { text: final });
    this.#control.step('task.done', { runId, tokens: final.length, chars: final.length });
    this.emit('task:done', { answer: final, tokens: final.length, runId });
    log.info(`Task complete`, { tokens: final.length, chars: final.length });
  }

  // ── Tool execution ──────────────────────────────────────────────
  async #runTool(toolName, toolArgs, runId) {
    if (!toolName) {
      this.#control.result(runId, { error: 'No tool specified' });
      return;
    }

    this.#control.step('tool.start', { tool: toolName });
    this.emit('tool:start', toolName, toolArgs);

    const result = await tools.run(toolName, toolArgs || {});
    this.#stats.toolCalls++;

    this.#control.result(runId, result);
    this.#control.step('tool.done', { tool: toolName });
    this.emit('tool:done', toolName, result);

    if (result.error) {
      log.warn(`Tool ${toolName}: ${result.error}`);
    } else {
      log.info(`Tool ${toolName} done`);
    }
  }

  #toolsPrompt(taskRow, brain = this.#brain, memoryCtx = '') {
    const rows = tools.list()
      .map((t) => `- ${t.name}: ${t.description}${t.args ? ` (args: ${JSON.stringify(t.args)})` : ''}`)
      .join('\n');
    let p = `You are mona-agent — the AI agent controlling this device (${process.platform}). You reason deeply and act precisely: plan, act, observe, reflect, then answer.

## Reasoning protocol
Think before you act: what does the user actually want, what do you already know, what do you still need, and what is the safest way to get it.
- When you need information or need to change something on this device, reply with ONLY one JSON object:
{"reasoning":"<your concise thinking: goal, what you know, what you plan and why>","tool":"<tool name>","args":{...}}
- When you have everything you need, reply with ONLY:
{"reasoning":"<why the goal is now satisfied>","answer":"<the final answer for the user>"}
- Plain text is also accepted as a final answer. Never mix prose with JSON.

## Examples (follow this format exactly)
Task: "What is the uptime of this machine?"
Reply: {"reasoning":"The user wants the current uptime. sysinfo provides it directly in one call.","tool":"sysinfo","args":{}}

Task: "Say hello."
Reply: {"reasoning":"No tools are needed — a direct answer satisfies the goal.","answer":"Hello! I am your agent on this machine."}

## Answer quality
- Base every claim on actual tool results — never invent data you could have read.
- If you cannot verify a fact with a tool, say so plainly instead of guessing.
- Be direct and concise. State what you did and what you found.
- If something failed, say what failed and what you tried instead.
- If the goal is already satisfied, stop and answer instead of calling more tools.

## Memory
You have a persistent memory tool. Read it at the start of relevant tasks, and save user preferences and important facts so they survive across tasks.

Available tools:
${rows}

Rules:
- GUI apps, servers, and long-running programs (e.g. a Python tkinter window) MUST use the shell tool with "background":true so they keep running.
- To create a Python GUI window, generate a tkinter script and run it with "python3 -c '...'" in the background.
- Never invent data you can read with a tool. Keep answers short and direct.
- If a command fails, diagnose and retry differently — never give up.`;
    if (memoryCtx) p += memoryCtx;
    if (taskRow?.system_prompt) {
      p += `\n\n## Your role (set by the owner)\n${taskRow.system_prompt}`;
    }
    if (brain.extraRules) {
      p += `\n\n## Owner's rules (always follow)\n${brain.extraRules}`;
    }
    return p;
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  close() {
    log.info('Agent shutting down');
    if (this.#taskPoll) clearInterval(this.#taskPoll);
    this.#control.close();
    this.emit('close');
  }
}
