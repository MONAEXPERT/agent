---
license: mit
tags:
- ai-agent
- agent
- automation
- cli
- daemon
- terminal
- macos
- linux
language:
- en
---

# mona-agent — your computer, with a brain in the cloud 

<p align="center">
  <strong>The open-source AI agent for your computer.<br/>
  Chat from anywhere. It runs commands, manages files and automates tasks —<br/>
  private by design, with your AI keys locked in an encrypted cloud vault.</strong>
</p>

<p align="center">
  <a href="https://github.com/MONAEXPERT/agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js 20+"></a>
  <a href="https://github.com/MONAEXPERT/agent/actions"><img src="https://github.com/MONAEXPERT/agent/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/MONAEXPERT/agent/blob/main/package.json"><img src="https://img.shields.io/badge/dependencies-1-lightgrey.svg" alt="1 runtime dependency"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL2-informational.svg" alt="Platforms: macOS, Linux, WSL2">
  <img src="https://img.shields.io/badge/security-egress--only%20%7C%20sandboxed-brightgreen.svg" alt="Security: egress-only, sandboxed">
  <img src="https://img.shields.io/badge/privacy-AES--256%20vault-blueviolet.svg" alt="Privacy: AES-256 key vault">
  <a href="https://huggingface.co/aiagentmona/mona-agent"><img src="https://img.shields.io/badge/%F0%9F%A4%97%20Hugging%20Face-aiagentmona%2Fmona-agent-yellow.svg" alt="Hugging Face: aiagentmona/mona-agent"></a>
</p>

## Contents

