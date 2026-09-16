// Scores the "compare a coin with its own past" matcher on real candles.
//
// For each coin and timeframe it replays historyMatch/backtestAnalog exactly as
// the Compare page runs them, and prints the hit-rate next to the majority-class
// baseline. The point is not to find a good number — it is to know the real one
// before the page shows anything.
import { readFileSync } from 'node:fs';
import { backtestAnalog, historyMatch, shapeFor } from '../js/lib/analog.js';

const DATA = process.argv[2] || `${process.env.HOME}/mnt/claude-projects/cv-data/klines.json`;
const raw = JSON.parse(readFileSync(DATA, 'utf8'));
const rows = [];
for (const key of Object.keys(raw)) {
  const [sym, iv] = key.split(':');
  if (!['1h', '4h', '1d'].includes(iv)) continue;
  const candles = raw[key].map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
  const s = backtestAnalog(candles, { interval: iv });
  const m = historyMatch(candles, { interval: iv });
  rows.push({ sym, iv, ...shapeFor(iv), n: candles.length,
    ok: s.ok, tests: s.tests, acc: s.accuracyPct, base: s.baselinePct, edge: s.edgePts,
    brier: s.brier, conf: s.confidentAccuracyPct, beats: s.beatsBaseline,
    live: m.ok ? `${m.upCount}/${m.matches.length} up, med ${m.medianPct}%` : m.reason.slice(0, 40) });
}
const by = {};
for (const r of rows) { (by[r.iv] ||= []).push(r); }
for (const iv of Object.keys(by)) {
  const g = by[iv];
  const wins = g.filter((r) => r.ok && r.beats).length;
  const scored = g.filter((r) => r.ok);
  const avgAcc = scored.reduce((a, r) => a + r.acc, 0) / scored.length;
  const avgBase = scored.reduce((a, r) => a + r.base, 0) / scored.length;
  const totTests = scored.reduce((a, r) => a + r.tests, 0);
  console.log(`\n=== ${iv}  window ${g[0].window} / horizon ${g[0].horizon} ===`);
  for (const r of g.sort((a, b) => b.edge - a.edge)) {
    console.log(`  ${r.sym.padEnd(5)} ${r.ok ? `${String(r.tests).padStart(3)} tests  acc ${String(r.acc).padStart(5)}%  base ${String(r.base).padStart(5)}%  edge ${r.edge >= 0 ? '+' : ''}${r.edge}  brier ${r.brier}  conf ${r.conf ?? '—'}` : 'not scoreable'}   live: ${r.live}`);
  }
  console.log(`  -> ${wins}/${scored.length} coins beat their own baseline; mean acc ${avgAcc.toFixed(1)}% vs base ${avgBase.toFixed(1)}% over ${totTests} tests`);
}
