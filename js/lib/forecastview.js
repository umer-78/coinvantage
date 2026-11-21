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

/**
 * How much wider the centred range is drawn on each chart (log distance from
 * today's price × the factor). A factor is fitted on the older half of each
 * series and kept only where it helps the newer half (tools/evaluate-bands.mjs).
 * On 106 coins (2026-11-20, Evaluate run 44798322187) only 10s passed: its 80%
 * range held 74.0% of the newer half as drawn and 76.5% drawn 5% wider. Every
 * other chart was already as close to 80% as the fitted factor got it.
 */
export const RANGE_WIDEN = { '10s': 1.05 };

/** The forecast with its lean taken out: centred on today's price, same spread (× `widen`). */
export function withoutLean(f, widen = 1) {
  if (!f?.ok || !Array.isArray(f.path) || !f.path.length || !(f.lastPrice > 0)) return f;
  const price = f.lastPrice;
  const keys = ['p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];
  const path = f.path.map((p) => {
    const k = p.p50 > 0 ? price / p.p50 : 1;
    const q = { ...p };
    for (const key of keys) if (Number.isFinite(p[key])) q[key] = widen === 1 ? p[key] * k : price * ((p[key] * k) / price) ** widen;
    return q;
  });
  const end = path[path.length - 1];
  return {
    ...f, path,
    range: Object.fromEntries(keys.filter((key) => Number.isFinite(end[key])).map((key) => [key, end[key]])),
    targetPrice: price, expectedReturnPct: 0,
    leanRemoved: true, rawExpectedReturnPct: f.expectedReturnPct, rawTargetPrice: f.targetPrice,
    ...(widen !== 1 ? { rangeWiden: widen } : {}),
  };
}

/** The forecast as it should be shown on this chart, given the trust in its direction. */
export function forecastForDisplay(f, interval, trust) {
  return directionReliable(interval, trust) ? f : withoutLean(f, RANGE_WIDEN[interval] || 1);
}

/**
 * Measured 2026-10-12 (tools/evaluate-engine.mjs + tools/report-engine.mjs,
 * Evaluate job "engine"): 1,440 forecasts on fresh candles, 12 coins, 240 per
 * chart, each made only from candles before it.
 *
 * `centred`: share of outcomes inside the 50%, 80% and 90% ranges centred on
 * today's price (the lean taken out), measured at scale (see below): within
 * 1.3 points of the target on every chart.
 *
 * `move`: "a bigger (or smaller) move than usual" — volatility now against the
 * coin's own normal, judged on whether the move that followed was bigger than
 * the coin's usual move. `big`/`small` are the average size of the move that
 * followed each call, in units of the usual move; `rho` the rank correlation.
 * The call is shown only where it separated the two clearly (sizes at least
 * 1.3× apart and rho ≥ 0.15) in two runs in a row: 5m, 15m and 1h. Hit rates sit near the hindsight
 * baseline (always naming whichever outcome was commoner in the window), so
 * the size of the move, not the hit rate, is what it tells.
 *
 * `perCoinCheck`: the coin page used to show each forecast's own recent check
 * as "tested accuracy". When that read 60% or more the forecast was right
 * 52.1% of the time (881 cases, 2026-10-15); otherwise 49.1% (4,829). It says nothing, so
 * it is no longer shown as accuracy.
 */
export const FORECAST_TESTED = {
  measuredOn: '2026-10-12', tests: 1440, coins: 12, perChart: 240,
  // Centred ranges, re-measured 2026-11-20 by tools/evaluate-bands.mjs on every
  // coin the app can trade (Evaluate job "bands", run 44798322187), all ten
  // charts: every non-overlapping horizon, the engine's own range functions.
  // Second charts use the 78 coins Binance lists. 10s is drawn 5% wider
  // (RANGE_WIDEN) and its figures are the newer half, which the width was not
  // fitted on. A forecast re-check of ten forecasts a coin and chart is far
  // too few to judge a range by: these are up to 200,000 ranges a chart.
  centred: {
    '1s': { band50: 51.3, band80: 77.5, band90: 87.4, tests: 7800, coins: 78 },
    '5s': { band50: 48.8, band80: 78, band90: 88.4, tests: 9750, coins: 78 },
    '10s': { band50: 46.8, band80: 76.5, band90: 87.4, tests: 3838, coins: 78, widen: 1.05, asDrawnBefore: { band50: 44.8, band80: 74, band90: 85.9 } },
    '1m': { band50: 49.9, band80: 79.5, band90: 89.4, tests: 161733, coins: 106 },
    '5m': { band50: 49.9, band80: 79.8, band90: 89.7, tests: 201042, coins: 106 },
    '15m': { band50: 49.6, band80: 79.4, band90: 89.4, tests: 126324, coins: 106 },
    '1h': { band50: 47.3, band80: 77.8, band90: 88.4, tests: 21143, coins: 104 },
    '4h': { band50: 48.1, band80: 78.9, band90: 89.3, tests: 29765, coins: 99 },
    '1d': { band50: 50.6, band80: 81.3, band90: 91, tests: 4428, coins: 47 },
    '1w': { band50: 46, band80: 75.5, band90: 84.1, tests: 1932, coins: 47 },
  },
  centredMeasuredOn: '2026-11-20',
  // Re-measured twice on 2026-10-15 on every coin the app can trade (106; 5,710
  // forecasts each, ten per coin and chart, the runs 90 minutes apart). The
  // call is shown only on charts where it separated big moves from small ones
  // in both: 5m, 15m and 1h. 4h failed both (the move after a "bigger" call
  // was 1.2× the one after a "smaller" call, rho 0.05 and 0.10), as did 1d
  // (1.04×). 1m: the sizes could not be measured. Figures are the later run;
  // `movePassedBefore` is what passed in the run before it.
  move: {
    '1m': { hit: 60.1, baseline: 51.4, rho: 0.309, big: null, small: null },
    '5m': { hit: 63.6, baseline: 51.3, rho: 0.325, big: 1.95, small: 1.01 },
    '15m': { hit: 62.5, baseline: 55.7, rho: 0.273, big: 1.6, small: 1.02 },
    '1h': { hit: 58.3, baseline: 54.3, rho: 0.252, big: 2.04, small: 1.14 },
    '4h': { hit: 54.6, baseline: 56.3, rho: 0.098, big: 1.61, small: 1.31 },
    '1d': { hit: 50.0, baseline: 54.5, rho: 0.098, big: 1.39, small: 1.34 },
  },
  movePassedBefore: ['5m', '15m', '1h'],
  moveMeasuredOn: '2026-10-15',
  // all six charts together, the later 2026-10-15 run
  perCoinCheck: { highN: 881, highHit: 52.1, lowN: 4829, lowHit: 49.1 },
};

/** Whether the move-size call separated big moves from small ones on this chart. */
export const moveCallUseful = (interval) => {
  const m = FORECAST_TESTED.move[interval];
  return !!m && m.big > 0 && m.small > 0 && m.big / m.small >= 1.3 && m.rho >= 0.15 && FORECAST_TESTED.movePassedBefore.includes(interval);
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
