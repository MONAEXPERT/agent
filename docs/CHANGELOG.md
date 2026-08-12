# Changelog

All notable changes to the mona-agent client are documented here.
Format: [Keep a Changelog](https://keepachangelog.com), versioning:
[SemVer](https://semver.org).

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

[2.0.0]: https://github.com/MONAEXPERT/agent/releases/tag/v2.0.0
