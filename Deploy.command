#!/bin/bash
# Double-click this file in Finder to publish CoinVantage.
#
# It has to run on macOS rather than from Claude: the push needs the GitHub
# login in your keychain, and the backend step needs the Supabase CLI — neither
# exists in the sandbox Claude's shell runs in.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "=== Running tests ==="
if ! node --test tests/core.test.mjs 2>&1 | tail -6; then
  echo; echo "Tests failed — nothing was deployed."; read -r -p "Press Return to close."; exit 1
fi

echo; echo "=== Publishing the site ==="
bash tools/deploy-push.sh || { echo; echo "Push failed."; read -r -p "Press Return to close."; exit 1; }

echo; echo "=== Publishing the backend ==="
bash tools/deploy-backend.sh || { echo; echo "Backend deploy failed (the site is already live)."; read -r -p "Press Return to close."; exit 1; }

echo; echo "Done. Live at https://umer-78.github.io/coinvantage/"
read -r -p "Press Return to close."
