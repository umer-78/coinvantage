// Signal engine: turns indicators into a Buy/Sell score, a trade plan
// (entry, stop-loss, take-profits) and a backtest of the same rules.
// These are rule-based technical signals, not financial advice.

import { computeAll, supportResistance, last } from './indicators.js';

export const THRESHOLDS = { strong: 45, normal: 18 };

/**
 * Stop and target distances, chosen by measurement rather than convention.
 *
 * The old plan — a 1.5 ATR stop and a 2.5:1 target on every timeframe — was
 * never tested. Swept across 12 coins and ~21,000 entries with
 * `tools/evaluate-geometry.mjs`, it turned out to lose money on three of the
 * four timeframes, because a 2.5:1 target from a 1.5 ATR stop is only reached
 * about a quarter of the time. That is the arithmetic behind the −60% weekly
 * backtest, and no forecasting model can rescue a plan whose exits do not pay.
 *
 * `ev` is the measured expected value per trade in R (risk units), after fees,
 * entering at every bar of the newer half of each coin's candles. A negative
 * number means the geometry itself loses — the UI says so rather than
 * printing levels that quietly cost money. Re-measured 2026-10-15 on all 106
 * coins (Evaluate job "signals", two runs hours apart, the later shown): 15m
 * −0.002 and −0.004R, 1h +0.084 and +0.053R, 4h −0.033 and −0.038R, 1d −0.036
 * and −0.033R. The daily plan, +0.058R on 12 coins, loses on 106. On no chart
 * did another of the 30 stop/target pairs do more than 0.01R better, well
 * inside how much one chart's figure moved between the two runs, so the
 * levels are unchanged.
 */
export const TRADE_GEOMETRY = {
  '15m': { stopAtr: 1, rr: 1, ev: -0.004, tested: true },
  '1h':  { stopAtr: 1, rr: 3, ev: +0.053, tested: true },
  '4h':  { stopAtr: 1, rr: 1, ev: -0.038, tested: true },
  '1d':  { stopAtr: 1, rr: 2, ev: -0.033, tested: true },
};
/** How many entries and coins the `ev` figures above rest on. */
export const GEOMETRY_TESTED = { coins: 106, measuredOn: '2026-10-15', entries: { '15m': 51359, '1h': 33128, '4h': 53599, '1d': 22146 } };
/**
 * What the score is, and what it is not — settled by measurement.
 *
 * Two tests were run, and they disagreed. The weaker one was published first and
 * this comment exists so the mistake is not repeated.
 *
 * TEST 1 — bucket averages (`tools/evaluate-signal-edge.mjs`). Group every bar by
 * the score it showed, then average the outcome. On the 1h chart, scores of
 * 45-59 hit target 35.4% against a 27.5% base rate: a 1.29x lift on 486 samples,
 * which looks like a real edge.
 *
 * TEST 2 — trade it (`tools/evaluate-band-strategy.mjs`). Take only those
 * signals, in sequence, one position at a time, with fees, and compare them with
 * an entry at every candle of the same stretch under the same exits. Re-run
 * 2026-10-16 on all 106 coins, on both halves of each coin's candles, with the
 * best-looking band of each chart (the 1d one picked from the newer half):
 *
 *                        newer half              older half
 *   1h, scores 45-59 :  +0.145R vs +0.093R      −0.166R vs −0.115R
 *   4h, scores 18-29 :  +0.039R vs −0.024R      −0.012R vs −0.011R
 *   1d, scores 60-100:  +0.176R vs −0.014R      −0.076R vs −0.032R
 *
 * Every band beat any-candle entries on the half where it looked good and
 * none did on the other; the daily band, the strongest, did worse than any
 * candle on the half it was not picked from. (Until this run the control was
 * 60 fixed moments a coin and counted a time-out as 0R while the band's own
 * time-outs counted their move, which made the comparison unfair; the 12-coin
 * figures below that, +0.040R against +0.126R on 1h, used it.)
 *
 * The bucket average was inflated by two things a real account does not get:
 * overlapping positions it could never have held simultaneously, and partial
 * credit for trades that merely ended slightly up. Neither survives contact with
 * sequencing.
 *
 * So: no score band has been shown to be tradeable. The score describes how
 * strongly the indicators agree right now. It does not predict profit, it is not
 * a gradient, and the UI says so rather than implying otherwise.
 */
