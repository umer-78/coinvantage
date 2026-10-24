// The automatic AI trader — in paper mode.
//
// It runs the same rules the backtest publishes, by itself, on live prices:
// it opens positions when the signal and the model agree, sizes each one so a
// stop-out costs a fixed small fraction of the balance, moves the stop to
// break-even at +1R, and closes on the stop, the target, or a signal reversal.
//
// IT TRADES SIMULATED MONEY ONLY. There is no exchange connection, no API key,
// no order of any kind. The point is to show honestly what the strategy would
// have done — including the losing runs — not to move anyone's funds.
//
// It also catches up: when the site is reopened, `replay` walks the candles
// that happened while the tab was closed, so the record stays continuous
// instead of only counting the hours someone had the page open.

import { computeAll, atr, ema } from './indicators.js';
import { scoreAt, labelFor, THRESHOLDS } from './signals.js';

/**
 * What this ruleset actually did on real candles.
 *
 * Measured 2026-10-15 with tools/evaluate-trader-rules.mjs (the Evaluate
 * workflow) on every coin the app trades that has the candles (106 on 15m,
 * 104 on 1h, 103 on 4h, 83 on 1d), each from the exchange the app reads it on
 * (Binance, Gate or HTX; 4,000 candles each on 15m and 1h, 3,500 on 4h, 2,200
 * on 1d). All coins advance together, candle by candle, through the same
 * engine the live account runs, fees included; open positions at the end are
 * valued at the last close. The numbers are the NEWER half of each history,
 * which played no part in choosing anything.
 *
 * 432 rule sets were tried against these: trend, breakout and buy-the-dip
 * entries, momentum confirmation, a filter that pauses buying while Bitcoin is
 * in a downtrend, stops of 1.5-3 ATR, fixed and trailing exits. The one with the
 * best average rank on the OLDER halves (`alt`) did worse than the current rules
 * on the newer halves on 15m, 1h and 1d and better on 4h, so the current rules
 * stay; the 12-coin run on 2026-10-12 decided the same. On 15m only 35 of the
 * 432 made money after fees.
 *
 * The benchmark is equal-weight buy-and-hold of the same coins over the same
 * window: the rules beat it on 15m and 1d and not on 1h or 4h, where holding
 * made +60% and +161%. The coins are today's survivors, which flatters holding
 * them and every backtest of them.
 */
export const AUTOTRADER_TESTED = {
  '15m': { pickedReturn: 4.86, buyHold: 1.05, maxDrawdownPct: 17.8, trades: 222, winRate: 22.5, feeDragPct: 8.9, from: '2026-09-24', to: '2026-10-15', alt: { ret: -9.58, dd: 11.39 }, madeMoney: 35, coins: 106 },
  '1h': { pickedReturn: 26.52, buyHold: 59.55, maxDrawdownPct: 22.02, trades: 209, winRate: 29.7, feeDragPct: 8.9, from: '2026-07-24', to: '2026-10-15', alt: { ret: 4.74, dd: 15.87 }, madeMoney: 172, coins: 104 },
  '4h': { pickedReturn: 28.14, buyHold: 161.26, maxDrawdownPct: 29.44, trades: 178, winRate: 27.5, feeDragPct: 5.9, from: '2025-12-28', to: '2026-10-15', alt: { ret: 53.07, dd: 14.74 }, madeMoney: 218, coins: 103 },
  '1d': { pickedReturn: 170.55, buyHold: 123.78, maxDrawdownPct: 21.79, trades: 128, winRate: 37.5, feeDragPct: 4.5, from: '2023-10-12', to: '2026-10-15', alt: { ret: 150.79, dd: 23.19 }, madeMoney: 384, coins: 83 },
  coins: 106, configs: 432, measuredOn: '2026-10-15',
  altRules: 'breakout entry with the Bitcoin-trend filter, 3 ATR stop, 2R target, no exit on a signal reversal',
  beatsBuyAndHold: false,
  // The self-review (js/lib/tradelearn.js), measured 2026-09-26 with
  // tools/evaluate-trader-live.mjs: it acted in 1 of 8 held-out runs (4h, older
  // rules: -10.9% -> -7.2%) and left the rest unchanged. Too few cases to call
  // an edge: it is a safety net, not a boost.
  selfReview: { runs: 8, acted: 1, note: 'Changed its rules in 1 of 8 held-out runs (4h: −10.9% → −7.2%); no change in the other 7.' },
};

/**
 * Rules picked for one chart. tools/evaluate-trader-folds.mjs (all coins in
 * one account, shared cash, fees) cuts each chart's history into four blocks
 * and three times picks the best of 432 rule sets on everything before a
 * block, then runs it on that block next to the standard rules. The bar, set
 * before the first run: better in two of three blocks, by a point on average,
 * worst drop no more than five points deeper; and, as for every published
 * rule, a change needs the latest two runs to agree. On 24 coins 1h and 1d
 * cleared it in every run and 15m in the last two, so they traded their own
 * picks. On all 106 coins (2026-10-15 and 16) none did. 15m's pick then
 * cleared it on 2026-10-22 and 23 (the second with the new exits,
 * CHART_EXITS), was held back for a run that also measured what worse fills
 * cost it, and failed in that run (2026-10-24: better in 1 of 3 blocks,
 * -10.61% against -3.87% a block). 1d's failed on 2026-10-22 (worst drop 0.6
 * points over the bar) and 23 (1 of 3) and cleared it on 24. With the latest
 * two runs split on both, every chart trades the standard rules (each coin's
 * own daily rules, PER_COIN_RULES, still apply on 1d). An entry here
 * overrides them on its chart.
 */
export const CHART_RULES = {};

/**
 * When to sell, tested on its own (tools/evaluate-exits.mjs, all coins with
 * enough history in one account per chart, after 0.15% a side for fees and
 * worse fills). Under the standard exits about a third of trades end by the
 * rule that sells after two candles reading against the trade, and only about
 * one in ten of those sales wins (−0.43 to −0.52R each, against −1.0 to −1.2R
 * for the stop-loss and +2.8 to +3.0R for the target). That rule alone was
 * switched off, nothing fitted, on each chart's three walk-forward blocks, with
 * the bar set before the first run: better in at least two of three blocks, by
 * at least a point a block, worst drop no more than five points deeper — and,
 * as for every published rule, two runs in a row agreeing. 15m and 4h cleared
 * it in both runs, so they no longer sell on weak candles. 1h did not: one run
 * gave +17.3 points a block (3 of 3), the next, one day of data later, −10.4
 * (0 of 3). 1d did not either. Gains and drop changes are points a block.
 */
export const EXITS_TESTED = {
  runs: ['2026-10-22', '2026-10-23'], cost: 0.15,
  sellOnWeakOff: {
    '15m': [{ better: 3, gain: 11.31, ddDiff: -4.88 }, { better: 2, gain: 3.63, ddDiff: -4.01 }],
    '1h': [{ better: 3, gain: 17.28, ddDiff: -6.12 }, { better: 0, gain: -10.38, ddDiff: -1.27 }],
    '4h': [{ better: 2, gain: 9.13, ddDiff: -2.21 }, { better: 2, gain: 3.88, ddDiff: -7.61 }],
    '1d': [{ better: 2, gain: 3.72, ddDiff: -1.46 }, { better: 1, gain: 0.91, ddDiff: 0 }],
  },
  // how trades ended under the standard exits (second run): count, average R, share that won
  exits: {
    '15m': { stop: [155, -1.23, 0], weak: [127, -0.52, 11], target: [46, 2.82, 100] },
    '1h': { stop: [138, -1.1, 0], weak: [107, -0.45, 10.3], target: [66, 2.9, 100] },
    '4h': { stop: [129, -1.05, 0], weak: [105, -0.49, 7.6], target: [60, 2.95, 100] },
    '1d': { stop: [61, -1.02, 0], weak: [62, -0.43, 6.5], target: [46, 2.97, 100] },
  },
};
/** The exit changes that cleared that bar twice: an entry here overrides the standard exits on its chart. */
export const CHART_EXITS = { '15m': { signalExitBars: null }, '4h': { signalExitBars: null } };

