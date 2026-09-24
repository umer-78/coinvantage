// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { signalMeter } from '../js/lib/selfimprove.js';

test('signal meter needle stays on the track (0-100 %)', () => {
  assert.equal(signalMeter(-100).pos, 0);
  assert.equal(signalMeter(0).pos, 50);
  assert.equal(signalMeter(100).pos, 100);
  assert.equal(signalMeter(22).pos, 61);
  for (const s of [-500, -45, -18, 7, 18, 45, 999, NaN, undefined]) {
    const { pos } = signalMeter(s);
    assert.ok(pos >= 0 && pos <= 100, `score ${s} put the needle at ${pos}%`);
  }
});

test('signal meter labels follow the score bands', () => {
  assert.equal(signalMeter(60).label, 'Strong buy');
  assert.equal(signalMeter(20).label, 'Buy');
  assert.equal(signalMeter(0).label, 'Neutral');
  assert.equal(signalMeter(-20).label, 'Sell');
  assert.equal(signalMeter(-60).label, 'Strong sell');
});