export const SIGNAL_EDGE_TESTED = {
  '1h': { lo: 45, hi: 59, bucketLift: 1.09, tradedR: 0.145, randomR: 0.093, trades: 5811, older: { tradedR: -0.166, randomR: -0.115, trades: 3439 }, beatsRandom: false },
  '4h': { lo: 18, hi: 29, bucketLift: 1.04, tradedR: 0.039, randomR: -0.024, trades: 6880, older: { tradedR: -0.012, randomR: -0.011, trades: 5564 }, beatsRandom: false },
  '1d': { lo: 60, hi: 100, bucketLift: 1.21, tradedR: 0.176, randomR: -0.014, trades: 417, older: { tradedR: -0.076, randomR: -0.032, trades: 201 }, beatsRandom: false },
};

/**
 * No band is presented as evidence, because none earned it. Returns the test
 * result for this timeframe so the UI can say what was tried and what it found.
 */
export function edgeBand(interval, score) {
  const t = SIGNAL_EDGE_TESTED[interval];
  if (!t) return { band: null, inside: false, tested: null };
  return { band: null, inside: false, tested: { ...t, inBand: score >= t.lo && score <= t.hi } };
}

const DEFAULT_GEOMETRY = { stopAtr: 1.5, rr: 2.5, ev: null, tested: false };
export const geometryFor = (interval) => TRADE_GEOMETRY[interval] || DEFAULT_GEOMETRY;

/**
 * What a score means, measured rather than assumed.
 *
 * Every candle of every coin is sorted by its score and matched against
 * whether price was higher H candles later (the coin page's horizon), with
 * tools/evaluate-score-buckets.mjs. First run on 12 coins (244,000 bars); on
 * all 106 coins, 2026-10-15 (1,576,070 candles):
 *
 *            Strong fall  Falling  No clear trend  Rising  Strong rise
 *   5m           50.0%     51.4%       49.7%       47.1%     45.4%
 *   15m          53.2%     51.2%       50.0%       48.5%     46.1%
 *   1h           51.2%     49.5%       47.4%       47.1%     46.4%
 *   4h           51.0%     48.6%       47.9%       47.7%     45.3%
 *   1d           47.0%     46.6%       45.4%       46.9%     45.1%
 *
 * On every chart the strong-rise reading was followed by a rise least often,
 * and in neither half of the data did it beat the strong-fall reading. So the
 * bars this engine scored highest were the ones LEAST likely to rise.
 * These are trend indicators, and at these horizons crypto mean-reverts: a high
 * score means "this has already run", which is not the same as "this will keep
 * running". Calling that a Buy — and a big one a Strong Buy — told the reader
 * the opposite of what the data says, and it is why a paper account following
 * these labels lost money with a 19% win rate.
 *
 * Inverting the labels does not fix it either. Both orientations were traded
 * over a held-out half with a 1.5 ATR stop, R targets and 0.1% per-side fees,
 * across five timeframes and four rule variants: nothing produced a positive
 * expectancy that held in both halves. The tilt is real but far too small to
 * pay for the spread.
 *
 * The honest label is therefore a description of trend extension, with no
 * instruction attached. tone stays 'up'/'down' as a chart colour — it describes
 * the direction the indicators lean, not a recommendation.
 */
export const SCORE_BUCKETS_TESTED = {
  bars: 1576070, coins: 106, measuredOn: '2026-10-15',
  upRateByBucket: {
    '5m': { extendedDown: 50.0, leaningDown: 51.4, noTrend: 49.7, leaningUp: 47.1, extendedUp: 45.4 },
    '15m': { extendedDown: 53.2, leaningDown: 51.2, noTrend: 50.0, leaningUp: 48.5, extendedUp: 46.1 },
    '1h': { extendedDown: 51.2, leaningDown: 49.5, noTrend: 47.4, leaningUp: 47.1, extendedUp: 46.4 },
    '4h': { extendedDown: 51.0, leaningDown: 48.6, noTrend: 47.9, leaningUp: 47.7, extendedUp: 45.3 },
    '1d': { extendedDown: 47.0, leaningDown: 46.6, noTrend: 45.4, leaningUp: 46.9, extendedUp: 45.1 },
  },
  higherScoreMeansHigherChance: false,
  invertingItAlsoFails: true,
};

