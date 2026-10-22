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

### The AI learns and trades in the cloud (2026-10-22)
Before this, the AI learning pass and the AI trader only ran while a page was open, and the
learning record lived in that one browser. Now:
- **Cloud learning** (`supabase/functions/cv/learn.ts`, pure logic in `learnjob.js`, cron
  `cv-learn` at 3,8,13… past each hour): one chart and six coins a run, in turn, over the 78
  coins of `tools/universe.json` that read from Binance, on 1m–1d. It grades calls whose outcome
  candle has closed, measures every indicator on each coin's last 500 candles, logs this candle's
  calls (indicators, forecast, blend) before the outcome is known, and works out each chart's
  weights and champion (`engine/learncenter.js`, byte-identical to `js/lib/learncenter.js`). One
  row per chart in `ai_learn` (public read of `summary` only; the `ledger` column stays with the
  job). A call whose outcome candle can no longer be read is dropped and counted (`expired`).
  The AI learning page, the coin page's blend and the Trading page read it (`js/lib/cloudlearn.js`);
  a browser runs its own pass only when the record cannot be read.
- **Cloud trader** (`trader.ts`, cron `cv-trader` at 1,6,11… past each hour): every signed-in
  account whose AI is on (`aiSession.status = 'running'`) is checked with the page closed, by the
  same routine the page runs (`js/lib/traderrun.js`: settings, chart rules, lessons, replay, log,
  self-review), on candles from the exchange the browser reads each coin from (`candles.ts`:
  Binance, else the Gate.io/HTX/OKX venue in `coins.js`; a short Binance history takes the longer
  one). It skips an account whose last check came after the newest candle closed. It saves through
  `cv_save_trader`, only if the account is unchanged since it was read (a page saved meanwhile:
  the next run starts from that copy). Both database functions are service-role only. `trader-run`
  takes `{"dry": true}` to report without saving. Check entries carry `by: 'cloud'` or `'page'`.
- **Your forecast record** (`aiLedger`) now syncs with the account (`cloudsync.js` TRADING_KEYS),
  joined across devices rather than one copy kept (`mergeLedgers`).
- **Less kept on the device**: the persisted response cache is capped at 12 entries and about
  600 KB (`js/api/http.js`; it used to keep one per coin page visited), keys of removed features
  are cleared, and `aiLearn` is removed once the cloud record can be read.
Verified after deploy (cv v16, pinned to 7a83d1d): selftest 200 and equal to the site's engine;
a learning run on every chart (6 calls each); a trader run on the one running account read all 89
of its coins (0 failed) and saved.

The one running account (Oct 22) was on 4h, whose tested rules lost money once real fills are
counted, with no trades yet; at the owner's request its settings were fixed in the cloud: the
chart is now 1h (the best tested after costs) and the empty 4h account was restarted on 1h. The
previous settings and account are kept in `trading.traderBackup`.

### What each chart can make, per hour to per month (2026-10-22)
`earningsByChart(cfg)` spreads each tested chart's walk-forward average (at the account's risk,
read between the measured levels, less the fill cost) evenly over an hour, a day, a week and a
month, with the worst test period and holding the coins beside it; the Trading page shows it on
the account's balance with the account's own record so far. `settingsWarnings` now says when the
chosen chart's tested rules lost money after fills (4h). Simple averages of past periods: the
page says so, and that holding made more on every chart in those (mostly rising) periods.

### When to sell: the exit test (2026-10-22)
`tools/evaluate-exits.mjs` (Evaluate job `exits`, monthly) keeps each chart's entry rules and
varies only the exits (stop 2/3/4 ATR, target 1.5–5R or a 2/3 ATR trailing stop, break-even at
1R, selling after 1–3 weak candles or never), picked on the history before each block and run on
the block, after 0.15% a side. First run (99–103 coins, to Oct 22): under the current exits the
stop-loss ends ~45% of trades at −1.0 to −1.2R, the target ~20% at +2.6 to +3.0R, and selling
on weak candles ~35% at −0.43 to −0.48R (only 8–12% of those win). Picked exits beat the current
ones in 2 of 3 blocks on 15m and 4h (passing the bar once), 1 of 3 on 1h and 0 of 3 on 1d, so no
exit changes until a second run agrees. The job also A/Bs the weak-candle rule on its own (off,
after 1, after 3), with nothing fitted.

### Score levels are not a buy setup (2026-10-22)
The server record (`signal_log`, last 30 days) graded the levels the chart score draws: on 1d,
long plans after "strong rise" readings lost 2.5% a plan (8 of 80 reached a target) and after
"rising" 3.1% (16 of 134), while short plans after falling readings made money; on 4h the long
plans lost slightly. That is the score test's finding (the strongest readings were followed by a
rise least often), so `generateSignal` now titles them "Levels if you buy" / "Levels if you sell
or short", and the coin page and the assistant say under them what trades at those distances did
in testing (`TRADE_GEOMETRY.ev`). The summary already called them chart geometry, not a signal.
The AI signal (the tested trader rule) is the thing to act on. The deployed `cv` function keeps
the old titles in its rows until it is next deployed.
`tools/live-check.mjs` (Evaluate job `live`) opens the deployed site with live data and reports
which coin page parts, charts and data pages did not read.

### The best tested setup is chosen after the cost of real fills (2026-10-22)
`bestTestedChart` ranked charts by test periods with a gain before spread and slippage, so it
recommended 15m (+3.21% per 11 days). After `fillCost` (fills 0.05% worse each way), 15m made
+1.11% per 11 days and its worst period lost money, and 4h lost on average. It now ranks by
the result after that cost per 30 days (a tie goes to the smaller worst drop): 1h, +6.08% per
6 weeks, about +4.4% a month, worst drop 18.3% (holding made +18.23% a period). The settings
dialog's "What to do" says so.

