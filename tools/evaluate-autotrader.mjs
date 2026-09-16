// Measures the AI trader's actual ruleset on real candles, with a held-out half.
//
// The trader ships a stop/target pair that was never measured (1.5 ATR / 2.5R)
// while the coin page publishes a different, measured one (1 ATR / 3R on 1h).
// This grid replays the real replaySymbol() over 12 coins, tunes on the first
// half of history and reports every candidate on the second half, which it has
// never seen. Anything that only works in-sample is visible as the gap between
// the two columns.
import { readFileSync } from 'node:fs';
import { replaySymbol, newState, DEFAULT_CONFIG } from '../js/lib/autotrader.js';

const raw = JSON.parse(readFileSync(process.env.KLINES || 'klines.json', 'utf8'));
const IV = process.argv[2] || '1h';
const COINS = [...new Set(Object.keys(raw).filter((k) => k.endsWith(`:${IV}`)).map((k) => k.split(':')[0]))];

const load = (sym) => raw[`${sym}:${IV}`].map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));

function run(cfg, slice) {
  const st = newState(cfg);
  for (const sym of cfg.universe) {
    const all = load(sym);
    const c = slice === 'train' ? all.slice(0, Math.floor(all.length / 2)) : all.slice(Math.floor(all.length / 2) - 260);
    if (c.length < 260) continue;
    replaySymbol(st, cfg, sym, c);
  }
  const closed = st.closed;
  if (!closed.length) return { trades: 0, ret: 0, win: 0, pf: 0, fees: 0, expR: 0 };
  const wins = closed.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = -closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const fees = closed.reduce((a, t) => a + (t.feePaid || 0), 0);
  const riskCash = cfg.startingBalance * (cfg.riskPct / 100);
  return {
    trades: closed.length,
    ret: +(((st.balance - cfg.startingBalance) / cfg.startingBalance) * 100).toFixed(2),
    win: +((wins.length / closed.length) * 100).toFixed(1),
    pf: +(gl ? gp / gl : 0).toFixed(2),
    fees: +((fees / cfg.startingBalance) * 100).toFixed(2),
    expR: +((closed.reduce((a, t) => a + t.pnl, 0) / closed.length) / riskCash).toFixed(3),
  };
}

// The benchmark that matters: equal-weight buy-and-hold over the SAME window.
// A long-only strategy in a rising market looks clever for free; the only
// result worth anything is one that beats just owning the coins.
function buyHold(slice) {
  const rets = [];
  for (const sym of COINS) {
    const all = load(sym);
    const c = slice === 'train' ? all.slice(0, Math.floor(all.length / 2)) : all.slice(Math.floor(all.length / 2));
    if (c.length < 10) continue;
    rets.push((c[c.length - 1].c / c[0].c - 1) * 100);
  }
  return +(rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(2);
}
const BH = { train: buyHold('train'), test: buyHold('test') };
console.log(`BUY AND HOLD (equal weight, same window): train ${BH.train}%   test ${BH.test}%`);

const grid = [];
for (const atrStop of [1, 1.5, 2])
  for (const rMultiple of [1.5, 2, 3])
    for (const entryScore of [30, 50, 65])
      for (const breakEvenAtR of [1, null])
        for (const signalExitBars of [2, null])
          grid.push({ ...DEFAULT_CONFIG, universe: COINS, interval: IV, atrStop, rMultiple, entryScore, exitScore: -entryScore, breakEvenAtR, signalExitBars });

console.log(`interval ${IV} · ${COINS.length} coins · ${load(COINS[0]).length} candles each`);
console.log('stop R    e   be sx |   TRAIN ret  win   pf  trades |   TEST ret  win   pf  trades  fees  expR');
const rows = grid.map((cfg) => ({ cfg, tr: run(cfg, 'train'), te: run(cfg, 'test') }));
rows.sort((a, b) => b.tr.ret - a.tr.ret);
for (const r of rows.slice(0, 14)) {
  const { atrStop, rMultiple, entryScore, breakEvenAtR, signalExitBars } = r.cfg;
  console.log(`${String(atrStop).padEnd(4)} ${String(rMultiple).padEnd(4)} ${String(entryScore).padEnd(3)} ${(breakEvenAtR?'BE':'--')} ${(signalExitBars?'SX':'--')} | ${String(r.tr.ret).padStart(9)}% ${String(r.tr.win).padStart(5)} ${String(r.tr.pf).padStart(5)} ${String(r.tr.trades).padStart(6)} | ${String(r.te.ret).padStart(8)}% ${String(r.te.win).padStart(5)} ${String(r.te.pf).padStart(5)} ${String(r.te.trades).padStart(6)} ${String(r.te.fees).padStart(5)} ${String(r.te.expR).padStart(6)}`);
}
const ship = rows.find((r) => r.cfg.atrStop === 1.5 && r.cfg.rMultiple === 2.5 && r.cfg.entryScore === DEFAULT_CONFIG.entryScore) || rows.find((r) => r.cfg.atrStop === 1.5 && r.cfg.rMultiple === 2 && r.cfg.breakEvenAtR === 1 && r.cfg.signalExitBars === 2);
if (ship) console.log(`\nWHAT SHIPS NOW (${ship.cfg.atrStop} ATR / ${ship.cfg.rMultiple}R / entry ${ship.cfg.entryScore}):  train ${ship.tr.ret}%  test ${ship.te.ret}%  win ${ship.te.win}%  pf ${ship.te.pf}  trades ${ship.te.trades}  fees ${ship.te.fees}%  expR ${ship.te.expR}`);
const best = [...rows].sort((a, b) => b.te.ret - a.te.ret)[0];
console.log(`BEST ON TEST (may be luck): ${best.cfg.atrStop} ATR / ${best.cfg.rMultiple}R / entry ${best.cfg.entryScore} -> test ${best.te.ret}% (train ${best.tr.ret}%)`);
const medTest = rows.map(r=>r.te.ret).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
console.log(`MEDIAN test return across all ${rows.length} configs: ${medTest}%  |  configs positive on test: ${rows.filter(r=>r.te.ret>0).length}/${rows.length}`);
console.log(`BEATING BUY-AND-HOLD on test (${BH.test}%): ${rows.filter(r=>r.te.ret>BH.test).length}/${rows.length} configs`);
const pickTrain = rows[0];
console.log(`PICKED BY TRAIN ONLY -> ${pickTrain.cfg.atrStop} ATR / ${pickTrain.cfg.rMultiple}R / entry ${pickTrain.cfg.entryScore} / be=${pickTrain.cfg.breakEvenAtR ?? 'off'} / sx=${pickTrain.cfg.signalExitBars ?? 'off'}  =>  test ${pickTrain.te.ret}% vs buy-hold ${BH.test}%  (pf ${pickTrain.te.pf}, ${pickTrain.te.trades} trades, fees ${pickTrain.te.fees}%)`);