// Plain words for what the indicators show about the move SO FAR. ("Extended
// up" read like jargon, and people took it as a call.) The action codes stay
// the same so logged rows keep their meaning.
export function labelFor(score) {
  if (score >= THRESHOLDS.strong) return { action: 'EXTENDED_UP', text: 'Strong rise so far', tone: 'up' };
  if (score >= THRESHOLDS.normal) return { action: 'LEANING_UP', text: 'Rising', tone: 'up' };
  if (score <= -THRESHOLDS.strong) return { action: 'EXTENDED_DOWN', text: 'Strong fall so far', tone: 'down' };
  if (score <= -THRESHOLDS.normal) return { action: 'LEANING_DOWN', text: 'Falling', tone: 'down' };
  return { action: 'NO_TREND', text: 'No clear trend', tone: 'flat' };
}

/** What the measured up-rate was for this reading, so the UI can show it. */
export function upRateFor(interval, score) {
  const t = SCORE_BUCKETS_TESTED.upRateByBucket[interval];
  if (!t) return null;
  const key = score >= THRESHOLDS.strong ? 'extendedUp'
    : score >= THRESHOLDS.normal ? 'leaningUp'
    : score <= -THRESHOLDS.strong ? 'extendedDown'
    : score <= -THRESHOLDS.normal ? 'leaningDown' : 'noTrend';
  return { bucket: key, upRatePct: t[key], bars: SCORE_BUCKETS_TESTED.bars, coins: SCORE_BUCKETS_TESTED.coins };
}

