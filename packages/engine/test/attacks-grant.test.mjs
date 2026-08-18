// Capability-grant attack suite — one case per verification stage (nine),
// plus the flag cases from the analysis: valid signature + foreign device
// fingerprint, valid grant + `security: "locked"`, and traversal paths.
// Every case is a deliberate single-stage bypass; each must fail closed.

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
  grantSigningInput,
} from '../src/index.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const CEILING = mkdtempSync(join(tmpdir(), 'mona-cap-att-'));
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
    policy: new Policy({ capabilities: fullCaps() }),
    deviceFingerprint: FP,
    tenantId: TENANT,
    runId: RUN,
    seen: new Map(),
    now: Date.now(),
    ...overrides,
  };
}

// Baseline: the untouched grant is accepted — every attack row below flips
// exactly one stage away from this.
test('baseline: the valid grant verifies (each attack row breaks one stage)', () => {
  const v = verifyCapabilityGrant(makeGrant(), ctx());
  assert.equal(v.ok, true);
  assert.deepEqual(v.effective.shell.allow, ['docker'], 'ceiling intersection wins');
});

describe('attacks/grant — the nine verification stages, one bypass each', () => {
  test('stage 1: not a v1 grant object', () => {
    const v = verifyCapabilityGrant(null, ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /invalid grant/);
  });

  test('stage 1b: remote extension disabled in policy', () => {
    const v = verifyCapabilityGrant(makeGrant(), ctx({ policy: new Policy({ capabilities: { allowRemoteExtension: false } }) }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /remote capability extension disabled/);
  });

  test('stage 2: missing signature', () => {
    const g = makeGrant();
    delete g.sig;
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /missing signature/);
  });

  test('stage 2b: payload tampered after signing', () => {
    const g = makeGrant();
    g.grant = { shell: { allow: ['bash'] }, paths: { allow: [join(CEILING, 'foo')] }, tools: ['shell'] };
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /invalid signature/);
  });

  test('stage 2c: signature from a foreign key', () => {
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    const g = makeGrant();
    const payload = { ...g };
    delete payload.sig;
    g.sig = cryptoSign(null, Buffer.from(grantSigningInput(payload)), otherKey).toString('base64url');
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /invalid signature/);
  });

  test('stage 3: VALID signature but foreign deviceFingerprint', () => {
    const v = verifyCapabilityGrant(makeGrant(), ctx({ deviceFingerprint: 'fp-someone-else' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /device fingerprint mismatch/);
  });

  test('stage 4: tenant mismatch', () => {
    const v = verifyCapabilityGrant(makeGrant(), ctx({ tenantId: 'tenant-other' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /tenant mismatch/);
  });

  test('stage 5: run mismatch', () => {
    const v = verifyCapabilityGrant(makeGrant(), ctx({ runId: 'run_other' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /run mismatch/);
  });

  test('stage 6: expired grant', () => {
    const v = verifyCapabilityGrant(makeGrant({ expiresAt: new Date(Date.now() - 1).toISOString() }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /expired/);
  });

  test('stage 6b: TTL exceeds maxTtlSec', () => {
    const v = verifyCapabilityGrant(makeGrant({ expiresAt: new Date(Date.now() + 901_000).toISOString() }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /ttl exceeds maxTtlSec/);
  });

  test('stage 6c: issued too far in the future', () => {
    const v = verifyCapabilityGrant(makeGrant({ issuedAt: new Date(Date.now() + 600_000).toISOString() }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /future/);
  });

  test('stage 7: mfa method not permitted', () => {
    const v = verifyCapabilityGrant(makeGrant({ mfa: { method: 'sms', verifiedAt: new Date().toISOString() } }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /mfa method not permitted/);
  });

  test('stage 7b: missing mfa verification time', () => {
    const v = verifyCapabilityGrant(makeGrant({ mfa: { method: 'totp' } }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /missing mfa verification time/);
  });

  test('stage 7c: mfa verification too old', () => {
    const v = verifyCapabilityGrant(makeGrant({ mfa: { method: 'totp', verifiedAt: new Date(Date.now() - 901_000).toISOString() } }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /mfa verification too old/);
  });

  test('stage 8: missing nonce', () => {
    const v = verifyCapabilityGrant(makeGrant({ nonce: '' }), ctx());
    assert.equal(v.ok, false);
    assert.match(v.reason, /missing nonce/);
  });

  test('stage 8b: nonce replay within the window', () => {
    const g = makeGrant();
    const c = ctx();
    assert.equal(verifyCapabilityGrant(g, c).ok, true);
    const second = verifyCapabilityGrant(g, c);
    assert.equal(second.ok, false);
    assert.match(second.reason, /replayed/);
  });

  test('stage 9: ceiling intersection wins over the grant', () => {
    const g = makeGrant({
      grant: {
        shell: { allow: ['docker', 'bash'] },
        paths: { allow: [join(CEILING, 'foo'), join(tmpdir(), 'outside')] },
        tools: ['shell', 'files'],
      },
    });
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, true);
    assert.deepEqual(v.effective.shell.allow, ['docker'], 'bash dropped — not in owner ceiling');
    assert.deepEqual(v.effective.paths.allow, [join(CANON, 'foo')], 'outside path dropped');
  });

  test('stage 9b: traversal paths are rejected outright', () => {
    const g = makeGrant({ grant: { shell: { allow: ['docker'] }, paths: { allow: [join(CEILING, 'Projects', '..', '..')] }, tools: ['shell'] } });
    const v = verifyCapabilityGrant(g, ctx());
    assert.equal(v.ok, true, 'signature is valid');
    assert.deepEqual(v.effective.paths.allow, [], 'traversal path contributes nothing');
  });
});

describe('attacks/grant — resolveCapabilityGrant', () => {
  test('security: "locked" short-circuits a VALID grant', () => {
    const r = resolveCapabilityGrant(
      { security: 'locked', grant: makeGrant() },
      ctx()
    );
    assert.equal(r.locked, true);
    assert.deepEqual(r.effective, { shell: { allow: [] }, paths: { allow: [] }, tools: null });
    assert.equal(r.verdict.ok, false);
    assert.equal(r.verdict.reason, 'locked');
  });

  test('absent grant leaves effective capabilities empty', () => {
    const r = resolveCapabilityGrant({ security: 'open', grant: null }, ctx());
    assert.equal(r.locked, false);
    assert.deepEqual(r.effective.shell.allow, []);
    assert.equal(r.verdict, null);
  });

  test('invalid grant in an open profile leaves effective capabilities empty', () => {
    const bad = makeGrant();
    delete bad.sig;
    const r = resolveCapabilityGrant({ security: 'open', grant: bad }, ctx());
    assert.equal(r.locked, false);
    assert.deepEqual(r.effective.shell.allow, []);
    assert.equal(r.verdict.ok, false);
  });
});
