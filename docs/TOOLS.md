# Tools Reference

The built-in tools give the cloud agent real hands on your machine. Each tool
runs in a sandbox with clear boundaries.

## files

File operations confined to safe paths.

| Operation | Notes |
|---|---|
| `list` | Directory listing with sizes and mtimes |
| `read` | Read text files (size-capped) |
| `write` | Write text files (atomic) |
| `move` / `delete` | Rename / remove within allowed paths |

**Safety:** the tool refuses to touch paths outside the allowed roots
(home, workspace, temp). Symlink escapes are rejected.

## shell

A guarded, allowlisted command shell.

- Commands run through an allowlist of safe patterns (`ls`, `cat`, `df`,
  `uptime`, …); anything matching a dangerous pattern (`rm -rf /`,
  fork bombs, `sudo` without confirmation) is **blocked before execution**.
- Output is streamed back line-buffered, so the dashboard log feels live.
- Each execution is logged and attached to the audit trail in the cloud.

Example the agent might run:

```bash
df -h / && du -sh ~/Downloads | sort -h | tail -5
```

## net

Network helpers for connectivity checks and HTTP.

| Helper | Use |
|---|---|
| `http` | GET/POST JSON requests (outbound only) |
| `ping` / `reachable` | Host / port reachability |
| `dns` | DNS lookups |
| `wake` | (LAN) wake-on-LAN helper, where supported |

Used by the cloud agent for health checks, webhooks and diagnostics.

## sysinfo

System metrics for the live device dashboard.

| Metric | Snapshot interval |
|---|---|
| CPU usage % | every 10 s |
| Load average (1/5/15) | every 10 s |
| Memory total / used / % | every 10 s |
| Disk usage % | every 10 s |
| Uptime | every 10 s |
| Hostname, platform, arch, CPU model, cores, version, IP | on connect |

The cloud keeps the latest snapshot plus a rolling 180-point history per
device and renders sparklines for CPU and memory in the dashboard.

## apps

Launch or quit desktop applications on the host OS.

| Action | Behaviour |
|---|---|
| `open` | macOS: `open -a`; Linux: `gtk-launch` / `xdg-open`; Windows: `start` |
| `quit` | macOS: `osascript`; Linux: `pkill`; Windows: `taskkill` |

- App names are sanitized (letters, digits, spaces, `.`, `_`, `-` only).
- Commands run with an 8 s timeout; output is capped (2 KB stdout / 1 KB stderr).
- Unsupported platforms return a clear error instead of guessing.

## browser

Open URLs or run web searches in the default browser.

| Action | Behaviour |
|---|---|
| `open` | Opens a URL — only `http:`/`https:` accepted, everything else rejected |
| `search` | Builds a search URL (`site`: `web` → Bing, `google`, `youtube`) |
| `watch` | Opens a URL for viewing (video/streaming) |

- Queries are URL-encoded and capped at 300 chars.
- No browser automation — it opens the user's real default browser.

## memory

Persistent memory across tasks and restarts — plain markdown files under
`~/.mona-agent/memory/` (override with `MONA_MEMORY_DIR`), one file per day.

| Action | Behaviour |
|---|---|
| `remember` | Appends a timestamped note (max 4000 chars) to today's file |
| `recall` | Searches notes for a query |
| `list` | Lists recent note files |

The cloud brain loads these notes at task start (persistent memory injection)
and can update them, so the agent gets smarter with each task.

## security

The shell's security posture, advertised to the cloud in the `hello` handshake
so the control plane can enforce `agent_permissions` without probing:

| Field | Meaning |
|---|---|
| `allowlist` | Allowed command names (env `MONA_ALLOW_CMDS`, per-OS defaults) |
| `unsafe` | `true` only when policy `shell.unsafe` is set (or deprecated `MONA_SHELL_UNSAFE=1`) |
| `platform` | Detected OS (`darwin` / `linux` / `win32`) |
| `mode` | `argv` — commands execute as argv arrays, never as a shell string |

Execution model (v2.8+):

- Commands are parsed quote-aware into argv arrays; `&&`, `||`, `;` chains
  and `|` pipes are supported, and EVERY segment's executable must pass the
  allowlist (pipe-to-shell is structurally impossible — `sh`/`bash` are not
  allowlisted).
- Executables are resolved to their realpath before execution.
- Redirects (`>`, `<`), command substitution (`$()`, backticks) and
  env-assignment prefixes are rejected with a clear error.
- The child environment is scrubbed to `PATH/HOME/LANG` (+ a few safe
  vars); only `$HOME`, `$PATH`, `$USER`, `$LANG`, `$PWD`, `$TMPDIR` expand.
- Timeouts kill the whole process group; output is capped at 64 KB per
  stream (8 KB returned in tool results).
- `MONA_SHELL_UNSAFE=1` is deprecated — set
  `{"shell": {"unsafe": true}}` in `~/.mona-agent/policy.json` instead.

Blocked patterns (defence-in-depth, always denied): `rm -rf /`, `mkfs`,
`dd if=`, fork bombs, `sudo`, `shutdown`, `format C:`, `diskpart`, and
friends — see `src/tools/shell.js` for the full list.

## net

SSRF-safe HTTP(S) fetch (v2.8+):

- DNS is resolved by the agent; every address must pass the blocked-range
  check (loopback, private, link-local, metadata, CGNAT, reserved, IPv6
  equivalents) — DNS rebinding cannot walk past it.
