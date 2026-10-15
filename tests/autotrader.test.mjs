// The AI trader's engine: what a live account does one check at a time must
// match a replay, it never invests money it does not have, and coins advance
// together in time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySymbol, replaySeries, newState, rescaleAccount, openManual, closeManual, freeCash, DEFAULT_CONFIG, dropTracker, stats } from '../js/lib/autotrader.js';
import { computeAll, atr } from '../js/lib/indicators.js';

const H = 3600e3;
const T0 = Date.UTC(2026, 0, 1);
// A steady climb with small swings: above the 200 EMA, 50 above 200.
function climb(n, t0 = T0) {
  const out = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const c = 100 * Math.pow(1.002, i) * (1 + 0.004 * Math.sin(i / 2));
    out.push({ t: t0 + i * H, o: prev, h: Math.max(prev, c) * 1.001, l: Math.min(prev, c) * 0.999, c, v: 1000 });
    prev = c;
  }
  return out;
}
// Scores are scripted so each test controls exactly when the rules fire.
function prepared(symbol, candles, scoreAt) {
  return { symbol, candles, ind: computeAll(candles), atr: atr(candles, 14), scores: candles.map((_, i) => scoreAt(i)) };
}
const cfgWith = (o) => ({ ...DEFAULT_CONFIG, trailAtr: null, breakEvenAtR: null, rMultiple: 50, atrStop: 30, ...o });

test('a live account checking one candle at a time exits on a signal reversal like a replay does', () => {
  const candles = climb(320);
  const s = prepared('A', candles, (i) => (i === 250 ? 40 : i === 270 || i === 271 ? -40 : 0));
  const cfg = cfgWith({ signalExitBars: 2 });
  const batch = newState(cfg);
  replaySymbol(batch, cfg, 'A', candles, s);
  const live = newState(cfg);
  for (let n = 221; n <= candles.length; n++) replaySymbol(live, cfg, 'A', candles.slice(0, n), s);
  assert.equal(batch.closed.length, 1);
  assert.equal(batch.closed[0].reason, 'signal reversal');
  assert.equal(batch.closed[0].exitAt, candles[271].t);
  // the count of reversal bars used to restart with every check, so live never exited
  assert.deepEqual(live.closed.map((t) => [t.reason, t.exitAt]), batch.closed.map((t) => [t.reason, t.exitAt]));
});

test('a new trade does not inherit the previous trade\'s reversal count', () => {
  const candles = climb(320);
  // bar 260 closes trade 1 (two reversal bars 259-260)... trade 2 opens at 262,
  // then one reversal bar at 265 must not close it.
  const s = prepared('A', candles, (i) => (i === 250 || i === 262 ? 40 : i === 259 || i === 260 || i === 265 ? -40 : 0));
  const cfg = cfgWith({ signalExitBars: 2 });
  const st = newState(cfg);
  replaySymbol(st, cfg, 'A', candles, s);
  assert.equal(st.closed.length, 1);
  assert.ok(st.open.A, 'second trade still open');
});

test('positions never add up to more cash than the account has', () => {
  const syms = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const series = syms.map((sym) => prepared(sym, climb(300), (i) => (i === 250 ? 40 : 0)));
  const cfg = cfgWith({ maxPositions: 10, riskPct: 10, maxPositionPct: 25 });
  const st = newState(cfg);
  replaySeries(st, cfg, series);
  const invested = Object.values(st.open).reduce((a, p) => a + p.notional, 0);
  assert.ok(Object.keys(st.open).length >= 4, 'it still trades');
  assert.ok(invested <= st.balance + 0.01, `invested ${invested.toFixed(2)} of a ${st.balance.toFixed(2)} balance`);
  assert.ok(freeCash(st) >= -0.01, "to the cent");
});

