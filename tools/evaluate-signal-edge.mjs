// Does the signal actually pick better bars than entering at random?
//
// The geometry sweep measured expectancy entering at EVERY bar. That told us the
// exits were losing, but it never asked the more important question: when the
// engine says "Buy" with a score of 40, is that trade better than one taken at a
// random moment? If the answer is no, the signal is decoration and the site
// should say so. If yes, the threshold can be raised until the timeframes that
// currently lose money stop losing it.
//
// usage: node tools/evaluate-signal-edge.mjs klines.json
import fs from 'node:fs';
import { generateSignal, geometryFor } from '../js/lib/signals.js';
import { tripleBarrier } from '../js/lib/barrier.js';
import { computeAll } from '../js/lib/indicators.js';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const HMAP = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
const FEE = 0.002;
const BUCKETS = [-100, -45, -18, 0, 18, 30, 45, 60, 101];

const acc = new Map(); // iv|bucket -> { wins, n }
const all = new Map(); // iv -> { wins, n }  (every bar, the control)

for (const key of Object.keys(data)) {
  const iv = key.split(':')[1];
  const H = HMAP[iv];
  const geo = geometryFor(iv);
  const c = data[key].map(([t, o, h, l, cc, v]) => ({ t, o, h, l, c: cc, v }));
  if (c.length < 600) continue;
  const ind = computeAll(c);
  const from = Math.floor(c.length * 0.5);
  const step = Math.max(1, Math.floor(H / 2));

  for (let i = from; i < c.length - H * 4; i += step) {
    const b = tripleBarrier(c, i, ind.atr[i], { up: geo.stopAtr * geo.rr, down: geo.stopAtr, maxBars: H * 3 });
    if (b.label === null) continue;
    const win = b.touched === 'target' ? 1 : b.touched === 'time' && b.label === 1 ? 0.4 : 0;

    const ctrl = all.get(iv) || { wins: 0, n: 0, rr: geo.rr };
    ctrl.wins += win; ctrl.n++; all.set(iv, ctrl);

    // the signal as the site computes it, using only candles up to this bar
    const sig = generateSignal(c.slice(Math.max(0, i - 499), i + 1), { interval: iv });
    if (!sig.ok) continue;
    const bi = BUCKETS.findIndex((edge, k) => sig.score >= edge && sig.score < (BUCKETS[k + 1] ?? 101));
    const id = `${iv}|${bi}`;
    const cell = acc.get(id) || { wins: 0, n: 0, rr: geo.rr, lo: BUCKETS[bi], hi: BUCKETS[bi + 1] };
    cell.wins += win; cell.n++; acc.set(id, cell);
  }
  console.error(key, 'done');
}

const ev = (p, rr) => p * rr - (1 - p) * 1 - FEE;
for (const iv of ['15m', '1h', '4h', '1d']) {
  const ctrl = all.get(iv);
  if (!ctrl) continue;
  const cp = ctrl.wins / ctrl.n;
  console.log(`\n${iv}  (reward:risk ${ctrl.rr}:1)`);
  console.log(`   every bar (control): hit ${(cp * 100).toFixed(1)}%  EV ${ev(cp, ctrl.rr) >= 0 ? '+' : ''}${ev(cp, ctrl.rr).toFixed(3)} R   n=${ctrl.n}`);
  for (let k = 0; k < BUCKETS.length - 1; k++) {
    const cell = acc.get(`${iv}|${k}`);
    if (!cell || cell.n < 60) continue;
    const p = cell.wins / cell.n;
    const e = ev(p, cell.rr);
    const lift = p / cp;
    console.log(`   score ${String(cell.lo).padStart(4)}..${String(cell.hi - 1).padStart(4)}: hit ${(p * 100).toFixed(1)}%  EV ${e >= 0 ? '+' : ''}${e.toFixed(3)} R  lift ×${lift.toFixed(2)}  n=${cell.n}`);
  }
}
