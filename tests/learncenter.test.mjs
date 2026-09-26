import test from 'node:test';
import assert from 'node:assert/strict';
import { wilson, measureOnHistory, learnedWeights, blend, recordCalls, resolveCalls, liveScores, decideChampion, newLearnLedger, diffWeights, INDICATORS } from '../js/lib/learncenter.js';

function walk(n, seed = 3, drift = 0.0) {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => { const o = p; p *= 1 + (rnd() - 0.5) * 0.02 + drift; return { t: 1.7e12 + i * 36e5, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 100 + rnd() * 20 }; });
}

test('wilson range is sane', () => {
  const [lo, hi] = wilson(60, 100);
  assert.ok(lo > 0.49 && lo < 0.51 && hi > 0.68 && hi < 0.7);
  assert.deepEqual(wilson(0, 0), [0, 1]);
});

test('on a random walk no indicator earns a vote', () => {
  const m = measureOnHistory(walk(500), 12);
  const w = learnedWeights(m, null);
  const voted = Object.values(w).filter((x) => x !== 0).length;
  assert.ok(voted <= 1, `${voted} indicators voted on noise`);
  for (const k of Object.keys(INDICATORS)) assert.ok(k in m);
});

test('blend without any votes is the forecast itself', () => {
  assert.equal(blend(0.62, { rsi: 1 }, {}), 0.62);
  assert.equal(blend(null, { rsi: 1 }, { rsi: 0.4 }), 0.7);
});

test('calls are logged before the outcome and scored after it', () => {
  const c = walk(30);
  let L = recordCalls(newLearnLedger(), { symbol: 'BTC', interval: '1h', t: c[10].t, price: c[10].c, horizonAt: c[20].t, votes: { rsi: 1 }, forecastProb: 0.6, blendProb: 0.6 });
  L = recordCalls(L, { symbol: 'BTC', interval: '1h', t: c[10].t, price: c[10].c, horizonAt: c[20].t, votes: { rsi: 1 } });
  assert.equal(L.rows.length, 1, 'no duplicate rows');
  L = resolveCalls(L, c.slice(0, 15), { symbol: 'BTC', interval: '1h' });
  assert.equal(L.rows[0].resolved, false, 'not scored before its time');
  L = resolveCalls(L, c, { symbol: 'BTC', interval: '1h' });
  assert.equal(L.rows[0].resolved, true);
  assert.equal(liveScores(L).rsi.n, 1);
});

test('the champion only switches on clear, large-sample evidence, and switches back', () => {
  const s = (rate, n) => ({ rate, n, hits: Math.round(rate * n / 100), lo: rate - 5, hi: rate + 5 });
  assert.equal(decideChampion({ forecast: s(52, 50), blend: s(70, 50) }).champion, 'forecast', 'too few calls');
  assert.equal(decideChampion({ forecast: s(52, 200), blend: s(54, 200) }).champion, 'forecast', 'lead too small');
  const up = decideChampion({ forecast: s(52, 200), blend: s(60, 200) });
  assert.equal(up.champion, 'blend'); assert.ok(up.switched);
  assert.equal(decideChampion({ forecast: s(55, 300), blend: s(53, 300) }, 'blend').champion, 'forecast');
});

test('weight changes are described in words', () => {
  const t = diffWeights({ rsi: 0 }, { rsi: 0.3, macd: -0.25 });
  assert.ok(t.some((x) => x.includes('RSI') && x.includes('earned a vote')));
  assert.ok(t.some((x) => x.includes('MACD') && x.includes('reverse')));
});
