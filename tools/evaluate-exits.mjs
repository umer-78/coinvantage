// usage: node tools/evaluate-exits.mjs klines.json
//
// When should the AI trader sell? The entry rules stay as each chart ships
// them (rulesForChart); only the exits change: the stop distance, a fixed
// target (1.5R to 5R) or a trailing stop instead, a stop moved to the entry
// once a trade is 1R up, and selling after 1 to 3 candles that read against
// the trade (or never). Every chart's history is cut into four blocks; three
// times the exits with the best result on everything before a block (all coins
// in one account, shared cash, the app's sizing) run on that block next to the
// current exits. Every run pays the 0.1% fee plus 0.05% for worse fills each
// way, the cost of real orders the app's tests count.
//
// Decided before the run: a chart's exits change only if the picked ones beat
// the current exits in at least two of the three blocks, by at least one point
// a block on average, with an average worst drop (open trades valued at every
// close) no more than five points deeper. And, as with every published rule,
// only when two runs in a row agree.
//
// It also breaks down what each kind of exit did under the current rules
// (how many trades ended that way and their average result in R), which is
// where a selling rule that costs money shows up.
import { readFileSync } from 'node:fs';
import { replaySeries, newState, DEFAULT_CONFIG, marketRegime, equity, dropTracker, rulesForChart } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const WARM = 260;
const COST = 0.15; // fee 0.1% + fills 0.05% worse, each way
const IVS = ['15m', '1h', '4h', '1d'].filter((iv) => Object.keys(raw).some((k) => k.endsWith(`:${iv}`)));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const r2 = (v) => +v.toFixed(2);
const candlesOf = (k) => raw[k].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));

const grid = [];
for (const atrStop of [2, 3, 4])
  for (const exit of ['r1.5', 'r2', 'r3', 'r5', 't2', 't3'])
    for (const breakEvenAtR of [null, 1])
      for (const signalExitBars of [null, 1, 2, 3]) {
        const target = exit[0] === 'r' ? +exit.slice(1) : null;
        grid.push({
          atrStop, rMultiple: target ?? 3, trailAtr: target === null ? +exit.slice(1) : null, breakEvenAtR, signalExitBars,
          tag: `${atrStop}ATR stop · ${target === null ? `trail ${exit.slice(1)}ATR` : `target ${target}R`} · ${breakEvenAtR ? 'BE at 1R' : 'no BE'} · ${signalExitBars ? `sell after ${signalExitBars} weak` : 'no signal sell'}`,
        });
      }
const EXIT_KEYS = ['atrStop', 'rMultiple', 'trailAtr', 'breakEvenAtR', 'signalExitBars'];

const prep = (sym, c) => { const ind = computeAll(c); return { symbol: sym, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) }; };

function account(base, exits, series, from) {
  const cfg = { ...base, ...exits, feePct: COST, excluded: [], universe: series.map((x) => x.symbol) };
  const st = newState(cfg);
  const run = series.map((x) => ({ ...x, regime: cfg.marketFilter ? x.regime : null }));
  for (const x of run) st.cursor[x.symbol] = x.candles[from - 1].t;
  const drop = dropTracker(st);
  replaySeries(st, cfg, run, { from, onBar: drop.onBar });
  const last = Object.fromEntries(run.map((x) => [x.symbol, x.candles.at(-1).c]));
  const eqEnd = equity(st, last) - Object.values(st.open).reduce((a, p) => a + (last[p.symbol] * p.qty * cfg.feePct) / 100, 0);
  const why = {};
  for (const t of st.closed) {
    const R = t.riskCash > 0 ? t.pnl / t.riskCash : 0;
    const w = (why[t.reason] ||= { n: 0, sumR: 0, wins: 0 });
    w.n++; w.sumR += R; if (t.pnl > 0) w.wins++;
  }
  return { ret: (eqEnd / cfg.startingBalance - 1) * 100, dd: drop.worstDropPct(), trades: st.closed.length, win: st.closed.length ? (st.closed.filter((t) => t.pnl > 0).length / st.closed.length) * 100 : 0, why };
}
const objective = (m) => (m.trades < 10 ? -Infinity : m.ret - 0.5 * m.dd);

