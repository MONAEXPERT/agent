// Tool registry — discovers and dispatches tool calls.
// Each tool module exports { name, description, args, run(args) }.
// The registry validates inputs and enforces timeouts.

import { log } from '../log.js';
import { Policy } from '@mona/engine';
import { sysinfo } from './sysinfo.js';
import { shell } from './shell.js';
import { files } from './files.js';
import { net } from './net.js';
import { apps } from './apps.js';
import { browser } from './browser.js';
import { web } from './web.js';
import { memory } from './memory.js';
import { notify } from './notify.js';
import { vector } from './vector.js';
import { jobs } from './jobs.js';
import { delegate } from './delegate.js';
import { goal } from './goal.js';
import { workflow } from './workflow.js';

const BUILTIN = [sysinfo, shell, files, net, apps, browser, web, memory, notify, vector, jobs, delegate, goal, workflow];
const TIMEOUT_MS = 30_000;

// Policy choke point: EVERY tool invocation (daemon, brain loop, CLI exec)
// passes through the local policy engine. The control plane can never
// widen this — it is loaded once from disk at startup.
const POLICY = Policy.load();

class ToolRegistry {
  #tools = new Map();

  constructor() {
    for (const tool of BUILTIN) {
      this.register(tool);
    }
  }

  register(tool) {
    if (!tool.name || typeof tool.run !== 'function') {
      throw new Error(`Invalid tool: missing name or run function`);
    }
    this.#tools.set(tool.name, tool);
  }

  /** List all registered tools (for cloud brain context). */
  list() {
    return [...this.#tools.values()].map(t => ({
      name:        t.name,
      description: t.description,
      args:        t.args || {},
    }));
  }

  /** List tool names. */
  names() {
    return [...this.#tools.keys()];
  }

  /** Run a tool by name with timeout enforcement + policy gate. */
  async run(name, args = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}`, available: this.names() };
    }

    // Policy gate (deny / confirm / rate limit).
    const verdict = POLICY.check(name, args);
    if (verdict.tier !== 'allow') {
      return { error: verdict.reason, policy: verdict.tier };
    }

    log.info(`Tool: ${name}`, args);

    // Per-tool timeout override (e.g. `jobs.wait` may legitimately poll for
    // minutes) — default 30s stays for every other tool.
    const timeoutMs = Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0 ? tool.timeoutMs : TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await tool.run(args, controller.signal);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        return { error: `Tool '${name}' timed out (${timeoutMs / 1000}s)` };
      }
      return { error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const tools = new ToolRegistry();
