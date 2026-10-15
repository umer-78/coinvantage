// The fetch wrapper's per-host breaker: one failed request must not take a
// whole exchange out; three in a row do, for a short while.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getJson } from '../js/api/http.js';

test('one failed request does not cut off the host; three in a row do', async () => {
  const realFetch = globalThis.fetch;
  let failNext = 0, calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (failNext > 0) { failNext--; throw new TypeError('network'); }
    return { ok: true, status: 200, json: async () => ({ url }) };
  };
  try {
    failNext = 1;
    await assert.rejects(getJson('https://ex.test/a'));
    assert.deepEqual(await getJson('https://ex.test/b'), { url: 'https://ex.test/b' }, 'the next request still goes out');

    failNext = 2;
    await assert.rejects(getJson('https://ex.test/c'));
    await assert.rejects(getJson('https://ex.test/d'));
    assert.ok(await getJson('https://ex.test/e'), 'two failures, then an answer: still up');

    failNext = 3;
    for (const k of ['f', 'g', 'h']) await assert.rejects(getJson(`https://ex.test/${k}`));
    const before = calls;
    await assert.rejects(getJson('https://ex.test/i'), /unavailable/, 'three in a row: the host rests');
    assert.equal(calls, before, 'without another request going out');
    assert.ok(await getJson('https://other.test/x'), 'other hosts are not affected');
  } finally {
    globalThis.fetch = realFetch;
  }
});
