#!/usr/bin/env bash
# Deploy when the repo and Pages already exist and the GitHub CLI is not on PATH.
# Stamps the build into version.txt, js/app.js and sw.js so the running app
# reloads itself, then commits and pushes. No repo or Pages API calls, so no gh.
#
#   bash tools/deploy-push.sh                  # default commit message
#   bash tools/deploy-push.sh "my message"     # your own commit message
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-Site-wide audit fixes: honest accuracy reporting, currency handling, language switcher removed}"
BRANCH="main"
SITE="https://umer-78.github.io/coinvantage/"

# macOS ships git as an Xcode command-line-tools shim that refuses to run until
# the Xcode licence is accepted. Catch that here rather than after stamping a
# build, so a blocked run leaves the tree untouched.
if ! git --version >/dev/null 2>&1; then
  echo "git will not run on this Mac yet."
  echo
  echo "macOS is holding it behind the Xcode licence. Accept it once:"
  echo
  echo "    sudo xcodebuild -license accept"
  echo
  echo "It asks for your Mac password (nothing is shown as you type). Then re-run this script."
  exit 1
fi

node tools/build-sitemap.mjs "$SITE"
BUILD="$(date -u +%Y%m%d-%H%M%S)"
printf '%s\n' "$BUILD" > version.txt
node -e '
  const fs = require("fs");
  const b = process.argv[1];
  const app = fs.readFileSync("js/app.js", "utf8").replace(/^export const BUILD = .*$/m, `export const BUILD = ${JSON.stringify(b)};`);
  fs.writeFileSync("js/app.js", app);
  const sw = fs.readFileSync("sw.js", "utf8").replace(/^const VERSION = .*$/m, `const VERSION = ${JSON.stringify("cv-" + b)};`);
  fs.writeFileSync("sw.js", sw);
' "$BUILD"
echo "Build $BUILD stamped"

git add -A
git diff --cached --quiet || git commit -q -m "$MSG"
git push origin "$BRANCH"

echo
echo "Pushed. Live in a minute or two at ${SITE}"
echo "Check it took with:  curl -s ${SITE}version.txt"
echo "It should print:     $BUILD"
