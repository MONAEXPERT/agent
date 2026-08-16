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
| `allowlist` | Allowed command patterns (env `MONA_ALLOW_CMDS`, per-OS defaults) |
| `unsafe` | `true` only when `MONA_SHELL_UNSAFE=1` is explicitly set |
| `platform` | Detected OS (`darwin` / `linux` / `win32`) |

Blocked patterns (always denied): `rm -rf /`, `mkfs`, `dd if=`, fork bombs,
`sudo`, `shutdown`, `format C:`, `diskpart`, and friends — see
`src/tools/shell.js` for the full list.

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
