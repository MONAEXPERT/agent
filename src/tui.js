// Terminal dashboard — full-screen TUI for the mona-agent daemon.
// Zero external dependencies — pure ANSI escape codes + Node builtins.
// Multi-OS support (macOS, Linux, Windows Terminal).
//
// Key bindings:
//   q / Ctrl+C    Quit
//   c             Clear activity log
//   r             Force reconnect
//   d             Toggle debug info
//   ↑ / ↓         Scroll log
//   h             Show help overlay
//   /             Chat input mode (future)

import os from 'node:os';
import { DEFAULTS, CLOUD, PATHS } from './config.js';

// ── Platform detection ────────────────────────────────────────────
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'
const IS_WIN = PLATFORM === 'win32';

// ── ANSI helpers ──────────────────────────────────────────────────
const ESC = '\x1b[';
const ansi = {
  clear:      `${ESC}2J${ESC}H`,
  clearLine:  `${ESC}2K`,
  hide:       `${ESC}?25l`,
  show:       `${ESC}?25h`,
  bold:       `${ESC}1m`,
  dim:        `${ESC}2m`,
  reset:      `${ESC}0m`,
  reverse:    `${ESC}7m`,
  fg: {
    gray:     `${ESC}90m`,
    red:      `${ESC}31m`,
    green:    `${ESC}32m`,
    yellow:   `${ESC}33m`,
    blue:     `${ESC}34m`,
    magenta:  `${ESC}35m`,
    cyan:     `${ESC}36m`,
    white:    `${ESC}37m`,
    bCyan:    `${ESC}96m`,
    bGreen:   `${ESC}92m`,
    bYellow:  `${ESC}93m`,
    bRed:     `${ESC}91m`,
    bMagenta: `${ESC}95m`,
    bWhite:   `${ESC}97m`,
  },
};

// ── Box-drawing chars (ASCII-safe fallback for Windows) ──────────
const B = IS_WIN ? {
  tl: '+', tr: '+', bl: '+', br: '+',
  h: '-', v: '|',
  lt: '+', rt: '+', tt: '+', bt: '+', x: '+',
} : {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼',
};

// ── Status icons ──────────────────────────────────────────────────
const ICON = {
  connected:    '●',
  disconnected: '○',
  thinking:     '◈',
  done:         '✓',
  error:        '✗',
  tool:         '⚙',
  arrow:        '↳',
  task:         '▸',
  token:        '·',
  debug:        '…',
};

// ── Platform icon ─────────────────────────────────────────────────
const PLATFORM_ICON = { darwin: '', linux: '🐧', win32: '🪟' };
const PLATFORM_LABEL = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

// ── Helpers ───────────────────────────────────────────────────────
function memBar(used, total, width = 12) {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pctStr = `${Math.round(pct * 100)}%`;
  return `${bar} ${pctStr}`;
}

function fmtBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeStr() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function truncate(s, len) {
  if (!s) return '';
  if (s.length <= len) return s;
  return s.slice(0, len - 1) + '…';
}