test('coins advance together: the earlier signal gets the only slot', () => {
  const a = prepared('A', climb(300), (i) => (i === 260 ? 40 : 0));
  // B's candles are an hour earlier, so its signal at the same index comes first
  const b = prepared('B', climb(300, T0 - H), (i) => (i === 260 ? 40 : 0));
  const cfg = cfgWith({ maxPositions: 1 });
  const st = newState(cfg);
  replaySeries(st, cfg, [a, b]);
  assert.deepEqual(Object.keys(st.open), ['B']);
});

test('pullback mode buys a dip in an uptrend and sells into strength', () => {
  const candles = climb(320);
  const s = prepared('A', candles, (i) => (i === 250 ? -40 : i === 270 || i === 271 ? 40 : 0));
  const cfg = cfgWith({ entryMode: 'pullback', signalExitBars: 2 });
  const st = newState(cfg);
  replaySymbol(st, cfg, 'A', candles, s);
  assert.equal(st.closed.length, 1);
  assert.equal(st.closed[0].openedAt, candles[250].t);
  assert.equal(st.closed[0].reason, 'sold into strength');
  // trend mode ignores the same dip
  const t = newState(cfgWith({}));
  replaySymbol(t, cfgWith({}), 'A', candles, s);
  assert.equal(t.closed.length + Object.keys(t.open).length, 1, 'trend mode buys the +40 at 270 only');
  assert.notEqual((t.closed[0] || t.open.A).openedAt, candles[250].t);
});

test('the market filter blocks new buys while Bitcoin is in a downtrend', () => {
  const candles = climb(300);
  const s = prepared('A', candles, (i) => (i === 250 ? 40 : 0));
  const regime = new Map(candles.map((c) => [c.t, false]));
  const cfg = cfgWith({ marketFilter: true });
  const st = newState(cfg);
  replaySeries(st, cfg, [{ ...s, regime }]);
  assert.equal(Object.keys(st.open).length, 0);
  const ok = newState(cfg);
  replaySeries(ok, cfg, [{ ...s, regime: new Map(candles.map((c) => [c.t, true])) }]);
  assert.equal(Object.keys(ok.open).length, 1);
});

test('a manual demo buy cannot spend cash already in open positions', () => {
  const cfg = { ...DEFAULT_CONFIG, maxPositions: 10 };
  const st = newState(cfg);
  for (const sym of ['A', 'B', 'C', 'D']) assert.ok(openManual(st, cfg, sym, 10, { notional: 2490 }).ok);
  const r = openManual(st, cfg, 'E', 10, { notional: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /free/);
  assert.equal(openManual(st, cfg, 'E', 10, { notional: freeCash(st) }).ok, false, 'the fee must fit too');
  assert.ok(openManual(st, cfg, 'E', 10, { notional: freeCash(st) / 1.001 - 0.01 }).ok);
  assert.ok(freeCash(st) >= -0.01, "to the cent");
  const c = closeManual(st, cfg, 'E', 10, Date.now(), 'no exchange price');
  assert.equal(c.trade.reason, 'no exchange price');
});

test('a coin with its own rules trades them; the others and the account settings do not change', async () => {
  const { rulesFor, PER_COIN_RULES } = await import('../js/lib/autotrader.js');
  const cfg = cfgWith({ perCoin: { A: { entryMode: 'pullback', riskPct: 50 } } });
  assert.equal(rulesFor(cfg, 'A').entryMode, 'pullback');
  assert.equal(rulesFor(cfg, 'A').riskPct, cfg.riskPct, 'sizing stays the account\'s');
  assert.equal(rulesFor(cfg, 'B'), cfg);
  // same scripted dip as the pullback test: only the coin with its own rules buys it
  const candles = climb(320);
  const a = prepared('A', candles, (i) => (i === 250 ? -40 : 0));
  const b = prepared('B', candles, (i) => (i === 250 ? -40 : 0));
  const st = newState(cfg);
  replaySeries(st, cfg, [a, b]);
  assert.deepEqual(Object.keys(st.open), ['A']);
  // a settings change made in place reaches the next replay
  cfg.perCoin = null;
  assert.equal(rulesFor(cfg, 'A'), cfg);
  for (const r of Object.values(PER_COIN_RULES.rules)) assert.ok(['trend', 'breakout', 'pullback'].includes(r.entryMode) && r.atrStop > 0);
});

test('a chart trades its own rules only where the published test clears the bar set before it', async () => {
  const { CHART_RULES, CHART_TESTED } = await import('../js/lib/autotrader.js');
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const x = CHART_TESTED[iv];
    // the bar was set on the closed-trade drop (`ddClosed`); `dd` is the one shown
    const dd = (r) => r.ddClosed ?? r.dd;
    const clears = x.better >= 2 && x.own.ret - x.standard.ret >= 1 && dd(x.own) <= dd(x.standard) + 5;
    assert.ok(x.holdDrop > 0 && x.own.dd > 0 && x.standard.dd > 0, `${iv}: drops measured`);
    assert.ok(x.fillCost > 0, `${iv}: the cost of worse fills is measured`);
    assert.equal(x.adopt, clears, `${iv}: adopt must follow the bar`);
    assert.equal(Boolean(CHART_RULES[iv]), x.adopt, `${iv}: rules shipped exactly where adopted`);
  }
});

