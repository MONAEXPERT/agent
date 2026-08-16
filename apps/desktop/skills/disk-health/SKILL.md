---
name: disk-health
description: Disk health check — flag volumes running out of space.
---

When asked to check disk space, storage, or disk health:
1. Run `df -h` via the shell tool (allowed command).
2. For every volume above 85% usage, explain what it is, how much is free,
   and give one concrete safe cleanup suggestion (never run it yourself —
   propose it and let the user decide).
3. Summarize: healthy volumes in one line, at-risk volumes in detail.