/**
 * That test's results (run 2026-10-24 on all 106 coins, the standard rules
 * traded on every chart, with the exits in CHART_EXITS), averaged over its
 * three blocks: `standard` is the standard rules, `own` the chart's own pick,
 * `hold` equal amounts of every coin held through the block. `coins` is how
 * many had candles for the chart's whole test (fewer on 1d: many coins are
 * younger than its four years). Returns, drops and fees are % of the balance
 * per block; trades are the total over the three. `dd` is the worst drop with
 * open trades valued at every candle close — what the account would have
 * shown; `ddClosed` counts only closed trades, the measure the rules were
 * picked and the bar judged by. `holdDrop` is holding's worst drop, measured
 * the same way. `range` and `up` are the worst and best block and the blocks
 * with a gain, for the rules the chart trades. `byRisk` is the same test with
 * every block replayed at six risk levels (same rules, 5 open at most, 25% a
 * coin): average, worst and best block, average worst drop, blocks with a
 * gain, trades a block. `fillCost`: points a block the rules lost with every
 * fill 0.05% worse each way (spread and slippage, which the test otherwise
 * leaves out). `cleared`: whether the chart's own pick cleared the bar in
 * this run; `adopt`: whether it is traded, which needs the latest two runs to
 * agree (CHART_RULES).
 *
 * `previous`: the run the day before, on the same rules and nearly the same
 * candles. 15m went from -10.64% to -3.87% a block, 1h from -0.22% to -2.72%,
 * 4h from +4.23% to +2.93% and 1d from +29.18% to +20.31%: with every coin in
 * one account, a slightly different start changes which trades get taken, and
 * the result follows. A single run's average is rough to within several
 * points, and the Trading page says so.
 *
 * `signals`: what followed each buy of those rules on its own (every coin run
 * alone, one trade at a time). R is the result over the amount risked at
 * entry, fees included; `fwdUpPct` the share of buys followed by a higher
 * price H candles later (95% range fwdLo–fwdHi) against `baseUpPct` from any
 * candle; `randPct` a buy at a random candle of the block held as long. On no
 * chart did a buy pick direction better than chance (on 15m and 1h a rise
 * followed less often than after any candle), and on none did it beat a
 * random buy held as long: the 1d account beat holding when prices fell by
 * sitting out (−10.4% against −53.9% in 2022–23, a worst drop of 18.6%
 * against 64.4% for holding), not by picking winners, and holding made more
 * over the three blocks on every chart. The coin page shows it.
 */
export const CHART_TESTED = {
  measuredOn: '2026-10-24', coins: 106, configs: 432, blocks: 3,
  '15m': {coins: 106, range: [-7.83, -0.99], up: 0, from: '2026-09-23', to: '2026-10-24', block: '10 days', better: 1, cleared: false, adopt: false, hold: -2.22, holdDrop: 9.63, fillCost: 1.38, previous: { ret: -10.64, better: 3, cleared: true, measuredOn: '2026-10-23' }, standard: {ret: -3.87, dd: 13.33, ddClosed: 11.66, trades: 206, win: 19.9, fees: 2.63}, own: {ret: -10.61, dd: 17.42, ddClosed: 15.34, trades: 379, win: 22.16, fees: 4.7},
    byRisk: { '1': {ret: -6.01, lo: -8.36, hi: -2.65, dd: 13.67, up: 0, trades: 69}, '2': {ret: -3.98, lo: -8.94, hi: 0.57, dd: 13.86, up: 1, trades: 68}, '3': {ret: -5.76, lo: -12.36, hi: 0.51, dd: 16.11, up: 1, trades: 71}, '5': {ret: -6.28, lo: -12.36, hi: 0.36, dd: 16.49, up: 1, trades: 71}, '0.5': {ret: -5.81, lo: -10.06, hi: -2.98, dd: 9.99, up: 0, trades: 69}, '1.5': {ret: -3.87, lo: -7.83, hi: -0.99, dd: 13.33, up: 0, trades: 69}},
    signals: {n: 2042, winPct: 18.46, avgR: -0.4, avgWinR: 2.87, avgLossR: -1.14, holdMedian: 30, avgPct: -0.54, randPct: 0.21, H: 8, fwdN: 2041, fwdUpPct: 42.87, fwdLo: 40.74, fwdHi: 45.03, baseUpPct: 47.06}},
  '1h': {coins: 103, range: [-10.11, 11.29], up: 1, from: '2026-06-21', to: '2026-10-24', block: '6 weeks', better: 1, cleared: false, adopt: false, hold: 14.86, holdDrop: 12.89, fillCost: 2.21, previous: { ret: -0.22, better: 1, cleared: false, measuredOn: '2026-10-23' }, standard: {ret: -2.72, dd: 23.1, ddClosed: 21.76, trades: 335, win: 23.58, fees: 4.67}, own: {ret: -5.28, dd: 20.55, ddClosed: 17.96, trades: 251, win: 25.1, fees: 3.2},
    byRisk: { '1': {ret: 0.1, lo: -8.75, hi: 14.86, dd: 20.08, up: 1, trades: 110}, '2': {ret: -4.39, lo: -14.86, hi: 14.92, dd: 25.09, up: 1, trades: 112}, '3': {ret: -2.34, lo: -12.93, hi: 12.63, dd: 24.21, up: 1, trades: 109}, '5': {ret: -2.27, lo: -13.27, hi: 9.17, dd: 25.82, up: 1, trades: 109}, '0.5': {ret: -0.7, lo: -7.33, hi: 10.01, dd: 12.91, up: 1, trades: 109}, '1.5': {ret: -2.72, lo: -10.11, hi: 11.29, dd: 23.1, up: 1, trades: 112}},
    signals: {n: 3098, winPct: 24.79, avgR: 0.03, avgWinR: 2.43, avgLossR: -0.76, holdMedian: 23, avgPct: 0.57, randPct: 1.17, H: 12, fwdN: 3098, fwdUpPct: 45.93, fwdLo: 44.18, fwdHi: 47.69, baseUpPct: 48.29}},
  '4h': {coins: 99, range: [-14.17, 32.39], up: 1, from: '2025-08-13', to: '2026-10-24', block: '5 months', better: 2, cleared: false, adopt: false, hold: 27.15, holdDrop: 41.42, fillCost: 0.97, previous: { ret: 4.23, better: 2, cleared: false, measuredOn: '2026-10-23' }, standard: {ret: 2.93, dd: 21.24, ddClosed: 21.23, trades: 175, win: 26.29, fees: 1.69}, own: {ret: -8.37, dd: 38.51, ddClosed: 37.29, trades: 692, win: 26.44, fees: 7.91},
    byRisk: { '1': {ret: 2.7, lo: -10.39, hi: 23.76, dd: 15.65, up: 1, trades: 58}, '2': {ret: 0.73, lo: -19.9, hi: 40.73, dd: 25.01, up: 1, trades: 60}, '3': {ret: -1.18, lo: -24.45, hi: 39.91, dd: 29.69, up: 1, trades: 60}, '5': {ret: 3.91, lo: -21.71, hi: 44.59, dd: 34.1, up: 1, trades: 59}, '0.5': {ret: 1.4, lo: -4.79, hi: 11.97, dd: 8.45, up: 1, trades: 58}, '1.5': {ret: 2.93, lo: -14.17, hi: 32.39, dd: 21.24, up: 1, trades: 58}},
    signals: {n: 1412, winPct: 23.94, avgR: -0.07, avgWinR: 2.97, avgLossR: -1.03, holdMedian: 32, avgPct: 0.17, randPct: 2.28, H: 6, fwdN: 1412, fwdUpPct: 46.25, fwdLo: 43.66, fwdHi: 48.85, baseUpPct: 46.63}},
  '1d': {coins: 50, range: [-10.4, 45.68], up: 2, from: '2022-04-19', to: '2026-10-24', block: '18 months', better: 2, cleared: true, adopt: false, hold: 35.7, holdDrop: 58.84, fillCost: 0.72, previous: { ret: 29.18, better: 1, cleared: false, measuredOn: '2026-10-23' }, standard: {ret: 20.31, dd: 19.59, ddClosed: 17.84, trades: 172, win: 26.74, fees: 1.21}, own: {ret: 84.59, dd: 29.67, ddClosed: 22.1, trades: 217, win: 32.72, fees: 3.41},
    byRisk: { '1': {ret: 13.39, lo: -6.79, hi: 30.48, dd: 13.72, up: 2, trades: 57}, '2': {ret: 26.63, lo: -14.16, hi: 59.56, dd: 24.82, up: 2, trades: 57}, '3': {ret: 29.21, lo: -20.27, hi: 61.8, dd: 34.34, up: 2, trades: 57}, '5': {ret: 46.45, lo: -31.45, hi: 126.2, dd: 42.36, up: 2, trades: 55}, '0.5': {ret: 6.71, lo: -3.32, hi: 15.16, dd: 7.17, up: 2, trades: 57}, '1.5': {ret: 20.31, lo: -10.4, hi: 45.68, dd: 19.59, up: 2, trades: 57}},
    signals: {n: 654, winPct: 26.15, avgR: 0.17, avgWinR: 2.76, avgLossR: -0.75, holdMedian: 21, avgPct: 2.74, randPct: 7.17, H: 7, fwdN: 653, fwdUpPct: 49, fwdLo: 45.19, fwdHi: 52.83, baseUpPct: 46.1}},
};

/**
 * The rules an account trades on a chart: the settings given, that chart's
 * own rules, then the self-review's latest decision about the trend filter.
 * That decision is read from the review's log of lessons because a saved
 * setting cannot tell a learned value from an old default, and trusting it
 * would quietly put the old default back over a chart's measured rules.
 */
