# Handoff prompt for the next session

Copy everything below the line into the next agent session verbatim, then continue.

---

You are continuing the **enterprise-run-platform** workstream for the `mona-agent` repository. Treat the repository as the source of truth; do not trust any earlier narration.

## Repository & access
- Remote: `https://github.com/MONAEXPERT/agent`
- Branch: `enterprise-run-skel` (already pushed; local == remote == `42f0b97`)
- Local clone: `/Users/mona/Documents/deepharness/enterprise-run-platform`
- Auth: SSH key `~/.ssh/id_ed25519_github_monaexpert` (fingerprint `SHA256:jgWTvgWUi0Eb3t9pBsJvP0CbQfPKcXTIMjTopJL0Nn4`). `~/.ssh/config` already maps `github.com` to this key. Ensure `git remote` is `git@github.com:MONAEXPERT/agent.git`; if it is HTTPS, run `git remote set-url origin git@github.com:MONAEXPERT/agent.git`.
- Toolchain: Node `v24`, npm. Run `npm ci --ignore-scripts --no-audit --no-fund` first so the `@mona/engine` workspace symlink resolves.

## Verify current state first
```bash
cd /Users/mona/Documents/deepharness/enterprise-run-platform
git status -sb                # expect: clean, on enterprise-run-skel
git rev-parse HEAD            # expect 42f0b97...
npm test                      # expect 425 tests, 0 failures
```

## What is already done (do NOT rebuild)
All in `packages/engine/src/`, exported from `index.mjs`, tested in `packages/engine/test/` and registered in the root `package.json` `test` script:
- `run-state.js` — durable RunStore: recovery points, rollback, cancel, resume, bounded retries.
- `jit.js` — role-scoped JIT access, revocation, audit.
- `device-registry.js` — enrollment, revocation, rotation, health, tenant isolation.
- `metrics.js` — value metrics + thresholded alerts.
- `plugin-manifest.js` — Ed25519 signing/verification + deny-by-default capabilities.
- `upgrade.js` — health-gated staged rollout.
- `fleet.js` — FleetController composing the services.
- `evidence.js` — run reconstruction + audit export/query.
- `package-lifecycle.js` — install/upgrade/rollback state machine.
- Docs: `docs/GOALS.md`, `docs/IMPLEMENTATION-BACKLOG.md` (status section), `docs/RUNBOOKS.md` (network runbook + versioning + escalation), `docs/DEVICE-LIFECYCLE.md`, `docs/PLUGIN-SUPPLY-CHAIN.md`, `docs/SLA-DR-BC.md`.
- CI: `ci.yml` (test matrix + audit + CodeQL + gitleaks + reproducibility); `release.yml` (SBOM/SHA256/provenance).

## Conventions to keep
1. Persist owned JSON atomically (0600, write `.tmp` then `renameSync`).
2. Any mutation of trust state writes to the shared hash-chained audit log via `auditWrite` from `policy.js`.
3. Return owned JSON only — never live service state.
4. Every new module: export from `index.mjs`, add its test file to the root `package.json` `test` script, and run `node --test packages/engine/test/*.test.mjs` then `npm test` before committing.
5. Isolate audit-path tests with `process.env.MONA_AUDIT` set to a temp path before the dynamic import.

## Remaining work (in priority order)
1. **Open the PR**: `gh` CLI is not installed. Open https://github.com/MONAEXPERT/agent/pull/new/enterprise-run-skel and create the PR against `main`.
2. **Goal 3 — real signing + lifecycle acceptance**: Authenticode (Windows) and GPG/RPM/DEB (Linux) signing need real keys + CI secrets — scaffold the signing job in CI and the install/upgrade/rollback acceptance tests that are portable (state-machine level is already done via `package-lifecycle.js`; wire it to `install.sh`/`install.ps1`).
3. **Goal 8 — SIEM exporter**: a streaming NDJSON exporter over `readAuditEntries`/`queryAudit` + `computeRunMetrics`/`evaluateAlerts` (alerting engine is done).
4. **Goal 6 — admin console API**: JSON endpoints over `FleetController` (enroll/grant/upgrade/report) as the backend for the dashboard.
5. **Goal 7 — marketplace index**: a signed plugin index manifest built on `plugin-manifest.js` (marketplace expansion remains deferred in the backlog).

## Definition of done for this workstream
Every goal has an implemented + tested engine module OR a tracked design spec with a completion signal; `npm test` is green; everything is committed and pushed to `enterprise-run-skel`; a PR is open against `main`.
