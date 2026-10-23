// The server's learning job: it covers every coin with Binance candles on every
// chart, grades calls once their outcome candle closes, drops the ones it can
// no longer grade, and learns the same way the browser's pass does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slotFor, learnRun, learnSummary, LEARN_COINS, LEARN_HORIZON, LEARN_INTERVAL_MS, LEARN_INTERVALS, candlesToRead } from '../supabase/functions/cv/learnjob.js';
import { DEFAULT_HORIZON } from '../js/ai/context.js';
import { INTERVAL_MS } from '../js/api/market.js';

const universe = JSON.parse(readFileSync(new URL('../tools/universe.json', import.meta.url), 'utf8'));

test('it learns on the coins the evaluation reads from Binance, at the forecast\'s own horizons', () => {
  assert.deepEqual(LEARN_COINS, universe.coins.filter((c) => c.venue === 'binance').map((c) => c.symbol));
  for (const iv of LEARN_INTERVALS) {
    assert.equal(LEARN_HORIZON[iv], DEFAULT_HORIZON[iv], `${iv} horizon`);
    assert.equal(LEARN_INTERVAL_MS[iv], INTERVAL_MS[iv], `${iv} candle length`);
  }
});

test('every coin comes round on every chart about every 78 minutes, and on 1m before its last call falls out of reach', () => {
  const seen = new Set();
  const start = Date.UTC(2026, 9, 22);
  const cycle = LEARN_INTERVALS.length * Math.ceil(LEARN_COINS.length / 6);
  const last = {};
  let worstGap = 0;
  for (let k = 0; k < cycle * 2; k++) {
    const now = start + k * 60e3;
    const s = slotFor(now);
    assert.ok(s.symbols.length > 0 && s.symbols.length <= 6);
    for (const sym of s.symbols) {
      seen.add(`${sym}:${s.interval}`);
      const key = `${sym}:${s.interval}`;
      if (s.interval === '1m' && last[key]) worstGap = Math.max(worstGap, now - last[key]);
      last[key] = now;
    }
  }
  assert.equal(seen.size, LEARN_COINS.length * LEARN_INTERVALS.length);
  assert.ok(worstGap + LEARN_HORIZON['1m'] * 6e4 < candlesToRead('1m') * 6e4, `a 1m call is graded within the candles read (${worstGap / 36e5} h between visits)`);
  assert.ok(worstGap <= 80 * 60e3, `back on each chart within 80 minutes (${worstGap / 60e3} min)`);
});

const H = 3600e3;
function series(n, t0, drift = 0.001) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + drift + 0.006 * Math.sin(i / 3));
    out.push({ t: t0 + i * H, o: p, h: Math.max(p, c) * 1.002, l: Math.min(p, c) * 0.998, c, v: 1000 });
    p = c;
  }
  return out;
}

test('a call is logged before its outcome, graded once its candle closes, and counted in the summary', () => {
  const t0 = Date.UTC(2026, 8, 1);
  const all = series(560, t0);
  const fc = () => ({ ok: true, probUp: 0.62 });
  // first run: candles up to 500, one call per coin
  const r1 = learnRun(null, '1h', [{ symbol: 'AAA', candles: all.slice(0, 500) }, { symbol: 'BBB', candles: all.slice(0, 500) }], { forecast: fc, now: all[499].t + 2 * H });
  assert.equal(r1.logged, 2);
  assert.equal(r1.summary.calls, 2);
  assert.equal(r1.summary.scored, 0);
  assert.equal(r1.summary.waiting.forecast, 2);
  assert.equal(r1.summary.coins, 2);
  assert.ok(r1.summary.history.macd.n > 0, 'indicators measured on history');
  // the same candle again logs nothing new
  assert.equal(learnRun(r1.ledger, '1h', [{ symbol: 'AAA', candles: all.slice(0, 500) }], { forecast: fc }).logged, 0);
  // 12 candles later the outcome has closed: graded against the close 12 candles on
  const r2 = learnRun(r1.ledger, '1h', [{ symbol: 'AAA', candles: all.slice(0, 513) }], { forecast: fc, now: all[512].t + 2 * H });
  assert.equal(r2.scored, 1);
  const row = r2.ledger.rows.find((r) => r.symbol === 'AAA' && r.resolved);
  assert.equal(row.up, all[511].c > all[499].c ? 1 : -1);
  assert.equal(r2.summary.live.forecast.n, 1);
  assert.equal(r2.summary.scored, 1);
  assert.equal(r2.summary.coins, 2, 'BBB\'s measurement is kept until it comes round again');
});

