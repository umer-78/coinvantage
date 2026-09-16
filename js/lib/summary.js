// Turns a signal, a forecast, a timing estimate and the other timeframes into
// the answer a person actually came for: what to do, at what price, for how
// long, where to get out, and what would prove it wrong.
//
// The numbers were always on the page — entry zone, stop, targets, a score out
// of 100 — but a reader had to assemble the meaning themselves. This module does
// that assembly in one place so the coin page, the assistant and the advice page
// all say the same thing in the same words.
//
// Two things this file is deliberately careful about, both of them corrections
// of mistakes that were shipped earlier:
//
//  1. Confidence is not the size of the score. Grouping bars by score and
//     trading the best-looking band came out behind entering at random, so a
//     big number earns no confidence on its own. The label is now built only
//     from what was measured — tested expectancy on the timeframe, tested
//     forecast accuracy on the timeframe, and whether the readings agree — and
//     the summary states which of those it used. In particular a timeframe the
//     app elsewhere admits has no measured edge can never be shown as high
//     confidence, which is what used to happen on the daily chart.
//
//  2. A timeframe is not an opinion. Reading 1h and 1d gives two answers about
//     two different spans of price; presenting them as rival verdicts on
//     separate screens made the app look like it was contradicting itself.
//     Every summary now carries the same combined view and says plainly which
//     timeframe leads and why they differ.

import { conflictCheck } from './analyst.js';
import { edgeBand, confluence } from './signals.js';
import { TESTED_ACCURACY } from './predict.js';

const pct = (v, dp = 1) => `${v > 0 ? '+' : ''}${Number(v).toFixed(dp)}%`;
const signed = (v) => `${v > 0 ? '+' : ''}${v}`;

/** The timeframes the app reconciles against each other, shortest first. */
export const TF_ORDER = ['15m', '1h', '4h', '1d'];

/** Below this a score is not a direction, it is noise. */
const NEUTRAL_BAND = 20;

const dirOf = (score) => (score >= NEUTRAL_BAND ? 1 : score <= -NEUTRAL_BAND ? -1 : 0);
const noEdgeOn = (iv) => (TESTED_ACCURACY.noEdge || []).includes(iv);
const accuracyOn = (iv) => (typeof TESTED_ACCURACY[iv] === 'number' ? TESTED_ACCURACY[iv] : null);

/** "15m 57.1% · 1h 53.0% · 4h 58.9% · 1d 47.0%" */
function accuracyList() {
  return TF_ORDER.filter((iv) => accuracyOn(iv) !== null)
    .map((iv) => `${iv} ${accuracyOn(iv).toFixed(1)}%`)
    .join(' · ');
}

/**
 * Reconcile the timeframes into one view.
 *
 * The weighting is the same one the signal card shows, so the sentence in the
 * summary and the number on the card can never drift apart.
 *
 * @param {Record<string, any>} mtf signals keyed by interval
 * @param {string} interval the chart the reader is looking at
 * @returns {null | {
 *   rows: {interval: string, score: number, text: string, tone: string, dir: number,
 *          accuracyPct: number|null, noEdge: boolean}[],
 *   score: number, text: string, tone: string, dir: number,
 *   here: object|null, anchor: object, relation: 'aligned'|'against'|'quiet'|'mixed'|'outside',
 *   split: boolean, span: string
 * }}
 */
export function reconcileTimeframes(mtf, interval) {
  if (!mtf) return null;
  const picked = {};
  const rows = [];
  for (const iv of TF_ORDER) {
    const s = mtf[iv];
    if (!s?.ok || typeof s.score !== 'number') continue;
    picked[iv] = s;
    rows.push({
      interval: iv,
      score: s.score,
      text: s.text || '—',
      tone: s.tone || 'flat',
      dir: dirOf(s.score),
      accuracyPct: accuracyOn(iv),
      noEdge: noEdgeOn(iv),
    });
  }
  if (rows.length < 2) return null;

  const c = confluence(picked);
  if (!c) return null;

  const dir = dirOf(c.score);
  const here = rows.find((r) => r.interval === interval) || null;
  const anchor = rows[rows.length - 1];

  let relation;
  if (!here) relation = 'outside';
  else if (here.dir !== 0 && dir !== 0) relation = here.dir === dir ? 'aligned' : 'against';
  else if (here.dir === 0 && dir !== 0) relation = 'quiet';
  else relation = 'mixed';

  const split = new Set(rows.map((r) => r.dir)).size > 1;
  // Timeframes that cancel each other out are not a neutral market — they are a
  // disagreement, and a clean directional verdict on any one of them would be
  // reporting the loudest chart rather than the evidence.
  if (relation === 'mixed' && split && here && here.dir !== 0) relation = 'split';
  const span = `${rows[0].interval}–${anchor.interval}`;

  return { rows, score: c.score, text: c.text, tone: c.tone, dir, here, anchor, relation, split, span };
}

