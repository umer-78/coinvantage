// Track-record plans are scored the way the plan says to manage them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePlan } from '../js/lib/planscore.js';

const long = { side: 'long', entry: 100, stop: 95, tp1: 105, tp2: 110 };
const c = (l, h, cl = (l + h) / 2) => ({ l, h, c: cl });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('stopped out before target 1 is a full loss at the stop', () => {
  const r = scorePlan(long, [c(98, 102), c(94, 99)], 96);
  assert.equal(r.result, 'stop');
  assert.ok(near(r.returnPct, -5));
});

test('target 1 then back to entry: half the profit, not a stop-out', () => {
  // the old scoring called this a full loss at the stop
  const r = scorePlan(long, [c(99, 106), c(101, 104), c(94, 100)], 96);
  assert.equal(r.result, 'tp1');
  assert.ok(near(r.returnPct, 2.5), `half of +5% = ${r.returnPct}`);
});

test('target 1 then target 2: the average of both exits', () => {
  const r = scorePlan(long, [c(99, 106), c(104, 111)], 109);
  assert.equal(r.result, 'tp2');
  assert.ok(near(r.returnPct, 7.5));
  // both targets in one candle
  assert.ok(near(scorePlan(long, [c(99, 112)], 111).returnPct, 7.5));
});

test('target 1 then the horizon: half at target 1, half at the close', () => {
  const r = scorePlan(long, [c(99, 106), c(102, 107)], 104);
  assert.equal(r.result, 'tp1');
  assert.ok(near(r.returnPct, (5 + 4) / 2));
});

test('nothing reached: expired at the close; stop and target 1 in one candle: stop', () => {
  const e = scorePlan(long, [c(98, 103)], 101);
  assert.equal(e.result, 'expired');
  assert.ok(near(e.returnPct, 1));
  assert.equal(scorePlan(long, [c(94, 106)], 100).result, 'stop');
});

test('a short plan is scored the same way, mirrored', () => {
  const short = { side: 'short', entry: 100, stop: 105, tp1: 95, tp2: 90 };
  const r = scorePlan(short, [c(94, 101), c(96, 100.5)], 97);
  assert.equal(r.result, 'tp1');
  assert.ok(near(r.returnPct, 2.5), 'half of +5%, rest out at entry');
  assert.equal(scorePlan(short, [c(99, 106)], 100).result, 'stop');
});

test('a plan without numbers is not scored', () => {
  assert.deepEqual(scorePlan(null, [], 1), { result: 'none', returnPct: null });
  assert.deepEqual(scorePlan({ side: 'long', entry: 0, stop: 1, tp1: 2 }, [], 1), { result: 'none', returnPct: null });
});
