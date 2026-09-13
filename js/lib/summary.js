// Turns a signal, a forecast and a timing estimate into the answer a person
// actually came for: what to do, at what price, for how long, where to get out,
// and what would prove it wrong.
//
// The numbers were always on the page — entry zone, stop, targets, a score out
// of 100 — but a reader had to assemble the meaning themselves. This module does
// that assembly in one place so the coin page, the assistant and the advice page
// all say the same thing in the same words.

import { conflictCheck } from './analyst.js';

const pct = (v, dp = 1) => `${v > 0 ? '+' : ''}${Number(v).toFixed(dp)}%`;

/**
 * @returns {{
 *   verdict: string, tone: 'up'|'down'|'warn'|'flat', headline: string,
 *   steps: {label: string, text: string}[], caveats: string[], confidence: string
 * }}
 */
export function tradeSummary({ signal, forecast, timing, interval, horizonText, fmt = (v) => String(v) }) {
  if (!signal?.ok) {
    return {
      verdict: 'NO READING', tone: 'flat',
      headline: 'Not enough price history on this timeframe to form a view.',
      steps: [], caveats: [], confidence: 'none',
    };
  }

  const side = signal.plan?.side ?? null;
  const score = signal.score;
  const conflict = conflictCheck(signal, forecast);
  const strength = Math.abs(score);

  // Confidence is an honest label, not a sales word: it falls when the two
  // readings disagree, and it never claims more than the measured accuracy.
  const acc = forecast?.validatedAccuracyPct ?? null;
  let confidence = strength >= 45 ? 'high' : strength >= 25 ? 'moderate' : 'low';
  if (conflict) confidence = 'low';
  if (acc !== null && acc < 52 && confidence === 'high') confidence = 'moderate';

  const steps = [];
  const caveats = [];
  let verdict, tone, headline;

  if (conflict) {
    verdict = 'NO CLEAR EDGE';
    tone = 'warn';
    headline = `The chart says ${side === 'short' ? 'sell' : 'buy'} but the forecast leans the other way (${conflict.probUp}% chance up). When the two disagree, the honest reading is that there is no edge here right now.`;
    caveats.push('Waiting for the chart and the forecast to point the same way is usually the better trade than picking one of them.');
  } else if (side === 'long') {
    verdict = score >= 45 ? 'STRONG BUY' : 'BUY';
    tone = 'up';
    headline = `The setup favours buying ${signal.coinSymbol || 'this coin'}, with a defined place to get out if it is wrong.`;
  } else if (side === 'short') {
    verdict = score <= -45 ? 'STRONG SELL' : 'SELL';
    tone = 'down';
    headline = 'The setup has turned against holders. If you own this, the case for reducing is stronger than the case for adding.';
  } else {
    verdict = 'WAIT';
    tone = 'flat';
    headline = 'Nothing here clears the bar to act on. Sitting out is a position, and it is the right one more often than people expect.';
  }

  const p = signal.plan;
  if (p && !conflict) {
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
    steps.push({
      label: 'What the model adds',
      text: `${forecast.probUpPct}% chance of going ${dir} over ${horizonText || 'the forecast horizon'}${acc !== null ? `, from a model that called direction right ${acc}% of the time on recent data it had never seen` : ''}.`,
    });
  }

  if (acc !== null && acc < 52) caveats.push(`The forecast has no measured edge on this coin and timeframe (${acc}%), so weight the chart signal more heavily here.`);
  if (strength < 25 && !conflict) caveats.push('This is a weak reading. A small score means the indicators barely agree, which is a reason to size down or skip it.');
  caveats.push('This is a reading of public market data, not advice. Use a stop-loss on every trade and only risk what you can afford to lose.');

  return { verdict, tone, headline, steps, caveats, confidence };
}

/** The same summary as plain markdown, for the assistant and for exports. */
export function summaryMarkdown(s) {
  if (!s || !s.steps) return '';
  const lines = [`**${s.verdict}** — ${s.headline}`, ''];
  for (const st of s.steps) lines.push(`- **${st.label}:** ${st.text}`);
  if (s.caveats.length) { lines.push(''); for (const c of s.caveats) lines.push(`_${c}_`); }
  return lines.join('\n');
}

export { pct };
