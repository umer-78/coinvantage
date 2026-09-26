// CoinVantage AI forecast engine — runs entirely in the browser, no API.
//
// It combines seven independent forecasters (see MODEL_INFO) and weights them
// by how accurate
// each one was on recent data it was NOT trained on (walk-forward validation):
//   1. Pattern matching  – finds past chart shapes most similar to today's and
//                          looks at what price did next (historical analogs)
//   2. Neural network    – small MLP trained on 23 technical features
//   3. Logistic model    – regularised logistic regression on the same features
//   4. Nearest neighbours– most similar past market states (feature space)
//   5. Trend model       – Holt double-exponential smoothing with volatility cone
//   6. Boosted trees     – gradient-boosted decision trees on the same features
//   7. Similar moves     – how moves like the latest one played out on this coin
//
// Crypto prices are noisy; the engine reports its measured accuracy so users
// can judge how much to trust a forecast. Not financial advice.

import { computeAll } from './indicators.js';
import { pooledProb } from './pooled.js';
import { tripleBarrier } from './barrier.js';

// ---------------------------------------------------------------- helpers
const clip = (v, lo = -5, hi = 5) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const sigmoid = (z) => 1 / (1 + Math.exp(-clip(z, -30, 30)));
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function weightedMedian(values, weights) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  for (const i of idx) { acc += weights[i]; if (acc >= total / 2) return values[i]; }
  return values[idx[idx.length - 1]] ?? 0;
}

// ---------------------------------------------------------------- features
export const FEATURE_NAMES = [
  'Return 1 bar', 'Return 3 bars', 'Return 6 bars', 'Return 12 bars', 'Return 24 bars',
  'RSI', 'MACD histogram', 'MACD line', 'Bollinger %B', 'Bollinger width',
  'Distance to EMA20', 'Distance to EMA50', 'Distance to EMA200', 'EMA20 slope',
  'Volume vs average', 'ADX', 'DI spread', 'Stoch RSI', 'Volatility regime',
  'Candle body', 'Upper wick', 'Lower wick', 'Position in 50-bar range',
];

export function buildFeatures(candles, ind = computeAll(candles)) {
  const n = candles.length;
  const X = new Array(n).fill(null);
  const closes = candles.map((c) => c.c);
  const atrPctArr = candles.map((c, i) => (ind.atr[i] ? ind.atr[i] / c.c : null));
  for (let i = 60; i < n; i++) {
    const c = candles[i];
    const atr = ind.atr[i];
    if (!atr || ind.rsi[i] === null || ind.macd.hist[i] === null || ind.bb.upper[i] === null || ind.ema50[i] === null) continue;
    const ap = atr / c.c;
    const ret = (k) => Math.log(c.c / closes[i - k]) / (ap * Math.sqrt(k));
    let apSum = 0, apN = 0;
    for (let j = Math.max(0, i - 100); j <= i; j++) if (atrPctArr[j]) { apSum += atrPctArr[j]; apN++; }
    let lo = Infinity, hi = -Infinity;
    for (let j = i - 49; j <= i; j++) { lo = Math.min(lo, candles[j].l); hi = Math.max(hi, candles[j].h); }
    const bbw = ind.bb.upper[i] - ind.bb.lower[i];
    const f = [
      ret(1), ret(3), ret(6), ret(12), ret(24),
      (ind.rsi[i] - 50) / 25,
      ind.macd.hist[i] / atr,
      ind.macd.line[i] / atr / 3,
      bbw > 0 ? (c.c - ind.bb.lower[i]) / bbw - 0.5 : 0,
      bbw / c.c / ap / 4 - 1,
      (c.c - ind.ema20[i]) / atr / 2,
      (c.c - ind.ema50[i]) / atr / 4,
      ind.ema200[i] !== null ? (c.c - ind.ema200[i]) / atr / 10 : 0,
      ind.ema20[i - 5] !== null ? (ind.ema20[i] - ind.ema20[i - 5]) / atr : 0,
      ind.volSma[i] ? Math.log((c.v + 1e-12) / ind.volSma[i] + 1e-6) : 0,
      ind.adx.adx[i] !== null ? ind.adx.adx[i] / 50 - 0.5 : 0,
      ind.adx.plusDI[i] !== null ? (ind.adx.plusDI[i] - ind.adx.minusDI[i]) / 50 : 0,
      ind.stoch.k[i] !== null ? ind.stoch.k[i] / 50 - 1 : 0,
      apN ? ap / (apSum / apN) - 1 : 0,
      (c.c - c.o) / atr,
      (c.h - Math.max(c.o, c.c)) / atr,
      (Math.min(c.o, c.c) - c.l) / atr,
      hi > lo ? (c.c - lo) / (hi - lo) - 0.5 : 0,
    ];
    X[i] = Float64Array.from(f, (v) => clip(v));
  }
  return X;
}

function standardizer(rows) {
  const d = rows[0].length;
  const mu = new Float64Array(d), sd = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) mu[j] += r[j];
  for (let j = 0; j < d; j++) mu[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[j] - mu[j]) ** 2;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j] / rows.length) || 1;
  return (r) => Float64Array.from(r, (v, j) => clip((v - mu[j]) / sd[j], -6, 6));
}

// ---------------------------------------------------------------- models
function trainLogistic(X, y, { iters = 250, lr = 0.05, l2 = 2e-3 } = {}) {
  const n = X.length, d = X[0].length;
  const w = new Float64Array(d); let b = 0;
  const m = new Float64Array(d + 1), v = new Float64Array(d + 1);
  const g = new Float64Array(d + 1);
  for (let t = 1; t <= iters; t++) {
    g.fill(0);
    for (let i = 0; i < n; i++) {
      let z = b; const xi = X[i];
      for (let j = 0; j < d; j++) z += w[j] * xi[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) g[j] += err * xi[j];
      g[d] += err;
    }
    for (let j = 0; j <= d; j++) {
      const grad = g[j] / n + (j < d ? l2 * w[j] : 0);
      m[j] = 0.9 * m[j] + 0.1 * grad; v[j] = 0.999 * v[j] + 0.001 * grad * grad;
      const step = (lr * (m[j] / (1 - 0.9 ** t))) / (Math.sqrt(v[j] / (1 - 0.999 ** t)) + 1e-8);
      if (j < d) w[j] -= step; else b -= step;
    }
  }
  const predict = (x) => { let z = b; for (let j = 0; j < d; j++) z += w[j] * x[j]; return sigmoid(z); };
  return { predict, weights: w };
}