// Score a single bar. `ind` is the output of computeAll(candles).
export function scoreAt(candles, ind, i) {
  const c = candles[i];
  const parts = [];
  let max = 0;
  const add = (key, label, points, weight, group) => { parts.push({ key, label, points, group }); max += weight; };

  const e20 = ind.ema20[i], e50 = ind.ema50[i], e200 = ind.ema200[i];
  const adxV = ind.adx.adx[i];
  const trendMult = adxV === null ? 1 : adxV > 25 ? 1.25 : adxV < 18 ? 0.7 : 1;

  // 1. Long-term trend
  if (e200 !== null) {
    add('ema200', c.c > e200 ? 'Price above 200 EMA — long-term uptrend' : 'Price below 200 EMA — long-term downtrend',
      (c.c > e200 ? 1.5 : -1.5) * trendMult, 1.5, 'trend');
  }
  // 2. EMA50 / EMA200 regime + fresh crosses
  if (e50 !== null && e200 !== null) {
    let pts = e50 > e200 ? 1 : -1;
    let label = e50 > e200 ? '50 EMA above 200 EMA (bullish regime)' : '50 EMA below 200 EMA (bearish regime)';
    for (let k = 1; k <= 5 && i - k >= 0; k++) {
      const p50 = ind.ema50[i - k], p200 = ind.ema200[i - k];
      if (p50 === null || p200 === null) break;
      if (p50 <= p200 && e50 > e200) { pts = 1.5; label = 'Golden cross: 50 EMA just crossed above 200 EMA'; break; }
      if (p50 >= p200 && e50 < e200) { pts = -1.5; label = 'Death cross: 50 EMA just crossed below 200 EMA'; break; }
    }
    add('cross', label, pts * trendMult, 1.5, 'trend');
  }
  // 3. Short-term trend
  if (e20 !== null && e50 !== null) {
    const bull = (c.c > e20 ? 1 : 0) + (e20 > e50 ? 1 : 0);
    const pts = bull === 2 ? 1 : bull === 0 ? -1 : 0;
    const label = pts > 0 ? 'Price > 20 EMA > 50 EMA — short-term uptrend'
      : pts < 0 ? 'Price < 20 EMA < 50 EMA — short-term downtrend' : 'Short-term EMAs mixed';
    add('ema20', label, pts * trendMult, 1, 'trend');
  }
  // 4. MACD momentum
  const h = ind.macd.hist[i], hp = ind.macd.hist[i - 1];
  if (h !== null && hp !== null && hp !== undefined) {
    let pts, label;
    let crossed = 0;
    for (let k = 0; k < 3 && i - k - 1 >= 0; k++) {
      const a = ind.macd.hist[i - k], b = ind.macd.hist[i - k - 1];
      if (a === null || b === null) break;
      if (b <= 0 && a > 0) { crossed = 1; break; }
      if (b >= 0 && a < 0) { crossed = -1; break; }
    }
    const atrNow = ind.atr[i] || c.c * 0.01;
    const flat = Math.abs(h) < atrNow * 0.03; // histogram hugging zero = chop, ignore crosses
    if (flat) { pts = 0; label = 'MACD flat around zero (no momentum)'; }
    else if (crossed === 1 && h > 0) { pts = 1.25; label = 'MACD bullish crossover'; }
    else if (crossed === -1 && h < 0) { pts = -1.25; label = 'MACD bearish crossover'; }
    else if (h > 0) { pts = h >= hp ? 1 : 0.4; label = h >= hp ? 'MACD positive and strengthening' : 'MACD positive but fading'; }
    else { pts = h <= hp ? -1 : -0.4; label = h <= hp ? 'MACD negative and weakening further' : 'MACD negative but recovering'; }
    add('macd', label, pts, 1.5, 'momentum');
  }
  // 5. RSI
  const r = ind.rsi[i], rp = ind.rsi[i - 1];
  if (r !== null) {
    let pts = 0, label = `RSI ${r.toFixed(0)} — neutral`;
    const rising = rp !== null && rp !== undefined && r > rp;
    const up = e50 !== null && c.c > e50;
    if (r < 25) { pts = 1.5; label = `RSI ${r.toFixed(0)} — deeply oversold`; }
    else if (r < 30) { pts = 1; label = `RSI ${r.toFixed(0)} — oversold`; }
    else if (r < 45) { pts = rising ? 0.5 : -0.3; label = `RSI ${r.toFixed(0)} — weak${rising ? ' but turning up' : ''}`; }
    else if (r <= 55) { pts = 0; }
    else if (r <= 70) { pts = up ? 0.6 : 0.2; label = `RSI ${r.toFixed(0)} — bullish momentum`; }
    else if (r <= 80) { pts = -1; label = `RSI ${r.toFixed(0)} — overbought`; }
    else { pts = -1.5; label = `RSI ${r.toFixed(0)} — extremely overbought, pullback risk`; }
    add('rsi', label, pts, 1.5, 'momentum');
  }
  // 6. Bollinger Bands
  const up = ind.bb.upper[i], lo = ind.bb.lower[i];
  if (up !== null && lo !== null) {
    let pts = 0, label = 'Price inside Bollinger Bands';
    if (c.c < lo) { pts = 1; label = 'Closed below lower Bollinger Band (stretched down)'; }
    else if (c.c > up) { pts = -1; label = 'Closed above upper Bollinger Band (stretched up)'; }
    add('bb', label, pts, 1, 'volatility');
  }
  // 7. Stochastic RSI
  const k = ind.stoch.k[i], d = ind.stoch.d[i];
  if (k !== null && d !== null) {
    let pts = 0, label = `Stoch RSI ${k.toFixed(0)}`;
    if (k < 20 && k > d) { pts = 1; label = `Stoch RSI ${k.toFixed(0)} — bullish cross in oversold zone`; }
    else if (k > 80 && k < d) { pts = -1; label = `Stoch RSI ${k.toFixed(0)} — bearish cross in overbought zone`; }
    add('stoch', label, pts, 1, 'momentum');
  }
  // 8. Volume confirmation
  const vs = ind.volSma[i];
  if (vs) {
    let pts = 0, label = 'Volume normal';
    if (c.v > vs * 1.5) {
      pts = c.c >= c.o ? 0.5 : -0.5;
      label = `Volume spike (${(c.v / vs).toFixed(1)}× avg) on a ${c.c >= c.o ? 'green' : 'red'} candle`;
    }
    add('volume', label, pts, 0.5, 'volume');
  }
  // 9. Directional movement
  const pdi = ind.adx.plusDI[i], mdi = ind.adx.minusDI[i];
  if (pdi !== null && mdi !== null && adxV !== null) {
    const strength = adxV > 25 ? 'strong' : adxV < 18 ? 'weak / ranging' : 'moderate';
    add('adx', `ADX ${adxV.toFixed(0)} (${strength} trend), ${pdi > mdi ? '+DI leads' : '−DI leads'}`,
      pdi > mdi ? 0.5 : -0.5, 0.5, 'trend');
  }

  const raw = parts.reduce((s, p) => s + p.points, 0);
  const score = max === 0 ? 0 : Math.max(-100, Math.min(100, Math.round((raw / max) * 100)));
  return { score, parts };
}

