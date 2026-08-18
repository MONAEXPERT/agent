// sandbox.js — OS-level containment for spawned commands.
//
// Three backends, one interface. wrap(argv, opts) returns the tuple the
// caller must actually spawn:
//
//   Linux  bwrap (bubblewrap) — kernel namespaces, no root, packaged in
//          most distros. Declarative read-only system bind + rw workspace,
//          tmpfs /tmp, own PID namespace. --new-session is mandatory: without
//          an own session the child could TIOCSTI into the parent terminal.
//   macOS  sandbox-exec — deprecated but functional on some builds; a
//          deny-default profile written to /tmp with 0600. Availability is
//          PROBED (one real spawn), never assumed: some macOS builds abort
//          every deny-default profile, and an available-but-broken backend
//          must be reported as unavailable. Profile path is generated here,
//          never composed from user input (workspace paths are device-side).
//   Win32  none — no cheap equivalent (AppContainer needs Win32 interop).
//          Honest degradation: the caller's deny-list stays active and
//          doctor reports `sandbox: unavailable (windows)`.
//
// Activation is a caller policy decision (mode `full` or MONA_SANDBOX=1):
// spawnTuple() throws SandboxUnavailableError when a sandbox is REQUIRED
// but no backend exists — degraded runs are never silent. MONA_NO_SANDBOX=1
// is the explicit escape hatch (passthrough, reported as such).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const PLATFORM = os.platform();

export class SandboxUnavailableError extends Error {}

function has(cmd, pathEnv = process.env.PATH) {
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// sandbox-exec is deprecated and misbehaves on some macOS builds (observed:
// SIGABRT on every deny-default profile, macOS 14.8 x86_64). Presence of the
// binary is NOT availability: probe once with a real deny-default profile and
// a trivially safe command. The result is cached per process — a spawn probe
// per command would be its own cost.
const PROBE_MARKER = 'mona-sandbox-probe';
let PROBE_RESULT = null; // null | true | false

function probeSandboxExec() {
  if (PROBE_RESULT !== null) return PROBE_RESULT;
  let dir = null;
  let profilePath = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-sb-probe-'));
    const w = wrapSandboxExec(['/bin/echo', PROBE_MARKER], { readRoots: [], writeRoots: [dir] });
    profilePath = w.profilePath;
    const r = spawnSync(w.cmd, w.args, { encoding: 'utf8', timeout: 5000 });
    PROBE_RESULT = r.status === 0 && String(r.stdout).includes(PROBE_MARKER);
  } catch {
    PROBE_RESULT = false;
  } finally {
    try { if (profilePath) fs.rmSync(profilePath, { force: true }); } catch { /* best effort */ }
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return PROBE_RESULT;
}

/** Which OS backend actually works on this machine. */
export function detect({ platform = PLATFORM, pathEnv = process.env.PATH, probe = true } = {}) {
  if (platform === 'linux') {
    return has('bwrap', pathEnv)
      ? { backend: 'bwrap', available: true }
      : { backend: null, available: false, reason: 'bwrap not found' };
  }
  if (platform === 'darwin') {
    if (!has('sandbox-exec', pathEnv)) {
      return { backend: null, available: false, reason: 'sandbox-exec not found' };
    }
    if (probe && !probeSandboxExec()) {
      return { backend: 'sandbox-exec', available: false, reason: 'sandbox-exec is present but fails on this macOS build' };
    }
    return { backend: 'sandbox-exec', available: true };
  }
  return { backend: null, available: false, reason: 'no OS sandbox on windows' };
}

/** Bind helper: only existing sources are bound (bwrap fails on missing
 *  source paths; /lib64 does not exist on every distro). */
function bindExisting(flags, src, dst, ro) {
  if (!fs.existsSync(src)) return;
  flags.push(ro ? '--ro-bind' : '--bind', src, dst);
}

/** bwrap argv for the given command argv. Unit-testable without bwrap. */
export function buildBwrapArgv(argv, { readRoots = [], writeRoots = [] } = {}) {
  const flags = [];
  for (const r of ['/usr', '/lib', '/lib64', '/bin']) bindExisting(flags, r, r, true);
  // DNS + TLS trust material; never /etc wholesale.
  bindExisting(flags, '/etc/resolv.conf', '/etc/resolv.conf', true);
  for (const r of ['/etc/ssl', '/etc/ca-certificates']) bindExisting(flags, r, r, true);
  for (const r of readRoots) bindExisting(flags, r, r, true);
  for (const w of writeRoots) bindExisting(flags, w, w, false);
  flags.push(
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--',
    ...argv,
  );
  return ['bwrap', ...flags];
}

const PROFILE_LITERALS = ['/etc/resolv.conf', '/dev/null', '/dev/zero', '/dev/urandom'];

/** sandbox-exec profile source. Unit-testable without sandbox-exec. */
export function buildSandboxExecProfile({ readRoots = [], writeRoots = [] } = {}) {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec (subpath "/usr/bin") (subpath "/bin"))',
    `(allow file-read* (subpath "/usr") (subpath "/System") ${PROFILE_LITERALS.map((l) => `(literal "${l}")`).join(' ')})`,
    '(allow sysctl-read)',
  ];
  const dirs = [...new Set([...readRoots, ...writeRoots])];
  if (dirs.length) {
    const subs = dirs.map((d) => `(subpath "${String(d).replace(/"/g, '\\"')}")`).join(' ');
    lines.push(`(allow file-read* file-write* ${subs})`);
  }
  return lines.join('\n') + '\n';
}

