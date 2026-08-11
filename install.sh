#!/usr/bin/env bash
# Easy install for Mona Agent.
# Usage:  curl -fsSL https://agent.mona.expert/install.sh | bash
set -euo pipefail

REPO="${MONA_REPO:-https://github.com/mona-expert/mona-agent.git}"
DIR="${MONA_DIR:-$HOME/.mona-agent-app}"

echo "→ Mona Agent installer"

command -v node >/dev/null 2>&1 || { echo "Node.js 18+ required. Install from https://nodejs.org"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node 18+ required (found $(node -v))"; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "→ Updating existing install in $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "→ Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
echo "→ Installing dependencies"
npm install --omit=dev --silent

# Link the CLI globally if possible.
if npm link >/dev/null 2>&1; then
  echo "→ Linked 'mona-agent' command globally"
else
  echo "→ Could not link globally; run via: node $DIR/bin/mona-agent.js"
fi

echo
echo "✓ Installed."
echo "  1) Log in:      mona-agent login"
echo "  2) Launch GUI:  cd $DIR && npm run gui   → http://localhost:4319"
echo
echo "No LLM keys are stored locally. All reasoning runs on agent.mona.expert."
