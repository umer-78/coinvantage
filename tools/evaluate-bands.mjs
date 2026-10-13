// usage: node tools/evaluate-bands.mjs klines.json
//
// Do the forecast's price ranges hold as often as they say? Where the
// direction is not reliable the coin page shows them centred on today's
// price: the coin's own past moves in units of its volatility at the time
// (empiricalBandQuantiles), times the 100-candle volatility now
// (rollingSigma), over the coin page's horizon — built here with the
// engine's own functions on the same 1,500 candles the forecast gets.
//
// Every coin, every chart, one test per horizon (no overlapping outcomes).
// Each series is cut in half by time. Decided before the run: on the older
// half each chart picks the width factor whose 80% range held closest to 80%;
// that factor is used only if, on the newer half, it brings the 80% range at
// least a point closer to 80% than the unscaled range does, without taking
// the 50% range more than 2 points further from 50%.
//
// 2026-10-13: two runs an hour apart disagreed on 5m (KEEP, then USE 1.1)
// because 5m had ~9 days of outcomes and the pick sat between 1 and 1.1. Since
// then the job downloads ~100 days of 5m and 15m and the factors step by 0.05;
// the rule itself is unchanged.
import { readFileSync } from 'node:fs';
import { _internals } from '../js/lib/predict.js';

const { rollingSigma, empiricalBandQuantiles } = _internals;
const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const H = { '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 }; // DEFAULT_HORIZON in js/ai/context.js
const FACTORS = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4];
const WINDOW = 1500;
const NORMAL = { q05: -1.6449, q10: -1.2816, q25: -0.6745, q75: 0.6745, q90: 1.2816, q95: 1.6449 };
const r1 = (v) => +v.toFixed(1);

const out = { measuredOn: new Date().toISOString().slice(0, 10), charts: {} };
for (const iv of Object.keys(H)) {
  const keys = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > WINDOW + 200);
  if (!keys.length) continue;
  const h = H[iv];
  const halves = [[], []];
  for (const key of keys) {
    const closes = raw[key].map((r) => r[4]);
    const origins = [];
    for (let o = WINDOW - 1; o + h < closes.length; o += h) origins.push(o);
    origins.forEach((o, idx) => {
      const win = closes.slice(o - WINDOW + 1, o + 1);
      const last = win.length - 1;
      const sd = rollingSigma(win, last) * Math.sqrt(h);
      if (!(sd > 0)) return;
      const z = empiricalBandQuantiles(win, last, h) || Object.fromEntries(Object.entries(NORMAL).map(([k, v]) => [k, v * 0.75]));
      const y = Math.log(closes[o + h] / closes[o]) / sd; // the move that followed, in the band's units
      halves[idx < origins.length / 2 ? 0 : 1].push({ y, z });
    });
  }
  const cover = (rows, f, lo, hi) => (rows.filter((r) => r.y >= f * r.z[lo] && r.y <= f * r.z[hi]).length / rows.length) * 100;
  const table = (rows) => Object.fromEntries(FACTORS.map((f) => [f, { band50: r1(cover(rows, f, 'q25', 'q75')), band80: r1(cover(rows, f, 'q10', 'q90')), band90: r1(cover(rows, f, 'q05', 'q95')) }]));
  const older = table(halves[0]), newer = table(halves[1]);
  const pick = [...FACTORS].sort((a, b) => Math.abs(older[a].band80 - 80) - Math.abs(older[b].band80 - 80) || Math.abs(a - 1) - Math.abs(b - 1))[0];
  const closer = Math.abs(newer[1].band80 - 80) - Math.abs(newer[pick].band80 - 80);
  const worse50 = Math.abs(newer[pick].band50 - 50) - Math.abs(newer[1].band50 - 50);
  const adopt = pick !== 1 && closer >= 1 && worse50 <= 2;
  out.charts[iv] = { coins: keys.length, tests: [halves[0].length, halves[1].length], pick, adopt, older: older[pick], olderUnscaled: older[1], newer: newer[pick], newerUnscaled: newer[1], all: table([...halves[0], ...halves[1]])[adopt ? pick : 1] };
  console.log(`${iv.padEnd(4)} ${keys.length} coins, ${halves[0].length} + ${halves[1].length} tests · older half: 80% range held ${older[1].band80}% → factor ${pick} gives ${older[pick].band80}% · newer half: ${newer[1].band80}% unscaled, ${newer[pick].band80}% with ${pick} (50% range ${newer[1].band50}% → ${newer[pick].band50}%) → ${adopt ? `USE ${pick}` : 'KEEP'}`);
}
console.log(`\nJSON ${JSON.stringify(out)}`);
