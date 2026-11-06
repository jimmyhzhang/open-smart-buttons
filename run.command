#!/bin/bash
# Double-click to start StreamDeckPlus after setup.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
echo "== StreamDeckPlus =="
if ! command -v node >/dev/null; then
  echo "Node.js is not installed. Install Node 22.18 or later (https://nodejs.org or 'brew install node') and run this again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
echo "node $(node --version)"
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "StreamDeckPlus needs Node 22.18 or later (found $(node --version)). Upgrade Node and run this again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi

if [ ! -d node_modules ] || [ ! -f ui/dist/index.html ]; then
  echo "Run npm ci and npm run build:ui to set up the editor, then launch it again."
  exit 1
fi

exec node src/server/main.ts --open "$@"
