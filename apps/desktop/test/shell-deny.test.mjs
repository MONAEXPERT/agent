// Sensitive-path deny-list: the shell and jobs tools must refuse to read
// credential/key material through ANY branch — foreground, pipe stage 2+,
// background mode, and the jobs background driver — and for every spelling
// (tilde, $HOME expansion, relative arg + sensitive cwd). HOME is isolated
// (same style as the jobs/security suites) so the deny-list resolves against
// a fake home and no real user config is ever touched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-deny-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
process.env.MONA_ALLOW_CMDS = 'echo,node,cat,ls,head';

const WS = path.join(FAKE_HOME, 'workspace');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.ssh'), { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.aws'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, '.ssh', 'id_rsa'), 'PRIVATE KEY MATERIAL');
fs.writeFileSync(path.join(FAKE_HOME, '.aws', 'credentials'), '[default]\naws_secret = x');
fs.writeFileSync(path.join(WS, 'README.md'), 'hello workspace');

const { shell } = await import('../src/tools/shell.js');
const { jobs } = await import('../src/tools/jobs.js');

describe('shell sensitive-path deny-list', () => {
  it('denies a tilde-qualified sensitive path', async () => {
    const r = await shell.run({ cmd: 'cat ~/.ssh/id_rsa' });
    assert.ok(r.error, 'expected an error');
    assert.match(r.error, /denied by device policy/);
    assert.match(r.error, /~\/\.ssh/);
    assert.ok(!String(r.stdout || '').includes('PRIVATE KEY'), 'no key material leaked');
  });

  it('denies $HOME-expanded sensitive paths', async () => {
    const r = await shell.run({ cmd: 'cat $HOME/.aws/credentials' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
    assert.ok(!String(r.stdout || '').includes('aws_secret'));
  });

  it('denies a sensitive cwd with a relative argument', async () => {
    const r = await shell.run({ cmd: 'cat id_rsa', cwd: '~/.ssh' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies a sensitive cwd even when the relative file exists there', async () => {
    const r = await shell.run({ cmd: 'cat id_rsa', cwd: path.join(FAKE_HOME, '.ssh') });
    assert.ok(r.error && /denied by device policy/.test(r.error));
    assert.ok(!String(r.stdout || '').includes('PRIVATE KEY'), 'no key material leaked');
  });

  it('denies sensitive paths in pipe stages', async () => {
    const r = await shell.run({ cmd: 'cat ~/.ssh/id_rsa | head' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies a sensitive path in a later pipe stage', async () => {
    const r = await shell.run({ cmd: 'cat README.md | head ~/.netrc' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies sensitive paths in background mode', async () => {
    const r = await shell.run({ cmd: 'cat ~/.ssh/id_rsa', background: true });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies system-level paths', async () => {
    for (const p of ['/etc/shadow', '/etc/sudoers', '/proc/self/environ']) {
      const r = await shell.run({ cmd: `cat ${p}` });
      assert.ok(r.error && /denied by device policy/.test(r.error), `expected denial for ${p}`);
    }
  });

  it('denies traversal into a sensitive dir from a sibling cwd', async () => {
    const r = await shell.run({ cmd: 'cat ../.ssh/id_rsa', cwd: WS });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies lexically even when the file does not exist', async () => {
    const r = await shell.run({ cmd: 'cat ~/.gnupg/private-keys-v1.d/x' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('denies listing a sensitive directory', async () => {
    const r = await shell.run({ cmd: 'ls ~/.aws', cwd: WS });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('allows ordinary workspace reads', async () => {
    const r = await shell.run({ cmd: 'cat README.md', cwd: WS });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello workspace/);
  });

  it('allows commands without path arguments', async () => {
    const r = await shell.run({ cmd: 'echo hello', cwd: WS });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello/);
  });
});

describe('jobs sensitive-path deny-list', () => {
  it('refuses to start a job reading a sensitive path', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'cat ~/.aws/credentials' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('refuses a sensitive cwd', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'cat id_rsa', cwd: '~/.ssh' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('refuses a sensitive path in a pipe chain', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'cat ~/.ssh/id_rsa | head' });
    assert.ok(r.error && /denied by device policy/.test(r.error));
  });

  it('starts a benign job in the workspace', async () => {
    const r = await jobs.run({ action: 'start', cmd: 'cat README.md', cwd: WS });
    assert.equal(r.status, 'running');
    const w = await jobs.run({ action: 'wait', id: r.id, timeoutS: 10 });
    assert.equal(w.status, 'done');
    assert.equal(w.exitCode, 0);
    assert.ok(w.stdout.includes('hello workspace'));
  });
});
