# Contributing to mona-agent

Thanks for helping build the open-source client! This file tells you how to
set up, test and propose changes.

## Setup

```bash
git clone git@github.com:MONAEXPERT/agent.git
cd agent
npm install
```

Requirements: Node.js ≥ 20, npm ≥ 9. No build step — plain ESM.

## Layout

```
apps/desktop/     the device agent (CLI, daemon, TUI, tools, tests)
packages/engine/  cloud-brain client (self-contained)
packages/protocol/ typed message schemas
docs/             user + architecture docs
```

## Testing

```bash
npm test
```

The suite covers the control channel (against a fake in-process server),
the agent loop, tool behavior and the TUI scrollback. Please keep it green
and add tests for new behavior.

## Conventions

- Plain modern JavaScript, ES modules, no build step.
- Keep the runtime dependency count at **one** (`ws`). Prefer Node built-ins.
- Commands executed by `tools/shell` must pass the guard allowlist — never
  weaken the guard to make a test pass.
- Commits: `type(scope): summary` (feat, fix, docs, refactor, test).
- The public repo contains **client code only**. Server-side code must not
  be committed here (SaaS boundary).

## Pull requests

1. Fork, branch, implement, test.
2. `npm test` green.
3. Open a PR with a clear description of what/why.
4. One logical change per PR. Small is beautiful.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