function trainMlp(X, y, { hidden = 16, epochs = 35, lr = 0.004, l2 = 3e-4, batch = 64, seed = 7 } = {}) {
  const n = X.length, d = X[0].length, H = hidden;
  const rnd = mulberry32(seed);
  const W1 = new Float64Array(H * d).map(() => (rnd() * 2 - 1) * Math.sqrt(6 / (d + H)));
  const b1 = new Float64Array(H);
  const W2 = new Float64Array(H).map(() => (rnd() * 2 - 1) * Math.sqrt(6 / (H + 1)));
  let b2 = 0;
  const P = [W1, b1, W2];
  const M = P.map((p) => new Float64Array(p.length)), V = P.map((p) => new Float64Array(p.length));
  let mb2 = 0, vb2 = 0, step = 0;
  const gW1 = new Float64Array(H * d), gb1 = new Float64Array(H), gW2 = new Float64Array(H);
  const hAct = new Float64Array(H);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let s = 0; s < n; s += batch) {
      gW1.fill(0); gb1.fill(0); gW2.fill(0); let gb2 = 0;
      const end = Math.min(n, s + batch), bs = end - s;
      for (let k = s; k < end; k++) {
        const x = X[order[k]];
        let z2 = b2;
        for (let h = 0; h < H; h++) {
          let z = b1[h]; const off = h * d;
          for (let j = 0; j < d; j++) z += W1[off + j] * x[j];
          hAct[h] = Math.tanh(z); z2 += W2[h] * hAct[h];
        }
        const err = sigmoid(z2) - y[order[k]];
        gb2 += err;
        for (let h = 0; h < H; h++) {
          gW2[h] += err * hAct[h];
          const dh = err * W2[h] * (1 - hAct[h] * hAct[h]);
          gb1[h] += dh; const off = h * d;
          for (let j = 0; j < d; j++) gW1[off + j] += dh * x[j];
        }
      }
      step++;
      const bc1 = 1 - 0.9 ** step, bc2 = 1 - 0.999 ** step;
      const upd = (p, gArr, mArr, vArr, reg) => {
        for (let j = 0; j < p.length; j++) {
          const grad = gArr[j] / bs + (reg ? l2 * p[j] : 0);
          mArr[j] = 0.9 * mArr[j] + 0.1 * grad; vArr[j] = 0.999 * vArr[j] + 0.001 * grad * grad;
          p[j] -= (lr * (mArr[j] / bc1)) / (Math.sqrt(vArr[j] / bc2) + 1e-8);
        }
      };
      upd(W1, gW1, M[0], V[0], true); upd(b1, gb1, M[1], V[1], false); upd(W2, gW2, M[2], V[2], true);
      const g2 = gb2 / bs; mb2 = 0.9 * mb2 + 0.1 * g2; vb2 = 0.999 * vb2 + 0.001 * g2 * g2;
      b2 -= (lr * (mb2 / bc1)) / (Math.sqrt(vb2 / bc2) + 1e-8);
    }
  }
  const predict = (x) => {
    let z2 = b2;
    for (let h = 0; h < H; h++) {
      let z = b1[h]; const off = h * d;
      for (let j = 0; j < d; j++) z += W1[off + j] * x[j];
      z2 += W2[h] * Math.tanh(z);
    }
    return sigmoid(z2);
  };
  return { predict };
}

// Gradient-boosted decision trees (logistic loss, histogram splits).
function trainGbdt(X, y, { rounds = 70, depth = 3, lr = 0.08, bins = 16, minLeaf = 25, lambda = 1, subsample = 0.8, colsample = 0.8, seed = 3 } = {}) {
  const n = X.length, d = X[0].length;
  const rnd = mulberry32(seed);
  // quantile cut points per feature
  const cuts = [];
  const binned = Array.from({ length: d }, () => new Uint8Array(n));
  for (let j = 0; j < d; j++) {
    const col = Float64Array.from(X, (r) => r[j]).sort();
    const cj = [];
    for (let b = 1; b < bins; b++) {
      const v = col[Math.floor((b / bins) * (n - 1))];
      if (!cj.length || v > cj[cj.length - 1]) cj.push(v);
    }
    cuts.push(cj);
    for (let i = 0; i < n; i++) {
      const v = X[i][j];
      let lo = 0, hi = cj.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (v <= cj[mid]) hi = mid; else lo = mid + 1; }
      binned[j][i] = lo;
    }
  }
  const F = new Float64Array(n);
  const trees = [];
  const G = new Float64Array(n), Hs = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); G[i] = p - y[i]; Hs[i] = Math.max(p * (1 - p), 1e-6); }
    const rows = [];
    for (let i = 0; i < n; i++) if (rnd() < subsample) rows.push(i);
    const feats = [];
    for (let j = 0; j < d; j++) if (rnd() < colsample) feats.push(j);
    const build = (idx, level) => {
      let gs = 0, hs = 0;
      for (const i of idx) { gs += G[i]; hs += Hs[i]; }
      const leaf = { v: (-gs / (hs + lambda)) * lr };
      if (level >= depth || idx.length < 2 * minLeaf) return leaf;
      const parent = (gs * gs) / (hs + lambda);
      let best = null;
      const hg = new Float64Array(bins), hh = new Float64Array(bins), hc = new Uint32Array(bins);
      for (const j of feats) {
        hg.fill(0); hh.fill(0); hc.fill(0);
        const bj = binned[j];
        for (const i of idx) { const b = bj[i]; hg[b] += G[i]; hh[b] += Hs[i]; hc[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < cuts[j].length; b++) {
          gl += hg[b]; hl += hh[b]; cl += hc[b];
          const cr = idx.length - cl;
          if (cl < minLeaf || cr < minLeaf) continue;
          const gr = gs - gl, hr = hs - hl;
          const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parent;
          if (!best || gain > best.gain) best = { gain, j, b };
        }
      }
      if (!best || best.gain <= 1e-6) return leaf;
      const L = [], R = [];
      const bj = binned[best.j];
      for (const i of idx) (bj[i] <= best.b ? L : R).push(i);
      return { j: best.j, t: cuts[best.j][best.b], l: build(L, level + 1), r: build(R, level + 1) };
    };
    const tree = build(rows, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) {
      let node = tree;
      while (node.v === undefined) node = X[i][node.j] <= node.t ? node.l : node.r;
      F[i] += node.v;
    }
  }
  const predict = (x) => {
    let f = 0;
    for (const tree of trees) { let node = tree; while (node.v === undefined) node = x[node.j] <= node.t ? node.l : node.r; f += node.v; }
    return sigmoid(f);
  };
  return { predict };
}

