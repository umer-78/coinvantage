// "How long does the move last, and when does it turn?"
//
// The plain forecast answers one question — where will price be at the horizon.
// That is a straight line, so it can never say "up for two days, then back down".
//
// This module builds a *shaped* path instead: it takes the past charts that
// matched today's (already found by the pattern matcher) and averages what price
// actually did at every step afterwards, not just at the end. Those real paths
// rise, peak and roll over, so the composite does too.
//
// The shape comes from history; the destination comes from the model ensemble.
// We tilt the historical shape so its endpoint matches the ensemble's expected
// move, which keeps the humps and dips while staying consistent with the
// direction probability shown everywhere else.

import { directionReliable } from './predict.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function weightedQuantile(pairs, q) {
  // pairs: [value, weight], returns the weighted quantile
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, p) => s + p[1], 0);
  if (!total) return 0;
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total * q) return v;
  }
  return sorted[sorted.length - 1][0];
}

/**
 * @param {object} fc  the object returned by forecast()
 * @param {object} opts { intervalMs, minMatches, interval }
 */
export function timingOutlook(fc, { intervalMs = null, minMatches = 4, interval = null } = {}) {
  if (!fc?.ok) return { ok: false, reason: 'No forecast to time.' };
  const matches = fc.patterns?.matches || [];
  const H = fc.horizon;
  if (matches.length < minMatches) {
    return { ok: false, reason: `Only ${matches.length} similar past charts were found — not enough to time the move. Direction only.` };
  }

  const step = intervalMs || (fc.path.length > 1 ? fc.path[1].t - fc.path[0].t : 36e5);
  const weights = matches.map((m) => m.similarity ** 4);

  // Median path across the matched futures, step by step.
  const med = [0], shareUp = [null], band = [[0, 0]];
  for (let h = 1; h <= H; h++) {
    const pairs = matches
      .map((m, i) => [m.futureReturns[h - 1], weights[i]])
      .filter(([v]) => Number.isFinite(v));
    if (!pairs.length) { med.push(med[h - 1]); shareUp.push(shareUp[h - 1]); band.push(band[h - 1]); continue; }
    const wsum = pairs.reduce((s, p) => s + p[1], 0);
    med.push(weightedQuantile(pairs, 0.5));
    shareUp.push(pairs.reduce((s, [v, w]) => s + (v > 0 ? w : 0), 0) / wsum);
    band.push([weightedQuantile(pairs, 0.25), weightedQuantile(pairs, 0.75)]);
  }

  // Tilt the historical shape so it lands on the ensemble's expected move.
  // A straight-line correction keeps every hump and dip intact.
  const targetEnd = fc.expectedReturnPct / 100;
  const drift = targetEnd - med[H];
  const adj = med.map((v, h) => v + (drift * h) / H);

  // Peak and trough of the adjusted path (h = 0 is now).
  let peakBar = 0, troughBar = 0;
  for (let h = 1; h <= H; h++) {
    if (adj[h] > adj[peakBar]) peakBar = h;
    if (adj[h] < adj[troughBar]) troughBar = h;
  }
  // Which extreme is the real story? A +0.05% bump next to a -1.7% dip is a dip,
  // not a rally, so the larger move wins and tiny wiggles count as no shape at all.
  const MIN_MOVE = 0.003; // 0.3% — below this there is nothing worth timing
  const peakVal = adj[peakBar], troughVal = adj[troughBar];
  const rising = peakBar > 0 && peakVal > MIN_MOVE && peakVal >= Math.abs(troughVal);
  const falling = troughBar > 0 && troughVal < -MIN_MOVE && Math.abs(troughVal) > peakVal;

  // Where does it turn? First bar after the peak that gives back a third of the gain.
  let turnBar = null;
  if (rising) {
    const giveBack = adj[peakBar] * 0.67;
    for (let h = peakBar + 1; h <= H; h++) {
      if (adj[h] <= giveBack) { turnBar = h; break; }
    }
  }
  // The mirror case: a dip that recovers.
  let recoverBar = null;
  if (falling) {
    const back = adj[troughBar] * 0.67;
    for (let h = troughBar + 1; h <= H; h++) {
      if (adj[h] >= back) { recoverBar = h; break; }
    }
  }

  // The window worth holding: while the path stays within 80% of its best level.
  let holdFrom = null, holdTo = null;
  if (rising) {
    const keep = adj[peakBar] * 0.8;
    for (let h = 1; h <= H; h++) {
      if (adj[h] >= keep) { if (holdFrom === null) holdFrom = h; holdTo = h; }
    }
  }

  const price = fc.lastPrice;
  const at = (bar) => fc.lastTime + step * bar;
  const pathOut = adj.map((v, h) => ({
    bar: h, t: at(h), pct: v * 100, price: price * (1 + v),
    shareUp: shareUp[h] === null ? null : shareUp[h] * 100,
    lo: price * (1 + band[h][0] + (drift * h) / H),
    hi: price * (1 + band[h][1] + (drift * h) / H),
  }));

  // Does the shape actually say anything, or is it a straight line? It only
  // counts if there is a real high or low to aim at, and it is not simply the
  // endpoint restated (a peak on the final bar tells you nothing about timing).
  const spread = Math.max(...adj) - Math.min(...adj);
  const turningBar = rising ? peakBar : falling ? troughBar : null;
  const shaped = (rising || falling) && turningBar < H && spread > 0.004;

  return {
    ok: true,
    shaped,
    matchesUsed: matches.length,
    horizonBars: H,
    stepMs: step,
    rising,
    falling,
    peak: rising ? { bar: peakBar, t: at(peakBar), pct: adj[peakBar] * 100, price: price * (1 + adj[peakBar]), agreement: shareUp[peakBar] === null ? null : shareUp[peakBar] * 100 } : null,
    trough: falling ? { bar: troughBar, t: at(troughBar), pct: adj[troughBar] * 100, price: price * (1 + adj[troughBar]) } : null,
    turn: turnBar === null ? null : { bar: turnBar, t: at(turnBar), pct: adj[turnBar] * 100, price: price * (1 + adj[turnBar]) },
    recover: recoverBar === null ? null : { bar: recoverBar, t: at(recoverBar), pct: adj[recoverBar] * 100 },
    hold: holdFrom === null ? null : { fromBar: holdFrom, toBar: holdTo, fromT: at(holdFrom), toT: at(holdTo) },
    endPct: adj[H] * 100,
    path: pathOut,
    // Where the forecast's direction did not hold up in testing, only WHEN
    // the high (or low) comes is a measured claim (TESTED_TIMING); how far
    // and which way are not, so nothing downstream states a price for it.
    priceless: !!fc.leanRemoved || (interval !== null && !directionReliable(interval)),
  };
}

