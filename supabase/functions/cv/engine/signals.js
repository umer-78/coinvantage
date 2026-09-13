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
 * entering at every bar. A negative number means the geometry itself loses —
 * the UI says so rather than printing levels that quietly cost money.
 */
export const TRADE_GEOMETRY = {
  '15m': { stopAtr: 1, rr: 1, ev: -0.009, tested: true },
  '1h':  { stopAtr: 1, rr: 3, ev: +0.055, tested: true },
  '4h':  { stopAtr: 1, rr: 1, ev: -0.047, tested: true },
  '1d':  { stopAtr: 1, rr: 2, ev: +0.058, tested: true },
};
/**
 * Where the score has actually worked — measured, not assumed.
 *
 * `tools/evaluate-signal-edge.mjs` replays every bar across 12 coins, computes
 * the score the site would have shown, and scores the trade that followed. The
 * result is uncomfortable and worth stating plainly: **a higher score does not
 * reliably mean a better trade.** The relationship is not a gradient. On the 4h
 * chart a score of 60+ performed WORSE than the average bar (45.5% vs 47.6%),
 * and on the 1h chart the 60+ bucket was worse than the 45-59 one.
 *
 * Two bands did show a real, repeated edge on a large enough sample, and only
 * those two are marked. Everything else is presented as no measured edge, which
 * is the honest description of a flat lift.
 *
 * A band qualifies only at n >= 300 and lift >= 1.10 over that timeframe's own
 * base rate — small buckets that look spectacular (15m 60+ hit 60.6%, but on 99
 * samples) are deliberately excluded.
 */
export const SIGNAL_EDGE = {
  '1h': { lo: 45, hi: 59, hitRate: 35.4, baseRate: 27.5, ev: 0.415, baseEv: 0.097, samples: 486, lift: 1.29 },
  '4h': { lo: 18, hi: 29, hitRate: 52.6, baseRate: 47.6, ev: 0.049, baseEv: -0.050, samples: 498, lift: 1.10 },
};

/** The measured band for this timeframe, and whether the score sits inside it. */
export function edgeBand(interval, score) {
  const band = SIGNAL_EDGE[interval];
  if (!band) return { band: null, inside: false };
  return { band, inside: score >= band.lo && score <= band.hi };
}

const DEFAULT_GEOMETRY = { stopAtr: 1.5, rr: 2.5, ev: null, tested: false };
export const geometryFor = (interval) => TRADE_GEOMETRY[interval] || DEFAULT_GEOMETRY;

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
      takeProfits: [price - geo.rr * 0.6 * risk, price - geo.rr * risk, tp3Candidate ?? price - geo.rr * 1.6 * risk].map((v) => round(Math.max(v, 0), price)),
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

// Long-only backtest of the same scoring rules (spot trading style).
export function backtest(candles, { entryScore = THRESHOLDS.normal, exitScore = -THRESHOLDS.normal, atrStop = 1.5, rMultiple = 2.5, feePct = 0.1 } = {}) {
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
        else if (c.c >= pos.entry + pos.risk) pos.stop = Math.max(pos.stop, pos.entry); // +1R → stop to breakeven
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
  if (signal.score <= -THRESHOLDS.strong) return { text: 'Strong sell signal — consider exiting or tightening your stop', tone: 'down' };
  if (signal.score <= -THRESHOLDS.normal) {
    return { text: pnl !== null && pnl > 0 ? 'Trend weakening — consider locking in profit' : 'Bearish — review your stop-loss', tone: 'down' };
  }
  if (rsiV !== null && rsiV > 75 && pnl !== null && pnl > 15) return { text: 'Overbought while in profit — consider taking partial profit', tone: 'warn' };
  if (signal.score >= THRESHOLDS.normal) return { text: 'Bullish — hold; trail stop below support', tone: 'up' };
  return { text: 'Neutral — hold and watch key levels', tone: 'flat' };
}
