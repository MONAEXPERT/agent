# Run remoteagent as a systemd user service on Linux

## Install

```bash
mkdir -p ~/.config/systemd/user
cp remoteagent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now remoteagent
```

## Useful commands

```bash
systemctl --user status remoteagent   # running? recent log lines
journalctl --user -u remoteagent -f   # follow the log
systemctl --user restart remoteagent  # restart after updates
```

## Uninstall

```bash
systemctl --user disable --now remoteagent
rm ~/.config/systemd/user/remoteagent.service
```

Requires `remoteagent` on your PATH (`~/.local/bin`, set by the installer)
and a systemd user session (standard on desktop distros).
