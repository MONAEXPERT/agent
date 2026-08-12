# mona-agent — the cloud-brained AI agent for your device ⚡

<p align="center">
  <strong>An open-source AI agent that lives on your Mac or Linux machine.<br/>
  Chat with it, let it run commands, manage files — from any device, anywhere.</strong>
</p>

<p align="center">
  <a href="https://github.com/MONAEXPERT/agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js 20+"></a>
  <a href="https://github.com/MONAEXPERT/agent/actions"><img src="https://img.shields.io/badge/tests-26%2F26-passing-brightgreen.svg" alt="Tests: 26/26 passing"></a>
  <a href="https://github.com/MONAEXPERT/agent/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-1-lightgrey.svg" alt="1 runtime dependency"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL2-informational.svg" alt="Platforms: macOS, Linux, WSL2">
  <img src="https://img.shields.io/badge/cloud-agent.mona.expert-blueviolet.svg" alt="Cloud: agent.mona.expert">
</p>

---

## What is mona-agent?

**mona-agent** is a lightweight, headless **AI agent daemon** that runs on your
computer. It connects to the mona.expert cloud, receives commands from your
dashboard or chat, executes **local tools** (files, shell, network, system
info), and streams the results back in real time.

Think of it as a **smart terminal for your machine** — an AI assistant with
hands. You can be at the office and ask your Mac at home to check disk space,
restart a service, or find a file. The agent does it and answers.

**No AI API keys ever live on your device.** All reasoning happens in the
cloud. Your device is a secure, capable pair of hands.

```
  Your Device                           mona.expert Cloud (SaaS)
  +-------------------+                +----------------------------+
  |   mona-agent      |                |  Dashboard (agent.mona.expert)
  |                   |--- HTTPS ----+ |  Agent orchestration
  |  * Terminal UI    |               |  AI engine (the brain)
  |  * File tools     |<-- commands --+  Chat & history
  |  * Shell guard    |               |  API key vault (AES-256)
  |  * Network tools  |-- metrics --->+  Live device monitoring
  |  * System info    |-- results --->+  Audit log
  +-------------------+                +----------------------------+
```

## Why mona-agent?

- 🖥 **Remote control with AI** — chat with your computer from anywhere, or
  let the cloud agent act on its own
- 🔐 **Zero secrets on the device** — no OpenAI/Anthropic/Google keys are
  stored locally; they live in the encrypted cloud vault
- ⚡ **Terminal-native** — a fast TUI dashboard with live log streaming,
  or a fully headless daemon mode
- 🛠 **Real tools, real actions** — files, shell commands, network checks,
  system metrics
- 📊 **Live device monitoring** — CPU, RAM, disk, load, uptime streamed to
  your dashboard every 10 seconds
- 📦 **One command install** — no build step, single runtime dependency
  (`ws`), works on macOS, Linux and WSL2
- 🆓 **Free and open source** — MIT licensed

## Quickstart — up and running in 60 seconds

```bash
# 1. Install (macOS / Linux / WSL2, needs Node.js 20+)
curl -fsSL https://agent.mona.expert/install.sh | bash

# 2. Log in with your mona.expert API key
mona-agent login

# 3. Start the terminal dashboard
mona-agent gui

# …or run fully headless in the background
mona-agent start
```

Now open **<https://agent.mona.expert/dashboard>** — your device appears
with live stats, and you can chat with it right from the browser.

## Usage

```bash
mona-agent login                 # store your mona.expert API key
mona-agent connect               # connect to the cloud control plane
mona-agent gui                   # terminal dashboard (live log, status)
mona-agent chat "Check disk usage and free up old logs"   # one-shot command
mona-agent exec "uptime && df -h"                        # run a command
mona-agent start                 # daemon mode (background, auto-reconnect)
```

## Built-in tools

| Tool      | What the agent can do with it                              |
|-----------|------------------------------------------------------------|
| `files`   | List, read, write, move, delete — confined to safe paths   |
| `shell`   | Run commands through a guarded, allowlisted shell          |
| `net`     | HTTP requests, connectivity checks, DNS lookups            |
| `sysinfo` | CPU, memory, disk, load, uptime, platform, network info    |

Full reference: **[docs/TOOLS.md](docs/TOOLS.md)**

## How it works

The daemon maintains a **control channel** to the cloud over HTTPS + WebSocket
(where available). It streams device metrics every 10 seconds, receives
**commands** from the cloud engine, executes them with the local tool
sandbox, and streams results back. Read the full walkthrough in
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## FAQ

**Is mona-agent free?** — Yes. The client is MIT licensed and free forever.
The mona.expert cloud has a free tier at
[agent.mona.expert](https://agent.mona.expert).

**Does my API key get stored on the device?** — Only your mona.expert
device token is stored locally (`~/.mona-agent/credentials.json`). AI
provider keys live only in the cloud vault, AES-256 encrypted.

**Can I run it on a server?** — Yes. Any Node.js 20+ machine works,
including headless Linux servers and Raspberry Pi class devices.

**What data leaves my device?** — Command results and system metrics, only
to the mona.expert cloud you are logged into. See
**[SECURITY.md](SECURITY.md)**.

More answers: **[docs/FAQ.md](docs/FAQ.md)**

## Documentation

| Page | Contents |
|------|----------|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Install, login, first steps, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Daemon internals, control channel, metrics pipeline |
| [docs/TOOLS.md](docs/TOOLS.md) | Tool-by-tool reference with examples |
| [docs/EXAMPLES.md](docs/EXAMPLES.md) | Automation recipes — cron, watchdogs, backups |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Cloud API, scheduling, boot persistence |
| [docs/FAQ.md](docs/FAQ.md) | Frequently asked questions |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [examples/](examples) | launchd & systemd units, health check script |
| [SECURITY.md](SECURITY.md) | Security model & vulnerability reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, tests, conventions |

## Development

```bash
git clone git@github.com:MONAEXPERT/agent.git
cd agent
npm install
npm test            # 26 tests, 9 suites
npm run gui         # run the dev build of the TUI
```

Requires Node.js ≥ 20. The codebase is plain modern JavaScript (ESM), no
build step.

## License

MIT — see [LICENSE](LICENSE). Free forever.

---

**[mona.expert](https://agent.mona.expert)** — one key, one brain, any
device. ⚡
