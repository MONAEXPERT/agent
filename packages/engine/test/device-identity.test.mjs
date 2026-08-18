import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceIdentity, signEnrollment, verifyEnrollment, DeviceRegistry, generateCredential } from '../src/index.mjs';
import os from 'node:os';
import path from 'node:path';

describe('Ed25519 device identity', () => {
  it('generates and verifies signed enrollment', () => {
    const identity = generateDeviceIdentity();
    const payload = { deviceId: 'd1', tenantId: 't1', nonce: 'n', ts: 1 };
    const signature = signEnrollment(payload, identity.privateKey);
    assert.equal(verifyEnrollment(payload, signature, identity.publicKey), true);
    assert.equal(verifyEnrollment({ ...payload, tenantId: 'other' }, signature, identity.publicKey), false);
  });

  it('requires a valid signature for public-key enrollment', () => {
    const identity = generateDeviceIdentity();
    const payload = { deviceId: 'd1', tenantId: 't1', nonce: 'n', ts: 1 };
    const r = new DeviceRegistry({ storePath: path.join(os.tmpdir(), `identity-${Date.now()}.json`) });
    assert.throws(() => r.enroll({ tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: 'bad' }), /signature/);
    const signature = signEnrollment(payload, identity.privateKey);
    const d = r.enroll({ tenantId: 't1', publicKey: identity.publicKey, enrollmentPayload: payload, enrollmentSignature: signature, credential: generateCredential() });
    assert.equal(d.identityAlgorithm, 'Ed25519');
    assert.equal(d.deviceFingerprint, identity.deviceFingerprint);
  });
});
