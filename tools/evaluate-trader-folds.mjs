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
import { replaySeries, newState, DEFAULT_CONFIG, marketRegime, equity, dropTracker, rulesForChart, RULE_KEYS } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';
import { holdDrop } from './hold-drop.mjs';

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
// The rules each chart ships: the standard ones with that chart's tested exit
// changes (CHART_EXITS) and adopted rules (CHART_RULES), as an account trades them.
const shipped = (iv) => { const r = rulesForChart({ ...DEFAULT_CONFIG }, iv, []); return Object.fromEntries([...RULE_KEYS, 'marketFilter'].map((k) => [k, r[k]])); };

const prep = (sym, c) => { const ind = computeAll(c); return { symbol: sym, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) }; };

// One account, all coins, shared cash, from candle `from` of every series.
function account(rules, series, from, extra = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...rules, ...extra, excluded: [], universe: series.map((x) => x.symbol) };
  const st = newState(cfg);
  const run = series.map((x) => ({ ...x, regime: cfg.marketFilter ? x.regime : null }));
  for (const x of run) st.cursor[x.symbol] = x.candles[from - 1].t;
  // `dd` (worst drop from one closed trade to the next) is what the rules were
  // picked by; `ddMarked` values open trades at every close too — the fall an
  // account would actually have shown, and the figure the app publishes.
  const drop = dropTracker(st);
  replaySeries(st, cfg, run, { from, onBar: drop.onBar });
  const last = Object.fromEntries(run.map((x) => [x.symbol, x.candles.at(-1).c]));
  const eqEnd = equity(st, last) - Object.values(st.open).reduce((a, p) => a + (last[p.symbol] * p.qty * cfg.feePct) / 100, 0);
  let eq = cfg.startingBalance, peak = eq, dd = 0;
  for (const t of [...st.closed].sort((a, b) => a.exitAt - b.exitAt)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  dd = Math.max(dd, (peak - eqEnd) / peak);
  const wins = st.closed.filter((t) => t.pnl > 0).length;
  const fees = st.closed.reduce((a, t) => a + (t.feePaid || 0), 0);
  return { ret: (eqEnd / cfg.startingBalance - 1) * 100, dd: dd * 100, ddMarked: drop.worstDropPct(), trades: st.closed.length, win: st.closed.length ? (wins / st.closed.length) * 100 : 0, fees: (fees / cfg.startingBalance) * 100 };
}

const objective = (m) => (m.trades < 10 ? -Infinity : m.ret - 0.5 * m.dd);

// What followed each buy signal on its own: every coin run alone with one
// position at a time, so no signal is skipped for want of cash. R is the
// result over the risk taken at entry (fees included); `fwd` asks whether the
// price was higher H candles after the buy, `base` the same from every candle
// of the block; `rand` is a buy at a random candle of the block held as long.
const HZ = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };
function signalRecord(rules, series, from, H) {
  const o = { n: 0, wins: 0, sumR: 0, winR: 0, lossR: 0, holds: [], sumPct: 0, sumRand: 0, fwdUp: 0, fwdN: 0, baseUp: 0, baseN: 0 };
  for (const x of series) {
    const cfg = { ...DEFAULT_CONFIG, ...rules, excluded: [], universe: [x.symbol], maxPositions: 1, maxPositionPct: 100, startingBalance: 1e6 };
    const st = newState(cfg);
    st.cursor[x.symbol] = x.candles[from - 1].t;
    replaySeries(st, cfg, [{ ...x, regime: cfg.marketFilter ? x.regime : null }], { from });
    const c = x.candles, at = new Map(c.map((k, i) => [k.t, i]));
    for (let i = from; i + H < c.length; i++) { o.baseN++; if (c[i + H].c > c[i].c) o.baseUp++; }
    for (const t of st.closed) {
      const i = at.get(t.openedAt), j = at.get(t.exitAt);
      if (i === undefined || j === undefined) continue;
      const R = t.riskCash > 0 ? t.pnl / t.riskCash : 0;
      o.n++; o.sumR += R; o.sumPct += t.pnlPct;
      if (t.pnl > 0) { o.wins++; o.winR += R; } else o.lossR += R;
      o.holds.push(j - i);
      if (i + H < c.length) { o.fwdN++; if (c[i + H].c > c[i].c) o.fwdUp++; }
      let sum = 0, k = 0;
      for (let a = from; a + (j - i) < c.length; a++) { sum += c[a + (j - i)].c / c[a].c - 1; k++; }
      o.sumRand += k ? (sum / k) * 100 : 0;
    }
  }
  return o;
}
function mergeSignals(list, H) {
  const o = list.reduce((a, x) => ({ n: a.n + x.n, wins: a.wins + x.wins, sumR: a.sumR + x.sumR, winR: a.winR + x.winR, lossR: a.lossR + x.lossR, holds: a.holds.concat(x.holds), sumPct: a.sumPct + x.sumPct, sumRand: a.sumRand + x.sumRand, fwdUp: a.fwdUp + x.fwdUp, fwdN: a.fwdN + x.fwdN, baseUp: a.baseUp + x.baseUp, baseN: a.baseN + x.baseN }));
  const h = [...o.holds].sort((a, b) => a - b);
  const losses = o.n - o.wins;
  // 95% Wilson range of the share of buys followed by a higher price
  const z = 1.96, p = o.fwdN ? o.fwdUp / o.fwdN : 0, d = 1 + (z * z) / Math.max(1, o.fwdN);
  const mid = (p + (z * z) / (2 * Math.max(1, o.fwdN))) / d, half = (z * Math.sqrt((p * (1 - p)) / Math.max(1, o.fwdN) + (z * z) / (4 * Math.max(1, o.fwdN) ** 2))) / d;
  return {
    n: o.n, winPct: r2(o.n ? (o.wins / o.n) * 100 : 0), avgR: r2(o.n ? o.sumR / o.n : 0),
    avgWinR: r2(o.wins ? o.winR / o.wins : 0), avgLossR: r2(losses ? o.lossR / losses : 0),
    holdMedian: h.length ? h[Math.floor(h.length / 2)] : null,
    avgPct: r2(o.n ? o.sumPct / o.n : 0), randPct: r2(o.n ? o.sumRand / o.n : 0),
    H, fwdN: o.fwdN, fwdUpPct: r2(p * 100), fwdLo: r2((mid - half) * 100), fwdHi: r2((mid + half) * 100), baseUpPct: r2(o.baseN ? (o.baseUp / o.baseN) * 100 : 0),
  };
}
const RISKS = [0.5, 1, 1.5, 2, 3, 5];
const r2 = (v) => +v.toFixed(2);

