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
 * Rules picked for one chart. tools/evaluate-trader-folds.mjs (2026-10-12, 24
 * coins in one account, shared cash, fees) cut each chart's history into four
 * blocks and three times picked the best of 432 rule sets on everything before
 * a block, then ran it on that block next to the standard rules. The bar,
 * set before the run: better in two of three blocks, by a point on average,
 * worst drop no more than five points deeper. 1h and 1d cleared it and trade
 * the same pick made on their full history; 15m and 4h did not and keep the
 * standard rules. (A first run cleared 15m too; re-run twenty minutes later
 * on slightly newer candles it did not. Its blocks are ten days long.)
 */
export const CHART_RULES = {
  '1h': { entryMode: 'trend', momentumConfirm: true, trendFilter: true, marketFilter: false, atrStop: 3, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
  '1d': { entryMode: 'breakout', momentumConfirm: true, trendFilter: false, marketFilter: false, atrStop: 2, rMultiple: 3, trailAtr: 4, signalExitBars: 2 },
};

/**
 * That test's results, averaged over its three blocks: `standard` is the
 * standard rules, `own` the chart's own pick, `hold` equal amounts of every
 * coin held through the block. Returns, drops and fees are % of the balance
 * per block; trades are the total over the three.
 */
export const CHART_TESTED = {
  measuredOn: '2026-10-12', coins: 24, configs: 432, blocks: 3,
  '15m': { from: '2026-09-11', to: '2026-10-12', block: '10 days', better: 1, adopt: false, hold: 7.76, standard: { ret: 5.84, dd: 9.68, trades: 273, win: 27.5, fees: 3.6 }, own: { ret: 6.93, dd: 6.51, trades: 250, win: 30.4, fees: 3.61 } },
  '1h': { from: '2026-06-09', to: '2026-10-12', block: '6 weeks', better: 2, adopt: true, hold: 16.15, standard: { ret: 1.27, dd: 15.31, trades: 253, win: 26.9, fees: 3.5 }, own: { ret: 7.12, dd: 12.86, trades: 218, win: 33.0, fees: 3.21 } },
  '4h': { from: '2025-08-01', to: '2026-10-12', block: '5 months', better: 0, adopt: false, hold: -9.88, standard: { ret: 0.7, dd: 23.32, trades: 218, win: 24.8, fees: 2.6 }, own: { ret: -13.42, dd: 25.28, trades: 218, win: 28.9, fees: 3.08 } },
  '1d': { from: '2022-04-07', to: '2026-10-12', block: '18 months', better: 2, adopt: true, hold: 10.39, standard: { ret: 13.03, dd: 16.95, trades: 134, win: 27.6, fees: 0.97 }, own: { ret: 16.97, dd: 14.22, trades: 175, win: 34.9, fees: 2.54 } },
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
  return `${buy} It sells at ${c.trailAtr ? `a stop that trails ${c.trailAtr} ATR under the highest price since it bought` : `the target (${c.rMultiple}R)`}, the stop (${c.atrStop} ATR below entry)${c.signalExitBars ? ` or ${c.entryMode === 'pullback' ? 'once the bounce has come' : `after ${c.signalExitBars} candles of signal reversal`}` : ''}.`;
}

export function rulesForChart(cfg, interval, lessons = []) {
  const trend = [...(lessons || [])].reverse().find((h) => h.lens === 'trend');
  return { ...cfg, ...(CHART_RULES[interval] || {}), ...(trend ? { trendFilter: !trend.undo } : {}), interval };
}

/**
 * Each coin's own rules for the daily chart, chosen on its own full daily
 * history by tools/evaluate-selection.mjs (24 coins, 216 rule sets each; a
 * coin keeps the daily rules unless others did better on it). On for daily
 * accounts unless switched off in Settings. Measured with everything chosen
 * on the older half of the data only (the daily rules too, picked the way the
 * shipped ones were) and run on the newer half, all coins in one account: it
 * made +46.0% against +37.0% for the daily rules alone, with a worst drop of
 * 33.2% against 29.3% — inside the bar set before the test (no more than five
 * points deeper). Holding all 24 coins made +88.7% over the same years. In a
 * walk-forward check over three periods each coin's own rules beat one shared
 * rule set in all three on daily (+2.9% against +1.3% a period); on 1h and 4h
 * they did not, so they are used on the daily chart only. The coins are
 * today's survivors, which flatters every backtest of them.
 */
export const PER_COIN_RULES = {
  interval: '1d', measuredOn: '2026-10-12', coins: 24,
  tested: { from: '2023-10-09', to: '2026-10-12', standard: { ret: 36.95, dd: 29.25, trades: 135, winRate: 32.6 }, own: { ret: 46.04, dd: 33.2, trades: 145, winRate: 33.1 }, hold: 88.69, walkForward: { periods: 3, better: 3, own: 2.94, shared: 1.32 } },
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
export function replaySeries(state, cfg, series, { from = 210, result = {} } = {}) {
  const pos = series.map(() => from);
  const rules = series.map((s) => rulesFor(cfg, s.symbol));
  for (const s of series) result[s.symbol] ||= { processed: 0, lastScore: null };
  for (;;) {
    let k = -1;
    for (let j = 0; j < series.length; j++) {
      if (pos[j] < series[j].candles.length && (k < 0 || series[j].candles[pos[j]].t < series[k].candles[pos[k]].t)) k = j;
    }
    if (k < 0) break;
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

function stepBar(state, cfg, s, i, score) {
  const { symbol, candles, ind } = s;
  const atrArr = s.atr;
  const c = candles[i];
  const pos = state.open[symbol];

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
  if (!wantsEntry(cfg, score, ind, i, c)) return;
  if (Object.keys(state.open).length >= cfg.maxPositions) return;
  if ((cfg.trendFilter || cfg.entryMode === 'pullback') && !(ind.ema200[i] && c.c > ind.ema200[i] && ind.ema50[i] > ind.ema200[i])) return;
  // The chart score adds oversold readings as reasons to buy, so early in a
  // fall it can still read high. Confirmation asks for the short-term trend
  // and momentum to be pointing up as well.
  if (cfg.momentumConfirm && !(c.c > ind.ema20[i] && ind.ema20[i] > ind.ema50[i] && ind.macd.hist[i] > 0)) return;
  // Most coins fall together: no new buys while Bitcoin itself is in a downtrend.
  if (s.regime && s.regime.get(c.t) === false) return;
  if (cfg.minAdx && !(ind.adx.adx[i] >= cfg.minAdx)) return;
  if (cfg.maxEntryRsi && ind.rsi[i] !== null && ind.rsi[i] > cfg.maxEntryRsi) return;
  if (cfg.excluded?.includes(symbol)) return;
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

function markEquity(state, t) {
  const last = state.equityCurve[state.equityCurve.length - 1];
  if (last && t - last.t < 3600e3) return; // at most one point per hour
  state.equityCurve.push({ t, equity: round(state.balance, 2) });
  if (state.equityCurve.length > 2000) state.equityCurve.splice(0, state.equityCurve.length - 2000);
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
