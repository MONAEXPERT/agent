# mona-agent Architecture

How the open-source device daemon is built, and how it talks to the
mona.expert cloud.

## Overview

mona-agent is a **headless Node.js daemon** with two jobs:

1. **Execute** — run local tools (files, shell, network, system info) on
   behalf of the cloud agent.
2. **Report** — stream device metrics and command results back to the cloud
   in real time.

```
┌─────────────────────────────────────┐      ┌──────────────────────────────┐
│  Device (your machine)              │      │  mona.expert cloud (SaaS)    │
│                                     │      │                              │
│  mona-agent                         │      │  Control plane API           │
│  ┌──────────────┐   ┌────────────┐  │      │  /api/v1/agent/verify        │
│  │ ControlChannel│◄─►│ tools/     │  │      │  /api/v1/agent/stats        │
│  │ (HTTPS + WS) │   │  files     │  │      │  /api/v1/agent/chat …        │
│  │              │   │  shell     │  │      │                              │
│  │   metrics   │   │  net       │  │      │  AI engine (the brain)       │
│  │   commands  │   │  sysinfo   │  │      │  Dashboard + device overview │
│  └──────────────┘   └────────────┘  │      │  Key vault (AES-256)         │
│         │                           │      │  Audit log                   │
│         ▼                           │      └──────────────────────────────┘
│  TUI (mona-agent gui)               │
│  headless daemon (mona-agent start) │
└─────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
|---|---|
| `bin/mona-agent.js` | CLI entrypoint — `gui`, `start`, `login`, `connect`, `chat`, `exec`, `policy`, `audit` |
| `src/config.js` | Credentials, cloud endpoint resolution, platform detection |
| `src/cloud.js` | REST client for the control plane API (Bearer-auth) |
| `src/control.js` | Control channel: versioned envelopes, command dispatch, metrics streaming |
| `src/api.js` | Local HTTP API + WebSocket (used by the local dashboard / desktop UI) |
| `src/agent.js` | Wires the engine core to the cloud brain, tools and trace reporting |
| `src/tools/*` | The tool sandbox: `files`, `shell`, `net`, `sysinfo`, `apps`, `browser`, `web`, `memory`, `notify` |
| `src/tui.js` | Terminal dashboard — live log, scrollback, status bar |
| `src/log.js` | Structured logging (quiet in daemon mode) |

## Workspaces

The repo is an npm monorepo with three packages:

| Package | Purpose |
|---|---|
| `packages/engine` (`@mona/engine`) | The agent core — policy-as-code, budget governor, structured memory, the bounded TaskLoop. Zero runtime dependencies; fully testable offline. |
| `packages/protocol` (`@mona/protocol`) | The wire contract — versioned envelopes, message types, close codes. The daemon and the gateway both implement it, so they can never drift apart. |
| `apps/desktop` (`mona-agent`) | The device daemon — consumes both packages; the only credential it holds is the mona.expert key. |

The daemon is intentionally thin: it supplies the brain (cloud `think`), the
tools and the trace plumbing — all loop behavior (policy checks, budget
steering, corrective nudges, forced conclusion) is engine code that is
tested once and shared with every future client.

## Control channel lifecycle

1. **Boot** — `config.js` loads `~/.mona-agent/credentials.json` and
   resolves the cloud endpoint (`MONA_CLOUD` or `https://agent.mona.expert`).
2. **Verify** — the daemon authenticates with `POST /api/v1/agent/verify`
   (Bearer token). The server returns the agent identity and capabilities.
3. **Metrics** — every 10 seconds the daemon POSTs a snapshot to
   `/api/v1/agent/stats`: CPU %, load average, memory, disk, uptime, host
   and platform info.
4. **Commands** — on the Sngine control plane the device **polls the cloud
   task queue** every 2 s (`GET /api/v1/agent/tasks`, claim, then report
   via `POST /api/v1/agent/tasks/:id/result`). No inbound port, no
   WebSocket upgrade required. On the Docker platform, commands arrive
   over the WebSocket control channel instead.
5. **Resilience** — metrics streaming is independent of the WebSocket
   channel. If the server cannot upgrade to WebSocket (e.g. shared hosting
   behind LiteSpeed), the daemon transparently falls back to HTTPS polling
   and keeps streaming — no reconnect storm.

## Agentic execution loop

Every task runs the same loop, wherever it came from (dashboard chat,
CLI, or the cloud queue):

```
        ┌───────────────────────────────────────────────────┐
        │                 mona.expert brain                │
        │  reason  answer in text OR emit one tool call   │
        └───────────────┬───────────────────────▲──────────┘
           task (HTTPS) │                       │ tool result
        ┌───────────────▼───────────────────────┴──────────┐
        │                   mona-agent                     │
        │  execute tool locally (sysinfo|shell|files|net)  │
        └───────────────────────────────────────────────────┘
```

- Up to **N tool steps per task** (default 8, owner-configurable 2–16 via the
  cloud brain settings) — the loop ends when the brain answers in plain text.
- Tool protocol is provider-agnostic: the brain replies with a single
  JSON object `{"tool":"<name>","args":{...}}` or plain text. No
  provider-specific function-calling plumbing.
- Every tool call is **policy-checked before execution** (engine Policy):
  unknown tools are denied, shell commands run the base + policy deny lists,
  `confirm`-tier tools require approval.
- **Budget steering** — when the daily token/cost caps approach their limit,
  the engine degrades the reasoning profile (`eco` → `cheap` profile, fewer
  steps; `critical` → minimal profile; `exhausted` → no new tasks).
- Every step is reported to the cloud (`tool.call` / `tool.result`,
  plus `think`, `profile`, `denied`, `correct`, `verify` entries) and
  appears live in the dashboard activity feed.
- **Never loops silently** — each iteration emits `step i/N`; a malformed
  reply gets at most 3 corrective nudges; when the step budget runs out the
  engine forces one final conclusion (`conclude`) instead of hanging.
- The final answer is stored in the cloud conversation — history survives
  restarts and is visible from every client.
- Finished tasks are folded into the engine's **structured memory** (dedupe,
  TTL, scored recall) and recalled into future prompts, so the agent
  remembers what it already did.

## Metrics pipeline (HTTP-first)

The client was designed so that **metrics never depend on a WebSocket
upgrade**:

- Every 10 s: `POST /api/v1/agent/stats` with CPU, memory, disk, load,
  uptime, hostname, platform, arch, version, IP.
- The cloud keeps the latest snapshot plus a rolling 180-point history per
  device; the dashboard polls every 3 s — effectively live.
- A device is shown as **online** when its last snapshot is ≤ 20 s old.

## Security model (client side)

- **No AI provider keys on the device.** Only a mona.expert device token is
  stored (`~/.mona-agent/credentials.json`, mode 0600).
- **Local policy is authoritative.** `~/.mona-agent/policy.json`
  (`MONA_POLICY` to override) governs every tool call — allow / deny /
  confirm tiers, shell patterns, per-tool rate limits, daily budget caps.
  It is loaded once from disk at startup; the control plane can never
  modify or widen it. Presets: `mona-agent policy preset strict|standard|permissive`.
- **Shell executes argv arrays, never shell strings.** Commands are parsed
  quote-aware; every executable is realpath-resolved and allowlisted
  (chains and pipes re-check each segment); the child environment is
  scrubbed to `PATH/HOME/LANG`; timeouts kill the whole process group.
- **SSRF-safe networking.** DNS is resolved by the agent and every address
  is checked against blocked ranges; connections go to the validated IP
  with Host header + TLS SNI; redirects are re-validated per hop (max 5);
  cloud metadata endpoints are blocked by name and IP.
- **Confined files tool.** Boundary-checked workspace containment with
  symlink-escape and TOCTOU guards (`O_NOFOLLOW` + descriptor check),
  special files refused, deletes move to trash.
- **Tamper-evident audit.** Every policy decision is appended to
  `~/.mona-agent/audit.jsonl` (hash-chained, append-only, 0600) and
  verified with `mona-agent audit verify`.
- **Egress-only** — the daemon opens outbound connections only; it listens
  on localhost only (for the local dashboard).

See [SECURITY.md](../SECURITY.md) for the full model and disclosure policy.

## Why HTTPS polling instead of WebSockets?

The control plane runs on shared hosting (LiteSpeed), where WebSocket
proxying is not always available and long-running Node processes are not
possible. The client therefore uses:

- **WebSocket** when the server upgrades it (self-hosted / VPS setups),
- **HTTPS polling + streaming metrics** everywhere else.

One code path, two transports — the daemon decides at runtime.
