// Technical indicators. Pure functions, no dependencies.
// Shared by the server (scanner, rule-based analyst) and the browser (charts, signals).
// Candle shape used everywhere: { t: openTimeMs, o, h, l, c, v }
// Every series function returns an array the same length as its input, with
// `null` where there is not yet enough data.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// EMA over a series that begins with nulls (e.g. the MACD line).
function emaSparse(values, period) {
  const start = values.findIndex((v) => v !== null);
  const out = new Array(values.length).fill(null);
  if (start < 0) return out;
  const tail = ema(values.slice(start), period);
  for (let i = 0; i < tail.length; i++) out[start + i] = tail[i];
  return out;
}

// Wilder's RSI
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null));
  const sig = emaSparse(line, signal);
  const hist = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function trueRanges(candles) {
  return candles.map((c, i) =>
    i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))
  );
}

// Wilder smoothing
function wilder(values, period, startIndex = 0) {
  const out = new Array(values.length).fill(null);
  if (values.length - startIndex < period) return out;
  let acc = 0;
  for (let i = startIndex; i < startIndex + period; i++) acc += values[i];
  let prev = acc / period;
  out[startIndex + period - 1] = prev;
  for (let i = startIndex + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function atr(candles, period = 14) {
  return wilder(trueRanges(candles), period);
}

export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRanges(candles);
  const trS = wilder(tr, period, 1);
  const pS = wilder(plusDM, period, 1);
  const mS = wilder(minusDM, period, 1);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(0);
  let firstDx = -1;
  for (let i = 0; i < n; i++) {
    if (trS[i] === null || trS[i] === 0) continue;
    plusDI[i] = (100 * pS[i]) / trS[i];
    minusDI[i] = (100 * mS[i]) / trS[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
    if (firstDx < 0) firstDx = i;
  }
  const adxLine = firstDx < 0 ? new Array(n).fill(null) : wilder(dx, period, firstDx);
  return { adx: adxLine, plusDI, minusDI };
}

export function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const r = rsi(closes, rsiPeriod);
  const raw = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < rsiPeriod + stochPeriod - 1) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) { lo = Math.min(lo, r[j]); hi = Math.max(hi, r[j]); }
    raw[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const k = smaSparse(raw, kSmooth);
  const d = smaSparse(k, dSmooth);
  return { k, d };
}

function smaSparse(values, period) {
  const start = values.findIndex((v) => v !== null);
  const out = new Array(values.length).fill(null);
  if (start < 0) return out;
  const tail = sma(values.slice(start), period);
  for (let i = 0; i < tail.length; i++) out[start + i] = tail[i];
  return out;
}

export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    out[i] = out[i - 1] + (d > 0 ? candles[i].v : d < 0 ? -candles[i].v : 0);
  }
  return out;
}

// Swing highs/lows (fractal pivots) → clustered support / resistance levels.
export function supportResistance(candles, { lookback = 5, maxLevels = 4 } = {}) {
  const n = candles.length;
  if (n < lookback * 2 + 1) return { supports: [], resistances: [] };
  const price = candles[n - 1].c;
  const pivots = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) pivots.push({ price: candles[i].h, i });
    if (isLow) pivots.push({ price: candles[i].l, i });
  }
  // cluster pivots within 0.6 ATR-ish (0.8% of price) of each other
  const tol = price * 0.008;
  pivots.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of pivots) {
    const last = clusters[clusters.length - 1];
    if (last && p.price - last.max <= tol) {
      last.sum += p.price; last.count++; last.max = p.price; last.lastIndex = Math.max(last.lastIndex, p.i);
    } else {
      clusters.push({ sum: p.price, count: 1, max: p.price, lastIndex: p.i });
    }
  }
  const levels = clusters.map((c) => ({ price: c.sum / c.count, touches: c.count, recency: c.lastIndex / n }));
  const score = (l) => l.touches + l.recency;
  const supports = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 8)
    .sort((a, b) => score(b) - score(a)).slice(0, maxLevels).sort((a, b) => b.price - a.price);
  const resistances = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 8)
    .sort((a, b) => score(b) - score(a)).slice(0, maxLevels).sort((a, b) => a.price - b.price);
  return { supports, resistances };
}

export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}

// Compute the full indicator bundle once for a candle array.
export function computeAll(candles) {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes, 20, 2),
    atr: atr(candles, 14),
    adx: adx(candles, 14),
    stoch: stochRsi(closes),
    volSma: sma(vols, 20),
  };
}
