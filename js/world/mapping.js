// What the 3D world shows, worked out from the market: kept apart from the
// drawing (ring.js) so it is tested under Node (tests/world.test.mjs).
// Every visible property is a reading, not decoration: how tall a monolith
// stands is its coin's market cap, the light in its seam the last 24 hours,
// and how hard the gold at the centre ripples how much the market moved.

/** Gem colours: jade for a rise, coral for a fall, gold when it barely moved. */
export const GEMS = { up: '#5fd3a5', down: '#f2877b', flat: '#d6b46c' };
/** Under this 24-hour move (in %) a coin reads as flat. */
export const FLAT_PCT = 0.25;

/** How many coins stand in the ring: fewer on a phone, where each one costs more. */
export const ringSize = (wide) => (wide ? 28 : 18);

/**
 * The coins in the ring: the largest by market cap with a price and a cap,
 * leaving out stablecoins (a dollar token's monolith would say nothing).
 */
export function ringCoins(list, { size = 28, stable = () => false } = {}) {
  return (list || [])
    .filter((c) => c && c.symbol && Number.isFinite(c.marketCap) && c.marketCap > 0 && Number.isFinite(c.price) && !stable(c.symbol))
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, size);
}

/** A monolith's height from its coin's market cap, on a log scale between the ring's smallest and largest. */
export function heightFor(cap, lo, hi, { min = 1.7, max = 4.4 } = {}) {
  if (!(cap > 0) || !(hi > 0) || !(lo > 0)) return min;
  const span = Math.log10(hi) - Math.log10(lo);
  if (!(span > 0)) return (min + max) / 2;
  const k = (Math.log10(cap) - Math.log10(lo)) / span;
  return min + Math.max(0, Math.min(1, k)) * (max - min);
}

/** The gem a 24-hour move lights, and how brightly (0.35 for no move, 1 from a 6% move either way). */
export function gemFor(changePct) {
  const c = Number.isFinite(changePct) ? changePct : 0;
  const kind = Math.abs(c) < FLAT_PCT ? 'flat' : c > 0 ? 'up' : 'down';
  return { kind, color: GEMS[kind], glow: Math.min(1, 0.35 + Math.abs(c) / 9.25) };
}

/**
 * How hard the liquid gold ripples: the ring's average absolute 24-hour move,
 * from a near-still 0.08 for a calm market to 0.24 when coins move 8% a day.
 */
export function ripple(changes) {
  const xs = (changes || []).filter(Number.isFinite).map(Math.abs);
  if (!xs.length) return 0.12;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.min(0.24, 0.08 + mean / 50);
}

/** A 24-hour move from a Binance mini-ticker (last and 24-hour open), in %. */
export function tickerChange(t) {
  const c = +t?.c, o = +t?.o;
  return c > 0 && o > 0 ? (c / o - 1) * 100 : null;
}

/** Where each page looks at the ring from: [orbit angle, distance, camera height, height looked at]. */
export const VIEWS = {
  markets: null, // the slow orbit, drawn live
  scanner: [1.1, 24, 4.6, 1.4],
  trader: [2.2, 25, 12, 0.8],
  learn: [0.5, 21, 6.5, 1.8],
  track: [3.0, 26, 6.5, 1.2],
  advice: [-0.8, 24, 7.5, 1.3],
  compare: [4.0, 25, 5.5, 1.4],
  exchanges: [5.1, 23, 3.8, 1.6],
  ai: [0.15, 22, 5.2, 2.0],
  wallet: [2.8, 23, 9.5, 1.0],
  alerts: [3.6, 24, 11, 1.0],
  futures: [4.6, 22, 3.2, 1.8],
  news: [5.6, 27, 8.5, 1.2],
};

/** A page's view; a page without its own gets a fixed one picked from its name. */
export function viewOf(page) {
  if (VIEWS[page] !== undefined) return VIEWS[page];
  let h = 0;
  for (const ch of String(page || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [(h % 628) / 100, 23 + (h % 4), 5 + (h % 4), 1.3];
}
