#!/usr/bin/env bash
# ── mona-agent installer ──────────────────────────────────────────
# Usage: curl -fsSL https://agent.mona.expert/install.sh | bash
set -euo pipefail

REPO="${MONA_REPO:-https://github.com/MONAEXPERT/mona-agent.git}"
DIR="${MONA_DIR:-$HOME/.mona-agent-app}"
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

echo ""
echo -e "  ${BOLD}${CYAN}mona-agent${RESET} installer"
echo ""

# ── Check prerequisites ──────────────────────────────────────────
command -v node >/dev/null 2>&1 || {
  echo -e "  ${RED}✗${RESET} Node.js 20+ required. Install from https://nodejs.org"
  exit 1
}

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "  ${RED}✗${RESET} Node.js 20+ required (found $(node -v))"
  exit 1
fi

echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# ── Clone or update ──────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  echo -e "  ${DIM}→ Updating existing install in $DIR${RESET}"
  git -C "$DIR" pull --ff-only --quiet
else
  echo -e "  ${DIM}→ Cloning into $DIR${RESET}"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

cd "$DIR"

# ── Install dependencies ────────────────────────────────────────
echo -e "  ${DIM}→ Installing dependencies${RESET}"
npm install --omit=dev --silent 2>/dev/null

# ── Link CLI globally ───────────────────────────────────────────
if npm link --silent 2>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} Linked ${BOLD}mona-agent${RESET} command globally"
else
  echo -e "  ${DIM}→ Could not link globally; run via: node $DIR/bin/mona-agent.js${RESET}"
fi

echo ""
echo -e "  ${GREEN}✓${RESET} Installed."
echo ""
echo -e "  ${BOLD}Quick start:${RESET}"
echo ""
echo -e "    ${CYAN}mona-agent login${RESET}     ${DIM}# connect to your control plane${RESET}"
echo -e "    ${CYAN}mona-agent gui${RESET}       ${DIM}# terminal dashboard${RESET}"
echo -e "    ${CYAN}mona-agent start${RESET}     ${DIM}# headless daemon${RESET}"
echo ""
echo -e "  Free & open source (MIT). No LLM keys on your device."
echo -e "  SaaS control plane at ${BOLD}agent.mona.expert${RESET} (free tier available)."
echo ""