test('the rules an account trades: its chart\'s own, then the self-review\'s latest trend lesson', async () => {
  const { rulesForChart, CHART_RULES } = await import('../js/lib/autotrader.js');
  const d = rulesForChart(DEFAULT_CONFIG, '1d');
  for (const [k, v] of Object.entries(CHART_RULES['1d'])) assert.equal(d[k], v, k);
  assert.equal(d.interval, '1d');
  assert.equal(rulesForChart(DEFAULT_CONFIG, '4h').entryMode, DEFAULT_CONFIG.entryMode, '4h keeps the standard rules');
  // a saved setting does not decide the trend filter; the lessons do
  assert.equal(rulesForChart({ ...DEFAULT_CONFIG, trendFilter: true }, '1d').trendFilter, false);
  assert.equal(rulesForChart(DEFAULT_CONFIG, '1d', [{ lens: 'trend', at: 1 }]).trendFilter, true, 'learned');
  assert.equal(rulesForChart(DEFAULT_CONFIG, '1d', [{ lens: 'trend', at: 1 }, { lens: 'trend', at: 2, undo: true }]).trendFilter, false, 'then unlearned');
  assert.equal(rulesForChart(DEFAULT_CONFIG, '1d', [{ lens: 'adx', at: 1 }]).trendFilter, false, 'other lessons leave it alone');
});

test('the coin page\'s "would it buy?" is the trader\'s own decision, candle by candle', async () => {
  const { entryBlocker, blockerText } = await import('../js/lib/autotrader.js');
  const candles = climb(320);
  const scoreAt = (i) => (i % 7 === 0 ? 40 : i % 11 === 0 ? -40 : 5);
  for (const rules of [cfgWith({ signalExitBars: 1, rMultiple: 1.2, atrStop: 2 }), cfgWith({ entryMode: 'breakout', momentumConfirm: true, trendFilter: false, signalExitBars: 1, rMultiple: 1.2, atrStop: 2 })]) {
    const s = prepared('A', candles, scoreAt);
    const st = newState(rules);
    const seen = { bought: 0, passed: 0 };
    for (let n = 221; n <= candles.length; n++) {
      const i = n - 1;
      const flat = !st.open.A;
      replaySymbol(st, rules, 'A', candles.slice(0, n), s);
      if (!flat) continue;
      const opened = st.open.A?.openedAt === candles[i].t;
      assert.equal(opened, entryBlocker(rules, s, i, s.scores[i]) === null, `${rules.entryMode} candle ${i}`);
      seen[opened ? 'bought' : 'passed']++;
    }
    assert.ok(seen.bought >= 3 && seen.passed >= 10, `both outcomes were checked: ${JSON.stringify(seen)}`);
  }
  const s = prepared('A', candles, () => 0);
  assert.equal(entryBlocker(cfgWith({}), s, 300, 0), 'signal');
  assert.match(blockerText('signal', cfgWith({}), 0), /the score is 0, the rule needs \+18 or more/);
  assert.equal(entryBlocker(cfgWith({ excluded: ['A'] }), s, 300, 40), 'excluded');
  const falling = prepared('B', climb(320).map((c) => ({ ...c, o: 10000 / c.o, h: 10000 / c.l, l: 10000 / c.h, c: 10000 / c.c })), () => 40);
  assert.equal(entryBlocker(cfgWith({}), falling, 300, 40), 'trend', 'no buying a downtrend with the trend filter on');
});

