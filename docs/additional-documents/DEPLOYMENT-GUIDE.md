# Enterprise Deployment Guide

Production rollout for the mona-agent client on macOS, Linux and Windows.

## 1. Provisioning flow

1. Create the user's account and agent in the dashboard.
2. Generate a device token (Settings → Mona key).
3. On the device: install Node.js ≥ 20, then
   `curl -fsSL https://agent.mona.expert/install.sh | bash`
   followed by `mona-agent login` with the token.
4. Start the daemon. Verify the dashboard shows the device online.

## 2. Persistent service (recommended)

**macOS (launchd)** — `~/Library/LaunchAgents/com.mona.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mona.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/agent/apps/desktop/bin/mona-agent.js</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mona-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/mona-agent.log</string>
</dict>
</plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.mona.agent.plist`.

**Linux (systemd)** — `/etc/systemd/system/mona-agent.service`:

```ini
[Unit]
Description=mona-agent device daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mona
ExecStart=/usr/bin/node /opt/mona-agent/apps/desktop/bin/mona-agent.js start
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## 3. Network policy

- Outbound: TCP 443 to the cloud endpoint only (the daemon).
- The cloud makes the LLM provider calls, not the device.
- No inbound rules. No WebSocket relay required (HTTPS polling fallback).

## 4. Update policy

- Track release tags on GitHub; review the CHANGELOG.
- Rolling update: stop the daemon, update the client directory, start the
  daemon. In-flight tasks expire safely (no replay).

## 5. Hardening checklist

- Run the daemon as a dedicated, unprivileged OS user.
- Restrict the shell allowlist if the device performs sensitive work.
- Keep the credentials file owner-readable (`chmod 600`).
- Point logs at your log rotation (launchd/systemd examples above).
- Monitor the live event stream for `llm:error` and rate-limit events.

## 6. Capacity notes

- The daemon is idle-light: polling every 2 s, metrics every 10 s.
- Reasoning cost is per task and visible in the dashboard (Insights tab).
- Auto brain mode balances depth against cost per task automatically.
