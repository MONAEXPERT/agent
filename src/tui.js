// Terminal dashboard — full-screen TUI for the mona-agent daemon.
// Zero external dependencies — pure ANSI escape codes + Node builtins.
//
// Layout:
// ┌─ header ─────────────────────────────────────────────────────────┐
// │  ┌─ system ──────────────┐  ┌─ activity log ───────────────────┐│
// │  │                       │  │                                   ││
// │  ├─ task ────────────────┤  │                                   ││
// │  │                       │  │                                   ││
// │  └───────────────────────┘  └───────────────────────────────────┘│
// ├─ footer ─────────────────────────────────────────────────────────┤
// └──────────────────────────────────────────────────────────────────┘

import os from 'node:os';
import { DEFAULTS } from './config.js';

// ── ANSI helpers ──────────────────────────────────────────────────
const ESC = '\x1b[';
const ansi = {
  clear:      `${ESC}2J${ESC}H`,
  hide:       `${ESC}?25l`,
  show:       `${ESC}?25h`,
  bold:       `${ESC}1m`,
  dim:        `${ESC}2m`,
  reset:      `${ESC}0m`,
  fg: {
    black:    `${ESC}30m`,
    red:      `${ESC}31m`,
    green:    `${ESC}32m`,
    yellow:   `${ESC}33m`,
    blue:     `${ESC}34m`,
    magenta:  `${ESC}35m`,
    cyan:     `${ESC}36m`,
    white:    `${ESC}37m`,
    gray:     `${ESC}90m`,
    bCyan:    `${ESC}96m`,
    bGreen:   `${ESC}92m`,
    bYellow:  `${ESC}93m`,
    bRed:     `${ESC}91m`,
    bMagenta: `${ESC}95m`,
    bWhite:   `${ESC}97m`,
  },
  bg: {
    black:    `${ESC}40m`,
    blue:     `${ESC}44m`,
    magenta:  `${ESC}45m`,
    darkGray: `${ESC}100m`,
  },
  moveTo: (r, c) => `${ESC}${r};${c}H`,
};

// ── Box-drawing chars ─────────────────────────────────────────────
const B = {
  tl: '┌', tr: '┐', bl: '└', br: '┘',
  h: '─', v: '│',
  lt: '├', rt: '┤', tt: '┬', bt: '┴', x: '┼',
  dh: '═', dv: '║',
  dtl: '╔', dtr: '╗', dbl: '╚', dbr: '╝',
};

// ── Status icons ──────────────────────────────────────────────────
const ICON = {
  connected:    '●',
  disconnected: '○',
  thinking:     '◈',
  done:         '✓',
  error:        '✗',
  tool:         '⚙',
  metrics:      '◌',
  arrow:        '↳',
  task:         '▸',
  token:        '·',
};

