// Audit chain signing + anchoring — the device half of tamper-evidence.
//
// The hash chain alone is worthless against an attacker with agent rights:
// they recompute it. Every audit entry therefore carries an Ed25519
// signature over `${AUDIT_DOMAIN}.${hash}`, made with the device's audit
// key (persisted next to the audit log, 0600; generated on first use with
// the same identity generator as device-registry.js). Domain separation:
// AUDIT_DOMAIN is its own string — an enrollment or grant signature can
// never be replayed as an audit signature and vice versa.
//
// The verifier checks the chain AND every signature against the device
// key. A fully recomputed chain under a foreign key fails at the first
// entry. Chain heads ({seq, hash, signedAt, sig, pub}) are anchored at the
// control plane every N entries / 5 minutes, so the device cannot rewrite
// its own history without diverging from the stored anchors.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateDeviceIdentity } from './device-registry.js';
import { env } from './env.js';

/** Domain-separation context — never reuse enrollment/grant strings. */
export const AUDIT_DOMAIN = 'mona-audit-v1';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const KEY_DIR_ENV = env('AUDIT_KEY_DIR');

/** The audit key lives next to its log (or in RA_AUDIT_KEY_DIR). */
export function keyPathFor(auditPath) {
  if (KEY_DIR_ENV) return join(KEY_DIR_ENV, 'audit-key.json');
  return join(dirname(auditPath), 'audit-key.json');
}

/** Load the device audit key, creating it (0600) on first use. */
export function loadOrCreateAuditKey(file) {
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && raw.privateKey && raw.publicKey) return raw;
    }
  } catch { /* corrupt key file → regenerate */ }
  const id = generateDeviceIdentity();
  const stored = {
    algorithm: 'Ed25519',
    publicKey: id.publicKey,
    privateKey: id.privateKey,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  return stored;
}

/** Ed25519 over `${AUDIT_DOMAIN}.${hash}` — base64url. */
export function signAuditHash(hash, privateKey) {
  return sign(null, Buffer.from(`${AUDIT_DOMAIN}.${hash}`), createPrivateKey(privateKey)).toString('base64url');
}

export function verifyAuditHash(hash, sig, publicKey) {
  try {
    return verify(null, Buffer.from(`${AUDIT_DOMAIN}.${hash}`), createPublicKey(publicKey), Buffer.from(String(sig || ''), 'base64url'));
  } catch {
    return false;
  }
}

/** Chain head for anchoring: {seq, hash, signedAt, sig, pub} or null. */
export function auditHead(auditPath) {
  try {
    if (!existsSync(auditPath)) return null;
    const text = readFileSync(auditPath, 'utf8').trimEnd();
    if (!text) return null;
    const last = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
    if (last && Number.isFinite(last.seq) && last.hash && last.sig) {
      return { seq: last.seq, hash: last.hash, signedAt: last.ts, sig: last.sig, pub: last.pub || null };
    }
    return null;
  } catch {
    return null;
  }
}

/** Anchor cadence: every N entries or every 5 minutes. */
export function anchorDue(state, { everyN = 50, everyMs = 300_000, head = null, now = Date.now() } = {}) {
  const s = state || { lastSeq: 0, lastAt: 0 };
  if (!head) return false;
  return head.seq - (s.lastSeq || 0) >= everyN || now - (s.lastAt || 0) >= everyMs;
}

/**
 * Compare the local chain against stored cloud anchors. The entry hash is
 * RECOMPUTED from the line content — the stored hash/sig fields are never
 * trusted, so a locally rewritten history diverges even if its hash fields
 * were recomputed to match. Returns { ok, divergentAt?, reason? } — the
 * FIRST divergence wins, with its seq.
 */
export function compareAnchors(localPath, anchors) {
  try {
    const lines = readFileSync(localPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const a of anchors || []) {
      const seq = Number(a.seq);
      if (!Number.isFinite(seq) || seq < 1) continue;
      const line = lines[seq - 1];
      if (!line) return { ok: false, divergentAt: seq, reason: 'local chain has no entry for anchored seq' };
      let rec;
      try { rec = JSON.parse(line); } catch { return { ok: false, divergentAt: seq, reason: 'corrupt local entry at anchored seq' }; }
      const { hash: _hash, sig: _sig, pub: _pub, ...rest } = rec;
      const recomputed = sha256(JSON.stringify({ seq: rec.seq, ts: rec.ts, ...rest, prev: rec.prev }));
      if (recomputed !== a.hash) return { ok: false, divergentAt: seq, reason: 'hash diverges from cloud anchor' };
    }
    return { ok: true, divergentAt: null, checkedAnchors: (anchors || []).length };
  } catch (err) {
    return { ok: false, divergentAt: null, reason: err.message };
  }
}
