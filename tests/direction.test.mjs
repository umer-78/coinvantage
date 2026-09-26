// The chance of a rise shown on the page, and where its candles come from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast, shownProbUp, directionReliable, summarizeForecast, TESTED_ACCURACY } from '../js/lib/predict.js';
import { adviseCoin } from '../js/lib/advice.js';
import { generateSignal } from '../js/lib/signals.js';
import { exchangeCandles, isTestedSource } from '../js/api/market.js';
import { demoCandles } from '../js/lib/demo.js';

test('the shown chance of a rise is the raw one shrunk by its measured trust', () => {
  const logit = (p) => Math.log(p / (1 - p));
  const expected = 1 / (1 + Math.exp(-0.9 * logit(0.7)));
  assert.ok(Math.abs(shownProbUp(0.7, '1m') - expected) < 1e-12);
  // less trust, closer to 50%, and never past the raw value or across 50%
  assert.ok(0.5 < shownProbUp(0.7, '15m') && shownProbUp(0.7, '15m') < shownProbUp(0.7, '5m'));
  assert.ok(shownProbUp(0.7, '5m') < shownProbUp(0.7, '1m') && shownProbUp(0.7, '1m') < 0.7);
  assert.ok(Math.abs(shownProbUp(0.3, '1m') + shownProbUp(0.7, '1m') - 1) < 1e-12, 'up and down are treated alike');
  // no trust, or never tested: the page says nothing about direction
  for (const iv of ['1h', '4h', '1d', '1s', '10s', '1w', null]) assert.equal(shownProbUp(0.83, iv), 0.5, `${iv}`);
});

test('every tested timeframe has a trust between 0 and 1', () => {
  for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
    const s = TESTED_ACCURACY.directionTrust[iv];
    assert.equal(typeof s, 'number', `${iv} has no trust value`);
    assert.ok(s >= 0 && s <= 1, `${iv}: ${s}`);
  }
  assert.equal(directionReliable('1m'), true);
  assert.equal(directionReliable('4h'), false);
  assert.equal(directionReliable('1w'), false);
});

test('the assistant gets the shown probability, with the raw one beside it', () => {
  const fc = forecast(demoCandles('bitcoin', '4h', 600), { horizon: 6, fast: true });
  assert.ok(fc.ok);
  const untrusted = summarizeForecast(fc, '4h');
  assert.equal(untrusted.probUpPct, 50);
  assert.equal(untrusted.directionReliable, false);
  assert.equal(untrusted.direction, 'SIDEWAYS');
  assert.equal(untrusted.confidence, 'Low');
  assert.equal(untrusted.rawProbUpPct, +(fc.probUp * 100).toFixed(1));
  const trusted = summarizeForecast(fc, '1m');
  assert.equal(trusted.probUpPct, +(shownProbUp(fc.probUp, '1m') * 100).toFixed(1));
  assert.equal(trusted.directionReliable, true);
});

test('a forecast with no trusted direction does not vote in a recommendation', () => {
  const signal = generateSignal(demoCandles('bitcoin', '4h', 400), { interval: '4h' });
  const fc = { ok: true, probUp: 0.9, ensemble: { accuracy: 0.7, baseline: 0.5 } };
  const withIt = adviseCoin({ signal, forecast: fc, interval: '4h' });
  const without = adviseCoin({ signal, forecast: null, interval: '4h' });
  assert.equal(withIt.score, without.score);
  assert.equal(withIt.verdict, without.verdict);
  assert.match(withIt.reasons.find((r) => /AI forecast/.test(r.text)).text, /no reliable direction on 4h/);
  // where it is trusted it speaks with the shown number, not the raw one
  const minute = adviseCoin({ signal, forecast: fc, interval: '1m' });
  assert.match(minute.reasons.find((r) => /AI forecast/.test(r.text)).text, new RegExp(`${Math.round(shownProbUp(0.9, '1m') * 100)}% chance of rising`));
});

test('scans only use candles the forecast was tested on', () => {
  assert.equal(isTestedSource({ source: 'binance' }), true);
  assert.equal(isTestedSource({ source: 'gate', venue: 'Gate.io XMR/USDT' }), true);
  assert.equal(isTestedSource({ source: 'coingecko', lowRes: true }), false);
  assert.equal(isTestedSource({ source: 'demo' }), false);
  assert.equal(isTestedSource(null), false);
});

// ------------------------------------------------ candles from other exchanges
const MIN = 60e3;
const recent = (n) => { const end = Math.floor(Date.now() / MIN) * MIN; return Array.from({ length: n }, (_, i) => end - (n - 1 - i) * MIN); };
async function withFetch(answer, fn) {
  const real = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (url) => {
    hosts.push(new URL(url).hostname);
    return new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(hosts); } finally { globalThis.fetch = real; }
}
// Gate.io rows: [time s, quote volume, close, high, low, open, base volume, closed]
const gate = (o, h, l, c) => recent(60).map((t) => [String(t / 1e3), '1000', String(c), String(h), String(l), String(o), '5', 'true']);
// HTX rows, newest first
const htx = (price) => ({ status: 'ok', data: recent(60).reverse().map((t) => ({ id: t / 1e3, open: price, close: price, high: price, low: price, amount: 3 })) });

