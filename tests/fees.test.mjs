// Run: node --test tests/
// A closed trade's result has to be what it did to the balance: both fees in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, openManual, closeManual, recordRealTrade, stats, DEFAULT_CONFIG } from '../js/lib/autotrader.js';

const cfg = { ...DEFAULT_CONFIG, feePct: 0.1 };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} vs ${b}`);

test('a practice trade closed where it opened loses exactly its two fees', () => {
  const s = newState(cfg);
  const start = s.balance;
  assert.ok(openManual(s, cfg, 'BTC', 50000, { notional: 1000 }).ok);
  const r = closeManual(s, cfg, 'BTC', 50000);
  near(r.trade.pnl, -2, 'the trade shows both 0.1% fees on 1,000');
  near(s.balance - start, r.trade.pnl, 'and the balance moved by exactly that');
});

test('a gain smaller than the fees counts as a loss, not a win', () => {
  const s = newState(cfg);
  openManual(s, cfg, 'ETH', 2000, { notional: 1000 });
  const r = closeManual(s, cfg, 'ETH', 2003);   // +0.15%: more than one 0.1% fee, less than the two paid
  assert.ok(r.trade.pnl < 0, `pnl ${r.trade.pnl}`);
  const st = stats(s);
  assert.equal(st.wins, 0);
  assert.equal(st.losses, 1);
});

test('closing a recorded real trade takes the fee you entered out of the balance', () => {
  const s = newState(cfg);
  const start = s.balance;
  assert.ok(recordRealTrade(s, cfg, { symbol: 'SOL', qty: 10, entry: 100, fee: 5 }).ok);
  const r = closeManual(s, cfg, 'SOL', 110);
  near(r.trade.pnl, 100 - 1.1 - 5, '100 gained, minus the 0.1% exit fee and the 5 you paid to enter');
  near(s.balance - start, r.trade.pnl, 'and the balance moved by exactly that');
});
