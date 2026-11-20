// End-to-end walk-forward test of the shipped forecast() engine.
// usage: node tools/evaluate-engine.mjs klines.json shard shards out.json [originsPerSeries]
import fs from 'node:fs';
import { forecast } from '../js/lib/predict.js';
const [, , file, shard = '0', shards = '1', outFile, perSeries = '14'] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
// the horizons the coin page forecasts on each chart (DEFAULT_HORIZON in js/ai/context.js)
const HMAP = { '1s': 30, '5s': 24, '10s': 18, '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7, '1w': 4 };
const out = [];
const keys = Object.keys(data).sort().filter((_, i) => i % +shards === +shard);
for (const key of keys) {
  const iv = key.split(':')[1], H = HMAP[iv];
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  const n = c.length;
  // the 100-candle volatility the forecast's ranges are built on (rollingSigma
  // in js/lib/predict.js), from prefix sums
  const S1 = [0], S2 = [0];
  for (let i = 0; i < n; i++) { const r = i ? Math.log(c[i].c / c[i - 1].c) : 0; S1.push(S1[i] + r); S2.push(S2[i] + r * r); }
  const sigAt = (i) => { const a = Math.max(1, i - 99), m = i - a + 1, mu = (S1[i + 1] - S1[a]) / m; return Math.sqrt(Math.max((S2[i + 1] - S2[a]) / m - mu * mu, 1e-12)); };
  const WIN = { '1s': 1000, '5s': 1000, '10s': 600 }[iv] || 1500;
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  // Is a bigger (or smaller) move than usual coming? Called from today's
  // volatility against the coin's own past, judged on the move that followed.
  // Uses only candles the forecast saw.
  const moveCall = (o, H) => {
    const js = []; for (let j = Math.max(101, o - WIN + 1 + 101); j <= o - H; j++) js.push(j);
    if (js.length < 200) return null;
    const usual = median(js.map((j) => Math.abs(Math.log(c[j + H].c / c[j].c))));
    const sigMed = median(js.map((j) => sigAt(j))) * Math.sqrt(H);
    return { vNow: sigAt(o) * Math.sqrt(H), sigMed, usual, absRet: Math.abs(Math.log(c[o + H].c / c[o].c)) };
  };
  // As many candles as the coin page gives the forecast: second charts load
  // 1,000 (1s, 5s) or 600 (10s) candles (js/api/market.js MAX_BARS), the rest
  // 1,500. A weekly chart has a few hundred candles at most: it is tested on
  // its last 40% with at least 200 behind each forecast (the engine's minimum).
  const start = Math.max(iv === '1w' ? 200 : WIN, Math.floor(n * 0.6));
  const span = n - H - 1 - start;
  const count = +perSeries;
  // a coin listed recently has no candles after the 1,500-candle window
  if (span < count) { console.error(key, `too short (${n} candles)`); continue; }
  for (let k = 0; k < count; k++) {
    const o = start + Math.floor((span * k) / count);
    const f = forecast(c.slice(Math.max(0, o - WIN + 1), o + 1), { horizon: H });
    if (!f.ok) continue;
    out.push({ key, iv, o, y: c[o + H].c > c[o].c ? 1 : 0, p: f.probUp, conf: f.confidence, valAcc: f.ensemble.accuracy, models: Object.fromEntries(f.models.map((m) => [m.key, m.probUp])), ret: c[o + H].c / c[o].c - 1, inRange50: c[o + H].c >= f.range.p25 && c[o + H].c <= f.range.p75, inRange80: c[o + H].c >= f.range.p10 && c[o + H].c <= f.range.p90, move: moveCall(o, H), valN: f.ensemble.samples, q: Object.fromEntries(['p10', 'p25', 'p50', 'p75', 'p90'].map((k) => [k, f.range[k] / c[o].c])) });
  }
  console.error(key, 'done');
}
fs.writeFileSync(outFile, JSON.stringify(out));
