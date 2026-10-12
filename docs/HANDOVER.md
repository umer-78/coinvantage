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
node --test tests/*.test.mjs              # every unit test must pass, incl. the missing-import guard
node tools/smoke.mjs                      # route smoke test
bash tools/deploy-push.sh                 # stamp the release version, commit and push main (Pages deploys from main)
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
      errors, 25 unit tests green at the time, Supabase advisors clean of real issues.
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
1. `node --check` every file in js/, then `node --test tests/*.test.mjs` (all must pass).
2. Walk every route on the live site and confirm zero console errors.
3. Re-run the Supabase security advisors; confirm nothing new.
4. Confirm engine parity: `js/lib/{signals,predict,indicators,barrier,pooled}.js` must be
   byte-identical to `supabase/functions/cv/engine/` — the /cv/selftest endpoint
   depends on it, and `tools/deploy-backend.sh` refuses to deploy when they differ.
5. Check `version.txt`, `js/app.js` BUILD and `sw.js` VERSION all match after deploy.

### Cloud sync, trade results and the schema (2026-10-12)
- **Sync** (`js/lib/cloudsync.js`): every synced key merges on its own against a
  fingerprint of the value both sides last agreed on; whichever side changed
  wins, and when both did the cloud's copy is kept. The Trading page's accounts
  and the AI's rules sync too (they used to stay on one device). Demo or real
  trades that only one device had are set aside (`syncBackup`) and the Trading
  page offers them back; two AI accounts meeting for the first time keep the
  one that has run longest. A shared browser never uploads one account's data
  into another. Saves go through `public.sync_user_data(p_cols, p_trading)`,
  which writes only the keys that changed. `tests/cloudsync.test.mjs` runs it
  against a fake server that reorders keys the way jsonb does.
- **Trade results count both fees.** A closed trade's P&L used to leave out the
  entry fee, so win rates and profit factors read higher than the balance.
  `AUTOTRADER_TESTED` no longer carries profit factors (measured the old way,
  never shown); its returns and drawdowns are balance-based and still hold.
- **Schema in the repo**: `supabase/migrations/` holds every migration applied to
  the live database, exported from its history and checked byte for byte. The
  last file (`record_live_cron_jobs`) records two scheduled jobs that had been
  changed on the live database without a migration; it was not applied there
  and changes nothing if it is.

### AI trader fixes and re-measure (2026-10-12, later the same day)
Found by reading a live account that lost 20% (63 trades, 3 targets):
- Sizing ignored cash already in open positions (ten positions at the 25% cap
  held 250% of the balance). `freeCash()` now caps every buy, fee included.
- The reversal-bar count restarted each check, so the signal exit never fired
  live; it is kept on the position (`pos.reversalBars`).
- Coins without exchange candles (CoinGecko samples, e.g. FIGR_HELOC) and demo
  candles are never traded; an open position in such a coin is closed at its last
  price. Coins removed from the list keep being checked for exits.
- Catch-ups replay all coins together in time (`replayAll` / `replaySeries`).
- New, OFF by default: `entryMode` breakout / pullback, `momentumConfirm`,
  `marketFilter` (Bitcoin trend). `tools/evaluate-trader-rules.mjs` (Actions →
  Evaluate → Run workflow) tried 432 rule sets, picked one on the older halves,
  and it did NOT beat the shipped rules on the newer halves, so nothing changed.
  Newer-half results of the shipped rules: 15m −6.3% (hold +1.8%), 1h +11.9%
  (+36.6%), 4h +4.0% (−12.4%), 1d +110.3% (+123.3%). On 15m only 3 of 432 rule
  sets made money after fees. Source: `AUTOTRADER_TESTED`.
- Market data hosts are blocked in the cloud sandbox; the Evaluate workflow runs
  the test on GitHub's runners. Read its log for the report.

### Backend deploy as it stands (2026-10-12)
The live edge function `cv` (version 11) is a one-line entry that imports
`supabase/functions/cv/index.ts` from a pinned commit on raw.githubusercontent.com
(ea81f80), so what runs is exactly what was committed. To deploy newer server
code, change the hash in that entry (or run `tools/deploy-backend.sh`), then check
`/functions/v1/cv/selftest` returns 200. Since ea81f80 the only server-side change
is the unresolved-trade fix in `engine/barrier.js` (barrier labels, which the server
never uses), so the live function has not needed a redeploy. Vault holds `cron_secret` and
`telegram_webhook_secret` only: alerts cannot be delivered until a Telegram bot
token, Resend key and Stripe keys are added under Admin → API keys.

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
- **AI learning center (#/learn, 2026-09-26):** `js/lib/learncenter.js` + `learnpass.js`. Grades 12 indicator
  readings, the forecast and a learned blend on real outcomes (non-overlapping calls, Wilson 95% ranges, a
  vote only with 30+ calls and a range clear of 50%). Walk-forward release test (`tools/evaluate-learning.mjs`):
  blend 53.9% = forecast 53.9% overall, so the forecast is champion; the blend takes over only after 100+
  live calls each with a 3-point lead and its 95% range above the forecast. Learns from every chart opened,
  every trader check, and grades all three accounts' buys (demo buys now record trend/ADX/RSI at entry).
- **2026-09-26 re-measure (supersedes the forecast line below):** direction 53.9% vs 58.5% hindsight
  baseline, 52.2% for "always up"; confident subset 50.7% (227). No edge on any timeframe. Ranges now
  come from each coin's own standardized past moves: 80% band holds 78.5% (was 71.7%), 50% band 48.4%
  (was 45.1%). Source: TESTED_ACCURACY. Tool: tools/evaluate-engine.mjs.
- **AI trader, 2026-09-26 (superseded by the 2026-10-12 section above):** `tools/evaluate-trader-live.mjs` simulates all coins candle by candle (the old
  harness replayed one coin at a time, which let one open trade block every other coin). One setting chosen
  on the training halves of 15m/1h/4h/1d — 3 ATR stop, 3R target, trend filter on — now ships. Held-out:
  15m +18.0% (prev +9.3%), 1h +24.8% (prev +31.8%), 4h +11.2% (prev −10.9%), 1d +70.7% (prev +65.6%),
  smaller drawdowns on 3 of 4, half the fees. Beats buy-and-hold only on 4h. Source: AUTOTRADER_TESTED.
- **Trader self-review** (`js/lib/tradelearn.js`): reads the trade log, switches a filter on when one entry
  condition keeps losing (≥10 trades, ≥0.25R worse), off again if results got worse, never re-learns an
  unlearned lesson. Coin benching is off by default (measured as noise). In 8 held-out runs it acted once.
- Superseded on 2026-09-26, kept for history — forecast direction accuracy: 49.6% overall against a 51.0% baseline (no edge) — 1m 44.6% (baseline 53.8%),
  5m 55.0% (52.5%), 15m 52.5% (51.2%), 1h 48.8% (64.2%), 4h 43.8% (75.4%), 1d 52.9% (52.1%).
  1,440 tests, 12 coins, 240 per timeframe. No edge on 1m, 1h, 4h. Source of truth: TESTED_ACCURACY in js/lib/predict.js.
- Tried and REJECTED (all measured worse, do not re-add without new evidence):
  stacked logistic regression over the model votes (51.6%), and Platt calibration
  WITH an intercept (52.4% — the intercept moves the 50% crossing and flips
  forecasts). Slope-only calibration is what shipped: direction unchanged at
  54.0%, Brier 0.2529 to 0.2483, confident-subset accuracy 53.0% to 56.9%.
  Also rejected: a pooled cross-coin model (53.7%), and more validation points
  with below-chance models zeroed out (51.5%). Four variants tested, one shipped.
- Timing peak-hit: 58.0% vs 54.1% random (931 tests, 12 coins) — 5m 52.6% vs 48.7%, 15m 48.6% vs 49.0% (no edge),
  1h 52.5% vs 46.8%, 4h 68.7% vs 61.8%, 1d 56.1% vs 55.0%. Source of truth: TESTED_TIMING in js/lib/timing.js.

### Assistant and advice fixes (2026-09-25)
- `adviseCoin` scales the score by the evidence behind it (divides by `max(total weight, 1)`), so one barely-trusted reading can no longer produce "BUY, conviction 100/100".
- The forecast's weight is measured against the per-coin baseline (always naming the commoner direction), not 50%, and counts a quarter on timeframes where the published walk-forward test found no edge (`TESTED_ACCURACY.noEdge`).
- `js/lib/tickers.js`: ambiguous tickers (near, link, dot, etc, op…) count as coins only in capitals, with a `$`, or next to a trading word. "Which coin looks strongest" no longer resolves to LooksRare, and "near term for BTC" no longer turns into BTC vs NEAR.
- Tools page (`#/tools`, `js/lib/calc.js`): converter, DCA backtest, position sizer.
