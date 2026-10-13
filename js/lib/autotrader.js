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
 * Measured 2026-10-12 with tools/evaluate-trader-rules.mjs (the Evaluate
 * workflow): 12 coins, Binance candles (4,000 each on 15m and 1h, 3,500 on 4h,
 * 2,200 on 1d). All coins advance together, candle by candle, through the same
 * engine the live account runs, fees included; open positions at the end are
 * valued at the last close. The numbers are the NEWER half of each history,
 * which played no part in choosing anything.
 *
 * 432 rule sets were tried against these: trend, breakout and buy-the-dip
 * entries, momentum confirmation, a filter that pauses buying while Bitcoin is
 * in a downtrend, stops of 1.5-3 ATR, fixed and trailing exits. The one with the
 * best average rank on the OLDER halves (`alt`) did worse than the current rules
 * on the newer halves on 4h and 1d and about the same on 1h, so the current
 * rules stay. On 15m only 3 of the 432 made money after fees.
 *
 * The benchmark is equal-weight buy-and-hold of the same coins over the same
 * window: the rules beat it on 4h (a falling market) and not on the other three.
 */
export const AUTOTRADER_TESTED = {
  '15m': { pickedReturn: -6.26, buyHold: 1.81, maxDrawdownPct: 13.89, trades: 152, winRate: 23.0, feeDragPct: 6.7, from: '2026-09-21', to: '2026-10-12', alt: { ret: -4.8, dd: 9.63 }, madeMoney: 3 },
  '1h': { pickedReturn: 11.86, buyHold: 36.55, maxDrawdownPct: 12.97, trades: 171, winRate: 29.8, feeDragPct: 7.7, from: '2026-07-20', to: '2026-10-12', alt: { ret: 11.34, dd: 9.87 }, madeMoney: 334 },
  '4h': { pickedReturn: 3.98, buyHold: -12.35, maxDrawdownPct: 22.86, trades: 98, winRate: 25.5, feeDragPct: 3.6, from: '2025-12-24', to: '2026-10-12', alt: { ret: -4.06, dd: 20.22 }, madeMoney: 90 },
  '1d': { pickedReturn: 110.31, buyHold: 123.26, maxDrawdownPct: 17.81, trades: 100, winRate: 35.0, feeDragPct: 3.8, from: '2023-10-09', to: '2026-10-12', alt: { ret: 70.84, dd: 18.09 }, madeMoney: 384 },
  coins: 12, configs: 432, measuredOn: '2026-10-12',
  altRules: 'breakout entry with momentum confirmation and the Bitcoin-trend filter, 3 ATR stop, 2R target',
  beatsBuyAndHold: false,
  // The self-review (js/lib/tradelearn.js), measured 2026-09-26 with
  // tools/evaluate-trader-live.mjs: it acted in 1 of 8 held-out runs (4h, older
  // rules: -10.9% -> -7.2%) and left the rest unchanged. Too few cases to call
  // an edge: it is a safety net, not a boost.
  selfReview: { runs: 8, acted: 1, note: 'Changed its rules in 1 of 8 held-out runs (4h: −10.9% → −7.2%); no change in the other 7.' },
};

/**
 * Rules picked for one chart. tools/evaluate-trader-folds.mjs (24 coins in one
 * account, shared cash, fees) cuts each chart's history into four blocks and
 * three times picks the best of 432 rule sets on everything before a block,
 * then runs it on that block next to the standard rules. The bar, set before
 * the first run: better in two of three blocks, by a point on average, worst
 * drop no more than five points deeper. 1h and 1d have cleared it in every
 * run and trade the same pick made on their full history; 4h never has and
 * keeps the standard rules. 15m (ten-day blocks) has gone both ways between
 * runs hours apart; the last two cleared it with the same pick, so it trades
 * that pick (re-run 2026-10-13).
 */
