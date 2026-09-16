// End-to-end walk-forward test of the shipped forecast() engine.
// usage: node tools/evaluate-engine.mjs klines.json shard shards out.json [originsPerSeries]
import fs from 'node:fs';
import { forecast } from '../js/lib/predict.js';
const [, , file, shard = '0', shards = '1', outFile, perSeries = '14'] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const HMAP = { '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const out = [];
const keys = Object.keys(data).sort().filter((_, i) => i % +shards === +shard);
for (const key of keys) {
  const iv = key.split(':')[1], H = HMAP[iv];
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  const n = c.length;
  const start = Math.max(1500, Math.floor(n * 0.6));
  const span = n - H - 1 - start;
  const count = +perSeries;
  for (let k = 0; k < count; k++) {
    const o = start + Math.floor((span * k) / count);
    const f = forecast(c.slice(Math.max(0, o - 1499), o + 1), { horizon: H });
    if (!f.ok) continue;
    out.push({ key, iv, o, y: c[o + H].c > c[o].c ? 1 : 0, p: f.probUp, conf: f.confidence, valAcc: f.ensemble.accuracy, models: Object.fromEntries(f.models.map((m) => [m.key, m.probUp])), ret: c[o + H].c / c[o].c - 1, inRange50: c[o + H].c >= f.range.p25 && c[o + H].c <= f.range.p75, inRange80: c[o + H].c >= f.range.p10 && c[o + H].c <= f.range.p90 });
  }
  console.error(key, 'done');
}
fs.writeFileSync(outFile, JSON.stringify(out));