// Decimal places that keep a price readable. Fixed decimals erased sub-cent
// coins: at 8 places a 0.0000000015 price (Baby Doge scale) rounded to 0, so the
// entry, stop and every target read 0. Below 0.00001 keep about four significant
// figures; at or above it the result is exactly what it always was.
function decimalsFor(p) {
  const a = Math.abs(p);
  if (a >= 1000) return 2;
  if (a >= 1) return 4;
  if (a >= 0.01) return 6;
  if (!(a > 0) || a >= 1e-5) return 8;
  return Math.min(20, Math.ceil(-Math.log10(a)) + 3);
}

function round(v, price) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const r = Number(v.toFixed(decimalsFor(price)));
  // Never round a real level away to zero: keep four significant figures instead.
  return r === 0 && v !== 0 ? Number(v.toPrecision(4)) : r;
}

// A short gains at most the whole price, so a target placed k × risk below the
// entry lands at or under zero when the stop is far away relative to the price
// (very volatile coins). Those used to be clamped and shown as $0 — a level the
// price cannot trade at. Each reachable target is kept exactly as measured; an
// unreachable one repeats the previous step's percentage fall instead, so the
// plan keeps three falling, positive targets (the page, alerts and the track
// record all read three). Plans whose targets are all above zero — every normal
// plan — come out unchanged. Returns [] when even the first target is out of
// reach, and the caller drops the plan.
function shortTargets(price, raw) {
  const out = [];
  for (const v of raw) {
    if (v > 0) { out.push(v); continue; }
    if (!out.length) return [];
    const prev = out[out.length - 1], before = out.length > 1 ? out[out.length - 2] : price;
    out.push(prev * (prev / before));
  }
  return out;
}

