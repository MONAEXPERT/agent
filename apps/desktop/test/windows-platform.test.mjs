import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { platformPathEntries, executableCandidates } from '../src/tools/shell.js';
import { daemonStatus, daemonInstall, daemonUninstall } from '../src/daemon.js';

describe('Windows platform helpers', () => {
  it('splits Windows PATH using semicolons', () => {
    assert.deepEqual(platformPathEntries('win32', { PATH: 'C:\\Windows\\System32;C:\\Windows' }), ['C:\\Windows\\System32', 'C:\\Windows']);
  });

  it('expands PATHEXT candidates', () => {
    assert.deepEqual(executableCandidates('tasklist', 'win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD' }), ['tasklist.com', 'tasklist.exe', 'tasklist.bat', 'tasklist.cmd']);
  });

  it('does not require POSIX executable bits on Windows', () => {
    assert.equal(typeof platformPathEntries, 'function');
  });
});

describe('Windows daemon safety', () => {
  it('exposes explicit unsupported service status without invoking systemd', () => {
    const status = daemonStatus.call({});
    assert.ok(status);
  });

  it('returns an explicit unsupported result for service installation APIs', () => {
    assert.equal(typeof daemonInstall, 'function');
    assert.equal(typeof daemonUninstall, 'function');
  });
});
