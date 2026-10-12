// The AI trader's engine: what a live account does one check at a time must
// match a replay, it never invests money it does not have, and coins advance
// together in time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replaySymbol, replaySeries, newState, openManual, closeManual, freeCash, DEFAULT_CONFIG } from '../js/lib/autotrader.js';
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
