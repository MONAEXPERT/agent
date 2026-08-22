# Run mona-agent automatically on macOS

Install this LaunchAgent to start mona-agent when you log in and keep it
running (auto-restart on crash).

## Install

```bash
mkdir -p ~/Library/LaunchAgents
cp online.remoteagent.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/online.remoteagent.agent.plist
```

## Verify

```bash
launchctl list | grep monaexpert
mona-agent connect    # should report cloud reachable, key valid
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/online.remoteagent.agent.plist
rm ~/Library/LaunchAgents/online.remoteagent.agent.plist
```

Requires `mona-agent` on your PATH (`~/.local/bin`, set by the installer).
