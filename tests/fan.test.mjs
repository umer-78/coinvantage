// The forecast fan's possible paths: the measured spread, never a call.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
globalThis.document ??= { documentElement: {} };
const { samplePaths } = await import('../js/charts/candles.js');

const proj = Array.from({ length: 12 }, (_, k) => {
  const w = 0.01 * Math.sqrt(k + 1) * 1.2816;
  return { p50: 100, p10: 100 * Math.exp(-w), p90: 100 * Math.exp(w * 1.3), p25: 99, p75: 101 };
});

test('possible paths spread like the measured range: about 80% end inside the 80% range', () => {
  const paths = samplePaths(proj, 'BTC:1h:1', 4000);
  const end = proj[proj.length - 1];
  const inside = paths.filter((p) => p[11] >= end.p10 && p[11] <= end.p90).length / paths.length;
  assert.ok(inside > 0.77 && inside < 0.83, `inside ${inside}`);
  // above and below by the range's own widths: the upper side here is wider
  const above = paths.filter((p) => p[11] > end.p90).length, below = paths.filter((p) => p[11] < end.p10).length;
  assert.ok(Math.abs(above - below) / paths.length < 0.03, 'about as many above the range as below it');
});

test('the same coin and candle draw the same paths; another candle draws others', () => {
  const a = samplePaths(proj, 'BTC:1h:1', 5), b = samplePaths(proj, 'BTC:1h:1', 5), c = samplePaths(proj, 'BTC:1h:2', 5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((p) => p.length === proj.length && p.every((v) => v > 0)));
});