function knnModel(X, y, ret, k) {
  const norms = X.map((r) => Math.sqrt(r.reduce((s, v) => s + v * v, 0)) || 1);
  return (x) => {
    const nx = Math.sqrt(x.reduce((s, v) => s + v * v, 0)) || 1;
    const sims = new Float64Array(X.length);
    for (let i = 0; i < X.length; i++) {
      let dot = 0; const r = X[i];
      for (let j = 0; j < x.length; j++) dot += r[j] * x[j];
      sims[i] = dot / (norms[i] * nx);
    }
    const idx = Array.from(sims.keys()).sort((a, b) => sims[b] - sims[a]).slice(0, k);
    let up = 0, wsum = 0, r = 0;
    for (const i of idx) { const w = Math.max(0.05, sims[i] + 1); up += w * y[i]; r += w * ret[i]; wsum += w; }
    return { prob: (up + 1) / (wsum + 2), expRet: r / wsum };
  };
}

// Holt linear trend on log prices, evaluated for every bar in one pass.
function holtSeries(closes, alpha = 0.25, beta = 0.04) {
  const n = closes.length;
  const level = new Float64Array(n), trend = new Float64Array(n);
  level[0] = Math.log(closes[0]);
  for (let i = 1; i < n; i++) {
    const x = Math.log(closes[i]);
    level[i] = alpha * x + (1 - alpha) * (level[i - 1] + trend[i - 1]);
    trend[i] = beta * (level[i] - level[i - 1]) + (1 - beta) * trend[i - 1];
  }
  return { level, trend };
}

function rollingSigma(closes, i, lookback = 100) {
  let s = 0, s2 = 0, m = 0;
  for (let j = Math.max(1, i - lookback + 1); j <= i; j++) { const r = Math.log(closes[j] / closes[j - 1]); s += r; s2 += r * r; m++; }
  if (m < 2) return 0.02;
  const mu = s / m;
  return Math.sqrt(Math.max(s2 / m - mu * mu, 1e-10));
}

/**
 * Quantiles of the coin's past H-bar log returns in units of σ√H (σ = the
 * 100-bar volatility at the start of each move), centred on their median.
 * Uses only candles before `last`, so a forecast never sees its own outcome.
 */
function empiricalBandQuantiles(closes, last, H) {
  const zs = [];
  for (let j = 101; j <= last - H; j++) {
    const s = rollingSigma(closes, j) * Math.sqrt(H);
    if (s > 0) zs.push(Math.log(closes[j + H] / closes[j]) / s);
  }
  if (zs.length < 60) return null;
  zs.sort((a, b) => a - b);
  const q = (p) => { const k = (zs.length - 1) * p, lo = Math.floor(k); return zs[lo] + (zs[Math.min(lo + 1, zs.length - 1)] - zs[lo]) * (k - lo); };
  const med = q(0.5);
  return { q05: q(0.05) - med, q10: q(0.1) - med, q25: q(0.25) - med, q75: q(0.75) - med, q90: q(0.9) - med, q95: q(0.95) - med };
}

// ---------------------------------------------------------------- pattern matching
function znorm(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length) || 1;
  return arr.map((v) => (v - m) / sd);
}

// Prefix sums of log prices, cached per candle array, for O(W) correlation per window.
const prefixCache = new WeakMap();
function prefixes(candles) {
  let p = prefixCache.get(candles);
  if (p) return p;
  const n = candles.length;
  const logs = new Float64Array(n), s1 = new Float64Array(n + 1), s2 = new Float64Array(n + 1);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = candles[i].c; logs[i] = Math.log(candles[i].c);
    s1[i + 1] = s1[i] + logs[i]; s2[i + 1] = s2[i] + logs[i] * logs[i];
  }
  p = { logs, s1, s2, raw };
  prefixCache.set(candles, p);
  return p;
}

// Find past windows whose shape matches the window ending at `endIdx`,
// using only data available up to `endIdx` (so it can be validated honestly).
export function findPatterns(candles, endIdx, { window = 32, horizon = 12, topK = 8, minCorr = 0.6 } = {}) {
  const W = window, H = horizon;
  if (endIdx - W < W + H + 10) return { matches: [] };
  const { logs, s1, s2, raw } = prefixes(candles);
  const cur = znorm(Array.from(logs.subarray(endIdx - W + 1, endIdx + 1)));
  const curVol = rollingSigma(raw, endIdx, W);
  const cands = [];
  const lastStart = endIdx - W - H; // the match AND its future must be fully in the past
  for (let s = 0; s <= lastStart; s++) {
    const mean = (s1[s + W] - s1[s]) / W;
    const varc = (s2[s + W] - s2[s]) / W - mean * mean;
    if (varc <= 1e-14) continue;
    let dot = 0;
    for (let j = 0; j < W; j++) dot += logs[s + j] * cur[j]; // cur has zero mean, so the window mean cancels
    const corr = dot / (W * Math.sqrt(varc));
    if (corr >= minCorr) cands.push({ s, corr });
  }
  cands.sort((a, b) => b.corr - a.corr);
  const picked = [];
  for (const c of cands) {
    if (picked.every((p) => Math.abs(p.s - c.s) >= Math.floor(W / 2))) picked.push(c);
    if (picked.length >= topK) break;
  }
  const matches = picked.map(({ s, corr }) => {
    const e = s + W - 1;
    const volRatio = clip(curVol / (rollingSigma(raw, e, W) || curVol), 0.5, 2);
    const future = [];
    for (let h = 1; h <= H; h++) future.push((raw[e + h] / raw[e] - 1) * volRatio);
    const series = [];
    for (let j = s; j <= e + H; j++) series.push((raw[j] / raw[e]) * 100);
    return {
      startIndex: s, endIndex: e,
      startTime: candles[s].t, endTime: candles[e].t,
      similarity: corr,
      futureReturns: future,
      futureReturnPct: future[H - 1] * 100,
      maxUpPct: Math.max(...future) * 100,
      maxDownPct: Math.min(...future) * 100,
      series, // normalised path (window + future) with window end = 100, for overlay charts
    };
  });
  if (!matches.length) return { matches };
  const w = matches.map((m) => m.similarity ** 4);
  const wsum = w.reduce((a, b) => a + b, 0);
  const probUp = (matches.reduce((acc, m, i) => acc + (m.futureReturnPct > 0 ? w[i] : 0), 0) + 0.5) / (wsum + 1);
  const finals = matches.map((m) => m.futureReturns[H - 1]);
  const currentSeries = [];
  for (let j = endIdx - W + 1; j <= endIdx; j++) currentSeries.push((raw[j] / raw[endIdx]) * 100);
  return {
    matches,
    probUp,
    medianReturn: weightedMedian(finals, w),
    currentSeries,
    avgSimilarity: matches.reduce((a, m) => a + m.similarity, 0) / matches.length,
  };
}