/**
 * The few numbers the plain-English summaries need: which way, how many
 * candles to the high (or the low), the price there, and when it turns.
 */
export function condenseTiming(t) {
  if (!t?.ok || !t.shaped) return null;
  const p = t.rising ? t.peak : t.trough;
  if (t.priceless) return { rising: t.rising, bars: p.bar, targetPrice: null, turnBars: null, priceless: true, horizonBars: t.horizonBars };
  return { rising: t.rising, bars: p.bar, targetPrice: p.price, turnBars: t.turn?.bar ?? null };
}

/** Human sentence for the UI, given a bar→duration formatter. */
export function timingText(t, fmtDuration, fmtMoney) {
  if (!t?.ok) return t?.reason || '';
  if (!t.shaped) {
    return t.endPct >= 0
      ? `Past look-alikes drifted up steadily rather than spiking — no clear peak-and-drop pattern within this horizon.`
      : `Past look-alikes drifted down steadily — no clear dip-and-bounce pattern within this horizon.`;
  }
  if (t.priceless) return `In similar past charts the ${t.rising ? 'high' : 'low'} of the next ${fmtDuration(t.horizonBars)} came about **${fmtDuration((t.rising ? t.peak : t.trough).bar)}** in. That is when, not which way or how far: the direction is not reliable on this chart.`;
  // "+0.7%", "−1.0%", and no sign on a move that rounds to zero ("-0.0%").
  const sp = (v) => { const a = Math.abs(v).toFixed(1); return +a === 0 ? '0.0%' : `${v < 0 ? '−' : '+'}${a}%`; };
  const parts = [];
  if (t.rising && t.peak) {
    parts.push(`Strength usually lasts about **${fmtDuration(t.peak.bar)}**, peaking near **${fmtMoney(t.peak.price)}** (${sp(t.peak.pct)})`);
    if (t.turn) parts.push(`then gives most of it back by **${fmtDuration(t.turn.bar)}** from now (${sp(t.turn.pct)})`);
    else parts.push(`and holds rather than reversing inside this horizon`);
  } else if (t.falling && t.trough) {
    parts.push(`Weakness usually runs about **${fmtDuration(t.trough.bar)}**, bottoming near **${fmtMoney(t.trough.price)}** (${sp(t.trough.pct)})`);
    if (t.recover) parts.push(`with a bounce starting in about **${fmtDuration(t.recover.bar)}**`);
    else parts.push(`with no clear bounce inside this horizon`);
  }
  return `${parts.join(', ')}.`;
}

