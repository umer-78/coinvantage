// Coins Binance does not list are looked for on Gate.io, HTX and OKX. The
// exchange that had a coin is tried first next time, and a coin none of them
// has is not looked for again straight away.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= new EventTarget(); // the store announces its writes
const { exchangeCandles, looksPegged, isStable } = await import('../js/api/market.js');

const H = 3600e3;
function okxRows(n, price) {
  const end = Math.floor(Date.now() / H) * H;
  return Array.from({ length: n }, (_, k) => { const t = end - k * H; return [String(t), String(price), String(price * 1.01), String(price * 0.99), String(price), '100']; });
}
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// What each exchange says about a pair it does not list, as a web page sees it:
// HTX and OKX answer in a readable reply; Gate.io's error reply has no CORS
// header, so the browser reports it as a failed request.
function mockNet(okxHas, { offline = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (offline) throw new TypeError('Failed to fetch');
    if (u.includes('okx.com')) return json(okxHas ? { code: '0', data: okxRows(300, 2) } : { code: '51001', data: [] });
    if (u.includes('huobi')) return json({ status: 'error', 'err-msg': 'invalid symbol' });
    throw new TypeError('Failed to fetch');
  };
  return calls;
}

test('the exchange that had a coin is asked first next time', async () => {
  const coin = { symbol: 'ONLYOKX', price: 2 };
  let calls = mockNet(true);
  const first = await exchangeCandles(coin, '1h', 100);
  assert.equal(first.source, 'okx');
  assert.ok(calls.some((u) => u.includes('gateio')) && calls.some((u) => u.includes('huobi')), 'discovery tries Gate.io and HTX first');
  calls = mockNet(true);
  const again = await exchangeCandles(coin, '15m', 100); // a different chart, so nothing is cached
  assert.equal(again.source, 'okx');
  assert.ok(!calls.some((u) => u.includes('gateio') || u.includes('huobi')), `went straight to OKX: ${calls.join(' ')}`);
  // once found, a check that asks for the last few candles gets them
  calls = mockNet(true);
  const few = await exchangeCandles(coin, '4h', 5);
  assert.equal(few?.source, 'okx');
  assert.equal(few.candles.length, 5);
});

test('a coin no exchange has is not looked for again at once', async () => {
  // The HTTP helper skips a host for 15 seconds after it fails, so the clock is
  // moved past that: only the memory can explain a request not being made.
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const coin = { symbol: 'NOWHERE', price: 1 };
    shift += 20e3;
    let calls = mockNet(false);
    assert.equal(await exchangeCandles(coin, '1h', 100), null);
    assert.ok(calls.length >= 3, `all three tried: ${calls.length}`);
    shift += 20e3;
    calls = mockNet(false);
    assert.equal(await exchangeCandles(coin, '4h', 100), null);
    assert.equal(calls.length, 0, 'remembered: no exchange is asked again for hours');
    shift += 7 * 3600e3;
    calls = mockNet(false);
    await exchangeCandles(coin, '1d', 100);
    assert.ok(calls.length >= 3, 'after six hours it looks again');
    // with no connection at all nothing is remembered: the next look asks again
    const gone = { symbol: 'OFFLINE', price: 1 };
    shift += 7 * 3600e3;
    calls = mockNet(false, { offline: true });
    assert.equal(await exchangeCandles(gone, '1h', 100), null);
    shift += 20e3;
    calls = mockNet(false);
    await exchangeCandles(gone, '4h', 100);
    assert.ok(calls.length >= 3, 'a dropped connection is not "listed nowhere"');
    // a known source asked for by name is always tried
    shift += 20e3;
    calls = mockNet(false);
    await exchangeCandles(coin, '15m', 100, 'gate');
    assert.ok(calls.some((u) => u.includes('gateio')));
  } finally {
    Date.now = realNow;
  }
});

test('a coin whose price held still all week is taken for a stablecoin', () => {
  const week = (f) => Array.from({ length: 168 }, (_, i) => f(i));
  assert.equal(looksPegged(week((i) => 1 + 0.001 * Math.sin(i))), true, 'a dollar coin');
  assert.equal(looksPegged(week((i) => 1.14 * (1 + (0.05 / 8760) * i))), true, 'a treasury fund earning 5% a year');
  assert.equal(looksPegged(week((i) => 60000 * (1 + 0.02 * Math.sin(i / 9)))), false, 'bitcoin moves');
  assert.equal(looksPegged([1, 1, 1]), false, 'too few prices to tell');
  assert.ok(isStable('USDY') && isStable('bfusd') && !isStable('BTC'));
});
