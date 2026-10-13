// What the coin page, the scanner and the assistant show of a forecast.
//
// The engine's ranges and path are centred on its lean (its expected move),
// and on every chart where that lean did not hold up in testing the page also
// says "no reliable direction". Both at once was a contradiction: a range
// sitting mostly above today's price, a "target" 1.3% higher, a timing line
// "topping near" a higher price — each a direction call the test says nothing
// for. Where the direction is not reliable the forecast is shown without the
// lean: the same widths, centred on today's price, no target. The raw
// forecast still goes to the ledgers that grade the model.
import { directionReliable, summarizeForecast, TESTED_ACCURACY } from './predict.js';

/** The forecast with its lean taken out: same spread, centred on today's price. */
export function withoutLean(f) {
  if (!f?.ok || !Array.isArray(f.path) || !f.path.length || !(f.lastPrice > 0)) return f;
  const price = f.lastPrice;
  const keys = ['p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];
  const path = f.path.map((p) => {
    const k = p.p50 > 0 ? price / p.p50 : 1;
    const q = { ...p };
    for (const key of keys) if (Number.isFinite(p[key])) q[key] = p[key] * k;
    return q;
  });
  const end = path[path.length - 1];
  return {
    ...f, path,
    range: Object.fromEntries(keys.filter((key) => Number.isFinite(end[key])).map((key) => [key, end[key]])),
    targetPrice: price, expectedReturnPct: 0,
    leanRemoved: true, rawExpectedReturnPct: f.expectedReturnPct, rawTargetPrice: f.targetPrice,
  };
}

/** The forecast as it should be shown on this chart, given the trust in its direction. */
export function forecastForDisplay(f, interval, trust) {
  return directionReliable(interval, trust) ? f : withoutLean(f);
}

/**
 * Measured 2026-10-12 (tools/evaluate-engine.mjs + tools/report-engine.mjs,
 * Evaluate job "engine"): 1,440 forecasts on fresh candles, 12 coins, 240 per
 * chart, each made only from candles before it.
 *
 * `centred`: share of outcomes inside the 50% and 80% ranges centred on
 * today's price (the lean taken out). They held as well as the leaned ones or
 * better on every chart (1h 81.7% against 82.5%; 5m 83.3% against 78.8%) —
 * except that the daily 80% range is too narrow either way (72.5%).
 *
 * `move`: "a bigger (or smaller) move than usual" — volatility now against the
 * coin's own normal, judged on whether the move that followed was bigger than
 * the coin's usual move. `big`/`small` are the average size of the move that
 * followed each call, in units of the usual move; `rho` the rank correlation.
 * The call is shown only where it separated the two clearly (sizes at least
 * 1.3× apart and rho ≥ 0.15): 5m, 1h and 4h. Hit rates sit near the hindsight
 * baseline (always naming whichever outcome was commoner in the window), so
 * the size of the move, not the hit rate, is what it tells.
 *
 * `perCoinCheck`: the coin page used to show each forecast's own recent check
 * as "tested accuracy". When that read 60% or more the forecast was right
 * 49.5% of the time (196 cases); otherwise 49.7% (1,244). It says nothing, so
 * it is no longer shown as accuracy.
 */
export const FORECAST_TESTED = {
  measuredOn: '2026-10-12', tests: 1440, coins: 12, perChart: 240,
  // Centred ranges, re-measured 2026-10-13 at scale by tools/evaluate-bands.mjs
  // (Evaluate job "bands"): 24 coins, every non-overlapping horizon, the
  // engine's own range functions. A width factor fitted on the older half of
  // each series did not improve the newer half on any chart, so none is used.
  // 1m is from the 240-forecast test above (its direction keeps the lean).
  centred: {
    '1m': { band50: 50.8, band80: 78.8, tests: 240, coins: 12 },
    '5m': { band50: 46.3, band80: 76.5, band90: 87.4, tests: 4992, coins: 24 },
    '15m': { band50: 49.1, band80: 80.0, band90: 89.7, tests: 7488, coins: 24 },
    '1h': { band50: 49.8, band80: 79.0, band90: 89.1, tests: 4992, coins: 24 },
    '4h': { band50: 49.5, band80: 78.9, band90: 89.4, tests: 7992, coins: 24 },
    '1d': { band50: 46.5, band80: 77.2, band90: 88.9, tests: 2391, coins: 24 },
  },
  centredMeasuredOn: '2026-10-13',
  move: {
    '1m': { hit: 50.8, baseline: 58.3, rho: 0.079, big: 1.83, small: 1.91 },
    '5m': { hit: 59.2, baseline: 55.8, rho: 0.304, big: 1.42, small: 0.99 },
    '15m': { hit: 58.3, baseline: 60.0, rho: 0.146, big: 1.22, small: 1.06 },
    '1h': { hit: 57.9, baseline: 51.7, rho: 0.197, big: 1.64, small: 0.94 },
    '4h': { hit: 62.1, baseline: 64.6, rho: 0.292, big: 1.39, small: 0.84 },
    '1d': { hit: 49.2, baseline: 52.9, rho: 0.134, big: 1.32, small: 1.21 },
  },
  perCoinCheck: { highN: 196, highHit: 49.5, lowN: 1244, lowHit: 49.7 },
};

/** Whether the move-size call separated big moves from small ones on this chart. */
export const moveCallUseful = (interval) => {
  const m = FORECAST_TESTED.move[interval];
  return !!m && m.big / m.small >= 1.3 && m.rho >= 0.15;
};

/**
 * Is a bigger or smaller move than usual coming over the next H candles?
 * Volatility now (100 candles, the one the ranges are built on) against the
 * coin's own normal, the way FORECAST_TESTED.move was measured. `usualPct` is
 * the coin's median H-candle move, either way. Null with too little history.
 */
export function moveSizeCall(candles, H, interval) {
  const c = (candles || []).map((k) => k.c);
  const n = c.length, o = n - 1;
  if (n < 400 || !(H > 0)) return null;
  const S1 = [0], S2 = [0];
  for (let i = 0; i < n; i++) { const r = i ? Math.log(c[i] / c[i - 1]) : 0; S1.push(S1[i] + r); S2.push(S2[i] + r * r); }
  const sigAt = (i) => { const a = Math.max(1, i - 99), m = i - a + 1, mu = (S1[i + 1] - S1[a]) / m; return Math.sqrt(Math.max((S2[i + 1] - S2[a]) / m - mu * mu, 1e-12)); };
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const js = [];
  for (let j = Math.max(101, o - 1499 + 101); j <= o - H; j++) js.push(j);
  if (js.length < 200) return null;
  const usual = median(js.map((j) => Math.abs(Math.log(c[j + H] / c[j]))));
  const ratio = sigAt(o) / median(js.map((j) => sigAt(j)));
  return { bigger: ratio > 1, ratio: +ratio.toFixed(2), usualPct: +((Math.exp(usual) - 1) * 100).toFixed(2), useful: moveCallUseful(interval), tested: FORECAST_TESTED.move[interval] || null };
}

/**
 * The forecast's facts for the plain-words summary and the assistant: the
 * shown forecast (no lean where the direction is not reliable, so no expected
 * move or target there), and the chart's measured direction record in place
 * of the forecast's own per-coin check, which testing showed says nothing.
 */
export function forecastFacts(f, interval, trust) {
  const s = summarizeForecast(forecastForDisplay(f, interval, trust), interval, trust);
  if (!s) return s;
  const r = TESTED_ACCURACY.recheck?.[interval];
  return {
    ...s,
    validatedAccuracyPct: null, baselineAccuracyPct: null, accuracyWhenConfidentPct: null,
    testedDirectionPct: r ? r.hit : typeof TESTED_ACCURACY[interval] === 'number' ? TESTED_ACCURACY[interval] : null,
    testedBaselinePct: r ? r.baseline : TESTED_ACCURACY.baseline?.[interval] ?? null,
    ...(s.directionReliable === false ? { expectedMovePct: null, targetPrice: null } : {}),
    // the per-coin check's own claims ("right 67% on 173 recent unseen cases,
    // above the 53% it had to beat") are the same uninformative figure
    notes: (s.notes || []).filter((n) => !/recent unseen cases/.test(n)),
  };
}
