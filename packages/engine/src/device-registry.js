// Device & identity lifecycle registry.
//
// DeviceRegistry owns enrollment, credential rotation, revocation, inventory,
// and health for the device fleet. It persists only owned JSON data through
// atomic 0600 writes, stores credential *hashes* (never the secret), enforces
// tenant scoping on every query, and writes each enrollment/rotation/revocation
// to the shared hash-chained audit log.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { auditWrite } from './policy.js';

const DEFAULT_STORE = process.env.MONA_DEVICES_STORE || join(homedir(), '.mona-agent', 'devices.json');
const MAX_DEVICES = 10000;

export const DEVICE_HEALTH = Object.freeze(['online', 'degraded', 'offline']);

function nowIso() { return new Date().toISOString(); }
function deviceId() { return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

/** One-way hash of a credential so the registry never stores the secret. */
export function hashCredential(secret) {
  return createHash('sha256').update(String(secret ?? '')).digest('hex');
}

export function normaliseDevice(raw = {}) {
  return {
    id: String(raw.id || deviceId()),
    tenantId: String(raw.tenantId || ''),
    hostname: String(raw.hostname || ''),
    os: String(raw.os || ''),
    version: String(raw.version || ''),
    arch: String(raw.arch || ''),
    credentialHash: String(raw.credentialHash || ''),
    credentialExpiresAt: raw.credentialExpiresAt || '',
    health: DEVICE_HEALTH.includes(raw.health) ? raw.health : 'online',
    lastSeen: raw.lastSeen || nowIso(),
    group: String(raw.group || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 50) : [],
    policyRevision: String(raw.policyRevision || ''),
    outstandingRuns: Number.isInteger(raw.outstandingRuns) ? raw.outstandingRuns : 0,
    enrolledAt: raw.enrolledAt || nowIso(),
    revoked: Boolean(raw.revoked),
    revokedAt: raw.revokedAt || null,
    revokeReason: String(raw.revokeReason || ''),
  };
}

export class DeviceRegistry {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    this.storePath = storePath;
    this.devices = new Map();
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.devices) ? raw.devices : [])) {
        const d = normaliseDevice(item);
        this.devices.set(d.id, d);
      }
    } catch { /* corrupt store fails closed to empty */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const devices = [...this.devices.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))).slice(0, MAX_DEVICES);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, devices }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  /** Enroll a device. The credential is hashed; the secret is never stored. */
  enroll({ id, tenantId, hostname = '', os = '', version = '', arch = '', credential = '', credentialExpiresAt = '', tags = [], group = '', policyRevision = '' } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required');
    if (!credential) throw new TypeError('credential is required');
    const device = normaliseDevice({
      id, tenantId, hostname, os, version, arch, tags, group, policyRevision,
      credentialHash: hashCredential(credential), credentialExpiresAt,
    });
    if (this.devices.has(device.id)) return this.get(device.id);
    this.devices.set(device.id, device);
    this.#save();
    auditWrite({ kind: 'device', action: 'enroll', deviceId: device.id, tenantId, hostname, os });
    return this.get(device.id);
  }

  /** Read a device. When `tenantId` is supplied, cross-tenant reads return null. */
  get(id, { tenantId } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (tenantId !== undefined && d.tenantId !== tenantId) return null;
    return normaliseDevice(d);
  }

  /** Inventory, strictly tenant-scoped. `tenantId` is required (no implicit global view). */
  list({ tenantId, health, group, tag } = {}) {
    if (!tenantId) throw new TypeError('tenantId is required to list devices');
    return [...this.devices.values()]
      .filter((d) => d.tenantId === tenantId)
      .filter((d) => health === undefined || d.health === health)
      .filter((d) => group === undefined || d.group === group)
      .filter((d) => tag === undefined || d.tags.includes(tag))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .map((d) => normaliseDevice(d));
  }

  /** Record a heartbeat and current health. */
  heartbeat(id, { health = 'online', outstandingRuns = 0, policyRevision = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (!DEVICE_HEALTH.includes(health)) throw new TypeError(`invalid health: ${health}`);
    d.health = health;
    d.lastSeen = nowIso();
    d.outstandingRuns = Number.isInteger(outstandingRuns) ? outstandingRuns : 0;
    if (policyRevision) d.policyRevision = policyRevision;
    this.#save();
    return this.get(id);
  }

  /** Verify a presented credential against the stored hash and expiry window. */
  verifyCredential(id, credential, now = Date.now()) {
    const d = this.devices.get(String(id));
    if (!d || d.revoked) return { ok: false, reason: 'unknown or revoked device' };
    if (hashCredential(credential) !== d.credentialHash) return { ok: false, reason: 'credential mismatch' };
    if (d.credentialExpiresAt && Date.parse(d.credentialExpiresAt) <= now) return { ok: false, reason: 'credential expired' };
    return { ok: true };
  }

  /** Rotate a credential atomically: the new hash is stored before the old expires. */
  rotateCredential(id, { credential = '', credentialExpiresAt = '', auditor = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    if (!credential) throw new TypeError('credential is required');
    d.credentialHash = hashCredential(credential);
    d.credentialExpiresAt = credentialExpiresAt;
    this.#save();
    auditWrite({ kind: 'device', action: 'rotate', deviceId: d.id, tenantId: d.tenantId, auditor });
    return this.get(id);
  }

  /** Revoke a device immediately. A revoked device can never verify again. */
  revoke(id, { reason = '', auditor = '' } = {}) {
    const d = this.devices.get(String(id));
    if (!d) return null;
    d.revoked = true;
    d.revokedAt = nowIso();
    d.revokeReason = reason;
    this.#save();
    auditWrite({ kind: 'device', action: 'revoke', deviceId: d.id, tenantId: d.tenantId, reason, auditor });
    return this.get(id);
  }

  /** Force-revoke every device in a tenant (compromise response). */
  revokeTenant(tenantId, { reason = 'tenant compromised', auditor = '' } = {}) {
    const ids = [...this.devices.values()].filter((d) => d.tenantId === tenantId && !d.revoked).map((d) => d.id);
    for (const id of ids) this.revoke(id, { reason, auditor });
    return ids;
  }

  /** A device is eligible for autonomous remediation only when online, unrevoked, and with an unexpired credential. */
  eligibleForRemediation(id, now = Date.now()) {
    const d = this.devices.get(String(id));
    if (!d || d.revoked) return false;
    if (d.health !== 'online') return false;
    if (d.credentialExpiresAt && Date.parse(d.credentialExpiresAt) <= now) return false;
    return true;
  }
}
