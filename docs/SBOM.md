# Software Bill of Materials (SBOM)

The mona-agent client ships with an SBOM in CycloneDX format:
[`sbom.cyclonedx.json`](../sbom.cyclonedx.json).

## Highlights

- **1 runtime dependency** — `ws` (WebSocket implementation). No
  transitive runtime dependencies.
- **Zero build step** — the client runs directly from source on
  Node.js ≥ 20.
- **Dev dependencies** — none beyond the Node.js test runner (162 tests,
  including the 58-case security red-team suite).

## Regeneration

```bash
cd apps/desktop
npm ls --json --omit=dev --all > /tmp/deps.json
# the sbom is regenerated from deps.json + package metadata (scripts/sbom.mjs)
node ../../scripts/sbom.mjs
```

## Vulnerability handling

Dependencies are monitored on every change. If a CVE is reported in a
dependency:

1. Triaged within 48 h
2. Fixed / mitigated and released
3. Coordinated disclosure via [SECURITY.md](../SECURITY.md)

One dependency means the attack surface stays small — that is a
deliberate engineering constraint of this project.
# Software Bill of Materials (SBOM)

Client-side component inventory for the mona-agent device daemon.

## Runtime dependencies

| Component | Version | Purpose | License |
|---|---|---|---|
| Node.js (runtime) | ≥ 20 | JavaScript runtime | MIT |
| ws | ^8.18 | WebSocket client (optional relay) | MIT |

The client has exactly **one npm dependency** (`ws`); everything else —
cloud client, engine protocol, SSE handling, tool registry, TUI — is
implemented in this repository with Node built-ins.

## Build & toolchain

| Component | Purpose |
|---|---|
| node:test | Test runner (162 tests incl. 58-case red-team suite, no external test deps) |
| npm workspaces | Monorepo layout (packages/engine, packages/protocol, apps/desktop) |

## Server-side (operated by the platform)

The cloud side is a PHP application on standard shared hosting (LiteSpeed,
MySQL/MariaDB, PHP 8.x) plus the Sngine framework for accounts and payments.
Provider SDKs are not used; LLM calls are plain HTTPS REST. Server components
are the operator's responsibility and are documented for audits in this
folder.

## Generating a full SBOM

```bash
npm ls --all --json > sbom-npm.json
```

Combine with the Git tag manifest (`git tag`, `CHANGELOG.md`) for a complete
release inventory.

## Vulnerability monitoring

- `npm audit` on the single dependency per release
- GitHub Security advisories for the repository
- SECURITY.md reporting path for external findings