- Connections go to the validated IP with the real Host header and TLS SNI.
- Redirects are re-validated on every hop, max 5.
- Cloud metadata endpoints are blocked by name (`metadata.google.internal`,
  …) and by IP (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`).
- Response size is capped (50 KB for the tool) and read as a bounded stream
  — no decompression bombs. No env bypass exists.

## web

Web research — pure Node, no external dependencies, multi-OS.

- `ddgSearch(query, max = 8)` — DuckDuckGo HTML search (no API key), returns
  `[{title, url, snippet}]` with real targets extracted from redirect links.
- `fetch` page → `htmlToText()` — strips scripts/styles/tags, decodes HTML
  entities, caps output at 10 KB.
- 15 s timeout per request, honest `mona-agent/2.x` user agent.

## notify

Desktop notifications — lets the agent surface alerts on your screen.

| Platform | Mechanism |
|---|---|
| macOS | `osascript` `display notification` |
| Linux | `notify-send` (fails silently if absent) |
| Windows | `msg` via PowerShell |

- Titles are capped at 100 chars, bodies at 300.
- All shell metacharacters (`"`, `'`, `\`, backtick) are stripped before the
  command is built — notification text can never escape into the shell.
- Unsupported platforms return a clear error instead of guessing.

## Adding your own tool

Tools live in `apps/desktop/src/tools/` and are plain ES modules. Each tool
exposes a `run(action, args)` and registers itself in
`src/tools/index.js`. Keep the same rules: validate input, never execute
untrusted data, and always stream results.

## Skills

Skills are user-enableable capability packs (a `SKILL.md` with instructions
plus optional `tools/*.mjs` helper tools) installed into
`~/.mona-agent/skills/`. The bundled ones ship with the agent:

```bash
mona-agent skills list          # installed skills + enabled state
mona-agent skills install       # install the bundled skills (idempotent)
mona-agent skills enable <name> # inject its instructions into the brain
mona-agent skills disable <name>
```

### Capability dial (mode)

Instead of tuning skills and policy by hand, set a profile:

```bash
mona-agent mode list
mona-agent mode set minimal   # no skills, strict policy (read-only)
mona-agent mode set standard  # core skills, shell/browser need approval
mona-agent mode set full      # all skills, permissive policy + auto-start daemon
```

`mode set` writes `~/.mona-agent/policy.json`, enables exactly the mode's
skills and — for `full` — marks the daemon for auto-start.

### Daemon (background service)

```bash
mona-agent daemon status      # service + pid state
mona-agent daemon install     # launchd (macOS) / systemd (Linux) auto-start
mona-agent daemon uninstall   # stop + remove
mona-agent daemon stop        # signal the running daemon to exit
```

Single-instance: `~/.mona-agent/daemon.pid` guards against double-run; stale
pid files (after a crash) are cleaned automatically.

Enabled skills' instructions are injected into the agent's context, and their
tools become callable through the same registry as the built-ins.

## Policy (engine)

The engine checks every tool call against a policy before executing it —
and the tool registry enforces the same policy for direct commands
(`mona-agent exec`, dashboard tool calls). Defaults are safe (all built-in
tools allowed, destructive shell patterns blocked); an optional
`~/.mona-agent/policy.json` (or `MONA_POLICY`) tunes it:

```json
{
  "version": 1,
  "tools":     { "shell": "confirm", "web": "deny" },
  "shell":     { "deny": ["git\\s+push"], "unsafe": false },
  "rateLimits": { "shell": { "perMinute": 20 }, "*": { "perMinute": 300 } },
  "budget":    { "dailyTokens": 500000, "dailyCostUsd": 2 },
  "maxSteps":  12,
  "audit":     true
}
```

- `tools`: per-tool tier — `allow` | `deny` | `confirm` (unknown tools are
  default-denied)
- `shell.deny`: extra regex patterns (blocked); `shell.unsafe: true`
  enables unrestricted argv execution (audited — replaces the deprecated
  `MONA_SHELL_UNSAFE=1` env flag); legacy `approval.patterns` still works
- `rateLimits`: per-tool sliding per-minute window (`*` = default for all)
- `budget`: daily caps; `0` = unlimited. Levels degrade automatically:
  normal → eco (cheap profile) → critical (minimal) → exhausted (no tasks)
- `maxSteps`: 2–16 (default 8)
- `audit`: `false` disables the decision log (not recommended)

Presets (write one to `~/.mona-agent/policy.json`):

```bash
mona-agent policy preset strict      # read-only: shell/net/browser/apps denied
mona-agent policy preset standard    # shell & browser need approval, rate limits
mona-agent policy preset permissive  # everything allowed (default behaviour)
mona-agent policy status             # show the active policy + tool tiers
mona-agent policy explain <tool>     # show which rule decides a call
```

The policy file is **local and authoritative** — it loads from disk at
startup and the control plane can never modify or widen it.

## Audit log (engine)

Every policy decision (tool call, shell check, rate-limit denial) is
appended to `~/.mona-agent/audit.jsonl` (0600) as a hash-chained,
append-only JSONL stream — `h_n = sha256(h_{n-1} || entry)`. Tampering
breaks the chain:

```bash
mona-agent audit tail      # last 20 decisions
mona-agent audit verify    # verify the whole chain (exit 1 on tampering)
```

## Budget (engine)

Daily token/cost usage is recorded in `~/.mona-agent/budget.json` (0600) and
survives restarts. When a cap is hit the daemon answers new tasks with a
clear message instead of burning spend — and the dashboard shows the level
in the device stats.

## Memory store (engine)

Alongside the markdown memory tool, the engine keeps a structured store
(`~/.mona-agent/memory-store.json`): deduplicated near-identical entries,
TTL expiry (30 days default), capped at 500 entries, and scored recall. The
daemon auto-remembers finished tasks and recalls them into future prompts.
