// usage: node tools/evaluate-trader-folds.mjs klines.json
//
// Should each chart have its own AI-trader rules? The app uses one rule set on
// every chart (tools/evaluate-trader-rules.mjs picked it by its average rank
// across all four). Here each chart gets its own pick instead, tested
// walk-forward: every coin's history is cut into four blocks, and three times
// the rule set with the best result on everything before a block (all coins
// in one account, shared cash, the app's sizing and fees) is run on that block
// next to the app's current rules.
//
// Decided before the run: a chart gets its own rules only if they beat the
// current rules in at least two of the three blocks, by at least one point
// on average, with an average worst drop no more than five points deeper.
// The rules it would then get are picked the same way on the full history.
import { readFileSync } from 'node:fs';
import { replaySeries, newState, DEFAULT_CONFIG, marketRegime, equity } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const WARM = 260;
const IVS = ['15m', '1h', '4h', '1d'].filter((iv) => Object.keys(raw).some((k) => k.endsWith(`:${iv}`)));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const candlesOf = (k) => raw[k].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));

const grid = [];
for (const entryMode of ['trend', 'breakout', 'pullback'])
  for (const momentumConfirm of entryMode === 'pullback' ? [false] : [false, true])
    for (const trendFilter of entryMode === 'pullback' ? [true] : [false, true])
      for (const marketFilter of [false, true])
        for (const atrStop of [1.5, 2, 3])
          for (const exit of ['r2', 'r3', 't3', 't4'])
            for (const signalExitBars of [2, null]) {
              const tag = `${entryMode}${momentumConfirm ? '+confirm' : ''} ${trendFilter ? 'TF' : '--'} ${marketFilter ? 'MF' : '--'} ${atrStop}ATR ${exit} ${signalExitBars ? 'SX' : '--'}`;
              grid.push({ entryMode, momentumConfirm, trendFilter, marketFilter, atrStop, rMultiple: exit[0] === 'r' ? +exit[1] : 3, trailAtr: exit[0] === 't' ? +exit[1] : null, signalExitBars, tag });
            }
const CURRENT = { tag: 'current app rules' };

const prep = (sym, c) => { const ind = computeAll(c); return { symbol: sym, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) }; };