/** Wrap argv in sandbox-exec. Writes the profile 0600 into tmpdir; the
 *  profile path is generated (pid + timestamp) — never user input. */
export function wrapSandboxExec(argv, { readRoots = [], writeRoots = [] } = {}) {
  const profile = buildSandboxExecProfile({ readRoots, writeRoots });
  const profilePath = path.join(os.tmpdir(), `mona-sandbox-${process.pid}-${Date.now()}.sb`);
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });
  return {
    cmd: 'sandbox-exec',
    args: ['-f', profilePath, ...argv],
    backend: 'sandbox-exec',
    profilePath,
    profile,
  };
}

/**
 * Wrap argv for the available backend.
 * Returns { cmd, args, backend, degraded, reason? , profilePath? }.
 * The agent's own node dir is always a read root so the agent can spawn
 * node helpers under the same containment.
 */
export function wrap(argv, { readRoots = [], writeRoots = [] } = {}) {
  if (process.env.MONA_NO_SANDBOX === '1') {
    return { cmd: argv[0], args: argv.slice(1), backend: null, degraded: false, passthrough: true, reason: 'disabled by MONA_NO_SANDBOX' };
  }
  const d = detect();
  if (!d.available) {
    return { cmd: argv[0], args: argv.slice(1), backend: null, degraded: true, reason: d.reason };
  }
  const read = [...readRoots];
  try { read.push(path.dirname(process.execPath)); } catch { /* no execPath */ }
  if (d.backend === 'bwrap') {
    return { cmd: 'bwrap', args: buildBwrapArgv(argv, { readRoots: read, writeRoots }), backend: 'bwrap' };
  }
  const w = wrapSandboxExec(argv, { readRoots: read, writeRoots });
  return { cmd: w.cmd, args: w.args, backend: 'sandbox-exec', profilePath: w.profilePath };
}

/**
 * Spawn tuple for a resolved binary. When `required` is true (mode `full`
 * or MONA_SANDBOX=1) a missing backend throws instead of degrading
 * silently. MONA_NO_SANDBOX=1 downgrades to an explicit passthrough.
 */
export function spawnTuple(bin, args, { required = false, readRoots = [], writeRoots = [] } = {}) {
  if (!required && process.env.MONA_SANDBOX !== '1') {
    return { cmd: bin, args, backend: null };
  }
  const w = wrap([bin, ...args], { readRoots, writeRoots });
  if (w.degraded) {
    throw new SandboxUnavailableError(`sandbox required but unavailable: ${w.reason}`);
  }
  return { cmd: w.cmd, args: w.args, backend: w.backend };
}