test('your own rules are traded as you set them; the best tested chart and the warnings', async () => {
  const { rulesForChart, CUSTOM_DEFAULT, bestTestedChart, settingsWarnings, backtestSettings, CHART_TESTED } = await import('../js/lib/autotrader.js');
  const mine = { ...DEFAULT_CONFIG, strategy: 'custom', custom: { entryMode: 'pullback', atrStop: 1.5, trendFilter: false } };
  const r = rulesForChart(mine, '1d', [{ lens: 'trend', at: 1 }]);
  assert.equal(r.entryMode, 'pullback');
  assert.equal(r.atrStop, 1.5);
  assert.equal(r.trendFilter, false, 'the self-review\'s trend lesson does not override your own choice');
  assert.equal(r.signalExitBars, CUSTOM_DEFAULT.signalExitBars, 'unset rules start at the defaults');
  const best = bestTestedChart();
  assert.ok(CHART_TESTED[best.iv]);
  for (const iv of Object.keys(CHART_TESTED).filter((k) => CHART_TESTED[k]?.standard)) assert.ok((CHART_TESTED[iv].up ?? 0) <= best.up);
  const w = settingsWarnings({ ...DEFAULT_CONFIG, interval: '30m', strategy: 'custom', riskPct: 3, universe: ['BTC'] });
  assert.ok(w.some((x) => /never tested/.test(x)) && w.some((x) => /no published test/.test(x)) && w.some((x) => /ten losing trades/.test(x)) && w.some((x) => /fewer than three/.test(x)));
  assert.deepEqual(settingsWarnings({ ...DEFAULT_CONFIG, interval: '1d', universe: ['BTC', 'ETH', 'SOL'] }), []);
  const yours = settingsWarnings({ ...DEFAULT_CONFIG, interval: '15m', riskPct: 5, maxPositionPct: 100, universe: ['BTC', 'LEO', 'XMR'] });
  assert.ok(yours.some((x) => /Up to 100% in one coin; the tests allowed 25%/.test(x)), 'all-in on one coin is flagged');
  assert.ok(yours.some((x) => /2 of your 3 coins were not in the tests .*: LEO, XMR\./.test(x)), 'coins outside the test are named');
  // the settings test replays them like the live account
  const by = { A: climb(320), B: climb(320) };
  const bt = backtestSettings({ ...DEFAULT_CONFIG, trendFilter: false, entryScore: -100 }, by);
  assert.equal(bt.coins, 2);
  assert.ok(bt.trades > 0 && Number.isFinite(bt.ret) && Number.isFinite(bt.hold) && bt.hold > 0);
});

