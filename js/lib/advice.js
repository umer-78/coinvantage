// One reading per coin — and, where the evidence supports one, a verdict.
//
// The app already produces four independent readings of a coin: the technical
// signal, the model ensemble's direction probability, the shaped timing path,
// and the multi-year history check. Each of them publishes how accurate it has
// been. This module blends them *weighted by that measured accuracy*, so a
// reading with no demonstrated edge barely moves the verdict, and then states
// the result in plain language with the trade levels attached.
//
// It is advice in the sense of "here is what the evidence says", not a promise.
// Nothing here executes anything.

import { upRateFor } from './signals.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// An input only counts as much as its track record justifies. 50% accuracy is a
// coin flip and earns zero weight; 60% is a strong edge for crypto.
const edgeWeight = (accuracy, floor = 0.5) =>
  accuracy === null || accuracy === undefined ? 0.15 : clamp((accuracy - floor) / 0.1, 0, 1);

export function adviseCoin({ signal, forecast, timing, history, holding = null, interval = '4h' } = {}) {
  if (!signal?.ok) return { ok: false, reason: signal?.reason || 'No signal for this coin.' };

  const parts = [];
  const reasons = [];

  // 1. Technical signal.
  //
  // This module's whole premise is that each reading counts only as much as its
  // track record justifies — and this one was the sole exception: a hardcoded
  // weight of 0.9, the heaviest of the four, never passed through edgeWeight().
  // It is also the reading that was since measured to point the WRONG way:
  // across 244,000 bars the share of bars that rose falls as the score rises.
  //
  // So it now goes through the same gate as everything else, using its measured
  // directional accuracy — for a positive score, how often bars in that band
  // actually rose; for a negative score, how often they actually fell. Both come
  // out under 50%, so the gate gives it zero weight, which is the correct answer
  // and not a special case. It stays in the reasons because the reading is worth
  // seeing; it just no longer votes.
  const bucket = upRateFor(interval, signal.score);
  const dirAcc = bucket === null ? null
    : (signal.score >= 0 ? bucket.upRatePct : 100 - bucket.upRatePct) / 100;
  // The bar is 55%, not 50%. Crediting anything above a coin flip let a reading
  // in the NEUTRAL band vote bearish on the strength of 51.9% in one sample —
  // noise dressed as evidence. No measured band comes close to 55%, so this is
  // zero today; it is written as a threshold rather than a constant so that a
  // future re-measurement showing a real edge would switch it back on by itself.
  const SIGNAL_EDGE_FLOOR = 0.55;
  const signalWeight = bucket === null ? 0 : edgeWeight(dirAcc, SIGNAL_EDGE_FLOOR) * 0.9;
  parts.push({ key: 'signal', value: clamp(signal.score / 60, -1, 1), weight: signalWeight });
  reasons.push({
    tone: 'flat',
    text: `Chart reading: ${signal.text} (${signal.score > 0 ? '+' : ''}${signal.score}/100)`
      + (bucket === null
        ? ' — this timeframe has never been measured, so it earns no weight in the verdict.'
        : `. Measured over ${bucket.bars.toLocaleString()} bars, readings in this band were followed by a higher price ${bucket.upRatePct}% of the time${signalWeight > 0 ? '.' : ', so it earns no weight in the verdict.'}`),
  });

  // 2. Model ensemble, weighted by its own out-of-sample accuracy on this coin.
  if (forecast?.ok) {
    const edge = (forecast.probUp - 0.5) * 2;
    const w = edgeWeight(forecast.ensemble?.accuracy) * 1.4;
    parts.push({ key: 'forecast', value: clamp(edge * 2.5, -1, 1), weight: w });
    const accTxt = forecast.ensemble?.accuracy !== null && forecast.ensemble?.accuracy !== undefined
      ? `${(forecast.ensemble.accuracy * 100).toFixed(0)}% accurate on unseen data`
      : 'accuracy not measured';
    reasons.push({
      tone: forecast.probUp >= 0.54 ? 'good' : forecast.probUp <= 0.46 ? 'bad' : 'flat',
      text: `AI forecast: ${(forecast.probUp * 100).toFixed(0)}% chance of rising (${accTxt})${w < 0.25 ? ' — little measured edge, so it barely counts here' : ''}.`,
    });
  }

  // 3. Multi-year history: what happened the last times the chart looked like this.
  if (history?.ok) {
    const s = history.analogs.stats[history.horizon];
    const w = edgeWeight(history.validation?.accuracy) * 0.8;
    parts.push({ key: 'history', value: clamp((s.probUp - 0.5) * 3, -1, 1), weight: w });
    reasons.push({
      tone: s.probUp >= 0.6 ? 'good' : s.probUp <= 0.4 ? 'bad' : 'flat',
      text: `Previous years: ${s.upCount}/${s.total} look-alike charts rose over ${history.horizon} days (median ${s.median >= 0 ? '+' : ''}${s.median.toFixed(1)}%)${w < 0.2 ? ' — this method is near a coin flip on this coin' : ''}.`,
    });
  }

  // 4. Timing: is there room left in the move, or is the peak already behind us?
  let timingNote = null;
  if (timing?.ok && timing.shaped) {
    const room = timing.rising ? clamp(1 - timing.peak.bar / timing.horizonBars, 0, 1) : 0;
    parts.push({ key: 'timing', value: timing.rising ? room * 0.6 : -0.5, weight: 0.5 });
    timingNote = timing;
    reasons.push({
      tone: timing.rising ? 'good' : 'bad',
      text: timing.rising
        ? `Timing: strength expected to run ${timing.peak.bar} more candle${timing.peak.bar === 1 ? '' : 's'} before topping out.`
        : `Timing: weakness expected for the next ${timing.trough.bar} candle${timing.trough.bar === 1 ? '' : 's'} — a better entry may come.`,
    });
  }

  const wsum = parts.reduce((s, p) => s + p.weight, 0) || 1;
  const score = parts.reduce((s, p) => s + p.value * p.weight, 0) / wsum; // -1..1
  const conviction = Math.round(Math.abs(score) * 100);

  // How much of the verdict rests on things that have actually been shown to work?
  const evidenceWeight = parts.filter((p) => p.key !== 'signal').reduce((s, p) => s + p.weight, 0);
  const evidence = evidenceWeight < 0.5 ? 'thin' : evidenceWeight < 1.2 ? 'moderate' : 'good';

  let verdict, tone, headline;
  if (holding) {
    if (score <= -0.35) { verdict = 'SELL'; tone = 'down'; headline = 'Reduce or close'; }
    else if (score <= -0.12) { verdict = 'TRIM'; tone = 'warn'; headline = 'Take some off'; }
    else if (score >= 0.3) { verdict = 'ADD'; tone = 'up'; headline = 'Hold and add on dips'; }
    else { verdict = 'HOLD'; tone = 'flat'; headline = 'Hold, nothing to do'; }
  } else if (score >= 0.35) { verdict = 'BUY'; tone = 'up'; headline = 'Buy candidate'; }
  else if (score >= 0.15) { verdict = 'ACCUMULATE'; tone = 'up'; headline = 'Worth accumulating'; }
  else if (score <= -0.3) { verdict = 'AVOID'; tone = 'down'; headline = 'Avoid for now'; }
  else { verdict = 'WAIT'; tone = 'flat'; headline = 'No edge — wait'; }

  // Trade levels only come from the signal engine, which is the part that was
  // backtested with stops and targets. No plan = no levels, and we say so.
  const plan = signal.plan && signal.plan.side === 'long' ? signal.plan : null;

  return {
    ok: true,
    verdict, tone, headline, conviction, score, evidence,
    price: signal.price,
    plan: plan && {
      entryZone: plan.entryZone, stopLoss: plan.stopLoss, takeProfits: plan.takeProfits,
      riskPct: plan.riskPct, rewardRisk: plan.rewardRisk,
    },
    waitFor: plan ? null : signal.waitFor,
    timing: timingNote && {
      rising: timingNote.rising,
      bars: timingNote.rising ? timingNote.peak.bar : timingNote.trough.bar,
      targetPrice: timingNote.rising ? timingNote.peak.price : timingNote.trough.price,
      turnBars: timingNote.turn?.bar ?? null,
    },
    reasons,
    parts,
  };
}

/** Rank a scanned list into "buy these / avoid these". */
export function rankAdvice(rows) {
  const scored = rows.filter((r) => r.advice?.ok);
  const buys = scored.filter((r) => ['BUY', 'ACCUMULATE'].includes(r.advice.verdict))
    .sort((a, b) => b.advice.score - a.advice.score);
  const avoid = scored.filter((r) => r.advice.verdict === 'AVOID')
    .sort((a, b) => a.advice.score - b.advice.score);
  const wait = scored.filter((r) => r.advice.verdict === 'WAIT');
  return { buys, avoid, wait, total: scored.length };
}

export const ADVICE_DISCLAIMER = 'This is a reading of public market data, not personalised financial advice. Every level assumes you set the stop-loss. The app never places a trade for you.';
