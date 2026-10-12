// Strongest-coins rotation: hold the coins that rose most over a look-back
// window, re-ranked on a fixed schedule, and hold cash while Bitcoin is in a
// downtrend. A different question from the AI trader's rules, which time
// entries on one coin at a time: this one chooses WHICH coins to hold.
//
// Measured by tools/evaluate-selection.mjs: settings chosen on older candles,
// result reported on newer candles that played no part in the choice.
import { ema } from './indicators.js';

export const ROTATION_DEFAULT = { lookback: 30, top: 3, every: 7, btcFilter: true, absolute: true, feePct: 0.1, startingBalance: 10000 };

/**
 * Lines several coins' candles up on one clock (Bitcoin's, or the first
 * series'), so candle i means the same moment for every coin. A coin with no
 * candle at a moment (not listed yet, or a gap) has null there.
 */
export function alignSeries(candlesBySymbol, clock = 'BTC') {
  const base = candlesBySymbol[clock] || Object.values(candlesBySymbol)[0] || [];
  const times = base.map((c) => c.t);
  const at = new Map(times.map((t, i) => [t, i]));
  const opens = {}, closes = {};
  for (const [s, candles] of Object.entries(candlesBySymbol)) {
    const o = new Array(times.length).fill(null), c = new Array(times.length).fill(null);
    for (const k of candles) { const i = at.get(k.t); if (i !== undefined) { o[i] = k.o; c[i] = k.c; } }
    opens[s] = o; closes[s] = c;
  }
  // Bitcoin above its 200-candle average with the 50 above the 200: the same
  // test as the AI trader's market filter.
  const btc = closes[clock] || [];
  const e50 = ema(btc.map((x) => x ?? 0), 50), e200 = ema(btc.map((x) => x ?? 0), 200);
  const btcOk = btc.map((x, i) => x !== null && e200[i] !== null && e50[i] !== null && x > e200[i] && e50[i] > e200[i]);
  return { times, opens, closes, btcOk };
}

/** The coins to hold after candle i closes, strongest first. */
export function rotationPicks(aligned, i, cfg = ROTATION_DEFAULT) {
  if (cfg.btcFilter && !aligned.btcOk[i]) return [];
  const ranked = [];
  for (const [symbol, c] of Object.entries(aligned.closes)) {
    const now = c[i], then = c[i - cfg.lookback];
    if (!(now > 0) || !(then > 0)) continue;
    const m = now / then - 1;
    if (cfg.absolute && m <= 0) continue;
    ranked.push({ symbol, momentumPct: m * 100 });
  }
  ranked.sort((a, b) => b.momentumPct - a.momentumPct);
  return ranked.slice(0, cfg.top);
}

/**
 * Replays the rotation from candle `from` to candle `to` (exclusive). Picks
 * are made on a candle's close and traded at the next candle's open, so no
 * decision sees a price it could not have known. Coins that stay in the top
 * are left alone; a coin that drops out is sold and its slot bought into a
 * newcomer. Fees are charged on every buy and sell.
 */
export function rotationReplay(aligned, cfg = ROTATION_DEFAULT, { from = cfg.lookback + 200, to = aligned.times.length } = {}) {
  const fee = cfg.feePct / 100;
  let cash = cfg.startingBalance;
  const held = {}; // symbol -> quantity
  const last = {}; // last known close, for marking a coin with a gap
  let peak = cash, maxDd = 0, trades = 0, fees = 0, investedBars = 0, rebalances = 0;
  const curve = [];
  const mark = (i, px) => Object.entries(held).reduce((a, [s, q]) => a + q * (px[s][i] ?? last[s] ?? 0), cash);
  for (let i = from; i < to; i++) {
    for (const s of Object.keys(aligned.closes)) if (aligned.closes[s][i] !== null) last[s] = aligned.closes[s][i];
    const eq = mark(i, aligned.closes);
    curve.push({ t: aligned.times[i], equity: eq });
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
    if (Object.keys(held).length) investedBars++;
    if ((i - from) % cfg.every !== 0 || i + 1 >= to) continue;
    const want = new Set(rotationPicks(aligned, i, cfg).map((p) => p.symbol));
    const open = aligned.opens;
    let changed = false;
    for (const s of Object.keys(held)) {
      if (want.has(s)) continue;
      const px = open[s][i + 1];
      if (!(px > 0)) continue; // no price to sell at: try again next time
      const value = held[s] * px;
      cash += value * (1 - fee); fees += value * fee; trades++; changed = true;
      delete held[s];
    }
    const slot = mark(i + 1, open) / cfg.top;
    for (const s of want) {
      if (held[s]) continue;
      const px = open[s][i + 1];
      if (!(px > 0)) continue;
      const spend = Math.min(slot, cash);
      if (spend < 1) continue;
      held[s] = (spend * (1 - fee)) / px; cash -= spend; fees += spend * fee; trades++; changed = true;
    }
    if (changed) rebalances++;
  }
  const end = curve.length ? curve[curve.length - 1].equity : cfg.startingBalance;
  // what it would cost to sell what is still held
  const exitFees = Object.entries(held).reduce((a, [s, q]) => a + q * (last[s] ?? 0) * fee, 0);
  const r2 = (v) => +v.toFixed(2);
  return {
    ret: r2(((end - exitFees) / cfg.startingBalance - 1) * 100),
    dd: r2(maxDd * 100),
    trades, rebalances,
    feesPct: r2((fees / cfg.startingBalance) * 100),
    investedPct: r2((investedBars / Math.max(1, to - from)) * 100),
    holding: Object.keys(held),
    curve,
  };
}

/** Equal amounts in every coin that has a price at `from`, held to `to`. */
export function buyAndHold(aligned, { from, to = aligned.times.length, symbols = null } = {}) {
  const rs = [];
  for (const [s, c] of Object.entries(aligned.closes)) {
    if (symbols && !symbols.includes(s)) continue;
    const a = aligned.opens[s][from + 1], b = [...c.slice(from, to)].reverse().find((x) => x !== null);
    if (a > 0 && b > 0) rs.push(b / a - 1);
  }
  return rs.length ? +((rs.reduce((x, y) => x + y, 0) / rs.length) * 100).toFixed(2) : null;
}
