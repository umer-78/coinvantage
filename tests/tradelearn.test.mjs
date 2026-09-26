import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewTrades, decideChanges, activeLessons, tradeR, MIN_TRADES } from '../js/lib/tradelearn.js';
import { newState, replaySymbol, DEFAULT_CONFIG, logCheck } from '../js/lib/autotrader.js';

// Deterministic random walk with a trend, so the trader has something to trade.
function walk(n, seed = 7) {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const o = p; p = p * (1 + (rnd() - 0.47) * 0.02);
    return { t: 1.7e12 + i * 36e5, o, h: Math.max(o, p) * (1 + rnd() * 0.004), l: Math.min(o, p) * (1 - rnd() * 0.004), c: p, v: 100 + rnd() * 50 };
  });
}

const trade = (i, { trendUp, adx = 30, rsi = 55, win, symbol = 'BTC' }) => ({
  symbol, entry: 100, initialStop: 98, qty: 10, riskCash: 20, pnl: win ? 40 : -20,
  openedAt: i * 1000, exitAt: i * 1000 + 500, reason: win ? 'target' : 'stop-loss', ctx: { trendUp, adx, rsi },
});

test('tradeR measures a result in units of the cash risked', () => {
  assert.equal(tradeR(trade(1, { trendUp: true, win: true })), 2);
  assert.equal(tradeR(trade(1, { trendUp: true, win: false })), -1);
});

test('the review changes nothing until it has enough trades', () => {
  const few = Array.from({ length: MIN_TRADES - 1 }, (_, i) => trade(i, { trendUp: false, win: false }));
  const r = reviewTrades(few);
  assert.ok(r.findings[0].includes('needs'));
  assert.deepEqual(decideChanges(r, { ...DEFAULT_CONFIG }).changes, []);
});

test('counter-trend trades that keep losing switch the trend filter on', () => {
  const log = [
    ...Array.from({ length: 10 }, (_, i) => trade(i, { trendUp: false, win: i % 5 === 0 })),   // 20% won
    ...Array.from({ length: 10 }, (_, i) => trade(20 + i, { trendUp: true, win: i % 2 === 0 })), // 50% won
  ];
  const r = reviewTrades(log);
  const d = decideChanges(r, { ...DEFAULT_CONFIG, trendFilter: false }, [], log);
  assert.equal(d.cfgPatch.trendFilter, true);
  assert.ok(d.changes[0].text.includes('200-bar average'));
  assert.deepEqual(activeLessons({ ...DEFAULT_CONFIG, trendFilter: false, ...d.cfgPatch }), ['only buy while price is above the 200-bar average']);
  // a lesson that was unlearned before is not relearned
  assert.equal(decideChanges(r, { ...DEFAULT_CONFIG, trendFilter: false }, [{ lens: 'trend', undo: true }], log).cfgPatch.trendFilter, undefined);
});

test('a filter that made results worse is switched back off', () => {
  const at = 100000;
  const before = Array.from({ length: 12 }, (_, i) => ({ ...trade(i, { trendUp: true, win: i % 2 === 0 }) }));
  const after = Array.from({ length: 22 }, (_, i) => ({ ...trade(0, { trendUp: true, win: i % 7 === 0 }), openedAt: at + i * 1000, exitAt: at + i * 1000 + 500 }));
  const log = [...before, ...after];
  const cfg = { ...DEFAULT_CONFIG, trendFilter: true };
  const d = decideChanges(reviewTrades(log), cfg, [{ at, lens: 'trend', text: 'on' }], log);
  assert.equal(d.cfgPatch.trendFilter, false);
  assert.ok(d.changes.some((c) => c.undo));
});

test('after a reset the trader never trades candles from before it', () => {
  const candles = walk(600);
  const st = newState({ ...DEFAULT_CONFIG }, { liveFrom: candles[candles.length - 1].t + 1 });
  const r = replaySymbol(st, { ...DEFAULT_CONFIG, entryScore: -100 }, 'BTC', candles);
  assert.equal(r.processed, 0);
  assert.equal(st.closed.length + Object.keys(st.open).length, 0);
  logCheck(st, { kind: 'check', coins: 1 });
  assert.equal(st.log.length, 1);
});

test('entries record the market context the review reads', () => {
  const candles = walk(700, 11);
  const st = newState({ ...DEFAULT_CONFIG });
  replaySymbol(st, { ...DEFAULT_CONFIG, entryScore: -100 }, 'ETH', candles);
  const p = st.closed[0] || Object.values(st.open)[0];
  assert.ok(p, 'some trade was opened');
  assert.equal(typeof p.ctx.trendUp, 'boolean');
  assert.ok(p.riskCash > 0);
  assert.equal(p.entryBar, -100);
});
