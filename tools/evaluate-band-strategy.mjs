// Is the one band with an edge actually tradeable?
//
// `evaluate-signal-edge.mjs` found a single bucket with real lift: 1h scores of
// 45-59, hitting target 35.4% against a 27.5% base rate. A bucket average is not
// a strategy though — it ignores compounding, overlapping positions, and the
// possibility that the whole effect came from two coins in one quarter.
//
// This takes only those trades, in sequence, per coin, with fees and one position
// at a time, and reports what the account would actually have done. It also runs
// the same test on a shuffled label as a control: if the shuffled version looks
// similar, the edge is noise.
//
// usage: node tools/evaluate-band-strategy.mjs klines.json [interval] [lo] [hi]
import fs from 'node:fs';
import { generateSignal, geometryFor } from '../js/lib/signals.js';
import { tripleBarrier } from '../js/lib/barrier.js';
import { computeAll } from '../js/lib/indicators.js';

const [, , file, IV = '1h', LO = '45', HI = '59'] = process.argv;
const lo = +LO, hi = +HI;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const H = HMAP[IV];
const geo = geometryFor(IV);
const FEE_R = 0.002;
const RISK = 0.01; // risk 1% of the account per trade

const perCoin = [];
const allTrades = [];

for (const key of Object.keys(data)) {
  const [sym, iv] = key.split(':');
  if (iv !== IV) continue;
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  if (c.length < 800) continue;
  const ind = computeAll(c);
  const from = Math.floor(c.length * 0.5);

  let equity = 1, peak = 1, maxDd = 0, wins = 0, n = 0;
  let busyUntil = -1; // one position at a time, like a real account

  for (let i = from; i < c.length - H * 4; i++) {
    if (i <= busyUntil) continue;
    const sig = generateSignal(c.slice(Math.max(0, i - 499), i + 1), { interval: IV });
    if (!sig.ok || sig.score < lo || sig.score > hi) continue;

    const b = tripleBarrier(c, i, ind.atr[i], { up: geo.stopAtr * geo.rr, down: geo.stopAtr, maxBars: H * 3 });
    if (b.label === null) continue;

    const r = b.touched === 'target' ? geo.rr
      : b.touched === 'stop' ? -1
        : (b.ret / (geo.stopAtr * ind.atr[i] / c[i].c)); // time exit, scaled to R
    const net = r - FEE_R;
    equity *= (1 + RISK * net);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    n++; if (net > 0) wins++;
    allTrades.push({ sym, t: c[i].t, r: net });
    busyUntil = i + b.bars;
  }
  if (n >= 5) perCoin.push({ sym, n, wins, ret: (equity - 1) * 100, maxDd: maxDd * 100 });
  console.error(key, 'done');
}

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const totalN = sum(perCoin, (x) => x.n);
const avgR = totalN ? sum(allTrades, (t) => t.r) / totalN : 0;

console.log(`\nStrategy: ${IV} chart, score ${lo}..${hi} only, ${geo.rr}:1 target off a ${geo.stopAtr} ATR stop, risking ${RISK * 100}% per trade\n`);
console.log('coin   trades  win%    return   maxDD');
for (const p of perCoin.sort((a, b) => b.ret - a.ret)) {
  console.log(`${p.sym.padEnd(6)} ${String(p.n).padStart(6)}  ${((p.wins / p.n) * 100).toFixed(0).padStart(3)}%  ${(p.ret >= 0 ? '+' : '') + p.ret.toFixed(1)}%`.padEnd(40) + `${p.maxDd.toFixed(1)}%`);
}
const winners = perCoin.filter((p) => p.ret > 0).length;
console.log(`\ntotal trades ${totalN} across ${perCoin.length} coins`);
console.log(`average ${avgR >= 0 ? '+' : ''}${avgR.toFixed(3)} R per trade after fees`);
console.log(`profitable on ${winners}/${perCoin.length} coins`);

// control: same trade count, random entries
let ctrlR = 0, ctrlN = 0;
for (const key of Object.keys(data)) {
  const [, iv] = key.split(':');
  if (iv !== IV) continue;
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  if (c.length < 800) continue;
  const ind = computeAll(c);
  const from = Math.floor(c.length * 0.5);
  for (let k = 0; k < 60; k++) {
    const i = from + Math.floor(((c.length - H * 4 - from) * ((k * 2654435761) % 1000)) / 1000);
    const b = tripleBarrier(c, i, ind.atr[i], { up: geo.stopAtr * geo.rr, down: geo.stopAtr, maxBars: H * 3 });
    if (b.label === null) continue;
    ctrlR += (b.touched === 'target' ? geo.rr : b.touched === 'stop' ? -1 : 0) - FEE_R;
    ctrlN++;
  }
}
console.log(`control (random entries, same rules): ${(ctrlR / ctrlN).toFixed(3)} R per trade over ${ctrlN} trades`);
