// Signal engine (server copy of js/lib/signals.js without the backtest helpers).
// Rule-based technical signals, not financial advice.

import { computeAll, supportResistance, last } from './indicators.js';

export const THRESHOLDS = { strong: 45, normal: 18 };

export function labelFor(score) {
  if (score >= THRESHOLDS.strong) return { action: 'STRONG_BUY', text: 'Strong Buy', tone: 'up' };
  if (score >= THRESHOLDS.normal) return { action: 'BUY', text: 'Buy', tone: 'up' };
  if (score <= -THRESHOLDS.strong) return { action: 'STRONG_SELL', text: 'Strong Sell', tone: 'down' };
  if (score <= -THRESHOLDS.normal) return { action: 'SELL', text: 'Sell', tone: 'down' };
  return { action: 'NEUTRAL', text: 'Neutral', tone: 'flat' };
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
    if (r < 25) { pts = 1.5; label = `RSI ${r.toFixed(0)} — deeply oversold, bounce likely`; }
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

function round(v, price) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const dp = price >= 1000 ? 2 : price >= 1 ? 4 : price >= 0.01 ? 6 : 8;
  return Number(v.toFixed(dp));
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

  let plan = null;
  if (score >= THRESHOLDS.normal) {
    let stop = entryStop(price - 1.5 * atrV, s1 !== null ? s1 - 0.25 * atrV : null, 'long', price, atrV);
    const risk = price - stop;
    const tp3Candidate = sr.resistances.find((l) => l.price > price + 2.5 * risk)?.price;
    plan = {
      side: 'long',
      title: 'Long / buy setup',
      entry: round(price, price),
      entryZone: [round(Math.max(price - 0.5 * atrV, s1 ?? -Infinity), price), round(price, price)],
      stopLoss: round(stop, price),
      takeProfits: [price + 1.5 * risk, price + 2.5 * risk, tp3Candidate ?? price + 4 * risk].map((v) => round(v, price)),
      riskPct: +((risk / price) * 100).toFixed(2),
      rewardRisk: 2.5,
      exitRules: [
        `Exit if price closes below the stop (${fmtNum(stop)})`,
        `Take partial profit at TP1 and move stop to entry`,
        ind.ema50[i] !== null ? `Trend exit: a close below the 50 EMA (${fmtNum(ind.ema50[i])})` : null,
        'Exit or tighten stop if RSI goes above 75 and momentum fades',
      ].filter(Boolean),
    };
  } else if (score <= -THRESHOLDS.normal) {
    let stop = entryStop(price + 1.5 * atrV, r1 !== null ? r1 + 0.25 * atrV : null, 'short', price, atrV);
    const risk = stop - price;
    const tp3Candidate = sr.supports.find((l) => l.price < price - 2.5 * risk)?.price;
    plan = {
      side: 'short',
      title: 'Exit longs / short setup',
      entry: round(price, price),
      entryZone: [round(price, price), round(Math.min(price + 0.5 * atrV, r1 ?? Infinity), price)],
      stopLoss: round(stop, price),
      takeProfits: [price - 1.5 * risk, price - 2.5 * risk, tp3Candidate ?? price - 4 * risk].map((v) => round(Math.max(v, 0), price)),
      riskPct: +((risk / price) * 100).toFixed(2),
      rewardRisk: 2.5,
      exitRules: [
        'Spot holders: consider closing or reducing the position',
        `Short invalidated on a close above ${fmtNum(stop)}`,
        ind.ema50[i] !== null ? `Bearish bias ends on a close back above the 50 EMA (${fmtNum(ind.ema50[i])})` : null,
      ].filter(Boolean),
    };
  }

  const waitFor = [];
  if (!plan) {
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
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}