test('a call whose outcome candle can no longer be read is dropped and counted, not left waiting', () => {
  const t0 = Date.UTC(2026, 8, 1);
  const all = series(1400, t0);
  const r1 = learnRun(null, '1h', [{ symbol: 'AAA', candles: all.slice(0, 500) }], { forecast: () => ({ ok: true, probUp: 0.4 }) });
  // the next read starts long after that call's outcome candle
  const r2 = learnRun(r1.ledger, '1h', [{ symbol: 'AAA', candles: all.slice(900, 1400) }], { forecast: () => ({ ok: true, probUp: 0.4 }) });
  assert.equal(r2.expired, 1);
  assert.equal(r2.summary.expired, 1);
  assert.equal(r2.ledger.rows.filter((r) => !r.resolved).length, 1, 'only the new call waits');
});

test('the summary the pages read is small and complete', () => {
  const r = learnRun(null, '4h', [{ symbol: 'AAA', candles: series(500, Date.UTC(2026, 0, 1)) }], { forecast: () => ({ ok: false }) });
  const s = learnSummary(r.ledger, '4h');
  for (const k of ['interval', 'lastPass', 'calls', 'scored', 'waiting', 'coins', 'history', 'live', 'weights', 'champion', 'changes']) assert.ok(k in s, k);
  assert.equal(s.champion, 'forecast');
  assert.equal(s.waiting.forecast, 0, 'no forecast, nothing waiting for it');
  assert.ok(JSON.stringify(s).length < 20000);
});

test('the page is told when a waiting call will really be graded: when its coin comes round again', async () => {
  const { nextVisit } = await import('../supabase/functions/cv/learnjob.js');
  const t0 = Date.UTC(2026, 9, 22, 15, 0);
  const at = nextVisit('BTC', '1m', t0 + 20 * 60e3);
  assert.ok(at >= t0 + 20 * 60e3);
  const s = slotFor(at);
  assert.equal(s.interval, '1m');
  assert.ok(s.symbols.includes('BTC'));
  // and nothing earlier would have taken it
  for (let t = Math.ceil((t0 + 20 * 60e3) / 60e3) * 60e3; t < at; t += 60e3) { const x = slotFor(t); assert.ok(!(x.interval === '1m' && x.symbols.includes('BTC'))); }
  const r = learnRun(null, '1m', [{ symbol: 'BTC', candles: series(500, t0 - 500 * 6e4).map((c, i) => ({ ...c, t: t0 - (500 - i) * 6e4 })) }], { forecast: () => ({ ok: true, probUp: 0.6 }), now: t0 });
  assert.ok(r.summary.waiting.nextAt > t0 + 15 * 60e3, 'not when the 1m outcome closes, when the coin is taken again');
});

test('a page never waits more than a few seconds for the cloud record, and keeps the last good copy', async () => {
  globalThis.window ??= new EventTarget();
  const { cloudLearning, cloudLearningNow } = await import('../js/lib/cloudlearn.js');
  const good = { '1h': { calls: 5, weights: {} } };
  assert.deepEqual(await cloudLearning({ force: true, read: async () => good }), good);
  const t = Date.now();
  const r = await cloudLearning({ force: true, read: () => new Promise(() => {}) });   // a cloud that never answers
  assert.ok(Date.now() - t < 6000, `gave up after ${Date.now() - t} ms`);
  assert.deepEqual(r, good, 'the last good copy, not nothing');
  assert.deepEqual(cloudLearningNow(), good);
});
