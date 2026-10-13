// The AI signal's live record: the row the server writes at each close, and
// how the Track page counts it — only what happened after tracking began.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiSignalRow, aiSignal } from '../js/lib/autotrader.js';
import { aiRecordStats } from '../js/lib/airecord.js';

const T0 = Date.UTC(2026, 0, 1), H = 4 * 3600e3;
function wavy(n = 700) {
  const out = [];
  for (let i = 0, prev = 100; i < n; i++) {
    const c = 100 * (i < 300 ? 0.998 ** i : 0.998 ** 300 * 1.003 ** (i - 300)) * (1 + 0.02 * Math.sin(i / 5));
    out.push({ t: T0 + i * H, o: prev, h: Math.max(prev, c) * 1.01, l: Math.min(prev, c) * 0.99, c, v: 1000 });
    prev = c;
  }
  return out;
}

test('the server writes what the signal said on the last closed candle, and when to grade it', () => {
  const c = wavy();
  for (let n = 400; n <= 700; n += 7) {
    const cut = c.slice(0, n);
    const row = aiSignalRow(cut, '4h', 'W', { horizonBars: 6, intervalMs: H });
    const a = aiSignal(cut, '4h', 'W');
    assert.equal(row.action, a.action);
    assert.equal(row.candle_time, new Date(cut.at(-1).t).toISOString());
    assert.equal(Date.parse(row.horizon_at), cut.at(-1).t + H + 6 * H, 'graded six candles after the logged one closed');
    if (row.action === 'sell') { assert.ok(Number.isFinite(row.trade_pct) && row.exit_price > 0 && row.stop === null); }
    if (row.action === 'buy' || row.action === 'hold') { assert.ok(row.entry > 0 && row.opened_at); }
    if (row.action === 'wait') { assert.equal(row.entry, null); }
  }
  assert.equal(aiSignalRow(c.slice(0, 100), '4h', 'W', { horizonBars: 6, intervalMs: H }), null);
});

test('the live record counts only trades bought after tracking began', () => {
  const iso = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
  const rows = [
    { symbol: 'BTC', interval: '1d', candle_time: iso(13), action: 'hold', resolved: true, fwd_up: true, opened_at: iso(1) },
    { symbol: 'BTC', interval: '1d', candle_time: iso(14), action: 'sell', resolved: true, fwd_up: false, trade_pct: 5.2, opened_at: iso(1) }, // bought before tracking: not counted
    { symbol: 'BTC', interval: '1d', candle_time: iso(16), action: 'buy', resolved: true, fwd_up: true, opened_at: iso(16) },
    { symbol: 'BTC', interval: '1d', candle_time: iso(20), action: 'sell', resolved: false, fwd_up: null, trade_pct: -1.5, opened_at: iso(16) },
    { symbol: 'ETH', interval: '1d', candle_time: iso(13), action: 'wait', resolved: true, fwd_up: false },
    { symbol: 'ETH', interval: '1d', candle_time: iso(14), action: 'buy', resolved: true, fwd_up: false, opened_at: iso(14) },
    { symbol: 'ETH', interval: '1d', candle_time: iso(15), action: 'hold', resolved: false, fwd_up: null, opened_at: iso(14) },
  ];
  const s = aiRecordStats(rows)['1d'];
  assert.equal(s.logged, 7);
  assert.equal(s.coins, 2);
  assert.equal(s.graded, 5);
  assert.equal(s.anyUpPct, 40);
  assert.equal(s.buys, 2);
  assert.equal(s.buyUpPct, 50);
  assert.deepEqual([s.trades, s.wins, s.avgTradePct], [1, 0, -1.5], 'the trade bought before tracking began is left out');
  assert.equal(s.open, 1, 'ETH is in a trade on its latest candle, BTC is not');
  assert.equal(s.since, Date.parse(iso(13)));
});
