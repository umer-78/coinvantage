// Live candles from Gate.io, HTX and OKX: each venue's message format, its
// keep-alive, and what the stream does when the socket drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseCandle, streamCandles } from '../js/api/exstream.js';

// message shapes as each exchange documents them
const GATE = { time: 1606292600, channel: 'spot.candlesticks', event: 'update',
  result: { t: '1606292580', v: '2362.32', c: '19128.1', h: '19130', l: '19120.5', o: '19125', n: '1m_BTC_USDT', a: '3.8283', w: false } };
const HTX = { ch: 'market.btcusdt.kline.1min', ts: 1489474082831,
  tick: { id: 1489464480, amount: 12.5, count: 3, open: 7962.62, close: 7970, low: 7960, high: 7975.5, vol: 99612.3 } };
const OKX = { arg: { channel: 'candle1m', instId: 'BTC-USDT' },
  data: [['1597026383085', '8533.02', '8553.74', '8527.17', '8548.26', '45247', '529.58', '529.58', '0']] };

test('reads a candle from each venue, with volume in the base coin', () => {
  assert.deepEqual(parseCandle('gate', GATE), { t: 1606292580000, o: 19125, h: 19130, l: 19120.5, c: 19128.1, v: 3.8283 });
  assert.deepEqual(parseCandle('htx', HTX), { t: 1489464480000, o: 7962.62, h: 7975.5, l: 7960, c: 7970, v: 12.5 });
  assert.deepEqual(parseCandle('okx', OKX), { t: 1597026383085, o: 8533.02, h: 8553.74, l: 8527.17, c: 8548.26, v: 45247 });
});

test('acks, pings, errors and broken prices are not candles', () => {
  assert.equal(parseCandle('gate', { channel: 'spot.candlesticks', event: 'subscribe', result: { status: 'success' } }), null);
  assert.equal(parseCandle('htx', { ping: 1492420473027 }), null);
  assert.equal(parseCandle('htx', { id: 'cv', status: 'ok', subbed: 'market.btcusdt.kline.1min' }), null);
  assert.equal(parseCandle('okx', { event: 'subscribe', arg: { channel: 'candle1m', instId: 'BTC-USDT' } }), null);
  assert.equal(parseCandle('okx', { event: 'error', code: '60018', msg: 'Invalid request' }), null);
  assert.equal(parseCandle('okx', { ...OKX, data: [['1597026383085', '0', '1', '1', '1', '5']] }), null);
  assert.equal(parseCandle('gate', { ...GATE, result: { ...GATE.result, c: 'NaN' } }), null);
  assert.equal(parseCandle('nope', GATE), null);
});

// A stand-in for the browser's WebSocket that the test drives by hand.
class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeSocket.all.push(this); }
  send(m) { this.sent.push(m); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen(); }
  push(data) { this.onmessage({ data }); }
}
async function withSockets(fn) {
  const real = globalThis.WebSocket;
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  try { return await fn(); } finally { globalThis.WebSocket = real; }
}
// wait for a condition rather than a fixed time, so a slow machine is not a failure
async function until(ok, ms = 3000) {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 10))) {
    if (Date.now() > end) throw new Error('timed out waiting');
  }
}

test('subscribes to the pair and interval the chart shows', () => withSockets(async () => {
  const stops = [
    streamCandles('gate', 'XMR', '1w', () => {}),
    streamCandles('htx', 'KAS', '1h', () => {}),
    streamCandles('okx', 'HYPE', '4h', () => {}),
  ];
  for (const s of FakeSocket.all) s.open();
  const [gate, htx, okx] = FakeSocket.all.map((s) => JSON.parse(s.sent[0]));
  assert.deepEqual(gate.payload, ['7d', 'XMR_USDT']);
  assert.deepEqual(htx, { sub: 'market.kasusdt.kline.60min', id: 'cv' });
  assert.deepEqual(okx.args, [{ channel: 'candle4H', instId: 'HYPE-USDT' }]);
  assert.equal(FakeSocket.all[2].url, 'wss://ws.okx.com:8443/ws/v5/business');
  stops.forEach((s) => s());
  assert.equal(streamCandles('gate', 'XMR', '1s', () => {}), null, 'no venue streams 1s candles');
}));

test('HTX frames are unzipped in order and its pings are answered', () => withSockets(async () => {
  const got = [];
  const stop = streamCandles('htx', 'BTC', '1m', (c) => got.push(c.c));
  const s = FakeSocket.all[0];
  s.open();
  const zip = (m) => new Uint8Array(gzipSync(JSON.stringify(m))).buffer;
  s.push(zip({ ping: 42 }));
  for (const close of [1, 2, 3]) s.push(zip({ ...HTX, tick: { ...HTX.tick, close } }));
  await until(() => got.length === 3);
  assert.deepEqual(JSON.parse(s.sent[1]), { pong: 42 });
  assert.deepEqual(got, [1, 2, 3]);
  stop();
}));

test('says when candles start and stop, and reconnects after a drop', () => withSockets(async () => {
  const live = [];
  const stop = streamCandles('gate', 'XMR', '1m', () => {}, (on) => live.push(on));
  const first = FakeSocket.all[0];
  first.open();
  assert.deepEqual(live, [], 'an open socket is not live until a candle arrives');
  first.push(JSON.stringify(GATE));
  await until(() => live.length === 1);
  first.close();
  assert.deepEqual(live, [true, false]);
  await until(() => FakeSocket.all.length === 2); // first retry after 1 s
  stop();
  assert.equal(FakeSocket.all[1].readyState, 3, 'stop() closes the socket');
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(FakeSocket.all.length, 2, 'and nothing reconnects after stop()');
}));
