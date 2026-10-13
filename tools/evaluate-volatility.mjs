// usage: node tools/evaluate-volatility.mjs klines.json
//
// Can the price ranges be narrower and still hold? The ranges are the coin's
// own past moves in units of its volatility at the time, times its volatility
// now — the volatility being the plain spread of the last 100 candles. An
// exponentially weighted estimate (recent candles count more, RiskMetrics
// style) reacts faster: narrower in calm stretches, wider once things move.
//
// Every coin, every chart, one test per horizon (no overlapping outcomes), the
// same 1,500-candle windows the forecast gets, each range built only from
// candles before its outcome. Scored with the interval score (Gneiting &
// Raftery 2007): the range's width plus 2/α times how far the outcome fell
// outside it — lower is better, and neither a too-wide nor a too-narrow range
// can game it. Scores are in units of the coin's usual move over the window
// (median absolute move over the horizon), the same divisor for every method.
//
// Decided before the run: each series is cut in half by time. On the older
// half each chart picks the method with the lowest mean 80% interval score.
// It replaces the 100-candle volatility only if, on the newer half, its mean
// 80% interval score is at least 2% lower than the 100-candle one's and its 80%
// range holds no more than a point further from 80% than the 100-candle range.
import { readFileSync } from 'node:fs';
import { _internals } from '../js/lib/predict.js';

const { rollingSigma } = _internals;
const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const H = { '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 }; // DEFAULT_HORIZON in js/ai/context.js
const WINDOW = 1500;
const METHODS = { rolling100: null, ewma97: 0.97, ewma94: 0.94 };
const r1 = (v) => +v.toFixed(1), r3 = (v) => +v.toFixed(3);

// σ of log returns at every candle of `closes` (index j uses returns up to j).
function rollingSigmas(closes) {
  const n = closes.length, S1 = [0], S2 = [0], out = new Float64Array(n);
  for (let j = 1; j < n; j++) { const r = Math.log(closes[j] / closes[j - 1]); S1.push(S1[j - 1] + r); S2.push(S2[j - 1] + r * r); }
  for (let j = 1; j < n; j++) {
    const a = Math.max(1, j - 99), m = j - a + 1;
    if (m < 2) { out[j] = 0.02; continue; }
    const mu = (S1[j] - S1[a - 1]) / m;
    out[j] = Math.sqrt(Math.max((S2[j] - S2[a - 1]) / m - mu * mu, 1e-10));
  }
  return out;
}
// v_j = λ v_(j−1) + (1 − λ) r_j², seeded with the plain variance of the first 100 returns
function ewmaSigmas(closes, lambda) {
  const n = closes.length, out = new Float64Array(n), m = Math.min(100, n - 1);
  let s = 0, s2 = 0;
  for (let j = 1; j <= m; j++) { const r = Math.log(closes[j] / closes[j - 1]); s += r; s2 += r * r; }
  let v = Math.max(s2 / m - (s / m) ** 2, 1e-10);
  out[m] = Math.sqrt(v);
  for (let j = m + 1; j < n; j++) { const r = Math.log(closes[j] / closes[j - 1]); v = lambda * v + (1 - lambda) * r * r; out[j] = Math.sqrt(Math.max(v, 1e-10)); }
  return out;
}
const quantile = (sorted, p) => { const k = (sorted.length - 1) * p, lo = Math.floor(k); return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (k - lo); };

// the prefix-sum σ must be the engine's rollingSigma
{
  const c = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(Math.sin(i * 0.37) * 0.05 + i * 0.001));
  const s = rollingSigmas(c);
  for (const j of [5, 150, 399]) if (Math.abs(s[j] / rollingSigma(c, j) - 1) > 1e-6) throw new Error(`rollingSigmas differs from the engine at ${j}`);
}