// ---------------------------------------------------------------- similar-move statistics
// "When this coin moved this far this fast before, with RSI in this zone, how often did it rise next?"
// Empirical conditional probability from the coin's own history (smoothed toward the base rate).
function moveStatsModel(samples) {
  const zb = (z) => (z < -2 ? 0 : z < -1 ? 1 : z < -0.3 ? 2 : z < 0.3 ? 3 : z < 1 ? 4 : z < 2 ? 5 : 6);
  const rb = (r) => (r < 30 ? 0 : r < 45 ? 1 : r < 55 ? 2 : r < 70 ? 3 : 4);
  const cell = new Map(), zc = new Map();
  let ups = 0;
  for (const s of samples) {
    const k = zb(s.z) * 5 + rb(s.rsi);
    const a = cell.get(k) || [0, 0]; a[0] += s.up; a[1]++; cell.set(k, a);
    const b = zc.get(zb(s.z)) || [0, 0]; b[0] += s.up; b[1]++; zc.set(zb(s.z), b);
    ups += s.up;
  }
  const base = samples.length ? ups / samples.length : 0.5;
  return (z, rsi) => {
    const b = zc.get(zb(z));
    const pz = b ? (b[0] + 10 * base) / (b[1] + 10) : base;
    const a = cell.get(zb(z) * 5 + rb(rsi));
    return { prob: a ? (a[0] + 20 * pz) / (a[1] + 20) : pz, n: a ? a[1] : b ? b[1] : 0 };
  };
}

// ---------------------------------------------------------------- main
// The models that get a vote. A cross-coin model was built, trained on 25k
// pooled rows per timeframe and measured on the same 672-forecast harness: it
// scored 53.7% against this roster's 54.0%, with a worse Brier score, so it is
// not in the list. tools/train-pooled.mjs and js/lib/pooled.js are kept so the
// experiment can be repeated rather than guessed at — see docs/HANDOVER.md.
export const MODEL_INFO = {
  gbdt: 'Gradient-boosted trees',
  mlp: 'Neural network',
  logistic: 'Logistic regression',
  knn: 'Nearest neighbours',
  moves: 'Similar past moves',
  pattern: 'Chart pattern matching',
  trend: 'Trend model (Holt)',
};

// Candle spacing → the timeframe key the pooled model was trained under.
const INTERVAL_FOR_MS = { 9e5: '15m', 36e5: '1h', 144e5: '4h', 864e5: '1d' };