// Full signal for the latest candle, including a trade plan.
export function generateSignal(candles, { interval = '' } = {}) {
  if (!candles || candles.length < 60) {
    return { ok: false, reason: 'Not enough price history for a signal (need 60+ candles).' };
  }
  const ind = computeAll(candles);
  const i = candles.length - 1;
  const price = candles[i].c;
  const { score, parts } = scoreAt(candles, ind, i);
  const label = labelFor(score);
  const atrV = ind.atr[i] ?? price * 0.02;
  const sr = supportResistance(candles.slice(-300));
  const s1 = sr.supports[0]?.price ?? null;
  const r1 = sr.resistances[0]?.price ?? null;

  // Levels come from the measured geometry for this timeframe, not a fixed rule.
  const geo = geometryFor(interval);
  let plan = null;
  if (score >= THRESHOLDS.normal) {
    let stop = entryStop(price - geo.stopAtr * atrV, s1 !== null ? s1 - 0.25 * atrV : null, 'long', price, atrV);
    const risk = price - stop;
    const tp3Candidate = sr.resistances.find((l) => l.price > price + geo.rr * risk)?.price;
    plan = {
      side: 'long',
      title: 'Long / buy setup',
      entry: round(price, price),
      entryZone: [round(Math.max(price - 0.5 * atrV, s1 ?? -Infinity), price), round(price, price)],
      stopLoss: round(stop, price),
      takeProfits: [price + geo.rr * 0.6 * risk, price + geo.rr * risk, tp3Candidate ?? price + geo.rr * 1.6 * risk].map((v) => round(v, price)),
      riskPct: +((risk / price) * 100).toFixed(2),
      rewardRisk: geo.rr,
      expectancyR: geo.ev,
      geometryTested: geo.tested,
      exitRules: [
        `Exit if price closes below the stop (${fmtNum(stop)})`,
        `Take partial profit at TP1 and move stop to entry`,
        ind.ema50[i] !== null ? `Trend exit: a close below the 50 EMA (${fmtNum(ind.ema50[i])})` : null,
        'Exit or tighten stop if RSI goes above 75 and momentum fades',
      ].filter(Boolean),
    };
  } else if (score <= -THRESHOLDS.normal) {
    let stop = entryStop(price + geo.stopAtr * atrV, r1 !== null ? r1 + 0.25 * atrV : null, 'short', price, atrV);
    const risk = stop - price;
    const tp3Candidate = sr.supports.find((l) => l.price < price - geo.rr * risk)?.price;
    plan = {
      side: 'short',
      title: 'Exit longs / short setup',
      entry: round(price, price),
      entryZone: [round(price, price), round(Math.min(price + 0.5 * atrV, r1 ?? Infinity), price)],
      stopLoss: round(stop, price),
      takeProfits: shortTargets(price, [price - geo.rr * 0.6 * risk, price - geo.rr * risk, tp3Candidate ?? price - geo.rr * 1.6 * risk]).map((v) => round(v, price)),
      riskPct: +((risk / price) * 100).toFixed(2),
      rewardRisk: geo.rr,
      expectancyR: geo.ev,
      geometryTested: geo.tested,
      exitRules: [
        'Spot holders: consider closing or reducing the position',
        `Short invalidated on a close above ${fmtNum(stop)}`,
        ind.ema50[i] !== null ? `Bearish bias ends on a close back above the 50 EMA (${fmtNum(ind.ema50[i])})` : null,
      ].filter(Boolean),
    };
  }

  // A plan whose whole move is smaller than what it costs to trade is not a
  // plan. On a 5-second chart the distance from entry to target can be a
  // fraction of a cent — round-trip fees and the spread eat it several times
  // over. Better to say there is nothing to trade than to draw levels that
  // cannot pay. 0.3% is roughly two round trips at a typical 0.1% taker fee.
  const MIN_TRADEABLE_MOVE = 0.003;
  let noEdgeReason = null;
  // The opposite failure: swings so wide that the setup's stop, or even its first
  // target, would need the price to reach zero. No level like that can be traded.
  if (plan && (!(plan.stopLoss > 0) || plan.takeProfits.length < 3)) {
    noEdgeReason = `Price is swinging too hard on this chart for the tested ${plan.side} setup: its levels would need the price to fall to zero, which it cannot trade at. Treat the reading as a warning rather than a setup, or use a different chart.`;
    plan = null;
  }
  if (plan) {
    const target = plan.takeProfits[0];
    const move = Math.abs(target - price) / price;
    const riskFrac = plan.riskPct / 100;
    if (move < MIN_TRADEABLE_MOVE || riskFrac < 0.001) {
      noEdgeReason = `Price is moving too little on this timeframe to trade: the setup's first target is ${(move * 100).toFixed(3)}% away, which fees and the spread would swallow. Use a slower chart for an actual entry.`;
      plan = null;
    }
  }

  const waitFor = [];
  if (noEdgeReason) waitFor.push(noEdgeReason);
  if (!plan && !noEdgeReason) {
    if (r1 !== null) waitFor.push(`Bullish trigger: a close above resistance ${fmtNum(r1)} with rising volume`);
    if (s1 !== null) waitFor.push(`Pullback buy zone near support ${fmtNum(s1)} if RSI stays above 40`);
    if (s1 !== null) waitFor.push(`Bearish trigger: a close below ${fmtNum(s1)}`);
  }

  const bull = parts.filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
  const bear = parts.filter((p) => p.points < 0).sort((a, b) => a.points - b.points);

  return {
    ok: true,
    interval,
    time: candles[i].t,
    price,
    score,
    confidence: Math.min(100, Math.abs(score)),
    ...label,
    plan,
    waitFor,
    reasons: { bullish: bull.map((p) => p.label), bearish: bear.map((p) => p.label) },
    parts,
    levels: {
      supports: sr.supports.map((l) => round(l.price, price)),
      resistances: sr.resistances.map((l) => round(l.price, price)),
    },
    indicators: {
      rsi: num(last(ind.rsi)), macd: num(last(ind.macd.line)), macdSignal: num(last(ind.macd.signal)),
      macdHist: num(last(ind.macd.hist)), ema20: num(ind.ema20[i]), ema50: num(ind.ema50[i]), ema200: num(ind.ema200[i]),
      bbUpper: num(ind.bb.upper[i]), bbLower: num(ind.bb.lower[i]), atr: num(atrV), atrPct: +((atrV / price) * 100).toFixed(2),
      adx: num(ind.adx.adx[i]), stochK: num(ind.stoch.k[i]), volumeRatio: ind.volSma[i] ? +(candles[i].v / ind.volSma[i]).toFixed(2) : null,
      mfi: num(ind.mfi?.[i]), cci: num(ind.cci?.[i]), willR: num(ind.willr?.[i]),
      supertrend: num(ind.supertrend?.line[i]), supertrendDir: ind.supertrend?.dir[i] ?? null,
      donchianHigh: num(ind.donchian?.upper[i]), donchianLow: num(ind.donchian?.lower[i]),
    },
  };
}

