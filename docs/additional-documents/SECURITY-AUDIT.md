# Security Self-Audit Guide

A practical checklist for teams adopting mona-agent. Each item states what to
verify and where the evidence lives.

## 1. Device provisioning

- [ ] Device token generated from the dashboard (Settings → Mona key), never
      hardcoded, never committed to version control.
- [ ] `mona-agent login` performed on the device; credentials file readable
      only by the owning user (`chmod 600`).
- [ ] Device inventory matches reality: one token per device, labels in use.

## 2. Network posture

- [ ] No inbound ports required or opened for the daemon.
- [ ] Egress limited to `https://agent.mona.expert` (and the LLM providers,
      which the *cloud* calls — the device never talks to providers).
- [ ] Corporate proxy/MITM inspection excluded for the cloud endpoint
      (certificate verification is enforced).

## 3. Secrets & keys

- [ ] Provider keys stored only via the dashboard (encrypted AES-256-GCM).
- [ ] Keys rotated on personnel change; last-used timestamps reviewed
      periodically.
- [ ] Device tokens revoked immediately on device loss (single-click).

## 4. Tool policy

- [ ] Shell allowlist reviewed (blocked commands stay blocked).
- [ ] For high-stakes devices: tools reduced to the minimum set; irreversible
      actions require human confirmation in the dashboard.

## 5. Monitoring & incident response

- [ ] Live log reviewed (Logs tab) or exported for SIEM ingestion.
- [ ] Retention period defined for audit data.
- [ ] Incident reconstruction drill: open a run trace and confirm the full
      chain (reasoning → tool call → result → answer → verification) is
      readable end-to-end.

## 6. Updates

- [ ] Release tags pinned; changelog reviewed before rollout.
- [ ] Staging device tests a new version before fleet rollout.

## Evidence matrix

| Control | Evidence |
|---|---|
| Authentication | Settings → Devices: token list with last-used |
| Authorization | Rate-limit events in the live log; plan limits in Settings → Plan |
| Integrity | Git tags; test suite in CI; dependency list (see `SBOM.md`) |
| Confidentiality | Key storage is encrypted server-side; devices hold no provider keys |
| Auditability | History tab, run traces, JSONL training export, live event stream |