test('Gate.io candles are read field by field, oldest first', async () => {
  await withFetch((url) => (url.includes('gateio') ? gate(100, 120, 90, 110) : { data: [] }), async (hosts) => {
    const r = await exchangeCandles({ symbol: 'GATETEST', price: 110 }, '1m', 60);
    assert.equal(r.source, 'gate');
    assert.equal(r.venue, 'Gate.io GATETEST/USDT');
    assert.equal(r.candles.length, 60);
    assert.deepEqual({ ...r.candles.at(-1), t: 0 }, { t: 0, o: 100, h: 120, l: 90, c: 110, v: 5 });
    assert.ok(r.candles.every((c, i) => i === 0 || c.t > r.candles[i - 1].t));
    assert.deepEqual(hosts, ['api.gateio.ws']);
  });
});

test('a different token that shares the ticker is not charted: the next exchange is used', async () => {
  // Gate's "PRICETEST" trades at 0.02 while the coin is worth 150
  await withFetch((url) => (url.includes('gateio') ? gate(0.02, 0.02, 0.02, 0.02) : url.includes('huobi') ? htx(150) : { data: [] }), async (hosts) => {
    const r = await exchangeCandles({ symbol: 'PRICETEST', price: 150 }, '1m', 60);
    assert.equal(r.source, 'htx');
    assert.equal(r.candles.at(-1).c, 150);
    assert.deepEqual(hosts, ['api.gateio.ws', 'api.huobi.pro']);
  });
});

test('candles that stopped days ago are not passed off as live', async () => {
  const old = recent(60).map((t) => t - 5 * 864e5);
  const stale = old.map((t) => [String(t / 1e3), '1', '10', '10', '10', '10', '1', 'true']);
  await withFetch((url) => (url.includes('gateio') ? stale : { data: [] }), async () => {
    assert.equal(await exchangeCandles({ symbol: 'STALETEST', price: 10 }, '1m', 60), null);
  });
});

// ------------------------------------------------ trust learned on the device
import { learnedTrust, directionTrustFor, MIN_GRADED_FOR_TRUST } from '../js/lib/selfimprove.js';

// Graded forecasts where the model leaned `p` up and the price rose when `rose(i)` says so.
const graded = (interval, n, p, rose) => ({
  entries: Array.from({ length: n }, (_, i) => ({ resolved: true, interval, probUp: i % 2 ? p : 1 - p, actualUp: rose(i) })),
});

test('a device with too few graded forecasts uses the release test as it is', () => {
  const t = learnedTrust(graded('15m', MIN_GRADED_FOR_TRUST - 1, 0.7, () => true), '15m');
  assert.deepEqual(t, { trust: TESTED_ACCURACY.directionTrust['15m'], prior: TESTED_ACCURACY.directionTrust['15m'], local: null, graded: MIN_GRADED_FOR_TRUST - 1 });
});

test('leans that keep coming true raise the trust, leans that do not lower it, both only partly', () => {
  const prior = TESTED_ACCURACY.directionTrust['15m'];
  // the price rose exactly when the model leaned up
  const right = learnedTrust(graded('15m', 120, 0.7, (i) => i % 2 === 1), '15m');
  assert.equal(right.local, 1);
  assert.ok(right.trust > prior && right.trust < 1, `${right.trust}`);
  // the price rose half the time whatever the model said
  const noise = learnedTrust(graded('15m', 120, 0.7, (i) => Math.floor(i / 2) % 2 === 0), '15m');
  assert.equal(noise.local, 0);
  assert.ok(noise.trust < prior && noise.trust > 0, `${noise.trust}`);
  // 240 release-test forecasts against 120 of this device's: the blend sits a third of the way
  assert.ok(Math.abs(right.trust - (prior * 240 + 1 * 120) / 360) < 1e-12);
});

test('a timeframe the release test found no direction on stays at zero, whatever the device saw', () => {
  const t = learnedTrust(graded('4h', 500, 0.8, (i) => i % 2 === 1), '4h');
  assert.equal(t.local, 1);
  assert.equal(t.trust, 0);
  assert.equal(directionTrustFor('4h', graded('4h', 500, 0.8, (i) => i % 2 === 1)).trust, 0);
});

test('the pages pass the learned trust through to what they show', () => {
  const fc = forecast(demoCandles('bitcoin', '4h', 600), { horizon: 6, fast: true });
  const trust = learnedTrust(graded('15m', 120, 0.7, (i) => i % 2 === 1), '15m').trust;
  assert.equal(summarizeForecast(fc, '15m', trust).probUpPct, +(shownProbUp(fc.probUp, '15m', trust) * 100).toFixed(1));
});
