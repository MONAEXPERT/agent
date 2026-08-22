# Device & Identity Lifecycle

Covers enrollment, revocation, inventory, health, and tenant isolation (backlog P2.1), and the Windows/Linux operational matrix (backlog P1.3). This is the design contract; implementation tracks against the completion signals below.

## Enrollment
1. A device generates an Ed25519 key pair locally (the private key must be protected by the platform keystore where available) and presents its public key with a one-time nonce/enrollment payload.
2. The payload is signed with the private key. The registry verifies the signature before accepting enrollment and stores only the public key and its SHA-256 fingerprint.
3. A device may continue to use the legacy opaque credential enrollment path for compatibility, but new integrations should use signed enrollment.
4. A device presents a one-time enrollment code + a hardware-bound identity (TPM/Keychain/DPAPI-backed key pair).
2. The control plane issues a short-lived device credential bound to that key; the device never stores a long-lived bearer token.
3. Enrollment records the device's OS, version, arch, and hostname, and assigns a tenant + initial group.

**Done when:** an automated test enrolls a device, rotates its credential, and revokes it end-to-end.

## Inventory & health
1. Devices report a compact heartbeat: last-seen, agent version, policy revision, disk/CPU/memory pressure, and outstanding run count.
2. Inventory is queryable by tenant, group, tag, OS, and health state.
3. Health is a first-class signal for run admission: a device in `degraded` or `offline` state is not eligible for autonomous remediation.

**Done when:** a heartbeat is retained, the inventory query returns it, and a degraded device is excluded from automated remediation.

## Revocation & rotation
1. Revocation is immediate and propagates through the JIT/credential layer (a revoked device credential cannot authorize any subsequent run).
2. Credentials rotate on a bounded interval; rotation is non-disruptive and atomic (the new credential becomes valid before the old expires).
3. A compromised-device path force-revokes every active JIT grant for that device in one operation.

**Done when:** enrollment-to-revocation and cross-tenant isolation are covered by automated tests.

## Tenant isolation & RBAC
1. Every run, device, and grant carries a `tenantId`; a query scoped to one tenant never returns another tenant's data.
2. RBAC is enforced at two layers: device policy (what a device may do) and control-plane roles (who may enroll, grant, or revoke).
3. JIT access (see `packages/engine/src/jit.js`) is the only mechanism for temporary elevation, and it is always audited.

**Done when:** a cross-tenant query returns nothing outside its tenant, and a role without grant permission is refused.

## Windows lifecycle (backlog P1.3)
- Signed installer/update artifacts (Authenticode), OS-backed credential storage (DPAPI/Credential Manager), Event Log integration, least-privilege service account, and install/upgrade/rollback/uninstall acceptance tests.
- Supported matrix: each declared Windows/Windows Server target with lifecycle dates.

## Linux lifecycle (backlog P1.3)
- Native package signing (RPM/DEB), install/upgrade/rollback workflows, and a known-good previous-version rollback path.

**Done when:** every declared Windows and Linux target passes its lifecycle and security acceptance tests.

---

## Capability grants

This document is the device↔control-plane contract for **remote capability
extension**. It defines how a signed capability grant is produced (server
side, in Sngine), what it contains, and how the device verifies and applies it.

The device-side implementation lives in `packages/engine/src/capability-grant.js`
and is wired into the daemon in `apps/desktop/src/agent.js`.

## Model

The device owner controls an **owner ceiling** in `policy.json` (editable only
on the device). The control plane may *request* additional capabilities, but a
grant only ever takes effect where it **intersects** the ceiling:

```
effective = base allowlist  ∪  ( grant  ∩  owner ceiling )
```

The intersection wins, never the union. If the `capabilities` block is absent
from `policy.json`, remote extension is **off** — deny by default. There is no
environment-variable fallback and no default `true`.

## Owner ceiling (policy.json)

```jsonc
{
  "capabilities": {
    "allowRemoteExtension": true,
    "grantPublicKey": "-----BEGIN PUBLIC KEY-----\n…",   // or an array for rotation
    "maxTtlSec": 900,
    "requireMfa": ["totp", "webauthn"],                // empty = any method
    "ceiling": {
      "shell": { "allow": ["git", "npm", "docker"] },
      "paths": { "allow": ["~/Projects", "~/Documents"] },
      "tools": ["sysinfo", "files", "shell", "net", "web", "memory", "vector"]
    }
  }
}
```

## Grant production (Sngine side)

- The grant is produced **server-side, after** a successful 2FA step-up of the
  account owner. The signing key lives only in the control plane; it is **never
  present in the browser/frontend**.
- A step-up authorizes **one grant**, not a session. The frame is "extended
  rights for the next N minutes for this one task", never "until logout".
- Before the owner confirms the 2FA challenge, the UI shows **in plaintext**
  exactly what is being granted — each command and each path, individually —
  never a generic "extended rights" label.

