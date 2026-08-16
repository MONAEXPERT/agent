// Agent daemon runtime — the core loop.
// Receives commands from the website via the control channel,
// delegates reasoning to the cloud brain, executes local tools,
// and streams everything back.
//
// The agentic loop itself (plan → act → reflect → answer) is the shared
// engine core in packages/engine — TaskLoop with policy-as-code, a budget
// governor and structured memory. This file wires that core to the cloud
// brain (think) and the local tool registry, and reports every step to the
// dashboard (never silent).

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
import { TaskLoop, Policy, Budget, MemoryStore, parseBrainReply } from '@mona/engine';
import { writePid, clearPid, alreadyRunning } from './daemon.js';

// The engine's parser is the single source of truth for brain replies.
export { parseBrainReply };

const MAX_RETRIES = 3;       // transient failures (network, 429, 5xx)
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

/** Extract a {tool, args} JSON call from a model reply — legacy helper,
 *  superseded by the engine parser (packages/engine/src/loop.js). Kept for
 *  backward-compatible imports; new code should use parseBrainReply. */
export function parseToolCall(text) {
  if (!text) return null;
  // Legacy shape: a bare JSON array of tool calls.
  try {
    const o = JSON.parse(String(text).trim());
    if (Array.isArray(o) && o.length && o.every((x) => x && typeof x.tool === 'string')) {
      return o.map((c) => ({ tool: c.tool, args: c.args || {}, reasoning: c.reasoning || '' }));
    }
  } catch { /* fall through to the engine parser */ }
  const r = parseBrainReply(text);
  if (r && r.kind === 'tools') return r.calls;
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
  // Engine core: policy-as-code, budget governor, structured memory.
  // Shared across tasks; each task gets its own TaskLoop over these.
  #policy;
  #budget;
  #memory;
  // Owner-configurable reasoning profile (set from the cloud per poll).
  #brain = { maxSteps: 8, temperature: 0.4, extraRules: '', verify: true };

  constructor(creds) {
    super();
    this.#creds = creds;

    // Policy file (MONA_POLICY or ~/.mona-agent/policy.json) governs tool
    // authorization and budget caps; safe defaults apply when absent.
    this.#policy = Policy.load();
    this.#budget = new Budget({
      dailyTokens: this.#policy.dailyTokens,
      dailyCostUsd: this.#policy.dailyCostUsd,
    });
    this.#memory = new MemoryStore({});

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
  start({ force = false } = {}) {
    if (!force && alreadyRunning()) {
      const err = new Error('mona-agent is already running (see ~/.mona-agent/daemon.pid). Use `mona-agent daemon status`, or start with --force after a crash.');
      err.code = 'EALREADYRUNNING';
      throw err;
    }
    log.info(`Agent starting`, { agentId: this.#creds.agentId });
    log.info(`Tools: ${tools.names().join(', ')}`);
    writePid();
    this.#control.connect();
    this.#startTaskPoll();
    return this;
  }

  get stats() { return { ...this.#stats, budget: this.#budget.summary(), memory: this.#memory.stats() }; }
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

    // Budget gate: daily token/cost caps from the policy file. When exhausted
    // the task is answered immediately instead of burning more spend.
    if (!this.#budget.canRun()) {
      const s = this.#budget.summary();
      const msg = `Daily budget exhausted (${s.tokens} tokens, $${s.costUsd.toFixed(4)}). Budget resets tomorrow.`;
      log.warn(msg);
      this.#control.result(runId, { text: msg });
      this.#control.step('task.done', { runId, blocked: 'budget' });
      this.emit('task:done', { answer: msg, runId, blocked: 'budget' });
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
        // Sngine platform: engine-driven agentic loop. The shared core in
        // packages/engine (TaskLoop) runs plan → act → reflect → answer with
        // policy checks, budget steering, corrective nudges and a forced
        // conclusion. This daemon supplies the brain (cloud think), the tools
        // and the trace plumbing — every step stays visible.
        const memoryCtx = loadMemoryContext();
        const recalled = this.#memory.recall(task, { limit: 5 }).map((e) => e.text).join('\n');
        const systemPrompt = this.#toolsPrompt(cloudTask, brain, memoryCtx, recalled);

        // Loop events → dashboard + audit trace (never silent).
        const wireLoop = (loop) => {
          loop.on('step', (i, m) => this.emit('task:step', i, m));
          loop.on('profile', (prof) => {
            this.emit('task:profile', prof);
            trace('profile', { summary: prof.reason || prof.profile, detail: JSON.stringify(prof) });
          });
          loop.on('think', (text) => {
            trace('think', { summary: truncate(String(text).slice(0, 500), 500), detail: truncate(String(text), 6000) });
          });
          loop.on('tool', (name, args) => {
            steps.push({ type: 'tool.call', tool: name, args });
            this.#control.step('tool.call', { tool: name });
            this.emit('tool:start', name, args);
            log.info(`Tool call: ${name}`);
            postActivity(this.#creds.apiKey, 'tool.call', { tool: name, args }, runId, this.#creds.agentId).catch(() => {});
            trace('tool.call', { summary: name, detail: JSON.stringify(args || {}, null, 2) });
          });
          loop.on('tool:result', (name, out) => {
            this.#stats.toolCalls++;
            const outStr = truncate(JSON.stringify(out), TOOL_OUT_MAX);
            steps.push({ type: 'tool.result', tool: name, output: truncate(outStr, 400) });
            postActivity(this.#creds.apiKey, 'tool.result', { tool: name, output: truncate(outStr, 200) }, runId, this.#creds.agentId).catch(() => {});
            trace('tool.result', { summary: truncate(outStr, 500), detail: truncate(outStr, 4000) });
            log.info(`Tool result (${name}): ${truncate(outStr, 120)}`);
            if (out && (out.error || out.exitCode)) this.#debugSnapshot(runId, `tool ${name} failed`);
          });
          loop.on('tool:denied', (name, verdict) => {
            log.warn(`Tool denied by policy: ${name} (${verdict.reason})`);
            postActivity(this.#creds.apiKey, 'auto.denied', { tool: name, reason: verdict.reason, tier: verdict.tier }, runId, this.#creds.agentId).catch(() => {});
            trace('denied', { summary: `${name}: ${verdict.reason}` });
          });
          loop.on('nudge', (why) => {
            postActivity(this.#creds.apiKey, 'auto.correct', { reason: why }, runId, this.#creds.agentId).catch(() => {});
            trace('correct', { summary: `${why} reply — corrective nudge` });
          });
          loop.on('blocked', (kind, s) => {
            log.warn(`Task blocked: ${kind}`);
            trace('blocked', { summary: kind, detail: JSON.stringify(s) });
          });
          loop.on('answer', (text) => {
            trace('answer', { summary: truncate(String(text).slice(0, 500), 500), detail: truncate(String(text), 6000) });
          });
          loop.on('error', (err) => log.warn(`Loop error: ${err.message}`));
        };

        // Brain adapter: cloud think() with retries; streams tokens to the
        // dashboard, tracks usage/model/provider, maps to the engine's usage
        // shape (input/output/total/costUsd) for the budget governor.
        const loopThink = async (messages, prof) => {
          const res = await this.#thinkWithRetry(messages, runId, {
            temperature: prof?.temperature ?? brain.temperature,
            // 'standard' means no steering — let the cloud auto-pick.
            profile: prof?.profile && prof.profile !== 'standard' ? prof.profile : (brain.profile ?? null),
          });
          if (res.usage) addUsage(res.usage);
          if (res.model) lastModel = res.model;
          if (res.provider) lastProvider = res.provider;
          return {
            text: res.text ?? '',
            usage: res.usage ? {
              input: +res.usage.input || 0,
              output: +res.usage.output || 0,
              total: +res.usage.total || 0,
              costUsd: +res.usage.costUsd || 0,
            } : null,
          };
        };

        const loop = new TaskLoop({
          think: loopThink,
          runTool: (name, args) => tools.run(name, args),
          policy: this.#policy,
          budget: this.#budget,
          maxSteps: brain.maxSteps,
          temperature: brain.temperature,
        });
        wireLoop(loop);

        const res = await loop.run(task, {
          system: systemPrompt,
          profile: brain.profile ?? 'standard',
          conclude: async (messages) => {
            // Never give up: one forced conclusion when steps run out.
            messages.push({ role: 'user', content: 'Step limit reached. Reply {"reasoning":"brief summary of what you did","answer":"..."} — or plain text. No more tools.' });
            try {
              const tThink = Date.now();
              const thinkRes = await this.#thinkWithRetry(messages, runId, { temperature: brain.temperature, profile: brain.profile });
              const r2 = parseBrainReply(thinkRes.text ?? '');
              if (thinkRes.usage) addUsage(thinkRes.usage);
              if (thinkRes.model) lastModel = thinkRes.model;
              if (thinkRes.provider) lastProvider = thinkRes.provider;
              const text = r2.kind === 'answer' ? r2.answer : (r2.kind === 'text' ? r2.text : (thinkRes.text ?? '').trim());
              await trace('final', {
                summary: truncate(text, 500),
                detail: truncate(thinkRes.text ?? '', 6000),
                model: thinkRes.model || '',
                provider: thinkRes.provider || '',
                usage: thinkRes.usage || null,
                durationMs: Date.now() - tThink,
              });
              return text || null;
            } catch {
              return null; // engine falls back to a static conclusion
            }
          },
        });
        final = res.answer;

        // Self-verification pass: the brain re-checks its own answer against
        // the evidence (the full loop conversation) before it reaches the
        // user — fixes premature or sloppy answers.
        if (final && brain.verify) {
          try {
            const vMessages = [...(res.messages || [])];
            vMessages.push({ role: 'assistant', content: final });
            vMessages.push({ role: 'user', content: 'VERIFY: You are about to send this answer to the user. Check it against the tool results above: is every claim factual, complete and direct? If something is wrong or missing, fix it. Reply {"reasoning":"what you checked","answer":"<corrected or unchanged answer>"}.' });
            const tThink = Date.now();
            const vRes = await this.#thinkWithRetry(vMessages, runId, { temperature: brain.temperature, profile: 'complex' });
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

    // The agent that remembers: fold the finished task into structured memory
    // (deduped, TTL-capped, scored recall) so future tasks know what was done.
    try {
      this.#memory.remember(`Task: ${String(task).slice(0, 200)}\nResult: ${String(final).slice(0, 400)}`, { tags: ['task'] });
    } catch { /* memory is best-effort */ }

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

    // Policy gate applies to direct dashboard tool commands too — the same
    // rules the engine enforces inside the agentic loop.
    const verdict = this.#policy.check(toolName, toolArgs || {});
    if (!verdict.allowed) {
      log.warn(`Tool denied by policy: ${toolName} (${verdict.reason})`);
      this.#control.result(runId, { error: verdict.reason, policy: verdict.tier });
      return;
    }
    if (toolName === 'shell') {
      const sv = this.#policy.shellCheck((toolArgs?.cmd) || '');
      if (!sv.allowed) {
        log.warn(`Shell command denied by policy: ${sv.reason}`);
        this.#control.result(runId, { error: sv.reason, policy: sv.tier });
        return;
      }
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

  #toolsPrompt(taskRow, brain = this.#brain, memoryCtx = '', agentMemory = '') {
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
    if (agentMemory) {
      p += `\n\n## Agent memory (auto-remembered from past tasks)\n${agentMemory}\n(Recall this before repeating work that may already be done.)`;
    }
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
    clearPid();
    this.emit('close');
  }
}