test('the expected yield comes from the walk-forward test of the rules the chart trades', async () => {
  const { expectedYield, CHART_TESTED } = await import('../js/lib/autotrader.js');
  assert.equal(expectedYield({ ...DEFAULT_CONFIG, interval: '30m' }), null, 'nothing measured on an untested chart');
  assert.equal(expectedYield({ ...DEFAULT_CONFIG, interval: '1d', strategy: 'custom' }), null, 'nor for your own rules');
  for (const iv of Object.keys(CHART_TESTED).filter((k) => CHART_TESTED[k]?.standard)) {
    const x = CHART_TESTED[iv];
    const y = expectedYield({ ...DEFAULT_CONFIG, interval: iv });
    assert.ok(y.lo <= y.ret && y.ret <= y.hi, `${iv}: the average sits between the worst and best period`);
    assert.equal(y.hold, x.hold);
    if (x.byRisk) {
      // at a tested level the figures are the measured ones; between two, in between
      const at = (r) => expectedYield({ ...DEFAULT_CONFIG, interval: iv, riskPct: r });
      assert.deepEqual([at(1).ret, at(1).dd], [x.byRisk[1].ret, x.byRisk[1].dd]);
      const mid = at(1.25).ret;
      assert.ok(mid >= Math.min(x.byRisk[1].ret, x.byRisk[1.5].ret) && mid <= Math.max(x.byRisk[1].ret, x.byRisk[1.5].ret));
      assert.equal(at(50).risk, 5, 'clamped to the highest level tested');
    }
  }
  assert.equal(expectedYield({ ...DEFAULT_CONFIG, interval: '1d', maxPositionPct: 50 }).capsDiffer, true);
});

test('the AI signal is the chart\'s published rule replayed on the coin, with that rule\'s measured record', async () => {
  const { aiSignal, CHART_TESTED, rulesForChart } = await import('../js/lib/autotrader.js');
  assert.equal(aiSignal(climb(100), '1d'), null, 'too little history');
  // a fall, then a climb: the trend rule is in a trade it bought during the climb
  const up = [];
  for (let i = 0, prev = 100; i < 700; i++) {
    const c = 100 * (i < 300 ? 0.998 ** i : 0.998 ** 300 * 1.003 ** (i - 300)) * (1 + 0.004 * Math.sin(i / 2));
    up.push({ t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.001, l: Math.min(prev, c) * 0.999, c, v: 1000 });
    prev = c;
  }
  const a = aiSignal(up, '1h', 'X');
  assert.ok(['buy', 'hold'].includes(a.action), a.action);
  assert.ok(a.entry > 0 && a.initialStop < a.entry, 'the stop starts below the entry (a trailing stop may since have passed it)');
  assert.deepEqual(a.record, CHART_TESTED['1h'].signals);
  assert.equal(a.tested, true);
  // the published rules, never anyone's own settings
  for (const k of ['entryMode', 'atrStop', 'trailAtr']) assert.equal(a.rules[k], rulesForChart({ ...DEFAULT_CONFIG }, '1h')[k]);
  // buy means bought on the last candle; cut the series there and it must agree
  const k = up.findIndex((c) => c.t === a.openedAt);
  assert.equal(aiSignal(up.slice(0, k + 1), '1h', 'X').action, 'buy');
  // a fall: no position, and the reason in words
  const down = climb(400).map((c) => ({ ...c, o: 10000 / c.o, h: 10000 / c.l, l: 10000 / c.h, c: 10000 / c.c }));
  const w = aiSignal(down, '1h', 'Y');
  assert.equal(w.action, 'wait');
  assert.ok(w.why && w.code);
  // an untested chart says so instead of borrowing a record
  const u = aiSignal(climb(400), '30m', 'X');
  assert.equal(u.tested, false);
  assert.equal(u.record, null);
  // its own trades on these candles: newest first, at most five shown, fees counted
  const wavy = [];
  for (let i = 0, prev = 100; i < 700; i++) {
    const c = 100 * (i < 300 ? 0.998 ** i : 0.998 ** 300 * 1.003 ** (i - 300)) * (1 + 0.02 * Math.sin(i / 5));
    wavy.push({ t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.01, l: Math.min(prev, c) * 0.99, c, v: 1000 });
    prev = c;
  }
  const pw = aiSignal(wavy, '4h', 'W').past;
  assert.ok(pw.trades >= 2 && pw.recent.length === Math.min(5, pw.trades), `${pw.trades} trades`);
  for (let j = 1; j < pw.recent.length; j++) assert.ok(pw.recent[j - 1].exitAt >= pw.recent[j].exitAt, 'newest first');
  assert.ok(pw.recent.every((t) => t.netPct < (t.exit / t.entry - 1) * 100), 'after both fees, a trade made less than the price move');
  assert.equal(pw.holdPct, +((wavy.at(-1).c / wavy[210].c - 1) * 100).toFixed(2));
  // every published signal record says what it says: no chart beat chance on direction
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const r = CHART_TESTED[iv].signals;
    assert.ok(r.n > 100 && r.fwdLo <= r.baseUpPct, `${iv}: the record is published as measured`);
  }
});

