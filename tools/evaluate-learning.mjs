// usage: node tools/evaluate-learning.mjs klines.json engine-out-0.json [engine-out-1.json]
// (the engine-out files come from tools/evaluate-engine.mjs)
// Walk-forward test of the learned blend: weights come ONLY from candles before
// each forecast (the same 1,500-bar window the forecast saw).
import fs from 'node:fs';
import { computeAll } from '../js/lib/indicators.js';
import { indicatorVotes, measureOnHistory, learnedWeights, blend, INDICATORS } from '../js/lib/learncenter.js';
const data = JSON.parse(fs.readFileSync(process.argv[2] || 'klines.json'));
const rows = [...JSON.parse(fs.readFileSync(process.argv[3])), ...(process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4])) : [])];
const H = { '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const res = {}; const indTally = {};
const add = (iv, k, hit) => { const a = ((res[iv] ||= {})[k] ||= { n: 0, h: 0 }); a.n++; a.h += hit; const b = ((res.ALL ||= {})[k] ||= { n: 0, h: 0 }); b.n++; b.h += hit; };
let voted = 0;
for (const r of rows) {
  const all = data[r.key].map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const win = all.slice(Math.max(0, r.o - 1499), r.o + 1);
  const hist = measureOnHistory(win.slice(0, -H[r.iv]), H[r.iv]); // outcomes inside the window only
  const w = learnedWeights(hist, null);
  const ind = computeAll(win);
  const votes = indicatorVotes(win, ind, win.length - 1);
  const pb = blend(r.p, votes, w);
  const up = r.y === 1;
  add(r.iv, 'forecast', (r.p >= 0.5) === up);
  add(r.iv, 'blend', (pb >= 0.5) === up);
  if (Object.values(w).some((x) => x)) voted++;
  for (const [k, v] of Object.entries(votes)) if (v) { const a = (indTally[k] ||= { n: 0, h: 0 }); a.n++; a.h += (v === 1) === up; }
}
for (const [iv, m] of Object.entries(res)) console.log(iv.padEnd(4), Object.entries(m).map(([k, a]) => `${k} ${(100 * a.h / a.n).toFixed(1)}% (${a.n})`).join('  '));
console.log('origins where at least one indicator had earned a vote:', voted, 'of', rows.length);
console.log('each indicator called on its own at the test points:', Object.entries(indTally).map(([k, a]) => `${k} ${(100 * a.h / a.n).toFixed(1)}%/${a.n}`).join('  '));