/** Compact form for the AI assistant / LLM context. */
export function summarizeTiming(t) {
  if (!t?.ok || !t.shaped) return null;
  if (t.priceless) {
    return {
      basedOnSimilarPastCharts: t.matchesUsed,
      extreme: t.rising ? 'high' : 'low',
      barsToExtreme: (t.rising ? t.peak : t.trough).bar,
      horizonBars: t.horizonBars,
      note: 'Only when the high or low comes is measured on this chart; which way and how far are not, so no price is given.',
    };
  }
  return {
    basedOnSimilarPastCharts: t.matchesUsed,
    direction: t.rising ? 'rise then fade' : t.falling ? 'fall then bounce' : 'flat',
    barsToPeak: t.peak?.bar ?? null,
    peakMovePct: t.peak ? +t.peak.pct.toFixed(2) : null,
    peakPrice: t.peak ? +t.peak.price.toPrecision(6) : null,
    pctOfPastCasesUpAtPeak: t.peak?.agreement === null || t.peak?.agreement === undefined ? null : +t.peak.agreement.toFixed(0),
    barsUntilItTurnsDown: t.turn?.bar ?? null,
    barsToTrough: t.trough?.bar ?? null,
    troughMovePct: t.trough ? +t.trough.pct.toFixed(2) : null,
    barsUntilBounce: t.recover?.bar ?? null,
    moveAtHorizonPct: +t.endPct.toFixed(2),
    bestHoldWindowBars: t.hold ? [t.hold.fromBar, t.hold.toBar] : null,
  };
}

// Measured timing accuracy — tools/evaluate-timing.mjs (current figures and how
// they were measured are in the comment inside TESTED_TIMING below).
export const TESTED_TIMING = {
  // Measured on every coin the app can trade (106, each from the exchange it is
  // read on; Evaluate job "timing", 2026-10-16): 3,822 walk-forward tests on all
  // six charts, each prediction made only from candles that existed at that
  // moment. A hit means the real high or low landed within +/-25% of the horizon
  // of the bar the forecast named. `baselinePct` is what a uniform random guess
  // scores on the SAME tests, so the edge is the gap and nothing else.
  //
  // The edge is small. On 12 coins it read 58.0% against 54.1%; on 106 coins it
  // is 52.8% against 51.4%. No chart clears its own baseline by 4 points, and 5m
  // and 1m sit below or at theirs. A run a few hours earlier on nearly the same
  // candles (`previousRun`) put single charts 1 to 4 points away from these
  // figures, as much as most of the edges: the tests on one chart share their
  // moments across coins, and crypto moves together, so they are far fewer
  // independent tests than the count suggests.
  //
  // Timing answers "when", never "which way". A well-placed turning point on a
  // direction call with no edge is still a direction call with no edge.
  tests: 3822, coins: 106, measuredOn: '2026-10-16',
  peakHitPct: 52.8, baselinePct: 51.4, medianBarsOff: 3,
  turnedInsideHorizonPct: 81.3,
  byInterval: {
    '1m': { tests: 170, hitPct: 49.4, baselinePct: 48.9, medianOff: 5 },
    '5m': { tests: 424, hitPct: 42.7, baselinePct: 47.0, medianOff: 4 },
    '15m': { tests: 640, hitPct: 51.4, baselinePct: 48.7, medianOff: 2 },
    '1h': { tests: 1059, hitPct: 45.9, baselinePct: 44.6, medianOff: 4 },
    '4h': { tests: 992, hitPct: 63.9, baselinePct: 61.6, medianOff: 2 },
    '1d': { tests: 537, hitPct: 56.6, baselinePct: 53.6, medianOff: 2 },
  },
  // The run before, on the same 106 coins; it scored no per-chart baselines.
  previousRun: { tests: 3874, peakHitPct: 53.7, baselinePct: 51.9, hitPct: { '1m': 45.4, '5m': 41.5, '15m': 48.3, '1h': 48.1, '4h': 66.4, '1d': 60.3 } },
};

