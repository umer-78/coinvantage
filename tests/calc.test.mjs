// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { convert, dcaBacktest, positionSize } from '../js/lib/calc.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const day = 86400e3;
const series = (prices) => prices.map((c, i) => ({ t: i * day, c }));

test('convert: coin to fiat and back', () => {
  // 2 BTC at $50,000 into PKR at 280 per USD (1 PKR = 1/280 USD)
  close(convert(2, 50000, 1 / 280), 28_000_000, 1e-3);
  close(convert(28_000_000, 1 / 280, 50000), 2, 1e-9);
  assert.equal(convert(1, 0, 1), null);
  assert.equal(convert(NaN, 1, 1), null);
});

test('dcaBacktest: buys on schedule, totals match by hand', () => {
  // price 100 → 50 → 100, buying $100 every day
  const r = dcaBacktest(series([100, 50, 100]), { amount: 100, everyDays: 1 });
  assert.equal(r.buys, 3);
  close(r.invested, 300);
  close(r.units, 1 + 2 + 1);
  close(r.value, 400);
  close(r.pnlPct, (400 - 300) / 300 * 100);
  close(r.avgCost, 75);
  // lump sum: $300 at 100 → 3 units → $300
  close(r.lump.value, 300);
  assert.equal(r.rows.length, 3);
});

test('dcaBacktest: every N days and a fee', () => {
  const r = dcaBacktest(series([10, 10, 10, 10, 10]), { amount: 50, everyDays: 2, feePct: 1 });
  assert.equal(r.buys, 3); // days 0, 2, 4
  close(r.units, 3 * 50 * 0.99 / 10);
  assert.ok(r.pnl < 0, 'a flat market with fees loses money');
});

test('dcaBacktest: bad input is an error, not NaN', () => {
  assert.ok(dcaBacktest([], { amount: 10 }).error);
  assert.ok(dcaBacktest(series([1, 2]), { amount: 0 }).error);
});

test('positionSize: long, risk exactly the chosen percent', () => {
  const r = positionSize({ balance: 10000, riskPct: 1, entry: 100, stop: 95, target: 115 });
  assert.equal(r.side, 'long');
  close(r.riskAmount, 100);
  close(r.units, 20); // $100 risk / $5 per unit
  close(r.notional, 2000);
  close(r.leverage, 0.2);
  close(r.rr, 3);
  close(r.reward, 300);
});

test('positionSize: short when the stop is above entry; fees shrink the size', () => {
  const r = positionSize({ balance: 1000, riskPct: 2, entry: 50, stop: 55, feePct: 0.1 });
  assert.equal(r.side, 'short');
  // loss per unit = 5 + 0.001 * 105 = 5.105
  close(r.units, 20 / 5.105);
  const bad = positionSize({ balance: 1000, riskPct: 2, entry: 50, stop: 55, target: 60 });
  assert.ok(bad.targetError);
  assert.ok(positionSize({ balance: 1000, riskPct: 2, entry: 50, stop: 50 }).error);
});
