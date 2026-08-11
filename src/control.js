// WebSocket control channel — the device dials OUT to agent.mona.expert.
// The WEBSITE is the controller: it sends commands down; the device executes
// them and streams metrics, steps, tokens, and results back up.
// There is NO local server and NO local UI served over HTTP.

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import os from 'node:os';
import { CLOUD, DEFAULTS } from './config.js';
import { log } from './log.js';

export class ControlChannel extends EventEmitter {
  #apiKey;
  #agentId;
  #ws = null;
  #queue = [];
  #metricsTimer = null;
  #backoff = DEFAULTS.reconnectMinMs;
  #reconnectTimer = null;
  #closing = false;

  constructor(apiKey, agentId) {
    super();
    this.#apiKey = apiKey;
    this.#agentId = agentId;
  }

  /** Connect (or reconnect) to the cloud. Returns this for chaining. */
  connect() {
    if (this.#closing) return this;

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

  /** Send a typed message upstream. */
  #send(type, data) {
    const msg = JSON.stringify({
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

  // ── Device metrics stream ──────────────────────────────────────
  #startMetrics() {
    this.#metricsTimer = setInterval(() => {
      const metrics = {
        cpuLoad: os.loadavg(),
        mem:     { total: os.totalmem(), free: os.freemem() },
        uptime:  os.uptime(),
        cpus:    os.cpus().length,
      };
      this.#send('device.metrics', metrics);
      this.emit('metrics', metrics);
    }, DEFAULTS.metricsIntervalMs);
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
