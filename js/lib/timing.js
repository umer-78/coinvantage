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
 * @param {object} opts { intervalMs, minMatches }
 */
export function timingOutlook(fc, { intervalMs = null, minMatches = 4 } = {}) {
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
  };
}

/** Human sentence for the UI, given a bar→duration formatter. */
export function timingText(t, fmtDuration, fmtMoney) {
  if (!t?.ok) return t?.reason || '';
  if (!t.shaped) {
    return t.endPct >= 0
      ? `Past look-alikes drifted up steadily rather than spiking — no clear peak-and-drop pattern within this horizon.`
      : `Past look-alikes drifted down steadily — no clear dip-and-bounce pattern within this horizon.`;
  }
  const parts = [];
  if (t.rising && t.peak) {
    parts.push(`Strength usually lasts about **${fmtDuration(t.peak.bar)}**, peaking near **${fmtMoney(t.peak.price)}** (${t.peak.pct >= 0 ? '+' : ''}${t.peak.pct.toFixed(1)}%)`);
    if (t.turn) parts.push(`then gives most of it back by **${fmtDuration(t.turn.bar)}** from now (${t.turn.pct >= 0 ? '+' : ''}${t.turn.pct.toFixed(1)}%)`);
    else parts.push(`and holds rather than reversing inside this horizon`);
  } else if (t.falling && t.trough) {
    parts.push(`Weakness usually runs about **${fmtDuration(t.trough.bar)}**, bottoming near **${fmtMoney(t.trough.price)}** (${t.trough.pct.toFixed(1)}%)`);
    if (t.recover) parts.push(`with a bounce starting around **${fmtDuration(t.recover.bar)}** from now`);
    else parts.push(`with no clear bounce inside this horizon`);
  }
  return `${parts.join(', ')}.`;
}

/** Compact form for the AI assistant / LLM context. */
export function summarizeTiming(t) {
  if (!t?.ok || !t.shaped) return null;
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

// Measured timing accuracy — tools/evaluate-timing.mjs, 245 walk-forward tests on
// 12 coins of real Binance data. "Hit" means the real high or low landed within
// ±25% of the horizon of the predicted bar; `baselinePct` is what a random guess
// scores on the same tests, so the edge is the gap between them.
//
// It works on 4h and daily charts and does NOT work on 15m, where it scores
// below chance. The UI must say so rather than quietly showing a number.
export const TESTED_TIMING = {
  tests: 245, coins: 12,
  peakHitPct: 61.2, baselinePct: 53.6, medianBarsOff: 2,
  turnedInsideHorizonPct: 82,
  byInterval: {
    '15m': { tests: 20, hitPct: 45.0, medianOff: 3 },
    '1h': { tests: 64, hitPct: 51.6, medianOff: 3 },
    '4h': { tests: 78, hitPct: 67.9, medianOff: 1 },
    '1d': { tests: 83, hitPct: 66.3, medianOff: 2 },
  },
};

/** Is the timing call worth showing on this timeframe, and what should we admit? */
export function timingTrust(interval) {
  const iv = TESTED_TIMING.byInterval[interval];
  if (!iv) return { level: 'unknown', text: 'Timing has not been measured on this timeframe — treat the turning point as a rough guide only.' };
  const edge = iv.hitPct - TESTED_TIMING.baselinePct;
  if (edge >= 8) return { level: 'good', text: `On ${interval} charts the real high or low landed inside the predicted window ${iv.hitPct}% of the time across ${iv.tests} tests (a random guess scores ${TESTED_TIMING.baselinePct}%); typical miss ${iv.medianOff} candle${iv.medianOff === 1 ? '' : 's'}.` };
  if (edge >= 2) return { level: 'weak', text: `On ${interval} charts this scored ${iv.hitPct}% against a ${TESTED_TIMING.baselinePct}% random baseline over ${iv.tests} tests — barely an edge. Use the direction, not the clock.` };
  return { level: 'bad', text: `Timing does not work on ${interval} charts: ${iv.hitPct}% versus a ${TESTED_TIMING.baselinePct}% random baseline over ${iv.tests} tests — worse than guessing. Ignore the turning point here and use the 4h or daily chart for timing.` };
}

void clamp;
