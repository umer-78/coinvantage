// Per-chart summary of a forecast release test (tools/evaluate-engine.mjs
// output): hit rate, the do-nothing baseline, the direction trust fitted the
// way TESTED_ACCURACY.directionTrust was, and how often the outcome landed in
// the drawn ranges. Prints JSON for TESTED_ACCURACY.recheck.
// usage: node tools/report-engine.mjs out0.json [out1.json ...]
import fs from 'node:fs';
import { fitShrink } from '../js/lib/selfimprove.js';
import { TESTED_ACCURACY } from '../js/lib/predict.js';

const rows = process.argv.slice(2).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const out = { measuredOn: new Date().toISOString().slice(0, 10), tests: rows.length, byInterval: {} };
const pct = (v) => +(v * 100).toFixed(1);
for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
  const r = rows.filter((x) => x.iv === iv);
  if (!r.length) continue;
  const hit = r.filter((x) => (x.p >= 0.5 ? 1 : 0) === x.y).length / r.length;
  const rose = r.filter((x) => x.y === 1).length / r.length;
  const { s, gain } = fitShrink(r.map((x) => ({ p: x.p, up: x.y === 1 })));
  const published = TESTED_ACCURACY.directionTrust[iv] ?? 0;
  out.byInterval[iv] = {
    n: r.length, coins: new Set(r.map((x) => x.key.split(':')[0])).size,
    hitPct: pct(hit), baselinePct: pct(Math.max(rose, 1 - rose)),
    trust: +s.toFixed(2), gainNats: +gain.toFixed(2), publishedTrust: published, kept: +Math.min(published, s).toFixed(2),
    band50: pct(r.filter((x) => x.inRange50).length / r.length), band80: pct(r.filter((x) => x.inRange80).length / r.length),
  };
  const x = out.byInterval[iv];
  console.log(`${iv.padEnd(4)} n ${String(x.n).padStart(4)}  hit ${x.hitPct}% vs baseline ${x.baselinePct}%  trust ${x.trust} (published ${published}) → kept ${x.kept}  in 50% band ${x.band50}%, 80% band ${x.band80}%`);
}
console.log(`\nJSON ${JSON.stringify(out)}`);
