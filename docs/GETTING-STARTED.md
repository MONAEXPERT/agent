# Getting Started with remoteagent

Install the remoteagent app on your device, log in with your remoteagent.online key, and
have your machine connected to the cloud in under a minute.

## Recommended for unknown environments: Docker

The container is the strongest default because it stacks three independent
layers of containment: read-only rootfs, `cap_drop: [ALL]` +
`no-new-privileges`, and tmpfs `/tmp` — the agent process cannot gain
privileges even if compromised. Prefer it whenever Docker is available and
you do not need the agent to manage the host machine itself.

```bash
git clone https://github.com/remoteagent-online/remoteagent.git
cd agent
docker compose up -d --build
docker compose logs -f remoteagent
```

Then log in inside the container:

```bash
docker compose exec remoteagent remoteagent login
```

## 1. Native install — prerequisites

- **Node.js 20 or newer** — check with `node -v`.
  - macOS: `brew install node`
  - Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install nodejs`
  - Windows: use [WSL2](https://learn.microsoft.com/windows/wsl/install) (native Windows Git Bash works too)
- An account + **API key** at [api.remoteagent.online](https://app.remoteagent.online/dashboard)  Settings.
- **OS sandbox (recommended; required for mode `full`):**
  - Linux: `bwrap` (`apt install bubblewrap` / `dnf install bubblewrap` /
    `pacman -S bubblewrap`). Without it the agent runs with the path
    deny-list only and `remoteagent doctor` reports the degraded state.
  - macOS: `sandbox-exec` ships with the OS (deprecated by Apple, still
    functional).
  - Windows: no OS sandbox equivalent — the path deny-list stays active;
    see `docs/WINDOWS.md`.

## 2. Install (native)

```bash
curl -fsSL https://remoteagent.online/install.sh | bash
```

The installer:

- Downloads the agent from GitHub (`remoteagent-online/remoteagent`)
- Installs dependencies (`ws` only)
- Places the app in `~/.mona-agent/agent`
- Adds `remoteagent` to your PATH (via `~/.local/bin`, persisted in your shell rc)

## 3. Log in

```bash
remoteagent login
```

Paste your remoteagent.online API key when prompted. The key is stored in
`~/.mona-agent/credentials.json` (outside the agent install directory).

## 4. Connect and use

```bash
remoteagent gui                    # terminal dashboard with live log
remoteagent chat "free disk space" # one-shot conversation
remoteagent exec shell cmd=uptime  # run a single allowed command
remoteagent start                  # headless background service (auto-reconnect)
```

### Capability dial: from zero skills to full daemon

Pick how much power the agent gets on this device:

```bash
remoteagent mode list              # minimal · standard · full
remoteagent mode show              # current mode + effective policy
remoteagent mode set minimal       # read-only: no skills, no shell, no network writes
remoteagent mode set standard      # balanced: core skills, shell/browser need approval
remoteagent mode set full          # everything on + auto-start daemon
```

Setting a mode writes `~/.mona-agent/policy.json` (the device-side authority),
enables/disables the matching skills and — in `full` — installs the background
service so the agent starts on login and restarts on crash (launchd on macOS,
systemd on Linux):

```bash
remoteagent daemon status          # service + pid state
remoteagent daemon install         # enable auto-start on login
remoteagent daemon uninstall       # stop + remove the service
remoteagent skills list            # installed skills + enabled state
```

Only one daemon can run per device: `remoteagent start` refuses to double-run
(see `~/.mona-agent/daemon.pid`), and `start --force` is only for crash recovery.

## 5. Security defaults (v2.8+)

- **Shell** — commands are parsed into argv arrays and executed without a
  shell; every executable must be on the allowlist (realpath-checked).
  Chains (`&&`, `;`, pipes) re-check every segment; `sudo`, redirects,
  `$(...)` and backticks are rejected. To run other commands, extend
  `MONA_ALLOW_CMDS` (comma-separated) or set `{"shell": {"unsafe": true}}`
  in `~/.mona-agent/policy.json` (audited).
- **Network** — SSRF-safe: private ranges, loopback and cloud metadata are
  unreachable, redirects are re-validated per hop.
- **Files** — confined to the workspace; deletes move to trash.
- **Policy** — every tool call is checked against `~/.mona-agent/policy.json`
  (allow / deny / confirm / rate limits). The control plane can never widen
  it. Apply a preset:

```bash
remoteagent policy preset strict      # read-only agent
remoteagent policy preset standard    # shell/browser need approval
remoteagent policy status             # what's currently allowed
remoteagent policy explain shell cmd=df  # why a call is allowed/denied
```

- **Audit** — every decision is written to a tamper-evident, hash-chained
  log. Verify it anytime:

```bash
remoteagent audit tail                # recent decisions
remoteagent audit verify              # detect tampering
```

## 6. See it in the browser

Open <https://app.remoteagent.online/dashboard>. Your device appears with live
CPU, memory, disk and load — and a chat window connected to the cloud brain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `remoteagent: command not found` | Re-open your terminal, or run `export PATH="$HOME/.local/bin:$PATH"` |
| `Node.js 20+ required` | Upgrade Node (`brew upgrade node` / nodesource) |
| Agent connects but dashboard shows no device | Confirm you ran `remoteagent login` with the key from your account |
| Metrics stream, chat replies "No API key configured" | Add an AI provider key in the dashboard  Settings (the cloud brain needs one) |
| Firewall / corporate proxy | Set `MONA_CLOUD=https://api.remoteagent.online` and check HTTPS egress |

## Bring your own LLM (BYO keys)

Since v2.10.1 the brain can run on-device with **your** keys instead of
the cloud vault — prompts never leave the machine.

```bash
remoteagent provider set anthropic                          # asks for the key
remoteagent provider set openai --model gpt-4o-mini
remoteagent provider set openai --url http://localhost:1234/v1 --model llama-3   # LM Studio / vLLM
remoteagent provider set ollama --model llama3.2            # fully offline, $0
remoteagent provider test                                   # one-shot smoke test
MONA_TRANSPORT=local remoteagent start                      # local brain only, fail-fast
```

Config lives in `~/.mona-agent/provider.json` (0600, never sent to the
cloud). BYO tokens are priced locally so the budget governor and cost
traces keep working — see `remoteagent provider status`. Templates:
[examples/providers](../examples/providers/README.md).

## MCP — expose the tools to other agents

`remoteagent mcp` serves the tool registry to any Model Context Protocol
client over stdio. Every call passes the local policy gate.

## Uninstall

```bash
rm -rf ~/.mona-agent ~/.local/bin/remoteagent
# optional: remove the PATH line added to ~/.zshrc / ~/.bashrc / ~/.profile
```

## Next steps

- [TOOLS.md](TOOLS.md) — what the agent can do on your device
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the agent works under the hood
- [FAQ.md](FAQ.md) — common questions
- [SECURITY.md](../SECURITY.md) — security model & responsible disclosure
