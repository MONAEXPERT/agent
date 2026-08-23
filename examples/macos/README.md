# Run remoteagent automatically on macOS

Install this LaunchAgent to start remoteagent when you log in and keep it
running (auto-restart on crash).

## Install

```bash
mkdir -p ~/Library/LaunchAgents
cp online.remoteagent.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/online.remoteagent.agent.plist
```

## Verify

```bash
launchctl list | grep remoteagent
remoteagent connect    # should report cloud reachable, key valid
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/online.remoteagent.agent.plist
rm ~/Library/LaunchAgents/online.remoteagent.agent.plist
```

Requires `remoteagent` on your PATH (`~/.local/bin`, set by the installer).
