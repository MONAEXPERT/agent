// WebSocket control channel — the device dials OUT to agent.mona.expert.
// The WEBSITE is the controller: it sends commands down; the device executes
// them and streams metrics, steps, tokens, and results back up.
// There is NO local server and NO local UI served over HTTP.

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import os from 'node:os';
import { statfsSync } from 'node:fs';
import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

/**
 * Close codes the cloud uses to say "this credential is no longer valid".
 * Reconnecting would just fail again — the daemon stops and asks for re-login.
 *   4001 — unauthorized (bad / expired API key)
 *   4003 — forbidden (device revoked, agent disabled)
 */
const TERMINAL_CLOSE_CODES = new Set([4001, 4003]);

/** Sampled CPU busy ratio — two os.cpus() readings 100ms apart. */
async function cpuPercent() {
  const a = os.cpus();
  await new Promise((r) => setTimeout(r, 100));
  const b = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < a.length; i++) {
    const ta = a[i].times, tb = b[i].times;
    idle += tb.idle - ta.idle;
    for (const k of Object.keys(tb)) total += tb[k] - ta[k];
  }
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

/** Used disk % on the device's home volume. */
function diskPercent() {
  try {
    const s = statfsSync(os.homedir());
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return total > 0 ? Math.round((1 - free / total) * 1000) / 10 : 0;
  } catch { return null; }
}

export class ControlChannel extends EventEmitter {
  #apiKey;
  #agentId;
  #capabilities;
  #ws = null;
  #queue = [];
  #metricsTimer = null;
  #metricsIntervalMs;
  #backoff = DEFAULTS.reconnectMinMs;
  #reconnectTimer = null;
  #closing = false;
  #stopped = false;

  constructor(apiKey, agentId, capabilities = null, { metricsIntervalMs } = {}) {
    super();
    this.#apiKey = apiKey;
    this.#agentId = agentId;
    this.#capabilities = capabilities;
    this.#metricsIntervalMs = metricsIntervalMs || DEFAULTS.metricsIntervalMs;
  }

  /** Connect (or reconnect) to the cloud. Returns this for chaining. */
  connect() {
    if (this.#closing || this.#stopped) return this;

    const url = CLOUD.wsUrl;
    log.debug(`Connecting to ${url}`);

    this.#ws = new WebSocket(url, {
      headers: {
        'authorization':    `Bearer ${this.#apiKey}`,
        'x-mona-agent-id':  this.#agentId || '',
        'user-agent':        `mona-agent/${DEFAULTS.version}`,
      },
    });

    this.#ws.on('open', () => {
      this.#backoff = DEFAULTS.reconnectMinMs;
      log.info(`Connected to ${new URL(url).host}`);

      this.#send('hello', {
        agentId:  this.#agentId,
        host:     os.hostname(),
        platform: os.platform(),
        arch:     os.arch(),
        cpus:     os.cpus().length,
        mem:      os.totalmem(),
        version:  DEFAULTS.version,
        capabilities: this.#capabilities,
      });
      this.#flush();
      this.#startMetrics();
      this.emit('connected');
    });

    this.#ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'command') {
        this.emit('command', msg);
      } else if (msg.type === 'ping') {
        this.#send('pong', {});
      } else {
        this.emit('message', msg);
      }
    });

    this.#ws.on('close', (code) => {
      this.#stopMetrics();
      if (this.#closing) return;
      // Terminal close: the credential itself was rejected — do not loop.
      if (TERMINAL_CLOSE_CODES.has(code)) {
        this.#stopped = true;
        clearTimeout(this.#reconnectTimer);
        log.error(`Cloud rejected credentials (code ${code}) — stopping. Run: mona-agent login`);
        this.emit('auth-failed', code);
        this.emit('disconnected', code);
        return;
      }
      // Exponential backoff with jitter
      const jitter = Math.random() * this.#backoff * 0.3;
      const wait = Math.min(this.#backoff + jitter, DEFAULTS.reconnectMaxMs);
      this.#backoff = Math.min(this.#backoff * 2, DEFAULTS.reconnectMaxMs);
      log.warn(`Disconnected (code=${code}), reconnecting in ${(wait / 1000).toFixed(1)}s`);
      this.emit('disconnected', code);
      this.#reconnectTimer = setTimeout(() => this.connect(), wait);
    });

    this.#ws.on('error', (err) => {
      log.error(`WebSocket error: ${err.message}`);
      this.emit('error', err);
    });

    return this;
  }

  /** Send a typed message upstream. Every envelope carries a protocol version. */
  #send(type, data) {
    const msg = JSON.stringify({
      v: 1,
      type,
      ts: Date.now(),
      agentId: this.#agentId,
      data,
    });
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(msg);
    } else {
      this.#queue.push(msg);
    }
  }

  #flush() {
    while (this.#queue.length && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(this.#queue.shift());
    }
  }

  // ── Public emitters (all consumed by the website dashboard) ─────
  step(name, detail)     { this.#send('agent.step', { name, detail }); }
  token(delta, runId)    { this.#send('agent.token', { delta, runId }); }
  result(runId, output)  { this.#send('agent.result', { runId, output }); }
  log(level, message)    { this.#send('agent.log', { level, message }); }

  /** Current connection state. */
  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** True once the cloud has rejected this credential — the daemon is done. */
  get stopped() {
    return this.#stopped;
  }

  // ── Device metrics stream ──────────────────────────────────────
  #startMetrics() {
    this.#metricsTimer = setInterval(async () => {
      const totalMem = os.totalmem(), freeMem = os.freemem();
      const cpus = os.cpus();
      const metrics = {
        cpuLoad: os.loadavg(),
        cpuPercent: await cpuPercent(),
        cpuModel: cpus[0]?.model || 'unknown',
        mem: {
          total: totalMem,
          free: freeMem,
          used: totalMem - freeMem,
          percent: Math.round((1 - freeMem / totalMem) * 1000) / 10,
        },
        diskPercent: diskPercent(),
        uptime: os.uptime(),
        uptimeSeconds: os.uptime(),
        cpus: cpus.length,
      };
      this.#send('device.metrics', metrics);
      this.emit('metrics', metrics);
    }, this.#metricsIntervalMs);
  }

  #stopMetrics() {
    if (this.#metricsTimer) {
      clearInterval(this.#metricsTimer);
      this.#metricsTimer = null;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────
  close() {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopMetrics();
    if (this.#ws) {
      this.#ws.removeAllListeners('close');
      this.#ws.close(1000, 'agent shutdown');
    }
  }
}
