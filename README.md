# mona-agent — Cloud-Brained AI Agent for Your Device

<p align="center">
  <strong>Open-source device agent. Free forever. MIT licensed.</strong>
</p>

<p align="center">
  <a href="https://github.com/MONAEXPERT/agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js"></a>
  <img src="https://img.shields.io/badge/dependencies-1-lightgrey" alt="1 dependency">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL2-informational" alt="Platforms">
</p>

---

## What is this?

**mona-agent** is a headless daemon that runs on any device. It connects to a control plane, receives commands, executes local tools, and streams results back.

No LLM provider keys (OpenAI, Anthropic, Google, etc.) are stored on your device. Reasoning happens in the cloud — the device is a smart terminal.

```
  Your Device                           Control Plane (SaaS or self-hosted)
  +-------------------+                +----------------------------+
  |  mona-agent       |--- WSS ------+ |  Dashboard / Website        |
  |                   |               |  Auth / User Management     |
  |  * Terminal GUI   |<-- commands -- |  API Key Vault (AES-256)   |
  |  * Local tools    |-- telemetry -+ |  LLM Proxy (5 providers)   |
  |  * File sandbox   |-- tokens ----+ |  Agent Orchestration       |
  |  * Shell guard    |-- metrics ---+ |  Audit Log                 |
  |                   |               |                            |
  |  <- NO API KEYS ->|               |  <-- YOUR KEYS STAY HERE --> |
  +-------------------+               +----------------------------+
```

## Quick Start

```bash
# Install
curl -fsSL https://agent.mona.expert/install.sh | bash

# Login to your control plane
mona-agent login       # paste your API key

# Run
mona-agent gui         # terminal dashboard with live metrics
mona-agent start       # headless daemon (no UI)
```

## Terminal Dashboard

Built-in TUI — zero extra dependencies. Pure ANSI escape codes.

```
+-- mona-agent v1.0.0 ------------------------- * connected ---+
| +-- System -------------------+ +-- Activity ---------------+ |
| | Host     MacBook-Pro        | | 22:54 * Connected         | |
| | OS       darwin arm64       | | 22:55 > Task: "sys info"  | |
| | CPUs     10 cores           | | 22:55 ~ Thinking...       | |
| | Mem      [####    ] 62%     | | 22:56 + Done (142 tok)    | |
| +-- Task ---------------------+ |                           | |
| | + Idle                      | |                           | |
| +-----------------------------+ +---------------------------+ |
| q quit &middot; c clear &middot; arrows scroll                 |
+----------------------------------------------------------------+
```

## Tools

The agent ships with four sandboxed tool modules:

| Tool | Capabilities | Security |
|------|-------------|----------|
| `sysinfo` | OS, CPU, memory, load, network, uptime | Read-only |
| `shell` | Command execution | Allowlist + blocked patterns |
| `files` | Read/write/list/delete/stat | Path sandboxed |
| `net` | HTTP fetch/check, connectivity | HTTP(S)-only |

### Shell Security

By default only safe commands are allowed. Extend via environment:

```bash
MONA_ALLOW_CMDS="df,uptime,uname,git,npm,docker" mona-agent start
```

Destructive patterns (`rm -rf /`, `mkfs`, fork bombs) are always blocked.

## Commands

```
mona-agent gui       Terminal dashboard with live metrics
mona-agent start     Headless daemon — no UI, log to stderr
mona-agent login     Save your control-plane API key
mona-agent status    Show login state and config paths
mona-agent help      Show all commands and environment vars
```

Without arguments, auto-detects: GUI if terminal, headless otherwise.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MONA_CLOUD` | `https://agent.mona.expert` | Control plane URL |
| `MONA_CLOUD_WS` | Auto-derived | WebSocket URL override |
| `MONA_ALLOW_CMDS` | `df,uptime,uname,...` | Shell command allowlist |
| `MONA_SHELL_UNSAFE` | — | Set to `1` for unrestricted shell |
| `MONA_WORKSPACE` | `~/.mona-agent/workspace` | File tool sandbox directory |

## Project Structure

```
agent/
+-- bin/mona-agent.js         CLI entry point
+-- src/
|   +-- agent.js              Agent daemon (reasoning loop)
|   +-- cloud.js              Cloud API client (SSE streaming)
|   +-- config.js             Configuration & credential management
|   +-- control.js            WebSocket control channel (reconnect, metrics)
|   +-- log.js                Structured event-driven logger
|   +-- tui.js                Terminal dashboard (pure ANSI)
|   +-- tools/
|       +-- index.js          Tool registry & dispatcher
|       +-- sysinfo.js        System information
|       +-- shell.js          Sandboxed shell execution
|       +-- files.js          File system operations
|       +-- net.js            Network operations
+-- test/
|   +-- agent.test.mjs        14 unit tests
+-- install.sh                One-line install script
+-- README.md
+-- LICENSE
+-- package.json
```

## Architecture

**Cloud-brained**: Reasoning happens on the control plane where API keys live. The device executes tools and streams results. The device never touches LLM provider credentials.

- **Commands** (`run`, `tool`, `ping`) flow: control plane -> cloud -> device
- **Telemetry** (`metrics`, `steps`, `tokens`, `results`) flow: device -> cloud -> control plane
- **API keys** never leave the control plane

The device stores **only** the control-plane API key in `~/.mona-agent/credentials.json` (mode `0600`).

## Open Source & SaaS

| What | Where | Price |
|------|-------|-------|
| **Device agent** | This repo — install, modify, fork | Free & open source (MIT) |
| **Control plane** | Self-host or SaaS at [agent.mona.expert](https://agent.mona.expert) | Free tier available |

The agent is MIT. Use it with any control plane. The cloud platform at agent.mona.expert provides the managed experience with premium plans for teams.

## Development

```bash
git clone https://github.com/MONAEXPERT/agent.git
cd agent
npm install
npm test               # 14 tests, all passing
```

## License

MIT — free forever.

---

<p align="center">
  <sub>
    mona-agent &middot; <a href="https://agent.mona.expert">agent.mona.expert</a> &middot;
    <a href="https://github.com/MONAEXPERT/agent">GitHub</a> &middot;
    <a href="https://github.com/MONAEXPERT/agent/issues">Issues</a>
  </sub>
</p>

<p align="center">
  <sub>Open-source device agent. No LLM keys on your device. Ever.</sub>
</p>