export const CHART_RULES = {
  '15m': { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, marketFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
  '1h': { entryMode: 'trend', momentumConfirm: true, trendFilter: true, marketFilter: false, atrStop: 3, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
  '1d': { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, marketFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
};

/**
 * That test's results (run 2026-10-13), averaged over its three blocks:
 * `standard` is the standard rules, `own` the chart's own pick, `hold` equal
 * amounts of every coin held through the block. Returns, drops and fees are %
 * of the balance per block; trades are the total over the three. `dd` is the
 * worst drop with open trades valued at every candle close — what the account
 * would have shown; `ddClosed` counts only closed trades, the measure the
 * rules were picked and the bar judged by (it hid every fall a trade recovered
 * from before it closed). `holdDrop` is holding's worst drop, measured the
 * same way. `range` and `up` are the worst and best block and the blocks with
 * a gain, for the rules the chart trades. `byRisk` is the same test with every
 * block replayed at six risk levels (same rules, 5 open at most, 25% a coin):
 * average, worst and best block, average worst drop, blocks with a gain,
 * trades a block. `fillCost`: points a block the shipped rules lost with
 * every fill 0.05% worse each way (spread and slippage, which the test
 * otherwise leaves out) — from a re-run 30 minutes later that made the same
 * decisions.
 *
 * `signals`: what followed each buy of those rules on its own (every coin run
 * alone, one trade at a time, blocks the rules were not picked on). R is the
 * result over the amount risked at entry, fees included; `fwdUpPct` the share
 * of buys followed by a higher price H candles later (95% range fwdLo–fwdHi)
 * against `baseUpPct` from any candle; `randPct` a buy at a random candle of
 * the block held as long. On no chart did a buy pick direction better than
 * chance, and on none did it beat a random buy held as long: the 1d account
 * beat holding by sitting out falls (+3.3% against −56.8% in 2022–23, a worst
 * drop of 19.7% against 64.0% for holding), not by picking winners. The coin
 * page shows it.
 */
export const CHART_TESTED = {
  measuredOn: '2026-10-13', coins: 24, configs: 432, blocks: 3,
  '15m': { range: [-4.69, 22.01], up: 2, from: '2026-09-12', to: '2026-10-13', block: '10 days', better: 2, adopt: true, hold: 7.19, holdDrop: 9.86, fillCost: 1.55, standard: { ret: 4.21, dd: 11.68, ddClosed: 8.49, trades: 279, win: 27.24, fees: 3.71 }, own: { ret: 6.88, dd: 9.26, ddClosed: 7.09, trades: 201, win: 32.84, fees: 2.95 },
    byRisk: { 0.5: { ret: 5.05, lo: -2.78, hi: 19.37, dd: 6.32, up: 1, trades: 68 }, 1: { ret: 5.89, lo: -4.25, hi: 22.18, dd: 8.79, up: 1, trades: 67 }, 1.5: { ret: 6.88, lo: -4.69, hi: 22.01, dd: 9.26, up: 2, trades: 67 }, 2: { ret: 7.36, lo: -4.74, hi: 22.01, dd: 9.5, up: 2, trades: 66 }, 3: { ret: 7.45, lo: -4.74, hi: 22.01, dd: 9.53, up: 2, trades: 66 }, 5: { ret: 7.45, lo: -4.74, hi: 22.01, dd: 9.53, up: 2, trades: 66 } },
    signals: { n: 583, winPct: 28.82, avgR: -0.09, avgWinR: 2.42, avgLossR: -1.11, holdMedian: 22, avgPct: 0.18, randPct: 0.42, H: 8, fwdN: 582, fwdUpPct: 45.7, fwdLo: 41.7, fwdHi: 49.77, baseUpPct: 50.39 } },
  '1h': { range: [-12.34, 19.29], up: 2, from: '2026-06-10', to: '2026-10-13', block: '6 weeks', better: 2, adopt: true, hold: 15.22, holdDrop: 13.79, fillCost: 1.62, standard: { ret: -1.53, dd: 17.67, ddClosed: 15.56, trades: 261, win: 25.67, fees: 3.59 }, own: { ret: 6.69, dd: 15.29, ddClosed: 12.97, trades: 210, win: 29.52, fees: 2.99 },
    byRisk: { 0.5: { ret: 3.91, lo: -2.95, hi: 10.51, dd: 9.63, up: 2, trades: 70 }, 1: { ret: 4.79, lo: -8.53, hi: 13.93, dd: 14.32, up: 2, trades: 70 }, 1.5: { ret: 6.69, lo: -12.34, hi: 19.29, dd: 15.29, up: 2, trades: 70 }, 2: { ret: 5.63, lo: -11.83, hi: 16.22, dd: 14.8, up: 2, trades: 69 }, 3: { ret: 4.97, lo: -11.85, hi: 15.93, dd: 15.25, up: 2, trades: 69 }, 5: { ret: 4.76, lo: -11.85, hi: 15.3, dd: 15.4, up: 2, trades: 69 } },
    signals: { n: 553, winPct: 27.31, avgR: 0.01, avgWinR: 2.65, avgLossR: -0.98, holdMedian: 27, avgPct: 0.25, randPct: 1.05, H: 12, fwdN: 553, fwdUpPct: 46.29, fwdLo: 42.18, fwdHi: 50.46, baseUpPct: 50.35 } },
  '4h': { range: [-18.21, 18], up: 1, from: '2025-08-02', to: '2026-10-13', block: '5 months', better: 1, adopt: false, hold: -10.59, holdDrop: 38.39, fillCost: 1.36, standard: { ret: -1.81, dd: 27.05, ddClosed: 24.59, trades: 216, win: 24.07, fees: 2.54 }, own: { ret: -3.38, dd: 20.57, ddClosed: 17.35, trades: 173, win: 30.06, fees: 2.56 },
    byRisk: { 0.5: { ret: 2, lo: -4.63, hi: 13.71, dd: 11.6, up: 1, trades: 72 }, 1: { ret: -0.09, lo: -13.14, hi: 17.99, dd: 21.33, up: 1, trades: 72 }, 1.5: { ret: -1.81, lo: -18.21, hi: 18, dd: 27.05, up: 1, trades: 72 }, 2: { ret: -5.47, lo: -19.63, hi: 10.45, dd: 30.66, up: 1, trades: 72 }, 3: { ret: -9.65, lo: -19.47, hi: 7.39, dd: 34.36, up: 1, trades: 70 }, 5: { ret: -14.43, lo: -24.85, hi: -0.27, dd: 38.26, up: 0, trades: 67 } },
    signals: { n: 547, winPct: 21.39, avgR: -0.06, avgWinR: 2.49, avgLossR: -0.75, holdMedian: 22, avgPct: -0.41, randPct: 0.22, H: 6, fwdN: 547, fwdUpPct: 46.62, fwdLo: 42.48, fwdHi: 50.81, baseUpPct: 47.61 } },
  '1d': { range: [3.34, 23.28], up: 3, from: '2022-04-08', to: '2026-10-13', block: '18 months', better: 2, adopt: true, hold: 10.71, holdDrop: 63.97, fillCost: 1.18, standard: { ret: 12.66, dd: 19.88, ddClosed: 17, trades: 133, win: 27.82, fees: 0.97 }, own: { ret: 16.26, dd: 19.69, ddClosed: 14.22, trades: 176, win: 34.66, fees: 2.55 },
    byRisk: { 0.5: { ret: 8.7, lo: 1.02, hi: 13.68, dd: 7.8, up: 3, trades: 59 }, 1: { ret: 15.85, lo: 2.19, hi: 23.65, dd: 14.37, up: 3, trades: 59 }, 1.5: { ret: 16.26, lo: 3.34, hi: 23.28, dd: 19.69, up: 3, trades: 59 }, 2: { ret: 17.13, lo: 4.75, hi: 33.82, dd: 25.03, up: 3, trades: 59 }, 3: { ret: 9.09, lo: 3.3, hi: 19.72, dd: 30.42, up: 3, trades: 59 }, 5: { ret: 9.25, lo: -0.97, hi: 23.59, dd: 31.6, up: 2, trades: 56 } },
    signals: { n: 327, winPct: 31.19, avgR: 0.2, avgWinR: 2.54, avgLossR: -0.86, holdMedian: 8, avgPct: 0.87, randPct: 1.78, H: 7, fwdN: 325, fwdUpPct: 48.31, fwdLo: 42.93, fwdHi: 53.73, baseUpPct: 46.93 } },
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
  const buy = c.entryMode === 'pullback' ? `When a coin in an uptrend dips until the score falls to −${c.entryScore} or lower, it buys the dip${extra}.`
    : c.entryMode === 'breakout' ? `When a coin closes above its highest price of the previous 20 candles${c.trendFilter ? ' in an uptrend' : ''}, it buys${extra}.`
      : `When the score clears +${c.entryScore}${c.trendFilter ? ' in an uptrend' : ''} it buys${extra}.`;
  return `${buy} It sells at ${c.trailAtr ? `a stop that trails ${c.trailAtr} ATR under the highest price since it bought` : `the target (${c.rMultiple}R)`}, the stop (${c.atrStop} ATR below entry)${c.signalExitBars ? ` or ${c.entryMode === 'pullback' ? 'once the bounce has come' : `after ${c.signalExitBars} candles of signal reversal`}` : ''}.${c.volScale ? ' It buys less while the coin is more volatile than usual (down to half).' : ''}`;
}

export function rulesForChart(cfg, interval, lessons = []) {
  // Your own rules are traded as you set them: neither the chart's tested
  // rules nor the self-review's trend lesson overrides what you chose.
  if (cfg.strategy === 'custom') return { ...cfg, ...pickRules({ ...CUSTOM_DEFAULT, ...(cfg.custom || {}) }), interval };
  const trend = [...(lessons || [])].reverse().find((h) => h.lens === 'trend');
  return { ...cfg, ...(CHART_RULES[interval] || {}), ...(trend ? { trendFilter: !trend.undo } : {}), volScale: VOL_SCALE.charts.includes(interval), interval };
}

/**
 * Volatility-scaled position size (DEFAULT_CONFIG.volScale), A/B-tested by
 * tools/evaluate-trader-folds.mjs on the rules each chart ships, block by
 * block. The bar, written in the script before the run: better on return −
 * ½·worst drop in at least 2 of 3 blocks, by at least a point on average, and
 * an average return no more than a point lower. Only 4h cleared it, so only
 * 4h uses it. Differences are percentage points per block, with minus without.
 */
export const VOL_SCALE = {
  measuredOn: '2026-10-13', charts: ['4h'],
  // the run behind CHART_TESTED; `dd` is the change in the worst drop with
  // open trades valued at every close, `objective` the bar's (closed trades)
  tested: {
    '15m': { better: 1, ret: -2.19, dd: -1.48, objective: -2.06 },
    '1h': { better: 1, ret: -1.04, dd: -0.72, objective: -0.75 },
    '4h': { better: 3, ret: 0.15, dd: -2.29, objective: 1.38 },
    '1d': { better: 1, ret: 4.17, dd: -1.54, objective: 4.89 },
  },
};

/**
 * What the settings can be expected to make, from the walk-forward test of
 * the rules this chart trades (CHART_TESTED): the average per test period and
 * the worst and best period. The test was run at six risk levels (byRisk);
 * between two of them the figures are read off a straight line. More risk did
 * not mean more return: above 2% a trade the results stayed about flat on 15m and
 * 1h (the 25%-a-coin cap binds first) and got worse on 4h and 1d, with deeper
 * drops. Measured with the standard caps (5 open, 25% a coin) on 24 coins;
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
    levels: levels.map((l) => ({ risk: l, ...x.byRisk[l] })), coins: CHART_TESTED.coins,
    ...at, capsDiffer: (cfg.maxPositionPct ?? 25) !== 25 || (cfg.maxPositions ?? 5) !== 5,
  };
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
export const MAX_COINS = 30;

/**
 * The tested chart that did best, judged in this order: the most test
 * periods with a gain, then the most made above holding the same coins,
 * then the smaller worst drop.
 */
export function bestTestedChart() {
  const rows = Object.entries(CHART_TESTED).filter(([, x]) => x && typeof x === 'object' && x.standard).map(([iv, x]) => {
    const r = x.adopt ? x.own : x.standard;
    return { iv, up: x.up ?? 0, edge: r.ret - x.hold, dd: r.dd, ret: r.ret, hold: x.hold, block: x.block };
  });
  rows.sort((a, b) => b.up - a.up || b.edge - a.edge || a.dd - b.dd);
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
  if (cfg.strategy === 'custom') out.push('Your own rules have no published test. Use "Test these settings" to see how they did on recent candles before you rely on them.');
  if (cfg.riskPct > 2) out.push(`Risking ${cfg.riskPct}% a trade means ten losing trades in a row, which happens, cost about ${Math.round((1 - (1 - cfg.riskPct / 100) ** 10) * 100)}% of the account.`);
  if (cfg.maxPositions * (cfg.maxPositionPct ?? 25) < 50) out.push(`With at most ${cfg.maxPositions} open and ${cfg.maxPositionPct ?? 25}% in one coin, no more than ${cfg.maxPositions * (cfg.maxPositionPct ?? 25)}% of the account is ever invested.`);
  if ((cfg.universe || []).length < 3) out.push('With fewer than three coins the trader will often have nothing to do.');
  if ((cfg.feePct ?? 0.1) > 0.25) out.push(`A ${cfg.feePct}% fee each way is high: on short charts fees can take most of the gains.`);
  return out;
}

/**
 * Each coin's own rules for the daily chart, chosen on its own full daily
 * history by tools/evaluate-selection.mjs (24 coins, 216 rule sets each; a
 * coin keeps the daily rules unless others did better on it). On for daily
 * accounts unless switched off in Settings. Measured with everything chosen
 * on the older half of the data only (the daily rules too, picked the way the
 * shipped ones were) and run on the newer half, all coins in one account.
 * First run (2026-10-12): +46.0% against +37.0% for the daily rules alone,
 * worst drop (closed trades) 33.2% against 29.3% — inside the bar set before
 * the test (no more than five points deeper), so switched on. Re-run a day
 * later (`tested`, with drops valued at every close too): +89.8% against
 * +33.3%, closed-trade drop 34.7% against 29.3% — 5.4 points, just outside
 * the bar, which would make them an opt-in. A published decision changes only
 * when two runs in a row agree, so they stay on until the next run; one long
 * account test swings this much with its start date. Holding all 24 coins
 * made +83.6% over the same years, with a worst drop of 72.2%. In a
 * walk-forward check over three periods each coin's own rules beat one shared
 * rule set in all three on daily (+3.2% against +1.1% a period); on 1h they
 * did not, and 4h, which had not, did in 2 of 3 in the re-run — daily only
 * until a second run agrees. The coins are today's survivors, which flatters
 * every backtest of them.
 */
export const PER_COIN_RULES = {
  interval: '1d', measuredOn: '2026-10-13', coins: 24,
  tested: { from: '2023-10-10', to: '2026-10-13', standard: { ret: 33.31, dd: 35.6, ddClosed: 29.25, trades: 136, winRate: 32.4 }, own: { ret: 89.77, dd: 40.15, ddClosed: 34.69, trades: 151, winRate: 32.5 }, hold: 83.6, holdDrop: 72.2, walkForward: { periods: 3, better: 3, own: 3.16, shared: 1.11 }, firstRun: { own: 46.04, standard: 36.95 } },
  rules: {
    BTC: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    ETH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    BNB: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    SOL: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    XRP: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    DOGE: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    ADA: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    AVAX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    LINK: { entryMode: 'trend', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    LTC: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: null },
    TRX: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: null, signalExitBars: null },
    DOT: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    BCH: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
    ETC: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: null },
    XLM: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    ATOM: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 2, trailAtr: null, signalExitBars: null },
    FIL: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 2, trailAtr: null, signalExitBars: 2 },
    UNI: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    AAVE: { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, atrStop: 3, rMultiple: 3, trailAtr: null, signalExitBars: 2 },
    NEAR: { entryMode: 'trend', momentumConfirm: true, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    ALGO: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 3, signalExitBars: 2 },
    HBAR: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
    INJ: { entryMode: 'breakout', momentumConfirm: false, trendFilter: false, atrStop: 1.5, rMultiple: 3, trailAtr: 4, signalExitBars: null },
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
  stepBar(state, cfg, s, i, score);
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
function wantsEntry(cfg, score, ind, i, c) {
  if (cfg.entryMode === 'pullback') return score <= -cfg.entryScore;
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
export function blockerText(code, cfg, score) {
  return {
    signal: cfg.entryMode === 'breakout' ? 'it has not closed above its highest price of the previous 20 candles'
      : cfg.entryMode === 'pullback' ? `there is no dip: the score is ${score}, the rule needs −${cfg.entryScore} or lower`
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
  return { ...base, action: 'wait', code, why: code ? blockerText(code, cfg, score) : 'the rule found no entry on it', last: t ? { exitAt: t.exitAt, pnlPct: t.pnlPct, why: t.reason } : null };
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
        if (trail > pos.stop) pos.stop = round(trail);
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
  if (Object.keys(state.open).length >= cfg.maxPositions) return;
  if (entryBlocker(cfg, s, i, score) !== null) return;
  const a = atrArr[i];
  if (!a) return;

  const entry = c.c;
  const stop = entry - cfg.atrStop * a;
  const riskPerUnit = entry - stop;
  if (riskPerUnit <= 0) return;

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
  if (notional < 1) return;

  const qty = notional / entry;
  const fee = notional * (cfg.feePct / 100);
  state.balance -= fee;
  state.open[symbol] = {
    symbol, side: 'long',
    entry: round(entry), initialStop: round(stop), stop: round(stop),
    tp: cfg.trailAtr ? null : round(entry + cfg.rMultiple * riskPerUnit),
    qty: round(qty, 10), notional: round(notional, 2),
    openedAt: c.t, openScore: score, entryBar: cfg.entryMode === 'pullback' ? -cfg.entryScore : cfg.entryMode === 'breakout' ? null : cfg.entryScore, entryMode: cfg.entryMode || 'trend',
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
    ...p, exit: round(exitPrice), exitAt: t, reason,
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
    entry: round(price), initialStop: round(stop), stop: round(stop), tp: round(tp),
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
      entry: round(e), initialStop: null, stop: null, tp: null,
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
    entry: round(e), exit: round(x), qty: round(q, 10), notional: round(notional, 2),
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