/** How a set of rules buys and sells, in words: the Trading page and the assistant both use it. */
export function rulesInWords(c) {
  const extra = `${c.momentumConfirm ? ' while the short-term trend and momentum also point up' : ''}${c.marketFilter ? ', and only while Bitcoin itself is in an uptrend' : ''}`;
  const buy = c.entryMode === 'pullback' ? `When a coin in an uptrend dips until RSI falls to ${PULLBACK_RSI} or lower, it buys the dip${extra}.`
    : c.entryMode === 'breakout' ? `When a coin closes above its highest price of the previous 20 candles${c.trendFilter ? ' in an uptrend' : ''}, it buys${extra}.`
      : `When the score clears +${c.entryScore}${c.trendFilter ? ' in an uptrend' : ''} it buys${extra}.`;
  return `${buy} It sells at ${c.trailAtr ? `a stop that trails ${c.trailAtr} ATR under the highest price since it bought` : `the target (${c.rMultiple}R)`}, the stop (${c.atrStop} ATR below entry)${c.signalExitBars ? ` or ${c.entryMode === 'pullback' ? 'once the bounce has come' : `after ${c.signalExitBars} candles of signal reversal`}` : ''}.${c.volScale ? ' It buys less while the coin is more volatile than usual (down to half).' : ''}`;
}

export function rulesForChart(cfg, interval, lessons = []) {
  // Your own rules are traded as you set them: neither the chart's tested
  // rules nor the self-review's trend lesson overrides what you chose.
  if (cfg.strategy === 'custom') return { ...cfg, ...pickRules({ ...CUSTOM_DEFAULT, ...(cfg.custom || {}) }), interval };
  // The tested rules, never a stale copy of them in saved settings: the
  // standard set, then the chart's own where it has them.
  const standard = Object.fromEntries([...RULE_KEYS, 'marketFilter'].map((k) => [k, DEFAULT_CONFIG[k]]));
  const trend = [...(lessons || [])].reverse().find((h) => h.lens === 'trend');
  return { ...cfg, ...standard, ...(CHART_EXITS[interval] || {}), ...(CHART_RULES[interval] || {}), ...(trend ? { trendFilter: !trend.undo } : {}), volScale: VOL_SCALE.charts.includes(interval), interval };
}

/**
 * Volatility-scaled position size (DEFAULT_CONFIG.volScale), A/B-tested by
 * tools/evaluate-trader-folds.mjs on the rules each chart trades, block by
 * block. The bar, written in the script before the run: better on return −
 * ½·worst drop in at least 2 of 3 blocks, by at least a point on average, and
 * an average return no more than a point lower; and the latest two runs
 * agreeing. 4h cleared it on 24 coins (2026-10-13) and traded with it. On 106
 * coins the latest two runs (2026-10-23 and 24) agree on no chart. 15m cleared
 * it on 2026-10-22 and 23 and 1d on 2026-10-16 and 22, but neither change was
 * published before a run that failed it (15m on 24, 1d on 23); 1d cleared it
 * again on 24, 1h only on 24, 4h only on 22. So it is off everywhere until
 * two runs in a row clear it.
 * Differences are percentage points per block, with minus without;
 * `previous` is the run the day before, on the same rules.
 */
export const VOL_SCALE = {
  measuredOn: '2026-10-24', charts: [],
  // the latest run; `dd` is the change in the worst drop with open trades
  // valued at every close, `objective` the bar's (closed trades)
  tested: {
    '15m': { better: 0, ret: -3.24, dd: 0.78, objective: -3.78, previous: { better: 2, ret: -0.1, dd: -2.44, objective: 1.08 } },
    '1h': { better: 3, ret: 1.76, dd: -1.79, objective: 2.35, previous: { better: 0, ret: -4.34, dd: 0.7, objective: -4.43 } },
    '4h': { better: 2, ret: -2.57, dd: -2.38, objective: -1.01, previous: { better: 2, ret: -0.71, dd: -2.2, objective: 0.77 } },
    '1d': { better: 3, ret: 1.57, dd: -3.27, objective: 2.97, previous: { better: 2, ret: -0.64, dd: -2.76, objective: 0.54 } },
  },
};


/**
 * What the settings can be expected to make, from the walk-forward test of
 * the rules this chart trades (CHART_TESTED): the average per test period and
 * the worst and best period. The test was run at six risk levels (byRisk);
 * between two of them the figures are read off a straight line. In the run
 * before the latest, above 2% a trade the results stayed about flat on 15m and
 * 1h (the 25%-a-coin cap binds first) and got worse on 4h and 1d; in the latest,
 * 5% a trade made the most on every chart, always with a deeper drop and a
 * worse worst block. The Trading page reads its sentence off the rows.
 * Measured with the standard caps (5 open, 25% a coin) on every coin;
 * `capsDiffer` flags other caps.
 * Null for your own rules or an untested chart: nothing measured to expect.
 */
export function expectedYield(cfg) {
  const x = CHART_TESTED[cfg.interval];
  if (!x?.standard || cfg.strategy === 'custom') return null;
  const t = x.adopt ? x.own : x.standard;
  const risk = Math.min(5, Math.max(0.5, Number(cfg.riskPct) || DEFAULT_CONFIG.riskPct));
  const levels = Object.keys(x.byRisk || {}).map(Number).sort((a, b) => a - b);
  let at = { ret: t.ret, lo: x.range[0], hi: x.range[1], dd: t.dd, up: x.up, trades: Math.round(t.trades / CHART_TESTED.blocks) };
  if (levels.length) {
    const hiL = levels.find((l) => l >= risk) ?? levels[levels.length - 1];
    const loL = [...levels].reverse().find((l) => l <= risk) ?? levels[0];
    const a = x.byRisk[loL], b = x.byRisk[hiL], w = hiL === loL ? 0 : (risk - loL) / (hiL - loL);
    const mix = (k) => +(a[k] + (b[k] - a[k]) * w).toFixed(2);
    // between two levels, count only the blocks with a gain at both
    at = { ret: mix('ret'), lo: mix('lo'), hi: mix('hi'), dd: mix('dd'), up: Math.min(a.up, b.up), trades: Math.round(mix('trades')) };
  }
  return {
    chart: cfg.interval, block: x.block, periods: CHART_TESTED.blocks, hold: x.hold, holdDrop: x.holdDrop ?? null, fillCost: x.fillCost ?? null, risk, measured: levels.length > 0,
    levels: levels.map((l) => ({ risk: l, ...x.byRisk[l] })), coins: x.coins ?? CHART_TESTED.coins,
    ...at, capsDiffer: (cfg.maxPositionPct ?? 25) !== 25 || (cfg.maxPositions ?? 5) !== 5,
  };
}

/**
 * What each tested chart made in its walk-forward test, after the cost of real
 * fills, spread evenly over an hour, a day, a week and a month: the average of
 * the test periods at this account's risk a trade (read between the measured
 * levels, as expectedYield does), with the worst and best period and holding
 * the same coins beside it. Simple averages, not compounded; an expectation
 * from past periods, not a promise.
 */
export function earningsByChart(cfg) {
  const rows = [];
  for (const [chart, x] of Object.entries(CHART_TESTED)) {
    if (!x?.standard) continue;
    const y = expectedYield({ ...cfg, interval: chart, strategy: 'tested' });
    if (!y) continue;
    const days = (Date.parse(x.to) - Date.parse(x.from)) / 864e5 / (CHART_TESTED.blocks || 3);
    if (!(days > 0)) continue;
    const fill = x.fillCost ?? 0;
    const per = (v) => ({ hour: v / days / 24, day: v / days, week: (v / days) * 7, month: (v / days) * 30 });
    const net = y.ret - fill;
    rows.push({
      chart, rules: x.adopt ? 'its own pick' : 'the standard rules', risk: y.risk, block: x.block, days: +days.toFixed(1), periods: y.periods,
      net: +net.toFixed(2), worst: +(y.lo - fill).toFixed(2), best: +(y.hi - fill).toFixed(2), fillCost: fill, dd: y.dd,
      per: per(net), worstPer: per(y.lo - fill), hold: x.hold, holdPer: per(x.hold),
      tradesPerMonth: Math.round((y.trades / days) * 30), coins: y.coins, from: x.from, to: x.to,
    });
  }
  return rows;
}

/** Rules you can set yourself, and what they start at. */
export const CUSTOM_DEFAULT = { entryMode: 'trend', momentumConfirm: false, trendFilter: true, marketFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: 2 };
const pickRules = (r) => Object.fromEntries(['entryMode', 'momentumConfirm', 'trendFilter', 'marketFilter', 'atrStop', 'rMultiple', 'trailAtr', 'signalExitBars'].filter((k) => k in r).map((k) => [k, r[k]]));

/**
 * Settings replayed on recent candles with the live account's own engine and
 * fees, every coin together. A look back, not a promise: rules picked on these
 * same candles (the tested ones were picked on all the history) look better
 * here than they will live.
 */
export function backtestSettings(cfg, candlesBySymbol) {
  const series = Object.entries(candlesBySymbol).filter(([, c]) => Array.isArray(c) && c.length > 220);
  const state = newState(cfg);
  replayAll(state, cfg, Object.fromEntries(series));
  const last = Object.fromEntries(series.map(([sym, c]) => [sym, c[c.length - 1].c]));
  const st = stats(state, last);
  const exitFees = Object.values(state.open).reduce((a, p) => a + (last[p.symbol] ?? p.entry) * p.qty * (cfg.feePct / 100), 0);
  const holds = series.map(([, c]) => c[c.length - 1].c / c[210].c - 1);
  return {
    coins: series.length,
    from: series.length ? Math.min(...series.map(([, c]) => c[210].t)) : null,
    to: series.length ? Math.max(...series.map(([, c]) => c[c.length - 1].t)) : null,
    ret: round(((st.equity - exitFees) / cfg.startingBalance - 1) * 100, 2),
    hold: holds.length ? round((holds.reduce((a, b) => a + b, 0) / holds.length) * 100, 2) : null,
    dd: st.maxDrawdownPct, trades: st.trades, winRate: st.winRate, fees: st.feesPaid, open: st.openCount,
  };
}