- [Private & secure by design](#private--secure-by-design)
- [What it can do](#what-it-can-do)
- [Built for](#built-for)
- [Quickstart — 60 seconds](#quickstart--60-seconds)
- [How mona-agent compares](#how-mona-agent-compares)
- [Documentation](#documentation)
- [Security & compliance](#compliance--trust)

---

## The story

Most AI assistants live in a chat window. They can write you a script — but
they can't run it. They can explain a crash — but they can't look at your
logs. They know everything about your code and nothing about your machine.

**mona-agent is the other half.** It's a small, fast daemon that lives on
your computer — macOS, Linux, WSL2 — and connects it to a brain in the
cloud. You talk to it from your dashboard or your phone; it reasons about
the task, then *actually does it*: checks disk space, restarts a service,
finds a file, opens an app, runs a cleanup. And it streams every step back
so you can watch it think and act in real time.

It's the difference between an advisor and an employee. One tells you what
to do. The other just gets it done.

```
  Your Device                           mona.expert Cloud
  +-------------------+                +----------------------------+
  |   mona-agent      |                |  Dashboard & chat          |
  |                   |--- HTTPS ----+ |  AI engine (the brain)     |
  |  * executes tools |<-- commands --+ |  Agent orchestration       |
  |  * streams metrics|               |  Key vault (AES-256)        |
  |  * terminal UI    |-- results --->+ |  Live device monitoring    |
  +-------------------+                +----------------------------+
```

## Private & secure by design

Your machine is a trust boundary, not a sandbox afterthought.

- **Zero AI keys on your device.** Provider keys (OpenAI, Anthropic, …) live
  only in the cloud, encrypted AES-256-GCM. The device holds one revocable
  token — nothing else worth stealing.
- **Egress-only networking.** The daemon makes outbound HTTPS connections and
  listens on localhost only. No open ports, no public exposure — it works
  behind NAT and firewalls.
- **Guarded execution.** Commands run through an allowlist; dangerous
  patterns (`rm -rf /`, fork bombs, silent `sudo`) are blocked *before*
  execution. File access is confined to safe paths with symlink-escape
  rejection.
- **Complete audit trail.** Every action — reasoning → tool call → result →
  answer → verification — is traced with tokens, cost and latency, and
  exportable for audits.
- **Documented, not hand-waved.** A real [threat model (STRIDE)](docs/additional-documents/THREAT-MODEL.md),
  [data-flow & minimization](docs/additional-documents/DATA-FLOW.md),
  [security self-audit guide](docs/additional-documents/SECURITY-AUDIT.md)
  and [EU CRA readiness](docs/additional-documents/CRA-READINESS.md). No fake
  certifications — "trust me" isn't a security model.

See [SECURITY.md](SECURITY.md) for the full policy and responsible disclosure.

## What it can do

-  **Operate your computer from anywhere** — ask from your phone: *"how's
  the disk looking?"*, *"restart nginx"*, *"open Safari"*
-  **Think  act  observe  deliver** — a real agentic loop: the cloud
  brain plans, the device executes local tools, results flow back, and the
  answer lands in your chat — up to 8 tool steps per task
-  **Fail is never allowed** — transient errors retry automatically,
  failed commands trigger self-diagnosis and a smarter second attempt,
  and every task ends with an answer
-  **Zero secrets on the device** — no AI provider keys are stored
  locally; they live in the encrypted cloud vault. One key. One brain.
-  **Live device monitoring** — CPU, memory, disk, load and uptime
  streamed to your dashboard every 10 seconds, with history sparklines
-  **Terminal-native** — a fast TUI with live logs, or a fully headless
  daemon; one command installs it, one dependency powers it
-  **Free and open source** — MIT licensed, forever

## Built for

-  **Developers** — delegate test runs, log checks and service restarts to a
   device you can chat with from your phone.
-  **Homelab & server ops** — manage headless boxes, Raspberry Pis and NAS
   without SSH; the device polls the cloud, so no open ports are needed.
-  **Personal automation** — open apps, check disk, control media, run
   scripts from any browser.
-  **Kiosks & presentation machines** — restart demo windows and
   long-running GUI programs on demand.
-  **Compliance-heavy teams** — every action traced and exportable; EU CRA /
   NIS2 / AI Act / GDPR documentation included.

More scenarios: [docs/USE-CASES.md](docs/USE-CASES.md).

## Quickstart — 60 seconds

```bash
# 1. Install (needs Node.js 20+)
curl -fsSL https://agent.mona.expert/install.sh | bash

# 2. Log in with your mona.expert key
mona-agent login

# 3. Start the terminal dashboard — or run headless
mona-agent gui
mona-agent start
```

Then open **<https://agent.mona.expert/dashboard>** — your device appears
with live stats, and you can chat with it from the browser.

## Usage

```bash
mona-agent login            # save your mona.expert key
mona-agent connect          # test the connection end to end
mona-agent gui              # terminal dashboard with live log
mona-agent chat "free up disk space"     # one-shot conversation
mona-agent exec "uptime && df -h"        # run a guarded command
mona-agent start            # headless daemon with auto-reconnect
```

In the dashboard chat, just talk normally:

> *"Run `df -h` and tell me my disk usage."* ·
> *"What's the load average?"* ·
> *"Open Spotify and play some focus music."*

The brain picks the tool, the device runs it, you get the result.

## Built-in tools

| Tool | What the agent can do with it |
|------|-------------------------------|
| `sysinfo` | CPU, memory, disk, load, uptime, host and platform details |
| `shell` | Run commands — allowlisted by default, full shell opt-in |
| `files` | List, read, write, move, delete — confined to safe paths |
| `net` | HTTP(S) requests, DNS, connectivity checks |

Full reference: **[docs/TOOLS.md](docs/TOOLS.md)**

## How mona-agent compares

| | Typical AI chat | mona-agent |
|---|---|---|
| Can it see your machine? |  |  live metrics & files |
| Can it execute? |  |  sandboxed shell & tools |
| Does it retry when things fail? |  |  auto-debug + retry loop |
| Where do your API keys live? | on your disk |  encrypted cloud vault |
| Is every action audited? |  |  full trace, exportable |
| Install | app + account | one command, one dependency |

## FAQ

**Is mona-agent free?** — Yes. The client is MIT licensed and free
forever; the cloud has a free tier at
[agent.mona.expert](https://agent.mona.expert).

**What data leaves my device?** — Only what the task requires: system
metrics, and the results of commands you asked the agent to run. Nothing
is sent to third parties. See **[docs/GDPR.md](docs/GDPR.md)**.

**Can it damage my machine?** — Commands are allowlisted by default, the
file tool is confined to safe paths, and every action is recorded in the
audit log. Full shell execution is an explicit opt-in.

**Does it run on servers?** — Any Node.js 20+ machine: headless Linux
boxes, Raspberry Pis, home servers. See
**[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md)**.

## Documentation

| Page | Contents |
|------|----------|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Install, login, first steps, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Daemon internals, agentic loop, metrics pipeline |
| [docs/TOOLS.md](docs/TOOLS.md) | Tool-by-tool reference with examples |
| [docs/EXAMPLES.md](docs/EXAMPLES.md) | Automation recipes — cron, watchdogs, backups |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Cloud API, scheduling, boot persistence |
| [docs/FAQ.md](docs/FAQ.md) | Frequently asked questions |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [examples/](examples) | launchd & systemd units, health check script |

## Compliance & Trust

<a href="docs/COMPLIANCE.md"><img src="https://img.shields.io/badge/EU_CRA-ready-blue.svg" alt="EU Cyber Resilience Act ready"></a>
<a href="docs/COMPLIANCE.md"><img src="https://img.shields.io/badge/NIS2-aligned-blue.svg" alt="NIS2 aligned"></a>
<a href="docs/AI-ACT.md"><img src="https://img.shields.io/badge/EU_AI_Act-transparency_documented-blueviolet.svg" alt="EU AI Act transparency"></a>
<a href="docs/GDPR.md"><img src="https://img.shields.io/badge/GDPR-privacy_by_design-brightgreen.svg" alt="GDPR privacy by design"></a>
<a href="docs/SBOM.md"><img src="https://img.shields.io/badge/SBOM-CycloneDX_1.5-informational.svg" alt="SBOM CycloneDX 1.5"></a>

- **[EU Cyber Resilience Act](docs/COMPLIANCE.md)** — SBOM, vulnerability
  handling, secure by design, coordinated disclosure
- **[NIS2](docs/COMPLIANCE.md)** — TOMs, logging, incident support
- **[EU AI Act](docs/AI-ACT.md)** — limited-risk classification,
  transparency obligations implemented and documented
- **[GDPR](docs/GDPR.md)** — data minimisation, Art. 30 record, DPA-ready
- **[SBOM](docs/SBOM.md)** — CycloneDX 1.5, one runtime dependency
- **[Security policy](SECURITY.md)** — threat model, disclosure process, supported versions

## Community

 **Star the repo** if mona-agent is useful to you — it genuinely helps
others discover the project.

-  [GitHub Discussions](https://github.com/MONAEXPERT/agent/discussions) — ideas, questions, show & tell
-  [Issues](https://github.com/MONAEXPERT/agent/issues) — bugs and feature requests
-  [Hugging Face](https://huggingface.co/aiagentmona/mona-agent) — mirror of this repo
-  [agent.mona.expert](https://agent.mona.expert) — the cloud dashboard
-  [SECURITY.md](SECURITY.md) — responsible disclosure

## Development

```bash
git clone git@github.com:MONAEXPERT/agent.git
cd agent
npm install
npm test            # 26 tests, 9 suites
npm run gui         # run the dev build of the TUI
```

Requires Node.js ≥ 20. Plain modern JavaScript (ESM), no build step,
one runtime dependency — deliberately small.

## License

MIT — see [LICENSE](LICENSE). Free forever.

---

**[mona.expert](https://agent.mona.expert)** — one key, one brain, any
device. 


## Compliance & standards

Enterprise-ready documentation: [EU CRA readiness](docs/additional-documents/CRA-READINESS.md),
[ISO/IEC 27001 mapping](docs/additional-documents/ISO-27001-MAPPING.md),
[IEC 62443 alignment](docs/additional-documents/IEC-62443.md),
[threat model](docs/additional-documents/THREAT-MODEL.md),
[data flow & minimization](docs/additional-documents/DATA-FLOW.md),
[deployment guide](docs/additional-documents/DEPLOYMENT-GUIDE.md),
[enterprise FAQ](docs/additional-documents/ENTERPRISE-FAQ.md) and
[SBOM](docs/additional-documents/SBOM.md).
See [SECURITY.md](SECURITY.md) for vulnerability reporting.
