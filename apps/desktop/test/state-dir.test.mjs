// State-dir migration: move ~/.mona-agent → ~/.remoteagent, symlink back.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateStateDir } from '../src/state-dir.js';

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'remoteagent-state-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function makeLegacy() {
  const dir = join(home, '.mona-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ apiKey: 'secret', agentId: 'a1' }));
  return dir;
}

describe('state-dir migration', () => {
  it('moves the legacy dir, leaves a symlink, and keeps the data intact', () => {
    const legacy = makeLegacy();
    const logs = [];
    assert.equal(migrateStateDir({ home, log: (m) => logs.push(m) }), true);
    assert.equal(existsSync(legacy), true, 'legacy path still resolves');
    assert.equal(lstatSync(legacy).isSymbolicLink(), true, 'legacy path is a symlink');
    assert.equal(existsSync(join(home, '.remoteagent')), true);
    const creds = JSON.parse(readFileSync(join(home, '.remoteagent', 'credentials.json'), 'utf8'));
    assert.equal(creds.apiKey, 'secret');
    assert.equal(logs.length, 1);
  });

  it('is a no-op when there is nothing to migrate', () => {
    assert.equal(migrateStateDir({ home }), false);
    assert.equal(existsSync(join(home, '.remoteagent')), false);
  });

  it('is a no-op on the second run (legacy is now a symlink)', () => {
    makeLegacy();
    assert.equal(migrateStateDir({ home }), true);
    assert.equal(migrateStateDir({ home }), false);
    assert.equal(lstatSync(join(home, '.mona-agent')).isSymbolicLink(), true);
  });

  it('never overwrites or merges when both directories exist', () => {
    makeLegacy();
    mkdirSync(join(home, '.remoteagent'), { recursive: true });
    writeFileSync(join(home, '.remoteagent', 'keep.txt'), 'new');
    assert.equal(migrateStateDir({ home }), false);
    assert.equal(lstatSync(join(home, '.mona-agent')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(home, '.remoteagent', 'keep.txt'), 'utf8'), 'new');
  });

  it('leaves a pre-existing user-managed symlink alone', () => {
    mkdirSync(join(home, '.remoteagent'), { recursive: true });
    symlinkSync(join(home, '.remoteagent'), join(home, '.mona-agent'), 'dir');
    assert.equal(migrateStateDir({ home }), false);
    assert.equal(lstatSync(join(home, '.mona-agent')).isSymbolicLink(), true);
  });
});
