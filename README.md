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

# mona-agent — your computer, with a brain you control

<p align="center">
  <strong>The open-source AI agent for your own computer.<br/>
  Chat from anywhere — it runs commands, manages files, automates tasks.<br/>
  Every step is streamed to you. Nothing runs in the dark.</strong>
</p>

<p align="center">
  <a href="https://github.com/MONAEXPERT/agent/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js 20+"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL2-informational.svg" alt="Platforms: macOS, Linux, WSL2">
  <img src="https://img.shields.io/badge/api%20keys-on%20device-0-red.svg" alt="Zero API keys on device">
  <img src="https://img.shields.io/badge/control-via%20agent.mona.expert-blueviolet.svg" alt="Controlled via agent.mona.expert">
  <img src="https://img.shields.io/badge/privacy-AES--256%20vault-blue.svg" alt="Privacy: AES-256 vault">
</p>

## Why mona-agent

Most AI assistants live in a chat window. They can write you a script — but
they can't run it. They can explain a crash — but they can't look at your
logs.

**mona-agent is the other half.** A small, open-source app on your own
machine (macOS, Linux, WSL2) that connects to a brain in the cloud. You talk
to it from your dashboard; it reasons about the task, then *actually does
it*: checks disk space, restarts a service, finds a file, opens an app, runs
a cleanup — and streams every step back so you can watch it think and act in
real time.

## The five promises

1. **Saves you money.** Your AI keys live in one encrypted vault on
   agent.mona.expert — never on your devices. Tasks are routed to the
   cheapest model that can handle them (simple → cheap, complex → deep),
   with per-run token and cost traces. No wasteful loops, no hidden spend.
2. **Zero API keys on device.** The only thing stored locally is your
   agent.mona.expert token, in a `0600` file. No OpenAI, Anthropic or other
   provider keys ever touch your machine. Steal the laptop — you lose
   nothing but a revocable token.
3. **Fully transparent.** Every task streams: reasoning steps, tool calls,
   tool results, token usage, model, latency. Everything is recorded in an
   append-only audit trail on your control plane. You can always see *what*
   it did and *why*.
4. **Never loops silently.** The agent works in a bounded
   plan → act → reflect → verify loop. Every step emits progress
   (step N of M), every tool call is streamed, and when the step budget is
   reached it is forced to conclude with an answer. A task can never spin
   in the background without visible output.
5. **Yours, and only yours.** Control happens exclusively through your
   account at agent.mona.expert. Authenticated dashboard, per-user data
   isolation, CSRF-protected API, revocable device tokens, rate limits and
   a full audit trail. No third party, no backdoor, no telemetry.

## Quickstart — 60 seconds

```bash
# 1. Install the agent on your computer (macOS / Linux / WSL2)
curl -fsSL https://agent.mona.expert/install.sh | bash

# 2. Log in with a token from your dashboard (Devices → Generate token)
MONA_CLOUD=https://agent.mona.expert mona-agent login

# 3. Start it
mona-agent start        # or: mona-agent gui  (live terminal dashboard)
```

Then open **https://agent.mona.expert/mona** — build an agent, chat with it,
schedule it (cron), watch it work on your device, and revoke access any time
with one click.

## What it can do

| Capability | How |
|---|---|
| Run commands | guarded, argv-based shell — every executable allowlisted, no string-to-shell, env scrubbed |
| Manage files | sandboxed workspace — path-traversal, symlink and TOCTOU escapes rejected; deletes go to trash |
| Web research | search + page fetch (no API key needed) |
| Launch apps | open/quit desktop applications |
| Browser | open URLs / run searches in your default browser |
| Persistent memory | remembers across tasks and restarts |
| Notifications | desktop alerts (macOS / Linux / Windows) |
| Schedule runs | cron-style tasks from the dashboard |
| Multi-device | agents claim tasks per device — never executed twice |

## How it stays safe

- **Sandboxed tools** — files are confined to a workspace (boundary-checked,
  symlink- and TOCTOU-guarded, 1 MB write cap); the shell is argv-based
  with a realpath-resolved allowlist and always-blocked patterns (`sudo`,
  `rm -rf /`, `mkfs`, pipe-to-shell downloads, …); the network tool is
  SSRF-safe (private ranges and cloud metadata unreachable); every policy
  decision lands in a hash-chained audit log.
- **Egress-only networking** — the agent reaches out to your control plane;
  nothing listens for inbound connections.
- **Revocable access** — one click in the dashboard kills a device's token.
- **Open source** — read every line; the code is the security documentation.
- **Bounded work** — step limits, corrective nudges and forced conclusions
  mean no infinite loops, no silent hangs.

## Architecture

```
┌──────────────┐   WSS / SSE    ┌───────────────────────────────┐
│  your device │ ◄────────────► │  agent.mona.expert            │
│  mona-agent  │   tasks+steps  │  dashboard · API · vault      │
│  (sandbox)   │                │  AES-256 encrypted AI keys    │
└──────────────┘                │  cron runner · audit trail    │
                                └───────────────────────────────┘
```

- `apps/desktop` — the device agent (daemon, tools, terminal UI). It is thin
  on purpose: it supplies the cloud brain, the tools and the trace plumbing.
- `packages/engine` — the agent core: bounded plan → act → reflect → answer
  loop with policy-as-code, a budget governor (cheap-first degradation) and
  structured memory. Zero dependencies, tested offline.
- `packages/protocol` — the wire contract (versioned envelopes, message
  types, close codes) shared by the daemon and the gateway.
- `docs/` — architecture, compliance (GDPR, CRA, ISO 27001, IEC 62443),
  threat model, tool reference, changelog

Every loop guarantee lives in the engine and is tested once: policy checks
before each tool call, corrective nudges on malformed replies, forced
conclusion at the step limit (never hangs), and budget steering that shifts
to cheaper reasoning profiles as daily caps approach. Every step — think,
tool call, result, denial, profile switch — is streamed to your dashboard
and recorded in the audit trail.

## Documentation

- [Getting started](docs/GETTING-STARTED.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Tools reference](docs/TOOLS.md)
- [Compliance & trust](docs/COMPLIANCE.md)
- [Changelog](docs/CHANGELOG.md)
- [FAQ](docs/FAQ.md)

## License

MIT — free to read, fork and run. Your machine, your data, your keys.