function entryStop(atrStop, levelStop, side, price, atrV) {
  // Prefer a structure level if it's within 3 ATR; otherwise use the ATR stop.
  if (levelStop === null) return atrStop;
  if (side === 'long') {
    const s = Math.min(atrStop, levelStop);
    return price - s > 3 * atrV ? atrStop : s;
  }
  const s = Math.max(atrStop, levelStop);
  return s - price > 3 * atrV ? atrStop : s;
}

function num(v) { return v === null || v === undefined || !isFinite(v) ? null : +v.toPrecision(8); }
export function fmtNum(v) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const dp = decimalsFor(v);   // same scale as the plan's own rounding (see decimalsFor)
  return Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}

// Long-only backtest of the same scoring rules (spot trading style).
/**
 * Replay this engine's own entries over past candles.
 *
 * The stop and target default to the MEASURED geometry for the timeframe, not
 * to a fixed 1.5 ATR / 2.5R. They were fixed before, which meant the coin page
 * backtested a different trade from the one it was printing directly above —
 * "here is your plan" said 1 ATR and 3R, while "here is how it performed" tested
 * 1.5 ATR and 2.5R.
 *
 * The break-even move is off by default for the same reason: measured over the
 * grid in tools/evaluate-autotrader.mjs it cost money on every timeframe, and
 * showing a result that depends on it would overstate what the published plan
 * does. Pass breakEvenAtR to put it back for comparison.
 */