export function forecast(candles, { horizon = 12, window = 40, fast = false, intervalMs = null, folds = 3, interval = null, labelMode = 'direction', barrierUp = 2, barrierDown = 1 } = {}) {
  const n = candles.length;
  const H = horizon;
  if (n < 200) return { ok: false, reason: 'Need at least 200 candles of history for the AI forecast.' };
  const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
  const stepMs = intervalMs || (n > 1 ? candles[n - 1].t - candles[n - 2].t : null);
  const intervalKey = interval || (stepMs ? INTERVAL_FOR_MS[stepMs] : null);
  const t0 = now();
  const closes = candles.map((c) => c.c);
  const ind = computeAll(candles);
  const feats = buildFeatures(candles, ind);

  const idx = [];
  for (let i = 0; i < n - H; i++) if (feats[i]) idx.push(i);
  if (idx.length < 150) return { ok: false, reason: 'Not enough clean history to train the models.' };
  // What the models are trained to predict.
  //
  // 'direction' is the original question — is the close higher H bars later?
  // It counts a +0.01% drift as a win and ignores the path, which is most of
  // why it scores near a coin flip.
  //
  // 'barrier' asks the question a trade actually turns on: does price reach the
  // profit target before the stop? Bounded, decidable, and the same thing the
  // entry/stop/target plan on the page depends on. Measured separately, because
  // it is a different question and its accuracy is NOT comparable to the other.
  const barrierOpts = { up: barrierUp, down: barrierDown, maxBars: H * 3 };
  const barrierCache = new Map();
  const barrierAt = (i) => {
    if (!barrierCache.has(i)) barrierCache.set(i, tripleBarrier(candles, i, ind.atr[i], barrierOpts));
    return barrierCache.get(i);
  };
  const label = labelMode === 'barrier'
    ? (i) => { const b = barrierAt(i); return b.label === null ? (closes[i + H] > closes[i] ? 1 : 0) : b.label; }
    : (i) => (closes[i + H] > closes[i] ? 1 : 0);
  const fret = (i) => Math.log(closes[i + H] / closes[i]);
  const zAt = (i) => Math.log(closes[i] / closes[Math.max(0, i - H)]) / ((rollingSigma(closes, i, 100) || 1e-9) * Math.sqrt(H));
  const holt = holtSeries(closes);
  const holtProb = (i) => normCdf((holt.trend[i] * H + (holt.level[i] - Math.log(closes[i]))) / ((rollingSigma(closes, i) || 1e-9) * Math.sqrt(H)));
  const patOpts = { window, horizon: H, topK: 12, minCorr: 0.5 };

  // Train every model on the given sample indices; returns predictors taking a bar index.
  const trainAll = (trainIdx, seedBase = 1) => {
    const scale = standardizer(trainIdx.map((i) => feats[i]));
    const X = trainIdx.map((i) => scale(feats[i]));
    const y = trainIdx.map(label);
    const r = trainIdx.map(fret);
    const sigH = (rollingSigma(closes, trainIdx[trainIdx.length - 1], 300) || 0.01) * Math.sqrt(H);
    const keep = r.map((v) => Math.abs(v) > 0.2 * sigH); // drop near-zero moves: they are noise
    const Xf = X.filter((_, k) => keep[k]), yf = y.filter((_, k) => keep[k]);
    const lr = trainLogistic(Xf, yf);
    const gb = trainGbdt(Xf, yf, { rounds: fast ? 40 : 70, seed: seedBase + 3 });
    const knn = knnModel(X, y, r, Math.max(15, Math.round(Math.sqrt(X.length))));
    const mlps = fast ? [] : [trainMlp(Xf, yf, { seed: seedBase + 7, epochs: 25 }), trainMlp(Xf, yf, { seed: seedBase + 29, epochs: 25 })];
    const moves = moveStatsModel(trainIdx.map((i) => ({ z: zAt(i), rsi: ind.rsi[i], up: label(i) })));
    const p = {
      // Available to re-enable by adding `pooled` back to MODEL_INFO; it takes
      // the raw feature row, not the per-coin standardised one, because that is
      // what it was trained on. Measured worse — see the note above.
      pooled: (i) => pooledProb(intervalKey, feats[i]),
      logistic: (i) => lr.predict(scale(feats[i])),
      gbdt: (i) => gb.predict(scale(feats[i])),
      knn: (i) => knn(scale(feats[i])).prob,
      moves: (i) => moves(zAt(i), ind.rsi[i]).prob,
      trend: (i) => holtProb(i),
      pattern: (i) => { const pr = findPatterns(candles, i, patOpts); return pr.matches.length >= 3 ? pr.probUp : 0.5; },
      knnRet: (i) => knn(scale(feats[i])).expRet,
    };
    if (mlps.length) p.mlp = (i) => mlps.reduce((a, m) => a + m.predict(scale(feats[i])), 0) / mlps.length;
    return p;
  };

  // ---- walk-forward validation: K folds over the most recent ~36% of history.
  // Each fold is predicted by models trained only on data that ended H bars before it.
  const valStart = Math.floor(idx.length * 0.64);
  const K = fast ? 1 : folds;
  const foldSize = Math.ceil((idx.length - valStart) / K);
  const keys = Object.keys(MODEL_INFO).filter((k) => !(fast && k === 'mlp'));
  const hits = Object.fromEntries(keys.map((k) => [k, [0, 0]]));
  const valRecords = []; // { i, probs:{} }
  for (let f = 0; f < K; f++) {
    const a = valStart + f * foldSize, b = Math.min(idx.length, a + foldSize);
    if (a >= b) break;
    const firstBar = idx[a];
    const trainIdx = idx.filter((i) => i <= firstBar - H - 1).slice(-3000);
    if (trainIdx.length < 100) continue;
    const P = trainAll(trainIdx, f * 101);
    // non-overlapping test points (every H/2 bars) keep validation fast and honest
    const stride = Math.max(1, Math.floor(H / 2));
    for (let j = a; j < b; j += stride) {
      const i = idx[j];
      const rec = { i, fold: f, probs: {} };
      for (const k of keys) {
        if (k === 'pattern' && ((j - a) / stride) % 2 !== 0) continue; // pattern search on every other point
        const pr = P[k](i);
        // A model with nothing to say (the pooled one has no coefficients for
        // this timeframe, say) must abstain, not vote 0 — counting a null as
        // "down" would both wreck the blend and fake its accuracy.
        if (pr === null || pr === undefined || !Number.isFinite(pr)) continue;
        rec.probs[k] = pr;
        hits[k][1]++; if ((pr >= 0.5 ? 1 : 0) === label(i)) hits[k][0]++;
      }
      valRecords.push(rec);
    }
  }

  const models = keys.map((k) => ({ key: k, name: MODEL_INFO[k], accuracy: hits[k][1] ? hits[k][0] / hits[k][1] : null, samples: hits[k][1] }));

  // Accuracy-proportional weights: the simple blend, and the fallback whenever
  // there is not enough validation data to learn something better.
  const weights = {};
  for (const m of models) {
    const edge = Math.max(0, (m.accuracy ?? 0.5) - 0.5);
    weights[m.key] = edge * Math.sqrt(Math.min(1, m.samples / 120)) + 0.004;
  }
  const simpleBlend = (probs) => {
    let s = 0, w = 0;
    for (const k of keys) {
      const p = probs[k];
      if (p === null || p === undefined || !Number.isFinite(p)) continue;
      s += p * weights[k]; w += weights[k];
    }
    return w ? s / w : 0.5;
  };

  // ---- stacking: learn how to combine the models instead of assuming it.
  //
  // Weighting each model by its own hit rate treats them as independent, which
  // they are not — several read the same trend and vote together, so the blend
  // over-counts one opinion. A logistic regression over the validation records
  // learns what each model is worth *given the others*, including a negative
  // weight for one that is reliably wrong. It is regularised hard (few samples)
  // and every number it is fitted on is out-of-sample: those models were trained
  // on data ending H bars before the point they predicted.
  const featRow = (probs) => {
    const x = keys.map((k) => (probs[k] === undefined || probs[k] === null ? 0 : (probs[k] - 0.5) * 2));
    x.push(1); // intercept
    return x;
  };
  const sigmoid = (z) => 1 / (1 + Math.exp(-clip(z, -30, 30)));

  function fitLogistic(rows, ys, { l2 = 1, iters = 250, lr = 0.6 } = {}) {
    const d = rows[0].length;
    const w = new Array(d).fill(0);
    for (let it = 0; it < iters; it++) {
      const g = new Array(d).fill(0);
      for (let r = 0; r < rows.length; r++) {
        const x = rows[r];
        let z = 0;
        for (let j = 0; j < d; j++) z += w[j] * x[j];
        const err = sigmoid(z) - ys[r];
        for (let j = 0; j < d; j++) g[j] += err * x[j];
      }
      // L2 on the slopes only — shrinking the intercept would fight the base rate
      for (let j = 0; j < d - 1; j++) g[j] += l2 * w[j];
      for (let j = 0; j < d; j++) w[j] -= (lr / rows.length) * g[j];
    }
    return w;
  }

  const applyW = (w, probs) => {
    const x = featRow(probs);
    let z = 0;
    for (let j = 0; j < x.length; j++) z += w[j] * x[j];
    return sigmoid(z);
  };

  // Enough records, and more than one fold, or there is nothing honest to fit on.
  const foldsSeen = new Set(valRecords.map((r) => r.fold));
  const canStack = valRecords.length >= 60 && foldsSeen.size >= 2;
  const l2 = Math.max(0.5, keys.length * 2);

  // Out-of-fold stacker predictions: each record scored by a model that never
  // saw its fold. This is what the published accuracy is measured on.
  const stackedOof = new Map();
  if (canStack) {
    for (const f of foldsSeen) {
      const tr = valRecords.filter((r) => r.fold !== f);
      if (tr.length < 40) continue;
      const w = fitLogistic(tr.map((r) => featRow(r.probs)), tr.map((r) => label(r.i)), { l2 });
      for (const r of valRecords) if (r.fold === f) stackedOof.set(r, applyW(w, r.probs));
    }
  }
  const usedStacking = canStack && stackedOof.size >= valRecords.length * 0.5;

  // Does stacking actually beat the simple blend here? If not, keep the simple
  // one — a fancier model that tests worse is not an improvement.
  const scoreOf = (get) => {
    let hit = 0, tot = 0;
    for (const r of valRecords) {
      const p = get(r);
      if (p === undefined) continue;
      tot++; if ((p >= 0.5 ? 1 : 0) === label(r.i)) hit++;
    }
    return tot ? hit / tot : 0;
  };
  const stackScore = usedStacking ? scoreOf((r) => stackedOof.get(r)) : 0;
  const simpleScore = scoreOf((r) => simpleBlend(r.probs));
  // Measured on 672 walk-forward forecasts across 12 coins and 4 timeframes,
  // a loose gate here made the engine WORSE: 51.6% against the simple blend's
  // 54.0%, because with a hundred-odd validation points the regression fits
  // noise between correlated models and the fold estimate is too shaky to catch
  // it. So the bar is deliberately high: a lot of evidence and a clear margin,
  // or the blend that is known to work stays in charge.
  const stacking = usedStacking && valRecords.length >= 200 && stackScore >= simpleScore + 0.03;

  // Final combiner, fitted on every validation record, for the live prediction.
  const stackW = stacking
    ? fitLogistic(valRecords.map((r) => featRow(r.probs)), valRecords.map((r) => label(r.i)), { l2 })
    : null;

  // ---- calibration: make a stated 70% mean 70%.
  // Platt scaling on the out-of-sample scores. Without it the blend is
  // over-confident, which is worse than being wrong — it invites bigger bets.
  //
  // Slope only, no intercept — and that detail is the whole thing. Fitting an
  // intercept as well moved the point where the probability crosses 50%, which
  // silently changes which way the forecast points: measured over 672
  // walk-forward forecasts it dropped direction accuracy from 54.0% to 52.4%.
  // Scaling the log-odds around 0.5 cannot change the direction of a single
  // forecast; it only makes a stated 70% mean 70%.
  let calA = 1;
  const oof = valRecords
    .map((r) => ({ p: stacking ? stackedOof.get(r) : simpleBlend(r.probs), y: label(r.i) }))
    .filter((o) => o.p !== undefined);
  if (oof.length >= 60) {
    const rows = oof.map((o) => [Math.log(clip(o.p, 1e-4, 1 - 1e-4) / (1 - clip(o.p, 1e-4, 1 - 1e-4)))]);
    const w = fitLogistic(rows, oof.map((o) => o.y), { l2: 0.25, iters: 300, lr: 0.4 });
    if (w[0] > 0.05 && w[0] < 6) calA = w[0];
  }
  const calibrate = (p) => {
    const q = clip(p, 1e-4, 1 - 1e-4);
    return sigmoid(calA * Math.log(q / (1 - q)));
  };

  const blend = (probs) => calibrate(stacking ? applyW(stackW, probs) : simpleBlend(probs));

  let eHit = 0, eN = 0, cHit = 0, cN = 0, upCount = 0;
  let brier = 0;
  for (const r of valRecords) {
    const raw = stacking ? stackedOof.get(r) : simpleBlend(r.probs);
    if (raw === undefined) continue;
    const p = calibrate(raw), y = label(r.i);
    eN++; upCount += y; if ((p >= 0.5 ? 1 : 0) === y) eHit++;
    brier += (p - y) * (p - y);
    if (Math.abs(p - 0.5) >= 0.05) { cN++; if ((p >= 0.5 ? 1 : 0) === y) cHit++; }
  }
  const brierScore = eN ? brier / eN : null;
  const trainUp = idx.slice(0, valStart).reduce((a, i) => a + label(i), 0) / Math.max(1, valStart);
  const valUp = eN ? upCount / eN : 0.5;
  const baseline = trainUp >= 0.5 ? valUp : 1 - valUp;

  // ---- final models on all history → live prediction
  const last = n - 1;
  const P = trainAll(idx.slice(-3000), 999);
  const live = {};
  if (feats[last]) for (const k of keys) { const v = P[k](last); if (v !== null && v !== undefined && Number.isFinite(v)) live[k] = v; }
  else { live.trend = holtProb(last); live.pattern = P.pattern(last); }
  const pat = findPatterns(candles, last, patOpts);
  for (const m of models) { m.probUp = live[m.key] ?? null; }
  // Show the weights the blend actually used. With stacking on, that is the
  // size of each fitted coefficient — including the sign, because a model that
  // is reliably wrong is worth having, inverted.
  const shown = {};
  for (const k of keys) {
    shown[k] = stacking ? stackW[keys.indexOf(k)] : weights[k];
  }
  const wTotal = keys.reduce((a, k) => a + (live[k] !== undefined ? Math.abs(shown[k]) : 0), 0);
  models.forEach((m) => {
    m.weightPct = wTotal && live[m.key] !== undefined ? Math.round((Math.abs(shown[m.key]) / wTotal) * 100) : 0;
    m.inverted = stacking && live[m.key] !== undefined && shown[m.key] < 0;
  });
  const probUp = blend(live);

  // ---- expected move & range
  const sig = rollingSigma(closes, last);
  const drifts = [];
  if (pat.matches.length >= 3) drifts.push([Math.log(1 + pat.medianReturn), weights.pattern]);
  if (feats[last]) drifts.push([P.knnRet(last), weights.knn]);
  drifts.push([holt.trend[last] * H * 0.5, weights.trend]);
  let mu = drifts.reduce((a, [v, w]) => a + v * w, 0) / drifts.reduce((a, [, w]) => a + w, 0);
  // central path consistent with the direction probability: shift by the probability edge
  const edgeMu = (probUp - 0.5) * 2 * 0.8 * sig * Math.sqrt(H); // P(up)=0.6 → ≈ +0.16σ·√H
  mu = 0.5 * mu + 0.5 * edgeMu;
  if (Math.sign(mu) !== Math.sign(probUp - 0.5) && Math.abs(probUp - 0.5) > 0.03) mu = edgeMu;
  mu = clip(mu, -2 * sig * Math.sqrt(H), 2 * sig * Math.sqrt(H));
  const price = closes[last];
  const step = intervalMs || (n > 1 ? candles[last].t - candles[last - 1].t : 36e5);
  const path = [];
  // Range: the quantiles of this coin's own past H-bar moves, each measured in
  // units of the volatility at that time, so a quiet week and a wild week are
  // comparable. Crypto moves have fat tails: the old normal curve × 0.75 drew
  // the 80% band too narrow (it held 72% of outcomes in the 2026-09-26
  // walk-forward test); the coin's own history held 79%. With too little
  // history it falls back to the old normal band.
  const zq = empiricalBandQuantiles(closes, last, H);
  const RANGE_CALIBRATION = 0.75;
  const Z = zq || { q05: -1.6449 * RANGE_CALIBRATION, q10: -1.2816 * RANGE_CALIBRATION, q25: -0.6745 * RANGE_CALIBRATION, q75: 0.6745 * RANGE_CALIBRATION, q90: 1.2816 * RANGE_CALIBRATION, q95: 1.6449 * RANGE_CALIBRATION };
  for (let h = 1; h <= H; h++) {
    const m = (mu * h) / H, sd = sig * Math.sqrt(h);
    path.push({
      t: candles[last].t + step * h,
      p05: price * Math.exp(m + Z.q05 * sd), p10: price * Math.exp(m + Z.q10 * sd), p25: price * Math.exp(m + Z.q25 * sd), p50: price * Math.exp(m),
      p75: price * Math.exp(m + Z.q75 * sd), p90: price * Math.exp(m + Z.q90 * sd), p95: price * Math.exp(m + Z.q95 * sd),
    });
  }
  const end = path[path.length - 1];
  const ensembleAcc = eN ? eHit / eN : null;
  const strength = Math.abs(probUp - 0.5);
  // 95% (Wilson) range of the recent hit rate. A few dozen unseen cases cannot
  // tell 57% apart from the baseline, so "High" needs the whole range above it
  // (it used to need only 55%, which 75 cases clear by luck easily).
  const accRange = eN ? wilsonRange(eHit, eN) : null;
  const provenEdge = eN >= 50 && accRange[0] > Math.max(0.5, baseline);
  const confidence = strength >= 0.1 && provenEdge ? 'High'
    : strength >= 0.05 && ensembleAcc !== null && ensembleAcc > Math.max(0.5, baseline) ? 'Moderate' : 'Low';
  const direction = probUp >= 0.54 ? 'UP' : probUp <= 0.46 ? 'DOWN' : 'SIDEWAYS';

  const notes = [];
  if (ensembleAcc !== null) {
    const accP = (ensembleAcc * 100).toFixed(0), baseP = (baseline * 100).toFixed(0);
    const lo = (accRange[0] * 100).toFixed(0), hi = (accRange[1] * 100).toFixed(0);
    if (provenEdge) notes.push(`The ensemble called the direction right ${accP}% of the time on ${eN} recent unseen cases; even the low end of its 95% range (${lo}%) is above the ${baseP}% it had to beat.`);
    else if (ensembleAcc > baseline) notes.push(`The ensemble called the direction right ${accP}% of the time on ${eN} recent unseen cases, against ${baseP}% for always naming the more common direction. With this few cases the true rate could be anywhere from ${lo}% to ${hi}%, so this is not a proven edge.`);
    else notes.push(`On ${eN} recent unseen cases the ensemble was right ${accP}% of the time, no better than the ${baseP}% of always naming the more common direction — treat this forecast as weak and rely on stop-losses.`);
  }
  const mv = feats[last] ? moveStatsModel(idx.map((i) => ({ z: zAt(i), rsi: ind.rsi[i], up: label(i) })))(zAt(last), ind.rsi[last]) : null;
  const zNow = zAt(last);
  if (mv && Math.abs(zNow) > 1 && mv.n >= 15) notes.push(`Price just moved ${zNow > 0 ? 'up' : 'down'} unusually fast (${Math.abs(zNow).toFixed(1)}σ). In ${mv.n} similar past cases it rose afterwards ${(mv.prob * 100).toFixed(0)}% of the time.`);
  if (pat.matches.length < 3) notes.push('Few close historical chart matches were found, so pattern matching has little influence.');
  if (sig * Math.sqrt(H) > 0.08) notes.push('Volatility is high — the forecast range is wide.');

  return {
    ok: true,
    horizon: H, window, candlesUsed: n,
    lastTime: candles[last].t, lastPrice: price,
    probUp, direction, confidence,
    expectedReturnPct: (Math.exp(mu) - 1) * 100,
    targetPrice: end.p50,
    range: { p05: end.p05, p10: end.p10, p25: end.p25, p50: end.p50, p75: end.p75, p90: end.p90, p95: end.p95 },
    path, models,
    ensemble: {
      accuracy: ensembleAcc, samples: eN, baseline, accuracyRange: accRange, provenEdge,
      confidentAccuracy: cN >= 12 ? cHit / cN : null, confidentCoverage: eN ? cN / eN : 0,
      validationFrom: candles[idx[valStart]]?.t, validationTo: candles[idx[idx.length - 1]]?.t,
      method: stacking ? 'stacked' : 'weighted', brier: brierScore, labelMode,
      calibrationSlope: +calA.toFixed(3),
    },
    patterns: pat,
    notes,
    computeMs: Math.round(now() - t0),
  };
}

