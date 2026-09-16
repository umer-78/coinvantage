#!/usr/bin/env bash
# Deploys the single routed edge function (cv) to Supabase.
#
# The site and the server share the same engine files — js/lib/*.js is mirrored
# byte-for-byte into supabase/functions/cv/engine/ — so whenever those change,
# the server has to be redeployed or it keeps sending alerts in the old wording
# and scoring the track record with the old models.
#
#   1. brew install supabase/tap/supabase     (once)
#   2. supabase login                         (once)
#   3. bash tools/deploy-backend.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v supabase >/dev/null || { echo "Supabase CLI not found. Run: brew install supabase/tap/supabase"; exit 1; }

# Refuse to ship a server whose engine has drifted from the site's.
fail=0
for f in signals predict indicators barrier pooled; do
  a=$(shasum -a 256 "js/lib/$f.js" | cut -d' ' -f1)
  b=$(shasum -a 256 "supabase/functions/cv/engine/$f.js" | cut -d' ' -f1)
  if [ "$a" != "$b" ]; then echo "MISMATCH: js/lib/$f.js differs from the copy the server would run"; fail=1; fi
done
[ "$fail" = 0 ] || { echo "Aborting: copy js/lib/<name>.js over supabase/functions/cv/engine/<name>.js first."; exit 1; }
echo "Engine parity verified (5 files)."

supabase functions deploy cv --project-ref cjpljmzustvgsmueqese --no-verify-jwt
echo
echo "Deployed. Checking the engine answers identically on both sides:"
curl -s "https://cjpljmzustvgsmueqese.supabase.co/functions/v1/cv/selftest"
echo
node --input-type=module -e '
  import { generateSignal } from "./js/lib/signals.js";
  import { forecast } from "./js/lib/predict.js";
  const candles = Array.from({ length: 400 }, (_, i) => {
    const c = 100 + Math.sin(i / 9) * 8 + Math.sin(i / 37) * 15 + i * 0.05;
    return { t: i * 3600e3, o: c - Math.cos(i / 5) * 0.6, h: c + 1.2, l: c - 1.3, c, v: 1000 + (i % 17) * 40 };
  });
  const s = generateSignal(candles, { interval: "1h" });
  const f = forecast(candles, { horizon: 6, fast: true });
  console.log("locally:", JSON.stringify({ score: s.score, action: s.action, probUp: f.ok ? +f.probUp.toFixed(6) : null, acc: f.ok ? f.ensemble.accuracy : null }));
'
echo "The two lines above must match. If they do not, the deploy did not take."