### Grant payload

```jsonc
{
  "v": 1,
  "tenantId": "…",
  "deviceFingerprint": "sha256-hex",   // binds to one device
  "runId": "run_…",                    // binds to exactly one task
  "grant": {
    "shell": { "allow": ["docker"] },
    "paths": { "allow": ["~/Projects/foo"] },
    "tools": ["shell", "files"]
  },
  "mfa": { "method": "totp", "verifiedAt": "2026-08-18T09:12:03Z", "sessionId": "…" },
  "issuedAt": "2026-08-18T09:12:05Z",
  "expiresAt": "2026-08-18T09:27:05Z",
  "nonce": "base64url-16-bytes",
  "sig": "base64url-ed25519-signature"
}
```

### Signature (domain-separated)

The signature is Ed25519 over the canonical, deterministic serialization of the
payload (all fields except `sig`), prefixed with the context string
`remoteagent-capability-grant-v1`:

```
signing_input = "remoteagent-capability-grant-v1\n" + canonical(payload)
sig           = ed25519_sign(privateKey, signing_input)  // base64url
```

`canonical()` sorts object keys recursively and serializes with no whitespace,
so the signer and verifier always agree on the exact bytes. The distinct
context string means an enrollment signature can never be replayed as a
capability grant, and vice versa.

### Device fingerprint

The fingerprint binds a grant to one device. Until a device keypair/enrollment
exists, the fingerprint is derived deterministically from the agent's
registration id:

```
deviceFingerprint = sha256("remoteagent-device:" + agentId)
```

The control plane computes the same value from the agent id it already holds.
When a device keypair/enrollment lands, `grantPublicKey`/fingerprint derivation
should be superseded by that key — without changing the rest of this contract.

## Device-side verification

Order is part of the contract and every stage is fail-closed:

1. `allowRemoteExtension === true`, else discard immediately.
2. Ed25519 signature against `grantPublicKey` (any key in the array). Failure
   rejects — the task then runs with base rights only and the grant is audited
   as `rejected`.
3. `deviceFingerprint` matches this device.
4. `tenantId` matches the registered tenant.
5. `runId` matches the run that is starting.
6. `expiresAt` in the future, `expiresAt − issuedAt ≤ maxTtlSec`, `issuedAt`
   not more than 120 s in the future (clock skew).
7. `mfa.method` ∈ `requireMfa` (empty = any), `mfa.verifiedAt` no older than
   `maxTtlSec`.
8. `nonce` not seen before — a Map-with-TTL replay cache.
9. Intersect `grant` with the ceiling.

`security: "locked"` on the task short-circuits the whole path: no grant is
verified or applied, and the run is forced to the most restrictive posture.

## Key rotation

`capabilities.grantPublicKey` may be an array. The verifier accepts a signature
under **any** key in the array, so a key rollover can be done without downtime:

1. Publish the new public key as a second array entry and dual-sign grants
   during the transition.
2. Stop signing with the old key.
3. Remove the old key from `policy.json`.

## Audit

Every grant decision is written to the local hash-chained audit log with
`kind: "capability-grant"`, the run id, verdict (`accepted`/`rejected`), reason,
a `grantHash` (sha256 of the canonical grant), the MFA method, and the
effective capabilities that survived the ceiling intersection.

Every entry is additionally **Ed25519-signed** with the device audit key
(domain `remoteagent-audit-v1`, key file `audit-key.json` next to the log, 0600,
generated on first use). `remoteagent audit verify` checks the hash chain
**and** every signature; a chain recomputed under a foreign key fails at its
first entry.

### Audit anchoring — control-plane contract

The device anchors its chain head at the control plane every **50 entries or
5 minutes** (whichever comes first), so the device cannot rewrite its own
history without diverging from the stored anchors.

`POST /api/v1/agent/audit-anchor` (device bearer token; Sngine router
`remoteagent-plugin/api/agent.php`) — request body:

```json
{
  "seq": 412,
  "hash": "sha256 of the signed entry",
  "signedAt": "2026-08-18T12:00:00.000Z",
  "sig": "base64url Ed25519 over remoteagent-audit-v1.<hash>",
  "pub": "device audit public key (SPKI PEM)"
}
```

Server requirements (append-only, tenant-scoped):

- Auth: device bearer token only; the anchor is stored under that device's
  tenant. Never account-admin-only, never unauthenticated.
- Store: append-only rows `{seq, hash, signedAt, sig, pub}` — no update/delete
  path, no overwrite of an existing seq.
- Response: `200 {"ok": true}`.
- `GET` the same path returns `{"anchors": [...]}` (newest last) for the
  device's own tenant; `remoteagent audit verify --against-cloud` compares the
  local chain entry at each anchored seq and reports the first divergence
  with its seq.

Rate limiting: at most one POST per device per minute (the client already
throttles to the 50-entries/5-minutes cadence).

