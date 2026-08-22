# Contributing to remoteagent

Thanks for helping build the open-source client! This file tells you how to
set up, test and propose changes.

## Setup

```bash
git clone git@github.com:remoteagent-online/remoteagent.git
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
the agent loop, tool behavior, the TUI scrollback, and the security
red-team suite (`apps/desktop/test/security.test.mjs` — injection,
traversal, symlink/TOCTOU escapes, SSRF, audit-chain integrity, rate
limits). Please keep it green and add tests for new behavior — security
behavior in particular needs a test that proves it.

## Conventions

- Plain modern JavaScript, ES modules, no build step.
- Keep the runtime dependency count at **one** (`ws`). Prefer Node built-ins.
- `tools/shell` executes argv arrays against the allowlist — never weaken
  the guard to make a test pass, never reintroduce string-to-shell
  execution.
- Policy files, audit logs and presets are documented in `docs/TOOLS.md`
  and `docs/GETTING-STARTED.md` — keep them in sync when behaviour changes.
- Commits: `type(scope): summary` (feat, fix, docs, refactor, test), with a
  `Signed-off-by:` trailer (DCO — see below).
- The public repo contains **client code only**. Server-side code must not
  be committed here (SaaS boundary).

## Developer Certificate of Origin (DCO)

All contributions must be made under the Developer Certificate of Origin
version 1.1. Every commit must carry a `Signed-off-by:` trailer:

```
Signed-off-by: Name <email>
```

Use `git commit -s` to add it automatically. By adding the trailer you
certify the following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Pull requests

1. Fork, branch, implement, test.
2. `npm test` green.
3. Open a PR with a clear description of what/why.
4. One logical change per PR. Small is beautiful.
5. For security-sensitive changes, describe the trust boundary, policy impact, regression test, and any release/distribution considerations without including secrets or unpublished exploit details. Use `docs/SECURITY-REVIEW-SCOPE.md` for review planning.

## Community and release validation

Community reports should include the version/commit, platform, reproduction steps, expected versus actual behavior, and sanitized logs. Suspected vulnerabilities must follow [`SECURITY.md`](SECURITY.md), not a public issue. Maintainers use [`docs/RELEASE-DISTRIBUTION-CHECKLIST.md`](docs/RELEASE-DISTRIBUTION-CHECKLIST.md) when validating release artifacts and supported installation paths.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
