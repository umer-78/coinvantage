// Pure geometry for the chart's drawing tools. Kept out of the canvas module so
// it can be tested without a browser — the maths is where the bugs hide.

// The retracement levels every charting package draws, so a reader coming from
// another tool sees the same numbers.
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/** Shortest distance from a point to a line segment, in pixels. */
export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** The price at each Fibonacci level between two anchor prices. */
export function fibPrices(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return FIB_LEVELS.map((r) => ({ ratio: r, price: lo + (hi - lo) * r }));
}

/**
 * Where a two-point trend line sits at a given x, extended indefinitely.
 * Vertical lines have no single y, so they report null rather than Infinity.
 */
export function trendYAt(x, x1, y1, x2, y2) {
  if (x2 === x1) return null;
  return y1 + ((y2 - y1) / (x2 - x1)) * (x - x1);
}