test('volatility-scaled risk only ever buys less, and only while a coin is unusually volatile', async () => {
  const { volRatio, replaySymbol } = await import('../js/lib/autotrader.js');
  const calm = Array.from({ length: 900 }, (_, i) => ({ c: 100 * Math.exp(Math.sin(i * 1.7) * 0.006) }));
  const r = volRatio(calm);
  assert.equal(r[199], null, 'nothing before there is enough history');
  assert.ok(Math.abs(r[800] - 1) < 0.2, 'about 1 in a steady market');
  const wild = calm.map((c, i) => ({ c: i > 850 ? 100 * Math.exp(Math.sin(i * 1.7) * 0.03) : c.c }));
  assert.ok(volRatio(wild)[899] > 1.5, 'above 1 once it turns wild');
  // the same entries, never a bigger position
  const wavy = [];
  for (let i = 0, prev = 100; i < 700; i++) {
    const c = 100 * 1.002 ** i * (1 + (i > 400 ? 0.05 : 0.01) * Math.sin(i / 5));
    wavy.push({ t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.002, l: Math.min(prev, c) * 0.998, c, v: 1000 });
    prev = c;
  }
  const run = (volScale) => { const cfg = { ...DEFAULT_CONFIG, trendFilter: false, volScale, maxPositions: 1, universe: ['W'] }; const st = newState(cfg); replaySymbol(st, cfg, 'W', wavy); return [...st.closed, ...Object.values(st.open)]; };
  const off = run(false), on = run(true);
  assert.ok(off.length > 2);
  assert.deepEqual(on.map((t) => t.openedAt), off.map((t) => t.openedAt), 'the rules decide when; the scaling only how much');
  assert.ok(on.every((t, k) => t.notional <= off[k].notional + 1e-6));
  assert.ok(on.some((t, k) => t.notional < off[k].notional - 1e-6), 'smaller somewhere in the wild stretch');
});

test('volatility-scaled size is on only where it cleared its bar, and never on your own rules', async () => {
  const { rulesForChart, VOL_SCALE } = await import('../js/lib/autotrader.js');
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const t = VOL_SCALE.tested[iv];
    const cleared = t.better >= 2 && t.objective >= 1 && t.ret >= -1;
    assert.equal(rulesForChart({ ...DEFAULT_CONFIG }, iv).volScale, cleared, iv);
    assert.equal(VOL_SCALE.charts.includes(iv), cleared, iv);
  }
  assert.equal(rulesForChart({ ...DEFAULT_CONFIG, strategy: 'custom' }, '4h').volScale, false);
});

test('the worst drop counts falls inside open trades, not only closed ones', () => {
  const st = newState({ ...DEFAULT_CONFIG, startingBalance: 1000 });
  st.open.BTC = { symbol: 'BTC', side: 'long', entry: 100, qty: 5, notional: 500, stop: 50, initialStop: 50, tp: null };
  const tr = dropTracker(st);
  tr.onBar({ t: 1, c: 100 }, 'BTC');
  tr.onBar({ t: 2, c: 80 }, 'BTC'); // 100 down on the trade: the account is worth 900
  tr.onBar({ t: 3, c: 120 }, 'BTC'); // then it recovers, so no closed trade ever lost
  assert.equal(+tr.worstDropPct().toFixed(6), 10);
});

