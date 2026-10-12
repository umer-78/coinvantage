// usage: node tools/evaluate-selection.mjs klines.json
//
// Two ways of choosing what to trade, each chosen on OLDER candles and
// reported on NEWER candles that played no part in the choice:
//
// 1. Strongest-coins rotation (js/lib/rotation.js): hold the coins that rose
//    most over a look-back window, re-ranked on a schedule, cash while Bitcoin
//    is in a downtrend. 240 settings; one is picked by its result on the older
//    half (return minus half the worst drawdown, at least 10 trades).
// 2. Per-coin rules for the AI trader: every coin trades the rule set that did
//    best on ITS OWN older half, against one rule set picked for all coins.
//    Each coin gets an equal, separate account in both arms, so the only
//    difference is the choice of rules.
//
// Decided in advance: rotation is offered in the app only if the setting
// picked on the older half beats holding the same coins on the newer half on
// the daily chart, after fees. Per-coin rules are adopted only if they beat
// the shared rule set on the newer half on at least two of three timeframes.
import { readFileSync } from 'node:fs';
import { alignSeries, rotationReplay, buyAndHold } from '../js/lib/rotation.js';
import { replaySeries, newState, DEFAULT_CONFIG, equity } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const only = process.argv[3]; // 'rotation' | 'percoin' | undefined (both)
const candlesOf = (k) => raw[k].map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
const ivs = (want) => want.filter((iv) => Object.keys(raw).some((k) => k.endsWith(`:${iv}`)));
const PER_DAY = { '1h': 24, '4h': 6, '1d': 1 };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const objective = (m, min = 10) => (m.trades < min ? -Infinity : m.ret - 0.5 * m.dd);
const out = { measuredOn: new Date().toISOString().slice(0, 10) };

// ---------------------------------------------------------------- rotation
if (only !== 'percoin') {
  out.rotation = {};
  for (const iv of ivs(['4h', '1d'])) {
    const by = {};
    for (const k of Object.keys(raw).filter((x) => x.endsWith(`:${iv}`))) by[k.split(':')[0]] = candlesOf(k);
    const A = alignSeries(by, 'BTC');
    const n = A.times.length, d = PER_DAY[iv];
    const grid = [];
    for (const L of [7, 14, 30, 60, 90]) for (const R of [1, 3, 7]) for (const K of [1, 2, 3, 5]) for (const btcFilter of [true, false]) for (const absolute of [true, false]) {
      grid.push({ lookback: L * d, every: R * d, top: K, btcFilter, absolute, feePct: 0.1, startingBalance: 10000, tag: `${L}d look-back, every ${R}d, top ${K}${btcFilter ? ', BTC filter' : ''}${absolute ? ', rising only' : ''}` });
    }
    const warm = 90 * d + 210;
    const mid = Math.floor((n + warm) / 2);
    const halves = { older: { from: warm, to: mid }, newer: { from: mid, to: n } };
    const rows = grid.map((cfg) => ({ cfg, older: rotationReplay(A, cfg, halves.older), newer: rotationReplay(A, cfg, halves.newer) }));
    const pick = [...rows].sort((a, b) => objective(b.older) - objective(a.older))[0];
    const bhAll = { older: buyAndHold(A, halves.older), newer: buyAndHold(A, halves.newer) };
    const bhBtc = { older: buyAndHold(A, { ...halves.older, symbols: ['BTC'] }), newer: buyAndHold(A, { ...halves.newer, symbols: ['BTC'] }) };
    const news = rows.map((r) => r.newer.ret).sort((a, b) => a - b);
    const f = (m) => `ret ${String(m.ret).padStart(8)}%  dd ${String(m.dd).padStart(6)}%  trades ${String(m.trades).padStart(4)}  fees ${m.feesPct}%  invested ${m.investedPct}% of the time`;
    console.log(`\n== ROTATION ${iv}: ${Object.keys(by).length} coins; older ${iso(A.times[warm])} → ${iso(A.times[mid - 1])}, newer ${iso(A.times[mid])} → ${iso(A.times[n - 1])}`);
    console.log(`  hold every coin equally: older ${bhAll.older}%  newer ${bhAll.newer}%   hold BTC: older ${bhBtc.older}%  newer ${bhBtc.newer}%`);
    console.log(`  PICKED on older: ${pick.cfg.tag}`);
    console.log(`    older ${f(pick.older)}`);
    console.log(`    NEWER ${f(pick.newer)}`);
    console.log(`  all ${rows.length} settings on the newer half: median ${news[Math.floor(news.length / 2)]}%, ${news.filter((x) => x > bhAll.newer).length} beat holding every coin, ${news.filter((x) => x > 0).length} made money`);
    for (const r of [...rows].sort((a, b) => objective(b.older) - objective(a.older)).slice(1, 4)) console.log(`  next best on older (${r.cfg.tag}) NEWER ${f(r.newer)}`);
    // Bitcoin's own drawdown on the newer half, for scale
    let pk = 0, ddb = 0;
    for (let i = mid; i < n; i++) { const c = A.closes.BTC[i]; pk = Math.max(pk, c); ddb = Math.max(ddb, (pk - c) / pk); }
    out.rotation[iv] = { coins: Object.keys(by).length, from: iso(A.times[mid]), to: iso(A.times[n - 1]), picked: pick.cfg.tag, settings: { lookbackDays: pick.cfg.lookback / d, everyDays: pick.cfg.every / d, top: pick.cfg.top, btcFilter: pick.cfg.btcFilter, absolute: pick.cfg.absolute }, older: { ret: pick.older.ret, dd: pick.older.dd }, newer: { ret: pick.newer.ret, dd: pick.newer.dd, trades: pick.newer.trades, feesPct: pick.newer.feesPct, investedPct: pick.newer.investedPct }, holdAll: bhAll.newer, holdBtc: bhBtc.newer, btcDd: +(ddb * 100).toFixed(2), medianAll: news[Math.floor(news.length / 2)], beatHold: news.filter((x) => x > bhAll.newer).length, of: rows.length };
  }
}

