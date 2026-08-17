# Changelog

All notable changes to mona-agent are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Vector indexing (dependency-free, local).** New engine module
  `packages/engine/src/vector.js`: a deterministic hashing-trick embedding
  (256-dim signed feature vectors, djb2 + fnv1a), cosine similarity scoring,
  persistent JSON index (0600), TTL, dedupe-by-merge. No API keys, no
  network, no npm dependencies.
- **`vector` tool** (`apps/desktop/src/tools/vector.js`): `remember` notes,
  `index` workspace files (chunked, binary-safe, workspace-confined),
  `search` in natural language, `list` / `stats` / `forget`.
- **Vector recall in prompts**: `MemoryStore.recall` now scores by hybrid
  vector + recency + hit boost (legacy entries embedded lazily), and the
  daemon injects vector-searched context into every task's system prompt.
- **Serial task queue** (`apps/desktop/src/taskqueue.js`): tasks run one at
  a time in arrival order; waiting tasks report their position; steps from
  different tasks can never interleave.
- **Context compaction** in the engine loop: when a task's message history
  exceeds a character budget, old tool results are compressed (head + recent
  tail always survive verbatim) — long tasks no longer risk blowing the
  brain's context window. Visible via `task.compact` step + audit entry.
- **Local task audit**: every task event (start / think / tool / result /
  denied / compact / verify / answer / error) is written to the same
  hash-chained `~/.mona-agent/audit.jsonl` used for policy decisions —
  `mona-agent audit tail|verify` now covers the full task trail.
- **`jobs` tool — background command management** (`apps/desktop/src/tools/jobs.js`):
  long-running work no longer blocks the task loop or dies with the 15s shell
  timeout. `jobs start <cmd> [cwd]` returns a job id + pid immediately,
  `status <id>`, `output <id> [tail]`, `list`, `wait <id> [timeoutS]` and
  `kill <id>` manage it — the same job lifecycle a harness exposes to the
  brain. Background commands route through the *same* security surface as
  the shell tool (argv parsing, allowlist, blocked patterns, scrubbed env)
  and honour the shell policy tier, so a background command can never widen
  device policy. The tool registry now supports per-tool timeouts (jobs may
  wait up to 130s; every other tool keeps the 30s default).
- **`delegate` tool — sub-agent fan-out** (`packages/engine/src/delegate.js` +
  `apps/desktop/src/tools/delegate.js`): the brain splits a task into up to
  six independent sub-tasks (`[{id, prompt}]`) that run **concurrently** as
  fresh, bounded `TaskLoop`s with their own message context — sharing the
  same policy, budget and tool sandbox. Every sub-result returns
  `{status, answer, steps, usage, trace}` so the parent verifies each piece
  before answering; failed sub-agents are reported, never hidden. Sub-steps
  land in the local hash-chained audit log (`kind: subtask`). Delegation is
  depth-limited (max 2 levels) so it can never nest into runaway recursion,
  and sub-loops respect policy exactly like the main loop.

### Changed
- `MemoryStore` recall is vector-based while keeping the same on-disk format
  and public API — existing memory files work untouched.
- Tools list now advertises `vector` to the cloud brain.

## [2.8.3] — 2026-08-16

### Added
- Dashboard-driven version lifecycle: `!cmd version|update|status` system
  commands handled locally on the device (zero tokens, never reach the
  brain). Server `GET /agents` now surfaces `version`, `last_seen`,
  `online`; `POST /agents/:id/update` queues a self-update; agents UI shows
  the agent version + live badge + Update button.

### Fixed
- `mona-agent update` now verifies the extracted archive version matches
  the requested tag (guards against stale GitHub CDN archives).
- Pre-existing broken `open` allowlist test (duplicate block + wrong
  export) — suite green again.

## [2.8.2] — 2026-08-16

### Added
- Version lifecycle foundation: single source of truth (`src/version.js`
  reads root `package.json`), `mona-agent version`, `mona-agent update
  [check]` (GitHub release feed with tag fallback, self-update with
  rollback on failure, lifecycle record `~/.mona-agent/update.json`).
- Dashboard `update` + `version` commands over the control channel.

## [2.8.1] — 2026-08-16

### Fixed
- Shell allowlist: `open` added to the macOS default allowlist — the agent
  can launch apps/URLs (`open -a Calendar`) out of the box.

## [2.8.0] — 2026-08-16

### Security
- argv shell: quote-aware parsing, `execFile/spawn shell:false`, realpath
  allowlist per segment, scrubbed child env, process-group kill on timeout,
  redirects/`$()`/backticks rejected. `MONA_SHELL_UNSAFE` env var
  deprecated → policy `shell.unsafe` (audited).
- net: DNS resolved by agent, every address CIDR-checked, connect-to-IP +
  Host/SNI, redirect revalidation (max 5), metadata endpoints blocked,
  bounded body reads.
- files: O_NOFOLLOW + fstat TOCTOU guard, special-file refusal, trash-based
  delete, try/catch contract.
- policy v2: hash-chained append-only audit log (`mona-agent audit
  tail|verify`), per-tool rate limits, strict/standard/permissive presets,
  `explain()`, registry-wide policy choke point.

### Added
- CLI: `policy status|explain|preset`, `audit tail|verify`.
- CI: Node 20/22/24 × ubuntu/macos, npm audit job, dependabot, SHA-pinned
  actions.
- Tests: 162 green incl. 58-case red-team suite.

## [2.7.0] — 2026-08-16

### Added
- Wire engine + protocol into the daemon — one core, one wire contract.

## Earlier

- v2.0.0–v2.6.x: initial releases (control plane, device daemon, TUI,
  skills, policy v1, hash-chained audit, mTLS identity, sandboxing).
