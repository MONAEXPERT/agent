// Unit + integration tests for mona-agent.
// Run: npm test (uses Node.js built-in test runner)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── Tool tests ────────────────────────────────────────────────────

describe('tools/sysinfo', () => {
  let sysinfo;
  before(async () => {
    ({ sysinfo } = await import('../src/tools/sysinfo.js'));
  });

  it('returns host info', async () => {
    const result = await sysinfo.run({});
    assert.ok(result.host);
    assert.ok(result.platform);
    assert.ok(result.arch);
    assert.ok(result.cpus > 0);
    assert.ok(result.mem.total > 0);
    assert.ok(result.mem.percent >= 0 && result.mem.percent <= 100);
    assert.ok(Array.isArray(result.loadavg));
    assert.equal(result.loadavg.length, 3);
  });
});

describe('tools/shell', () => {
  let shell;
  before(async () => {
    ({ shell } = await import('../src/tools/shell.js'));
  });

  it('runs allowed commands', async () => {
    const result = await shell.run({ cmd: 'echo hello' });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('hello'));
  });

  it('blocks disallowed commands', async () => {
    const result = await shell.run({ cmd: 'curl https://example.com' });
    assert.ok(result.error);
    assert.ok(result.error.includes('not in allowlist'));
  });

  it('rejects empty commands', async () => {
    const result = await shell.run({ cmd: '' });
    assert.ok(result.error);
  });

  it('rejects overly long commands', async () => {
    const result = await shell.run({ cmd: 'x'.repeat(3000) });
    assert.ok(result.error);
  });
});

describe('tools/files', () => {
  let files;
  before(async () => {
    ({ files } = await import('../src/tools/files.js'));
  });

  it('lists workspace directory', async () => {
    const result = await files.run({ action: 'list' });
    assert.ok(Array.isArray(result));
  });

  it('writes and reads a file', async () => {
    await files.run({ action: 'write', path: '__test.txt', content: 'hello test' });
    const result = await files.run({ action: 'read', path: '__test.txt' });
    assert.equal(result.content, 'hello test');
    await files.run({ action: 'delete', path: '__test.txt' });
  });

  it('rejects path traversal', async () => {
    try {
      await files.run({ action: 'read', path: '../../../etc/passwd' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('traversal'));
    }
  });
});

describe('tools/net', () => {
  let net;
  before(async () => {
    ({ net } = await import('../src/tools/net.js'));
  });

  it('rejects non-HTTP URLs', async () => {
    const result = await net.run({ action: 'fetch', url: 'ftp://example.com' });
    assert.ok(result.error);
  });

  it('validates method', async () => {
    const result = await net.run({ action: 'fetch', url: 'https://example.com', method: 'DELETE' });
    assert.ok(result.error);
  });
});

describe('tools/registry', () => {
  let tools;
  before(async () => {
    ({ tools } = await import('../src/tools/index.js'));
  });

  it('has all built-in tools', () => {
    const names = tools.names();
    assert.ok(names.includes('sysinfo'));
    assert.ok(names.includes('shell'));
    assert.ok(names.includes('files'));
    assert.ok(names.includes('net'));
  });

  it('lists tools with descriptions', () => {
    const list = tools.list();
    assert.ok(list.length >= 4);
    for (const tool of list) {
      assert.ok(tool.name);
      assert.ok(tool.description);
    }
  });

  it('returns error for unknown tools', async () => {
    const result = await tools.run('nonexistent', {});
    assert.ok(result.error);
    assert.ok(result.available);
  });
});

// ── Config tests ──────────────────────────────────────────────────

describe('config', () => {
  it('has valid cloud endpoints', async () => {
    const { CLOUD, DEFAULTS } = await import('../src/config.js');
    assert.ok(CLOUD.base.startsWith('http'));
    assert.ok(CLOUD.wsUrl.startsWith('ws'));
    assert.ok(DEFAULTS.version);
  });
});