const out = { measuredOn: new Date().toISOString().slice(0, 10), configs: grid.length, cost: COST, charts: {} };
for (const iv of IVS) {
  const coins = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length >= 1600).map((k) => k.split(':')[0]);
  if (!coins.includes('BTC')) continue;
  const base = rulesForChart({ ...DEFAULT_CONFIG }, iv, []);
  const current = Object.fromEntries(EXIT_KEYS.map((k) => [k, base[k]]));
  const all = Object.fromEntries(coins.map((s) => [s, candlesOf(`${s}:${iv}`)]));
  const times = all.BTC.map((c) => c.t);
  const cutT = (k) => times[Math.floor((times.length * k) / 4)];
  const slice = (s, t0, t1) => all[s].filter((c) => c.t < t1 && (t0 === null || c.t >= t0));
  const withRegime = (series) => { const btc = series.find((x) => x.symbol === 'BTC'); const reg = marketRegime(btc?.candles); for (const x of series) x.regime = reg; return series; };
  const folds = [];
  for (const f of [1, 2, 3]) {
    const tTrain = cutT(f), tEnd = f === 3 ? Infinity : cutT(f + 1);
    const train = withRegime(coins.map((s) => slice(s, null, tTrain)).map((c, j) => (c.length > WARM + 50 ? prep(coins[j], c) : null)).filter(Boolean));
    const test = withRegime(coins.map((s) => { const c = all[s]; const i0 = c.findIndex((x) => x.t >= tTrain); if (i0 < WARM) return null; const block = c.slice(i0 - WARM).filter((x) => x.t < tEnd); return block.length > WARM + 20 ? prep(s, block) : null; }).filter(Boolean));
    const pick = grid.map((g) => ({ g, m: account(base, g, train, 210) })).sort((a, b) => objective(b.m) - objective(a.m))[0].g;
    const cur = account(base, current, test, WARM), mine = account(base, pick, test, WARM);
    folds.push({ from: iso(tTrain), to: iso(Math.min(tEnd, times.at(-1))), pick: pick.tag, pickExits: Object.fromEntries(EXIT_KEYS.map((k) => [k, pick[k]])), current: cur, own: mine, coins: test.length });
    console.error(`${iv} fold ${f} done`);
  }
  const mean = (k, m) => r2(folds.reduce((a, x) => a + x[k][m], 0) / folds.length);
  const better = folds.filter((x) => x.own.ret > x.current.ret).length;
  const adopt = better >= 2 && mean('own', 'ret') - mean('current', 'ret') >= 1 && mean('own', 'dd') <= mean('current', 'dd') + 5;
  // what each kind of exit did under the current rules, all three blocks together
  const why = {};
  for (const x of folds) for (const [k, w] of Object.entries(x.current.why)) { const a = (why[k] ||= { n: 0, sumR: 0, wins: 0 }); a.n += w.n; a.sumR += w.sumR; a.wins += w.wins; }
  const whyOut = Object.fromEntries(Object.entries(why).sort((a, b) => b[1].n - a[1].n).map(([k, w]) => [k, { n: w.n, avgR: r2(w.sumR / w.n), totalR: r2(w.sumR), won: r2((w.wins / w.n) * 100) }]));
  console.log(`\n== ${iv}: ${folds[0].coins} coins in one account, ${grid.length} exit sets, after ${COST}% a side`);
  console.log(`  current exits: ${Object.entries(current).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const x of folds) console.log(`  test ${x.from} → ${x.to}: current ${String(r2(x.current.ret)).padStart(7)}% (drop ${r2(x.current.dd)}%, ${x.current.trades} trades)  picked ${String(r2(x.own.ret)).padStart(7)}% (drop ${r2(x.own.dd)}%, ${x.own.trades} trades)   picked: ${x.pick}`);
  console.log(`  picked better in ${better} of 3; average current ${mean('current', 'ret')}% (drop ${mean('current', 'dd')}%) vs picked ${mean('own', 'ret')}% (drop ${mean('own', 'dd')}%) → ${adopt ? 'CHANGE (needs a second run that agrees)' : 'KEEP CURRENT'}`);
  console.log(`  how trades ended under the current exits: ${Object.entries(whyOut).map(([k, w]) => `${k} ${w.n} (avg ${w.avgR}R, total ${w.totalR}R, ${w.won}% won)`).join(' · ')}`);
  out.charts[iv] = {
    coins: folds[0].coins, from: folds[0].from, to: folds.at(-1).to, current, better, adopt,
    currentAvg: { ret: mean('current', 'ret'), dd: mean('current', 'dd') }, pickedAvg: { ret: mean('own', 'ret'), dd: mean('own', 'dd') },
    folds: folds.map((x) => ({ from: x.from, to: x.to, pick: x.pick, pickExits: x.pickExits, current: { ret: r2(x.current.ret), dd: r2(x.current.dd), trades: x.current.trades }, picked: { ret: r2(x.own.ret), dd: r2(x.own.dd), trades: x.own.trades } })),
    exits: whyOut,
  };
  // the exits an adopting chart would get: picked the same way on all its history
  if (adopt) {
    const full = withRegime(coins.map((s) => (all[s].length > WARM + 50 ? prep(s, all[s]) : null)).filter(Boolean));
    out.charts[iv].final = grid.map((g) => ({ g, m: account(base, g, full, 210) })).sort((a, b) => objective(b.m) - objective(a.m))[0].g;
    console.log(`  exits it would get, picked on all the history: ${out.charts[iv].final.tag}`);
  }
}
console.log(`\nJSON ${JSON.stringify(out)}`);