// ── Memory bar helper ─────────────────────────────────────────────
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
  #state = {
    connected: false,
    agentId:   null,
    host:      os.hostname(),
    task:      null,     // { text, tokens, startedAt }
    stats:     { tasks: 0, tokens: 0, toolCalls: 0, errors: 0 },
    metrics:   null,
    tokenBuf:  '',       // accumulated streaming tokens for display
  };
  #renderTimer = null;
  #agent = null;

  constructor(agent) {
    this.#agent = agent;
    this.#state.agentId = agent?.creds?.agentId;
  }

  /** Bind agent events and start rendering. */
  start() {
    if (!this.#out.isTTY) {
      process.stderr.write('TUI requires a terminal (TTY). Use "mona-agent start" for headless mode.\n');
      process.exit(1);
    }

    // Hide cursor, enable raw mode for keyboard input
    this.#out.write(ansi.hide);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    // Key handling
    process.stdin.on('data', (key) => this.#onKey(key));

    // Terminal resize
    this.#out.on('resize', () => this.#render());

    // Wire agent events
    if (this.#agent) this.#wireAgent(this.#agent);

    // Render loop (4 fps)
    this.#renderTimer = setInterval(() => this.#render(), 250);
    this.#render();

    this.#log('info', 'Dashboard started');
    return this;
  }

  #wireAgent(agent) {
    agent.on('connected', () => {
      this.#state.connected = true;
      this.#log('info', `Connected to cloud`);
    });

    agent.on('disconnected', () => {
      this.#state.connected = false;
      this.#log('warn', 'Disconnected from cloud');
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
      // Keep only last ~200 chars for display
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
    // Auto-scroll to bottom when new entries arrive
    if (this.#scrollOffset === 0) {
      // Already at bottom, stay there
    }
  }

  // ── Key handler ─────────────────────────────────────────────────
  #onKey(key) {
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
        break;
      case 'r':
        this.#log('info', 'Reconnecting...');
        // Agent will handle reconnect
        break;
      case '\x1b[A': // Up arrow
        this.#scrollOffset = Math.min(this.#scrollOffset + 1, Math.max(0, this.#logs.length - 5));
        break;
      case '\x1b[B': // Down arrow
        this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
        break;
    }
  }

  // ── Rendering engine ────────────────────────────────────────────
  #render() {
    const W = this.#out.columns || 80;
    const H = this.#out.rows || 24;
    if (W < 40 || H < 12) return; // Too small

    const buf = [];
    const w = (s) => buf.push(s);

    // Clear + move to top
    w(ansi.clear);

    // ── Header ────────────────────────────────────────────────────
    const title = ` ${ansi.bold}${ansi.fg.bCyan}mona-agent${ansi.reset} ${ansi.dim}v${DEFAULTS.version}${ansi.reset}`;
    const statusIcon = this.#state.connected
      ? `${ansi.fg.bGreen}${ICON.connected} connected${ansi.reset}`
      : `${ansi.fg.bRed}${ICON.disconnected} disconnected${ansi.reset}`;
    const headerPad = W - this.#stripAnsi(title).length - this.#stripAnsi(statusIcon).length - 4;
    w(`${ansi.fg.gray}${B.tl}${B.h}${ansi.reset}${title} ${ansi.fg.gray}${B.h.repeat(Math.max(1, headerPad))} ${statusIcon} ${ansi.fg.gray}${B.h}${B.tr}${ansi.reset}\n`);

    // ── Layout calculations ───────────────────────────────────────
    const leftW = Math.min(30, Math.floor(W * 0.35));
    const rightW = W - leftW - 5; // 5 = borders + padding
    const bodyH = H - 4;          // header(1) + footer(2) + border(1)
    const sysH = Math.min(9, Math.floor(bodyH * 0.6));
    const taskH = bodyH - sysH;

    // ── Left column: System + Task ────────────────────────────────
    const sysLines = this.#renderSystem(leftW - 2);
    const taskLines = this.#renderTask(leftW - 2);

    // ── Right column: Activity log ────────────────────────────────
    const logLines = this.#renderLog(rightW - 2, bodyH - 2);

    // ── Compose body rows ─────────────────────────────────────────
    for (let row = 0; row < bodyH; row++) {
      let left = '';
      let right = '';

      // Left: system panel or task panel
      if (row === 0) {
        left = `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bCyan}System${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, leftW - 11))}${B.tr}${ansi.reset}`;
      } else if (row > 0 && row <= sysH - 2) {
        const line = sysLines[row - 1] || '';
        left = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(line, leftW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      } else if (row === sysH - 1) {
        left = `${ansi.fg.gray}${B.lt}${B.h} ${ansi.fg.bMagenta}Task${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, leftW - 9))}${B.rt}${ansi.reset}`;
      } else if (row >= sysH && row < bodyH - 1) {
        const tIdx = row - sysH;
        const line = taskLines[tIdx] || '';
        left = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(line, leftW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      } else if (row === bodyH - 1) {
        left = `${ansi.fg.gray}${B.bl}${B.h.repeat(leftW)}${B.br}${ansi.reset}`;
      }

      // Right: log panel
      if (row === 0) {
        right = `${ansi.fg.gray}${B.tl}${B.h} ${ansi.fg.bYellow}Activity${ansi.reset} ${ansi.fg.gray}${B.h.repeat(Math.max(0, rightW - 12))}${B.tr}${ansi.reset}`;
      } else if (row === bodyH - 1) {
        right = `${ansi.fg.gray}${B.bl}${B.h.repeat(rightW)}${B.br}${ansi.reset}`;
      } else {
        const logLine = logLines[row - 1] || '';
        right = `${ansi.fg.gray}${B.v}${ansi.reset} ${this.#padRight(logLine, rightW - 2)} ${ansi.fg.gray}${B.v}${ansi.reset}`;
      }

      w(`${ansi.fg.gray}${B.v}${ansi.reset}${left} ${right}${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    }

    // ── Footer ────────────────────────────────────────────────────
    const keys = `${ansi.dim}q${ansi.reset} quit ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}c${ansi.reset} clear ${ansi.fg.gray}·${ansi.reset} ${ansi.dim}↑↓${ansi.reset} scroll`;
    const taskStatus = this.#state.task
      ? `${ansi.fg.bYellow}${ICON.thinking} thinking${ansi.reset}`
      : `${ansi.fg.green}idle${ansi.reset}`;
    const footerPad = W - this.#stripAnsi(keys).length - this.#stripAnsi(taskStatus).length - 6;
    w(`${ansi.fg.gray}${B.lt}${B.h.repeat(W - 2)}${B.rt}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.v}${ansi.reset} ${keys}${' '.repeat(Math.max(1, footerPad))}${taskStatus} ${ansi.fg.gray}${B.v}${ansi.reset}\n`);
    w(`${ansi.fg.gray}${B.bl}${B.h.repeat(W - 2)}${B.br}${ansi.reset}\n`);

    this.#out.write(buf.join(''));
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
      `${ansi.fg.gray}OS${ansi.reset}     ${os.platform()} ${os.arch()}`,
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
      return [
        `${ansi.fg.bYellow}${ICON.thinking} Thinking...${ansi.reset}`,
        `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${t.tokens}${ansi.reset}  ${ansi.fg.gray}${elapsed}s${ansi.reset}`,
        `${ansi.dim}${preview}${ansi.reset}`,
        '',
        `${ansi.fg.gray}Total${ansi.reset}  ${s.tasks} tasks · ${s.tokens} tok`,
      ];
    }

    return [
      `${ansi.fg.green}${ICON.done} Idle${ansi.reset}`,
      '',
      `${ansi.fg.gray}Tasks${ansi.reset}  ${ansi.fg.bWhite}${s.tasks}${ansi.reset} completed`,
      `${ansi.fg.gray}Tokens${ansi.reset} ${ansi.fg.bWhite}${s.tokens}${ansi.reset} total`,
      `${ansi.fg.gray}Tools${ansi.reset}  ${ansi.fg.bWhite}${s.toolCalls}${ansi.reset} calls`,
      s.errors > 0 ? `${ansi.fg.bRed}Errors${ansi.reset} ${s.errors}` : '',
    ];
  }

  #renderLog(width, height) {
    const lines = [];
    const start = Math.max(0, this.#logs.length - height - this.#scrollOffset);
    const end = Math.min(this.#logs.length, start + height);

    for (let i = start; i < end; i++) {
      const entry = this.#logs[i];
      const icon = this.#logIcon(entry.type);
      const msg = truncate(entry.msg, width - 12);
      lines.push(`${ansi.fg.gray}${entry.time}${ansi.reset} ${icon} ${msg}`);
    }

    // Pad remaining
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
