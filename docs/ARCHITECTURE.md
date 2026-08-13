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
| `bin/mona-agent.js` | CLI entrypoint — `gui`, `start`, `login`, `connect`, `chat`, `exec` |
| `src/config.js` | Credentials, cloud endpoint resolution, platform detection |
| `src/cloud.js` | REST client for the control plane API (Bearer-auth) |
| `src/control.js` | Control channel: registration, command dispatch, metrics streaming |
| `src/api.js` | Local HTTP API + WebSocket (used by the local dashboard / desktop UI) |
| `src/tools/*` | The tool sandbox: `files`, `shell`, `net`, `sysinfo` |
| `src/tui.js` | Terminal dashboard — live log, scrollback, status bar |
| `src/log.js` | Structured logging (quiet in daemon mode) |

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

- Up to **8 tool steps per task** — the loop ends when the brain answers
  in plain text.
- Tool protocol is provider-agnostic: the brain replies with a single
  JSON object `{"tool":"<name>","args":{...}}` or plain text. No
  provider-specific function-calling plumbing.
- Every step is reported to the cloud (`tool.call` / `tool.result`) and
  appears live in the dashboard activity feed.
- The final answer is stored in the cloud conversation — history survives
  restarts and is visible from every client.

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
- **Guarded shell** — commands run through an allowlist; dangerous patterns
  are blocked before execution.
- **Confined files tool** — reads/writes are limited to safe, allowed paths.
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
