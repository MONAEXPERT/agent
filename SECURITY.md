# Security Policy

mona-agent is a client for the mona.expert cloud. This document describes
the client-side security model and how to report vulnerabilities.

## Supported versions

| Version | Supported |
|---|---|
| 2.x (current) | ✅ |
| < 2.0 | ❌ |

## Security model

- **No AI provider keys on the device.** The client stores only a
  mona.expert device token (`~/.mona-agent/credentials.json`, mode 0600).
  All third-party keys live in the cloud vault, AES-256 encrypted.
- **Guarded shell.** Commands run through an allowlist; dangerous patterns
  are rejected before execution.
- **Confined file tool.** Reads and writes are limited to safe roots;
  symlink escapes are refused.
- **Egress-only networking.** The daemon opens outbound connections only
  and listens on localhost exclusively (for the local dashboard). No
  inbound ports, no public exposure.
- **Metrics minimization.** Only system metrics and requested results are
  sent, only to the cloud endpoint you configured (`MONA_CLOUD`).
- **Transparent transport.** HTTPS with Bearer-auth; WebSocket upgrade when
  available, HTTPS polling fallback otherwise.

## Reporting a vulnerability

**Do not open a public issue for security bugs.**

Please report privately first so we can fix before disclosure:

1. Email: `security@mona.expert`
2. Include: affected version, steps to reproduce, impact, and (if you have
   it) a suggested fix.
3. We will acknowledge within 48 hours and aim to publish a fix + advisory
   within 14 days, crediting you if you wish.

### Disclosure policy

- 48 h — acknowledgment
- 14 days — fix + coordinated disclosure (extendable on request)

## Hall of fame

We appreciate all responsible disclosures. With your permission, we list
contributors here.