### A held coin's missed candles are fetched on catch-up (2026-10-22)
A user's AI account on 5m lost 5.2% on a QNT trade whose stop was 1.6% under the entry. The page
had been closed for longer than the 500 candles a check fetches (42 hours of 5m), so the first
candle the account saw had opened far under the stop, and the trade was closed there. Now, for
every coin with an open position whose last traded candle is older than the fetched window,
`catchUp` in `js/views/trader.js` fetches its candles back to that candle plus 240 before it for
the indicators (`BACKFILL_MAX` 6,000 candles, 20 days of 5m). Checked in a browser with the clock
moved 25 days on (past the 1h window): with the fix off, five held positions were sold 12–22%
under their stops at the first candle seen; with it on, each was stopped at its stop price or
sold earlier on its own signal. Coins without a position are not back-filled: an account whose
page is closed does not open trades it never saw. The Trading page now also lists, above the
AI's account, how the settings differ from the tested ones (untested chart, risk over 2%, more
than 25% in one coin…) with a button that opens Settings on the best tested setup.

### Trading page money and charts checked; labels fixed site-wide (2026-10-16)
- **The AI trader's money, audited from first principles** (24 setups: four charts × standard,
  trailing stop + break-even, 5% risk, ten positions at a 0.5% fee, volatility sizing, the dip
  rule; ten coins including BTT and PEPE prices). Every closed trade's P&L and fees, every fill
  (entry at the close, stop at or under the stop and never under the candle's low, target only
  on a candle that reached it and did not also hit the stop), the balance (start + closed P&L −
  open positions' entry fees), sizing (never more than the risk setting at the stop, never more
  than 25% in one coin, never more in positions than the balance) and the stats (win rate,
  profit factor, return, fees, worst drop from the curve) matched to the cent. In the browser,
  after twelve simulated days, the page's balance (₨ at 280.5 to the dollar), return, win rate,
  profit factor, drawdown, fee total and trade count matched the engine, and the balance chart's
  last point equals the balance card.
- **Fixed: the "buy the dip in an uptrend" rule (`entryMode: 'pullback'`) could never buy.** It
  waited for the chart score to reach −18 in an uptrend, but the score counts oversold readings
  as reasons to buy, so a real dip pushes it up: in an uptrend it never fell below −10 on 55,800
  test candles, and reached −18 only at overbought tops. Its tests passed because they scripted
  the score. The dip is now RSI(14) at 40 or lower (`PULLBACK_RSI`); a new test runs it on
  computed indicators. No shipped rule used it (none of the 73 per-coin picks).
- **The balance chart** gets a point only while a trade is open, so a week in cash ended the
  line at the last trade; it is now carried flat to now.
- **Labels** (scratch harness `cvlabels.mjs`: every page and the main pop-ups at 1280, 1024, 390
  and 360 px, in PKR): overlapping text, text spilling out of its box, text cut off with "…"
  and no way to read it, controls with no name, and boxes that scroll sideways behind a hidden
  scrollbar. Fixed: stat values no longer end in "…" (they wrap at the dash and shrink in a
  narrow box, `@container` rules at the end of `css/app.css`); the coin list in the trader
  settings keeps "no exchange", "Gate.io" and the like inside each coin's cell (`.pick`); the
  settings dialog is wider (`modal(..., { wide: true })`) and its expected-yield table fits
  (`.tbl.fit`); the chart interval buttons and the coin page tabs wrap instead of hiding options
  off the edge; table headers may wrap and cells of words carry `.wrap`, so tables fit the page
  (the scanner's "Top reason" moved into the signal's tooltip; Trend, Bid and Ask hide below
  1440 px with `.hide-l`); lists show the ticker first so a shortened name keeps it; sort arrows
  stay on their header's line; measured percentages show two decimals everywhere.

### Learning loops checked end to end (2026-10-16)
A browser run with the clock moved forward (one coin page view, then 3, 12 and 30 days on, on
mocked candles that never change once closed) confirmed each loop: the coin page logs a
forecast (`cv:aiLedger`) and indicator calls (`cv:aiLearn`) before the outcome, grades them
once the horizon candle is on screen, the learning pass grades the rest, and the AI trader
trades the new candles and reviews its log after every check (47 trades read; no condition
kept losing, so it changed nothing). The server's `signal_log` and `ai_signal_log` are written
and graded every hour with nothing overdue. Two faults found and fixed:
- **Your forecasts on the Account page were graded from the latest 500 candles**, so any older
  than that (eight hours of 1m candles, 42 minutes of 5s ones) could never be graded, and the
  oldest 20 due rows, fetched first every visit, kept the rest waiting. `closeAtTime` in
  `js/api/market.js` now reads the close at the horizon itself (Binance `endTime`, Gate.io
  `from`/`to`, OKX `after`; HTX only has its latest 2,000 candles); due rows are taken newest
  first, 40 a visit; a row whose exchange answered without its candle for a day is closed as
  "not available" (`outcome_price` null, so the database scores it neither right nor wrong).
- **The same log graded the models' raw lean even where the page showed no direction.** It now
  logs the chance the page shows, or none where no direction is shown (every chart at
  present), so "your hit rate" counts only direction calls you actually saw.

### Every model re-measured on all 106 tradable coins (2026-10-15/16)
The tests used to run on 12 or 24 large Binance coins. They now run on `tools/universe.json`:
CoinGecko's top 150 on 2026-10-15, less stablecoins, tokenised funds and gold tokens, each coin
from the exchange the app reads it on (78 Binance, 27 Gate.io, XMR on HTX), plus SAND. Eight
coins have no readable exchange and are named in the file's `noData` (FIGR_HELOC, WBT, BGB, KCS,
BCAP, HASH, OHM, PRL). `TESTED_COINS` lists the 106. Coins listed recently drop out of tests
that need long history (1d: 47–83 coins depending on the test).

Found and fixed on the way: the AI trader rounded prices to 6 decimals, so coins below a
millionth (BTT and others) entered at 0 and showed infinite returns. Prices now keep 10
significant digits (`px` in `js/lib/autotrader.js`); the first 106-coin trader runs were on the
broken engine and were discarded.

