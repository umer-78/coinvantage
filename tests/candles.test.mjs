// Every chart the AI trader offers has candles for every coin: a chart an
// exchange does not publish (Gate.io and HTX have no 2h, 6h or 12h) is built
// from its 1h candles on the UTC boundaries Binance uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateCandles, EX_AGG, EX_BAR, INTERVAL_MS } from '../js/api/market.js';
import { TRADER_CHARTS } from '../js/lib/autotrader.js';

const H = 36e5;
const hours = (n, t0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * H, o: 100 + i, h: 101 + i + (i % 3), l: 99 + i - (i % 2), c: 100.5 + i, v: 10 }));

test('a 6h candle is six 1h candles from a UTC boundary: first open, highest high, lowest low, last close, summed volume', () => {
  const t0 = Date.UTC(2026, 9, 24, 3); // starts inside the 00:00-06:00 bucket
  const out = aggregateCandles(hours(20, t0), 6 * H);
  assert.equal(out[0].t, Date.UTC(2026, 9, 24, 6), 'the bucket the hours start inside is dropped');
  const six = hours(20, t0).slice(3, 9);
  assert.deepEqual(out[0], { t: six[0].t, o: six[0].o, h: Math.max(...six.map((x) => x.h)), l: Math.min(...six.map((x) => x.l)), c: six[5].c, v: 60 });
  for (const b of out) assert.equal(b.t % (6 * H), 0, 'on a 6h boundary');
  assert.equal(out.at(-1).t, Date.UTC(2026, 9, 24, 18), 'the forming bucket is kept, as Binance shows it');
});

test('every trader chart can be read from every exchange, natively or from 1h candles', () => {
  for (const iv of TRADER_CHARTS) {
    assert.ok(INTERVAL_MS[iv] > 0, iv);
    for (const ex of ['gate', 'htx', 'okx']) assert.ok(EX_BAR[ex][iv] || (EX_AGG[iv] && EX_BAR[ex][EX_AGG[iv].base]), `${ex} ${iv}`);
  }
  for (const [iv, a] of Object.entries(EX_AGG)) assert.equal(INTERVAL_MS[iv], a.n * INTERVAL_MS[a.base], iv);
});

test('the cloud trader reads every chart the page offers', () => {
  const src = readFileSync(new URL('../supabase/functions/cv/candles.ts', import.meta.url), 'utf8');
  const step = src.match(/export const STEP_MS[^=]*=\s*\{([^}]+)\}/)[1];
  for (const iv of TRADER_CHARTS) assert.match(step, new RegExp(`'${iv}':`), `server STEP_MS has ${iv}`);
});
