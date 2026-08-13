# Frequently Asked Questions

## What is mona-agent?

An open-source AI agent daemon for macOS, Linux and WSL2. It connects your
machine to the mona.expert cloud, executes local tools on your behalf, and
streams live metrics to your dashboard.

## Is mona-agent free?

Yes — MIT licensed, free forever. The [mona.expert](https://agent.mona.expert)
cloud has a free tier.

## Does mona-agent need an API key?

It needs **one key**: your mona.expert device token (created in the
dashboard  Settings). AI provider keys (OpenAI, Anthropic, …) live only in
the cloud vault — never on your device.

## Where is my key stored?

`~/.mona-agent/credentials.json`, with restrictive permissions, outside the
install directory (which can be wiped and reinstalled safely).

## What does mona-agent send to the cloud?

Only to the cloud you are logged into:

- device metrics (CPU, memory, disk, load, uptime, host info)
- results of commands/tools the cloud agent asked for
- chat messages you send from the dashboard

Nothing is sent to third parties. Full details: [SECURITY.md](../SECURITY.md).

## Does the device need a public IP or open ports?

No. The daemon opens **outbound** connections only. It works behind NAT,
firewalls and CGNAT. It listens on localhost only (for the local dashboard).

## Can I run mona-agent on a server / Raspberry Pi?

Yes — any Node.js 20+ machine. Headless mode: `mona-agent start` (or a
systemd unit). Small footprint, one runtime dependency.

## Does it work on Windows?

In WSL2 or Git Bash, yes. Native PowerShell is not a target today.

## How do I update mona-agent?

```bash
curl -fsSL https://agent.mona.expert/install.sh | bash
```

The installer replaces the agent in place; your credentials are untouched.

## How do I uninstall?

```bash
rm -rf ~/.mona-agent ~/.local/bin/mona-agent
```

## Why does my dashboard show my device as offline?

The device is marked online when its last metrics snapshot is ≤ 20 seconds
old. Check `mona-agent start` is running and that the device has HTTPS
egress to agent.mona.expert.

## Can the agent damage my machine?

The tool sandbox blocks dangerous patterns before execution, the files tool
is confined to safe paths, and every action is recorded in the cloud audit
log. Treat the agent like any other user with shell access: grant what you
trust.

## Where do I report bugs or security issues?

Bugs: [GitHub issues](https://github.com/MONAEXPERT/agent/issues).
Security: [SECURITY.md](../SECURITY.md) (private disclosure first).
