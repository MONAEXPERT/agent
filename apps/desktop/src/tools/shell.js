// Sandboxed shell tool — multi-OS (macOS, Linux, Windows).
// Detects platform and uses the appropriate shell.
// Only allowlisted commands run by default.
// Set MONA_ALLOW_CMDS to extend. Use MONA_SHELL_UNSAFE=1 to allow anything.

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const pexec = promisify(exec);

// ── Platform detection ────────────────────────────────────────────
const PLATFORM = os.platform(); // 'darwin' | 'linux' | 'win32'

const SHELL_CONFIG = {
  darwin: {
    shell: '/bin/zsh',
    path:  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  },
  linux: {
    shell: '/bin/sh',
    path:  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
  win32: {
    shell: 'powershell.exe',
    path:  '', // Windows uses system PATH
  },
};

const cfg = SHELL_CONFIG[PLATFORM] || SHELL_CONFIG.linux;

// ── OS-aware default allowlist ────────────────────────────────────
const DEFAULTS = {
  darwin: 'df,uptime,uname,whoami,date,hostname,vm_stat,top,cat,head,tail,wc,ls,pwd,echo,env,which,sw_vers,sysctl',
  linux:  'df,uptime,uname,whoami,date,hostname,free,ps,top,cat,head,tail,wc,ls,pwd,echo,env,which',
  win32:  'whoami,date,hostname,dir,type,echo,ver,systeminfo,tasklist',
};

const ALLOW = new Set(
  (process.env.MONA_ALLOW_CMDS || DEFAULTS[PLATFORM] || DEFAULTS.linux)
    .split(',').map(s => s.trim()).filter(Boolean)
);
const UNSAFE = process.env.MONA_SHELL_UNSAFE === '1';

/** Shell security posture — advertised to the cloud in `hello` so the
 *  control plane can enforce agent_permissions without probing. */
export const security = {
  allowlist: [...ALLOW].sort(),
  unsafe: UNSAFE,
  platform: PLATFORM,
};

// ── Per-OS command mapping (translate common unix  windows) ──────
const CMD_MAP_WIN32 = {
  ls: 'dir',
  cat: 'type',
  pwd: 'echo %cd%',
  uname: 'ver',
  df: 'wmic logicaldisk get size,freespace,caption',
  free: 'systeminfo | find "Available Physical Memory"',
  uptime: 'systeminfo | find "System Boot Time"',
  whoami: 'whoami',
  clear: 'cls',
  cp: 'copy',
  mv: 'move',
  rm: 'del',
};

// ── Blocked patterns (always denied) ──────────────────────────────
const BLOCKED_PATTERNS = [
  // Unix
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\/s*$/i,
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\*\s*$/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  /:\(\)\s*\{.*\}/,
  />\s*\/dev\/sd[a-z]/i,
  /chmod\s+777\s+\//i,
  /sudo\b/i,
  /shutdown\b/i,
  /poweroff\b|reboot\b|halt\b/i,
  // Pipe-to-shell: remote code execution via downloader
  /curl\s+.*\|\s*(ba|z)?sh/i,
  /wget\s+.*\|\s*(ba|z)?sh/i,
  // Windows
  /format\s+[a-z]:/i,
  /del\s+\/f\s+\/s\s+[a-z]:\\/i,
  /rmdir\s+\/s\s+[a-z]:\\/i,
  /diskpart\b/i,
];

const EXEC_OPTS = {
  timeout:   15_000,
  maxBuffer: 1 << 20, // 1 MB
  shell:     cfg.shell,
  env: {
    ...process.env,
    PATH: cfg.path || process.env.PATH,
  },
};

// ── Tool definition ───────────────────────────────────────────────
export const shell = {
  name: 'shell',
  description: `Execute a shell command (${PLATFORM}; allowlisted by default; max 15s timeout; background:true for GUI/long-running processes)`,
  args: { cmd: 'string — the command to run', background: 'bool — optional, detach and return immediately (for GUI apps, servers, tkinter windows)' },
  platform: PLATFORM,

  async run(args) {
    let cmd = String(args.cmd || '').trim();
    if (!cmd) return { error: 'Empty command' };
    if (cmd.length > 2000) return { error: 'Command too long (max 2000 chars)' };

    // Block dangerous patterns always
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(cmd)) {
        return { error: 'Command blocked for security', cmd };
      }
    }

    // Allowlist check (unless unsafe mode)
    if (!UNSAFE) {
      const base = cmd.split(/[;\s|&]/)[0].trim().split('/').pop().split('\\').pop();
      if (!ALLOW.has(base)) {
        return {
          error: `Command '${base}' not in allowlist`,
          allowed: [...ALLOW].sort(),
          platform: PLATFORM,
          hint: 'Set MONA_ALLOW_CMDS to extend',
        };
      }
    }

    // Map unix commands to Windows equivalents when on win32
    if (PLATFORM === 'win32' && CMD_MAP_WIN32[cmd.split(/\s+/)[0].toLowerCase()]) {
      const [orig, ...rest] = cmd.split(/\s+/);
      cmd = CMD_MAP_WIN32[orig.toLowerCase()] + (rest.length ? ' ' + rest.join(' ') : '');
    }

    try {
      // Background mode: GUI apps / long-running processes (e.g. tkinter
      // windows) must not block the task or die with the 15s timeout.
      if (args.background) {
        const logFile = path.join(os.homedir(), '.mona-agent', `bg-${Date.now()}.log`);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const out = fs.openSync(logFile, 'a');
        const child = spawn(cfg.shell, ['-c', cmd], {
          detached: true,
          stdio: ['ignore', out, out],
          env: { ...process.env, PATH: cfg.path || process.env.PATH },
        });
        child.unref();
        fs.closeSync(out);
        return {
          exitCode: null,
          pid: child.pid,
          background: true,
          log: logFile,
          note: 'Process started in background and detached from the agent. Output: ' + logFile,
          platform: PLATFORM,
        };
      }

      const { stdout, stderr } = await pexec(cmd, EXEC_OPTS);
      return {
        exitCode: 0,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 2000),
        platform: PLATFORM,
      };
    } catch (err) {
      return {
        exitCode: err.code ?? 1,
        stdout:   (err.stdout || '').slice(0, 8000),
        stderr:   (err.stderr || '').slice(0, 2000),
        error:    err.killed ? 'Command timed out (15s)' : err.message,
        platform: PLATFORM,
      };
    }
  },
};
