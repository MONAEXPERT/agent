// Streams device monitoring + agent steps to agent.mona.expert over a WebSocket.
import { WebSocket } from 'ws';
import os from 'node:os';
import { CLOUD } from './config.js';

export class TelemetryStream {
  constructor(apiKey, agentId) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.ws = null;
    this.queue = [];
    this.timer = null;
  }

  connect() {
    this.ws = new WebSocket(CLOUD.ws, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    this.ws.on('open', () => {
      this.send('hello', { agentId: this.agentId, host: os.hostname() });
      this.flush();
      this.startDeviceMonitor();
    });
    this.ws.on('close', () => {
      clearInterval(this.timer);
      setTimeout(() => this.connect(), 3000); // auto-reconnect
    });
    this.ws.on('error', () => {});
    return this;
  }

  send(type, data) {
    const msg = JSON.stringify({ type, ts: Date.now(), agentId: this.agentId, data });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this.queue.push(msg);
  }

  flush() {
    while (this.queue.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.queue.shift());
    }
  }

  // Emit agent lifecycle steps.
  step(name, detail) { this.send('agent.step', { name, detail }); }
  log(level, message) { this.send('agent.log', { level, message }); }

  // Periodic device monitoring snapshot.
  startDeviceMonitor() {
    this.timer = setInterval(() => {
      const load = os.loadavg();
      this.send('device.metrics', {
        cpuLoad: load,
        mem: { total: os.totalmem(), free: os.freemem() },
        uptime: os.uptime(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
      });
    }, 5000);
  }

  close() {
    clearInterval(this.timer);
    this.ws?.close();
  }
}