/** "15m buy (+30) · 1h neutral (+5) · 4h buy (+33) · 1d strong buy (+67)" */
function rowList(rec) {
  return rec.rows.map((r) => `${r.interval} ${String(r.text).toLowerCase()} (${signed(r.score)})`).join(' · ');
}

/**
 * The two paragraphs that stop three timeframes reading as three contradictions:
 * what every timeframe says, and which one leads.
 */
export function reconcileSteps(rec, interval) {
  if (!rec) return [];
  const combined = `${rec.text} (${signed(rec.score)})`;
  const steps = [];

  let why;
  if (rec.relation === 'against') {
    why = `This ${interval} chart reads ${String(rec.here.text).toLowerCase()} while the combined view across ${rec.span} is ${combined}. That is a disagreement about span, not about the coin: a short chart turning against a longer trend is usually a pullback inside it. Follow the longer timeframe for direction and treat this one as a reason to wait for a better entry, not as a second opinion of equal weight.`;
  } else if (rec.relation === 'quiet') {
    why = `This ${interval} chart has no direction of its own right now (${signed(rec.here.score)} is inside the neutral band), while the combined view across ${rec.span} is ${combined}. Nothing has triggered on this timeframe yet — the standing view is the combined one, and this chart is where you would time an entry into it.`;
  } else if (rec.relation === 'aligned') {
    why = `This ${interval} chart and the combined view across ${rec.span} agree: ${combined}. Agreement across spans of price is the strongest form this setup takes. It still is not a prediction — it means the evidence is not pulling in two directions.`;
  } else if (rec.relation === 'split') {
    why = `This ${interval} chart reads ${String(rec.here.text).toLowerCase()}, but the other timeframes point the other way and the weighted view across ${rec.span} cancels out to ${signed(rec.score)}. A board this split is a disagreement, not a trend — acting on the one chart that happens to be loudest is how a reader ends up on the wrong side of the move.`;
  } else if (rec.relation === 'outside') {
    why = `This ${interval} chart is shorter than any timeframe with a measured track record, so nothing on it has been tested. The combined view across ${rec.span} is ${combined}; use this chart for timing only.`;
  } else {
    why = `The timeframes are split and the combined view comes out flat (${signed(rec.score)}). When the spans of price disagree this evenly there is no trend to trade, whatever any single chart says.`;
  }

  steps.push({
    label: 'Across timeframes',
    text: `${rowList(rec)}. ${why}`,
  });

  const accs = accuracyList();
  const noEdge = TF_ORDER.filter(noEdgeOn);
  let follow = `Longer timeframes set direction, shorter ones set timing, so where they disagree the ${rec.anchor.interval} reading leads and the shorter charts decide when to act on it.`;
  if (accs) {
    follow += ` The forecast model is not equally good on all of them — measured direction accuracy on unseen data was ${accs} across ${TESTED_ACCURACY.coins} coins.`;
  }
  if (noEdge.length) {
    follow += ` ${noEdge.join(' and ')} ${noEdge.length > 1 ? 'are' : 'is'} at or below a coin flip, so a probability shown there is not evidence — on that chart read the trend structure and ignore the percentage.`;
  }
  steps.push({ label: 'Which timeframe to follow', text: follow });

  return steps;
}

/**
 * Confidence, built only from things that were measured.
 *
 * The old rule read confidence off the size of the score, which is the one
 * quantity the band test showed carries no lift, and it never looked at the
 * per-timeframe accuracy table — so the daily chart, the timeframe with the
 * worst measured accuracy of the four, was the one shouting "high confidence".
 */
