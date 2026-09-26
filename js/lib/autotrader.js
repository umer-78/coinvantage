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

import { computeAll, atr } from './indicators.js';
import { scoreAt, labelFor, THRESHOLDS } from './signals.js';

/**
 * What this ruleset actually did on real candles.
 *
 * Measured 2026-09-26 with tools/evaluate-trader-live.mjs: 12 coins, Binance
 * candles (4,000 each on 15m and 1h, 3,500 on 4h, 2,200 on 1d), first half of
 * history used to choose settings, second half — never seen while choosing —
 * is what these numbers report. The simulation now advances all coins together
 * one candle at a time, exactly like the live account; the older harness ran
 * one coin's whole history before the next, which let a single open trade
 * block every other coin and gave different numbers.
 *
 * The settings (3 ATR stop, 3R target, trend filter on) were picked ONCE, as
 * the best average rank on the training halves of all four timeframes, then
 * scored on the test halves. Against the previous settings (2 ATR, no trend
 * filter) they did better on 15m, 4h and 1d and worse on 1h, with half the
 * fees and a smaller worst drawdown on three of four. The benchmark is still
 * equal-weight buy-and-hold of the same coins over the same window: the new
 * rules beat it on 4h (a falling market) and not on the other three.
 */
export const AUTOTRADER_TESTED = {
  '15m': { pickedReturn: 18.0, buyHold: 19.6, beatBuyHold: 7, configs: 48, trades: 109, feeDragPct: 5.8, profitFactor: 1.73, maxDrawdownPct: 9.9, previousReturn: 9.3, previousDrawdownPct: 12.0 },
  '1h': { pickedReturn: 24.8, buyHold: 40.7, beatBuyHold: 2, configs: 48, trades: 107, feeDragPct: 5.5, profitFactor: 1.56, maxDrawdownPct: 15.6, previousReturn: 31.8, previousDrawdownPct: 14.2 },
  '4h': { pickedReturn: 11.2, buyHold: -16.0, beatBuyHold: 33, configs: 48, trades: 82, feeDragPct: 3.3, profitFactor: 1.25, maxDrawdownPct: 30.5, previousReturn: -10.9, previousDrawdownPct: 36.8 },
  '1d': { pickedReturn: 70.7, buyHold: 143.4, beatBuyHold: 0, configs: 48, trades: 67, feeDragPct: 2.2, profitFactor: 1.79, maxDrawdownPct: 37.5, previousReturn: 65.6, previousDrawdownPct: 52.5 },
  coins: 12, candlesPerCoin: 4000, measuredOn: '2026-09-26',
  beatsBuyAndHold: false,
  // The self-review (js/lib/tradelearn.js) run inside the same test: it acted
  // in 1 of 8 runs (4h, old settings: -10.9% → -7.2%) and left the rest
  // unchanged. Too few cases to call an edge — it is a safety net, not a boost.
  selfReview: { runs: 8, acted: 1, note: 'Changed its rules in 1 of 8 held-out runs (4h: −10.9% → −7.2%); no change in the other 7.' },
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
  atrStop: 3,            // was 2; see AUTOTRADER_TESTED for the held-out comparison
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
  const ind = pre?.ind || computeAll(candles);
  const atrArr = pre?.atr || atr(candles, 14);
  const from = state.cursor[symbol] ?? 0;
  let processed = 0;
  let consecutiveExit = 0;
  let lastScore = null;

  for (let i = 210; i < candles.length; i++) {
    const c = candles[i];
    if (c.t <= from) continue;
    state.cursor[symbol] = c.t;
    if (state.liveFrom && c.t < state.liveFrom) continue;
    processed++;
    if (!state.firstBarAt || c.t < state.firstBarAt) state.firstBarAt = c.t;

    const pos = state.open[symbol];
    const score = pre?.scores ? pre.scores[i] : scoreAt(candles, ind, i).score;
    lastScore = score;

    // ---- manage an open position first, on this bar's high/low
    if (pos) {
      // Conservative: if both the stop and the target are inside one candle,
      // assume the stop hit first. Never flatter than reality.
      if (c.l <= pos.stop) { closePosition(state, cfg, symbol, Math.min(pos.stop, c.o), c.t, pos.stop > pos.initialStop ? 'trailing stop' : 'stop-loss'); }
      else if (pos.tp !== null && c.h >= pos.tp) { closePosition(state, cfg, symbol, pos.tp, c.t, 'target'); }
      else {
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
        const exitBars = cfg.signalExitBars;
        if (exitBars !== null && exitBars !== undefined) {
          consecutiveExit = score <= cfg.exitScore ? consecutiveExit + 1 : 0;
          if (consecutiveExit >= exitBars) closePosition(state, cfg, symbol, c.c, c.t, 'signal reversal');
        }
      }
      markEquity(state, c.t);
      continue;
    }

    // ---- look for an entry
    if (score < cfg.entryScore) continue;
    if (Object.keys(state.open).length >= cfg.maxPositions) continue;
    if (cfg.trendFilter && !(ind.ema200[i] && c.c > ind.ema200[i] && ind.ema50[i] > ind.ema200[i])) continue;
    if (cfg.minAdx && !(ind.adx.adx[i] >= cfg.minAdx)) continue;
    if (cfg.maxEntryRsi && ind.rsi[i] !== null && ind.rsi[i] > cfg.maxEntryRsi) continue;
    if (cfg.excluded?.includes(symbol)) continue;
    const a = atrArr[i];
    if (!a) continue;

    const entry = c.c;
    const stop = entry - cfg.atrStop * a;
    const riskPerUnit = entry - stop;
    if (riskPerUnit <= 0) continue;

    const riskCash = state.balance * (cfg.riskPct / 100);
    let notional = (riskCash / riskPerUnit) * entry;
    notional = Math.min(notional, state.balance * (cfg.maxPositionPct / 100), state.balance);
    if (notional < 1) continue;

    const qty = notional / entry;
    const fee = notional * (cfg.feePct / 100);
    state.balance -= fee;
    state.open[symbol] = {
      symbol, side: 'long',
      entry: round(entry), initialStop: round(stop), stop: round(stop),
      tp: cfg.trailAtr ? null : round(entry + cfg.rMultiple * riskPerUnit),
      qty: round(qty, 10), notional: round(notional, 2),
      openedAt: c.t, openScore: score, entryBar: cfg.entryScore, movedToBreakEven: false, feePaid: round(fee, 4),
      // What the market looked like at entry, so the self-review can learn from the log.
      riskCash: round(riskCash, 2),
      ctx: {
        trendUp: !!(ind.ema200[i] && c.c > ind.ema200[i]),
        adx: ind.adx.adx[i] === null ? null : round(ind.adx.adx[i], 1),
        rsi: ind.rsi[i] === null ? null : round(ind.rsi[i], 1),
        atrPct: round((a / entry) * 100, 3),
      },
    };
    markEquity(state, c.t);
  }
  return { processed, lastScore };
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
  const pnl = gross - fee;
  state.balance += pnl;
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
export function openManual(state, cfg, symbol, price, { notional, stopPrice, targetPrice, at = Date.now() } = {}) {
  if (state.open[symbol]) return { ok: false, error: `You already have a practice position open on ${symbol}. Close it first.` };
  if (Object.keys(state.open).length >= cfg.maxPositions) return { ok: false, error: `You already have ${cfg.maxPositions} practice positions open — that is the limit in your settings.` };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'No live price for this coin right now.' };

  const size = Math.min(+notional || 0, state.balance);
  if (!(size >= 1)) return { ok: false, error: 'Enter an amount of at least 1.' };

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

export const REAL_NOTICE = 'These are trades you placed yourself on an exchange. CoinVantage records them so you can measure your own results — it never places an order, connects to an exchange, or holds any key.';

/** Close a position by hand at the current price. */
export function closeManual(state, cfg, symbol, price, at = Date.now()) {
  if (!state.open[symbol]) return { ok: false, error: `No practice position open on ${symbol}.` };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: 'No live price for this coin right now.' };
  closePosition(state, cfg, symbol, price, at, 'closed by you');
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

/**
 * Record what one check of the market did, so the activity feed can show every
 * check with its real time — not only the trades. Kept short (last 40).
 */
export function logCheck(state, entry) {
  if (!state) return;
  state.log = [...(state.log || []), { t: Date.now(), ...entry }].slice(-40);
}
