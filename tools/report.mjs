// Aggregates walk-forward results: accuracy per model, per timeframe, and ensembles.
// usage: node tools/report.mjs out1.json [out2.json ...]
import fs from 'node:fs';

const res = Object.assign({}, ...process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))));
const series = Object.values(res);
const models = Object.keys(series[0].probs);
const ivs = ['15m', '1h', '4h', '1d'];

function acc(ps, ys, thr = 0) {
  let c = 0, n = 0;
  ps.forEach((p, i) => { if (Math.abs(p - 0.5) < thr) return; n++; if ((p >= 0.5 ? 1 : 0) === ys[i]) c++; });
  return { acc: n ? c / n : NaN, n };
}
const fmt = (a) => (Number.isFinite(a.acc) ? `${(a.acc * 100).toFixed(1)}` : '  — ');

function table(getProbs, names) {
  const lines = [];
  lines.push(['model'.padEnd(26), ...ivs.map((i) => i.padStart(7)), 'ALL'.padStart(7), 'conf≥.08'.padStart(14)].join(''));
  for (const m of names) {
    const cells = ivs.map((iv) => {
      const ps = [], ys = [];
      for (const s of series.filter((x) => x.iv === iv)) { const p = getProbs(s, m); if (!p) continue; ps.push(...p); ys.push(...s.ys); }
      return fmt(acc(ps, ys)).padStart(7);
    });
    const ps = [], ys = [];
    for (const s of series) { const p = getProbs(s, m); if (!p) continue; ps.push(...p); ys.push(...s.ys); }
    const all = acc(ps, ys), conf = acc(ps, ys, 0.08);
    lines.push([m.padEnd(26), ...cells, fmt(all).padStart(7), `${fmt(conf)} (${((conf.n / all.n) * 100).toFixed(0)}%)`.padStart(14)].join(''));
  }
  return lines.join('\n');
}

console.log(`series: ${series.length}, test points: ${series.reduce((a, s) => a + s.ys.length, 0)}`);
const upRate = series.reduce((a, s) => a + s.ys.reduce((x, y) => x + y, 0), 0) / series.reduce((a, s) => a + s.ys.length, 0);
console.log(`share of up-moves in test periods: ${(upRate * 100).toFixed(1)}%\n`);
console.log(table((s, m) => s.probs[m], models));

// ensembles
const avg = (s, keys, w) => s.ys.map((_, i) => { let a = 0, t = 0; keys.forEach((k, j) => { const p = s.probs[k]?.[i]; if (p === undefined) return; const ww = w ? w[j] : 1; a += p * ww; t += ww; }); return a / t; });
// online weighting: weight each model by its accuracy on earlier test points of the same series
const online = (s, keys, warm = 20) => s.ys.map((_, i) => {
  let a = 0, t = 0;
  for (const k of keys) {
    const ps = s.probs[k]; if (!ps) continue;
    let c = 0; for (let j = Math.max(0, i - 60); j < i; j++) if ((ps[j] >= 0.5 ? 1 : 0) === s.ys[j]) c++;
    const n = Math.min(i, 60);
    const w = n >= warm ? Math.max(0, c / n - 0.5) + 0.01 : 0.05;
    a += ps[i] * w; t += w;
  }
  return a / t;
});
const ens = {
  'ens: lr+knn+mlp+pat+holt': (s) => avg(s, ['lr', 'knn', 'mlp', 'pattern', 'holt']),
  'ens: gbdtF+mlpBag+pat': (s) => avg(s, ['gbdtF', 'mlpBag', 'pattern']),
  'ens: gbdtF+mlpBag+lrF': (s) => avg(s, ['gbdtF', 'mlpBag', 'lrF']),
  'ens: gbdtF+mlpBag+lrF+pat48': (s) => avg(s, ['gbdtF', 'mlpBag', 'lrF', 'pattern48']),
  'ens: all ML (F)': (s) => avg(s, ['gbdtF', 'mlpBag', 'lrF', 'knn']),
  'ens: everything': (s) => avg(s, ['lr', 'lrF', 'gbdt', 'gbdtF', 'knn', 'mlp', 'mlpF', 'mlpBag', 'pattern', 'pattern48', 'holt']),
  'online: lr+knn+mlp+pat+holt': (s) => online(s, ['lr', 'knn', 'mlp', 'pattern', 'holt']),
  'online: gbdtF+mlpBag+lrF+pat48+holt+mom': (s) => online(s, ['gbdtF', 'mlpBag', 'lrF', 'pattern48', 'holt', 'momentum']),
  'online: everything': (s) => online(s, ['lr', 'lrF', 'gbdt', 'gbdtF', 'knn', 'mlp', 'mlpF', 'mlpBag', 'pattern', 'pattern48', 'holt', 'momentum', 'reversal']),
};
console.log('\n' + table((s, m) => ens[m](s), Object.keys(ens)));

// per-coin view of best ensemble
if (process.env.PER_COIN) {
  const m = process.env.PER_COIN;
  for (const s of series) { const a = acc(ens[m] ? ens[m](s) : s.probs[m], s.ys); console.log(`${s.coin}:${s.iv}`.padEnd(10), fmt(a), a.n); }
}