/** Charts the trader can run on; only some were tested (CHART_TESTED). */
export const TRADER_CHARTS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
// The whole top-100 list the coin picker shows. Every check fetches each coin's
// candles (four at a time), so a long list only makes a check take longer.
export const MAX_COINS = 100;
/**
 * The coins the published tests ran on: tools/universe.json, CoinGecko's top
 * 150 on 2026-10-15 less stablecoins, tokenised funds and coins no exchange the
 * app reads lists, each with candles from the exchange the app reads it on.
 */
export const TESTED_COINS = [
  'BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'ZEC', 'HYPE', 'DOGE', 'XMR', 'LINK', 'ADA', 'LEO',
  'NEAR', 'XLM', 'RAIN', 'BCH', 'UNI', 'LTC', 'AVAX', 'CC', 'SUI', 'GRAM', 'HBAR', 'TAO', 'QNT',
  'SHIB', 'BTW', 'CRO', 'ENA', 'OKB', 'AAVE', 'ONDO', 'PUMP', 'ASTER', 'M', 'DOT', 'WLD', 'WLFI',
  'MNT', 'PEPE', 'ICP', 'MORPHO', 'SKY', 'HTX', 'ETC', 'ARB', 'VVV', 'JST', 'GT', 'JUP', 'ALGO',
  'POL', 'RENDER', 'KAS', 'ATOM', 'PI', 'AERO', 'FIL', 'NEXO', 'ZRO', 'LIT', 'STX', 'INJ',
  'STABLE', 'APT', 'CAKE', 'NIGHT', 'PYTH', 'XDC', 'AKE', 'BDX', 'STRK', 'DASH', 'ETHFI', 'VET',
  'FLR', 'TIA', 'CRV', 'TRUMP', 'RAY', '币安人生', 'PENGU', 'FET', 'GRASS', 'VIRTUAL', 'SEI', 'DRV',
  'XPL', 'FF', 'BSV', 'PENDLE', 'BTT', 'XTZ', 'SPX', 'LDO', 'PIEVERSE', 'SUN', 'OP', 'GNO', 'KITE',
  'CFX', 'UB', 'KAIA', 'CARDS', 'SAND',
];

/**
 * The tested chart that made the most after the cost of real fills, per month.
 * Each chart's result a period loses `fillCost` points when every fill is
 * 0.05% worse each way (spread and slippage, which the test itself leaves
 * out), and periods differ in length (11 days on 15m, 18 months on 1d), so
 * they are compared per 30 days; a tie goes to the smaller worst drop. It used
 * to rank by the number of periods with a gain before those costs, which
 * favoured the shortest chart: after them, 15m's worst period lost money and
 * 4h lost on average.
 */
export function bestTestedChart() {
  const rows = Object.entries(CHART_TESTED).filter(([, x]) => x && typeof x === 'object' && x.standard).map(([iv, x]) => {
    const r = x.adopt ? x.own : x.standard;
    const days = (Date.parse(x.to) - Date.parse(x.from)) / 864e5 / (CHART_TESTED.blocks || 3);
    const net = +(r.ret - (x.fillCost ?? 0)).toFixed(2);
    const month = days > 0 ? +((net / days) * 30).toFixed(2) : null;
    // periods with a gain after the fill cost, from the worst period up
    const worstNet = +((x.range?.[0] ?? r.ret) - (x.fillCost ?? 0)).toFixed(2);
    return { iv, up: x.up ?? 0, net, month, worstNet, fillCost: x.fillCost ?? 0, edge: r.ret - x.hold, dd: r.dd, ret: r.ret, hold: x.hold, block: x.block };
  });
  rows.sort((a, b) => (b.month ?? -Infinity) - (a.month ?? -Infinity) || a.dd - b.dd);
  return rows[0];
}

/**
 * Plain warnings about a set of trader settings, before they are used:
 * what was never tested, what risks a lot, what cannot work as set.
 */
export function settingsWarnings(cfg) {
  const out = [];
  const tested = CHART_TESTED[cfg.interval];
  if (!tested) out.push(`The ${cfg.interval} chart was never tested with these rules, so there is no measured result to expect on it. ${Object.keys(CHART_TESTED).filter((k) => CHART_TESTED[k]?.standard).join(', ')} were.`);
  // a chart whose tested rules lost money once real fills are counted
  const lost = tested && cfg.strategy !== 'custom' ? earningsByChart(cfg).find((r) => r.chart === cfg.interval && r.net < 0) : null;
  if (lost) {
    const top = bestTestedChart();
    out.push(`On ${cfg.interval} the tested rules lost ${Math.abs(lost.net)}% a period (${lost.block}) on average once real fills are counted (spread and slippage, ${lost.fillCost} points a period). ${top ? `${top.iv} made the most of the tested charts: about +${top.month}% a month after that cost.` : ''}`);
  }
  if (cfg.strategy === 'custom') out.push('Your own rules have no published test. Use "Test these settings" to see how they did on recent candles before you rely on them.');
  if (cfg.riskPct > 2) out.push(`Risking ${cfg.riskPct}% a trade means ten losing trades in a row, which happens, cost about ${Math.round((1 - (1 - cfg.riskPct / 100) ** 10) * 100)}% of the account.`);
  if ((cfg.maxPositionPct ?? 25) > 25) out.push(`Up to ${cfg.maxPositionPct}% in one coin; the tests allowed 25%. A coin that barely moves gets a close stop, so the risk setting can put up to ${cfg.maxPositionPct}% of the account into it, and the fee takes a bigger bite of each trade.${cfg.maxPositionPct > 50 ? ' One trade can then take all the cash, so the AI holds one coin at a time and passes up the other coins\' buy signals.' : ''}`);
  const untested = (cfg.universe || []).filter((sym) => !TESTED_COINS.includes(sym));
  if (untested.length) out.push(`${untested.length} of your ${(cfg.universe || []).length} coins ${untested.length === 1 ? 'was' : 'were'} not in the tests (${TESTED_COINS.length} of the largest coins), so the measured results say nothing about ${untested.length === 1 ? 'it' : 'them'}${untested.length <= 8 ? `: ${untested.join(', ')}` : ''}.`);
  if (cfg.maxPositions * (cfg.maxPositionPct ?? 25) < 50) out.push(`With at most ${cfg.maxPositions} open and ${cfg.maxPositionPct ?? 25}% in one coin, no more than ${cfg.maxPositions * (cfg.maxPositionPct ?? 25)}% of the account is ever invested.`);
  if ((cfg.universe || []).length < 3) out.push('With fewer than three coins the trader will often have nothing to do.');
  if ((cfg.feePct ?? 0.1) > 0.25) out.push(`A ${cfg.feePct}% fee each way is high: on short charts fees can take most of the gains.`);
  return out;
}

/**
 * Each coin's own rules for the daily chart, chosen on its own full daily
 * history by tools/evaluate-selection.mjs (216 rule sets each; a coin keeps
 * the daily rules unless others did better on it). On for daily accounts
 * unless switched off in Settings. Measured with everything chosen on the
 * older half of the data only (the daily rules too, picked the way the
 * shipped ones were) and run on the newer half, all coins in one account.
 * The bar, set before the first test: more than the daily rules alone, with a
 * worst drop (closed trades) no more than five points deeper.
 * - 2026-10-12, 24 coins: +46.0% against +37.0%, drop 33.2% against 29.3%;
 *   inside the bar, so switched on.
 * - 2026-10-13, 24 coins: +89.8% against +33.3%, drop 34.7% against 29.3%;
 *   5.4 points, just outside. One run, so the decision stood.
 * - 2026-10-15, the 73 coins with enough daily history (`tested`): +265.0%
 *   against +155.4%, drop 34.1% against 32.4%; inside the bar, so they stay on.
 * Holding the same 73 coins made +97.3% over those years, with a worst drop of
 * 64.9%. The walk-forward check disagrees: coin by coin over three periods
 * (the 49 coins with enough history), each coin's own rules beat one shared
 * rule set in only 1 of 3 on daily (+2.7% against +6.3% a period), where the
 * 24-coin run had them better in all three. 1h was rejected in both runs; 4h
 * was better in 2 of 3 periods both times but by 0.3 points a period this
 * time, under the 1-point bar. So the account gain rests on a few coins, and
 * the Settings switch says so. The coins are today's survivors, which flatters
 * every backtest of them.
 */
