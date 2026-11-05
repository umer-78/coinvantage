// What the 3D world shows, worked out from the market: kept apart from the
// drawing (market.js) so it is tested under Node (tests/world.test.mjs).
// Every visible property is a reading, not decoration: the candles are a
// coin's real hourly candles, a token's size is its coin's market cap, the
// light on its rim the last 24 hours, and how fast the data drifts up how much
// the market moved.

/** Gem colours: jade for a rise, coral for a fall, gold when it barely moved. */
export const GEMS = { up: '#5fd3a5', down: '#f2877b', flat: '#d6b46c' };
/** Under this 24-hour move (in %) a coin reads as flat. */
export const FLAT_PCT = 0.25;

/** How many coins stand in the ring: fewer on a phone, where each one costs more. */
export const ringSize = (wide) => (wide ? 28 : 18);

/**
 * The coins in the ring: the largest by market cap with a price and a cap,
 * leaving out stablecoins (a dollar token would say nothing).
 */
export function ringCoins(list, { size = 28, stable = () => false } = {}) {
  return (list || [])
    .filter((c) => c && c.symbol && Number.isFinite(c.marketCap) && c.marketCap > 0 && Number.isFinite(c.price) && !stable(c.symbol))
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, size);
}

/** A token's radius from its coin's market cap, on a log scale between the ring's smallest and largest. */
export function tokenSize(cap, lo, hi, { min = 0.36, max = 0.86 } = {}) {
  if (!(cap > 0) || !(hi > 0) || !(lo > 0)) return min;
  const span = Math.log10(hi) - Math.log10(lo);
  if (!(span > 0)) return (min + max) / 2;
  const k = (Math.log10(cap) - Math.log10(lo)) / span;
  return min + Math.max(0, Math.min(1, k)) * (max - min);
}

/** The light a 24-hour move gives a token's rim, and how brightly (0.35 for no move, 1 from a 6% move either way). */
export function gemFor(changePct) {
  const c = Number.isFinite(changePct) ? changePct : 0;
  const kind = Math.abs(c) < FLAT_PCT ? 'flat' : c > 0 ? 'up' : 'down';
  return { kind, color: GEMS[kind], glow: Math.min(1, 0.35 + Math.abs(c) / 9.25) };
}

/**
 * How lively the world is: the ring's average absolute 24-hour move, from a
 * near-still 0.08 for a calm market to 0.24 when coins move 8% a day.
 */
export function ripple(changes) {
  const xs = (changes || []).filter(Number.isFinite).map(Math.abs);
  if (!xs.length) return 0.12;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.min(0.24, 0.08 + mean / 50);
}

/** The share of the ring that rose in the last 24 hours (0.5 with nothing to read). */
export function breadth(changes) {
  const xs = (changes || []).filter(Number.isFinite);
  return xs.length ? xs.filter((x) => x > 0).length / xs.length : 0.5;
}

/** A 24-hour move from a Binance mini-ticker (last and 24-hour open), in %. */
export function tickerChange(t) {
  const c = +t?.c, o = +t?.o;
  return c > 0 && o > 0 ? (c / o - 1) * 100 : null;
}

/**
 * Candles as a 3D chart: each one's body and wick in world heights between
 * `floor` and `top`, the lowest low at the floor and the highest high at the
 * top, as a chart scales its price axis. A body never vanishes (a doji keeps
 * a sliver), and candles with a missing price are left out.
 */
export function candleBars(candles, { floor = 0.9, top = 7.2, minBody = 0.03 } = {}) {
  const xs = (candles || []).filter((c) => c && [c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v) && v > 0));
  if (!xs.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const c of xs) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const span = hi - lo || hi * 0.01;
  const y = (v) => floor + ((v - lo) / span) * (top - floor);
  return xs.map((c) => {
    const b0 = y(Math.min(c.o, c.c)), b1 = y(Math.max(c.o, c.c));
    return { t: c.t, up: c.c >= c.o, bodyLo: b0, bodyHi: Math.max(b1, b0 + minBody), wickLo: y(c.l), wickHi: y(c.h), close: y(c.c) };
  });
}

/** The exponential moving average of a series (the average line drawn through the 3D chart). */
export function ema(values, n = 20) {
  const k = 2 / (n + 1);
  const out = [];
  let e = null;
  for (const v of values || []) {
    if (!Number.isFinite(v)) { out.push(e); continue; }
    e = e === null ? v : v * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Where candle `i` of `n` stands on the chart's arc, in radians: the oldest on the left, the newest on the right. */
export function arcAngle(i, n, span = 2.2) {
  return n <= 1 ? 0 : -span / 2 + (i / (n - 1)) * span;
}

/** Where each page looks at the world from: [orbit angle, distance, camera height, height looked at]. */
export const VIEWS = {
  markets: null, // the slow orbit, drawn live
  scanner: [1.1, 24, 5.2, 2.2],
  trader: [2.2, 25, 10.5, 1.6],
  learn: [0.5, 22, 6.5, 2.4],
  track: [3.0, 26, 6.5, 2.0],
  advice: [-0.8, 24, 7.5, 2.0],
  compare: [4.0, 25, 5.5, 2.2],
  exchanges: [5.1, 23, 4.2, 2.4],
  ai: [0.15, 22, 5.2, 2.8],
  wallet: [2.8, 23, 9.5, 1.8],
  alerts: [3.6, 24, 10, 1.8],
  futures: [4.6, 22, 3.6, 2.6],
  news: [5.6, 27, 8.5, 2.0],
  coin: [0.35, 23, 6.2, 3.2], // a coin's page: its own candles fill the chart
};

/** A page's view; a page without its own gets a fixed one picked from its name. */
export function viewOf(page) {
  if (VIEWS[page] !== undefined) return VIEWS[page];
  let h = 0;
  for (const ch of String(page || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [(h % 628) / 100, 23 + (h % 4), 5 + (h % 4), 2.0];
}
