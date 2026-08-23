// Capability-grant verification — the device side of remote capability
// extension. A signed grant issued by the control plane (Sngine) after a fresh
// 2FA step-up can only ever intersect the owner's local ceiling; the
// intersection wins, never the union.
//
//   effective = base allowlist  ∪  ( grant  ∩  owner ceiling )
//
// Every verification step is fail-closed and the order is part of the
// contract. A grant is bound to one device, one tenant, one run, a short TTL,
// a fresh MFA, and a one-time nonce. Reused across domains with a distinct
// context string so an enrollment signature can never be replayed as a grant.
//
// The signing side lives in the control plane (out of this repo); this module
// only verifies. `canonical()` is shared with device-registry.js so the signer
// and the verifier stay byte-identical for the same payload.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep, dirname, basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { canonical } from './device-registry.js';

/** Domain-separation context — never reuse this string for any other purpose. */
export const GRANT_DOMAIN = 'mona-capability-grant-v1';

const GRANT_MAX_ENTRIES = 2048;

export function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

/** The exact bytes an Ed25519 signature covers (domain || canonical payload). */
export function grantSigningInput(payload) {
  return GRANT_DOMAIN + '\n' + canonical(payload);
}

/** The grant object minus the detached signature field. */
function payloadOf(grant) {
  const { sig: _sig, ...payload } = (grant && typeof grant === 'object') ? grant : {};
  return payload;
}

function grantHashOf(grant) {
  try { return sha256(canonical(payloadOf(grant))); } catch { return null; }
}

function base64urlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hasTraversal(p) {
  return String(p).split(/[\\/]+/).includes('..');
}

/**
 * Resolve a root: realpath where the path exists, else resolve the nearest
 * existing ancestor's symlinks and re-append the non-existing tail. This keeps
 * the ceiling root and a grant path under it on the same canonical base even
 * when the platform uses symlinked prefixes (e.g. macOS /var → /private/var),
 * while a symlinked grant path still resolves to its real (and refused) target.
 */
function resolveRoot(p) {
  const s = String(p);
  const expanded = s.startsWith('~/') ? join(homedir(), s.slice(2)) : s;
  const resolved = resolve(expanded);
  try {
    return realpathSync(resolved);
  } catch {
    let cur = resolved;
    const tail = [];
    for (;;) {
      try {
        const real = realpathSync(cur);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return resolved;
        tail.push(basename(cur));
        cur = parent;
      }
    }
  }
}

/**
 * Intersect a grant with the owner ceiling. A grant path counts only when it
 * lies UNDER a ceiling root (never when it contains one); grant paths carrying
 * `..` segments are rejected outright.
 */
export function intersectCapabilities(grant, ceiling) {
  const shellAllow = (grant?.shell?.allow || [])
    .map(String)
    .filter((c) => (ceiling?.shell?.allow || []).includes(c));

  const ceilingRoots = (ceiling?.paths?.allow || []).map(resolveRoot);
  const paths = (grant?.paths?.allow || [])
    .filter((p) => !hasTraversal(p))
    .map(resolveRoot)
    .filter((p) => ceilingRoots.some((r) => p === r || p.startsWith(r + sep)));

  const tools = (grant?.tools || [])
    .filter((t) => (ceiling?.tools || []).includes(t));

  return { shell: { allow: shellAllow }, paths: { allow: paths }, tools };
}

/**
 * Verify a signed capability grant. Returns { ok, reason?, grantHash, grant,
 * effective, mfa }. `seen` is a caller-owned Map used for nonce replay
 * protection (same Map-with-TTL structure as validateCommandFrame).
 */
