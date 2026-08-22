// P3 policy engine tests — rules-based deny-by-default, when-conditions,
// first-match-wins, prompt effect, explain(), and adversarial vectors
// (path traversal, symlink escape, SSRF). 45+ cases.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Policy, globToRegExp, ipInCidr, pathWithin } = await import('../src/policy.js');

const WS = mkdtempSync(join(tmpdir(), 'remoteagent-policy-ws-'));
const AUDIT = join(mkdtempSync(join(tmpdir(), 'remoteagent-policy-')), 'audit.jsonl');
mkdirSync(join(WS, 'sub'), { recursive: true });
writeFileSync(join(WS, 'ok.txt'), 'ok');
writeFileSync(join(WS, 'sub', 'x.txt'), 'x');
try { symlinkSync('/etc/passwd', join(WS, 'evil-link')); } catch { /* best effort */ }

after(() => { rmSync(WS, { recursive: true, force: true }); rmSync(join(AUDIT, '..'), { recursive: true, force: true }); });

function makePolicy(rules, extra = {}) {
  return new Policy({ version: 2, audit: false, auditPath: AUDIT, rules, default: 'deny', ...extra });
}

describe('glob matching', () => {
  test('exact, prefix-glob, star', () => {
    assert.equal(globToRegExp('sysinfo').test('sysinfo'), true);
    assert.equal(globToRegExp('sysinfo.*').test('sysinfo.detail'), true);
    assert.equal(globToRegExp('sysinfo.*').test('sysinfo'), false);
    assert.equal(globToRegExp('fs.*').test('fs.read'), true);
    assert.equal(globToRegExp('*').test('anything.at.all'), true);
    assert.equal(globToRegExp('shell.run').test('shell.runx'), false);
  });
});

describe('CIDR + path matching', () => {
  test('private/loopback/metadata ranges', () => {
    assert.ok(ipInCidr('127.0.0.1', ['127.0.0.0/8']));
    assert.ok(ipInCidr('10.1.2.3', ['10.0.0.0/8']));
    assert.ok(ipInCidr('192.168.0.5', ['192.168.0.0/16']));
    assert.ok(ipInCidr('169.254.169.254', ['169.254.0.0/16']));
    assert.ok(ipInCidr('::1', ['::1/128']));
    assert.ok(ipInCidr('fd00::1', ['fc00::/7']));
    assert.ok(!ipInCidr('8.8.8.8', ['10.0.0.0/8', '127.0.0.0/8']));
    assert.ok(!ipInCidr('1.1.1.1', ['169.254.0.0/16']));
  });

  test('path containment is realpath + separator safe', () => {
    assert.ok(pathWithin(join(WS, 'ok.txt'), [WS]));
    assert.ok(pathWithin(join(WS, 'sub', 'x.txt'), [WS]));
    assert.ok(!pathWithin('/etc/passwd', [WS]));
    // prefix-confusable: /tmp/ws-evil must NOT match workspace /tmp/ws
    assert.ok(!pathWithin('/tmp/remoteagent-policy-ws-X-evil/../etc/passwd', [WS]));
    // symlink escape
    assert.ok(!pathWithin(join(WS, 'evil-link'), [WS]));
  });
});

describe('rules: first-match-wins + default deny', () => {
  const p = makePolicy([
    { tool: 'sysinfo.*', effect: 'allow' },
    { tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } },
    { tool: 'shell.run', effect: 'prompt', when: { argv0: { in: ['git', 'npm'] } } },
    { tool: 'net.fetch', effect: 'allow', when: { host: { notIn: ['metadata.google.internal'] }, ip: { notInCidr: ['127.0.0.0/8', '169.254.0.0/16', '10.0.0.0/8'] } } },
    { tool: '*', effect: 'deny' },
  ]);

  test('allowed by rule', () => {
    const a = p.check('sysinfo.detail', {});
    assert.equal(a.tier, 'allow');
    assert.equal(a.allowed, true);
    const b = p.check('sysinfo.metrics', {});
    assert.equal(b.tier, 'allow');
    assert.equal(b.allowed, true);
    const c = p.check('fs.read', { path: join(WS, 'ok.txt') });
    assert.equal(c.tier, 'allow');
    assert.equal(c.allowed, true);
  });

  test('bare tool name does not match namespace glob (sysinfo vs sysinfo.*)', () => {
    const v = p.check('sysinfo', {});
    assert.equal(v.tier, 'deny', 'sysinfo.* must not match bare sysinfo');
    assert.equal(v.allowed, false);
  });

  test('denied: inside workspace but rule requires within', () => {
    const a = p.check('fs.read', { path: '/etc/passwd' });
    assert.equal(a.tier, 'deny');
    assert.equal(a.allowed, false);
    const b = p.check('fs.read', { path: join(WS, 'evil-link') }); // symlink escape
    assert.equal(b.tier, 'deny');
    assert.equal(b.allowed, false);
    const c = p.check('fs.read', { path: join(WS, 'sub', '..', '..', 'etc', 'passwd') }); // traversal
    assert.equal(c.tier, 'deny');
    assert.equal(c.allowed, false);
  });

  test('prompt effect → confirm tier in headless', () => {
    const v = p.check('shell.run', { argv0: 'git', args: ['status'] });
    assert.equal(v.tier, 'confirm');
    assert.equal(v.allowed, false);
    assert.ok(v.reason.includes('prompt'));
  });

  test('prompt NOT granted for non-allowlisted argv0', () => {
    const v = p.check('shell.run', { argv0: 'rm' });
    assert.equal(v.tier, 'deny');
    assert.equal(v.allowed, false);
  });

  test('SSRF: metadata host + private ranges denied', () => {
    // The net tool normalizes url → { host, ip } args before the policy
    // gate; these cases test the policy engine's defense-in-depth layer.
    const cases = [
      { args: { url: 'http://metadata.google.internal/', host: 'metadata.google.internal' }, allowed: false },
      { args: { url: 'http://169.254.169.254/latest', ip: '169.254.169.254' }, allowed: false },
      { args: { url: 'http://10.0.0.1/', ip: '10.0.0.1' }, allowed: false },
      { args: { url: 'http://127.0.0.1:8080/', ip: '127.0.0.1' }, allowed: false },
      { args: { url: 'https://example.com', host: 'example.com', ip: '93.184.216.34' }, allowed: true },
    ];
    for (const { args, allowed } of cases) {
      const v = p.check('net.fetch', args);
      assert.equal(v.tier, allowed ? 'allow' : 'deny');
      assert.equal(v.allowed, allowed);
    }
  });

  test('catch-all deny fires for unknown tools', () => {
    const v = p.check('whatever.tool', {});
    assert.equal(v.tier, 'deny');
    assert.equal(v.allowed, false);
  });

  test('first-match-wins: earlier rule shadows later', () => {
    const p2 = makePolicy([
      { tool: '*', effect: 'allow' },
      { tool: 'shell.run', effect: 'deny' },
    ]);
    const v = p2.check('shell.run', {});
    assert.equal(v.tier, 'allow', 'first rule wins');
    assert.equal(v.allowed, true);
  });

  test('no rules array → deny by default', () => {
    const p3 = new Policy({ version: 2, audit: false, auditPath: AUDIT, rules: [] });
    const v = p3.check('anything', {});
    assert.equal(v.tier, 'deny');
    assert.equal(v.allowed, false);
  });
});

