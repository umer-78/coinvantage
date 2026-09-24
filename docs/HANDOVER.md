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
node --test tests/*.test.mjs              # 63 unit tests, incl. the missing-import guard
node tools/smoke.mjs                      # route smoke test
bash tools/deploy-github.sh               # commit + push to gh-pages
```
Then re-run the Supabase security + performance advisors and confirm zero errors.

## Open work
- [x] Whole-market AI answers on **several timeframes at once** (`scanMarketMulti`,
      `marketContextMulti` in `js/ai/context.js`; `marketMultiBlock` in `js/lib/analyst.js`).
      The assistant must answer "which coin to buy, for how long, and when to sell"
      across short term (1h) / swing (4h) / position (1d) without a coin being open.
- [x] Wording pass over the main user-facing strings (plain English, no jargon, no overselling).
- [x] Make the forecast more accurate: replace the heuristic ensemble weights in
      `js/lib/predict.js` with a stacked logistic regression over `valRecords`, add
      probability calibration, re-measure with `tools/evaluate-engine.mjs`, publish the new
      honest numbers in `TESTED_ACCURACY` and on `#/track`.
- [x] **Pooled cross-coin model — built, measured, REJECTED.** `tools/train-pooled.mjs`
      fits one logistic regression per timeframe across all 12 coins at once
      (~25k rows for 15m/1h, 22k for 4h, 14k for 1d), trained strictly on the
      first 55% of every series so it can never see a tested forecast. Wired in
      as an extra voter it scored **53.7%** against the shipped roster's 54.0%,
      Brier 0.2499 vs 0.2483, confident-subset 56.0% vs 56.9%. Per timeframe it
      helped 15m (57.1 → 58.3) and hurt 1h (53.0 → 51.8) and 4h (58.9 → 57.7) —
      differences well inside the noise for 168 forecasts each, so enabling it
      only on 15m would be fitting the test set, not an improvement.
      The trainer and `js/lib/pooled.js` are kept. To re-try it, add `pooled`
      back to `MODEL_INFO` in `js/lib/predict.js`, re-train, and re-measure —
      accept only if it beats 54.0% overall.

- [x] Chart drawing tools (trend line, horizontal, Fibonacci, erase) + VWAP and Ichimoku.
      Drawings are stored in time/price, per coin and timeframe, in the `drawings` sync key.
      Pure maths lives in `js/lib/geometry.js` so it is testable without a browser.
- [x] Final full recheck: all 18 routes walked on the live site, zero JavaScript
      errors, 25 unit tests green, Supabase advisors clean of real issues.
      Last run 2026-09-13.

## Open work (as of 2026-09-13 evening)

Umer picked these four, plus the Binance import which is DONE and live.

- [x] **Portfolio performance chart** — `drawRealChart()` in `js/views/trader.js`.
      The real account's equity curve with a buy-and-hold BTC line normalised to
      the same starting balance, and a line saying whether you beat it.
- [x] **Watchlist alerts digest** — `watchlistDigest()` in
      `supabase/functions/cv/alerts.ts`, routed at `/cv/watchlist-digest`, pg_cron
      job `cv-digest` daily at 08:00 UTC. One read per coin shared across all
      subscribers; skips anyone with `settings.digest === false` or no channel.
- [x] **Coin comparison AI** — `detectCompare()` + `compareBlock()` in
      `js/lib/analyst.js`, `compareCoins()` in `js/ai/context.js`. Refuses to name
      a winner when the top two are within 10 conviction points, and flags any
      coin whose forecast has no measured edge.
- [x] **Export and reports** — `js/lib/export.js`. CSV with proper quoting and a
      printable HTML report that labels a sample under 30 trades as too small to
      judge, and carries the not-advice line.

### Repair / maintenance sweep to run each time
1. `node --check` every file in js/, then `node --test tests/*.test.mjs` (63 tests).
2. Walk every route on the live site and confirm zero console errors.
3. Re-run the Supabase security advisors; confirm nothing new.
4. Confirm engine parity: `js/lib/{signals,predict,indicators,barrier}.js` must be
   byte-identical to `supabase/functions/cv/engine/` — the /cv/selftest endpoint
   depends on it. `md5sum` both and compare.
5. Check `version.txt`, `js/app.js` BUILD and `sw.js` VERSION all match after deploy.

### Futures data fallback (2026-09-17)
Binance futures and Bybit both geo-block some regions (the browser only sees a
CORS error), which left the Futures page empty there. `js/api/futures.js` now
falls back to OKX for the market table and the single-coin panel. OKX's
`/api/v5/rubik/*` statistics send no CORS header, so positioning and
open-interest history are not available from OKX in a browser; the panel says
so instead of drawing an empty chart. `tools/smoke.mjs` ignores CORS errors only
from the geo-blocking hosts, so a new browser-unreadable endpoint still fails it.

### Measured: the score is descriptive, not tradeable (2026-09-14)

Two tests, and the second overturned the first. Both are kept here because the
first one was briefly published and the mistake should not be repeated.

**Test 1 — bucket averages** (`tools/evaluate-signal-edge.mjs`). Group every bar
by the score shown, average the outcome:

| Timeframe | Base (every bar) | Best band | Hit | Lift | n |
|---|---|---|---|---|---|
| 15m | 49.4% | 60..100 | 60.6% | 1.23 | 99 (too few) |
| 1h  | 27.5% | 45..59  | 35.4% | 1.29 | 486 |
| 4h  | 47.6% | 18..29  | 52.6% | 1.10 | 498 |
| 1d  | 35.0% | 30..44  | 37.9% | 1.08 | 596 |

Also note: the relationship is **not monotonic**. On 4h, 60+ did WORSE than an
average bar (45.5% vs 47.6%).

**Test 2 — trade it** (`tools/evaluate-band-strategy.mjs`). Take only those
signals, in sequence, one position at a time, with fees, compounding:

| Band | Traded | Random control | Verdict |
|---|---|---|---|
| 1h 45..59 | **+0.040 R** over 712 trades | **+0.126 R** | 3x WORSE than random |
| 4h 18..29 | +0.044 R over 752 trades | +0.019 R | margin too small to call |

The bucket average was inflated by overlapping positions a real account could
never have held at once, and by partial credit for trades that merely ended
slightly up. **No band is tradeable.** `SIGNAL_EDGE_TESTED` records the failure
so nobody reinstates the bucket number as if it were an edge; a unit test asserts
`beatsRandom === false` for every entry.

Method note: the barrier test always measures a LONG, so positive EV on strongly
NEGATIVE scores is mean reversion after selloffs, not the sell signal working.
A short-side test has not been run.

### Known, deliberate, do not "fix"
- 15m and 4h trade geometry has NEGATIVE measured expectancy at every configuration
  tested. The UI says so and downgrades the verdict to BUY (WEAK EDGE). Do not
  quietly swap in nicer-looking levels — re-measure with tools/evaluate-geometry.mjs.
- The app never places orders and never asks for exchange API keys. Four separate
  requests to add real trading were declined; the Real account is a journal plus
  CSV import. Keep it that way.

## Measured numbers currently published (do not change without re-measuring)
- Forecast direction accuracy: 54.0% overall — 15m 57.1%, 1h 53.0%, 4h 58.9%, 1d 47.0%
  (672 tests, 12 coins, naive baseline 51.3%). Confident subset: 56.9% over 38% of forecasts.
  Brier 0.248. Re-measured 2026-09-12 with tools/evaluate-engine.mjs on fresh candles.
- Tried and REJECTED (all measured worse, do not re-add without new evidence):
  stacked logistic regression over the model votes (51.6%), and Platt calibration
  WITH an intercept (52.4% — the intercept moves the 50% crossing and flips
  forecasts). Slope-only calibration is what shipped: direction unchanged at
  54.0%, Brier 0.2529 to 0.2483, confident-subset accuracy 53.0% to 56.9%.
  Also rejected: a pooled cross-coin model (53.7%), and more validation points
  with below-chance models zeroed out (51.5%). Four variants tested, one shipped.
- Timing peak-hit: 61.2% vs 53.6% random — 15m 45% (worse than chance, flagged as such in the UI),
  1h 51.6%, 4h 67.9%, 1d 66.3%.

### Assistant and advice fixes (2026-09-25)
- `adviseCoin` scales the score by the evidence behind it (divides by `max(total weight, 1)`), so one barely-trusted reading can no longer produce "BUY, conviction 100/100".
- The forecast's weight is measured against the per-coin baseline (always naming the commoner direction), not 50%, and counts a quarter on timeframes where the published walk-forward test found no edge (`TESTED_ACCURACY.noEdge`).
- `js/lib/tickers.js`: ambiguous tickers (near, link, dot, etc, op…) count as coins only in capitals, with a `$`, or next to a trading word. "Which coin looks strongest" no longer resolves to LooksRare, and "near term for BTC" no longer turns into BTC vs NEAR.
- Tools page (`#/tools`, `js/lib/calc.js`): converter, DCA backtest, position sizer.
