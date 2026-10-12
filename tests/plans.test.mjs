// Run: node --test tests/
// Trade-plan levels must always be prices a coin can actually trade at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignal, fmtNum } from '../js/lib/signals.js';

function rng(s) { s >>>= 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function gauss(r) { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function series({ seed, start, vol, drift = 0, n = 400 }) {
  const r = rng(seed); let c = start; const out = [];
  for (let i = 0; i < n; i++) {
    const o = c; c = Math.max(o * (1 + drift + vol * gauss(r)), 1e-15);
    out.push({ t: i * 36e5, o, h: Math.max(o, c) * (1 + Math.abs(vol * gauss(r)) * 0.5), l: Math.min(o, c) * (1 - Math.abs(vol * gauss(r)) * 0.5), c, v: 1000 });
  }
  return out;
}

test('short targets on a violently falling coin stay above zero and keep falling', () => {
  let shorts = 0, wouldHaveBeenZero = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const interval of ['5m', '1h']) {
      const s = generateSignal(series({ seed, start: 0.5, vol: 0.08, drift: -0.004 }), { interval });
      const p = s.plan;
      if (p?.side !== 'short') continue;
      shorts++;
      const [tp1, tp2, tp3] = p.takeProfits;
      assert.equal(p.takeProfits.length, 3, 'the page, alerts and track record read three targets');
      assert.ok(p.stopLoss > p.entry, 'short stop sits above entry');
      assert.ok(tp1 < p.entry && tp2 < tp1 && tp3 < tp2, `targets fall: ${p.takeProfits}`);
      assert.ok(tp3 > 0, `no target at or below $0 (seed ${seed} ${interval}: ${p.takeProfits})`);
      // The old additive target that used to be clamped to $0:
      if (p.entry - p.rewardRisk * 1.6 * (p.stopLoss - p.entry) <= 0) wouldHaveBeenZero++;
    }
  }
  assert.ok(shorts > 0, 'the sweep produced short plans');
  assert.ok(wouldHaveBeenZero > 0, 'the sweep covers the case that used to read $0');
});

test('a coin priced like Baby Doge keeps real plan levels instead of zeros', () => {
  // Fixed 8-decimal rounding turned these into entry = stop = 0 (falling) and
  // entry = stop = 0.00000001 (rising, 69% above the real price).
  for (const [seed, drift, side] of [[2, 0.003, 'long'], [1, -0.003, 'short']]) {
    const s = generateSignal(series({ seed, start: 1.5e-9, vol: 0.02, drift }), { interval: '1h' });
    const p = s.plan;
    assert.equal(p?.side, side, `seed ${seed} gives a ${side} plan`);
    for (const v of [p.entry, p.stopLoss, ...p.takeProfits, ...p.entryZone]) assert.ok(v > 0, `level ${v} is above zero`);
    assert.ok(Math.abs(p.entry / s.price - 1) < 0.01, `entry ${p.entry} matches the price ${s.price}`);
    if (side === 'long') assert.ok(p.stopLoss < p.entry && p.takeProfits[0] > p.entry);
    else assert.ok(p.stopLoss > p.entry && p.takeProfits[0] < p.entry);
  }
});

test('fmtNum never prints a tiny price as 0', () => {
  assert.notEqual(fmtNum(1.5e-9), '0');
  assert.equal(Number(fmtNum(1.5e-9)), 1.5e-9);
  assert.equal(fmtNum(64321.123), '64,321.12');      // ordinary prices unchanged
  assert.equal(fmtNum(0.0042), '0.0042');
});
