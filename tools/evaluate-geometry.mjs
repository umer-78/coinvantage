// Is the trade plan itself profitable, before any model is involved?
//
// A setup with a 2:1 reward-to-risk only pays if the target is reached more than
// a third of the time. This sweeps stop and target distances across every coin
// and timeframe and reports the hit rate and expected value of each, so the
// levels the site prints are chosen from measurement rather than convention.
//
// usage: node tools/evaluate-geometry.mjs klines.json
import fs from 'node:fs';
import { tripleBarrier } from '../js/lib/barrier.js';
import { computeAll } from '../js/lib/indicators.js';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const FEE = 0.002; // 0.1% each way, in R terms it is small but not zero

const CONFIGS = [];
for (const down of [1, 1.5, 2, 2.5, 3]) {
  for (const rr of [1, 1.25, 1.5, 2, 2.5, 3]) CONFIGS.push({ down, up: +(down * rr).toFixed(2), rr });
}

const results = new Map();
for (const key of Object.keys(data)) {
  const iv = key.split(':')[1];
  const H = HMAP[iv];
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  if (c.length < 400) continue;
  const ind = computeAll(c);
  const from = Math.floor(c.length * 0.5);
  const step = Math.max(1, Math.floor(H / 2));
  for (const cfg of CONFIGS) {
    const id = `${iv}|${cfg.down}|${cfg.rr}`;
    let wins = 0, n = 0;
    for (let i = from; i < c.length - H * 4; i += step) {
      const b = tripleBarrier(c, i, ind.atr[i], { up: cfg.up, down: cfg.down, maxBars: H * 3 });
      if (b.label === null) continue;
      n++;
      if (b.touched === 'target') wins++;
      else if (b.touched === 'time' && b.label === 1) wins += 0.4; // partial: in profit but not at target
    }
    const prev = results.get(id) || { wins: 0, n: 0, ...cfg, iv };
    prev.wins += wins; prev.n += n;
    results.set(id, prev);
  }
}

const rows = [...results.values()].filter((r) => r.n >= 200).map((r) => {
  const p = r.wins / r.n;
  const ev = p * r.rr - (1 - p) * 1 - FEE;
  return { ...r, hitRate: +(p * 100).toFixed(1), ev: +ev.toFixed(3) };
});

const byIv = {};
for (const r of rows) (byIv[r.iv] = byIv[r.iv] || []).push(r);
for (const iv of Object.keys(byIv).sort()) {
  const best = byIv[iv].sort((a, b) => b.ev - a.ev).slice(0, 3);
  console.log(`\n${iv}  (best three of ${byIv[iv].length} configurations, ${byIv[iv][0].n} samples each)`);
  for (const r of best) console.log(`   stop ${r.down} ATR · target ${r.up} ATR (${r.rr}:1) → hit ${r.hitRate}%  EV ${r.ev > 0 ? '+' : ''}${r.ev} R`);
  const cur = byIv[iv].find((r) => Math.abs(r.down - 1.5) < 0.01 && Math.abs(r.rr - 2.5) < 0.01);
  if (cur) console.log(`   what the site ships now: stop 1.5 ATR · 2.5:1 → hit ${cur.hitRate}%  EV ${cur.ev > 0 ? '+' : ''}${cur.ev} R`);
}