const out = { measuredOn: new Date().toISOString().slice(0, 10), charts: {} };
for (const iv of Object.keys(H)) {
  const keys = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > WINDOW + 200);
  if (!keys.length) continue;
  const h = H[iv];
  // rows[method][half] = [{ c50, c80, c90, is80, is50, w80 }]
  const rows = Object.fromEntries(Object.keys(METHODS).map((m) => [m, [[], []]]));
  for (const key of keys) {
    const closes = raw[key].map((r) => r[4]);
    const origins = [];
    for (let o = WINDOW - 1; o + h < closes.length; o += h) origins.push(o);
    origins.forEach((o, idx) => {
      const win = closes.slice(o - WINDOW + 1, o + 1);
      const last = win.length - 1;
      const y = Math.log(closes[o + h] / closes[o]);
      const moves = [];
      for (let j = 101; j <= last - h; j++) moves.push(Math.abs(Math.log(win[j + h] / win[j])));
      if (moves.length < 60) return;
      moves.sort((a, b) => a - b);
      const scale = quantile(moves, 0.5);
      if (!(scale > 0)) return;
      for (const [m, lambda] of Object.entries(METHODS)) {
        const sig = lambda === null ? rollingSigmas(win) : ewmaSigmas(win, lambda);
        const zs = [];
        for (let j = 101; j <= last - h; j++) { const s = sig[j] * Math.sqrt(h); if (s > 0) zs.push(Math.log(win[j + h] / win[j]) / s); }
        zs.sort((a, b) => a - b);
        const med = quantile(zs, 0.5), sd = sig[last] * Math.sqrt(h);
        const b = (p) => (quantile(zs, p) - med) * sd;
        const [l50, u50, l80, u80, l90, u90] = [b(0.25), b(0.75), b(0.1), b(0.9), b(0.05), b(0.95)];
        const score = (l, u, a) => (u - l + (2 / a) * Math.max(0, l - y) + (2 / a) * Math.max(0, y - u)) / scale;
        rows[m][idx < origins.length / 2 ? 0 : 1].push({
          c50: y >= l50 && y <= u50, c80: y >= l80 && y <= u80, c90: y >= l90 && y <= u90,
          is80: score(l80, u80, 0.2), is50: score(l50, u50, 0.5), w80: (u80 - l80) / scale,
        });
      }
    });
  }
  const stats = (rs) => ({
    band50: r1((rs.filter((r) => r.c50).length / rs.length) * 100), band80: r1((rs.filter((r) => r.c80).length / rs.length) * 100), band90: r1((rs.filter((r) => r.c90).length / rs.length) * 100),
    is80: r3(rs.reduce((a, r) => a + r.is80, 0) / rs.length), is50: r3(rs.reduce((a, r) => a + r.is50, 0) / rs.length), width80: r3(rs.reduce((a, r) => a + r.w80, 0) / rs.length),
  });
  const res = Object.fromEntries(Object.keys(METHODS).map((m) => [m, { older: stats(rows[m][0]), newer: stats(rows[m][1]) }]));
  const pick = Object.keys(METHODS).sort((a, b) => res[a].older.is80 - res[b].older.is80 || (a === 'rolling100' ? -1 : b === 'rolling100' ? 1 : 0))[0];
  const cur = res.rolling100.newer, nw = res[pick].newer;
  const adopt = pick !== 'rolling100' && nw.is80 <= cur.is80 * 0.98 && Math.abs(nw.band80 - 80) <= Math.abs(cur.band80 - 80) + 1;
  out.charts[iv] = { coins: keys.length, tests: [rows.rolling100[0].length, rows.rolling100[1].length], pick, adopt, methods: res };
  const line = (m) => `${m.padEnd(10)} older IS ${res[m].older.is80} (80% held ${res[m].older.band80}%) · newer IS ${res[m].newer.is80}, 80% held ${res[m].newer.band80}%, 50% ${res[m].newer.band50}%, 90% ${res[m].newer.band90}%, width ${res[m].newer.width80}`;
  console.log(`${iv.padEnd(4)} ${keys.length} coins, ${rows.rolling100[0].length} + ${rows.rolling100[1].length} tests · older half picks ${pick} → ${adopt ? `USE ${pick} (newer-half score ${r1((1 - nw.is80 / cur.is80) * 100)}% lower)` : 'KEEP the 100-candle volatility'}`);
  for (const m of Object.keys(METHODS)) console.log(`     ${line(m)}`);
}
console.log(`\nJSON ${JSON.stringify(out)}`);
