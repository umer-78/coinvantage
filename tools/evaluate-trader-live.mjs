// usage: node tools/evaluate-trader-live.mjs <interval> <checkEveryCandles=1> klines.json
// Held-out test of the AI trader, simulated the way it actually runs live:
// all coins advance together through time (a check every STEP candles), so the
// position limit and the balance interact across coins as they do in the app.
// (tools/evaluate-autotrader.mjs replays one coin's whole history before the
// next, which lets the first coin's open trade block every other coin.)
import { readFileSync } from 'node:fs';
import { replaySymbol, newState, DEFAULT_CONFIG } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';
import { reviewTrades, decideChanges } from '../js/lib/tradelearn.js';

const raw = JSON.parse(readFileSync(process.argv[4] || 'klines.json', 'utf8'));
const IV = process.argv[2] || '1h';
const STEP = +(process.argv[3] || 6);
const COINS = [...new Set(Object.keys(raw).filter((k) => k.endsWith(`:${IV}`)).map((k) => k.split(':')[0]))];
const load = (s) => raw[`${s}:${IV}`].map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
const slices = {};
for (const s of COINS) {
  const all = load(s), half = Math.floor(all.length / 2);
  for (const [name, c] of [['train', all.slice(0, half)], ['test', all.slice(half - 260)]]) {
    const ind = computeAll(c);
    const scores = c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0));
    (slices[name] ||= {})[s] = { c, pre: { ind, atr: atr(c, 14), scores } };
  }
}
function metrics(st, cfg) {
  const cl = st.closed, wins = cl.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -cl.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...cl].sort((a, b) => a.exitAt - b.exitAt)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const fees = cl.reduce((a, t) => a + (t.feePaid || 0), 0);
  return { ret: +(((st.balance - cfg.startingBalance) / cfg.startingBalance) * 100).toFixed(2), trades: cl.length, win: cl.length ? +((wins.length / cl.length) * 100).toFixed(1) : 0, pf: gl ? +(gp / gl).toFixed(2) : 0, dd: +((dd / cfg.startingBalance) * 100).toFixed(2), fees: +((fees / cfg.startingBalance) * 100).toFixed(2) };
}
// Walk time forward; `onCheck` may change cfg (the self-review).
function run(cfg0, name, { review = false, reviewEvery = 20 } = {}) {
  const cfg = { ...cfg0, excluded: [...(cfg0.excluded || [])] };
  const st = newState(cfg);
  const lessons = [];
  const ser = COINS.map((s) => slices[name][s]);
  const start = name === 'test' ? 260 : 210;
  const times = ser[0].c.slice(start).map((x) => x.t);
  let checks = 0;
  for (let k = 0; k < times.length; k += STEP) {
    const until = times[Math.min(k + STEP - 1, times.length - 1)];
    COINS.forEach((s, j) => {
      const c = ser[j].c;
      let n = c.findIndex((x) => x.t > until); if (n < 0) n = c.length;
      replaySymbol(st, cfg, s, c.slice(0, n), ser[j].pre);
    });
    if (review && ++checks % reviewEvery === 0) {
      const d = decideChanges(reviewTrades(st.closed), cfg, lessons, st.closed, { excludeCoins: !!process.env.EXCL });
      if (d.changes.length) { Object.assign(cfg, d.cfgPatch); for (const ch of d.changes) lessons.push({ at: until, lens: ch.lens, text: ch.text, undo: ch.undo }); }
    }
  }
  return { m: metrics(st, cfg), lessons };
}
function buyHold(name) {
  const r = COINS.map((s) => { const c = slices[name][s].c.slice(name === 'test' ? 260 : 210); return (c.at(-1).c / c[0].c - 1) * 100; });
  return +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(2);
}
const base = { ...DEFAULT_CONFIG, universe: COINS, interval: IV };
const grid = [];
for (const atrStop of [1.5, 2, 3])
  for (const exit of ['r2', 'r3', 't3', 't4'])
    for (const trendFilter of [false, true])
      for (const signalExitBars of [2, null])
        grid.push({ ...base, atrStop, rMultiple: exit[0] === 'r' ? +exit[1] : 3, trailAtr: exit[0] === 't' ? +exit[1] : null, trendFilter, signalExitBars, tag: `${atrStop}ATR ${exit} ${trendFilter ? 'TF' : '--'} ${signalExitBars ? 'SX' : '--'}` });
const rows = grid.map((cfg) => ({ cfg, tr: run(cfg, 'train').m, te: run(cfg, 'test').m }));
const BH = { train: buyHold('train'), test: buyHold('test') };
const f = (r) => `ret ${String(r.ret).padStart(7)}%  dd ${String(r.dd).padStart(6)}%  pf ${String(r.pf).padStart(5)}  win ${String(r.win).padStart(5)}  n ${String(r.trades).padStart(4)}  fees ${r.fees}%`;
console.log(`== ${IV}  ${COINS.length} coins  check every ${STEP} candles  buy&hold train ${BH.train}%  test ${BH.test}%`);
const shipped = rows.find((r) => r.cfg.atrStop === 2 && r.cfg.rMultiple === 3 && !r.cfg.trailAtr && !r.cfg.trendFilter && r.cfg.signalExitBars === 2);
const oldPick = [...rows].filter((r) => !r.cfg.trailAtr && !r.cfg.trendFilter).sort((a, b) => b.tr.ret - a.tr.ret)[0];
const newPick = [...rows].sort((a, b) => b.tr.ret - a.tr.ret)[0];
const riskPick = [...rows].sort((a, b) => (b.tr.ret - 0.5 * b.tr.dd) - (a.tr.ret - 0.5 * a.tr.dd))[0];
const current = rows.find((r) => r.cfg.tag === '3ATR r3 TF SX');
for (const [name, r] of [['CURRENT (ships)', current], ['PREVIOUS', shipped], ['BEST OLD RULES (train pick)', oldPick], ['BEST WITH NEW RULES (train pick)', newPick], ['BEST RETURN-DRAWDOWN (train pick)', riskPick]])
  console.log(`${name.padEnd(34)} ${r.cfg.tag.padEnd(18)} TRAIN ${f(r.tr)} | TEST ${f(r.te)}`);
const agg = (pred) => { const s = rows.filter(pred); const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]; return `n=${s.length} median test ret ${med(s.map((r) => r.te.ret))}% dd ${med(s.map((r) => r.te.dd))}%`; };
console.log('  trend filter off:', agg((r) => !r.cfg.trendFilter), '| on:', agg((r) => r.cfg.trendFilter));
console.log('  fixed target:    ', agg((r) => !r.cfg.trailAtr), '| trailing:', agg((r) => r.cfg.trailAtr));
console.log(`  configs beating buy&hold on test: ${rows.filter((r) => r.te.ret > BH.test).length}/${rows.length}`);
for (const [label, start] of [['CURRENT', current], ['PREVIOUS', shipped]]) {
  const sr = run(start.cfg, 'test', { review: true });
  console.log(`${(label + ' + SELF-REVIEW').padEnd(34)} ${start.cfg.tag.padEnd(18)} ${' '.repeat(80)} | TEST ${f(sr.m)}`);
  for (const l of sr.lessons) console.log('     lesson:', l.text);
}
console.log('JSON', JSON.stringify({ iv: IV, bh: BH, current: current.te, previous: shipped.te, oldPick: { tag: oldPick.cfg.tag, ...oldPick.te }, newPick: { tag: newPick.cfg.tag, ...newPick.te }, riskPick: { tag: riskPick.cfg.tag, ...riskPick.te }, beat: rows.filter((r) => r.te.ret > BH.test).length, configs: rows.length }));