const out = { measuredOn: new Date().toISOString().slice(0, 10), configs: grid.length, timeframes: {} };
for (const iv of IVS) {
  const STD = shipped(iv);
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
    const cur = account(STD, test, WARM), mine = account(pick, test, WARM);
    const hold = test.reduce((a, x) => a + (x.candles.at(-1).c / x.candles[WARM].c - 1), 0) / test.length * 100;
    const pack = (m) => ({ ret: r2(m.ret), dd: r2(m.dd), ddMarked: r2(m.ddMarked), trades: m.trades, win: r2(m.win), fees: r2(m.fees) });
    // the same block at other risk levels, for the expected-yield estimate:
    // both the chart's own pick and the standard rules, so whichever ships has one
    const byRisk = {};
    for (const risk of RISKS) byRisk[risk] = { own: pack(account(pick, test, WARM, { riskPct: risk })), standard: pack(account(STD, test, WARM, { riskPct: risk })) };
    const sig = { own: signalRecord(pick, test, WARM, HZ[iv]), standard: signalRecord(STD, test, WARM, HZ[iv]) };
    // the same block with volatility-scaled risk (DEFAULT_CONFIG.volScale)
    const vol = { own: pack(account(pick, test, WARM, { volScale: true })), standard: pack(account(STD, test, WARM, { volScale: true })) };
    // The same block with fills 0.05% worse each way (spread and slippage) on
    // top of the 0.1% fee: the tests otherwise fill at the candle's own price.
    const slip = { own: pack(account(pick, test, WARM, { feePct: 0.15 })), standard: pack(account(STD, test, WARM, { feePct: 0.15 })) };
    // the same block skipping entries whose fees are over a fifth of the stop distance
    const fee = { own: pack(account(pick, test, WARM, { maxFeeShare: 0.2 })), standard: pack(account(STD, test, WARM, { maxFeeShare: 0.2 })) };
    folds.push({ from: iso(tTrain), to: iso(Math.min(tEnd, times.at(-1))), pick: pick.tag, current: pack(cur), own: pack(mine), hold: r2(hold), holdDrop: r2(holdDrop(test, WARM)), coins: test.length, byRisk, sig, vol, slip, fee });
    console.error(`${iv} fold ${f} done`);
  }
  const mean = (k, m) => r2(folds.reduce((a, x) => a + x[k][m], 0) / folds.length);
  const better = folds.filter((x) => x.own.ret > x.current.ret).length;
  const adopt = better >= 2 && mean('own', 'ret') - mean('current', 'ret') >= 1 && mean('own', 'dd') <= mean('current', 'dd') + 5;
  console.log(`\n== ${iv}: ${coins.length} coins in one account, ${grid.length} rule sets`);
  for (const x of folds) console.log(`  test ${x.from} → ${x.to}: current ${String(x.current.ret).padStart(7)}% (dd ${x.current.dd}%, marked ${x.current.ddMarked}%, ${x.current.trades} trades)  own ${String(x.own.ret).padStart(7)}% (dd ${x.own.dd}%, marked ${x.own.ddMarked}%, ${x.own.trades} trades)  hold ${x.hold}% (drop ${x.holdDrop}%)   picked: ${x.pick}`);
  console.log(`  own better in ${better} of 3; average current ${mean('current', 'ret')}% (dd ${mean('current', 'dd')}%) vs own ${mean('own', 'ret')}% (dd ${mean('own', 'dd')}%) → ${adopt ? 'ADOPT' : 'KEEP CURRENT'}`);
  const sum = (k, m) => folds.reduce((a, x) => a + x[k][m], 0);
  const summary = (k) => ({ ret: mean(k, 'ret'), dd: mean(k, 'dd'), ddMarked: mean(k, 'ddMarked'), trades: sum(k, 'trades'), win: r2(folds.reduce((a, x) => a + x[k].win * x[k].trades, 0) / Math.max(1, sum(k, 'trades'))), fees: mean(k, 'fees') });
  const entry = { coins: coins.length, from: folds[0].from, to: folds.at(-1).to, folds, better, current: summary('current'), own: summary('own'), hold: r2(folds.reduce((a, x) => a + x.hold, 0) / folds.length), holdDrop: r2(folds.reduce((a, x) => a + x.holdDrop, 0) / folds.length), adopt };
  console.log(`  worst drop with open trades valued at every close: current ${entry.current.ddMarked}%, own ${entry.own.ddMarked}%, holding the coins ${entry.holdDrop}% (average of the blocks)`);
  // average, worst and best block at each risk level — for both rule sets, so
  // the app has the figures for whichever it ships (15m has flipped between runs)
  const which = adopt ? 'own' : 'standard';
  const riskTable = (k) => Object.fromEntries(RISKS.map((risk) => {
    const rs = folds.map((x) => x.byRisk[risk][k]);
    const avg = (f) => r2(rs.reduce((a, m) => a + m[f], 0) / rs.length);
    return [risk, { ret: avg('ret'), lo: r2(Math.min(...rs.map((m) => m.ret))), hi: r2(Math.max(...rs.map((m) => m.ret))), dd: avg('dd'), ddMarked: avg('ddMarked'), up: rs.filter((m) => m.ret > 0).length, trades: Math.round(rs.reduce((a, m) => a + m.trades, 0) / rs.length) }];
  }));
  entry.byRisk = riskTable(which);
  entry.byRiskBoth = { own: riskTable('own'), standard: riskTable('standard') };
  console.log(`  by risk per trade (${which} rules): ${RISKS.map((risk) => `${risk}% → ${entry.byRisk[risk].ret}% (worst block ${entry.byRisk[risk].lo}%, drop ${entry.byRisk[risk].dd}%, marked ${entry.byRisk[risk].ddMarked}%)`).join(' · ')}`);
  // both, so the record of whichever rules the app ships exists even when a
  // re-run decides the other way (15m has flipped between runs)
  entry.signals = Object.fromEntries(['own', 'standard'].map((k) => [k, mergeSignals(folds.map((x) => x.sig[k]), HZ[iv])]));
  for (const k of ['own', 'standard']) {
    const sg = entry.signals[k];
    console.log(`  each buy on its own (${k} rules): ${sg.n} buys, ${sg.winPct}% won, average ${sg.avgR}R (wins ${sg.avgWinR}R, losses ${sg.avgLossR}R), ${sg.avgPct}% a trade against ${sg.randPct}% for a random buy held as long, median hold ${sg.holdMedian} candles; higher ${sg.H} candles later ${sg.fwdUpPct}% (95% ${sg.fwdLo}–${sg.fwdHi}%) against ${sg.baseUpPct}% from any candle`);
  }
  for (const x of folds) delete x.sig;
  // Volatility-scaled risk, A/B on the rules this chart ships (SHIPPED, not this
  // run's adopt flag, which has flipped on 15m between runs). Decided before the
  // run: on for a chart only if, block by block, it improves return − ½·worst
  // drop (the objective the rules were picked by) in at least 2 of 3 blocks, by
  // at least 1 point on average, with an average return no more than 1 point
  // below the same rules without it.
  const SHIPPED = { '15m': 'standard', '1h': 'standard', '4h': 'standard', '1d': 'standard' }; // every chart since 2026-10-15 (106 coins)
  const sw = SHIPPED[iv] || which;
  const baseOf = (x) => (sw === 'own' ? x.own : x.current);
  const obj = (m) => m.ret - 0.5 * m.dd;
  const vb = folds.filter((x) => obj(x.vol[sw]) > obj(baseOf(x))).length;
  const vMean = (f) => r2(folds.reduce((a, x) => a + f(x), 0) / folds.length);
  const gain = vMean((x) => obj(x.vol[sw]) - obj(baseOf(x)));
  const retDiff = vMean((x) => x.vol[sw].ret - baseOf(x).ret);
  entry.volScale = { rules: sw, better: vb, objGain: gain, retDiff, ddDiff: vMean((x) => x.vol[sw].dd - baseOf(x).dd), adopt: vb >= 2 && gain >= 1 && retDiff >= -1,
    ddMarkedDiff: vMean((x) => x.vol[sw].ddMarked - baseOf(x).ddMarked),
    folds: folds.map((x) => ({ without: { ret: baseOf(x).ret, dd: baseOf(x).dd, ddMarked: baseOf(x).ddMarked }, with: { ret: x.vol[sw].ret, dd: x.vol[sw].dd, ddMarked: x.vol[sw].ddMarked } })) };
  console.log(`  volatility-scaled risk (${sw} rules): better in ${vb} of 3; return ${retDiff >= 0 ? '+' : ''}${retDiff} pts, worst drop ${entry.volScale.ddDiff >= 0 ? '+' : ''}${entry.volScale.ddDiff} pts, objective ${gain >= 0 ? '+' : ''}${gain} → ${entry.volScale.adopt ? 'ADOPT' : 'KEEP OFF'}`);
  for (const x of folds) delete x.vol;
  // Skipping entries whose fees in and out are over a fifth of the distance to
  // the stop, A/B on the shipped rules. Decided before the run, with the same
  // bar as the volatility-scaled risk: on for a chart only if it improves
  // return − ½·worst drop in at least 2 of 3 blocks, by at least 1 point on
  // average, with an average return no more than 1 point below without it.
  const fb = folds.filter((x) => obj(x.fee[sw]) > obj(baseOf(x))).length;
  const fGain = vMean((x) => obj(x.fee[sw]) - obj(baseOf(x)));
  const fRet = vMean((x) => x.fee[sw].ret - baseOf(x).ret);
  entry.feeFilter = { rules: sw, maxFeeShare: 0.2, better: fb, objGain: fGain, retDiff: fRet, ddDiff: vMean((x) => x.fee[sw].dd - baseOf(x).dd),
    ddMarkedDiff: vMean((x) => x.fee[sw].ddMarked - baseOf(x).ddMarked), tradesDiff: vMean((x) => x.fee[sw].trades - baseOf(x).trades),
    adopt: fb >= 2 && fGain >= 1 && fRet >= -1,
    folds: folds.map((x) => ({ without: { ret: baseOf(x).ret, dd: baseOf(x).dd, trades: baseOf(x).trades }, with: { ret: x.fee[sw].ret, dd: x.fee[sw].dd, trades: x.fee[sw].trades } })) };
  console.log(`  skip trades whose fees are over a fifth of the stop distance (${sw} rules): better in ${fb} of 3; return ${fRet >= 0 ? '+' : ''}${fRet} pts, worst drop ${entry.feeFilter.ddDiff >= 0 ? '+' : ''}${entry.feeFilter.ddDiff} pts, trades ${entry.feeFilter.tradesDiff >= 0 ? '+' : ''}${entry.feeFilter.tradesDiff} a block, objective ${fGain >= 0 ? '+' : ''}${fGain} → ${entry.feeFilter.adopt ? 'ADOPT' : 'KEEP OFF'}`);
  for (const x of folds) delete x.fee;
  // what the shipped rules made with worse fills (no decision rides on it)
  const sOf = (x) => (sw === 'own' ? x.slip.own : x.slip.standard);
  entry.slippage = { rules: sw, extraPct: 0.05, ret: vMean((x) => sOf(x).ret), dd: vMean((x) => sOf(x).ddMarked), retLost: vMean((x) => baseOf(x).ret - sOf(x).ret) };
  console.log(`  fills 0.05% worse each way (${sw} rules): ${entry.slippage.ret}% a block (${entry.slippage.retLost} points less), worst drop ${entry.slippage.dd}%`);
  for (const x of folds) delete x.slip;
  if (adopt) {
    // what this chart would get: the same pick on the full history
    const full = withRegime(coins.map((s) => prep(s, all[s])));
    entry.rules = grid.map((g) => ({ g, m: account(g, full, 210) })).sort((a, b) => objective(b.m) - objective(a.m))[0].g;
    console.log(`  rules picked on the full history: ${entry.rules.tag}`);
  }
  out.timeframes[iv] = entry;
}
console.log(`\nJSON ${JSON.stringify(out)}`);
