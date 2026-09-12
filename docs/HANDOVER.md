# CoinVantage — handover / continuation notes

Owner: Umer Hashmi (`umer-78`). Live site: https://umer-78.github.io/coinvantage/
Repo: https://github.com/umer-78/coinvantage  ·  Supabase project: `cjpljmzustvgsmueqese`

A fresh session should **clone this repo, read this file, and continue from "Open work"**.

## Hard rules that never change
1. The app **never places a real trade**. The AI trader is paper/simulated only.
2. The app **never asks for private keys, seed phrases or exchange API keys**. The wallet page warns about this.
3. Wallet connection is **read-only** — `eth_requestAccounts` and `eth_chainId` only, never a signature.
4. **Accuracy is reported honestly.** Published numbers come from `tools/evaluate-engine.mjs` /
   `tools/evaluate-timing.mjs` on real data. Never round up, never quote a number that was not measured.
5. No build step, no framework, no npm runtime dependencies. Plain ES modules served from GitHub Pages.

## How to verify (always run all of these before deploying)
```
node --check $(find js -name '*.js')      # syntax
node --test tests/*.test.mjs              # 17 unit tests, incl. the missing-import guard
node tools/smoke.mjs                      # route smoke test
bash tools/deploy-github.sh               # commit + push to gh-pages
```
Then re-run the Supabase security + performance advisors and confirm zero errors.

## Open work
- [x] Whole-market AI answers on **several timeframes at once** (`scanMarketMulti`,
      `marketContextMulti` in `js/ai/context.js`; `marketMultiBlock` in `js/lib/analyst.js`).
      The assistant must answer "which coin to buy, for how long, and when to sell"
      across short term (1h) / swing (4h) / position (1d) without a coin being open.
- [ ] Wording pass over every user-facing string (plain English, no jargon, no overselling).
- [x] Make the forecast more accurate: replace the heuristic ensemble weights in
      `js/lib/predict.js` with a stacked logistic regression over `valRecords`, add
      probability calibration, re-measure with `tools/evaluate-engine.mjs`, publish the new
      honest numbers in `TESTED_ACCURACY` and on `#/track`.
- [ ] Chart drawing tools (trendline, Fibonacci) and VWAP + Ichimoku overlays.
- [ ] Final full recheck of every route and feature, then redeploy.

## Measured numbers currently published (do not change without re-measuring)
- Forecast direction accuracy: 54.0% overall — 15m 57.1%, 1h 53.0%, 4h 58.9%, 1d 47.0%
  (672 tests, 12 coins, naive baseline 51.3%). Confident subset: 56.9% over 38% of forecasts.
  Brier 0.248. Re-measured 2026-09-12 with tools/evaluate-engine.mjs on fresh candles.
- Tried and REJECTED (both measured worse, do not re-add without new evidence):
  stacked logistic regression over the model votes (51.6%), and Platt calibration
  WITH an intercept (52.4% — the intercept moves the 50% crossing and flips
  forecasts). Slope-only calibration is what shipped: direction unchanged at
  54.0%, Brier 0.2529 to 0.2483, confident-subset accuracy 53.0% to 56.9%.
- Timing peak-hit: 61.2% vs 53.6% random — 15m 45% (worse than chance, flagged as such in the UI),
  1h 51.6%, 4h 67.9%, 1d 66.3%.