function confidenceFor({ interval, strength, conflict, coinAcc, relation, expectancyR }) {
  const tfAcc = accuracyOn(interval);
  const reasons = [];
  let level = 'low';

  if (strength >= 25) level = 'moderate';

  // "high" has to clear every measured bar at once, not just look impressive.
  const geometryPays = expectancyR === null || expectancyR === undefined ? null : expectancyR > 0;
  if (strength >= 45 && tfAcc !== null && tfAcc >= 55 && geometryPays === true && relation !== 'against' && !conflict) {
    level = 'high';
  }

  if (conflict) { level = 'low'; reasons.push('the chart and the forecast disagree'); }
  if (relation === 'against') { level = 'low'; reasons.push('this timeframe is pointing against the longer ones'); }
  if (relation === 'split') { level = 'low'; reasons.push('the timeframes contradict each other and average out to no trend'); }
  if (noEdgeOn(interval)) {
    if (level === 'high') level = 'moderate';
    reasons.push(`the forecast has no measured edge on ${interval} (${tfAcc !== null ? tfAcc.toFixed(1) : '—'}%)`);
  }
  if (geometryPays === false) {
    if (level === 'high') level = 'moderate';
    reasons.push(`these stop and target distances tested negative on ${interval}`);
  }
  if (coinAcc !== null && coinAcc !== undefined && coinAcc < 52) {
    if (level === 'high') level = 'moderate';
    reasons.push(`the forecast is at ${coinAcc}% on this coin`);
  }
  if (strength < 25) reasons.push('the indicators barely agree');

  const why = reasons.length
    ? `Rated ${level} because ${reasons.join(', and ')}.`
    : `Rated ${level}: no conflict between the readings, positive tested expectancy on ${interval}, and the forecast has a measured record there. It is a description of the evidence, not a promise.`;

  return { level, why };
}

/**
 * @returns {{
 *   verdict: string, tone: 'up'|'down'|'warn'|'flat', headline: string,
 *   steps: {label: string, text: string}[], caveats: string[],
 *   confidence: string, confidenceWhy: string, reconciled: object|null
 * }}
 */
