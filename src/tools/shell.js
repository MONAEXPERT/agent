// Sandboxed shell tool — only allowlisted commands run by default.
// Set MONA_ALLOW_CMDS to extend. Use MONA_SHELL_UNSAFE=1 to allow anything
// (NOT recommended for production).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(exec);

const DEFAULT_ALLOW = 'df,uptime,uname,whoami,date,hostname,free,ps,top,cat,head,tail,wc,ls,pwd,echo,env,which';
const ALLOW = new Set(
  (process.env.MONA_ALLOW_CMDS || DEFAULT_ALLOW)
    .split(',').map(s => s.trim()).filter(Boolean)
);
const UNSAFE = process.env.MONA_SHELL_UNSAFE === '1';

// Commands that are NEVER allowed, even in unsafe mode.
const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*f[a-z]*\s+)?[a-z]*\s*\/\s*$/i,  // rm -rf /
  /mkfs\b/i,
  /dd\s+if=/i,
  /:\(\)\s*\{.*\}/,                                  // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /chmod\s+777\s+\//,
];

const EXEC_OPTS = {
  timeout:   15_000,
  maxBuffer: 1 << 20, // 1 MB
  shell:     '/bin/sh',
  env: {
    ...process.env,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  },
};

export const shell = {
  name: 'shell',
  description: 'Execute a shell command (allowlisted by default; max 15s timeout)',
  args: { cmd: 'string — the command to run' },

  async run(args) {
    const cmd = String(args.cmd || '').trim();
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
      const base = cmd.split(/[;\s|&]/)[0].trim().split('/').pop();
      if (!ALLOW.has(base)) {
        return {
          error: `Command '${base}' not in allowlist`,
          allowed: [...ALLOW].sort(),
          hint: 'Set MONA_ALLOW_CMDS to extend',
        };
      }
    }

    try {
      const { stdout, stderr } = await pexec(cmd, EXEC_OPTS);
      return {
        exitCode: 0,
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 2000),
      };
    } catch (err) {
      return {
        exitCode: err.code ?? 1,
        stdout:   (err.stdout || '').slice(0, 8000),
        stderr:   (err.stderr || '').slice(0, 2000),
        error:    err.killed ? 'Command timed out (15s)' : err.message,
      };
    }
  },
};