// Update the numbers below only by re-running tools/evaluate-engine.mjs — never by estimating.
/**
 * Walk-forward accuracy, re-measured 2026-09-26 on fresh Binance candles after
 * the range change: 240 forecasts per timeframe, 1,440 in total, 12 coins, each
 * one produced using only the candles that existed at that moment.
 *
 * Every accuracy ships with its BASELINE — the score of always naming whichever
 * direction was more common in that window. That baseline uses hindsight (no
 * one knows the majority direction in advance), so it is a strict bar; for a
 * bar that CAN be known in advance, "always say up" scored 52.2% on the same
 * tests against the forecast's 53.9%.
 *
 * Honest summary: the direction call is close to a coin flip. It is below the
 * hindsight baseline on every timeframe, and the calls where the models lean
 * hardest (10+ points from 50/50) were right 50.7% of the time — no better.
 * What DID improve is the price range: the 80% band now holds 78.5% of real
 * outcomes (it held 71.7% before) and the 50% band 48.4% (was 45.1%), measured
 * on the same 1,440 tests.
 */
export const TESTED_ACCURACY = {
  // accuracy, and what it had to beat
  all: 53.9, allBaseline: 58.5,
  '1m': 59.6, '5m': 56.7, '15m': 55.0, '1h': 52.1, '4h': 47.5, '1d': 52.5,
  baseline: { '1m': 63.3, '5m': 58.3, '15m': 60.4, '1h': 55.0, '4h': 59.2, '1d': 54.6 },
  alwaysUp: 52.2,
  confident: { accuracy: 50.7, tests: 227, rule: 'model leans at least 10 points away from 50/50' },
  testsPerInterval: 240, tests: 1440, coins: 12, measuredOn: '2026-09-26',
  brier: { '1m': 0.243, '5m': 0.251, '15m': 0.251, '1h': 0.265, '4h': 0.256, '1d': 0.254 },
  // Share of outcomes that landed inside the range the forecast drew (target: 50 and 80).
  band50: { '1m': 51.7, '5m': 46.3, '15m': 43.8, '1h': 56.7, '4h': 50.8, '1d': 41.3 },
  band80: { '1m': 82.1, '5m': 72.9, '15m': 73.8, '1h': 84.2, '4h': 78.3, '1d': 79.6 },
  // The 90% range (added 2026-09-26), measured on the same 1,440 tests.
  band90: { '1m': 90.0, '5m': 82.9, '15m': 82.5, '1h': 92.5, '4h': 87.5, '1d': 89.6 },
  bandsAll: { band50: 48.4, band80: 78.5, band90: 87.5, before: { band50: 45.1, band80: 71.7 } },
  // Timeframes where the model scored at or below the do-nothing baseline.
  noEdge: ['1m', '5m', '15m', '1h', '4h', '1d'],
  beatsBaselineOverall: false,
  caveat: 'Twelve coins over one market window: crypto moves together, so 240 forecasts on a timeframe are nowhere near 240 independent tests.',
};

