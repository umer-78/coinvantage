// Walk-forward test of the engine on the triple-barrier question:
// does price reach the profit target before the stop?
//
// usage: node tools/evaluate-barrier.mjs klines.json shard shards out.json [perSeries] [mode]
//   mode: 'barrier' (train on the barrier label) or 'direction' (train on the old
//         label and score it against the barrier outcome anyway — the control).
import fs from 'node:fs';
import { forecast } from '../js/lib/predict.js';
import { tripleBarrier } from '../js/lib/barrier.js';
import { computeAll } from '../js/lib/indicators.js';

const [, , file, shard = '0', shards = '1', outFile, perSeries = '14', mode = 'barrier'] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const UP = 2, DOWN = 1;           // 2:1 reward-to-risk, the plan the site shows

const out = [];
const keys = Object.keys(data).sort().filter((_, i) => i % +shards === +shard);
for (const key of keys) {
  const iv = key.split(':')[1], H = HMAP[iv];
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  const n = c.length;
  const ind = computeAll(c);
  const start = Math.max(1500, Math.floor(n * 0.6));
  const span = n - H * 3 - 2 - start;      // leave room for the barrier to resolve
  const count = +perSeries;
  for (let k = 0; k < count; k++) {
    const o = start + Math.floor((span * k) / count);
    // the truth: what actually happened after this bar
    const truth = tripleBarrier(c, o, ind.atr[o], { up: UP, down: DOWN, maxBars: H * 3 });
    if (truth.label === null) continue;

    const f = forecast(c.slice(Math.max(0, o - 1499), o + 1), {
      horizon: H, fast: true, labelMode: mode, barrierUp: UP, barrierDown: DOWN,
    });
    if (!f.ok) continue;
    out.push({
      key, iv, o, mode,
      y: truth.label, touched: truth.touched, barsToResolve: truth.bars,
      p: f.probUp, conf: f.confidence, valAcc: f.ensemble.accuracy,
    });
  }
  console.error(key, 'done');
}
fs.writeFileSync(outFile, JSON.stringify(out));
