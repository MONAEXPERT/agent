# Migrating from mona-agent to RemoteAgent

The project was renamed from **mona-agent** to **RemoteAgent**. Everything
below is designed to keep existing installations working — the old names are
deprecated, not removed.

## Summary

| What | Old | New | Status |
|---|---|---|---|
| CLI binary | `mona-agent` | `remoteagent` | `mona-agent` kept as a permanent alias |
| State directory | `~/.mona-agent` | `~/.remoteagent` | moved once, symlink left behind; old path keeps resolving |
| Environment prefix | `MONA_*` | `RA_*` | `MONA_*` still accepted; removal in v4.0.0 |
| systemd unit | `mona-agent.service` | `remoteagent.service` | installer disables the old unit, enables the new one |
| launchd label | `com.monaexpert.agent` | `online.remoteagent.agent` | installer boots out the old agent, loads the new one |
| Release archive | `mona-agent-<tag>.tar.gz` | `remoteagent-<tag>.tar.gz` | both published (identical bytes) for ≥3 releases |
| Marketing site | `agent.mona.expert` | `remoteagent.online` | 301 redirects |
| Dashboard | `agent.mona.expert` | `app.remoteagent.online` | 301 redirects |
| Control plane API | `agent.mona.expert` | `api.remoteagent.online` | old host keeps answering and proxies to the new one |

## State directory

On first run after the upgrade (or during install), `~/.mona-agent` is moved
to `~/.remoteagent` and a symlink is left at the old path. The directory is
**never deleted** — it holds credentials and the hash-chained audit log.

- If the old path is already a symlink, nothing happens.
- If both directories exist, nothing is merged or overwritten; both remain.

## Environment variables

`RA_*` wins when both prefixes are set. A `MONA_*` variable still works and
emits a one-time `DeprecationWarning` per process. Support for `MONA_*` will
be removed in v4.0.0 (announced in the changelog).

| Old | New |
|---|---|
| `MONA_AGENT_BIN` | `RA_AGENT_BIN` |
| `MONA_ALLOW_CMDS` | `RA_ALLOW_CMDS` |
| `MONA_AUDIT` | `RA_AUDIT` |
| `MONA_AUDIT_KEY_DIR` | `RA_AUDIT_KEY_DIR` |
| `MONA_BUDGET_STORE` | `RA_BUDGET_STORE` |
| `MONA_CLOUD` | `RA_CLOUD` |
| `MONA_CLOUD_WS` | `RA_CLOUD_WS` |
| `MONA_DEVICES_STORE` | `RA_DEVICES_STORE` |
| `MONA_GOALS_STORE` | `RA_GOALS_STORE` |
| `MONA_INSTALL_DIR` | `RA_INSTALL_DIR` |
| `MONA_JIT_STORE` | `RA_JIT_STORE` |
| `MONA_MEMORY_DIR` | `RA_MEMORY_DIR` |
| `MONA_MEMORY_STORE` | `RA_MEMORY_STORE` |
| `MONA_METRICS_PORT` | `RA_METRICS_PORT` |
| `MONA_NO_SANDBOX` | `RA_NO_SANDBOX` |
| `MONA_PKGS_STORE` | `RA_PKGS_STORE` |
| `MONA_POLICY` | `RA_POLICY` |
| `MONA_POLICY_REGISTRY_STORE` | `RA_POLICY_REGISTRY_STORE` |
| `MONA_PROVIDER` | `RA_PROVIDER` |
| `MONA_PROVIDER_FILE` | `RA_PROVIDER_FILE` |
| `MONA_PROVIDER_KEY` | `RA_PROVIDER_KEY` |
| `MONA_PROVIDER_MODEL` | `RA_PROVIDER_MODEL` |
| `MONA_PROVIDER_URL` | `RA_PROVIDER_URL` |
| `MONA_REPO` | `RA_REPO` |
| `MONA_REQUIRE_CHECKSUM` | `RA_REQUIRE_CHECKSUM` |
| `MONA_RUNS_STORE` | `RA_RUNS_STORE` |
| `MONA_SANDBOX` | `RA_SANDBOX` |
| `MONA_SERVICE` | `RA_SERVICE` |
| `MONA_SHELL_UNSAFE` | `RA_SHELL_UNSAFE` |
| `MONA_SKILLS_DIR` | `RA_SKILLS_DIR` |
| `MONA_TOOL_PATH` | `RA_TOOL_PATH` |
| `MONA_TRANSPORT` | `RA_TRANSPORT` |
| `MONA_TRASH` | `RA_TRASH` |
| `MONA_UPGRADES_STORE` | `RA_UPGRADES_STORE` |
| `MONA_VECTOR_STORE` | `RA_VECTOR_STORE` |
| `MONA_WORKSPACE` | `RA_WORKSPACE` |

The installer still reads `MONA_INSTALL_DIR`, `MONA_REPO` and
`MONA_REQUIRE_CHECKSUM` as legacy names for compatibility.

## Endpoint guard (new hardening)

Since the rename, the daemon validates its control-plane endpoint before
connecting (packages/engine/src/endpoints.js, wired into config.js):

- **TLS mandatory** — https/wss on every non-loopback host. Plaintext
  http/ws works only on loopback (self-hosted Docker platform).
- **Host allowlist** — by default only `remoteagent.online` and
  `*.remoteagent.online`. Self-hosted or corporate planes must be named
  explicitly in the new `RA_CLOUD_ALLOWLIST` variable (comma-separated,
  supports `*.domain` wildcards).
- **No credentials in URLs**, and **no raw IP literals** off-loopback.

A daemon whose endpoint fails validation refuses to start (fail-closed).
Loopback hosts (localhost/127.0.0.1/::1) are always allowed for the local
Docker platform.

## Intentionally unchanged (wire & format compatibility)

These strings are part of on-disk or on-wire formats. Changing them would
break existing deployments, so they keep their historical names:

- **Protocol wire contract** — message type strings, envelope field names,
  and close codes in `packages/protocol` (old daemons must keep connecting).
- **Control-plane HTTP paths** — `/api/v1/mona/*` on the Sngine platform.
- **Device headers** — `x-mona-agent`, `x-mona-agent-id`.
- **Signed-record domains** — `mona-audit-v1`, `mona-capability-grant-v1`,
  `mona-device-identity-v1`, `mona-enrollment-v1` (hash chains, grants and
  device identities verify across the rename).
- **Plugin package convention** — `remoteagent-tool-*`; the legacy
  `mona-agent-tool-*` prefix is still discovered.
- **Plugin manifest key** — the `remoteAgent` field in tool-package
  manifests; the legacy `monaAgent` field is still accepted.
- **Release archive** — `mona-agent-<tag>.tar.gz` keeps being published so
  already-installed clients pass checksum verification during self-update.

## Updating

Existing installations self-update normally:

```bash
remoteagent update        # or: mona-agent update
```

The first run after the update performs the state-directory migration
automatically. `remoteagent audit verify` keeps working on the migrated
chain — the audit log is moved with the directory, never rewritten.

## Rollback

Roll back to the pre-rebrand release by installing the
`pre-rebrand-v2.11.0` tag. The state-dir symlink means both the old binary
and the new one resolve the same data; if you moved back permanently you can
move `~/.remoteagent` back to `~/.mona-agent` and remove the symlink first.
