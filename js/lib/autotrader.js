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
 * Measured with tools/evaluate-autotrader.mjs: 12 coins, 4,000 Binance candles
 * each, 108 settings per timeframe. The first half of history was used to pick
 * settings and the second half — never seen during tuning — is what these
 * numbers report. The benchmark is equal-weight buy-and-hold of the same 12
 * coins over the same window, because a long-only strategy in a rising market
 * makes money without any skill at all.
 *
 * The result is the reason this feature is labelled a demonstration rather than
 * a trading system: at NO setting, on ANY timeframe, did it beat simply owning
 * the coins on data it had not been tuned on. It is published here so the page
 * has to state it.
 */
export const AUTOTRADER_TESTED = {
  '1h': { pickedReturn: 9.8, buyHold: 25.8, beatBuyHold: 0, configs: 108, trades: 100, feeDragPct: 5.2, profitFactor: 1.43 },
  '4h': { pickedReturn: -19.3, buyHold: -24.7, beatBuyHold: 0, configs: 108, trades: 75, feeDragPct: 3.2, profitFactor: 0.44 },
  '1d': { pickedReturn: 6.2, buyHold: 119.6, beatBuyHold: 1, configs: 108, trades: 299, feeDragPct: 16.5, profitFactor: 1.05 },
  coins: 12, candlesPerCoin: 4000,
  beatsBuyAndHold: false,
};

export const DEFAULT_CONFIG = {
  startingBalance: 10000,
  riskPct: 1.5,          // % of balance risked per trade (stop distance = this loss)
  maxPositions: 5,
  maxPositionPct: 25,    // never put more than this share of the balance in one coin
  // Chosen on the training half and left alone: a much higher entry bar cuts the
  // trade count from ~500 to ~100, which cuts fee drag from roughly 20% of the
  // balance to 5% — the single biggest change to the result. 2 ATR / 3R beat
  // every other stop/target pair on the same half.
  entryScore: 65,
  exitScore: -65,
  atrStop: 2,
  rMultiple: 3,
  feePct: 0.1,
  // Two behaviours that were hardcoded and therefore never measured. Moving the
  // stop to break-even converts would-be winners into scratches, and exiting on
  // a signal reversal cuts trades before the target — both sound prudent and
  // both cost money if they are wrong, so they are settings now and the grid in
  // tools/evaluate-autotrader.mjs tests them.
  breakEvenAtR: null,    // measured: moving the stop to entry cost money, so it is off
  signalExitBars: 2,     // close after this many consecutive reversal bars; null = never
  interval: '1h',
  universe: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'LINK'],
};

export function newState(cfg = DEFAULT_CONFIG) {
  return {
    version: 1,
    startedAt: Date.now(),
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
export function replaySymbol(state, cfg, symbol, candles) {
  if (!candles || candles.length < 220) return { processed: 0 };
  const ind = computeAll(candles);
  const atrArr = atr(candles, 14);
  const from = state.cursor[symbol] ?? 0;
  let processed = 0;
  let consecutiveExit = 0;

  for (let i = 210; i < candles.length; i++) {
    const c = candles[i];
    if (c.t <= from) continue;
    processed++;
    state.cursor[symbol] = c.t;

    const pos = state.open[symbol];
    const { score } = scoreAt(candles, ind, i);

    // ---- manage an open position first, on this bar's high/low
    if (pos) {
      // Conservative: if both the stop and the target are inside one candle,
      // assume the stop hit first. Never flatter than reality.
      if (c.l <= pos.stop) { closePosition(state, cfg, symbol, pos.stop, c.t, 'stop-loss'); }
      else if (c.h >= pos.tp) { closePosition(state, cfg, symbol, pos.tp, c.t, 'target'); }
      else {
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
      tp: round(entry + cfg.rMultiple * riskPerUnit),
      qty: round(qty, 10), notional: round(notional, 2),
      openedAt: c.t, openScore: score, movedToBreakEven: false, feePaid: round(fee, 4),
    };
    markEquity(state, c.t);
  }
  return { processed };
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
    pnl: round(pnl, 2), pnlPct: round((side === 'long' ? (x / e - 1) : (e / x - 1)) * 100, 3),
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
    since: state.startedAt,
  };
}

export const PAPER_NOTICE = 'Simulated money only. This trader places no orders, connects to no exchange and holds no keys — it shows what the strategy would have done, fees included.';