export function tradeSummary({ signal, forecast, timing, interval, horizonText, mtf = null, fmt = (v) => String(v) }) {
  if (!signal?.ok) {
    return {
      verdict: 'NO READING', tone: 'flat',
      headline: 'Not enough price history on this timeframe to form a view.',
      steps: [], caveats: [], confidence: 'none', confidenceWhy: '', reconciled: null,
    };
  }

  const side = signal.plan?.side ?? null;
  const score = signal.score;
  const conflict = conflictCheck(signal, forecast);
  const strength = Math.abs(score);
  const rec = reconcileTimeframes(mtf, interval);
  const relation = rec ? rec.relation : null;

  const acc = forecast?.validatedAccuracyPct ?? null;
  const expectancyR = signal.plan?.expectancyR ?? null;
  const { level: confidence, why: confidenceWhy } =
    confidenceFor({ interval, strength, conflict, coinAcc: acc, relation, expectancyR });

  const steps = [];
  const caveats = [];
  let verdict, tone, headline;

  if (conflict) {
    verdict = 'NO CLEAR EDGE';
    tone = 'warn';
    headline = `The chart says ${side === 'short' ? 'sell' : 'buy'} but the forecast leans the other way (${conflict.probUp}% chance up). When the two disagree, the honest reading is that there is no edge here right now.`;
    caveats.push('Waiting for the chart and the forecast to point the same way is usually the better trade than picking one of them.');
  } else if ((relation === 'against' || relation === 'split') && side) {
    // The old behaviour printed a clean BUY here and left the reader to notice
    // on another screen that the longer charts said the opposite.
    verdict = 'WAIT — TIMEFRAMES DISAGREE';
    tone = 'warn';
    headline = relation === 'split'
      ? `This ${interval} chart wants to ${side === 'short' ? 'sell' : 'buy'}, but the other timeframes point the other way and across ${rec.span} it all cancels out (${signed(rec.score)}). A split board is a disagreement, not a trend, and the honest call is to stay out until it resolves.`
      : `This ${interval} chart wants to ${side === 'short' ? 'sell' : 'buy'}, but across ${rec.span} the weight of evidence is ${rec.text.toLowerCase()} (${signed(rec.score)}). One chart against the rest is a pullback more often than it is a turn, so the honest call is to wait for them to line up.`;
  } else if (side === 'long') {
    // No "STRONG BUY". The band test showed a bigger score does not mean a
    // better trade, so a word that promises one was removed rather than kept.
    verdict = 'BUY';
    tone = 'up';
    headline = `The setup favours buying ${signal.coinSymbol || 'this coin'} on the ${interval} chart, with a defined place to get out if it is wrong.`;
  } else if (side === 'short') {
    verdict = 'SELL';
    tone = 'down';
    headline = 'The setup has turned against holders. If you own this, the case for reducing is stronger than the case for adding.';
  } else {
    verdict = 'WAIT';
    tone = 'flat';
    headline = rec && rec.dir !== 0
      ? `Nothing on the ${interval} chart clears the bar to act on, though across ${rec.span} the weight of evidence is ${rec.text.toLowerCase()} (${signed(rec.score)}). Sitting out is a position, and it is the right one more often than people expect.`
      : 'Nothing here clears the bar to act on. Sitting out is a position, and it is the right one more often than people expect.';
  }

  const planUsable = signal.plan && !conflict && relation !== 'against' && relation !== 'split';
  const p = signal.plan;
  if (planUsable) {
    const buying = p.side === 'long';
    steps.push({
      label: buying ? 'What to buy' : 'What to do',
      text: buying
        ? `Buy ${signal.coinSymbol || 'the coin'} on the ${interval} chart — this reading is for that timeframe only, not a long-term view.`
        : `Reduce or close the position. This is an exit signal, not an invitation to short unless you already trade that way.`,
    });
    steps.push({
      label: buying ? 'When to buy' : 'When to act',
      text: buying
        ? `Inside ${fmt(p.entryZone[0])} – ${fmt(p.entryZone[1])}. Buying above that zone pays a worse price for the same risk, so if it has run away, wait for it to come back rather than chasing.`
        : `On a close below ${fmt(p.stopLoss)}, or straight away if you are already in profit and want to protect it.`,
    });
    if (buying) {
      steps.push({
        label: 'When to sell',
        text: `Take profit in pieces: ${p.takeProfits.map(fmt).join(', then ')}. A common approach is to sell a third at the first target and move your stop up to what you paid, so the rest of the trade cannot lose.`,
      });
    }
    steps.push({
      label: 'Where you are wrong',
      text: `${fmt(p.stopLoss)}. That is ${p.riskPct}% below your entry — if price closes past it, the reason for the trade is gone. Set this when you place the order, not later.`,
    });
    steps.push({
      label: 'How much',
      text: `Risk at most 1–2% of your account on this. With a ${p.riskPct}% stop, that means a position of roughly ${(1.5 / p.riskPct).toFixed(1)}× to ${(2 / p.riskPct).toFixed(1)}× your per-trade risk budget — not your whole balance.`,
    });
  } else if (!p) {
    const waits = signal.waitFor?.length ? signal.waitFor : ['No trigger has formed yet.'];
    steps.push({ label: 'What to wait for', text: waits.join(' · ') });
  } else if (relation === 'against' || relation === 'split') {
    steps.push({
      label: 'What to wait for',
      text: `The levels below still stand if you want them, but the trade only becomes worth taking when the ${rec.anchor.interval} chart agrees. Watch for the ${interval} reading to turn the same way as the combined view rather than acting on it now.`,
    });
  }

  if (timing && !conflict) {
    steps.push({
      label: 'How long',
      text: timing.rising
        ? `Strength has typically lasted about ${horizonText || `${timing.bars} candles`} in similar past setups, topping near ${fmt(timing.targetPrice)}${timing.turnBars ? ', then turning down' : ''}. Timing is the least reliable part of any forecast — use it to plan an exit, never to skip the stop.`
        : `Weakness has typically run about ${horizonText || `${timing.bars} candles`} in similar setups, so waiting is likely to get a better price than buying now.`,
    });
  }

  if (forecast && !conflict) {
    const dir = forecast.probUpPct >= 50 ? 'up' : 'down';
    const tfAcc = accuracyOn(interval);
    let text = `${forecast.probUpPct}% chance of going ${dir} over ${horizonText || 'the forecast horizon'}`;
    if (acc !== null) text += `, from a model that called direction right ${acc}% of the time on recent data it had never seen`;
    text += '.';
    if (noEdgeOn(interval)) {
      text += ` Read that number with suspicion here: across ${TESTED_ACCURACY.coins} coins the model scored ${tfAcc !== null ? tfAcc.toFixed(1) : '—'}% on the ${interval} timeframe, which is worse than guessing, so it is shown for completeness and is not part of the verdict above.`;
    }
    steps.push({ label: 'What the model adds', text });
  }

  // Every summary carries the same cross-timeframe paragraph, so switching the
  // chart changes the detail without changing the standing view.
  if (rec) steps.push(...reconcileSteps(rec, interval));

  // What the score means, stated from the test rather than from the look of it.
  // Grouping bars by score showed one band with apparent lift; trading that band
  // in sequence, one position at a time, did worse than entering at random. The
  // reader gets the second result, because it is the one that matches what they
  // can actually do.
  const { tested } = edgeBand(interval, signal.score);
  if (tested && !conflict) {
    caveats.push(`What the score is: how strongly the indicators agree right now, not a prediction of profit. Trading the best-looking band on this timeframe (scores ${tested.lo}–${tested.hi}) returned ${tested.tradedR >= 0 ? '+' : ''}${tested.tradedR.toFixed(3)}R per trade over ${tested.trades} tested trades, against ${tested.randomR >= 0 ? '+' : ''}${tested.randomR.toFixed(3)}R for entering at random under the same rules. A higher score does not mean a better trade.`);
  }
  if (strength >= 45) {
    caveats.push('A large score on the bar above means the indicators agree with each other, not that the trade is more likely to pay. That was measured separately and it is not.');
  }

  // The geometry's own expectancy, measured over ~21,000 entries. If the levels
  // themselves lose money there is no honest way to present them as a trade.
  if (p && expectancyR !== null && expectancyR !== undefined) {
    if (expectancyR <= 0) {
      caveats.push(`Tested across 12 coins, entries on this timeframe with these stop and target distances came out at ${expectancyR.toFixed(3)}R per trade — slightly negative before you add slippage. The levels are shown for reference; on the evidence this timeframe is one to read, not to trade.`);
      if (verdict === 'BUY') { verdict = 'BUY (WEAK EDGE)'; tone = 'warn'; }
      if (verdict === 'SELL') { verdict = 'SELL (WEAK EDGE)'; tone = 'warn'; }
    } else if (planUsable) {
      steps.push({
        label: 'Does this pay?',
        text: `Measured over about 21,000 entries across 12 coins, this stop and target combination returned ${expectancyR > 0 ? '+' : ''}${expectancyR.toFixed(3)}R per trade after fees. Small, positive, and only true if you take the exits as written.`,
      });
    }
  }

  if (noEdgeOn(interval)) {
    caveats.push(`On the ${interval} chart the forecast model scored ${accuracyOn(interval).toFixed(1)}% on unseen data across ${TESTED_ACCURACY.coins} coins — below a coin flip. Nothing shown on this timeframe is presented as a confident call, whatever the score says.`);
  }
  if (acc !== null && acc < 52) caveats.push(`The forecast has no measured edge on this coin and timeframe (${acc}%), so weight the chart signal more heavily here.`);
  if (strength < 25 && !conflict) caveats.push('This is a weak reading. A small score means the indicators barely agree, which is a reason to size down or skip it.');
  caveats.push('This is a reading of public market data, not advice. Use a stop-loss on every trade and only risk what you can afford to lose.');

  return { verdict, tone, headline, steps, caveats, confidence, confidenceWhy, reconciled: rec };
}

/** The same summary as plain markdown, for the assistant and for exports. */
export function summaryMarkdown(s) {
  if (!s || !s.steps) return '';
  const lines = [`**${s.verdict}** — ${s.headline}`, ''];
  if (s.confidence && s.confidence !== 'none') lines.push(`_Confidence: ${s.confidence}. ${s.confidenceWhy || ''}_`.trim(), '');
  for (const st of s.steps) lines.push(`- **${st.label}:** ${st.text}`);
  if (s.caveats.length) { lines.push(''); for (const c of s.caveats) lines.push(`_${c}_`); }
  return lines.join('\n');
}

export { pct };
