// Tool registry — discovers and dispatches tool calls.
// Each tool module exports { name, description, args, run(args) }.
// The registry validates inputs and enforces timeouts.

import { log } from '../log.js';
import { sysinfo } from './sysinfo.js';
import { shell } from './shell.js';
import { files } from './files.js';
import { net } from './net.js';
import { apps } from './apps.js';
import { browser } from './browser.js';
import { web } from './web.js';
import { memory } from './memory.js';
import { notify } from './notify.js';

const BUILTIN = [sysinfo, shell, files, net, apps, browser, web, memory, notify];
const TIMEOUT_MS = 30_000;

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

  /** Run a tool by name with timeout enforcement. */
  async run(name, args = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}`, available: this.names() };
    }

    log.info(`Tool: ${name}`, args);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const result = await tool.run(args, controller.signal);
      return result;
    } catch (err) {
      if (err.name === 'AbortError') {
        return { error: `Tool '${name}' timed out (${TIMEOUT_MS / 1000}s)` };
      }
      return { error: err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const tools = new ToolRegistry();