export const PER_COIN_RULES = {
  interval: '1d', measuredOn: '2026-10-15', coins: 73,
  tested: { from: '2023-10-12', to: '2026-10-15', standard: { ret: 155.41, dd: 34.54, ddClosed: 32.44, trades: 266, winRate: 32.7 }, own: { ret: 265.03, dd: 34.13, ddClosed: 34.11, trades: 222, winRate: 32.9 }, hold: 97.31, holdDrop: 64.91, walkForward: { periods: 3, better: 1, own: 2.72, shared: 6.3, coins: 49 }, previousRun: { coins: 24, own: 89.77, standard: 33.31 } },
  rules: {
    BTC: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    ETH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    BNB: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    XRP: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    SOL: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    TRX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    ZEC: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    DOGE: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    XMR: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    LINK: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    ADA: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    LEO: { entryMode: 'trend', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    NEAR: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    XLM: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    BCH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    UNI: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    LTC: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    AVAX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    SUI: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    HBAR: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    TAO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    QNT: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    SHIB: { entryMode: 'breakout', momentumConfirm: false, trendFilter: true, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    CRO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    ENA: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    OKB: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    AAVE: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    DOT: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    WLD: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    MNT: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    PEPE: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    ICP: { entryMode: 'trend', momentumConfirm: false, trendFilter: true, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    HTX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: null },
    ETC: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: null },
    ARB: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    JST: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    GT: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    JUP: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    ALGO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    POL: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: 3, signalExitBars: null },
    RENDER: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: null },
    KAS: { entryMode: 'breakout', momentumConfirm: false, trendFilter: true, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    ATOM: { entryMode: 'trend', momentumConfirm: true, trendFilter: true, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    FIL: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 2, trailAtr: null, signalExitBars: 2 },
    NEXO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    ZRO: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 2, trailAtr: null, signalExitBars: 2 },
    STX: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    INJ: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    APT: { entryMode: 'trend', momentumConfirm: true, trendFilter: true, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    CAKE: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 2, trailAtr: null, signalExitBars: null },
    PYTH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    XDC: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    BDX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: null },
    STRK: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    DASH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    ETHFI: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    VET: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    FLR: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 2, trailAtr: null, signalExitBars: 2 },
    TIA: { entryMode: 'trend', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 2, trailAtr: null, signalExitBars: 2 },
    CRV: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 3, signalExitBars: null },
    RAY: { entryMode: 'trend', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    FET: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    SEI: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: null },
    BSV: { entryMode: 'breakout', momentumConfirm: true, trendFilter: true, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    PENDLE: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    BTT: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    XTZ: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    LDO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 2, trailAtr: null, signalExitBars: null },
    SUN: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    OP: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    GNO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    CFX: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    SAND: { entryMode: 'trend', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
  },
};

export const DEFAULT_CONFIG = {
  startingBalance: 10000,
  riskPct: 1.5,          // % of balance risked per trade (stop distance = this loss)
  maxPositions: 5,
  maxPositionPct: 25,    // never put more than this share of the balance in one coin
  // The entry bar was raised to 65 to cut fee drag, before the bucket study
  // showed that the highest-scoring bars are the ones LEAST likely to rise. So a
  // high bar is not a better filter — it just trades less. It is set back to the
  // ordinary threshold so the demonstration actually runs and shows what the
  // published rule does, which is the only thing this account is for.
  entryScore: THRESHOLDS.normal,
  exitScore: -THRESHOLDS.normal,
  atrStop: 3,            // see AUTOTRADER_TESTED for the held-out comparison
  rMultiple: 3,
  feePct: 0.1,
  // Two behaviours that were hardcoded and therefore never measured. Moving the
  // stop to break-even converts would-be winners into scratches, and exiting on
  // a signal reversal cuts trades before the target — both sound prudent and
  // both cost money if they are wrong, so they are settings now and the grid in
  // tools/evaluate-autotrader.mjs tests them.
  breakEvenAtR: null,    // measured: moving the stop to entry cost money, so it is off
  // Buy less while a coin is unusually volatile: the position × max(0.5, 1 / ratio),
  // the ratio being its 100-candle volatility over its own long-run normal. Off until
  // tools/evaluate-trader-folds.mjs shows it helps on a chart (see CHART_RULES).
  volScale: false,
  signalExitBars: 2,     // close after this many consecutive reversal bars; null = never
  // Two risk rules added 2026-09-26 and measured with tools/evaluate-autotrader.mjs
  // before being switched on or left off (see AUTOTRADER_TESTED):
  trendFilter: true,     // only buy while price is above the 200-bar EMA and the 50 is above the 200
  trailAtr: null,        // e.g. 3 = trail the stop 3 ATR under the highest high since entry
  // Filters the self-review (js/lib/tradelearn.js) can switch on after reading the trade log.
  minAdx: null,          // skip entries while ADX is below this (a ranging market)
  maxEntryRsi: null,     // skip entries while RSI is above this (already stretched)
  excluded: [],          // coins the review stopped trading after a run of losses
  entryMode: 'trend',     // 'trend' buys a high score; 'pullback' a dip in an uptrend; 'breakout' a new 20-candle high
  perCoin: null,          // { SYMBOL: { ...RULE_KEYS } }: a coin's own rules over these (see PER_COIN_RULES)
  momentumConfirm: false, // also require price > 20 EMA > 50 EMA and a rising MACD
  marketFilter: false,    // no new buys while Bitcoin is below its 200 EMA
  interval: '1h',
  universe: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK'],
};

export function newState(cfg = DEFAULT_CONFIG, { liveFrom = null } = {}) {
  return {
    version: 1,
    interval: cfg.interval,  // an account keeps the timeframe it was started on
    startedAt: Date.now(),
    // After a Reset the account starts clean from that moment: candles that
    // opened before it are never traded. (Reset used to wipe the account and the
    // next Start replayed the last 500 candles, so the same past trades came
    // straight back, dated days before the reset.)
    liveFrom,
    firstBarAt: null,        // first candle the account actually traded on
    log: [],                 // what each check did, newest last (see logCheck)
    balance: cfg.startingBalance,
    startingBalance: cfg.startingBalance,
    open: {},          // symbol -> position
    closed: [],        // finished trades, newest last
    cursor: {},        // symbol -> last candle time processed
    equityCurve: [],   // { t, equity }
  };
}

const round = (v, dp = 6) => (Number.isFinite(v) ? +v.toFixed(dp) : v);
// Prices keep ten significant digits at any size. Six decimals turned BTT
// (about 0.0000004) into 0 and left PEPE and SHIB with one digit, so their
// stops sat up to 20% away from where they were set and every result was off.
const px = (v) => (Number.isFinite(v) ? +v.toPrecision(10) : v);

/**
 * The same account as if it had started with `startingBalance`: the balance,
 * every position and trade (size, fees, result) and the balance curve times
 * the ratio, so every percentage stays as it was. Each trade is sized as a
 * share of the balance, so these are the trades the AI would have made with
 * that much, to the cent. Changing the starting balance used to wait for the
 * next Reset, so the balance on the page did not move.
 */
export function rescaleAccount(state, startingBalance) {
  const k = startingBalance / state.startingBalance;
  if (!(k > 0) || !Number.isFinite(k) || k === 1) return state;
  const by = (v, dp) => (Number.isFinite(v) ? round(v * k, dp) : v);
  const pos = (p) => ({
    ...p, qty: by(p.qty, 10), notional: by(p.notional, 2), riskCash: by(p.riskCash, 2), feePaid: by(p.feePaid, 4),
    ...('pnl' in p ? { pnl: by(p.pnl, 2) } : {}),
  });
  return {
    ...state,
    startingBalance,
    balance: state.balance * k,
    open: Object.fromEntries(Object.entries(state.open || {}).map(([sym, p]) => [sym, pos(p)])),
    closed: (state.closed || []).map(pos),
    equityCurve: (state.equityCurve || []).map((e) => ({ ...e, equity: by(e.equity, 2) })),
  };
}

/**
 * Replay one symbol's candles from where we left off, mutating `state`.
 * `candles` must be closed candles, oldest first.
 */
export function replaySymbol(state, cfg, symbol, candles, pre = null) {
  if (!candles || candles.length < 220) return { processed: 0 };
  // `pre` lets the evaluation harness reuse indicators and scores across settings.
  const s = { symbol, candles, ind: pre?.ind || computeAll(candles), atr: pre?.atr || atr(candles, 14), scores: pre?.scores || null, regime: pre?.regime || null };
  const out = { processed: 0, lastScore: null };
  const rules = rulesFor(cfg, symbol);
  for (let i = 210; i < candles.length; i++) advance(state, rules, s, i, out);
  return out;
}

/**
 * Replay several coins together, one moment at a time, oldest first — the way
 * the published test ran and the way a live account sees the market. Replaying
 * one coin's whole backlog before the next (what a catch-up after a few days
 * away used to do) let the first coin's trades take every slot and all the
 * cash before the others' earlier signals were even looked at.
 */
export function replayAll(state, cfg, candlesBySymbol, { regimeCandles = null } = {}) {
  const series = [];
  const result = {};
  const regime = cfg.marketFilter ? marketRegime(regimeCandles || candlesBySymbol.BTC) : null;
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    result[symbol] = { processed: 0, lastScore: null };
    if (!candles || candles.length < 220) continue;
    series.push({ symbol, candles, ind: computeAll(candles), atr: atr(candles, 14), scores: null, regime });
  }
  return replaySeries(state, cfg, series, { result });
}

