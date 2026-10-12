// usage: node tools/evaluate-trader-rules.mjs klines.json
//
// Chooses the AI trader's rules without peeking at the result it reports.
// Every candidate set of rules is run on the OLDER half of each coin's history
// on four timeframes; one set is picked by its average rank there (return minus
// half the worst drawdown); only then is it run on the NEWER half, which played
// no part in the choice. That newer-half result is what the app publishes.
//
// All coins advance together, candle by candle, with the same engine the live
// account uses (js/lib/autotrader.js), fees included. Open positions at the end
// are valued at the last close, less the fee to sell.
import { readFileSync } from 'node:fs';
import { replaySeries, newState, DEFAULT_CONFIG, marketRegime, equity } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';
import { scoreAt } from '../js/lib/signals.js';

const raw = JSON.parse(readFileSync(process.argv[2] || 'klines.json', 'utf8'));
const IVS = ['15m', '1h', '4h', '1d'].filter((iv) => Object.keys(raw).some((k) => k.endsWith(`:${iv}`)));
const WARM = 260;

function prepare(iv) {
  const coins = [...new Set(Object.keys(raw).filter((k) => k.endsWith(`:${iv}`)).map((k) => k.split(':')[0]))]
    .filter((s) => raw[`${s}:${iv}`].length > 2 * WARM);
  const halves = { train: [], test: [] };
  for (const s of coins) {
    const all = raw[`${s}:${iv}`].map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
    const half = Math.floor(all.length / 2);
    for (const [name, c] of [['train', all.slice(0, half)], ['test', all.slice(half - WARM)]]) {
      const ind = computeAll(c);
      halves[name].push({ symbol: s, candles: c, ind, atr: atr(c, 14), scores: c.map((_, i) => (i >= 210 ? scoreAt(c, ind, i).score : 0)) });
    }
  }
  for (const name of ['train', 'test']) {
    const btc = halves[name].find((x) => x.symbol === 'BTC');
    const regime = marketRegime(btc?.candles);
    for (const x of halves[name]) x.regime = regime;
  }
  return { coins, halves };
}

