# Getting Started with mona-agent

Install the mona-agent app on your device, log in with your mona.expert key, and
have your machine connected to the cloud in under a minute.

## 1. Prerequisites

- **Node.js 20 or newer** — check with `node -v`.
  - macOS: `brew install node`
  - Ubuntu/Debian: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install nodejs`
  - Windows: use [WSL2](https://learn.microsoft.com/windows/wsl/install) (native Windows Git Bash works too)
- An account + **API key** at [agent.mona.expert](https://agent.mona.expert/dashboard)  Settings.

## 2. Install

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
```

The installer:

- Downloads the agent from GitHub (`MONAEXPERT/agent`)
- Installs dependencies (`ws` only)
- Places the app in `~/.mona-agent/agent`
- Adds `mona-agent` to your PATH (via `~/.local/bin`, persisted in your shell rc)

## 3. Log in

```bash
mona-agent login
```

Paste your mona.expert API key when prompted. The key is stored in
`~/.mona-agent/credentials.json` (outside the agent install directory).

## 4. Connect and use

```bash
mona-agent gui                    # terminal dashboard with live log
mona-agent chat "free disk space" # one-shot conversation
mona-agent exec "uptime"          # run a single command
mona-agent start                  # headless background service (auto-reconnect)
```

## 5. See it in the browser

Open <https://agent.mona.expert/dashboard>. Your device appears with live
CPU, memory, disk and load — and a chat window connected to the cloud brain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `mona-agent: command not found` | Re-open your terminal, or run `export PATH="$HOME/.local/bin:$PATH"` |
| `Node.js 20+ required` | Upgrade Node (`brew upgrade node` / nodesource) |
| Agent connects but dashboard shows no device | Confirm you ran `mona-agent login` with the key from your account |
| Metrics stream, chat replies "No API key configured" | Add an AI provider key in the dashboard  Settings (the cloud brain needs one) |
| Firewall / corporate proxy | Set `MONA_CLOUD=https://agent.mona.expert` and check HTTPS egress |

## Uninstall

```bash
rm -rf ~/.mona-agent ~/.local/bin/mona-agent
# optional: remove the PATH line added to ~/.zshrc / ~/.bashrc / ~/.profile
```

## Next steps

- [TOOLS.md](TOOLS.md) — what the agent can do on your device
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the agent works under the hood
- [FAQ.md](FAQ.md) — common questions
- [SECURITY.md](../SECURITY.md) — security model & responsible disclosure
