// "Has this chart happened before, and what came next?"
//
// The compare page puts two coins side by side. This module does the other
// comparison a reader actually wants: the coin against its own past. It takes
// the shape of the most recent candles, finds the past stretches that traced the
// same shape, and lays out what price did in the bars that followed each one.
//
// The matching itself is findPatterns() from the forecast engine, which is
// already written to look only at data available at the point it is asked about
// — so the same function can be run at a past bar and scored against what really
// happened. That is what backtestAnalog() does, and it is the reason this page
// can put a measured hit-rate next to the picture instead of a promise.
//
// Two honesty rules are baked in here:
//   * the answer is compared against the majority-class baseline, because a coin
//     that rose 60% of the time makes "up" look clever for free;
//   * evaluation points are spaced at least one horizon apart, so overlapping
//     futures cannot inflate the sample.

import { findPatterns } from './predict.js';

/**
 * What the method scored when it was run across 12 coins on real Binance
 * candles (4,000 per pair), each coin judged against its own majority-class
 * baseline. Measured with tools/evaluate-analog.mjs.
 *
 * The result is negative and it is published here rather than buried: shape
 * matching draws a genuinely useful picture of what followed similar stretches,
 * but as a direction call it did not beat simply always naming the more common
 * outcome. Six of thirty-six coin/timeframe pairs beat their baseline, which is
 * about what chance would give. The page still runs the test live per coin, so
 * a coin that does beat its own baseline is reported as beating it — but the
 * default framing is description, not prediction.
 */
export const ANALOG_TESTED = {
  '1h': { meanAccuracy: 49.2, meanBaseline: 53.2, coinsBeatingBaseline: 2, coins: 12, tests: 1651 },
  '4h': { meanAccuracy: 46.8, meanBaseline: 54.0, coinsBeatingBaseline: 1, coins: 12, tests: 1666 },
  '1d': { meanAccuracy: 50.7, meanBaseline: 54.4, coinsBeatingBaseline: 3, coins: 12, tests: 1564 },
  beatsBaselineOverall: false,
};

/** Window / horizon defaults per timeframe, in candles. */
export const ANALOG_SHAPE = {
  '1h': { window: 48, horizon: 24 },
  '4h': { window: 36, horizon: 18 },
  '1d': { window: 30, horizon: 14 },
};

export function shapeFor(interval) {
  return ANALOG_SHAPE[interval] || { window: 32, horizon: 12 };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
};

/**
 * Match the latest window against the coin's own history.
 *
 * @returns {{ok: false, reason: string} | {
 *   ok: true, window: number, horizon: number,
 *   matches: object[], currentSeries: number[],
 *   upCount: number, downCount: number, upRatePct: number,
 *   medianPct: number, bestPct: number, worstPct: number,
 *   p25Pct: number, p75Pct: number,
 *   avgSimilarityPct: number, typicalDrawdownPct: number, typicalRallyPct: number,
 *   direction: 'up'|'down'|'mixed'
 * }}
 */