/** 95% Wilson interval for a hit rate, as fractions. */
function wilsonRange(hits, n) {
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/** Accuracy and the number it had to beat, for one timeframe. */
export function accuracyFor(interval) {
  const acc = typeof TESTED_ACCURACY[interval] === 'number' ? TESTED_ACCURACY[interval] : null;
  const base = TESTED_ACCURACY.baseline[interval] ?? null;
  if (acc === null || base === null) return null;
  return { accuracyPct: acc, baselinePct: base, edgePts: +(acc - base).toFixed(1), beatsBaseline: acc > base };
}

// Compact version for prompts / scanner rows
export function summarizeForecast(f) {
  if (!f?.ok) return null;
  return {
    horizonBars: f.horizon,
    probUpPct: +(f.probUp * 100).toFixed(1),
    direction: f.direction,
    confidence: f.confidence,
    expectedMovePct: +f.expectedReturnPct.toFixed(2),
    targetPrice: +f.targetPrice.toPrecision(6),
    likelyRange: [+f.range.p25.toPrecision(6), +f.range.p75.toPrecision(6)],
    range90: f.range.p05 ? [+f.range.p05.toPrecision(6), +f.range.p95.toPrecision(6)] : null,
    wideRange: [+f.range.p10.toPrecision(6), +f.range.p90.toPrecision(6)],
    validatedAccuracyPct: f.ensemble.accuracy !== null ? +(f.ensemble.accuracy * 100).toFixed(1) : null,
    baselineAccuracyPct: +(f.ensemble.baseline * 100).toFixed(1),
    accuracyWhenConfidentPct: f.ensemble.confidentAccuracy !== null ? +(f.ensemble.confidentAccuracy * 100).toFixed(1) : null,
    models: f.models.map((m) => ({ model: m.name, probUpPct: m.probUp !== null ? +(m.probUp * 100).toFixed(1) : null, accuracyPct: m.accuracy !== null ? +(m.accuracy * 100).toFixed(1) : null, weightPct: m.weightPct })),
    patternMatches: f.patterns.matches.slice(0, 5).map((m) => ({ date: new Date(m.startTime).toISOString().slice(0, 10), similarityPct: +(m.similarity * 100).toFixed(0), thenMovedPct: +m.futureReturnPct.toFixed(2) })),
    notes: f.notes,
  };
}

// Exposed for the evaluation harness (tools/evaluate.mjs)
export const _internals = { buildFeatures, standardizer, trainLogistic, trainMlp, trainGbdt, knnModel, holtSeries, rollingSigma, normCdf, findPatterns, moveStatsModel };
