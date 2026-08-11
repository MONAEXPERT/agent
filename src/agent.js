// Agent daemon runtime — the core loop.
// Receives commands from the website via the control channel,
// delegates reasoning to the cloud brain, executes local tools,
// and streams everything back.

import { EventEmitter } from 'node:events';
import { think } from './cloud.js';
import { ControlChannel } from './control.js';
import { tools } from './tools/index.js';
import { log } from './log.js';

export class AgentDaemon extends EventEmitter {
  #creds;
  #control;
  #messages = [];
  #stats = { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 };
  #currentTask = null;

  constructor(creds) {
    super();
    this.#creds = creds;

    this.#control = new ControlChannel(creds.apiKey, creds.agentId);

    // Forward control events
    this.#control.on('connected',    ()    => this.emit('connected'));
    this.#control.on('disconnected', (c)   => this.emit('disconnected', c));
    this.#control.on('metrics',      (m)   => this.emit('metrics', m));
    this.#control.on('error',        (err) => this.emit('error', err));
    this.#control.on('command',      (cmd) => this.#onCommand(cmd));
  }

  /** Start the daemon — connect to cloud and begin accepting commands. */
  start() {
    log.info(`Agent starting`, { agentId: this.#creds.agentId });
    log.info(`Tools: ${tools.names().join(', ')}`);
    this.#control.connect();
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

  // ── Task execution (cloud reasoning) ────────────────────────────
  async #runTask(task, runId) {
    if (!task) {
      this.#control.result(runId, { error: 'No task provided' });
      return;
    }

    this.#currentTask = { task, runId, startedAt: Date.now(), tokens: 0 };
    this.#control.step('task.start', { task, runId });
    this.emit('task:start', this.#currentTask);
    log.info(`Task: "${task.slice(0, 100)}"`);

    this.#messages.push({ role: 'user', content: task });

    let answer = '';
    let tokenCount = 0;

    try {
      answer = await think({
        apiKey:  this.#creds.apiKey,
        messages: this.#messages,
        tools:   tools.list(),
        onChunk: (delta) => {
          tokenCount++;
          this.#control.token(delta, runId);
          this.emit('task:token', delta, runId);
        },
        onUsage: (usage) => {
          this.emit('task:usage', usage);
        },
      });
    } catch (err) {
      this.#stats.errors++;
      this.#currentTask = null;
      this.#control.step('task.error', { error: err.message });
      this.#control.result(runId, { error: err.message });
      this.emit('task:error', err);
      log.error(`Think failed: ${err.message}`);
      return;
    }

    this.#messages.push({ role: 'assistant', content: answer });
    this.#stats.tasks++;
    this.#stats.tokens += tokenCount;

    this.#currentTask = null;
    this.#control.result(runId, { text: answer });
    this.#control.step('task.done', { runId, tokens: tokenCount, chars: answer.length });
    this.emit('task:done', { answer, tokens: tokenCount, runId });
    log.info(`Task complete`, { tokens: tokenCount, chars: answer.length });
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

  // ── Lifecycle ───────────────────────────────────────────────────
  close() {
    log.info('Agent shutting down');
    this.#control.close();
    this.emit('close');
  }
}