export function historyMatch(candles, { interval = '1d', topK = 8, minCorr = 0.62 } = {}) {
  if (!Array.isArray(candles) || candles.length < 120) {
    return { ok: false, reason: 'Not enough history on this timeframe to look for repeats yet.' };
  }
  const { window, horizon } = shapeFor(interval);
  const r = findPatterns(candles, candles.length - 1, { window, horizon, topK, minCorr });
  if (!r.matches || r.matches.length < 3) {
    return { ok: false, reason: `This stretch does not look like anything in the coin's own history (fewer than 3 windows past ${Math.round(minCorr * 100)}% similarity). That is a real answer: no repeat means no read.` };
  }

  const finals = r.matches.map((m) => m.futureReturnPct);
  const upCount = finals.filter((v) => v > 0).length;
  const downCount = finals.length - upCount;
  const upRatePct = (upCount / finals.length) * 100;

  return {
    ok: true,
    window, horizon,
    matches: r.matches,
    currentSeries: r.currentSeries,
    upCount, downCount,
    upRatePct: +upRatePct.toFixed(1),
    medianPct: +median(finals).toFixed(2),
    bestPct: +Math.max(...finals).toFixed(2),
    worstPct: +Math.min(...finals).toFixed(2),
    p25Pct: +quantile(finals, 0.25).toFixed(2),
    p75Pct: +quantile(finals, 0.75).toFixed(2),
    avgSimilarityPct: +(r.avgSimilarity * 100).toFixed(1),
    typicalRallyPct: +median(r.matches.map((m) => m.maxUpPct)).toFixed(2),
    typicalDrawdownPct: +median(r.matches.map((m) => m.maxDownPct)).toFixed(2),
    direction: upRatePct >= 62.5 ? 'up' : upRatePct <= 37.5 ? 'down' : 'mixed',
  };
}

/**
 * Score the method on this coin's own history, walking forward.
 *
 * At each evaluation bar the matcher sees only the bars before it, votes up or
 * down, and is marked against what price actually did over the next `horizon`
 * candles. The majority-class baseline is reported next to it, because beating
 * a coin's own drift is the only result that means anything.
 */
export function backtestAnalog(candles, { interval = '1d', topK = 8, minCorr = 0.62, maxPoints = 160 } = {}) {
  const { window, horizon } = shapeFor(interval);
  const need = window * 2 + horizon + 12;
  if (!Array.isArray(candles) || candles.length < need + horizon + 20) {
    return { ok: false, reason: 'Not enough history to score the method honestly on this timeframe.' };
  }
  const first = need;
  const last = candles.length - 1 - horizon;
  const span = last - first;
  if (span < horizon * 3) return { ok: false, reason: 'Not enough history to score the method honestly on this timeframe.' };

  // never closer together than one horizon: overlapping futures are not
  // independent samples and would make a small edge look bigger than it is
  const step = Math.max(horizon, Math.ceil(span / maxPoints));

  let n = 0, hits = 0, ups = 0, confident = 0, confidentHits = 0, noRead = 0;
  let sumBrier = 0;
  for (let i = first; i <= last; i += step) {
    const r = findPatterns(candles, i, { window, horizon, topK, minCorr });
    if (!r.matches || r.matches.length < 3) { noRead++; continue; }
    const actualUp = candles[i + horizon].c > candles[i].c;
    const p = r.probUp;
    n++;
    if (actualUp) ups++;
    if ((p > 0.5) === actualUp) hits++;
    sumBrier += ((actualUp ? 1 : 0) - p) ** 2;
    if (Math.abs(p - 0.5) >= 0.1) { confident++; if ((p > 0.5) === actualUp) confidentHits++; }
  }
  if (n < 20) return { ok: false, reason: 'Too few independent test points on this timeframe for the number to mean anything.' };

  const upRate = ups / n;
  const baseline = Math.max(upRate, 1 - upRate) * 100; // always call the majority
  const accuracy = (hits / n) * 100;

  return {
    ok: true,
    window, horizon, step,
    tests: n,
    skipped: noRead,
    accuracyPct: +accuracy.toFixed(1),
    baselinePct: +baseline.toFixed(1),
    edgePts: +(accuracy - baseline).toFixed(1),
    beatsBaseline: accuracy > baseline,
    upRatePct: +(upRate * 100).toFixed(1),
    brier: +(sumBrier / n).toFixed(3),
    confidentTests: confident,
    confidentAccuracyPct: confident >= 10 ? +((confidentHits / confident) * 100).toFixed(1) : null,
  };
}

/**
 * One paragraph that states what the match found and what the score is worth.
 * Written here rather than in the view so the page, the assistant and any export
 * cannot drift into describing the same numbers differently.
 */
