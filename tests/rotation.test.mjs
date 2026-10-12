// The strongest-coins rotation: decides on a close, trades at the next open,
// pays fees both ways, and sits in cash while Bitcoin is in a downtrend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { alignSeries, rotationPicks, rotationReplay, buyAndHold } from '../js/lib/rotation.js';

const D = 864e5;
const series = (closes, t0 = 0) => closes.map((c, i) => ({ t: t0 + i * D, o: i ? closes[i - 1] : c, h: c, l: c, c, v: 1 }));
const rising = (n, from = 100, step = 0.5) => Array.from({ length: n }, (_, i) => from + i * step);
const flat = (n, v = 50) => Array(n).fill(v);
const cfg = { lookback: 10, top: 1, every: 1, btcFilter: false, absolute: true, feePct: 0.1, startingBalance: 10000 };

test('it holds the coin that rose most, and only coins that rose', () => {
  const A = alignSeries({ BTC: series(rising(300, 100, 0.1)), FAST: series(rising(300, 10, 0.5)), DOWN: series(rising(300, 500, -1)) });
  assert.deepEqual(rotationPicks(A, 250, { ...cfg, top: 2 }).map((p) => p.symbol), ['FAST', 'BTC']);
  assert.ok(!rotationPicks(A, 250, { ...cfg, top: 3 }).some((p) => p.symbol === 'DOWN'), 'a falling coin is never held');
  assert.equal(rotationPicks(A, 250, { ...cfg, top: 3, absolute: false }).length, 3);
});

test('a decision on a close is traded at the next open, never at a price it could not know', () => {
  // X is flat, then jumps 50% at the OPEN of candle 251: the ranking made on
  // candle 250's close cannot have bought before that jump.
  const x = flat(300, 100).map((c, i) => (i >= 251 ? 150 : c));
  const candles = series(x);
  candles[250].c = 101; // a small rise on 250's close makes X the pick
  candles[251].o = 150; // ...and the next candle gaps up at its open
  const A = alignSeries({ BTC: series(flat(300, 10)), X: candles });
  const r = rotationReplay(A, { ...cfg, lookback: 5 }, { from: 250, to: 300 });
  // bought at 251's open (150), so the jump is not in the result: only the fee
  assert.ok(r.ret <= 0 && r.ret >= -0.25, `return ${r.ret}%`);
});

test('fees are paid on the way in and on the way out', () => {
  const A = alignSeries({ BTC: series(flat(300, 10)), X: series(rising(300, 100, 0.0001)) });
  const r = rotationReplay(A, { ...cfg, lookback: 5 }, { from: 250, to: 300 });
  assert.equal(r.trades, 1);
  assert.ok(Math.abs(r.ret - -0.2) < 0.01, `a 0.1% fee each way on a flat coin: ${r.ret}%`);
});

test('with the Bitcoin filter on, a downtrend means cash', () => {
  const A = alignSeries({ BTC: series(rising(300, 400, -1)), X: series(rising(300, 10, 0.5)) });
  const r = rotationReplay(A, { ...cfg, btcFilter: true }, { from: 250, to: 300 });
  assert.equal(r.trades, 0);
  assert.equal(r.investedPct, 0);
  assert.ok(rotationReplay(A, cfg, { from: 250, to: 300 }).trades > 0, 'without the filter it buys');
});

test('holding everything equally is the yardstick', () => {
  const A = alignSeries({ BTC: series(rising(300, 100, 1)), X: series(flat(300, 10)) });
  const bh = buyAndHold(A, { from: 100, to: 300 });
  const btc = (399 / 200 - 1) * 100; // bought at 101's open (200), sold at 299's close (399)
  assert.ok(Math.abs(bh - btc / 2) < 0.01, `${bh} vs ${btc / 2}`);
});