export function backtest(candles, { interval = null, entryScore = THRESHOLDS.normal, exitScore = -THRESHOLDS.normal, atrStop = null, rMultiple = null, feePct = 0.1, breakEvenAtR = null } = {}) {
  const geo = interval ? geometryFor(interval) : null;
  atrStop = atrStop ?? geo?.stopAtr ?? 1.5;
  rMultiple = rMultiple ?? geo?.rr ?? 2.5;
  const n = candles.length;
  if (n < 80) return { ok: false, reason: 'Not enough history to backtest' };
  const ind = computeAll(candles);
  const start = n >= 260 ? 200 : 50;
  const fee = feePct / 100;
  const trades = [];
  let pos = null;
  let equity = 1, peak = 1, maxDD = 0;
  const curve = [];
  for (let i = start; i < n; i++) {
    const c = candles[i];
    if (pos) {
      let exit = null, why = '';
      if (c.l <= pos.stop) { exit = Math.min(pos.stop, c.o); why = pos.stop >= pos.entry ? 'breakeven' : 'stop'; }
      else if (c.h >= pos.target) { exit = Math.max(pos.target, c.o); why = 'target'; }
      else {
        const { score } = scoreAt(candles, ind, i);
        pos.weak = score <= exitScore ? pos.weak + 1 : 0;
        if (pos.weak >= 2) { exit = c.c; why = 'signal'; } // bearish signal confirmed on 2 closes
        else if (breakEvenAtR !== null && breakEvenAtR !== undefined && c.c >= pos.entry + breakEvenAtR * pos.risk) pos.stop = Math.max(pos.stop, pos.entry);
      }
      if (exit !== null) {
        const ret = (exit / pos.entry) * (1 - fee) * (1 - fee) - 1;
        equity *= 1 + ret;
        trades.push({ entryTime: pos.t, exitTime: c.t, entryIndex: pos.i, exitIndex: i, entry: pos.entry, exit, returnPct: +(ret * 100).toFixed(2), reason: why });
        pos = null;
      }
    } else {
      const a = ind.atr[i];
      if (a) {
        const { score } = scoreAt(candles, ind, i);
        if (score >= entryScore) {
          pos = { entry: c.c, stop: c.c - atrStop * a, risk: atrStop * a, target: c.c + atrStop * a * rMultiple, t: c.t, i, weak: 0 };
        }
      }
    }
    const mark = pos ? equity * (c.c / pos.entry) : equity;
    peak = Math.max(peak, mark);
    maxDD = Math.max(maxDD, (peak - mark) / peak);
    curve.push({ t: c.t, v: mark });
  }
  const openTrade = pos ? { entryTime: pos.t, entryIndex: pos.i, entry: pos.entry, stop: pos.stop, target: pos.target, unrealizedPct: +((candles[n - 1].c / pos.entry - 1) * 100).toFixed(2) } : null;
  const wins = trades.filter((t) => t.returnPct > 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = trades.filter((t) => t.returnPct <= 0).reduce((s, t) => s - t.returnPct, 0);
  return {
    ok: true,
    bars: n - start,
    from: candles[start].t,
    to: candles[n - 1].t,
    trades,
    openTrade,
    tradeCount: trades.length,
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    totalReturnPct: +((equity - 1) * 100).toFixed(2),
    buyHoldPct: +((candles[n - 1].c / candles[start].c - 1) * 100).toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : trades.length ? null : null,
    avgTradePct: trades.length ? +(trades.reduce((s, t) => s + t.returnPct, 0) / trades.length).toFixed(2) : null,
    curve,
  };
}

// Combine several timeframes into one confluence view.
export function confluence(signalsByInterval) {
  const weights = { '15m': 0.5, '1h': 1, '4h': 1.5, '1d': 2, '1w': 2 };
  let sum = 0, wsum = 0;
  for (const [iv, s] of Object.entries(signalsByInterval)) {
    if (!s?.ok) continue;
    const w = weights[iv] ?? 1;
    sum += s.score * w; wsum += w;
  }
  if (!wsum) return null;
  const score = Math.round(sum / wsum);
  return { score, ...labelFor(score) };
}

// Advice for a coin the user already holds.
export function adviseHolding({ signal, avgBuyPrice, price }) {
  if (!signal?.ok) return { text: 'Not enough data', tone: 'flat' };
  const pnl = avgBuyPrice ? (price / avgBuyPrice - 1) * 100 : null;
  const rsiV = signal.indicators.rsi;
  if (signal.score <= -THRESHOLDS.strong) return { text: 'Strong fall so far — check that your stop-loss is where you want it', tone: 'down' };
  if (signal.score <= -THRESHOLDS.normal) {
    return { text: pnl !== null && pnl > 0 ? 'Falling — you are in profit, so decide whether to lock some in' : 'Falling — check your stop-loss', tone: 'down' };
  }
  if (rsiV !== null && rsiV > 75 && pnl !== null && pnl > 15) return { text: 'Overbought while in profit — consider taking partial profit', tone: 'warn' };
  if (signal.score >= THRESHOLDS.normal) return { text: 'Rising — a stop below support protects the gain if it turns', tone: 'up' };
  return { text: 'No clear trend — watch the key levels', tone: 'flat' };
}