// ---------------------------------------------------------------- per-coin rules
if (only !== 'rotation') {
  out.perCoin = {};
  const WARM = 260;
  const grid = [];
  for (const entryMode of ['trend', 'breakout', 'pullback'])
    for (const momentumConfirm of entryMode === 'pullback' ? [false] : [false, true])
      for (const trendFilter of entryMode === 'pullback' ? [true] : [false, true])
        for (const atrStop of [1.5, 2, 3])
          for (const exit of ['r2', 'r3', 't3', 't4'])
            for (const signalExitBars of [2, null])
              grid.push({ ...DEFAULT_CONFIG, entryMode, momentumConfirm, trendFilter, marketFilter: false, atrStop, rMultiple: exit[0] === 'r' ? +exit[1] : 3, trailAtr: exit[0] === 't' ? +exit[1] : null, signalExitBars, maxPositions: 1, excluded: [], tag: `${entryMode}${momentumConfirm ? '+confirm' : ''} ${trendFilter ? 'TF' : '--'} ${atrStop}ATR ${exit} ${signalExitBars ? 'SX' : '--'}` });
  const solo = (cfg, x, from) => {
    const st = newState(cfg);
    st.cursor[x.symbol] = x.candles[from - 1].t;
    replaySeries(st, cfg, [x], { from });
    const last = x.candles.at(-1).c;
    const eqEnd = equity(st, { [x.symbol]: last }) - Object.values(st.open).reduce((a, p) => a + (last * p.qty * cfg.feePct) / 100, 0);
    let eq = cfg.startingBalance, peak = eq, dd = 0;
    for (const t of st.closed) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
    dd = Math.max(dd, (peak - eqEnd) / peak);
    return { ret: (eqEnd / cfg.startingBalance - 1) * 100, dd: dd * 100, trades: st.closed.length };
  };
  for (const iv of ivs(['1h', '4h', '1d'])) {
    const coins = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length > 2 * WARM + 200).map((k) => k.split(':')[0]);
    const prep = coins.map((s) => {
      const all = candlesOf(`${s}:${iv}`);
      const half = Math.floor(all.length / 2);
      const mk = (c) => { const ind = computeAll(c); return { symbol: s, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) }; };
      return { s, older: mk(all.slice(0, half)), newer: mk(all.slice(half - WARM)), bh: (all.at(-1).c / all[half].c - 1) * 100 };
    });
    // every rule set on every coin's older half
    const olderRes = grid.map((cfg) => prep.map((p) => solo({ ...cfg, universe: [p.s], interval: iv }, p.older, 210)));
    // one rule set for all: the best average objective across coins
    const shared = grid.map((cfg, j) => ({ j, score: olderRes[j].reduce((a, m) => a + Math.max(-100, objective(m, 5)), 0) / prep.length })).sort((a, b) => b.score - a.score)[0].j;
    // each coin its own: its best rule set, or the shared one when none traded enough
    const own = prep.map((_, c) => {
      let best = shared, bs = objective(olderRes[shared][c], 5);
      grid.forEach((_, j) => { const v = objective(olderRes[j][c], 5); if (v > bs) { bs = v; best = j; } });
      return best;
    });
    const newer = (j, c) => solo({ ...grid[j], universe: [prep[c].s], interval: iv }, prep[c].newer, WARM);
    const sharedNew = prep.map((_, c) => newer(shared, c));
    const ownNew = prep.map((_, c) => newer(own[c], c));
    const avg = (a, k) => +(a.reduce((x, m) => x + m[k], 0) / a.length).toFixed(2);
    const bh = +(prep.reduce((a, p) => a + p.bh, 0) / prep.length).toFixed(2);
    const wins = ownNew.filter((m, c) => m.ret > sharedNew[c].ret).length;
    console.log(`\n== PER-COIN RULES ${iv}: ${prep.length} coins, each in its own equal account; ${grid.length} rule sets`);
    console.log(`  shared rule set (picked on older halves): ${grid[shared].tag}`);
    console.log(`  NEWER  shared: avg ret ${avg(sharedNew, 'ret')}%  avg dd ${avg(sharedNew, 'dd')}%  trades ${sharedNew.reduce((a, m) => a + m.trades, 0)}`);
    console.log(`  NEWER  own:    avg ret ${avg(ownNew, 'ret')}%  avg dd ${avg(ownNew, 'dd')}%  trades ${ownNew.reduce((a, m) => a + m.trades, 0)}   own beat shared on ${wins} of ${prep.length} coins`);
    console.log(`  NEWER  hold each coin: avg ${bh}%`);
    for (let c = 0; c < prep.length; c++) console.log(`    ${prep[c].s.padEnd(6)} own ${grid[own[c]].tag.padEnd(30)} newer ${ownNew[c].ret.toFixed(1).padStart(7)}%   shared ${sharedNew[c].ret.toFixed(1).padStart(7)}%`);
    out.perCoin[iv] = { coins: prep.length, shared: grid[shared].tag, sharedRet: avg(sharedNew, 'ret'), sharedDd: avg(sharedNew, 'dd'), ownRet: avg(ownNew, 'ret'), ownDd: avg(ownNew, 'dd'), ownBeatShared: wins, hold: bh };
  }
}
// ---------------------------------------------------------------- per-coin rules, walk-forward
// A second, stricter test of per-coin rules, added after the single split
// above passed only narrowly. Each coin's history is cut into four blocks;
// rules are chosen on everything before a block and tested on that block,
// three times. Per-coin rules are adopted on a timeframe only if they beat the
// shared rule set in at least two of the three folds there, by at least one
// point on average, and on more than half of all coin-and-fold pairs. (The
// first draft of this bar, two folds and any average lead, passed on random-
// walk candles where no coin can have rules of its own, so it was tightened
// before the real candles were run.)
if (only !== 'rotation') {
  out.perCoinFolds = {};
  const WARM = 260;
  const grid = [];
  for (const entryMode of ['trend', 'breakout', 'pullback'])
    for (const momentumConfirm of entryMode === 'pullback' ? [false] : [false, true])
      for (const trendFilter of entryMode === 'pullback' ? [true] : [false, true])
        for (const atrStop of [1.5, 2, 3])
          for (const exit of ['r2', 'r3', 't3', 't4'])
            for (const signalExitBars of [2, null])
              grid.push({ ...DEFAULT_CONFIG, entryMode, momentumConfirm, trendFilter, marketFilter: false, atrStop, rMultiple: exit[0] === 'r' ? +exit[1] : 3, trailAtr: exit[0] === 't' ? +exit[1] : null, signalExitBars, maxPositions: 1, excluded: [], tag: `${entryMode}${momentumConfirm ? '+confirm' : ''} ${trendFilter ? 'TF' : '--'} ${atrStop}ATR ${exit} ${signalExitBars ? 'SX' : '--'}` });
  const prepSlice = (s, c) => { const ind = computeAll(c); return { symbol: s, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) }; };
  const solo = (cfg, x, from) => {
    const st = newState(cfg);
    st.cursor[x.symbol] = x.candles[from - 1].t;
    replaySeries(st, cfg, [x], { from });
    const last = x.candles.at(-1).c;
    const eqEnd = equity(st, { [x.symbol]: last }) - Object.values(st.open).reduce((a, p) => a + (last * p.qty * cfg.feePct) / 100, 0);
    let eq = cfg.startingBalance, peak = eq, dd = 0;
    for (const t of st.closed) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
    dd = Math.max(dd, (peak - eqEnd) / peak);
    return { ret: (eqEnd / cfg.startingBalance - 1) * 100, dd: dd * 100, trades: st.closed.length };
  };
  for (const iv of ivs(['1h', '4h', '1d'])) {
    const coins = Object.keys(raw).filter((k) => k.endsWith(`:${iv}`) && raw[k].length >= 1600).map((k) => k.split(':')[0]);
    const folds = [];
    for (const f of [1, 2, 3]) {
      const sets = coins.map((s) => {
        const all = candlesOf(`${s}:${iv}`);
        const cut = (k) => Math.floor((all.length * k) / 4);
        return { s, train: prepSlice(s, all.slice(0, cut(f))), test: prepSlice(s, all.slice(cut(f) - WARM, cut(f + 1))) };
      });
      const res = grid.map((cfg) => sets.map((x) => solo({ ...cfg, universe: [x.s], interval: iv }, x.train, 210)));
      const shared = grid.map((_, j) => ({ j, v: res[j].reduce((a, m) => a + Math.max(-100, objective(m, 5)), 0) })).sort((a, b) => b.v - a.v)[0].j;
      const own = sets.map((_, c) => { let best = shared, bs = objective(res[shared][c], 5); grid.forEach((_, j) => { const v = objective(res[j][c], 5); if (v > bs) { bs = v; best = j; } }); return best; });
      const test = (j, c) => solo({ ...grid[j], universe: [sets[c].s], interval: iv }, sets[c].test, WARM);
      const sh = sets.map((_, c) => test(shared, c)), ow = sets.map((_, c) => test(own[c], c));
      const avg = (a) => +(a.reduce((x, m) => x + m.ret, 0) / a.length).toFixed(2);
      const t0 = sets[0].test.candles[WARM].t, t1 = sets[0].test.candles.at(-1).t;
      folds.push({ from: iso(t0), to: iso(t1), shared: avg(sh), own: avg(ow), ownWins: ow.filter((m, c) => m.ret > sh[c].ret).length, coins: sets.length });
      console.error(`${iv} fold ${f} done`);
    }
    const better = folds.filter((x) => x.own > x.shared).length;
    const mean = (k) => +(folds.reduce((a, x) => a + x[k], 0) / folds.length).toFixed(2);
    const pairs = folds.reduce((a, x) => a + x.coins, 0), wins = folds.reduce((a, x) => a + x.ownWins, 0);
    const adopt = better >= 2 && mean('own') - mean('shared') >= 1 && wins * 2 > pairs;
    console.log(`\n== PER-COIN RULES, WALK-FORWARD ${iv} (${coins.length} coins)`);
    for (const x of folds) console.log(`  test ${x.from} → ${x.to}: own ${String(x.own).padStart(7)}%  shared ${String(x.shared).padStart(7)}%  own better on ${x.ownWins} of ${x.coins} coins`);
    console.log(`  own better in ${better} of 3 folds and on ${wins} of ${pairs} coin-folds; average own ${mean('own')}% vs shared ${mean('shared')}% → ${adopt ? 'ADOPT' : 'REJECT'}`);
    out.perCoinFolds[iv] = { folds, better, wins, pairs, own: mean('own'), shared: mean('shared'), adopt };
  }
}
console.log(`\nJSON ${JSON.stringify(out)}`);