A rule used throughout: a published decision changes only when two runs in a row agree. On
this pass the second run was minutes to hours after the first, on nearly the same candles, so
it confirms the measurement, not a new period; the monthly scheduled run is the first on new
data. Each chart's engine test has ten forecast moments shared by every coin (crypto moves
together), so 1,060 forecasts are far fewer independent tests than they look: the 1m 80% range
read 69.9% in one engine run and 83.3% in the next, 90 minutes later.

- **AI trader rules (trader-folds) — every chart now trades the standard rules.** Two runs:
  the chart's own pick beat the standard rules in 0 of 3 blocks on 15m, 1 of 3 on 1h and 4h;
  on 1d it made more (+95.8% against +27.8% a block) with a worst drop 10 points deeper than
  the bar allows. `CHART_RULES` is empty, and `rulesForChart` now applies the standard rule
  keys explicitly, so stale saved values cannot replace them. A third run on the standard
  rules (2026-10-16) is `CHART_TESTED`: 15m +3.21% a 10-day block, 1h +8.55% a 6-week block,
  4h +0.71% a 5-month block, 1d +20.50% an 18-month block; holding the same coins made more
  on every chart (+7.42%, +18.23%, +34.01%, +44.24%). The run four hours before, on nearly
  the same candles, had +6.13/+12.46/+8.31/+27.79% (`previous`): with every coin in one
  account a slightly different start changes which trades are taken, so one run's average is
  rough to within several points, and the Trading page says so. The trader's gain is the
  drop: 1d 19.5% against 59.4% for holding, 4h 30.1% against 40.6% (on 15m and 1h it fell
  further than holding). The 1d account beat holding in 2022–23 by sitting out the fall
  (−10.5% against −54.3%), not by picking winners. On no chart did a buy pick direction
  better than chance; on 15m and 1h a rise followed a buy less often than any candle.
  Volatility sizing (`VOL_SCALE`): 4h, on since the 24-coin run, failed the bar on the
  standard rules twice in a row (objective −0.33, then +0.56), so it is off and `charts` is
  empty; 1d cleared it for the first time (+1.32 points a block, drop 2.4 points smaller) and
  stays off until the next run agrees; 15m and 1h failed. Fee filter: the runs disagreed,
  stays off. Risk levels (`byRisk`): in the third run more risk made more on average on every
  chart at 5% a trade, always with a deeper drop and a worse worst block (1d: drop 43.4% at
  5% against 13.6% at 1%); the Trading page reads its sentence off the rows.
- **Trader rule search (trader-rules, 432 sets):** the current rules beat the older-half pick on
  15m, 1h and 1d; kept. Beats holding on 15m and 1d only. `AUTOTRADER_TESTED`.
- **Per-coin daily rules (selection):** re-picked on 73 coins. Older-half picks on the newer half,
  one account: +265.0% against +155.4% for the daily rules alone, drop 34.1% vs 32.4% — inside
  the bar, stay on. The walk-forward check (49 coins) disagrees: better in 1 of 3 periods
  (+2.7% vs +6.3%); the Settings switch says so. Rotation passed its written bar on daily
  (+139% vs +20% holding) with a 94% worst drop and fees of 128% of the balance; the earlier run
  failed it, so it is still not offered.
- **Forecast direction (engine, two runs):** no edge on any chart; `directionTrust` stays 0.
  `TESTED_ACCURACY.recheck` holds the later run.
- **Price ranges (bands, two runs, 1m added):** centred ranges within 1.3 points of target on
  every chart (1m over ~162,000 ranges: 80% held 79.7%). The 1d 5% widening from the 24-coin
  run failed on 106 coins in both runs (81.0% as drawn, 82.4% wider), so `RANGE_WIDEN` is empty.
  Faster volatility and time-of-day adjustments: still not worth it.
- **Move-size call:** passed on 5m, 15m and 1h in both runs, so 15m joins; 4h and 1d failed both.
- **Learned blend (new step in the engine job):** 49.5% against the forecast's 49.6% on 5,710
  forecasts, better only on 4h; the forecast stays champion. `LEARN_TESTED`.
- **Score readings (new `tools/evaluate-score-buckets.mjs`, 1.58 million candles):** the
  "strong rise so far" reading was followed by a rise least often on every chart (45–46%); a
  higher reading never beat a lower one in both halves. `SCORE_BUCKETS_TESTED`.
- **Score bands as strategies:** each chart's best-looking band, traded one position at a time with
  fees against an entry at every candle under the same exits, on both halves of every coin's
  candles (`tools/evaluate-band-strategy.mjs`, with a fair every-candle control): 1h 45–59
  +0.145R vs +0.093R on the newer half, −0.166R vs −0.115R on the older; 4h 18–29 +0.039R vs
  −0.024R, then −0.012R vs −0.011R; 1d 60–100 +0.176R vs −0.014R, then −0.076R vs −0.032R.
  Each band beat any-candle entries only on the half it was picked from, so none is tradeable
  (`SIGNAL_EDGE_TESTED.*.beatsRandom` false). The old control used 60 fixed moments a coin and
  scored a time-out as 0R; a same-data re-run reading 0.166R then 0.052R is how it was found.
- **Trade-plan levels (geometry), two runs:** on the newer half, entering at every candle, with
  the shipped stops and targets: 15m −0.002R then −0.004R a trade, 1h +0.084R then +0.053R, 4h
  −0.033R then −0.038R, 1d −0.036R then −0.033R (`TRADE_GEOMETRY` holds the later run). The
  daily plan, +0.058R on 12 coins, now loses. The best alternatives were within 0.01R, so the
  levels stay.