/**
 * The time-ordered replay itself, on series whose indicators are already
 * computed ({ symbol, candles, ind, atr, scores?, regime? }). Exported for the
 * evaluation harness, which reuses one computation across many settings.
 */
export function replaySeries(state, cfg, series, { from = 210, result = {}, onBar = null } = {}) {
  const pos = series.map(() => from);
  const rules = series.map((s) => rulesFor(cfg, s.symbol));
  for (const s of series) result[s.symbol] ||= { processed: 0, lastScore: null };
  for (;;) {
    let k = -1;
    for (let j = 0; j < series.length; j++) {
      if (pos[j] < series[j].candles.length && (k < 0 || series[j].candles[pos[j]].t < series[k].candles[pos[k]].t)) k = j;
    }
    if (k < 0) break;
    if (onBar) onBar(series[k].candles[pos[k]], series[k].symbol);
    advance(state, rules[k], series[k], pos[k]++, result[series[k].symbol]);
  }
  return result;
}

// The settings a coin can have its own value for. Sizing, risk and fees are
// the account's and stay the same for every coin.
export const RULE_KEYS = ['entryMode', 'momentumConfirm', 'trendFilter', 'atrStop', 'rMultiple', 'trailAtr', 'signalExitBars'];
/**
 * The account's settings with this coin's own rules on top, if it has any.
 * Worked out once per replay, never cached across them: the Trading page
 * changes its settings object in place (Save, the self-review's filters).
 */
export function rulesFor(cfg, symbol) {
  const own = cfg.perCoin?.[symbol];
  if (!own) return cfg;
  return { ...cfg, ...Object.fromEntries(RULE_KEYS.filter((k) => k in own).map((k) => [k, own[k]])) };
}

// One closed candle of one coin: skip it if already seen, else trade it.
function advance(state, cfg, s, i, out) {
  const c = s.candles[i];
  const from = state.cursor[s.symbol] ?? 0;
  if (c.t <= from) return;
  state.cursor[s.symbol] = c.t;
  if (state.liveFrom && c.t < state.liveFrom) return;
  out.processed++;
  if (!state.firstBarAt || c.t < state.firstBarAt) state.firstBarAt = c.t;
  const score = s.scores ? s.scores[i] : scoreAt(s.candles, s.ind, i).score;
  out.lastScore = score;
  const passed = stepBar(state, cfg, s, i, score);
  if (passed) { out.passed = (out.passed || 0) + 1; out.passedWhy = passed; }
}

/**
 * Candle time → whether Bitcoin was in an uptrend at that candle's close (price
 * above its 200 EMA and the 50 above the 200), for the market filter.
 */
export function marketRegime(btcCandles) {
  const map = new Map();
  if (!btcCandles || btcCandles.length < 210) return map;
  const closes = btcCandles.map((c) => c.c);
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  btcCandles.forEach((c, i) => { if (e200[i] !== null && e50[i] !== null) map.set(c.t, c.c > e200[i] && e50[i] > e200[i]); });
  return map;
}

// Cash not already tied up in open simulated positions. Sizing used to look at
// the balance alone, so five positions at the 25% cap put 125% of the account
// in the market (250% with ten) — borrowed money in an account that never
// borrows. A recorded real trade lives in its own account and is not counted.
export function freeCash(state) {
  const tied = Object.values(state.open).reduce((sum, p) => sum + (p.real ? 0 : (p.notional || 0)), 0);
  return state.balance - tied;
}

// "Pullback" buys a dip inside an uptrend and sells into strength; "trend"
// buys strength and sells when the reading turns down.
//
// The dip is read from RSI(14), not the chart score. The score counts oversold
// readings (RSI under 30, a close under the lower band) as reasons to buy, so a
// real dip pushes it up: in an uptrend it never fell below −10 on 55,800 test
// candles, and the −18 the rule used to wait for came only at overbought tops
// (RSI over 80, a close over the upper band), the opposite of a dip. The rule
// never bought anything; the tests that passed scripted the score.
export const PULLBACK_RSI = 40;
function wantsEntry(cfg, score, ind, i, c) {
  if (cfg.entryMode === 'pullback') return Number.isFinite(ind.rsi[i]) && ind.rsi[i] <= PULLBACK_RSI;
  // a close above the highest high of the previous 20 candles
  if (cfg.entryMode === 'breakout') return ind.donchian.upper[i - 1] !== null && c.c > ind.donchian.upper[i - 1];
  return score >= cfg.entryScore;
}
const wantsExit = (cfg, score) => (cfg.entryMode === 'pullback' ? score >= -cfg.exitScore : score <= cfg.exitScore);

/**
 * Why these rules would not buy this coin on candle i (a short code), or null
 * when they would. The trader and the coin page both ask this, so the page
 * cannot say "it would buy" when the trader would not. Codes, not sentences,
 * because the trader asks it on every candle of every replay.
 */
export function entryBlocker(cfg, s, i, score) {
  const { ind } = s, c = s.candles[i];
  if (!wantsEntry(cfg, score, ind, i, c)) return 'signal';
  if ((cfg.trendFilter || cfg.entryMode === 'pullback') && !(ind.ema200[i] && c.c > ind.ema200[i] && ind.ema50[i] > ind.ema200[i])) return 'trend';
  // The chart score adds oversold readings as reasons to buy, so early in a
  // fall it can still read high. Confirmation asks for the short-term trend
  // and momentum to be pointing up as well.
  if (cfg.momentumConfirm && !(c.c > ind.ema20[i] && ind.ema20[i] > ind.ema50[i] && ind.macd.hist[i] > 0)) return 'momentum';
  // Most coins fall together: no new buys while Bitcoin itself is in a downtrend.
  if (s.regime && s.regime.get(c.t) === false) return 'market';
  if (cfg.minAdx && !(ind.adx.adx[i] >= cfg.minAdx)) return 'adx';
  if (cfg.maxEntryRsi && ind.rsi[i] !== null && ind.rsi[i] > cfg.maxEntryRsi) return 'rsi';
  if (cfg.excluded?.includes(s.symbol)) return 'excluded';
  return null;
}

/** An entryBlocker code in words. */
export function blockerText(code, cfg, score, { rsi = null } = {}) {
  return {
    signal: cfg.entryMode === 'breakout' ? 'it has not closed above its highest price of the previous 20 candles'
      : cfg.entryMode === 'pullback' ? `there is no dip: RSI is ${Number.isFinite(rsi) ? Math.round(rsi) : `above ${PULLBACK_RSI}`}, the rule needs ${PULLBACK_RSI} or lower`
        : `the score is ${score > 0 ? '+' : ''}${score}, the rule needs +${cfg.entryScore} or more`,
    trend: 'it is not in an uptrend (price and the 50-candle average above the 200-candle average)',
    momentum: 'the short-term trend and momentum are not both pointing up',
    market: 'Bitcoin itself is in a downtrend',
    adx: `the trend is weak (ADX under ${cfg.minAdx})`,
    rsi: `RSI is above ${cfg.maxEntryRsi}`,
    excluded: 'its self-review stopped trading this coin after a run of losses',
  }[code] || code;
}

/**
 * The AI signal for one coin on one chart: what the chart's published rules
 * (CHART_RULES, else the standard rules; never anyone's own settings) did
 * with this coin's closed candles, replayed alone with one trade at a time.
 * That is how CHART_TESTED[chart].signals was measured, so the record shown
 * with a signal is the record of exactly this. Actions: 'buy' (bought on the
 * last closed candle), 'hold' (in a trade bought earlier), 'sell' (the trade
 * closed on the last closed candle) and 'wait' (no trade, with the reason).
 * Null with too little history.
 */
