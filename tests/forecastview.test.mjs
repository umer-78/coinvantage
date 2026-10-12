// What the pages show of a forecast: without the model's lean where its
// direction did not hold up in testing, the move-size call where it told big
// moves from small ones, and timing that states only what was measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../js/lib/predict.js';
import { withoutLean, forecastForDisplay, moveSizeCall, moveCallUseful, FORECAST_TESTED } from '../js/lib/forecastview.js';
import { timingOutlook, condenseTiming, summarizeTiming, timingText } from '../js/lib/timing.js';
import { demoCandles } from '../js/lib/demo.js';

const END = Date.UTC(2026, 8, 1);

test('without the lean the forecast keeps its spread but is centred on today\'s price', () => {
  const f = forecast(demoCandles('bitcoin', '1h', 900, END), { horizon: 12 });
  assert.ok(f.ok);
  const v = withoutLean(f);
  assert.equal(v.targetPrice, f.lastPrice);
  assert.equal(v.expectedReturnPct, 0);
  assert.equal(v.rawExpectedReturnPct, f.expectedReturnPct, 'the raw lean is kept for the record');
  for (let h = 0; h < f.path.length; h++) {
    assert.ok(Math.abs(v.path[h].p50 - f.lastPrice) < 1e-9 * f.lastPrice, 'the middle of the path is today\'s price');
    // same widths: each quantile moves by the same factor
    const k = f.lastPrice / f.path[h].p50;
    assert.ok(Math.abs(v.path[h].p10 - f.path[h].p10 * k) < 1e-9 * f.lastPrice);
    assert.ok(Math.abs(v.path[h].p90 - f.path[h].p90 * k) < 1e-9 * f.lastPrice);
  }
  assert.ok(v.range.p10 < f.lastPrice && v.range.p90 > f.lastPrice);
  assert.equal(v.probUp, f.probUp, 'the raw probability is not touched');
  // a chart with a trusted direction keeps the lean; one without does not
  assert.equal(forecastForDisplay(f, '1h', 0).leanRemoved, true);
  assert.equal(forecastForDisplay(f, '1h', 0.4), f);
  assert.equal(withoutLean({ ok: false, reason: 'x' }).ok, false);
});

test('the move-size call follows volatility now against the coin\'s normal, and is offered only where it was measured to help', () => {
  assert.deepEqual(['1m', '5m', '15m', '1h', '4h', '1d'].filter(moveCallUseful), ['5m', '1h', '4h']);
  // calm history, then a wild stretch at the end
  const mk = (n, wildFrom) => Array.from({ length: n }, (_, i) => ({ c: 100 * Math.exp(Math.sin(i * 1.7) * (i >= wildFrom ? 0.03 : 0.004)) }));
  const wild = moveSizeCall(mk(900, 860), 12, '1h');
  assert.equal(wild.bigger, true);
  assert.ok(wild.ratio > 1 && wild.usualPct > 0);
  assert.equal(wild.useful, true);
  assert.deepEqual(wild.tested, FORECAST_TESTED.move['1h']);
  const calm = moveSizeCall(mk(900, 9999).map((c, i) => (i < 600 ? { c: c.c * Math.exp(Math.sin(i * 1.3) * 0.03) } : c)), 12, '1d');
  assert.equal(calm.bigger, false);
  assert.equal(calm.useful, false, 'not offered as a call on 1d');
  assert.equal(moveSizeCall(mk(100, 0), 12, '1h'), null, 'too little history');
});

test('timing states when, not which way or how far, where the direction is not reliable', () => {
  const f = forecast(demoCandles('ethereum', '4h', 900, END), { horizon: 6 });
  const raw = timingOutlook(f, { intervalMs: 4 * 3600e3 });
  const t = timingOutlook(f, { intervalMs: 4 * 3600e3, interval: '4h' });
  assert.equal(raw.priceless, false);
  assert.equal(t.priceless, true, 'no trusted direction on 4h');
  assert.equal(timingOutlook(withoutLean(f), { intervalMs: 4 * 3600e3 }).priceless, true);
  assert.ok(t.shaped, 'this fixture has a shaped path');
  {
    const c = condenseTiming(t);
    assert.equal(c.targetPrice, null);
    assert.equal(c.turnBars, null);
    const s = summarizeTiming(t);
    assert.equal(s.peakPrice, undefined);
    assert.equal(s.peakMovePct, undefined);
    assert.ok(['high', 'low'].includes(s.extreme));
    const txt = timingText(t, (b) => `${b} candles`, (v) => `$${v}`);
    assert.match(txt, /when, not which way or how far/);
    assert.doesNotMatch(txt, /\$|%/);
  }
});