describe('explain()', () => {
  const p = makePolicy([
    { tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } },
    { tool: '*', effect: 'deny' },
  ]);

  test('shows matched rule', () => {
    const e = p.explain('fs.read', { path: join(WS, 'ok.txt') });
    assert.equal(e.matchedRule, 'fs.read');
    assert.equal(e.tier, 'allow');
    assert.match(e.decision, /fs.read.*matched/);
  });

  test('shows default when nothing matches', () => {
    const p2 = makePolicy([{ tool: 'fs.read', effect: 'allow', when: { path: { within: [WS] } } }]);
    const e = p2.explain('net.fetch', { url: 'https://x.com' });
    assert.equal(e.matchedRule, null);
    assert.equal(e.tier, 'deny');
    assert.match(e.decision, /default deny/);
  });

  test('legacy tier map explain', () => {
    const legacy = new Policy({ version: 1, tools: { shell: 'confirm' }, audit: false });
    const e = legacy.explain('shell', {});
    assert.equal(e.tier, 'confirm');
    assert.match(e.decision, /requires approval/);
  });

  test('explain does not consume a rate-limit token', () => {
    const pol = new Policy({ version: 1, tools: { shell: 'allow' }, rateLimits: { shell: { perMinute: 1 } }, audit: false });
    pol.explain('shell');
    pol.explain('shell');
    // explain() peeks; the actual check must still have its full allowance.
    assert.equal(pol.check('shell').allowed, true);
  });
});

describe('when-condition combinators', () => {
  test('min/max numeric bounds', () => {
    const p = makePolicy([
      { tool: 'fs.write', effect: 'allow', when: { size: { max: 100 } } },
      { tool: '*', effect: 'deny' },
    ]);
    const a = p.check('fs.write', { size: 50 });
    assert.equal(a.tier, 'allow');
    assert.equal(a.allowed, true);
    const b = p.check('fs.write', { size: 5000 });
    assert.equal(b.tier, 'deny');
    assert.equal(b.allowed, false);
  });

  test('in/notIn on scalar values', () => {
    const p = makePolicy([
      { tool: 'files.delete', effect: 'allow', when: { path: { notIn: ['/etc', '/usr'] } } },
      { tool: '*', effect: 'deny' },
    ]);
    const a = p.check('files.delete', { path: '/tmp/x' });
    assert.equal(a.tier, 'allow');
    assert.equal(a.allowed, true);
    const b = p.check('files.delete', { path: '/etc' });
    assert.equal(b.tier, 'deny');
    assert.equal(b.allowed, false);
  });

  test('includes: every substring must be present (not just the first)', () => {
    const p = makePolicy([
      { tool: 'files.write', effect: 'allow', when: { content: { includes: ['todo', 'urgent'] } } },
      { tool: '*', effect: 'deny' },
    ]);
    const ok = p.check('files.write', { content: 'urgent todo item' });
    assert.equal(ok.tier, 'allow');
    assert.equal(ok.allowed, true);
    // Has "todo" but not "urgent" — the old spread bug read only the first
    // substring and would have let this through.
    const missing = p.check('files.write', { content: 'todo item' });
    assert.equal(missing.tier, 'deny');
    assert.equal(missing.allowed, false);
  });
});

describe('remote policy cannot widen (architectural line)', () => {
  test('policy is constructed only from local disk content', () => {
    // Simulate a malicious remote payload: it must not affect the policy
    // instance that was loaded locally.
    const local = makePolicy([{ tool: '*', effect: 'deny' }]);
    const remote = { version: 2, rules: [{ tool: '*', effect: 'allow' }] };
    const a = local.check('shell.run', {});
    assert.equal(a.tier, 'deny');
    assert.equal(a.allowed, false);
    const b = new Policy({ ...local.raw, ...remote, audit: false }).check('shell.run', {});
    assert.equal(b.tier, 'allow', 'only a fresh local reload can change policy');
    assert.equal(b.allowed, true);
    const c = local.check('shell.run', {});
    assert.equal(c.tier, 'deny', 'loaded instance unchanged');
    assert.equal(c.allowed, false);
  });
});
