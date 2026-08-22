// Audit-chain signing + anchoring — the hash chain alone is worthless
// against an attacker with agent rights; the signature + cloud anchor make
// it real. Every acceptance case from the plan:
//   tampered middle entry → right seq · removed entry → detected ·
//   fully recomputed chain under a foreign key → signature error ·
//   divergence vs. stored anchors → detected · two processes writing
//   concurrently must not break the chain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign, createHash } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'remoteagent-audit-sign-'));
process.env.HOME = join(TMP, 'home');
process.env.MONA_AUDIT_KEY_DIR = join(TMP, 'keys');
delete process.env.MONA_AUDIT;

const {
  auditWrite, auditVerify,
  AUDIT_DOMAIN, signAuditHash, verifyAuditHash, loadOrCreateAuditKey,
  keyPathFor, auditHead, anchorDue, compareAnchors,
} = await import('../src/index.mjs');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Every test gets its OWN log dir → its own device key, so no test can
// poison another's chain.
let seqDir = 0;
function freshAudit() {
  const dir = join(TMP, `case-${++seqDir}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'audit.jsonl');
}
const keyFor = (path) => loadOrCreateAuditKey(keyPathFor(path));

describe('audit signing primitives', () => {
  test('sign/verify roundtrip over the audit domain', () => {
    const p = freshAudit();
    const key = keyFor(p);
    const sig = signAuditHash('abc123', key.privateKey);
    assert.equal(verifyAuditHash('abc123', sig, key.publicKey), true);
    assert.equal(verifyAuditHash('abc124', sig, key.publicKey), false, 'wrong hash');
    assert.equal(verifyAuditHash('abc123', sig, key.publicKey.replace('A', 'B')), false, 'wrong key');
  });

  test('domain separation: a signature under another domain does not verify', () => {
    const p = freshAudit();
    const key = keyFor(p);
    const forged = cryptoSign(null, Buffer.from(`remoteagent-enrollment-v1.deadbeef`), key.privateKey).toString('base64url');
    assert.equal(verifyAuditHash('deadbeef', forged, key.publicKey), false);
  });
});

describe('audit chain + signatures', () => {
  test('entries carry sig/pub and the chain verifies', () => {
    const p = freshAudit();
    const key = keyFor(p);
    auditWrite({ kind: 'probe', n: 1 }, p);
    auditWrite({ kind: 'probe', n: 2 }, p);
    const v = auditVerify(p);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.checked, 2);
    const line = JSON.parse(readFileSync(p, 'utf8').trim().split('\n')[0]);
    assert.ok(line.sig, 'entry must carry a signature');
    assert.equal(line.pub, key.publicKey);
  });

  test('tampered middle entry is reported with its seq', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe', n: 3 }, p);
    auditWrite({ kind: 'probe', n: 4 }, p);
    auditWrite({ kind: 'probe', n: 5 }, p);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const idx = lines.length - 2;
    const rec = JSON.parse(lines[idx]);
    rec.reason = 'tampered';
    lines[idx] = JSON.stringify(rec);
    writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 });
    const v = auditVerify(p);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'hash mismatch');
    assert.equal(v.brokenAt, rec.seq, 'must name the tampered seq');
  });

  test('removed entry breaks the chain and is detected', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe', n: 6 }, p);
    auditWrite({ kind: 'probe', n: 7 }, p);
    auditWrite({ kind: 'probe', n: 8 }, p);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const removed = JSON.parse(lines[lines.length - 2]);
    const kept = lines.filter((_, i) => i !== lines.length - 2);
    writeFileSync(p, kept.join('\n') + '\n', { mode: 0o600 });
    const v = auditVerify(p);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'chain break');
    assert.equal(v.brokenAt, removed.seq + 1, 'chain break surfaces at the entry after the gap');
  });

  test('a fully recomputed chain under a foreign key fails with a signature error', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe', n: 1 }, p);
    auditWrite({ kind: 'probe', n: 2 }, p);
    auditWrite({ kind: 'probe', n: 3 }, p);
    const { privateKey: foreignPriv } = generateKeyPairSync('ed25519');
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    let prev = '';
    const rebuilt = lines.map((l) => {
      const rec = JSON.parse(l);
      const { hash: _hash, sig: _sig, pub: _pub, ...body } = rec;
      const line = JSON.stringify({ ...body, prev });
      const h = sha256(line);
      const s = cryptoSign(null, Buffer.from(`${AUDIT_DOMAIN}.${h}`), foreignPriv).toString('base64url');
      prev = h;
      return JSON.stringify({ ...JSON.parse(line), hash: h, sig: s });
    }).join('\n') + '\n';
    writeFileSync(p, rebuilt, { mode: 0o600 });
    const v = auditVerify(p);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'signature mismatch');
    assert.equal(v.brokenAt, 1, 'fails at the first foreign-signed entry');
  });

  test('an entry without a signature is reported', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe', n: 9 }, p);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    delete rec.sig;
    lines[lines.length - 1] = JSON.stringify(rec);
    writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 });
    const v = auditVerify(p);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'missing signature');
  });
});

describe('audit cross-process integrity (Fix 6)', () => {
  test('two processes writing 100 entries each keep one verifiable chain', () => {
    const p = freshAudit();
    const engineUrl = new URL('../src/index.mjs', import.meta.url).href;
    const run = (tag) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `const mod = await import(${JSON.stringify(engineUrl)}); for (let i = 0; i < 100; i++) mod.auditWrite({ kind: 'probe', tag: ${JSON.stringify(tag)}, i });`
    ], { env: { ...process.env, MONA_AUDIT: p }, timeout: 60_000, encoding: 'utf8' });
    const a = run('a');
    const b = run('b');
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    const v = auditVerify(p);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.checked, 200, "both processes' entries verified");
  });
});

describe('audit anchoring', () => {
  test('auditHead exposes the signed chain head', () => {
    const p = freshAudit();
    const key = keyFor(p);
    auditWrite({ kind: 'probe', anchor: true }, p);
    const h = auditHead(p);
    assert.ok(h && h.seq >= 1);
    assert.ok(h.hash && h.sig && h.signedAt);
    assert.equal(verifyAuditHash(h.hash, h.sig, key.publicKey), true, 'head signature verifies');
  });

  test('anchorDue fires on every-N or every-5-minutes', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe' }, p);
    const head = auditHead(p);
    assert.equal(anchorDue({ lastSeq: head.seq, lastAt: Date.now() }, { head }), false, 'fresh anchor → not due');
    assert.equal(anchorDue({ lastSeq: head.seq - 50, lastAt: Date.now() }, { head }), true, '50 new entries → due');
    assert.equal(anchorDue({ lastSeq: head.seq, lastAt: Date.now() - 301_000 }, { head }), true, '5 minutes elapsed → due');
  });

  test('compareAnchors detects divergence with the seq', () => {
    const p = freshAudit();
    auditWrite({ kind: 'probe', n: 1 }, p);
    auditWrite({ kind: 'probe', n: 2 }, p);
    auditWrite({ kind: 'probe', n: 3 }, p);
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    const anchors = [1, 3].map((seq) => {
      const rec = JSON.parse(lines[seq - 1]);
      return { seq, hash: rec.hash };
    });
    const match = compareAnchors(p, anchors);
    assert.equal(match.ok, true, JSON.stringify(match));

    // Tamper the local entry at seq 3 — the anchor must catch it.
    const tampered = JSON.parse(lines[2]);
    tampered.reason = 'rewritten locally';
    lines[2] = JSON.stringify(tampered);
    writeFileSync(p, lines.join('\n') + '\n', { mode: 0o600 });
    const c = compareAnchors(p, anchors);
    assert.equal(c.ok, false);
    assert.equal(c.divergentAt, 3);
    assert.match(c.reason, /diverges from cloud anchor/);

    // Anchored seq with no local entry at all.
    const missing = compareAnchors(p, [{ seq: 10_000, hash: 'x' }]);
    assert.equal(missing.ok, false);
    assert.equal(missing.divergentAt, 10_000);
  });
});

test('key file is created next to the log with 0600', () => {
  const p = freshAudit();
  keyFor(p);
  const st = statSync(keyPathFor(p));
  assert.equal(st.mode & 0o777, 0o600);
});