- **Timing, history matcher, cross-coin model (timing job):** timing (when a move's high or low
  comes) on all six charts, 3,822 tests: 52.8% against 51.4% for a random guess on the same
  tests (12 coins had read 58.0% vs 54.1%). By chart: 1m 49.4/48.9, 5m 42.7/47.0, 15m
  51.4/48.7, 1h 45.9/44.6, 4h 63.9/61.6, 1d 56.6/53.6. The run before (`previousRun`, no
  per-chart baselines yet) put single charts 1.2–4.0 points away, as much as most of the
  edges, so no chart is labelled "good": `timingTrust` now also needs the edge to exceed that
  swing, and a failing chart points to the measured best one (`bestTimingChart`) instead of a
  hard-coded 4h. History matcher (`ANALOG_TESTED`): below its majority baseline on every chart
  in both runs (second: 1h 50.5% vs 53.4%, 4h 51.0% vs 57.7%, 1d 50.6% vs 56.1%; 44 of 287
  coin/chart pairs beat theirs). Cross-coin model (`tools/evaluate-pooled.mjs`, now printing
  baselines): no model beat naming the training part's commoner direction by more than 1.3
  points on any chart (15m 52.1% vs 51.7%, 1h 51.3% vs 50.0%, 4h 52.2% vs 51.9%, 1d 55.1% vs
  55.6%), so it stays out of the roster (note above `MODEL_INFO` in `js/lib/predict.js`).
- **Outside data (external, momentum):** Fear & Greed, funding (market and coin against coin),
  taker share, momentum and reversal: none held up on 106 coins.