export function analogVerdict(match, score, { symbol = 'this coin', interval = '1d', horizonText = null } = {}) {
  if (!match?.ok) return { headline: match?.reason || 'No reading.', tone: 'flat', lines: [] };
  const span = horizonText || `${match.horizon} candles`;
  const lines = [];

  const dirWord = match.direction === 'up' ? 'higher' : match.direction === 'down' ? 'lower' : 'in no consistent direction';
  const failed = score && score.ok && !score.beatsBaseline;
  let headline;
  if (match.direction === 'mixed') {
    headline = `${symbol} has traced this shape ${match.matches.length} times before on the ${interval} chart, and what followed was split — ${match.upCount} up, ${match.downCount} down. History is not taking a side here.`;
  } else if (failed) {
    // The count is still worth seeing; presenting it as a lean would be the
    // claim the backtest below just refused.
    headline = `${symbol} has traced this shape ${match.matches.length} times before on the ${interval} chart — ${match.upCount} of them went ${dirWord} next. On this coin that count has not predicted the following move any better than chance, so read the picture below as history rather than as a lean.`;
  } else {
    headline = `${symbol} has traced this shape ${match.matches.length} times before on the ${interval} chart, and ${match.upCount} of those ${match.matches.length} went ${dirWord} over the next ${span}.`;
  }

  lines.push(`Typical outcome: ${match.medianPct >= 0 ? '+' : ''}${match.medianPct}% after ${span}, with the middle half of past cases landing between ${match.p25Pct >= 0 ? '+' : ''}${match.p25Pct}% and ${match.p75Pct >= 0 ? '+' : ''}${match.p75Pct}%. Best case was ${match.bestPct >= 0 ? '+' : ''}${match.bestPct}%, worst was ${match.worstPct}%.`);
  lines.push(`Along the way those past cases typically rallied ${match.typicalRallyPct >= 0 ? '+' : ''}${match.typicalRallyPct}% at best and fell ${match.typicalDrawdownPct}% at worst before the horizon was up — the path matters as much as the endpoint if you are using a stop.`);
  lines.push(`Average shape similarity of the matches: ${match.avgSimilarityPct}%. A lower number means the "repeat" is looser than it looks on the chart.`);

  let tone = match.direction === 'up' ? 'up' : match.direction === 'down' ? 'down' : 'flat';

  if (score?.ok) {
    if (score.beatsBaseline) {
      lines.push(`Scored on this coin's own history, this method called direction right ${score.accuracyPct}% of the time over ${score.tests} independent tests, against ${score.baselinePct}% for simply always calling the more common outcome — an edge of ${score.edgePts} points. Small, and measured on one coin, so treat it as weak evidence rather than a forecast.`);
    } else {
      tone = 'warn';
      lines.push(`Scored on this coin's own history the method did not earn its keep: ${score.accuracyPct}% correct over ${score.tests} independent tests, against ${score.baselinePct}% for simply always calling the more common outcome. On this coin and timeframe the shape match is a description of the past, not a usable prediction — read the picture, do not trade the percentage.`);
    }
    if (score.confidentAccuracyPct !== null) {
      lines.push(`When the match leaned clearly one way (${score.confidentTests} of ${score.tests} cases) it was right ${score.confidentAccuracyPct}% of the time.`);
    }
    const overall = ANALOG_TESTED[interval];
    if (overall) {
      lines.push(`For context, run across ${overall.coins} coins on the ${interval} chart this method averaged ${overall.meanAccuracy}% against a ${overall.meanBaseline}% baseline, and beat its baseline on ${overall.coinsBeatingBaseline} of ${overall.coins} coins — roughly what chance would produce. Shape matching earns its place on this page as a picture of what followed similar stretches, not as a forecast.`);
    }
  } else if (score?.reason) {
    tone = 'warn';
    lines.push(`${score.reason} Until it can be scored, the matches below are history, not evidence.`);
  }

  return { headline, tone, lines };
}
