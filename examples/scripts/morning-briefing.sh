#!/usr/bin/env bash
# morning-briefing.sh — the 8am briefing recipe.
#
# Schedule with cron (or the dashboard's cron tasks):
#   0 8 * * * /path/to/remoteagent/examples/scripts/morning-briefing.sh
#
# The briefing skill gathers headlines and system health, then the agent
# summarizes them. Read-only: no writes, no deletes.
set -euo pipefail

if ! command -v remoteagent >/dev/null 2>&1; then
  echo "morning-briefing: remoteagent not found on PATH" >&2
  exit 1
fi

remoteagent chat "Run the briefing skill: today's headlines, this machine's health (disk-health skill), and a one-line plan for the day."
