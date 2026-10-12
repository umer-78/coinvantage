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
  // The move-size call: bigger than usual when today's volatility is above
  // the coin's typical, judged on whether the move that followed was bigger
  // than its typical move. Baseline: always naming the commoner outcome.
  const mv = r.filter((z) => z.move);
  if (mv.length) {
    const big = mv.filter((z) => z.move.absRet > z.move.usual).length / mv.length;
    const hitMv = mv.filter((z) => (z.move.vNow > z.move.sigMed) === (z.move.absRet > z.move.usual)).length / mv.length;
    // rank correlation of volatility now (against the coin's own) with the move that followed (against the coin's usual)
    const rank = (xs) => { const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const rk = new Array(xs.length); idx.forEach(([, i], k) => { rk[i] = k; }); return rk; };
    const a = rank(mv.map((z) => z.move.vNow / z.move.sigMed)), b = rank(mv.map((z) => z.move.absRet / z.move.usual));
    const m = (a.length - 1) / 2; let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - m) * (b[i] - m); da += (a[i] - m) ** 2; db += (b[i] - m) ** 2; }
    // and how much bigger the move was when the call said bigger
    const mean = (xs) => xs.reduce((s2, v) => s2 + v, 0) / Math.max(1, xs.length);
    const callBig = mv.filter((z) => z.move.vNow > z.move.sigMed), callSmall = mv.filter((z) => z.move.vNow <= z.move.sigMed);
    x.move = { n: mv.length, hitPct: pct(hitMv), baselinePct: pct(Math.max(big, 1 - big)), spearman: +(num / Math.sqrt(da * db)).toFixed(3),
      bigCalls: callBig.length, sizeWhenBig: +mean(callBig.map((z) => z.move.absRet / z.move.usual)).toFixed(2), sizeWhenSmall: +mean(callSmall.map((z) => z.move.absRet / z.move.usual)).toFixed(2) };
    console.log(`     move size: call right ${x.move.hitPct}% vs ${x.move.baselinePct}% baseline (n ${mv.length}), rank correlation ${x.move.spearman}; the move was ${x.move.sizeWhenBig}× usual after "bigger" calls and ${x.move.sizeWhenSmall}× after "smaller"`);
  }
  // The same ranges centred on today's price instead of the model's lean
  // (its drift): what the coin page shows where it has no reliable direction.
  const qs = r.filter((z) => z.q);
  if (qs.length) {
    const end = (z) => 1 + z.ret;
    const inBand = (z, a, b) => end(z) >= z.q[a] / z.q.p50 && end(z) <= z.q[b] / z.q.p50;
    x.centred = { n: qs.length, band50: pct(qs.filter((z) => inBand(z, 'p25', 'p75')).length / qs.length), band80: pct(qs.filter((z) => inBand(z, 'p10', 'p90')).length / qs.length),
      leanBand50: pct(qs.filter((z) => end(z) >= z.q.p25 && end(z) <= z.q.p75).length / qs.length), leanBand80: pct(qs.filter((z) => end(z) >= z.q.p10 && end(z) <= z.q.p90).length / qs.length),
      medianLeanPct: +(([...qs.map((z) => Math.abs(z.q.p50 - 1))].sort((a, b) => a - b)[Math.floor(qs.length / 2)]) * 100).toFixed(2) };
    console.log(`     centred on today's price: 50% band held ${x.centred.band50}%, 80% band ${x.centred.band80}% (with the lean: ${x.centred.leanBand50}%, ${x.centred.leanBand80}%); median lean ${x.centred.medianLeanPct}%`);
  }
  // Does the per-coin check the coin page shows ("tested accuracy ... on N
  // unseen cases") tell which forecasts will be right?
  const va = r.filter((z) => Number.isFinite(z.valAcc));
  if (va.length) {
    const hitOf = (rows) => (rows.length ? pct(rows.filter((z) => (z.p >= 0.5 ? 1 : 0) === z.y).length / rows.length) : null);
    const hi = va.filter((z) => z.valAcc >= 0.6), lo = va.filter((z) => z.valAcc < 0.6);
    x.valCheck = { n: va.length, medianValAcc: pct([...va.map((z) => z.valAcc)].sort((p, q) => p - q)[Math.floor(va.length / 2)]), highN: hi.length, highHitPct: hitOf(hi), lowN: lo.length, lowHitPct: hitOf(lo) };
    console.log(`     per-coin check: median ${x.valCheck.medianValAcc}%; when it read 60%+ the forecast was right ${x.valCheck.highHitPct}% (n ${hi.length}), otherwise ${x.valCheck.lowHitPct}% (n ${lo.length})`);
  }
}
console.log(`\nJSON ${JSON.stringify(out)}`);
