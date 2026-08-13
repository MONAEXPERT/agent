#!/usr/bin/env bash
# ── mona-agent installer ──────────────────────────────────────────
# Usage: curl -fsSL https://agent.mona.expert/install.sh | bash
#
# Installs the agent to ~/.mona-agent/agent and puts a `mona-agent`
# command on your PATH (~/.local/bin). PATH is set for the current
# shell AND persisted in ~/.zshrc / ~/.bashrc / ~/.profile, so the
# command also works in every new terminal.
set -euo pipefail

REPO="${MONA_REPO:-MONAEXPERT/agent}"
BRANCH="${MONA_BRANCH:-main}"
INSTALL_DIR="${MONA_INSTALL_DIR:-$HOME/.mona-agent}"
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

echo ""
echo -e "  ${BOLD}${CYAN} mona-agent${RESET} installer"
echo -e "  ───────────────────────"
echo ""

# ── Platform ────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)                  PLATFORM="macOS" ;;
  Linux)                   PLATFORM="Linux" ;;
  MINGW*|MSYS*|CYGWIN*)    PLATFORM="Windows (Git Bash)" ;;
  *)                       PLATFORM="$OS" ;;
esac
echo -e "  Platform: ${BOLD}$PLATFORM${RESET} ($ARCH)"

# ── Prerequisites ───────────────────────────────────────────────
command -v node >/dev/null 2>&1 || {
  echo -e "  ${RED}${RESET} Node.js 20+ required — install from https://nodejs.org"
  exit 1
}
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "  ${RED}${RESET} Node.js 20+ required (found $(node -v))"
  exit 1
fi
echo -e "  ${GREEN}${RESET} Node.js $(node -v)  |  npm $(npm -v)"

# ── Download ────────────────────────────────────────────────────
echo -e "  ${DIM} Downloading ${REPO}@${BRANCH} from GitHub${RESET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
  | tar xz -C "$TMP_DIR" --strip-components=1

# ── Dependencies ────────────────────────────────────────────────
echo -e "  ${DIM} Installing dependencies${RESET}"
( cd "$TMP_DIR" && npm install --omit=dev --no-audit --no-fund --silent )

# ── Copy into place (clean replace; config lives outside agent/) ─
rm -rf "$INSTALL_DIR/agent"
mkdir -p "$INSTALL_DIR/agent"
cp -R "$TMP_DIR"/. "$INSTALL_DIR/agent/"
chmod +x "$INSTALL_DIR/agent/apps/desktop/bin/mona-agent.js"
# agent entrypoint used by the mona-agent command
chmod +x "$INSTALL_DIR/agent/apps/desktop/src/config.js" 2>/dev/null || true

# ── Symlink + PATH for the current shell ────────────────────────
BIN_DIR="$HOME/.local/bin"
if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
  BIN_DIR="$HOME/bin"
  mkdir -p "$BIN_DIR"
fi
ln -sf "$INSTALL_DIR/agent/apps/desktop/bin/mona-agent.js" "$BIN_DIR/mona-agent"
echo -e "  Symlink:   ${BOLD}$BIN_DIR/mona-agent${RESET}"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) export PATH="$BIN_DIR:$PATH" ;;
esac

# ── Persist PATH for future shells (idempotent) ─────────────────
BIN_REL="${BIN_DIR/#$HOME\//}"
rc_touched=""
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$rc" ] || continue
  # skip if the bin dir is already on PATH there, in any common form
  grep -qF "$BIN_DIR" "$rc" && continue
  grep -qF "\$HOME/$BIN_REL" "$rc" && continue
  grep -qF "~/$BIN_REL" "$rc" && continue
  printf '\n# added by mona-agent installer (keeps `mona-agent` on PATH)\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
  rc_touched="$rc_touched $rc"
  echo -e "  PATH:       added to ~${rc#$HOME}"
done
if [ -z "$rc_touched" ] && [ ! -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.profile" ]; then
  printf '\n# added by mona-agent installer (keeps `mona-agent` on PATH)\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$HOME/.profile"
  echo -e "  PATH:       created ~/.profile"
fi

echo ""
echo -e "  ${GREEN} mona-agent installed!${RESET}"
echo ""
echo -e "  ${BOLD}Enjoying mona-agent?${RESET}  Star us on GitHub:"
echo -e "  ${CYAN}https://github.com/MONAEXPERT/agent${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "  1. Get your API key:   ${CYAN}https://agent.mona.expert/dashboard${RESET}"
echo -e "  2. Login:              ${CYAN}mona-agent login${RESET}"
echo -e "  3. Dashboard:          ${CYAN}mona-agent gui${RESET}   ${DIM}(headless: mona-agent start)${RESET}"
echo ""
echo -e "  ${DIM}PATH was set for this shell too — 'mona-agent' works right now.${RESET}"
echo -e "  ${DIM}New terminals pick it up automatically.${RESET}"
echo ""