function run(cfg, data, name) {
  const st = newState(cfg);
  const series = data.halves[name].map((x) => ({ ...x, regime: cfg.marketFilter ? x.regime : null }));
  // the test half's first WARM candles only warm the indicators up
  const from = name === 'test' ? WARM : 210;
  for (const s of series) st.cursor[s.symbol] = s.candles[from - 1].t;
  replaySeries(st, cfg, series, { from });
  const last = Object.fromEntries(series.map((s) => [s.symbol, s.candles.at(-1).c]));
  const sellFees = Object.values(st.open).reduce((a, p) => a + (last[p.symbol] * p.qty * cfg.feePct) / 100, 0);
  const eqEnd = equity(st, last) - sellFees;
  const cl = st.closed, wins = cl.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -cl.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  let eq = cfg.startingBalance, peak = eq, dd = 0;
  for (const t of [...cl].sort((a, b) => a.exitAt - b.exitAt)) { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  dd = Math.max(dd, (peak - eqEnd) / peak);
  const fees = cl.reduce((a, t) => a + (t.feePaid || 0), 0);
  const r2 = (v) => +v.toFixed(2);
  return { ret: r2((eqEnd / cfg.startingBalance - 1) * 100), dd: r2(dd * 100), trades: cl.length, win: cl.length ? r2((wins.length / cl.length) * 100) : 0, pf: gl ? r2(gp / gl) : null, fees: r2((fees / cfg.startingBalance) * 100) };
}

function buyHold(data, name) {
  const from = name === 'test' ? WARM : 210;
  const r = data.halves[name].map((x) => x.candles.at(-1).c / x.candles[from].c - 1);
  return +((r.reduce((a, b) => a + b, 0) / r.length) * 100).toFixed(2);
}

const grid = [];
for (const entryMode of ['trend', 'breakout', 'pullback'])
  for (const momentumConfirm of entryMode === 'pullback' ? [false] : [false, true])
    for (const trendFilter of entryMode === 'pullback' ? [true] : [false, true])
      for (const marketFilter of [false, true])
        for (const atrStop of [1.5, 2, 3])
          for (const exit of ['r2', 'r3', 't3', 't4'])
            for (const signalExitBars of [2, null]) {
              const tag = `${entryMode}${momentumConfirm ? '+confirm' : ''} ${trendFilter ? 'TF' : '--'} ${marketFilter ? 'MF' : '--'} ${atrStop}ATR ${exit} ${signalExitBars ? 'SX' : '--'}`;
              grid.push({ ...DEFAULT_CONFIG, entryMode, momentumConfirm, trendFilter, marketFilter, atrStop, rMultiple: exit[0] === 'r' ? +exit[1] : 3, trailAtr: exit[0] === 't' ? +exit[1] : null, signalExitBars, maxPositions: 5, excluded: [], tag });
            }
const CURRENT = grid.find((g) => g.tag === `${DEFAULT_CONFIG.entryMode} ${DEFAULT_CONFIG.trendFilter ? 'TF' : '--'} -- ${DEFAULT_CONFIG.atrStop}ATR r${DEFAULT_CONFIG.rMultiple} SX`);

// A rule set that hardly trades scores about 0%, which beats every losing one,
// so it needs at least this many trades on the older half to be ranked.
const MIN_TRADES = 10;
const objective = (m) => (m.trades < MIN_TRADES ? -Infinity : m.ret - 0.5 * m.dd);
const byIv = {};
for (const iv of IVS) {
  const data = prepare(iv);
  const rows = grid.map((cfg) => ({ cfg, tr: run({ ...cfg, universe: data.coins, interval: iv }, data, 'train'), te: run({ ...cfg, universe: data.coins, interval: iv }, data, 'test') }));
  [...rows].sort((a, b) => objective(b.tr) - objective(a.tr)).forEach((r, i) => { r.rank = i + 1; });
  byIv[iv] = { rows, bh: { train: buyHold(data, 'train'), test: buyHold(data, 'test') }, coins: data.coins.length, bars: data.halves.test[0].candles.length - WARM, from: data.halves.test[0].candles[WARM].t, to: data.halves.test[0].candles.at(-1).t };
  console.error(`${iv}: ${rows.length} rule sets on ${data.coins.length} coins`);
}

// One set of rules for every timeframe, picked on the older halves only.
const avgRank = grid.map((cfg, j) => ({ cfg, rank: IVS.reduce((a, iv) => a + byIv[iv].rows[j].rank, 0) / IVS.length, j }));
avgRank.sort((a, b) => a.rank - b.rank);
const pick = avgRank[0];
const f = (m) => `ret ${String(m.ret).padStart(7)}%  dd ${String(m.dd).padStart(6)}%  pf ${String(m.pf ?? '—').padStart(5)}  win ${String(m.win).padStart(5)}%  n ${String(m.trades).padStart(4)}  fees ${m.fees}%`;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
console.log(`PICKED (best average rank on the older halves): ${pick.cfg.tag}  (average rank ${pick.rank.toFixed(1)} of ${grid.length})`);
console.log(`CURRENT: ${CURRENT.tag}`);
const out = { measuredOn: new Date().toISOString().slice(0, 10), pick: pick.cfg.tag, current: CURRENT.tag, configs: grid.length, timeframes: {} };
for (const iv of IVS) {
  const b = byIv[iv];
  const P = b.rows[pick.j], C = b.rows[grid.indexOf(CURRENT)];
  const tes = b.rows.map((r) => r.te.ret).sort((x, y) => x - y);
  const med = tes[Math.floor(tes.length / 2)];
  console.log(`\n== ${iv}  ${b.coins} coins, newer half ${iso(b.from)} → ${iso(b.to)} (${b.bars} candles)  buy & hold: older ${b.bh.train}%  newer ${b.bh.test}%`);
  console.log(`  PICKED   older ${f(P.tr)}`);
  console.log(`  PICKED   NEWER ${f(P.te)}`);
  console.log(`  CURRENT  older ${f(C.tr)}`);
  console.log(`  CURRENT  NEWER ${f(C.te)}`);
  console.log(`  all ${grid.length} rule sets on the newer half: median ${med}%, ${tes.filter((x) => x > 0).length} made money, ${b.rows.filter((r) => r.te.ret > b.bh.test).length} beat buy & hold`);
  const top = [...b.rows].sort((a, c) => a.rank - c.rank).slice(0, 3);
  for (const r of top) console.log(`  best on older (${r.cfg.tag})  NEWER ${f(r.te)}`);
  out.timeframes[iv] = { coins: b.coins, from: iso(b.from), to: iso(b.to), buyHold: b.bh.test, picked: P.te, current: C.te, medianAll: med, madeMoney: tes.filter((x) => x > 0).length, beatBuyHold: b.rows.filter((r) => r.te.ret > b.bh.test).length };
}
console.log(`\nJSON ${JSON.stringify(out)}`);
