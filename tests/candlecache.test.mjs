// The AI trader's checks ask only for new candles; the window they trade on
// must be the one a full fetch returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { candleCache } from '../js/lib/candlecache.js';

const H = 3600e3;
function exchange(start) {
  const all = Array.from({ length: 2000 }, (_, i) => ({ t: start + i * H, c: 100 + Math.sin(i) }));
  const ex = { now: start + 1200 * H + 1, source: 'binance', short: false, calls: [] };
  ex.fetch = async (coin, iv, n) => {
    ex.calls.push(n);
    const rows = all.filter((c) => c.t <= ex.now);
    // `short`: a small request comes back with only the last two candles
    return { source: ex.source, candles: rows.slice(-(ex.short && n < 500 ? 2 : n)).map((c) => ({ ...c })) };
  };
  return ex;
}

test('later checks fetch a few candles and trade on the same window as a full fetch', async () => {
  const realNow = Date.now;
  const ex = exchange(Date.UTC(2026, 0, 1));
  Date.now = () => ex.now;
  try {
    const get = candleCache(ex.fetch, { window: 500, stepOf: () => H });
    const coin = { symbol: 'BTC' };
    assert.equal((await get(coin, '1h')).candles.length, 500);
    assert.deepEqual(ex.calls, [500], 'the first check fetches the window');
    for (let k = 1; k <= 30; k++) {
      ex.now += H / 12 + (k % 7 === 0 ? 3 * H : 0);   // checks every five minutes, now and then after a pause
      const got = await get(coin, '1h');
      const full = await ex.fetch(coin, '1h', 500);
      assert.deepEqual(got.candles, full.candles, `check ${k}: same window as a full fetch`);
    }
    assert.ok(ex.calls.filter((n, i) => i % 2 === 1 && i > 1).every((n) => n < 20), `small fetches: ${ex.calls.join(',')}`);
    // a reply that leaves a hole, or another exchange: the whole window again
    ex.calls.length = 0;
    ex.now += 5 * H;
    ex.short = true;
    const g = await get(coin, '1h');
    assert.ok(ex.calls.length === 2 && ex.calls[0] < 20 && ex.calls[1] === 500, `a hole fetches the whole window: ${ex.calls}`);
    assert.deepEqual(g.candles, (await ex.fetch(coin, '1h', 500)).candles);
    ex.short = false;
    ex.calls.length = 0;
    ex.source = 'gate';
    ex.now += H / 12;
    await get(coin, '1h');
    assert.ok(ex.calls.includes(500), 'another exchange fetches the whole window');
  } finally {
    Date.now = realNow;
  }
});
