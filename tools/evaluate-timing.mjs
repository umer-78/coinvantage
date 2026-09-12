// Walk-forward test of the TIMING claim: when we say "it rises for N bars then
// turns", does the real peak land where we said?
//
// usage: node tools/evaluate-timing.mjs klines.json out.json [originsPerSeries]
//
// For every test origin we run the shipped forecast() + timingOutlook() using
// only data available at that moment, then look at the real next H bars and
// find where price actually peaked. A prediction counts as a hit when the real
// peak is within ±25% of the horizon of the predicted bar. The same test is run
// against a uniform random guess so the number has something to beat.
import fs from 'node:fs';
import { forecast } from '../js/lib/predict.js';
import { timingOutlook } from '../js/lib/timing.js';

const [, , file, outFile = 'timing.json', perSeries = '12'] = process.argv;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const rows = [];

for (const key of Object.keys(data).sort()) {
  const iv = key.split(':')[1];
  const H = HMAP[iv];
  if (!H || H < 4) continue; // too few steps for a peak to mean anything
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  const n = c.length;
  const start = Math.max(1500, Math.floor(n * 0.6));
  const span = n - H - 1 - start;
  if (span <= 0) continue;
  const count = +perSeries;

  for (let k = 0; k < count; k++) {
    const o = start + Math.floor((span * k) / count);
    const f = forecast(c.slice(Math.max(0, o - 1499), o + 1), { horizon: H });
    if (!f.ok) continue;
    const t = timingOutlook(f, { intervalMs: c[o].t - c[o - 1].t });
    if (!t.ok || !t.shaped) continue;

    // What actually happened over the next H bars, as % from the origin close.
    const base = c[o].c;
    const real = [];
    for (let h = 1; h <= H; h++) real.push((c[o + h].c / base - 1) * 100);
    let actualPeak = 1, actualTrough = 1;
    for (let h = 1; h <= H; h++) {
      if (real[h - 1] > real[actualPeak - 1]) actualPeak = h;
      if (real[h - 1] < real[actualTrough - 1]) actualTrough = h;
    }

    const predBar = t.rising ? t.peak.bar : t.falling ? t.trough.bar : null;
    const actualBar = t.rising ? actualPeak : actualTrough;
    if (predBar === null) continue;
    const tol = Math.max(1, Math.round(H * 0.25));

    rows.push({
      key, iv, H, o,
      side: t.rising ? 'peak' : 'trough',
      predBar, actualBar,
      off: Math.abs(predBar - actualBar),
      hit: Math.abs(predBar - actualBar) <= tol,
      tol,
      // did it actually turn inside the horizon, as the shaped path claimed?
      claimedTurn: t.turn ? t.turn.bar : null,
      turnedEarly: actualBar < H,
      predPct: t.rising ? t.peak.pct : t.trough.pct,
      actualPct: real[actualBar - 1],
      endPredPct: t.endPct,
      endActualPct: real[H - 1],
    });
  }
  console.error(key, 'done', rows.length);
}

// A uniform random guess over bars 1..H, scored with the same tolerance.
const baseline = rows.length
  ? rows.reduce((s, r) => {
      const lo = Math.max(1, r.actualBar - r.tol), hi = Math.min(r.H, r.actualBar + r.tol);
      return s + (hi - lo + 1) / r.H; // P(random bar lands in the window)
    }, 0) / rows.length
  : null;

const hits = rows.filter((r) => r.hit).length;
const offs = rows.map((r) => r.off).sort((a, b) => a - b);
const turnedEarly = rows.filter((r) => r.turnedEarly).length;

const summary = {
  tests: rows.length,
  peakHitPct: rows.length ? +((hits / rows.length) * 100).toFixed(1) : null,
  baselinePct: baseline === null ? null : +(baseline * 100).toFixed(1),
  medianBarsOff: offs.length ? offs[Math.floor(offs.length / 2)] : null,
  turnedInsideHorizonPct: rows.length ? +((turnedEarly / rows.length) * 100).toFixed(1) : null,
  coins: new Set(rows.map((r) => r.key.split(':')[0])).size,
  byInterval: {},
};
for (const iv of [...new Set(rows.map((r) => r.iv))]) {
  const sub = rows.filter((r) => r.iv === iv);
  summary.byInterval[iv] = {
    tests: sub.length,
    hitPct: +((sub.filter((r) => r.hit).length / sub.length) * 100).toFixed(1),
    medianOff: sub.map((r) => r.off).sort((a, b) => a - b)[Math.floor(sub.length / 2)],
  };
}

fs.writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
