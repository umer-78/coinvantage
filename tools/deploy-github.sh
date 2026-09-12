#!/usr/bin/env bash
# One-shot GitHub Pages deploy for CoinVantage.
#
#   1. brew install gh          (once)
#   2. gh auth login            (once — pick GitHub.com, HTTPS, login with a browser)
#   3. bash tools/deploy-github.sh coinvantage
#
# It creates the repo, pushes, turns on Pages, waits for the first build,
# writes a sitemap for the real URL and prints the live link.
set -euo pipefail

REPO="${1:-coinvantage}"
BRANCH="main"
cd "$(dirname "$0")/.."

command -v gh >/dev/null || { echo "GitHub CLI not found. Run: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in. Run: gh auth login"; exit 1; }

USER_LOGIN="$(gh api user --jq .login)"
SITE="https://${USER_LOGIN}.github.io/${REPO}/"
echo "Deploying as ${USER_LOGIN} → ${SITE}"

git rev-parse --git-dir >/dev/null 2>&1 || git init
git symbolic-ref -q HEAD >/dev/null || git checkout -b "$BRANCH"
git branch -M "$BRANCH"
[ -f .nojekyll ] || touch .nojekyll

# Sitemap and robots point at the real address before the first push.
node tools/build-sitemap.mjs "$SITE"

# Stamp this release. The app fetches version.txt on every load and reloads
# itself when the number changes, so nobody is ever left on a stale build.
BUILD="$(date -u +%Y%m%d-%H%M%S)"
printf '%s\n' "$BUILD" > version.txt
# bake the same number into the app and the service-worker cache name
node -e '
  const fs = require("fs");
  const b = process.argv[1];
  const app = fs.readFileSync("js/app.js", "utf8").replace(/^export const BUILD = .*$/m, `export const BUILD = ${JSON.stringify(b)};`);
  fs.writeFileSync("js/app.js", app);
  const sw = fs.readFileSync("sw.js", "utf8").replace(/^const VERSION = .*$/m, `const VERSION = ${JSON.stringify("cv-" + b)};`);
  fs.writeFileSync("sw.js", sw);
' "$BUILD"
echo "Build $BUILD stamped into version.txt, js/app.js and sw.js"

git add -A
git diff --cached --quiet || git commit -q -m "Deploy CoinVantage to GitHub Pages"

if gh repo view "${USER_LOGIN}/${REPO}" >/dev/null 2>&1; then
  echo "Repo already exists — pushing to it."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${USER_LOGIN}/${REPO}.git"
  git push -u origin "$BRANCH"
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi

# Turn Pages on (ignore the error if it is already enabled).
gh api -X POST "repos/${USER_LOGIN}/${REPO}/pages" \
  -f "source[branch]=${BRANCH}" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api -X PUT "repos/${USER_LOGIN}/${REPO}/pages" \
       -f "source[branch]=${BRANCH}" -f "source[path]=/" >/dev/null 2>&1 || true

echo "Waiting for the first Pages build…"
for i in $(seq 1 40); do
  STATUS="$(gh api "repos/${USER_LOGIN}/${REPO}/pages" --jq .status 2>/dev/null || echo "")"
  [ "$STATUS" = "built" ] && break
  sleep 15
done

echo
echo "Live at: ${SITE}"
echo "Next: open the site → Admin → Settings → Site and paste that URL,"
echo "so alert e-mails and Telegram messages link back to the charts."