// ── Dashboard class ───────────────────────────────────────────────
export class Dashboard {
  #out = process.stdout;
  #logs = [];
  #maxLogs = 500;
  #scrollOffset = 0;
  #showDebug = false;
  #showHelp = false;
  #reconnectAttempts = 0;
  #state = {
    connected: false,
    agentId:   null,
    host:      os.hostname(),
    task:      null,
    stats:     { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 },
    metrics:   null,
    tokenBuf:  '',
  };
  #renderTimer = null;
  #agent = null;

  constructor(agent) {
    this.#agent = agent;
    this.#state.agentId = agent?.creds?.agentId;
  }

  start() {
    if (!this.#out.isTTY) {
      process.stderr.write('TUI requires a terminal (TTY). Use "mona-agent start" for headless mode.\n');
      process.exit(1);
    }

    this.#out.write(ansi.hide);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => this.#onKey(key));
    this.#out.on('resize', () => this.#render());

    if (this.#agent) this.#wireAgent(this.#agent);

    this.#renderTimer = setInterval(() => this.#render(), 250);
    this.#render();

    this.#log('info', `Dashboard started on ${PLATFORM_LABEL[PLATFORM]}`);
    return this;
  }

  #wireAgent(agent) {
    agent.on('connected', () => {
      this.#state.connected = true;
      this.#reconnectAttempts = 0;
      this.#log('info', `Connected to ${CLOUD.base}`);
    });

    agent.on('disconnected', (code) => {
      this.#state.connected = false;
      this.#reconnectAttempts++;
      this.#log('warn', `Disconnected (code=${code}), reconnecting (attempt ${this.#reconnectAttempts})...`);
    });

    agent.on('metrics', (m) => {
      this.#state.metrics = m;
    });

    agent.on('task:start', (t) => {
      this.#state.task = { text: t.task, tokens: 0, startedAt: Date.now() };
      this.#state.tokenBuf = '';
      this.#log('task', `Task: "${truncate(t.task, 60)}"`);
    });

    agent.on('task:token', (delta) => {
      if (this.#state.task) this.#state.task.tokens++;
      this.#state.tokenBuf += delta;
      if (this.#state.tokenBuf.length > 200) {
        this.#state.tokenBuf = this.#state.tokenBuf.slice(-200);
      }
    });

    agent.on('task:done', (result) => {
      const t = this.#state.task;
      const elapsed = t ? ((Date.now() - t.startedAt) / 1000).toFixed(1) : '?';
      this.#state.stats.tasks++;
      this.#state.stats.tokens += result.tokens;
      this.#state.task = null;
      this.#state.tokenBuf = '';
      this.#log('done', `Complete (${result.tokens} tok, ${elapsed}s)`);
    });

    agent.on('task:error', (err) => {
      this.#state.stats.errors++;
      this.#state.task = null;
      this.#log('error', `Task failed: ${err.message}`);
    });

    agent.on('tool:start', (name) => {
      this.#log('tool', `Tool: ${name}`);
    });

    agent.on('tool:done', (name, result) => {
      this.#state.stats.toolCalls++;
      if (result.error) {
        this.#log('warn', `Tool ${name}: ${result.error}`);
      } else {
        this.#log('tool', `${name} done`);
      }
    });

    agent.on('error', (err) => {
      this.#log('error', err.message);
    });
  }

  // ── Log management ──────────────────────────────────────────────
  #log(type, msg) {
    this.#logs.push({ time: timeStr(), type, msg });
    if (this.#logs.length > this.#maxLogs) this.#logs.shift();
  }

  // ── Key handler ─────────────────────────────────────────────────
  #onKey(key) {
    // Help overlay dismiss
    if (this.#showHelp) {
      this.#showHelp = false;
      return;
    }

    switch (key) {
      case 'q':
      case '\x03': // Ctrl+C
        this.stop();
        this.#agent?.close();
        process.exit(0);
        break;
      case 'c':
        this.#logs = [];
        this.#scrollOffset = 0;
        this.#log('info', 'Log cleared');
        break;
      case 'r':
        this.#log('info', 'Forcing reconnect...');
        this.#agent?.close?.();
        setTimeout(() => this.#agent?.start?.(), 500);
        break;
      case 'd':
        this.#showDebug = !this.#showDebug;
        this.#log('info', `Debug ${this.#showDebug ? 'on' : 'off'}`);
        break;
      case 'h':
        this.#showHelp = true;
        break;
      case '\x1b[A': // Up
        this.#scrollOffset = Math.min(this.#scrollOffset + 1, Math.max(0, this.#logs.length - 5));
        break;
      case '\x1b[B': // Down
        this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
        break;
    }
  }

  // ── Rendering engine ────────────────────────────────────────────
  #render() {
    const W = this.#out.columns || 80;
    const H = this.#out.rows || 24;
    if (W < 40 || H < 12) return;

    const buf = [];
    const w = (s) => buf.push(s);
    w(ansi.clear);

    // ── Help overlay ──────────────────────────────────────────────
    if (this.#showHelp) {
      this.#renderHelp(w, W, H);
      this.#out.write(buf.join(''));
      return;
    }

    // ── Header ────────────────────────────────────────────────────
    const pfIcon = PLATFORM_ICON[PLATFORM] || '';
    const title = `${ansi.bold}${ansi.fg.bCyan}mona-agent${ansi.reset} ${ansi.dim}v${DEFAULTS.version}${ansi.reset} ${pfIcon}`;
    const statusIcon = this.#state.connected
      ? `${ansi.fg.bGreen}${ICON.connected} connected${ansi.reset}`
      : `${ansi.fg.bRed}${ICON.disconnected} disconnected${ansi.reset}`;
    const headerPad = W - this.#stripAnsi(title).length - this.#stripAnsi(statusIcon).length - 4;
    w(`${ansi.fg.gray}${B.tl}${B.h}${ansi.reset}${title} ${ansi.fg.gray}${B.h.repeat(Math.max(1, headerPad))} ${statusIcon} ${ansi.fg.gray}${B.h}${B.tr}${ansi.reset}\n`);

    // Debug bar
    if (this.#showDebug) {
      const debugInfo = `${ansi.dim}Cloud: ${CLOUD.base} | WS: ${CLOUD.wsUrl} | Agent: ${this.#state.agentId || 'pending'} | Reconnects: ${this.#reconnectAttempts}${ansi.reset}`;
      w(`${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(debugInfo, W - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    }

    // ── Layout ────────────────────────────────────────────────────
    const leftW = Math.min(32, Math.floor(W * 0.35));
    const rightW = W - leftW - 3;
    const bodyH = H - 4 - (this.#showDebug ? 1 : 0);
    const sysH = Math.min(9, Math.floor(bodyH * 0.6));
    const taskH = bodyH - sysH;

    const sysLines = this.#renderSystem(leftW - 2);
    const taskLines = this.#renderTask(leftW - 2);
    const logLines = this.#renderLog(rightW - 2, bodyH - 2);

    // ── Body ──────────────────────────────────────────────────────
    for (let row = 0; row < bodyH; row++) {
      let left = '', right = '';

      // Left panels
      if (row === 0) {
        left = `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bCyan}System${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, leftW - 11))}${B.tr}${ansi.reset}`;
      } else if (row > 0 && row <= sysH - 2) {
        left = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(sysLines[row - 1] || '', leftW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      } else if (row === sysH - 1) {
        left = `${ansi.fg.gray}${B.lt}${B.h} ${ansi.fg.bMagenta}Task${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, leftW - 9))}${B.rt}${ansi.reset}`;
      } else if (row >= sysH && row < bodyH - 1) {
        const tIdx = row - sysH;
        left = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(taskLines[tIdx] || '', leftW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      } else {
        left = `${ansi.fg.gray}${B.bl}${B.h.repeat(leftW)}${B.br}${ansi.reset}`;
      }

      // Right panel (log)
      if (row === 0) {
        right = `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bYellow}Activity${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, rightW - 12))}${B.tr}${ansi.reset}`;
      } else if (row === bodyH - 1) {
        right = `${ansi.fg.gray}${B.bl}${B.h.repeat(rightW)}${B.br}${ansi.reset}`;
      } else {
        right = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(logLines[row - 1] || '', rightW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      }

      w(`${left} ${right}\n`);
    }

    // ── Footer ────────────────────────────────────────────────────
    const keys = `${ansi.dim}q${ansi.reset} quit ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}c${ansi.reset} clear ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}r${ansi.reset} reconnect ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}d${ansi.reset} debug ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}h${ansi.reset} help`;
    const taskStatus = this.#state.task
      ? `${ansi.fg.bYellow}${ICON.thinking} thinking (${this.#state.task.tokens} tok)${ansi.reset}`
      : `${ansi.dim}${ansi.fg.green}idle${ansi.reset}`;
    const footerPad = W - this.#stripAnsi(keys).length - this.#stripAnsi(taskStatus).length - 4;
    w(`${ansi.fg.gray}${B.lt}${B.h.repeat(W)}${B.rt}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.v}${ansi.reset} ${keys}${' '.repeat(Math.max(1, footerPad))}${taskStatus} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.bl}${B.h.repeat(W)}${B.br}${ansi.reset}\n`);

    this.#out.write(buf.join(''));
  }

  // ── Help overlay ────────────────────────────────────────────────
  #renderHelp(w, W, H) {
    const lines = [
      '',
      `  ${ansi.bold}${ansi.fg.bCyan}mona-agent${ansi.reset} v${DEFAULTS.version} ${PLATFORM_ICON[PLATFORM] || ''}`,
      `  ${ansi.dim}${PLATFORM_LABEL[PLATFORM]} | Node ${process.version}${ansi.reset}`,
      '',
      `  ${ansi.bold}Key Bindings${ansi.reset}`,
      '',
      `  ${ansi.fg.bGreen}q${ansi.reset} / ${ansi.fg.bGreen}Ctrl+C${ansi.reset}    Quit`,
      `  ${ansi.fg.bGreen}c${ansi.reset}             Clear activity log`,
      `  ${ansi.fg.bGreen}r${ansi.reset}             Force reconnect to cloud`,
      `  ${ansi.fg.bGreen}d${ansi.reset}             Toggle debug info bar`,
      `  ${ansi.fg.bGreen}h${ansi.reset}             Show this help (any key to dismiss)`,
      `  ${ansi.fg.bGreen}↑ / ↓${ansi.reset}         Scroll activity log`,
      '',
      `  ${ansi.bold}Environment${ansi.reset}`,
      `  ${ansi.dim}Cloud:${ansi.reset}  ${CLOUD.base}`,
      `  ${ansi.dim}WS:${ansi.reset}     ${CLOUD.wsUrl}`,
      '',
      `  ${ansi.dim}Press any key to dismiss${ansi.reset}`,
    ];

    const startRow = Math.max(1, Math.floor((H - lines.length) / 2));
    for (let i = 0; i < lines.length; i++) {
      w(`${ansi.moveTo(startRow + i, 1)}${lines[i]}`);
    }
  }

  // ── Panel renderers ─────────────────────────────────────────────
  #renderSystem(width) {
    const m = this.#state.metrics || {};
    const totalMem = m.mem?.total || os.totalmem();
    const freeMem = m.mem?.free || os.freemem();
    const usedMem = totalMem - freeMem;
    const load = m.cpuLoad || os.loadavg();
    const barW = Math.max(6, width - 18);

    return [
      `${ansi.fg.gray}Host${ansi.reset}   ${ansi.fg.bWhite}${truncate(os.hostname(), width - 7)}${ansi.reset}`,
      `${ansi.fg.gray}OS${ansi.reset}     ${PLATFORM_LABEL[PLATFORM]} ${os.arch()}`,
      `${ansi.fg.gray}CPUs${ansi.reset}   ${os.cpus().length} cores`,
      `${ansi.fg.gray}Mem${ansi.reset}    ${ansi.fg.cyan}${memBar(usedMem, totalMem, barW)}${ansi.reset}`,
      `${ansi.fg.gray}       ${fmtBytes(usedMem)} / ${fmtBytes(totalMem)}${ansi.reset}`,
      `${ansi.fg.gray}Load${ansi.reset}   ${load.map(v => v.toFixed(2)).join('  ')}`,
      `${ansi.fg.gray}Up${ansi.reset}     ${fmtUptime(m.uptime || os.uptime())}`,
    ];
  }

  #renderTask(width) {
    const t = this.#state.task;
    const s = this.#state.stats;

    if (t) {
      const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(0);
      const preview = truncate(this.#state.tokenBuf.replace(/\n/g, ' '), width - 2);
      const lines = [
        `${ansi.fg.bYellow}${ICON.thinking} Thinking...${ansi.reset}`,
        `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${t.tokens}${ansi.reset}  ${ansi.fg.gray}${elapsed}s${ansi.reset}`,
        `${ansi.dim}${preview}${ansi.reset}`,
      ];
      // Fill remaining
      while (lines.length < 5) lines.push('');
      return lines;
    }

    const lines = [
      `${ansi.fg.green}${ICON.done} Idle${ansi.reset}`,
      '',
      `${ansi.fg.gray}Tasks${ansi.reset}  ${ansi.fg.bWhite}${s.tasks}${ansi.reset} done`,
      `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${s.tokens}${ansi.reset} total`,
      `${ansi.fg.gray}Tools${ansi.reset}  ${ansi.fg.bWhite}${s.toolCalls}${ansi.reset} calls`,
    ];
    if (s.errors > 0) lines.push(`${ansi.fg.bRed}Errors${ansi.reset} ${s.errors}`);
    while (lines.length < 6) lines.push('');
    return lines;
  }

  #renderLog(width, height) {
    const lines = [];
    const start = Math.max(0, this.#logs.length - height - this.#scrollOffset);
    const end = Math.min(this.#logs.length, start + height);

    for (let i = start; i < end; i++) {
      const entry = this.#logs[i];
      const icon = this.#logIcon(entry.type);
      const msg = truncate(entry.msg, width - 13);
      lines.push(`${ansi.fg.gray}${entry.time}${ansi.reset} ${icon} ${msg}`);
    }

    while (lines.length < height) lines.push('');
    return lines;
  }

  #logIcon(type) {
    switch (type) {
      case 'info':  return `${ansi.fg.bCyan}${ICON.connected}${ansi.reset}`;
      case 'warn':  return `${ansi.fg.bYellow}⚠${ansi.reset}`;
      case 'error': return `${ansi.fg.bRed}${ICON.error}${ansi.reset}`;
      case 'task':  return `${ansi.fg.bMagenta}${ICON.task}${ansi.reset}`;
      case 'done':  return `${ansi.fg.bGreen}${ICON.done}${ansi.reset}`;
      case 'tool':  return `${ansi.fg.cyan}${ICON.tool}${ansi.reset}`;
      default:      return `${ansi.fg.gray}·${ansi.reset}`;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────
  #stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  #padRight(s, len) {
    const visible = this.#stripAnsi(s).length;
    if (visible >= len) return s;
    return s + ' '.repeat(len - visible);
  }

  stop() {
    clearInterval(this.#renderTimer);
    process.stdin.setRawMode?.(false);
    this.#out.write(ansi.show);
    this.#out.write(ansi.clear);
  }
}
