// Scoring a published trade plan against what the price did next.
//
// A plan is scored the way the plan itself says to manage it: "take partial
// profit at TP1 and move the stop to entry". Half the position closes at
// target 1, the stop on the rest moves to the entry price, and the rest closes
// at target 2, back at the entry, or at the horizon's close.
//
// The track record used to score plans by a rule of its own: target 1 counted
// as the exit only if nothing happened afterwards, while a later stop turned
// the same plan into a full loss, so "reached a target" undercounted the plans
// that did.
//
// When one candle touches both the stop and target 1, the stop is assumed to
// have come first, so a result is never flattered. After target 1 the move of
// the stop to entry starts with the next candle.

/**
 * @param plan    { side: 'long'|'short', entry, stop, tp1, tp2? }
 * @param candles candles after the plan's candle closed, oldest first
 * @param outcome the close at the horizon
 * @returns {{ result: 'stop'|'tp1'|'tp2'|'expired'|'none', returnPct: number|null }}
 */
export function scorePlan(plan, candles, outcome) {
  const { side, entry, stop, tp1, tp2 } = plan || {};
  if (![entry, stop, tp1].every(Number.isFinite) || entry <= 0) return { result: 'none', returnPct: null };
  const long = side !== 'short';
  const ret = (p) => (long ? p / entry - 1 : 1 - p / entry) * 100;
  const reached = (c, p) => (long ? c.h >= p : c.l <= p);
  const fell = (c, p) => (long ? c.l <= p : c.h >= p);
  const hasTp2 = Number.isFinite(tp2);
  let half = null; // the return locked in on the half closed at target 1
  for (const c of candles || []) {
    if (half === null) {
      if (fell(c, stop)) return { result: 'stop', returnPct: ret(stop) };
      if (!reached(c, tp1)) continue;
      half = ret(tp1);
      if (hasTp2 && reached(c, tp2)) return { result: 'tp2', returnPct: (half + ret(tp2)) / 2 };
      continue;
    }
    if (fell(c, entry)) return { result: 'tp1', returnPct: half / 2 };
    if (hasTp2 && reached(c, tp2)) return { result: 'tp2', returnPct: (half + ret(tp2)) / 2 };
  }
  if (half !== null) return { result: 'tp1', returnPct: (half + (Number.isFinite(outcome) ? ret(outcome) : 0)) / 2 };
  return { result: 'expired', returnPct: Number.isFinite(outcome) ? ret(outcome) : null };
}