export function aiSignal(candles, interval, symbol = 'COIN') {
  if (!Array.isArray(candles) || candles.length < 220) return null;
  const cfg = rulesFor({ ...rulesForChart({ ...DEFAULT_CONFIG, excluded: [], universe: [symbol], maxPositions: 1, maxPositionPct: 100 }, interval), perCoin: null }, symbol);
  const state = newState(cfg);
  const s = { symbol, candles, ind: computeAll(candles), atr: atr(candles, 14), scores: null, regime: null };
  const out = { processed: 0, lastScore: null };
  for (let i = 210; i < candles.length; i++) advance(state, cfg, s, i, out);
  const i = candles.length - 1, last = candles[i];
  const tested = CHART_TESTED[interval];
  // its trades on these candles, fees included: what it actually did on this coin
  const net = (t) => round(t.notional > 0 ? (t.pnl / t.notional) * 100 : t.pnlPct, 2);
  const done = state.closed.map((t) => ({ openedAt: t.openedAt, exitAt: t.exitAt, entry: t.entry, exit: t.exit, why: t.reason, netPct: net(t) }));
  const from = candles[Math.min(210, i)];
  const past = done.length ? {
    trades: done.length, wins: done.filter((t) => t.netPct > 0).length,
    avgPct: round(done.reduce((a, t) => a + t.netPct, 0) / done.length, 2),
    from: from.t, holdPct: round((last.c / from.c - 1) * 100, 2),
    recent: done.slice(-5).reverse(),
  } : { trades: 0, from: from.t, holdPct: round((last.c / from.c - 1) * 100, 2), recent: [] };
  const base = { interval, rules: cfg, tested: !!tested?.standard, record: tested?.signals || null, price: last.c, at: last.t, past };
  const pos = state.open[symbol];
  if (pos) {
    const k = candles.findIndex((c) => c.t === pos.openedAt);
    return { ...base, action: pos.openedAt === last.t ? 'buy' : 'hold', entry: pos.entry, stop: pos.stop, initialStop: pos.initialStop, target: pos.tp, openedAt: pos.openedAt, barsHeld: k < 0 ? null : i - k, openPct: round((last.c / pos.entry - 1) * 100, 2) };
  }
  const t = state.closed[state.closed.length - 1];
  if (t && t.exitAt === last.t) return { ...base, action: 'sell', entry: t.entry, exit: t.exit, why: t.reason, openedAt: t.openedAt, pnlPct: t.pnlPct, netPct: net(t), r: t.riskCash > 0 ? round(t.pnl / t.riskCash, 2) : null };
  const score = out.lastScore ?? scoreAt(candles, s.ind, i).score;
  const code = entryBlocker(cfg, s, i, score);
  return { ...base, action: 'wait', code, why: code ? blockerText(code, cfg, score, { rsi: s.ind.rsi[i] }) : 'the rule found no entry on it', last: t ? { exitAt: t.exitAt, pnlPct: t.pnlPct, why: t.reason } : null };
}

/**
 * A coin's volatility now against its own normal, candle by candle: the
 * standard deviation of the last 100 log returns (the one the forecast's
 * ranges use) over a slow average of that same figure (about 500 candles).
 * Only past candles go into each value; null until there is enough history.
 */
export function volRatio(candles) {
  const n = candles.length, out = new Array(n).fill(null);
  const S1 = [0], S2 = [0];
  for (let i = 0; i < n; i++) { const r = i ? Math.log(candles[i].c / candles[i - 1].c) : 0; S1.push(S1[i] + r); S2.push(S2[i] + r * r); }
  const k = 2 / (500 + 1);
  let normal = null;
  for (let i = 100; i < n; i++) {
    const a = i - 99, m = 100, mu = (S1[i + 1] - S1[a]) / m;
    const sd = Math.sqrt(Math.max((S2[i + 1] - S2[a]) / m - mu * mu, 1e-12));
    normal = normal === null ? sd : normal + k * (sd - normal);
    if (i >= 200) out[i] = sd / normal;
  }
  return out;
}

/**
 * One row of the live AI-signal record (table ai_signal_log): what the signal
 * said on the last closed candle, written by the server once per candle and
 * never changed afterwards, then graded on the price `horizonBars` candles
 * later. `opened_at` is when the trade it is in (or just closed) was bought,
 * so the record can count only trades bought after tracking began.
 */
export function aiSignalRow(candles, interval, symbol, { horizonBars, intervalMs }) {
  const a = aiSignal(candles, interval, symbol);
  if (!a || !(intervalMs > 0) || !(horizonBars > 0)) return null;
  const last = candles[candles.length - 1];
  const iso = (t) => new Date(t).toISOString();
  return {
    symbol, interval, candle_time: iso(last.t), price: last.c, action: a.action,
    entry: a.entry ?? null, stop: a.action === 'sell' ? null : a.stop ?? null, target: a.action === 'sell' ? null : a.target ?? null,
    opened_at: a.openedAt ? iso(a.openedAt) : null,
    exit_price: a.action === 'sell' ? a.exit : null, trade_pct: a.action === 'sell' ? a.netPct : null,
    horizon_bars: horizonBars, horizon_at: iso(last.t + intervalMs + horizonBars * intervalMs),
  };
}

function stepBar(state, cfg, s, i, score) {
  const { symbol, candles, ind } = s;
  const atrArr = s.atr;
  const c = candles[i];
  const pos = state.open[symbol];
  // the latest close of every coin seen, so the equity curve values open trades
  (state.px ||= {})[symbol] = c.c;

  // ---- manage an open position first, on this bar's high/low
  if (pos) {
    // Conservative: if both the stop and the target are inside one candle,
    // assume the stop hit first. Never flatter than reality.
    if (c.l <= pos.stop) {
      const why = pos.stop > pos.initialStop ? (pos.movedToBreakEven && pos.stop === pos.entry ? 'break-even stop' : 'trailing stop') : 'stop-loss';
      closePosition(state, cfg, symbol, Math.min(pos.stop, c.o), c.t, why);
    } else if (pos.tp !== null && c.h >= pos.tp) {
      closePosition(state, cfg, symbol, pos.tp, c.t, 'target');
    } else {
      // trailing stop: ratchet up under the highest high since entry, never down
      if (cfg.trailAtr && atrArr[i]) {
        pos.high = Math.max(pos.high ?? pos.entry, c.h);
        const trail = pos.high - cfg.trailAtr * atrArr[i];
        if (trail > pos.stop) pos.stop = px(trail);
      }
      // break-even stop once the trade is +1R in profit
      const r = pos.entry - pos.initialStop;
      const beR = cfg.breakEvenAtR;
      if (beR !== null && beR !== undefined && !pos.movedToBreakEven && r > 0 && c.h >= pos.entry + beR * r) {
        pos.stop = pos.entry;
        pos.movedToBreakEven = true;
      }
      // The run of reversal bars is kept on the position. It used to be a
      // local count that restarted with every check, and a live check sees one
      // new candle, so "two bars in a row" could never happen live — only in
      // a catch-up — and a new trade could inherit the last one's count.
      const exitBars = cfg.signalExitBars;
      if (exitBars !== null && exitBars !== undefined) {
        pos.reversalBars = wantsExit(cfg, score) ? (pos.reversalBars || 0) + 1 : 0;
        if (pos.reversalBars >= exitBars) closePosition(state, cfg, symbol, c.c, c.t, cfg.entryMode === 'pullback' ? 'sold into strength' : 'signal reversal');
      }
    }
    markEquity(state, c.t);
    return;
  }

  // ---- look for an entry
  // A buy the rules wanted but the account could not take is reported, not
  // dropped in silence: with all the cash in one coin the others' signals were
  // passed up and the page never said why it held one coin at a time.
  if (entryBlocker(cfg, s, i, score) !== null) return;
  if (Object.keys(state.open).length >= cfg.maxPositions) return 'full';
  const a = atrArr[i];
  if (!a) return;

  const entry = c.c;
  const stop = entry - cfg.atrStop * a;
  const riskPerUnit = entry - stop;
  if (riskPerUnit <= 0) return;
  // The fees in and out as a share of the distance to the stop. Past about a
  // fifth they eat what a 3R target makes on a third of trades, so the trade
  // starts behind (tools/evaluate-trader-folds.mjs, off unless adopted there).
  if (cfg.maxFeeShare > 0 && (2 * (cfg.feePct ?? 0.1)) / ((riskPerUnit / entry) * 100) > cfg.maxFeeShare) return;

  const riskCash = state.balance * (cfg.riskPct / 100);
  let notional = (riskCash / riskPerUnit) * entry;
  // the fee is paid from the same cash
  notional = Math.min(notional, state.balance * (cfg.maxPositionPct / 100), freeCash(state) / (1 + cfg.feePct / 100));
  // after the caps, which on short charts bind before the risk setting does
  if (cfg.volScale) {
    s.volr ||= volRatio(candles);
    const r = s.volr[i];
    if (r > 1) notional *= Math.max(0.5, 1 / r);
  }
  if (notional < 1) return freeCash(state) < 1 + (cfg.feePct ?? 0.1) / 100 ? 'nocash' : undefined;

  const qty = notional / entry;
  const fee = notional * (cfg.feePct / 100);
  state.balance -= fee;
  state.open[symbol] = {
    symbol, side: 'long',
    entry: px(entry), initialStop: px(stop), stop: px(stop),
    tp: cfg.trailAtr ? null : px(entry + cfg.rMultiple * riskPerUnit),
    qty: round(qty, 10), notional: round(notional, 2),
    openedAt: c.t, openScore: score, entryBar: cfg.entryMode === 'trend' || !cfg.entryMode ? cfg.entryScore : null, entryMode: cfg.entryMode || 'trend',
    movedToBreakEven: false, feePaid: round(fee, 4),
    // What the market looked like at entry, so the self-review can learn from the log.
    riskCash: round(qty * riskPerUnit, 2),
    ctx: {
      trendUp: !!(ind.ema200[i] && c.c > ind.ema200[i]),
      adx: ind.adx.adx[i] === null ? null : round(ind.adx.adx[i], 1),
      rsi: ind.rsi[i] === null ? null : round(ind.rsi[i], 1),
      atrPct: round((a / entry) * 100, 3),
    },
  };
  markEquity(state, c.t);
}

