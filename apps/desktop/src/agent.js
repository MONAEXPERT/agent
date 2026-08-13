// Agent daemon runtime — the core loop.
// Receives commands from the website via the control channel,
// delegates reasoning to the cloud brain, executes local tools,
// and streams everything back.

import { EventEmitter } from 'node:events';
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
const RETRIABLE = /429|5\d\d|fetch failed|network|ECONN|ETIMEDOUT|socket|timeout/i;

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…(truncated)' : s;
}

/** Extract a {tool, args} JSON call from a model reply (plain, fenced, or with prose around it). */
function extractBalancedJson(s, start) {
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

function parseToolCall(text) {
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

export class AgentDaemon extends EventEmitter {
  #creds;
  #control;
  #messages = [];
  #stats = { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 };
  #currentTask = null;
  #taskPoll = null;
  #polling = false;

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
      const tasks = await pollTasks(this.#creds.apiKey);
      for (const t of tasks) {
        if (t.status !== 'pending') continue;
        try { await claimTask(this.#creds.apiKey, t.id); } catch { /* already claimed */ }
        await this.#runTask(t.task, t.run_id, t);
      }
    } catch (err) {
      log.debug(`Task poll failed: ${err.message}`);
    } finally {
      this.#polling = false;
    }
  }

  // ── Task execution (cloud reasoning + local tools) ──────────────
  /** think() with auto-retry for transient failures — fail is never allowed. */
  async #thinkWithRetry(messages, runId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await think({
          apiKey:  this.#creds.apiKey,
          messages,
          tools:   tools.list(),
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
        // Sngine platform: agentic loop — brain reasons, device executes.
        const systemPrompt = this.#toolsPrompt();
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task },
        ];

        let corrections = 0;
        for (let i = 0; i < MAX_ITERS; i++) {
          const tThink = Date.now();
          const thinkRes = await this.#thinkWithRetry(messages, runId);
          const answer = thinkRes.text ?? thinkRes ?? '';
          const thinkMs = Date.now() - tThink;
          if (thinkRes.usage) addUsage(thinkRes.usage);
          if (thinkRes.model) lastModel = thinkRes.model;
          if (thinkRes.provider) lastProvider = thinkRes.provider;
          const toolCalls = parseToolCall(answer);

          // Trace: the brain's raw reasoning step
          await trace('think', {
            summary: truncate(answer.trim().split('\n')[0] || answer, 500),
            detail: truncate(answer, 6000),
            model: thinkRes.model || '',
            provider: thinkRes.provider || '',
            usage: thinkRes.usage || null,
            durationMs: thinkMs,
          });

          if (!toolCalls || !toolCalls.length) {
            const hasText = answer && answer.trim();
            const looksLikeAttempt = hasText && /"tool"\s*:/.test(answer);
            if (hasText && !looksLikeAttempt) { final = answer; break; }
            // empty or malformed  corrective nudge (auto-reasoning)
            if (corrections >= MAX_CORRECTIONS) {
              final = hasText ? answer : 'The brain produced no usable reply. Check the activity feed for the trace.';
              break;
            }
            corrections++;
            const hint = looksLikeAttempt
              ? 'Your last message was not valid JSON. Reply with ONLY one JSON object: {"tool":"<tool name>","args":{...}} — or plain text if you are done.'
              : 'Your reply was empty. Either answer in plain text or emit ONE JSON tool call.';
            messages.push({ role: 'assistant', content: answer });
            messages.push({ role: 'user', content: hint });
            await trace('correct', { summary: looksLikeAttempt ? 'malformed reply — corrective nudge' : 'empty reply — corrective nudge' });
            await postActivity(this.#creds.apiKey, 'auto.correct', { reason: looksLikeAttempt ? 'malformed' : 'empty', attempt: corrections }, runId, this.#creds.agentId).catch(() => {});
            continue;
          }
          corrections = 0;

          messages.push({ role: 'assistant', content: answer });

          // Execute every requested tool (JSON arrays = multi-tool steps)
          const resultLines = [];
          for (const toolCall of toolCalls) {
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

          // Feed all results back together, with a diagnostic nudge on error
          const anyFailed = resultLines.some((l) => /"error"|exitCode":[1-9]/.test(l));
          const debugHint = anyFailed
            ? `\n\nAt least one tool returned an error. Diagnose it, then either fix the call or use a different tool/approach. Do not give up — verify your fix by running it again.`
            : '';
          messages.push({ role: 'user', content: resultLines.join('\n\n') + debugHint });
        }

        // Never give up: one forced plain-text conclusion when steps run out
        if (!final) {
          messages.push({ role: 'user', content: 'You must now answer in plain text. Summarize what you did, what the last tool result showed, and the current state. Do not call tools.' });
          try {
            const tThink = Date.now();
            const thinkRes = await this.#thinkWithRetry(messages, runId);
            final = thinkRes.text ?? thinkRes ?? '';
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

  #toolsPrompt() {
    const rows = tools.list()
      .map((t) => `- ${t.name}: ${t.description}${t.args ? ` (args: ${JSON.stringify(t.args)})` : ''}`)
      .join('\n');
    return `You are mona-agent — the AI agent controlling this device (${process.platform}). You reason and act: use the local tools below to get real information and take real actions, then give the user a direct, concise answer.

Available tools:
${rows}

How to use a tool — reply with ONLY one JSON object, nothing else:
{"tool":"<tool name>","args":{...}}

Rules:
- GUI apps, servers, and long-running programs (e.g. a Python tkinter window) MUST use the shell tool with "background":true so they keep running.
- To create a Python GUI window, generate a tkinter script and run it with "python3 -c '...'" in the background.
- Never invent data you can read with a tool. Keep answers short and direct.
- If a command fails, diagnose and retry differently — never give up.`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  close() {
    log.info('Agent shutting down');
    if (this.#taskPoll) clearInterval(this.#taskPoll);
    this.#control.close();
    this.emit('close');
  }
}