// One account, all coins, shared cash, from candle `from` of every series.
function account(rules, series, from) {
  const cfg = { ...DEFAULT_CONFIG, ...rules, excluded: [], universe: series.map((x) => x.symbol) };
  const st = newState(cfg);
  const run = series.map((x) => ({ ...x, regime: cfg.marketFilter ? x.regime : null }));
  for (const x of run) st.cursor[x.symbol] = x.candles[from - 1].t;
  replaySeries(st, cfg, run, { from });
  const last = Object.fromEntries(run.map((x) => [x.symbol, x.candles.at(-1).c]));
  const eqEnd = equity(st, last) - Object.values(st.open).reduce((a, p) => a + (last[p.symbol] * p.qty * cfg.feePct) / 100, 0);
  let eq = cfg.startingBalance, peak = eq, dd = 0;
  for (const t of [...st.closed].sort((a, b) => a.exitAt - b.exitAt)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  dd = Math.max(dd, (peak - eqEnd) / peak);
  const wins = st.closed.filter((t) => t.pnl > 0).length;
  const fees = st.closed.reduce((a, t) => a + (t.feePaid || 0), 0);
  return { ret: (eqEnd / cfg.startingBalance - 1) * 100, dd: dd * 100, trades: st.closed.length, win: st.closed.length ? (wins / st.closed.length) * 100 : 0, fees: (fees / cfg.startingBalance) * 100 };
}
const objective = (m) => (m.trades < 10 ? -Infinity : m.ret - 0.5 * m.dd);
const r2 = (v) => +v.toFixed(2);

const out = { measuredOn: new Date().toISOString().slice(0, 10), configs: grid.length, timeframes: {} };
for (const iv of IVS) {
  const coins = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length >= 1600).map((k) => k.split(':')[0]);
  if (!coins.includes('BTC')) continue;
  const all = Object.fromEntries(coins.map((s) => [s, candlesOf(`${s}:${iv}`)]));
  // blocks are cut on Bitcoin's clock so every coin's block covers the same dates
  const times = all.BTC.map((c) => c.t);
  const cutT = (k) => times[Math.floor((times.length * k) / 4)];
  const slice = (s, t0, t1) => all[s].filter((c) => c.t < t1 && (t0 === null || c.t >= t0));
  const withRegime = (series) => { const btc = series.find((x) => x.symbol === 'BTC'); const reg = marketRegime(btc?.candles); for (const x of series) x.regime = reg; return series; };
  const folds = [];
  for (const f of [1, 2, 3]) {
    const tTrain = cutT(f), tEnd = f === 3 ? Infinity : cutT(f + 1);
    const train = withRegime(coins.map((s) => slice(s, null, tTrain)).map((c, j) => (c.length > WARM + 50 ? prep(coins[j], c) : null)).filter(Boolean));
    // the test block plus WARM candles before it, which only warm the indicators up
    const test = withRegime(coins.map((s) => { const c = all[s]; const i0 = c.findIndex((x) => x.t >= tTrain); if (i0 < WARM) return null; const block = c.slice(i0 - WARM).filter((x) => x.t < tEnd); return block.length > WARM + 20 ? prep(s, block) : null; }).filter(Boolean));
    const scored = grid.map((g) => ({ g, m: account(g, train, 210) }));
    const pick = scored.sort((a, b) => objective(b.m) - objective(a.m))[0].g;
    const cur = account({}, test, WARM), mine = account(pick, test, WARM);
    const hold = test.reduce((a, x) => a + (x.candles.at(-1).c / x.candles[WARM].c - 1), 0) / test.length * 100;
    const pack = (m) => ({ ret: r2(m.ret), dd: r2(m.dd), trades: m.trades, win: r2(m.win), fees: r2(m.fees) });
    folds.push({ from: iso(tTrain), to: iso(Math.min(tEnd, times.at(-1))), pick: pick.tag, current: pack(cur), own: pack(mine), hold: r2(hold), coins: test.length });
    console.error(`${iv} fold ${f} done`);
  }
  const mean = (k, m) => r2(folds.reduce((a, x) => a + x[k][m], 0) / folds.length);
  const better = folds.filter((x) => x.own.ret > x.current.ret).length;
  const adopt = better >= 2 && mean('own', 'ret') - mean('current', 'ret') >= 1 && mean('own', 'dd') <= mean('current', 'dd') + 5;
  console.log(`\n== ${iv}: ${coins.length} coins in one account, ${grid.length} rule sets`);
  for (const x of folds) console.log(`  test ${x.from} → ${x.to}: current ${String(x.current.ret).padStart(7)}% (dd ${x.current.dd}%, ${x.current.trades} trades)  own ${String(x.own.ret).padStart(7)}% (dd ${x.own.dd}%, ${x.own.trades} trades)  hold ${x.hold}%   picked: ${x.pick}`);
  console.log(`  own better in ${better} of 3; average current ${mean('current', 'ret')}% (dd ${mean('current', 'dd')}%) vs own ${mean('own', 'ret')}% (dd ${mean('own', 'dd')}%) → ${adopt ? 'ADOPT' : 'KEEP CURRENT'}`);
  const sum = (k, m) => folds.reduce((a, x) => a + x[k][m], 0);
  const summary = (k) => ({ ret: mean(k, 'ret'), dd: mean(k, 'dd'), trades: sum(k, 'trades'), win: r2(folds.reduce((a, x) => a + x[k].win * x[k].trades, 0) / Math.max(1, sum(k, 'trades'))), fees: mean(k, 'fees') });
  const entry = { coins: coins.length, from: folds[0].from, to: folds.at(-1).to, folds, better, current: summary('current'), own: summary('own'), hold: r2(folds.reduce((a, x) => a + x.hold, 0) / folds.length), adopt };
  if (adopt) {
    // what this chart would get: the same pick on the full history
    const full = withRegime(coins.map((s) => prep(s, all[s])));
    entry.rules = grid.map((g) => ({ g, m: account(g, full, 210) })).sort((a, b) => objective(b.m) - objective(a.m))[0].g;
    console.log(`  rules picked on the full history: ${entry.rules.tag}`);
  }
  out.timeframes[iv] = entry;
}
console.log(`\nJSON ${JSON.stringify(out)}`);
