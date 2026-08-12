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

## Adding your own tool

Tools live in `apps/desktop/src/tools/` and are plain ES modules. Each tool
exposes a `run(action, args)` and registers itself in
`src/tools/index.js`. Keep the same rules: validate input, never execute
untrusted data, and always stream results.
