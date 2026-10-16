// A forecast you were shown is graded against the close at its horizon, read
// from the exchange at that moment. Reading it from the latest candles left
// every forecast older than the last 500 candles ungraded for good (eight
// hours of 1m candles, 42 minutes of 5s ones).
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= new EventTarget(); // the store announces its writes
const { closeAtTime } = await import('../js/api/market.js');

const H = 3600e3;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const kline = (t, c) => [t, String(c), String(c), String(c), String(c), '1', t + 1, '0', 1, '0', '0', '0'];
function mockBinance(rowsFor) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.pathname.endsWith('/klines')) return json(rowsFor(u.searchParams));
    throw new TypeError('Failed to fetch');
  };
  return calls;
}

test('a forecast from days ago is graded with the close of the candle at its horizon', async () => {
  const at = Math.floor(Date.now() / H) * H - 5 * 24 * H; // five days back, on the hour
  const calls = mockBinance((q) => (+q.get('endTime') >= at ? [kline(at, 101.5)] : []));
  const r = await closeAtTime({ symbol: 'BTC', binance: 'BTCUSDT' }, '1h', at);
  assert.deepEqual(r, { close: 101.5 });
  assert.equal(calls[0].searchParams.get('endTime'), String(at), 'asks for that moment, not the latest candles');
  assert.equal(calls[0].searchParams.get('limit'), '1');
});

test('a candle still forming is not used: the grade waits for its close', async () => {
  const at = Math.floor(Date.now() / H) * H; // the current hour
  const calls = mockBinance(() => [kline(at, 99)]);
  assert.deepEqual(await closeAtTime({ symbol: 'ETH', binance: 'ETHUSDT' }, '1h', at), { retry: true });
  assert.equal(calls.length, 0);
});

test('an older candle across a gap is not taken for the one asked about', async () => {
  const at = Math.floor(Date.now() / H) * H - 30 * H;
  mockBinance(() => [kline(at - 3 * H, 50)]); // the exchange has nothing for that hour
  assert.deepEqual(await closeAtTime({ symbol: 'XRP', binance: 'XRPUSDT' }, '1h', at), { missing: true });
});

test('a second chart is graded with the last 1s close inside its candle', async () => {
  const at = Math.floor(Date.now() / 5e3) * 5e3 - 3 * 24 * H;
  const calls = mockBinance((q) => (q.get('interval') === '1s' ? [kline(+q.get('endTime'), 7.25)] : []));
  const r = await closeAtTime({ symbol: 'SOL', binance: 'SOLUSDT' }, '5s', at);
  assert.deepEqual(r, { close: 7.25 });
  assert.equal(calls[0].searchParams.get('interval'), '1s');
  assert.equal(+calls[0].searchParams.get('endTime'), at + 4e3, 'the 5s candle closes on its fifth second');
});

test('a dropped connection means try again, not a missing candle', async () => {
  const at = Math.floor(Date.now() / H) * H - 10 * H;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await closeAtTime({ symbol: 'DOGE', binance: 'DOGEUSDT' }, '1h', at), { retry: true });
});

test('a coin read on another exchange is graded from that exchange at that moment', async () => {
  const D = 24 * H, at = Math.floor(Date.now() / H) * H - 4 * D;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('okx.com') && u.includes('history-candles') && u.includes(`after=${at + 1}`)) return json({ code: '0', data: [[String(at), '3', '3', '3', '3.1', '9']] });
    if (u.includes('okx.com')) {
      const end = Math.floor(Date.now() / D) * D;
      return json({ code: '0', data: Array.from({ length: 300 }, (_, k) => [String(end - k * D), '3', '3', '3', '3', '9']) });
    }
    if (u.includes('huobi')) return json({ status: 'error', 'err-msg': 'invalid symbol' });
    throw new TypeError('Failed to fetch');
  };
  const r = await closeAtTime({ symbol: 'OKXONLY', price: 3 }, '1h', at);
  assert.deepEqual(r, { close: 3.1 });
  assert.ok(calls.some((u) => u.includes('history-candles') && u.includes('bar=1H')), 'asks OKX for the hour that was forecast');
});