### Cloud sync, trade results and the schema (2026-10-12)
- **Sync** (`js/lib/cloudsync.js`): every synced key merges on its own against a
  fingerprint of the value both sides last agreed on; whichever side changed
  wins, and when both did the cloud's copy is kept. The Trading page's accounts
  and the AI's rules sync too (they used to stay on one device). Demo or real
  trades that only one device had are set aside (`syncBackup`) and the Trading
  page offers them back; two AI accounts meeting for the first time keep the
  one that has run longest, with trades or not. The AI's account counts from
  the moment it starts: it used to count as empty until its first trade, so a
  new device skipped it, started its own and later put that over it (the chart
  and settings changed on the other device seemed to undo themselves). A shared browser never uploads one account's data
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
  sets made money after fees. Source: `AUTOTRADER_TESTED` (kept as the record of that
  single split; the Trading page now shows `CHART_TESTED`, see "Coin selection and
  per-coin rules" below, where 1h and 1d got their own rules).
- Market data hosts are blocked in the cloud sandbox; the Evaluate workflow runs
  the test on GitHub's runners. Read its log for the report.

### Keeping it current (2026-10-13)
- The Evaluate workflow also runs on the 1st of each month (04:17 UTC): trader-folds, bands,
  momentum and the forecast re-check, on fresh candles. Each job writes its result to the run's
  summary page (Actions → Evaluate → the run). Nothing in the app changes by itself: compare
  the summary with `CHART_TESTED`, `FORECAST_TESTED` and `TESTED_ACCURACY.recheck`, and
  re-publish only through the same pre-registered rules.
- The coin page's AI signal box now shows that coin's live server record (ai_signal_log) for
  tracked coins and charts (4h, 1d), with small samples as "k of n".

### Outside data and price factors, tested — none adopted (2026-10-13)
- `tools/fetch-external.mjs` + `tools/evaluate-external.mjs` (Evaluate jobs `external` and
  `momentum`): Fear & Greed (alternative.me, daily since 2018), perpetual funding (Binance's
  public data archive, data.binance.vision), taker-buy share of volume (Binance candles), plus
  3-week momentum and last week's move. 24 coins, 260 weekly dates 2021-10 → 2026-10, one
  date a week, market-wide readings on the average of all coins, per-coin readings as a
  top-third − bottom-third spread on the same date. Bar in the script: same sign in both
  halves and |t| ≥ 2 in the newer half.
- Results: Fear & Greed extreme fear −0.57 / −0.18 pts vs other weeks (t −0.1); extreme greed
  and market-wide funding extremes too rare (2–12 weeks per half); funding spread +0.25 / −0.31
  (flips); taker-buy spread +0.22 / +0.54 (t 1.59); momentum +1.07 (t 2.31) / −0.07 (gone in the
  newer half); last week's move +0.41 / +0.95 (t 1.82). Nothing cleared the bar, so nothing was
  added to the forecast or the trader. Re-run the jobs before trying any of these again.

### Live AI-signal record and AI-signal alerts (2026-10-13, server)
- Table `ai_signal_log` (public read, server write): one row per closed 4h/1d candle of the
  tracked coins — what the AI signal said (`aiSignalRow()` in the shared engine, the same
  `aiSignal()` the coin pages use), graded `horizon_bars` later (`fwd_up`, `fwd_ret_pct`) by the
  `track-signals` cron. Rows are never rewritten. Track page → "AI signal, live" counts only
  trades bought after tracking began on a coin (`js/lib/airecord.js`).
- AI signal alerts live in their own table `ai_alerts` (owner-only RLS, the same 3/50 limit
  counted across `alerts` + `ai_alerts`), so the existing alerts table is untouched.
  `alerts-check` sends Telegram/e-mail when the AI signal buys or sells on the candle that
  just closed (side long = buys, short = sells). Delivery still needs the Telegram/Resend keys
  under Admin → API keys.
- Applied 2026-10-13 with `execute_sql` (the migration tool timed out on every attempt; a
  statement set containing DROP waits for a confirmation that a remote session cannot give),
  recorded in `supabase_migrations.schema_migrations` as 20261013010000.
- `js/lib/autotrader.js` is now mirrored to `supabase/functions/cv/engine/autotrader.js`
  (parity test and `tools/deploy-backend.sh` check it).

### Price-range calibration at scale (2026-10-13)
- `tools/evaluate-bands.mjs` (Evaluate job `bands`): the centred ranges built with the
  engine's own `rollingSigma` + `empiricalBandQuantiles`, 24 coins, 5m–1d, every
  non-overlapping horizon (~28,000 tests). 80% range held 5m 76.5%, 15m 80.0%, 1h 79.0%, 4h
  78.9%, 1d 77.2%. A width factor fitted on each series' older half (pre-registered rule) did
  not improve the newer half anywhere (1h and 4h picked 1.1 and overshot to 82.8–83.1%), so
  the ranges are unchanged. `FORECAST_TESTED.centred` now carries these figures and counts.
- Same day, re-run: 5m flipped to "use 1.1" an hour later — its verdict rested on ~9 days of
  5m candles and sat between 1 and 1.1. The job now downloads ~100 days of 5m and 15m and the
  factors step by 0.05 (rule unchanged). Run 38330515049: 5m 79.8% (57,000 tests) and 15m 79.8%
  (31,488) — the short charts are calibrated; the old 76.5% was the 9-day sample. 1h 78.5%,
  4h 78.9%: keep. 1d picked 1.05 and it helped the newer half (80% range 75.8% → 77.4%, 50%
  47.9% → 49.8%, 90% 86.9% → 88.5%), so 1d's centred range is drawn 5% wider
  (`RANGE_WIDEN` in js/lib/forecastview.js; display only, the raw forecast is unchanged).
  It is a small correction on the same daily data, consistent with 1d being narrow in every
  test so far (72.5% in the engine test); the monthly re-test will show if it holds.
- Narrower ranges? `tools/evaluate-volatility.mjs` (second step of the `bands` job) builds
  the same ranges on an exponentially weighted volatility (λ 0.97 and 0.94) instead of the
  100-candle one and scores them with the interval score (width + 2/α × miss; lower is
  better). Bar set before the run: pick on the older half, use only if the newer half scores
  ≥2% lower with the 80% range no more than a point further from 80%. Run 38331888912: the
  weighted estimate was better on every chart but only by 0.1–1.6% (5m 1.6%, 15m 0.9%,
  4h 0.9%, 1h 0.6%, 1d 0.1%), so the 100-candle volatility stays.
- Time of day? `tools/evaluate-seasonal.mjs` (third step of `bands`): each move divided by
  the usual size of moves at that UTC hour (own hour, or averaged with its neighbours), the
  range scaled back up by the hours the horizon covers. Same bar. Run 38334429875: newer-half
  score 5m −1.7%, 15m −0.7%, 1h −0.4%, 4h 0% — below 2% everywhere, so not used. The ranges
  are calibrated and near what simple volatility models give; neither change is worth the
  extra engine code.

### Volatility-scaled position size (2026-10-13)
- `cfg.volScale` (autotrader): the position × max(0.5, 1 / ratio) while a coin's 100-candle
  volatility is above its own slow average (`volRatio()`, past candles only), applied after
  the caps (on short charts the 25%-a-coin cap binds before the risk setting).
- A/B in `tools/evaluate-trader-folds.mjs` on the rules each chart ships, bar written before
  the run (better on return − ½·drop in ≥2 of 3 blocks, by ≥1 point, return ≤1 point lower).
  4h cleared it (3 of 3; +0.82 points a block, worst drop −2.46) and uses it; 15m (gain 0.64),
  1h (1 of 3) and 1d (1 of 3 — one block +13 points) did not (`VOL_SCALE`). Your own rules
  never get it. CHART_TESTED for 4h predates it; the expected-yield box says so.

### Worst drop with open trades counted; trader re-run (2026-10-13)
- Every "worst drop" used to count only closed trades (the equity curve was the cash
  balance), which hid every fall a trade recovered from before it closed. Now
  `replaySeries(..., { onBar })` lets a test watch every candle, `dropTracker(state)` values
  open trades at each close, and the live account's equity curve does the same
  (`markEquity` uses the latest close seen, `state.px`), so Max drawdown on the Trading
  page and "Test these settings" are the real ones. The rules are still picked, and the
  bars judged, on the closed-trade drop (`ddClosed`), as the bars were written.
- `tools/evaluate-trader-folds.mjs` records both and holding's worst drop. Run 38380270716
  (now `CHART_TESTED`, `VOL_SCALE`): worst drop with open trades / closed only / holding —
  15m 9.26 / 7.09 / 9.86%, 1h 15.29 / 12.97 / 13.79%, 4h 27.05 / 24.59 / 38.39%,
  1d 19.69 / 14.22 / 63.97% (block averages). The trader's real benefit is on 1d and 4h:
  it fell far less than holding. Returns: 15m +6.88% vs hold +7.19% a 10-day block, 1h
  +6.69% vs +15.22%, 4h −1.81% vs −10.59%, 1d +16.26% vs +10.71%.
- Decisions: 1h and 1d adopt again with the same picks; 4h keeps the standard rules (1 of
  3); volScale stays on 4h only (3 of 3, +0.15 points, drop −2.29). 15m cleared the bar
  (2 of 3, +2.67 points) with the same pick as the run before it ("breakout+confirm 3ATR r3
  SX"), so it now trades that pick — the test pins shipped rules to the published figures.
- AI-signal records (shipped rules): higher H candles after a buy 15m 45.7% vs 50.4% any
  candle, 1h 46.3% vs 50.4%, 4h 46.6% vs 47.6%, 1d 48.3% vs 46.9% — still no edge.
- Fills: the tests fill at the candle's price with the 0.1% fee and nothing for spread or
  slippage. Re-run 38383284767 (same decisions) also ran the shipped rules with fills 0.05%
  worse each way: −1.55 points a block on 15m, −1.62 on 1h (a quarter of its +6.5%), −1.36
  on 4h, −1.18 on 1d (`fillCost`, shown on the Trading page and in the yield box). The test
  coins are today's survivors, which flatters every result; the page says so too.
- That run's volScale A/B on 15m used the standard rules (shipped then); `SHIPPED` now says
  own, so the next run tests 15m's own rules.
- `PER_COIN_RULES` re-run the same way (job `selection`, run 38381368027): each coin's own
  daily rules +89.77% vs +33.31% for the daily rules alone (newer half 2023-10-10 →
  2026-10-13), worst drop with open trades 40.15% vs 35.6% (closed only 34.69% vs 29.25%),
  holding +83.6% with a 72.2% drop. The first run a day earlier: +46.04% vs +36.95%. The
  closed-trade drop is now 5.44 points deeper — just outside the 5-point bar, which makes it
  "offer as opt-in". **Policy: a published decision changes only when two runs in a row
  agree** (15m above had two), so the per-coin rules stay on until the next run; if it also
  says opt-in, default them off (`ownRulesOff` → an opt-in flag). Same for the 4h per-coin
  walk-forward, which said adopt (2 of 3) for the first time. The Trading page states the
  first run's figure beside the new one.

### AI signal, forecast display and accuracy figures (2026-10-12/13)
Measured first (Evaluate jobs `trader-folds` and `engine`), then shown as measured:
- **AI signal** (coin page, top of Trade signal): `aiSignal()` replays the chart's published
  rules (never the user's own settings) on the coin's closed candles, one trade at a time →
  BUY / HOLD / SELL / WAIT with entry, stop and exit rule. Its record is
  `CHART_TESTED[chart].signals`: every coin alone, blocks the rules were not picked on. **No
  chart beat chance on direction** (price higher H candles after a buy: 15m 45.6% vs 50.3%
  any candle, 1h 47.0% vs 50.1%, 4h 46.7% vs 47.6%, 1d 48.3% vs 47.0%) and on none did a buy
  beat a random buy held as long (1d +0.96% vs +1.82% a trade). The 1d account beat holding
  by sitting out the 2022 fall (+3.3% vs −56.9%). The card says so; never present a BUY as a
  forecast that the price will rise. It also lists the rule's last 5 trades on that coin's
  own candles (fees included, against holding the coin), labelled as flattered because the
  rules were chosen on history that includes them; nothing at all on demo/CoinGecko data.
  The scanner has the same signal as a column, sortable, with a "BUY or HOLD" filter.
- **No lean where the direction is not reliable** (`js/lib/forecastview.js`): ranges, path,
  chart cone, scanner ranges and assistant facts are centred on today's price; no target or
  expected move. Centred ranges held as well or better on every chart (1h 81.7% vs 82.5% with
  the lean; 5m 83.3% vs 78.8%); the daily 80% range is too narrow either way (72.5%). Timing
  (`priceless`) states only when the high/low came, never a price or "strength" — the timing
  test measured the bar, not the direction. The raw forecast still goes to the ledgers.
- **Move-size call** (`moveSizeCall()`): volatility now vs the coin's normal. Offered as a call
  only on 5m, 1h, 4h, where the move after a "bigger" call was 1.4–1.6× usual vs 0.8–1.0× after
  "smaller" (`FORECAST_TESTED.move`); elsewhere only the usual move size is shown.
- **Removed as accuracy:** the forecast's per-coin recent check ("tested accuracy 71% on 87
  unseen cases", and its "beats the baseline" note). When it read 60%+ forecasts were right
  49.5% (196); otherwise 49.7% (1,244) — no information. Direction figures on the page now
  come from one place: `TESTED_ACCURACY.recheck` (summary.js `accuracyOn`, advice page,
  risk warnings). The history method's per-coin rate now shows its test count and 95% range.
- 15m flipped again on the re-runs (own rules would have been adopted); the published
  decision (standard rules) stands — re-running until a bar is cleared is not evidence.

### AI trader settings and expected yield (2026-10-12)
- Settings now take effect and say what they do: every chart in `TRADER_CHARTS`
  (untested ones are labelled so), up to `MAX_COINS` (30) from the top 100, quick picks,
  risk 0.1–5%, max open 1–20, max in one coin 5–100%, fee, tested rules or **your own
  rules** (`strategy: 'custom'`, traded exactly as set: no chart rules, no trend lesson, no
  per-coin rules). A chart change on an account with trades offers a fresh account at
  once (default) instead of silently waiting for Reset. Every change is written to the
  activity log ("Settings changed — …").
- Exchange data (`js/api/http.js`, `js/api/market.js`): a host is rested for 15 s only after
  three network failures in a row (it was one: a single timed-out or refused request made every
  coin on that exchange fail for 15 s — no chart, no forecast, coins skipped by the AI). A coin is
  remembered as listed nowhere (6 h) only when the exchanges answered; Gate.io's "no such pair"
  has no CORS header, so it reads as a failed request and counts as a "no" only next to a real
  answer from HTX or OKX. `knownVenue()`/`findVenue()` say where a coin's candles come from;
  symbols no exchange uses (FIGR_HELOC) are listed nowhere. A coin page for such a coin says so.
- AI checks after the first ask only for new candles (`js/lib/candlecache.js`): a handful per
  coin instead of 500, merged into the window a full fetch would return (tested); a hole, a
  change of exchange or a pause of six hours fetches the whole window again. The exchange
  already found for a coin only has to send what was asked (discovery still wants 50 candles).
- The forecast-record cards were titled "Self-improving model" with an "improving" chip. Keeping
  score does not make the forecast better, so they are now "This device's forecast record", the
  chip says "last 20 better/worse" (`TREND_WORDS`), and the Learn page says none of the learning
  has beaten chance in testing.
- Trader coin picker: coins listed nowhere show "no exchange" and cannot be picked; others not
  on Binance show the exchange found. Quick picks: Top 10/20 and All (`MAX_COINS` = 100, the
  whole list) pass over coins with no data; "The 24 tested" picks `TESTED_COINS`. "Use the best
  tested setup" sets exactly what the published test ran (best chart, tested rules, 1.5% risk,
  5 open, 25% a coin, the tested coins). `settingsWarnings()` also flags more than 25% in one
  coin and coins outside the test.
- A new starting balance applies at once (`rescaleAccount()`): the balance, every position
  and trade and the balance curve are scaled by the ratio, so results in % are unchanged;
  trades are sized as a share of the balance, so these are the trades the AI would have
  made with that much (tested against a replay started with it). It used to wait for the
  next Reset, and when it was the only change it was not even saved. The field is in the
  currency the page shows (it was dollars under a rupee display) and the form no longer
  blocks amounts that are not a multiple of 100 (`novalidate`; `read()` clamps every value).
- "What to do" box: best tested setup (`bestTestedChart()`: most test blocks with a gain,
  then most above holding, then smallest drop → 1d), warnings (`settingsWarnings()`), and
  **Expected yield** (`expectedYield()`): average, worst and best block, worst drop, blocks
  up and trades a block at the chosen risk, read off `CHART_TESTED[chart].byRisk` (each
  walk-forward block replayed at 0.5/1/1.5/2/3/5% risk, Evaluate job `trader-folds`). Null
  for custom rules or untested charts — nothing measured, so nothing promised.
- Measured by risk: past 2% a trade more risk made at most +0.4 points a block (15m) and
  less on 1h, 4h and 1d. 15m and 1h about flat above ~1.5–2% (the 25%-a-coin cap binds first), 4h best at 0.5% and worse at every step up
  (−11.3% a block at 5%), 1d best at 1–2% (+16.1 to +17.8%) and +9.4% at 3%. The risk
  table is read off the test periods themselves, so it is labelled a guide; the default
  (1.5%) was not changed on it.
- "Test these settings" replays the exact settings on the last 1,000 candles of each
  chosen coin with the live engine (`backtestSettings()`); labelled as in-sample.
- The assistant answers "what can my AI trader make?" with the same `expectedYield()`.

### Track record plan scoring (2026-10-12)
Plans are scored the way the long plan's own exit rules say to manage them
(`js/lib/planscore.js`, mirrored to `supabase/functions/cv/engine/`): half closes
at target 1, the stop on the rest moves to entry, the rest closes at target 2,
back at entry, or at the horizon. The old scorer counted a stop after target 1 as
a full loss and a target-2 finish as the whole position at target 2, and the
Track page claimed that was "more pessimistic" than the plan, which it was not
overall. `signal_log.plan_v` marks the rule a row was scored by (1 old, 2 new);
`track.ts` re-scores six old rows per run, newest first, and the page says how
many of the rows it shows still carry the old scoring.

### Coin selection and per-coin rules, measured (2026-10-12)
`tools/evaluate-selection.mjs`, run by the Evaluate workflow (job `selection`) on fresh
Binance candles for 24 coins. Everything is chosen on older candles and judged on newer
ones; each bar to adopt was written in the script before the run.
- **Strongest-coins rotation (`js/lib/rotation.js`) — REJECTED.** The setting picked on
  the older daily half (14-day look-back, top 1, every 3 days, BTC filter) made +2,658%
  there and −43.8% on the newer half, against −24.0% for holding the same coins (4h:
  −6.7% against +32.9%). The module and its tests are kept; it is not offered.
- **Per-chart AI-trader rules — 1h and 1d adopted.** `tools/evaluate-trader-folds.mjs`
  (job `trader-folds`): each chart's history in four blocks; three times the best of 432
  rule sets on everything before a block (24 coins in one account, shared cash, fees)
  runs on that block next to the standard rules. Bar, in the script: better in 2 of 3
  blocks, by ≥1 point on average, average worst drop no more than 5 points deeper.
  1h: +8.21% vs −0.19% a 6-week block (drop 12.09% vs 15.76%) — adopted. 1d: +16.64% vs
  +12.72% an 18-month block (drop 14.22% vs 16.95%) — adopted. 4h: 0 of 3 — kept.
  (Figures from the re-run that also measured six risk levels, below; the first run made
  the same decisions and picks: 1h +7.12% vs +1.27%, 1d +16.97% vs +13.03%.)
  15m: cleared the bar on a first run, not on a re-run 20 minutes later (10-day blocks)
  — kept. `CHART_RULES` holds the picks made the same way on the full history;
  `CHART_TESTED` the block averages the Trading page shows. Never publish a result of
  `CHART_RULES` on candles it was picked on: the daily pick scored +347% on the newer
  half it had seen, against +17% a block out of sample. A test pins the shipped rules to
  the bar (`tests/autotrader.test.mjs`).
- The trend filter is no longer carried over from saved settings: `rulesForChart()` reads
  the self-review's latest trend lesson instead, because a saved value cannot tell a
  learned setting from an old default.
- **Per-coin AI-trader rules — on for daily accounts, opt-out in Settings.** Walk-forward
  (single-coin accounts): 1d better in 3 of 3 periods, +2.94% against +1.32% a period;
  1h and 4h rejected. In the account (24 coins, newer half 2023-10-09 → 2026-10-12, every
  rule — the daily standard included — chosen on the older half): +46.04%, worst drop
  33.2%, against +36.95% and 29.25% for the daily rules alone; holding made +88.69%.
  Inside the bar (no more than 5 points deeper), so on by default. (Against the old
  standard rules it had been +66.45% vs +53.89% with a 9.7-point deeper drop, so it was
  opt-in for an hour; the setting is stored as `ownRulesOff` so saves from that hour do
  not count as opting out.) The table was chosen on each coin's full history against the
  daily rules. It follows the chart the account runs on (changes only on Reset).
- The 24 coins are today's survivors; that flatters every backtest that holds them.

### The track record's forecast variant (2026-10-12)
- `supabase/functions/cv/track.ts` logs `forecast(..., { fast: true })` on 700 candles to stay in
  the edge function's time limit; coin pages run the full model on 1,500. On simulated candles
  the two agreed on direction in 60 of 60 cases, probabilities ~10 points apart; the Track
  page says so. Live record (2026-10-12): 4h 53.4% vs 53.0% baseline over 2,115 calls (177
  candles), 1d 51.7% vs 55.0% over 240 — consistent with the release test's zero direction
  trust on both, so nothing in the app's trust changed. 1m/5m/15m, the only charts with
  some direction trust, are not logged live; adding a 15m plan to `app_settings.tracking`
  would check them, at the cost of more forecasts per run (CPU limit) — not done without
  the owner's say-so, since it changes their database settings.

### Updates that load, settings that stick, coins it cannot trade (2026-10-13)
- **Updates.** `checkForUpdate()` (js/app.js) used to unregister the service worker and
  reload; the reload then took modules from the browser's HTTP cache (GitHub Pages sends
  max-age=600), so a tab could stay on the old build for the whole visit (one try per build).
  It now fetches every app file again with `cache: 'reload'` (the list comes from
  `DEPS`), asks the service worker to update, clears Cache Storage and reloads — and
  retries a build after ten minutes, since Pages' servers can lag a deploy. The footer
  shows the running build (`#buildTag`).
- **Settings across tabs.** A second open tab kept its old `cfg`/`state` in memory and
  saved them back at its next check or Save. The Trading page now listens for `storage`
  events on `traderCfg`/`traderState` and takes the newer copy (no check is started, so
  two tabs cannot trigger each other).
- **Coins it cannot trade.** A coin with no price data from any exchange the app reads
  (FIGR_HELOC, WBT…) used to raise "No data for … — skipped" on every five-minute check.
  The toast now shows once per visit; a coin failing two checks in a row while others
  loaded (`traderNoData` in localStorage — never during an outage, never on demo data) or
  having only CoinGecko prices gets a notice on the page with "Remove them from the list",
  and a "no data" tag in Settings.

### AI-signal alerts reach the open site (2026-10-13)
- The server records every AI-alert firing on the row (`triggered_at`, `triggered_price`)
  whether or not Telegram or e-mail is set up. `showTriggeredServerAlerts()` (js/app.js)
  now reads `ai_alerts` too and shows each new firing once (toast + browser notification if
  allowed; remembered in `seenAlerts` as `ai:<id>:<time>`), on sign-in and every two minutes
  while the tab is visible. So AI alerts work for anyone with the site open before the
  Telegram/Resend keys are added. `ai_alerts.triggered_action` (migration
  20261013120000, nullable) records which way it fired, so "any" alerts say BUY or SELL;
  rows fired before it fall back to the alert's side.

### Backend deploy as it stands (2026-10-13)
The live edge function `cv` (version 15) is a one-line entry that imports
`supabase/functions/cv/index.ts` from a pinned commit on raw.githubusercontent.com
(2632934: the open-trade drop tracker, the re-measured tables with 15m's own rules, and
`ai_alerts.triggered_action`; version 14 was 096f103, the live AI-signal record and alerts),
so what runs is exactly what was committed. Verified after each deploy: every call 200 and
the next track run writing signal_log and ai_signal_log rows. To deploy newer server
code, change the hash in that entry (or run `tools/deploy-backend.sh`), then check
`/functions/v1/cv/selftest` returns 200. CI's `server` job boots the function with Deno and
no database (`tools/server-smoke.sh`) and fails if it does not start or its selftest differs
from the site's engine. (`deno check` is not used: the JavaScript engine's inferred types
give ~66 errors that are not bugs.) Vault holds `cron_secret` and
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
- **106-coin re-measure, 2026-10-15/16 — supersedes the lines below where they differ.** See
  "Every model re-measured on all 106 tradable coins" above. Sources of truth: `TESTED_ACCURACY`
  (+ `.recheck`) in `js/lib/predict.js`, `FORECAST_TESTED` and `RANGE_WIDEN` in
  `js/lib/forecastview.js`, `CHART_TESTED`, `CHART_RULES`, `VOL_SCALE`, `PER_COIN_RULES` and
  `AUTOTRADER_TESTED` in `js/lib/autotrader.js`, `SCORE_BUCKETS_TESTED`, `SIGNAL_EDGE_TESTED` and
  `GEOMETRY_TESTED` in `js/lib/signals.js`, `LEARN_TESTED` in `js/lib/learncenter.js`,
  `TESTED_TIMING` in `js/lib/timing.js`, `ANALOG_TESTED` in `js/lib/analog.js`.