test('the live equity curve values open trades at the latest close', () => {
  const c = Array.from({ length: 700 }, (_, i) => {
    const p = 100 * Math.exp(0.002 * i + Math.sin(i / 7) * 0.04);
    return { t: i * 36e5, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1000 };
  });
  const cfg = { ...DEFAULT_CONFIG, universe: ['AAA'], trendFilter: false, marketFilter: false };
  const st = newState(cfg);
  replaySeries(st, cfg, [{ symbol: 'AAA', candles: c, ind: computeAll(c), atr: atr(c, 14) }], { from: 210 });
  // while a trade is open the cash balance stands still, so a curve of cash
  // alone would be flat there; valued at each close it moves with the price
  const t = st.closed.find((x) => st.equityCurve.filter((p) => p.t > x.openedAt && p.t < x.exitAt).length >= 3);
  assert.ok(t, 'the fixture holds a trade for several candles');
  const inside = st.equityCurve.filter((p) => p.t > t.openedAt && p.t < t.exitAt).map((p) => p.equity);
  assert.ok(new Set(inside).size > 1);
  assert.ok(stats(st, { AAA: c.at(-1).c }).maxDrawdownPct > 0);
});

test('a new starting balance scales the account to what the AI would have done with that much', () => {
  const run = (startingBalance) => {
    const cfg = cfgWith({ signalExitBars: 2, maxPositions: 5, riskPct: 2, maxPositionPct: 25, startingBalance });
    const series = [
      prepared('A', climb(320), (i) => (i === 250 || i === 280 ? 40 : i === 270 || i === 271 ? -40 : 0)),
      prepared('B', climb(320).map((c) => ({ ...c, o: c.o * 3, h: c.h * 3, l: c.l * 3, c: c.c * 3 })), (i) => (i === 255 ? 40 : i === 290 || i === 291 ? -40 : 0)),
    ];
    const st = newState(cfg);
    replaySeries(st, cfg, series);
    return st;
  };
  const big = run(10000), small = run(2500);
  assert.ok(big.closed.length >= 2 && Object.keys(big.open).length >= 1, 'the test needs closed and open trades');
  const scaled = rescaleAccount(big, 2500);
  assert.equal(scaled.startingBalance, 2500);
  assert.ok(Math.abs(scaled.balance - small.balance) < 0.05, `balance ${scaled.balance} vs ${small.balance}`);
  assert.deepEqual(scaled.closed.map((t) => [t.symbol, t.openedAt, t.exitAt, t.pnlPct]), small.closed.map((t) => [t.symbol, t.openedAt, t.exitAt, t.pnlPct]));
  scaled.closed.forEach((t, i) => assert.ok(Math.abs(t.pnl - small.closed[i].pnl) < 0.02 && Math.abs(t.notional - small.closed[i].notional) < 0.02));
  for (const [sym, p] of Object.entries(small.open)) assert.ok(Math.abs(scaled.open[sym].notional - p.notional) < 0.02 && Math.abs(scaled.open[sym].qty / p.qty - 1) < 1e-6);
  assert.equal(scaled.equityCurve.length, small.equityCurve.length);
  scaled.equityCurve.forEach((e, i) => assert.ok(Math.abs(e.equity - small.equityCurve[i].equity) < 0.05));
  assert.equal(stats(scaled).returnPct, stats(big).returnPct, 'the result in % is unchanged');
  assert.equal(rescaleAccount(big, 10000), big, 'the same balance changes nothing');
  assert.equal(big.startingBalance, 10000, 'the original is left as it was');
});
