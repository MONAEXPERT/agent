// Capability-grant verification — signed remote extension, fail-closed.
// The device only ever applies the intersection of a signed grant with the
// owner's local ceiling; every stage below rejects (never falls back) on
// failure.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Policy,
  verifyCapabilityGrant,
  resolveCapabilityGrant,
  intersectCapabilities,
  grantSigningInput,
  
} from '../src/index.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const CEILING = mkdtempSync(join(tmpdir(), 'remoteagent-cap-'));
// Canonical base — resolveRoot realpaths the existing ceiling (macOS /var →
// /private/var), so expected contained paths must match that canonical form.
const CANON = realpathSync(CEILING);

const FP = 'fp-device-1';
const TENANT = 'tenant-1';
const RUN = 'run_1';

function signPayload(payload) {
  return cryptoSign(null, Buffer.from(grantSigningInput(payload)), privateKey).toString('base64url');
}

function makeGrant(overrides = {}) {
  const now = Date.now();
  const payload = {
    v: 1,
    tenantId: TENANT,
    deviceFingerprint: FP,
    runId: RUN,
    grant: {
      shell: { allow: ['docker'] },
      paths: { allow: [join(CEILING, 'foo')] },
      tools: ['shell', 'files'],
    },
    mfa: { method: 'totp', verifiedAt: new Date(now).toISOString(), sessionId: 's1' },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    nonce: 'nonce-1',
    ...overrides,
  };
  return { ...payload, sig: signPayload(payload) };
}

function policy(caps) {
  return new Policy({ capabilities: caps });
}

function fullCaps(overrides = {}) {
  return {
    allowRemoteExtension: true,
    grantPublicKey: PUB_PEM,
    maxTtlSec: 900,
    requireMfa: ['totp', 'webauthn'],
    ceiling: {
      shell: { allow: ['docker', 'git'] },
      paths: { allow: [CEILING] },
      tools: ['shell', 'files'],
    },
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    policy: policy(fullCaps()),
    deviceFingerprint: FP,
    tenantId: TENANT,
    runId: RUN,
    seen: new Map(),
    now: Date.now(),
    ...overrides,
  };
}

describe('capability-grant verification', () => {
  test('accepts a valid grant and returns the ceiling intersection', () => {
    const c = ctx();
    const v = verifyCapabilityGrant(makeGrant(), c);
    assert.equal(v.ok, true, v.reason);
    assert.deepEqual(v.effective.shell.allow, ['docker']);
    assert.deepEqual(v.effective.paths.allow, [join(CANON, 'foo')]);
    assert.deepEqual(v.effective.tools, ['shell', 'files']);
    assert.ok(v.grantHash);
  });

  test('rejects a tampered payload (invalid signature)', () => {
    const g = makeGrant();
    g.grant.shell.allow = ['bash'];
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'invalid signature');
  });

  test('rejects a grant for a foreign device fingerprint', () => {
    const v = verifyCapabilityGrant(makeGrant({ deviceFingerprint: 'fp-other' }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'device fingerprint mismatch');
  });

  test('rejects a grant for a foreign tenant', () => {
    const v = verifyCapabilityGrant(makeGrant({ tenantId: 'tenant-other' }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'tenant mismatch');
  });

  test('rejects a grant bound to another run', () => {
    const v = verifyCapabilityGrant(makeGrant({ runId: 'run_other' }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'run mismatch');
  });

  test('rejects an expired grant', () => {
    const now = Date.now();
    const v = verifyCapabilityGrant(makeGrant({ expiresAt: new Date(now - 1000).toISOString() }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'expired');
  });

  test('rejects a grant whose TTL exceeds maxTtlSec', () => {
    const now = Date.now();
    const v = verifyCapabilityGrant(
      makeGrant({ issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 1000_000).toISOString() }),
      ctx()
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'grant ttl exceeds maxTtlSec');
  });

  test('rejects a grant issued too far in the future', () => {
    const now = Date.now();
    const v = verifyCapabilityGrant(makeGrant({ issuedAt: new Date(now + 121_000).toISOString() }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'grant issued too far in the future');
  });

  test('rejects an MFA method outside requireMfa', () => {
    const v = verifyCapabilityGrant(makeGrant({ mfa: { method: 'sms', verifiedAt: new Date().toISOString() } }), ctx());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'mfa method not permitted');
  });

  test('rejects stale MFA verification', () => {
    const now = Date.now();
    const v = verifyCapabilityGrant(
      makeGrant({ mfa: { method: 'totp', verifiedAt: new Date(now - 1000_000).toISOString() } }),
      ctx()
    );
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'mfa verification too old');
  });

  test('rejects a replayed nonce', () => {
    const c = ctx();
    const g = makeGrant();
    assert.equal(verifyCapabilityGrant(g, c).ok, true);
    const v = verifyCapabilityGrant(g, c);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'replayed');
  });

  test('rejects when the policy has no capabilities block (deny by default)', () => {
    const bare = new Policy(null);
    const v = verifyCapabilityGrant(makeGrant(), { ...ctx(), policy: bare });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'remote capability extension disabled');
  });

  test('security: locked defeats any valid grant', () => {
    const r = resolveCapabilityGrant(
      { security: 'locked', grant: makeGrant() },
      ctx()
    );
    assert.equal(r.locked, true);
    assert.deepEqual(r.effective, { shell: { allow: [] }, paths: { allow: [] }, tools: null });
    assert.equal(r.verdict.ok, false);
    assert.equal(r.verdict.reason, 'locked');
  });
});

describe('intersectCapabilities', () => {
  test('intersects shell and tools, keeps only ceiling-contained paths', () => {
    const r = intersectCapabilities(
      { shell: { allow: ['docker', 'bash'] }, paths: { allow: [join(CEILING, 'foo'), '/etc'] }, tools: ['shell', 'net'] },
      { shell: { allow: ['docker'] }, paths: { allow: [CEILING] }, tools: ['shell', 'files'] }
    );
    assert.deepEqual(r.shell.allow, ['docker']);
    assert.deepEqual(r.paths.allow, [join(CANON, 'foo')]);
    assert.deepEqual(r.tools, ['shell']);
  });

  test('path "/" against ceiling does not match (contains, not contained)', () => {
    const r = intersectCapabilities(
      { paths: { allow: ['/'] } },
      { paths: { allow: [CEILING] } }
    );
    assert.deepEqual(r.paths.allow, []);
  });

  test('rejects grant paths carrying .. segments', () => {
    const r = intersectCapabilities(
      { paths: { allow: [join(CEILING, '..', '..', 'etc', 'passwd')] } },
      { paths: { allow: [CEILING] } }
    );
    assert.deepEqual(r.paths.allow, []);
  });
});
