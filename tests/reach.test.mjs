// Exchanges that refuse a region: the first refusal is remembered and the host
// is skipped, so a visitor there sees data from the next source and no wall of
// CORS errors.
import test from 'node:test';
import assert from 'node:assert/strict';

// The requests below must run as if from outside the US, wherever the tests run.
process.env.TZ = 'Asia/Karachi';
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { inUsTimeZone, refusedHere, noteRefusal, forgetRefusals, REFUSAL_MEMORY_MS } = await import('../js/api/reach.js');
const { getJson, getJsonAny } = await import('../js/api/http.js');

test('US time zones are recognised; Canadian and Mexican ones are not', () => {
  for (const z of ['America/New_York', 'America/Los_Angeles', 'America/Indiana/Indianapolis', 'America/Kentucky/Louisville', 'Pacific/Honolulu', 'America/Phoenix']) assert.ok(inUsTimeZone(z), z);
  for (const z of ['America/Toronto', 'America/Vancouver', 'America/Mexico_City', 'Asia/Karachi', 'Europe/London', 'UTC', '', undefined]) assert.ok(!inUsTimeZone(z), String(z));
});

test('a refusal is remembered for half a day, for the host and its stream', () => {
  forgetRefusals(); store.clear();
  const now = 1_000_000;
  const zone = 'Asia/Karachi';
  assert.equal(refusedHere('fapi.binance.com', { now, zone }), false);
  noteRefusal('fapi.binance.com', { now });
  assert.equal(refusedHere('fapi.binance.com', { now, zone }), true);
  assert.equal(refusedHere('fstream.binance.com', { now, zone }), true, 'the stream shares the policy');
  assert.equal(refusedHere('api.binance.com', { now, zone }), false, 'spot is a separate question');
  assert.equal(refusedHere('fapi.binance.com', { now: now + REFUSAL_MEMORY_MS, zone }), false, 'it expires');
  forgetRefusals();
  assert.equal(refusedHere('fapi.binance.com', { now, zone }), true, 'kept on the device across pages');
});

test('hosts that serve every region are never skipped', () => {
  noteRefusal('data-api.binance.vision');
  noteRefusal('www.okx.com');
  assert.equal(refusedHere('data-api.binance.vision', { zone: 'America/Chicago' }), false);
  assert.equal(refusedHere('www.okx.com', { zone: 'America/Chicago' }), false);
  assert.equal(refusedHere('api.bybit.com', { zone: 'America/Chicago' }), true);
});

test('one refused request, not a dozen: the rest wait for the first and are skipped', async () => {
  forgetRefusals(); store.clear();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); throw new TypeError('Failed to fetch'); };
  try {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => getJson(`https://api.bybit.com/v5/x?i=${i}`)));
    assert.equal(calls, 1, 'only the first request went out');
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.equal(r.reason.status, 451);
    }
    await assert.rejects(getJson('https://api.bybit.com/v5/y'), (e) => e.status === 451);
    assert.equal(calls, 1, 'later requests are skipped too');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a host that answers is asked normally, in parallel', async () => {
  forgetRefusals(); store.clear();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return { ok: true, status: 200, json: async () => ({ url }) }; };
  try {
    const out = await Promise.all(Array.from({ length: 4 }, (_, i) => getJson(`https://fapi.binance.com/fapi/v1/a?i=${i}`)));
    assert.equal(out.length, 4);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an "invalid symbol" answer is not asked of the next mirror', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(new URL(url).hostname); return { ok: false, status: 400, json: async () => ({}) }; };
  try {
    await assert.rejects(getJsonAny(['https://mirror-a.test', 'https://mirror-b.test'], '/api/v3/klines?symbol=NOPE'), (e) => e.status === 400);
    assert.deepEqual(asked, ['mirror-a.test']);
  } finally {
    globalThis.fetch = realFetch;
  }
});
