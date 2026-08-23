import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, memoryBackend, windowsDpapiBackend, dpapiScope } from '../src/credentials.js';

// Identity DPAPI runner: protect/unprotect are no-ops over the input, so the
// blob round-trips without a real Windows DPAPI call. The runner still gets the
// real PowerShell script so scope selection is exercised.
function identityRunner(_command, args, { input }) {
  return { status: 0, error: null, stdout: input };
}

// Runner whose unprotect (load) step fails, to exercise migration read-back.
function unprotectFailingRunner(_command, args, { input }) {
  if (args.join(' ').includes('Unprotect')) {
    return { status: 1, error: new Error('unprotect failed'), stdout: '' };
  }
  return { status: 0, error: null, stdout: input };
}

describe('credential store', () => {
  it('round-trips through an injected backend with metadata', () => {
    const store = createCredentialStore({ homeDir: mkdtempSync(join(tmpdir(), 'remoteagent-')), backend: memoryBackend() });
    store.save({ apiKey: 'secret', agentId: 'agent-1' });
    assert.deepEqual(store.load(), { apiKey: 'secret', agentId: 'agent-1' });
    assert.equal(store.metadata().secure, true);
    assert.equal(store.metadata().backend, 'memory');
  });

  it('rejects malformed credentials', () => {
    const store = createCredentialStore({ homeDir: mkdtempSync(join(tmpdir(), 'remoteagent-')), backend: memoryBackend() });
    assert.throws(() => store.save({ agentId: 'x' }), /apiKey/);
  });

  it('migrates a legacy file only after secure read-back', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'remoteagent-'));
    const legacy = join(homeDir, '.remoteagent', 'credentials.json');
    mkdirSync(join(homeDir, '.remoteagent'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ apiKey: 'secret', agentId: 'a' }));
    const store = createCredentialStore({ homeDir, backend: memoryBackend() });
    assert.equal(store.migrateLegacy(), true);
    assert.deepEqual(store.load(), { apiKey: 'secret', agentId: 'a' });
    assert.equal(existsSync(`${legacy}.migrated`), true);
  });

  it('DPAPI backend persists the blob and scope across store instances', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'remoteagent-dpapi-'));
    const dir = join(homeDir, '.remoteagent');
    const mk = () => windowsDpapiBackend({ dir, runner: identityRunner, scope: 'CurrentUser' });

    const store1 = createCredentialStore({ homeDir, os: 'win32', backend: mk() });
    store1.save({ apiKey: 'secret', agentId: 'a' });

    // A brand-new store instance on the same directory must recover the value
    // from disk — proving the blob and scope survive a process restart.
    const store2 = createCredentialStore({ homeDir, os: 'win32', backend: mk() });
    assert.deepEqual(store2.load(), { apiKey: 'secret', agentId: 'a' });

    assert.equal(existsSync(join(dir, 'credentials.dpapi')), true);
    assert.equal(readFileSync(join(dir, 'credentials.dpapi.scope'), 'utf8').trim(), 'CurrentUser');
  });

  it('DPAPI migration leaves the legacy file intact when read-back fails', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'remoteagent-dpapi-'));
    const legacy = join(homeDir, '.remoteagent', 'credentials.json');
    mkdirSync(join(homeDir, '.remoteagent'), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ apiKey: 'secret', agentId: 'a' }));

    const store = createCredentialStore({
      homeDir,
      os: 'win32',
      backend: windowsDpapiBackend({ dir: join(homeDir, '.remoteagent'), runner: unprotectFailingRunner, scope: 'CurrentUser' }),
    });

    assert.throws(() => store.migrateLegacy(), /read-back failed/);
    assert.equal(existsSync(legacy), true, 'legacy file must remain untouched');
    assert.equal(existsSync(`${legacy}.migrated`), false, 'legacy file must not be renamed');
  });

  it('dpapiScope rejects unknown scope values', () => {
    assert.equal(dpapiScope({ scope: 'CurrentUser' }), 'CurrentUser');
    assert.equal(dpapiScope({ scope: 'LocalMachine' }), 'LocalMachine');
    assert.throws(() => dpapiScope({ scope: 'HKEY_CURRENT_USER' }), /Invalid DPAPI scope/);
  });
});
