#!/usr/bin/env bash
# Boots the edge function locally with Deno — no database, dummy credentials —
# and checks that /cv/selftest answers exactly what the site's engine computes.
# Catches a server file that no longer loads (a syntax error, a bad import, a
# crash at start-up) and an engine copy that has drifted, before a deploy
# rather than after. CI runs it; locally: DENO=/path/to/deno bash tools/server-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DENO=${DENO:-deno}
PORT=8000 # Deno.serve's default
LOG=$(mktemp)
SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=ci-dummy \
  "$DENO" run --no-check --no-lock --node-modules-dir=none --allow-net --allow-env --allow-read \
  supabase/functions/cv/index.ts >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
  kill -0 $PID 2>/dev/null || { echo "The server exited while starting:"; cat "$LOG"; exit 1; }
  sleep 1
done
got=$(curl -s "http://127.0.0.1:$PORT/cv/selftest")
want=$(node --input-type=module -e '
  import { generateSignal } from "./js/lib/signals.js";
  import { forecast } from "./js/lib/predict.js";
  const candles = Array.from({ length: 400 }, (_, i) => {
    const c = 100 + Math.sin(i / 9) * 8 + Math.sin(i / 37) * 15 + i * 0.05;
    return { t: i * 3600e3, o: c - Math.cos(i / 5) * 0.6, h: c + 1.2, l: c - 1.3, c, v: 1000 + (i % 17) * 40 };
  });
  const s = generateSignal(candles, { interval: "1h" });
  const f = forecast(candles, { horizon: 6, fast: true });
  console.log(JSON.stringify({ score: s.score, action: s.action, probUp: f.ok ? +f.probUp.toFixed(6) : null, acc: f.ok ? f.ensemble.accuracy : null }));
')
if [ "$got" != "$want" ]; then
  echo "The server's selftest does not match the site's engine."
  echo "  server: $got"
  echo "  site:   $want"
  cat "$LOG"
  exit 1
fi
echo "Server starts and its engine matches the site's: $got"