/** How far a chart's hit rate moved between the last two runs, in points (null if unknown). */
export function timingSwing(interval) {
  const now = TESTED_TIMING.byInterval[interval]?.hitPct;
  const before = TESTED_TIMING.previousRun?.hitPct?.[interval];
  return Number.isFinite(now) && Number.isFinite(before) ? +Math.abs(now - before).toFixed(1) : null;
}

/** The chart where timing beat its own baseline by the most (at least 1 point), or null. */
export function bestTimingChart() {
  let best = null;
  for (const [interval, t] of Object.entries(TESTED_TIMING.byInterval)) {
    const edge = +(t.hitPct - t.baselinePct).toFixed(1);
    if (edge >= 1 && (!best || edge > best.edge)) best = { interval, edge, hitPct: t.hitPct, baselinePct: t.baselinePct };
  }
  return best;
}

/** Is the timing call worth showing on this timeframe, and what should we admit? */
export function timingTrust(interval) {
  const iv = TESTED_TIMING.byInterval[interval];
  if (!iv) return { level: 'unknown', text: `Timing has not been measured on the ${interval} chart, so treat any turning point there as a rough guide only.` };
  // Each timeframe is judged against its OWN random baseline. Comparing every
  // timeframe to one global number made a 68.7% look far better than a 52.5%
  // when, against what each had to beat, they are worth about the same. An edge
  // no bigger than the move between two runs is not counted as a clear one.
  const edge = iv.hitPct - iv.baselinePct;
  const swing = timingSwing(interval);
  const before = TESTED_TIMING.previousRun?.hitPct?.[interval];
  const thin = iv.tests < 100;
  const best = bestTimingChart();
  if (edge >= 4 && (swing === null || swing < edge)) {
    return { level: 'good', text: `On ${interval} charts the real high or low landed inside the predicted window ${iv.hitPct.toFixed(1)}% of the time across ${iv.tests} tests, against ${iv.baselinePct.toFixed(1)}% for a random guess on the same tests: an edge of ${edge.toFixed(1)} points. Typical miss ${iv.medianOff} candle${iv.medianOff === 1 ? '' : 's'}.${thin ? ' That is a small sample, so treat it as provisional.' : ''}` };
  }
  if (edge >= 1) {
    const moved = swing === null ? '' : swing >= edge
      ? ` A run a few hours earlier read ${before}%: the figure moved ${swing.toFixed(1)} points between runs, more than the edge.`
      : ` A run a few hours earlier read ${before}%.`;
    return { level: 'weak', text: `On ${interval} charts the real high or low landed inside the predicted window ${iv.hitPct.toFixed(1)}% of the time across ${iv.tests} tests, against ${iv.baselinePct.toFixed(1)}% for a random guess on the same tests: ${edge.toFixed(1)} points, which is barely an edge.${moved} Treat the turning point as a rough guide, not a clock.` };
  }
  const elsewhere = best && best.interval !== interval ? ` It tested best on ${best.interval} (${best.hitPct.toFixed(1)}% against ${best.baselinePct.toFixed(1)}%), and even that edge is small.` : '';
  return { level: 'bad', text: `Timing does not work on ${interval} charts: ${iv.hitPct.toFixed(1)}% against a ${iv.baselinePct.toFixed(1)}% random baseline over ${iv.tests} tests. Ignore the turning point here.${elsewhere}` };
}

void clamp;