export function verifyCapabilityGrant(grant, {
  policy = null,
  deviceFingerprint = '',
  tenantId = '',
  runId = '',
  seen = null,
  now = Date.now(),
} = {}) {
  const reject = (reason) => ({ ok: false, reason, grantHash: grantHashOf(grant), grant, effective: null, mfa: grant?.mfa || null });

  if (!grant || typeof grant !== 'object' || grant.v !== 1) {
    return reject('invalid grant');
  }

  const caps = policy?.capabilities || { allowRemoteExtension: false };
  if (caps.allowRemoteExtension !== true) {
    return reject('remote capability extension disabled');
  }

  // 2) Ed25519 signature against the pinned grant public key(s).
  if (typeof grant.sig !== 'string' || !grant.sig) return reject('missing signature');
  const payload = payloadOf(grant);
  const input = grantSigningInput(payload);
  const sig = base64urlToBuffer(grant.sig);
  let verified = false;
  for (const pem of (caps.grantPublicKey || [])) {
    try {
      if (cryptoVerify(null, Buffer.from(input), createPublicKey(pem), sig)) { verified = true; break; }
    } catch { /* try the next key (rotation window) */ }
  }
  if (!verified) return reject('invalid signature');

  // 3) Binding to this device.
  if (String(grant.deviceFingerprint || '') !== String(deviceFingerprint || '')) {
    return reject('device fingerprint mismatch');
  }

  // 4) Binding to the registered tenant.
  if (String(grant.tenantId || '') !== String(tenantId || '')) {
    return reject('tenant mismatch');
  }

  // 5) Binding to exactly one run.
  if (String(grant.runId || '') !== String(runId || '')) {
    return reject('run mismatch');
  }

  // 6) Time window.
  const maxTtlSec = Number(caps.maxTtlSec) > 0 ? Number(caps.maxTtlSec) : 900;
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return reject('invalid timestamps');
  if (expiresAt <= now) return reject('expired');
  if ((expiresAt - issuedAt) / 1000 > maxTtlSec) return reject('grant ttl exceeds maxTtlSec');
  if (issuedAt > now + 120_000) return reject('grant issued too far in the future');

  // 7) Fresh 2FA.
  const method = String(grant.mfa?.method || '');
  const requireMfa = caps.requireMfa || [];
  if (requireMfa.length && !requireMfa.includes(method)) return reject('mfa method not permitted');
  const verifiedAt = Date.parse(grant.mfa?.verifiedAt || '');
  if (!Number.isFinite(verifiedAt)) return reject('missing mfa verification time');
  if (now - verifiedAt > maxTtlSec * 1000) return reject('mfa verification too old');

  // 8) Nonce replay protection.
  const nonce = String(grant.nonce || '');
  if (!nonce) return reject('missing nonce');
  if (seen instanceof Map) {
    const previous = seen.get(nonce);
    if (previous !== undefined && previous > now - maxTtlSec * 1000) return reject('replayed');
    seen.set(nonce, now);
    for (const [entry, timestamp] of seen) {
      if (timestamp <= now - maxTtlSec * 1000) seen.delete(entry);
    }
    while (seen.size > GRANT_MAX_ENTRIES) seen.delete(seen.keys().next().value);
  }

  // 9) Intersect with the owner ceiling.
  const effective = intersectCapabilities(grant.grant, caps.ceiling || {});

  return { ok: true, grantHash: grantHashOf(grant), grant, effective, mfa: grant.mfa || null };
}

/**
 * Resolve the effective capabilities for a task from the agent capability
 * profile sent by the control plane. `security: "locked"` short-circuits any
 * grant; absent a grant the effective capabilities stay empty. Returns the
 * verdict so the caller can audit it exactly once.
 */
export function resolveCapabilityGrant(agentCaps, {
  policy = null,
  deviceFingerprint = '',
  tenantId = '',
  runId = '',
  seen = null,
  now = Date.now(),
} = {}) {
  const empty = () => ({ shell: { allow: [] }, paths: { allow: [] }, tools: null });
  const locked = agentCaps?.security === 'locked';
  if (locked) {
    return {
      locked: true,
      effective: empty(),
      verdict: { ok: false, reason: 'locked', grantHash: null, grant: null, effective: null, mfa: null },
    };
  }
  if (!agentCaps?.grant) {
    return { locked: false, effective: empty(), verdict: null };
  }
  const v = verifyCapabilityGrant(agentCaps.grant, { policy, deviceFingerprint, tenantId, runId, seen, now });
  return { locked: false, effective: v.ok ? v.effective : empty(), verdict: v };
}
