// The three-model cross-check learns each model's weight from that model's own
// graded calls on this device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newLedger, recordForecast, resolveDueLedger, adaptiveWeights, familyRecord, threeModelEnsemble, MIN_FAMILY_CALLS } from '../js/lib/selfimprove.js';
import { demoCandles } from '../js/lib/demo.js';

const H = 3600e3;
// n graded forecasts in which momentum says up, reversion says down, patterns
// say up, and the price rose `ups` times out of n.
function ledgerWith(n, ups, families = { momentum: 0.62, reversion: 0.4, pattern: 0.55, blend: 0.53 }) {
  let L = newLedger();
  const candles = [];
  for (let i = 0; i < n; i++) {
    const t0 = i * 10 * H;
    L = recordForecast(L, { symbol: 'BTC', interval: '1h', price: 100, probUp: 0.6, horizonBars: 1, horizonAt: t0 + H, families });
    candles.push({ t: t0 + H, o: 100, h: 102, l: 98, c: i < ups ? 101 : 99 });
  }
  return resolveDueLedger(L, candles, { symbol: 'BTC', interval: '1h' });
}

test('each model is graded on its own calls', () => {
  const L = ledgerWith(40, 28); // the price rose 70% of the time
  const r = familyRecord(L);
  assert.equal(r.momentum.n, 40);
  assert.equal(r.momentum.hits, 28, 'momentum said up');
  assert.equal(r.reversion.hits, 12, 'reversion said down');
  assert.equal(r.blend.hits, 28);
});

test('weights follow each model\'s record, not the main forecast\'s', () => {
  const w = adaptiveWeights(ledgerWith(40, 28));
  assert.equal(w.source, 'adaptive');
  assert.ok(w.momentum > 1.2, `momentum right 70% → ${w.momentum}`);
  assert.ok(w.reversion < 0.8, `reversion right 30% → ${w.reversion}`);
  assert.ok(w.pattern > 1.2, 'patterns said up too');
  // a small sample moves the weights less than a large one
  const small = adaptiveWeights(ledgerWith(MIN_FAMILY_CALLS, 14));
  const big = adaptiveWeights(ledgerWith(200, 140));
  assert.ok(big.momentum > small.momentum && small.momentum > 1);
});

test('equal weights until a model has enough graded calls', () => {
  const w = adaptiveWeights(ledgerWith(MIN_FAMILY_CALLS - 1, 15));
  assert.equal(w.source, 'default');
  assert.deepEqual([w.momentum, w.reversion, w.pattern], [1, 1, 1]);
  // forecasts recorded without the models' calls teach the weights nothing
  assert.equal(adaptiveWeights(ledgerWith(60, 50, null)).source, 'default');
});

test('the cross-check blends with the learned weights and damps on its own record', () => {
  const candles = demoCandles('bitcoin', '1h', 400);
  const good = threeModelEnsemble(candles, { ledger: ledgerWith(60, 45) });
  assert.ok(good.ok);
  assert.equal(good.weights.source, 'adaptive');
  assert.equal(good.dampened, false, 'blend right 75%: no damping');
  const bad = threeModelEnsemble(candles, { ledger: ledgerWith(60, 15) });
  assert.equal(bad.dampened, Math.abs(bad.rawProbUp - 0.5) > 1e-9, 'blend right 25%: damped');
  assert.ok(bad.blendAccuracy < 40);
});

test('risk warnings: a losing backtest that trailed a losing hold is flagged too', async () => {
  const { riskWarnings } = await import('../js/lib/selfimprove.js');
  const bt = (ret, hold) => riskWarnings({ backtest: { ok: true, totalReturnPct: ret, buyHoldPct: hold, tradeCount: 12 } }).find((w) => w.key === 'backtest')?.text || null;
  assert.match(bt(-20, 5), /gained 5\.0%/);
  assert.match(bt(-20, -5), /lost only 5\.0%/);
  assert.equal(bt(-5, -20), null, 'lost less than holding');
  assert.equal(bt(3, 10), null, 'made money');
  const geo = (x) => riskWarnings({ signal: { plan: { expectancyR: x } }, interval: '1h' })[0].text;
  assert.match(geo(-0.02), /about break-even/);
  assert.match(geo(-0.4), /— negative before fees/);
});

test('the strength meter and the engine label agree at every score', async () => {
  const { signalMeter } = await import('../js/lib/selfimprove.js');
  const { labelFor } = await import('../js/lib/signals.js');
  for (let s = -100; s <= 100; s++) {
    assert.equal(signalMeter(s).tone, labelFor(s).tone, `score ${s}`);
  }
});
