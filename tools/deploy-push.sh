#!/usr/bin/env bash
# Deploy when the repo and Pages already exist and the GitHub CLI is not on PATH.
# Does exactly what deploy-github.sh does after repo creation: stamp the build
# into version.txt, js/app.js and sw.js so the running app reloads itself, then
# commit and push. No repo or Pages API calls, so no gh needed.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-coinvantage}"
BRANCH="main"
SITE="https://umer-78.github.io/${REPO}/"

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
git diff --cached --quiet || git commit -q -m "Correct the trade summary, the AI trader and the non-Binance candle feed"
git push origin "$BRANCH"
echo "Pushed. Live in a minute or two at ${SITE}"
