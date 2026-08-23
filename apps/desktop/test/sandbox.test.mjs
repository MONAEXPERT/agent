// Sandbox backends — argv construction per platform (pure unit tests),
// honest degradation, and real containment checks when the host backend
// actually works. The profile/argv builders are tested everywhere; spawn-
// level tests run only when detect() reports a working backend. A backend
// that exists but misbehaves must be reported unavailable — tested by the
// detect() honesty case.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const {
  detect, buildBwrapArgv, buildSandboxExecProfile, wrapSandboxExec,
  wrap, spawnTuple, SandboxUnavailableError, PLATFORM,
} = await import('../src/sandbox.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-sb-test-'));
const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'data.txt'), 'workspace-data');

// POSIX-only assertions (bind paths like /usr do not exist on Windows CI).
const posix = PLATFORM === 'win32' ? describe.skip : describe;

posix('sandbox argv builders', () => {
  it('bwrap argv: ro system binds, rw workspace, namespace flags, argv passthrough', () => {
    const argv = buildBwrapArgv(['/bin/echo', 'hi'], { readRoots: [TMP], writeRoots: [WS] });
    const s = argv.join('\n');
    assert.equal(argv[0], 'bwrap');
    assert.ok(s.includes('--ro-bind\n/usr\n/usr'), 'ro-binds /usr');
    assert.ok(s.includes(`--bind\n${WS}\n${WS}`), 'rw-binds workspace');
    assert.ok(s.includes(`--ro-bind\n${TMP}\n${TMP}`), 'read root');
    assert.ok(s.includes('--tmpfs\n/tmp'));
    assert.ok(s.includes('--proc\n/proc'));
    assert.ok(s.includes('--dev\n/dev'));
    assert.ok(s.includes('--unshare-pid'));
    assert.ok(s.includes('--die-with-parent'));
    assert.ok(s.includes('--new-session'));
    assert.ok(s.includes('--\n/bin/echo\nhi'), 'original argv after --');
  });

  it('bwrap argv skips non-existent bind sources', () => {
    const argv = buildBwrapArgv(['/bin/echo'], { writeRoots: ['/does/not/exist'] });
    assert.ok(!argv.join('\n').includes('/does/not/exist'));
  });

  it('wrapSandboxExec writes a 0600 profile with a generated name', () => {
    const w = wrapSandboxExec(['/bin/echo', 'x'], { writeRoots: [WS] });
    assert.equal(w.cmd, 'sandbox-exec');
    assert.equal(w.args[0], '-f');
    assert.ok(w.profilePath.startsWith(os.tmpdir()));
    assert.match(path.basename(w.profilePath), /^remoteagent-sandbox-\d+-\d+\.sb$/);
    const st = fs.statSync(w.profilePath);
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(w.profilePath, 'utf8').includes('(deny default)'));
    fs.rmSync(w.profilePath, { force: true });
  });
});

describe('sandbox-exec profile source', () => {
  it('deny default + explicit allows + workspace subpath', () => {
    const p = buildSandboxExecProfile({ readRoots: ['/extra'], writeRoots: [WS] });
    assert.ok(p.startsWith('(version 1)\n(deny default)'));
    assert.ok(p.includes('(allow process-exec (subpath "/usr/bin") (subpath "/bin"))'));
    assert.ok(p.includes('(allow file-read*'));
    assert.ok(p.includes('(allow sysctl-read)'));
    assert.ok(p.includes(`(subpath "${WS}")`));
    assert.ok(p.includes('(allow file-read* file-write*'));
  });
});

describe('sandbox detection (platform-injected)', () => {
  it('linux without bwrap degrades with a reason', () => {
    const d = detect({ platform: 'linux', pathEnv: '/nonexistent', probe: false });
    assert.equal(d.available, false);
    assert.match(d.reason, /bwrap not found/);
  });

  it('linux with a bwrap binary in PATH is available', () => {
    const binDir = path.join(TMP, 'fakebin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'bwrap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const d = detect({ platform: 'linux', pathEnv: binDir, probe: false });
    assert.equal(d.backend, 'bwrap');
    assert.equal(d.available, true);
  });

  it('darwin without sandbox-exec degrades', () => {
    const d = detect({ platform: 'darwin', pathEnv: '/nonexistent', probe: false });
    assert.equal(d.available, false);
    assert.match(d.reason, /sandbox-exec not found/);
  });

  it('windows has no backend', () => {
    const d = detect({ platform: 'win32', pathEnv: '/nonexistent', probe: false });
    assert.equal(d.available, false);
    assert.match(d.reason, /no OS sandbox on windows/);
  });

  it('detect() on the real host either works or says why it cannot', () => {
    const d = detect();
    assert.equal(typeof d.available, 'boolean');
    if (!d.available) assert.ok(d.reason && d.reason.length > 0, 'degradation must carry a reason');
  });
});

describe('spawnTuple / wrap policy', () => {
  it('MONA_NO_SANDBOX=1 forces an explicit passthrough even when required', () => {
    process.env.MONA_NO_SANDBOX = '1';
    try {
      const t = spawnTuple('/bin/echo', ['x'], { required: true, writeRoots: [WS] });
      assert.equal(t.cmd, '/bin/echo');
      assert.equal(t.backend, null);
    } finally {
      delete process.env.MONA_NO_SANDBOX;
    }
  });

  it('not required on a host without a working backend = plain spawn', () => {
    const d = detect();
    if (!d.available) {
      const t = spawnTuple('/bin/echo', ['x'], { required: false, writeRoots: [WS] });
      assert.equal(t.cmd, '/bin/echo');
      assert.equal(t.backend, null);
    }
  });
});

// Real spawn containment — only meaningful when the host backend works.
const host = detect();
if (host.available) {
  describe('real containment', () => {
    it('reading inside the write root works', () => {
      const t = spawnTuple('/bin/cat', [path.join(WS, 'data.txt')], { required: true, writeRoots: [WS] });
      const r = spawnSync(t.cmd, t.args, { encoding: 'utf8', timeout: 10_000 });
      assert.equal(r.status, 0, String(r.stderr));
      assert.equal(r.stdout, 'workspace-data');
    });

    it('reading outside the roots fails', () => {
      const t = spawnTuple('/bin/cat', ['/etc/hosts'], { required: true, writeRoots: [WS] });
      const r = spawnSync(t.cmd, t.args, { encoding: 'utf8', timeout: 10_000 });
      assert.notEqual(r.status, 0);
      assert.equal(r.stdout, '');
    });

    it('a required sandbox that works is reported with its backend', () => {
      const t = spawnTuple('/bin/echo', ['x'], { required: true, writeRoots: [WS] });
      assert.ok(t.backend === 'bwrap' || t.backend === 'sandbox-exec');
    });
  });
} else {
  describe('honest degradation', () => {
    it('host backend is reported unavailable with a reason', () => {
      assert.equal(host.available, false);
      assert.ok(host.reason && host.reason.length > 0);
    });

    it('a required sandbox refuses to run instead of degrading silently', () => {
      assert.throws(
        () => spawnTuple('/bin/echo', ['x'], { required: true, writeRoots: [WS] }),
        SandboxUnavailableError
      );
    });

    it('wrap() returns the degraded tuple, never a fake one', () => {
      const w = wrap(['/bin/echo', 'x'], { writeRoots: [WS] });
      assert.equal(w.degraded, true);
      assert.equal(w.backend, null);
      assert.equal(w.cmd, '/bin/echo');
    });
  });
}