function closePosition(state, cfg, symbol, exitPrice, t, reason) {
  const p = state.open[symbol];
  if (!p) return;
  // A recorded short makes money when price falls. This used the long formula
  // for every side, so a profitable short was logged as a loss of the same size
  // and the balance was debited for it.
  const dir = p.side === 'short' ? -1 : 1;
  const gross = (exitPrice - p.entry) * p.qty * dir;
  const fee = exitPrice * p.qty * (cfg.feePct / 100);
  // A trade's result counts both fees. It used to leave out the entry fee, so a
  // trade that lost money overall could still count as a win. The simulated
  // accounts paid that fee from the balance when the position opened; a recorded
  // real trade has not paid it yet.
  const entryFee = p.feePaid || 0;
  const pnl = gross - fee - entryFee;
  state.balance += p.real ? pnl : gross - fee;
  state.closed.push({
    ...p, exit: px(exitPrice), exitAt: t, reason,
    pnl: round(pnl, 2), pnlPct: round((((exitPrice / p.entry) - 1) * 100) * dir, 3),
    feePaid: round((p.feePaid || 0) + fee, 4),
  });
  delete state.open[symbol];
}

/**
 * Open a position by hand, in the same simulated account the AI trader uses.
 * Still no real order anywhere — this is practice, priced off the live market.
 */
export function openManual(state, cfg, symbol, price, { notional, stopPrice, targetPrice, at = Date.now(), ctx = null } = {}) {
  if (state.open[symbol]) return { ok: false, error: `You already have a demo position open on ${symbol}. Close it first.` };
  if (Object.keys(state.open).length >= cfg.maxPositions) return { ok: false, error: `You already have ${cfg.maxPositions} demo positions open — that is the limit in your settings.` };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'No live price for this coin right now.' };

  // what can be spent with the fee still covered
  const cash = Math.floor((freeCash(state) / (1 + cfg.feePct / 100)) * 100) / 100;
  if (+notional > cash + 1e-9 && cash >= 1) return { ok: false, error: `Only ${cash.toFixed(2)} of the demo balance is free (after the fee) — the rest is in open positions. Enter that much or less, or close a position first.` };
  const size = Math.min(+notional || 0, cash);
  if (!(size >= 1)) return { ok: false, error: cash < 1 ? 'All of the demo balance is in open positions. Close one first.' : 'Enter an amount of at least 1.' };

  const stop = Number.isFinite(stopPrice) && stopPrice > 0 && stopPrice < price ? stopPrice : price * 0.95;
  const tp = Number.isFinite(targetPrice) && targetPrice > price ? targetPrice : price + (price - stop) * cfg.rMultiple;
  const qty = size / price;
  const fee = size * (cfg.feePct / 100);
  state.balance -= fee;
  state.open[symbol] = {
    symbol, side: 'long', manual: true,
    entry: px(price), initialStop: px(stop), stop: px(stop), tp: px(tp),
    qty: round(qty, 10), notional: round(size, 2),
    openedAt: at, openScore: null, movedToBreakEven: false, feePaid: round(fee, 4),
    // what the chart looked like when you bought, so the AI learning page can grade your buys too
    ctx, riskCash: round((price - stop) * qty, 2),
  };
  markEquity(state, at);
  return { ok: true, position: state.open[symbol] };
}

/**
 * Record a trade you actually placed on an exchange.
 *
 * This is a journal, not an order router: nothing here reaches an exchange and
 * the app holds no keys. The point is that the same statistics — win rate,
 * drawdown, profit factor — get computed over your real trades as over the
 * simulated ones, so the comparison is like for like.
 */
export function recordRealTrade(state, cfg, { symbol, side = 'long', qty, entry, exit = null, fee = 0, openedAt = Date.now(), closedAt = null, note = '' }) {
  if (!symbol) return { ok: false, error: 'Which coin?' };
  const q = +qty, e = +entry;
  if (!(q > 0)) return { ok: false, error: 'Enter how much you bought, greater than zero.' };
  if (!(e > 0)) return { ok: false, error: 'Enter the price you bought at.' };
  if (side !== 'long' && side !== 'short') return { ok: false, error: 'Side must be long or short.' };

  const notional = q * e;
  const feePaid = Math.max(0, +fee || 0);

  if (exit === null || exit === '' || exit === undefined) {
    if (state.open[symbol]) return { ok: false, error: `You already have an open ${symbol} trade recorded. Close it first, or record it as a closed trade.` };
    state.open[symbol] = {
      symbol, side, real: true,
      entry: px(e), initialStop: null, stop: null, tp: null,
      qty: round(q, 10), notional: round(notional, 2),
      openedAt, openScore: null, movedToBreakEven: false, feePaid: round(feePaid, 4), note,
    };
    markEquity(state, openedAt);
    return { ok: true, position: state.open[symbol] };
  }

  const x = +exit;
  if (!(x > 0)) return { ok: false, error: 'Enter the price you sold at, or leave it blank if the trade is still open.' };
  const gross = side === 'long' ? (x - e) * q : (e - x) * q;
  const pnl = gross - feePaid;
  state.balance += pnl;
  state.closed.push({
    symbol, side, real: true, note,
    entry: px(e), exit: px(x), qty: round(q, 10), notional: round(notional, 2),
    openedAt, exitAt: closedAt || Date.now(), reason: 'recorded by you',
    pnl: round(pnl, 2), pnlPct: round((side === 'long' ? (x / e - 1) : (1 - x / e)) * 100, 3), // same formula as closePosition
    feePaid: round(feePaid, 4),
  });
  markEquity(state, closedAt || Date.now());
  return { ok: true, trade: state.closed[state.closed.length - 1] };
}

export const REAL_NOTICE = 'CoinVantage only keeps the record: it never places an order, connects to an exchange or holds any key.';

/** Close a position by hand at the current price. */
export function closeManual(state, cfg, symbol, price, at = Date.now(), reason = 'closed by you') {
  if (!state.open[symbol]) return { ok: false, error: `No open position on ${symbol}.` };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'No live price for this coin right now.' };
  closePosition(state, cfg, symbol, price, at, reason);
  markEquity(state, at);
  return { ok: true, trade: state.closed[state.closed.length - 1] };
}

// Open trades are valued at the latest close seen (their entry before any):
// a curve of the cash balance alone hid every fall that a trade recovered
// from before it closed, so "max drawdown" read shallower than it was.
function markEquity(state, t) {
  const last = state.equityCurve[state.equityCurve.length - 1];
  if (last && t - last.t < 3600e3) return; // at most one point per hour
  state.equityCurve.push({ t, equity: round(equity(state, state.px || {}), 2) });
  if (state.equityCurve.length > 2000) state.equityCurve.splice(0, state.equityCurve.length - 2000);
}

/**
 * The account's worst fall while a replay runs, open trades valued at every
 * candle close rather than only when they close. Pass `onBar` to replaySeries,
 * then read worstDropPct() once at the end.
 */
export function dropTracker(state) {
  const px = {};
  let t0 = null, peak = equity(state), dd = 0;
  const mark = () => { const e = equity(state, px); if (e > peak) peak = e; else if (peak > 0) dd = Math.max(dd, (peak - e) / peak); };
  return {
    onBar(c, symbol) { if (t0 !== null && c.t > t0) mark(); px[symbol] = c.c; t0 = c.t; },
    worstDropPct() { if (t0 !== null) mark(); return dd * 100; },
  };
}

/** Mark open positions to the latest prices, without closing anything. */
export function equity(state, pricesBySymbol = {}) {
  let openValue = 0;
  for (const [sym, p] of Object.entries(state.open)) {
    const px = pricesBySymbol[sym] ?? p.entry;
    openValue += (px - p.entry) * p.qty * (p.side === 'short' ? -1 : 1);
  }
  return state.balance + openValue;
}

export function stats(state, pricesBySymbol = {}) {
  const closed = state.closed;
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const eq = equity(state, pricesBySymbol);

  let peak = state.startingBalance, maxDd = 0;
  for (const p of state.equityCurve) {
    peak = Math.max(peak, p.equity);
    maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }

  return {
    equity: round(eq, 2),
    balance: round(state.balance, 2),
    startingBalance: state.startingBalance,
    returnPct: round(((eq / state.startingBalance) - 1) * 100, 2),
    trades: closed.length,
    openCount: Object.keys(state.open).length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    avgWinPct: wins.length ? round(wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length, 2) : null,
    avgLossPct: losses.length ? round(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length, 2) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    maxDrawdownPct: round(maxDd * 100, 2),
    feesPaid: round(closed.reduce((s, t) => s + (t.feePaid || 0), 0), 2),
    since: Math.min(state.startedAt, state.firstBarAt ?? state.startedAt),
    liveSince: state.startedAt,
  };
}

export const PAPER_NOTICE = 'Simulated money only. This trader places no orders, connects to no exchange and holds no keys — it shows what the strategy would have done, fees included.';
// The trades you place yourself are not "what the strategy would have done", so
// they used to carry the AI's notice by mistake.
export const DEMO_NOTICE = 'Simulated money only: no order is sent anywhere, no exchange is connected and no keys are held. The fee is counted as if the trade were real.';

/**
 * Record what one check of the market did, so the activity feed can show every
 * check with its real time — not only the trades. Kept short (last 40).
 */
export function logCheck(state, entry) {
  if (!state) return;
  state.log = [...(state.log || []), { t: Date.now(), ...entry }].slice(-40);
}
