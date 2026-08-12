# Examples & Recipes

Real things people do with mona-agent. Copy, adapt, enjoy.

## Check on your machine from your phone

1. `mona-agent start` on the machine (or install the launchd/systemd unit
   from [examples/](../examples)).
2. Open <https://agent.mona.expert/dashboard> on your phone.
3. Chat: *"How's the disk looking?"* — the agent reads `df -h`, and the
   dashboard shows live CPU/memory sparklines.

## Morning briefing with cron

Get a daily summary of your home server in your dashboard before coffee:

```cron
# ~/.config/cron.d/mona (or: crontab -e)
30 7 * * *  $HOME/.local/bin/mona-agent chat "Summarize disk usage, uptime and any failed systemd units."
```

The reply lands in the dashboard chat history, timestamped.

## Watchdog — alert when a service dies

Ask the agent every 10 minutes; it pings the service and only reports
problems (the cloud keeps the conversation context):

```cron
*/10 * * * *  $HOME/.local/bin/mona-agent chat "Check nginx is answering on :80. Only reply if something is wrong."
```

## Nightly log cleanup

```cron
10 3 * * *  $HOME/.local/bin/mona-agent exec "find ~/logs -name '*.log' -mtime +14 -delete && echo cleaned"
```

## Health check from any shell

```bash
mona-agent connect          # force a connection test: health, auth, agents
```

`connect` reports cloud reachability, key validity and the agent list —
ideal for install verification and support tickets.

## Drive a script from the dashboard

Anything you can put in a script, the agent can run it for you:

```bash
#!/usr/bin/env bash
# backup.sh — daily offsite backup, called from the dashboard chat
tar czf - ~/projects | gpg -c --batch --passphrase-file ~/.backup-pass -o /mnt/backup/projects.tgz.gpg
```

Say *"run backup.sh"* in the chat; the guarded shell executes it and
streams the result back to your browser.

## Headless Raspberry Pi companion

The agent runs on any Node.js 20+ box:

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
mona-agent login
mona-agent start          # survives reboots via the systemd unit in examples/
```

Then manage the Pi from the dashboard: temperature, storage, running
services — with live metrics and chat.

## More

- [INTEGRATIONS.md](INTEGRATIONS.md) — the cloud REST API and scheduling
- [TOOLS.md](TOOLS.md) — the built-in tool sandbox
- [examples/](../examples) — launchd & systemd units, health check script