- **Forecast direction, re-checked 2026-10-12** (`TESTED_ACCURACY.recheck`, Evaluate job `engine`,
  1,440 fresh forecasts): 1m 54.2% vs 66.3% baseline (trust 0.05), 5m 52.1% vs 65.0% (0),
  15m 47.1% vs 57.9% (0), 1h 50.8% vs 59.6%, 4h 51.2% vs 52.5%, 1d 43.3% vs 52.1%. Each
  chart keeps the smaller of its release-test and fresh trust (set before the run), so 5m and
  15m no longer show a direction and 1m only ~51/49. Ranges still roughly hold (80% band
  72–84%).
- **AI trader (Trading page, 2026-10-12):** `CHART_TESTED` (walk-forward block averages per
  chart, 24 coins) and `PER_COIN_RULES.tested` (daily account, per-coin rules on) in
  `js/lib/autotrader.js`. Re-measure with the Evaluate workflow, jobs `trader-folds` and
  `selection`; `tests/autotrader.test.mjs` fails if the shipped chart rules stop matching
  the published bar.
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
- Timing peak-hit (superseded 2026-10-16 by 52.8% vs 51.4% on 3,822 tests and 106 coins): 58.0% vs 54.1% random
  (931 tests, 12 coins) — 5m 52.6% vs 48.7%, 15m 48.6% vs 49.0% (no edge), 1h 52.5% vs 46.8%, 4h 68.7% vs 61.8%,
  1d 56.1% vs 55.0%. Source of truth: TESTED_TIMING in js/lib/timing.js.

### Assistant and advice fixes (2026-09-25)
- `adviseCoin` scales the score by the evidence behind it (divides by `max(total weight, 1)`), so one barely-trusted reading can no longer produce "BUY, conviction 100/100".
- The forecast's weight is measured against the per-coin baseline (always naming the commoner direction), not 50%, and counts a quarter on timeframes where the published walk-forward test found no edge (`TESTED_ACCURACY.noEdge`).
- `js/lib/tickers.js`: ambiguous tickers (near, link, dot, etc, op…) count as coins only in capitals, with a `$`, or next to a trading word. "Which coin looks strongest" no longer resolves to LooksRare, and "near term for BTC" no longer turns into BTC vs NEAR.
- Tools page (`#/tools`, `js/lib/calc.js`): converter, DCA backtest, position sizer.
