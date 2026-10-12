// The assistant answers questions about the user's AI trader from the account
// itself, with the rules and tested numbers the Trading page shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { traderAnswer, TRADER_Q } from '../js/lib/traderchat.js';
import { newState, DEFAULT_CONFIG, PER_COIN_RULES, CHART_TESTED } from '../js/lib/autotrader.js';

test('questions about the AI trader are recognised; market questions are not', () => {
  for (const q of ['How is my AI trader doing?', 'How does the AI trader work?', 'what rules does the AI use for BTC?', 'Is the trading bot making money?', 'how much profit did the AI make', 'Does the AI have any open positions?', 'show my AI account'])
    assert.ok(TRADER_Q.test(q), q);
  for (const q of ['Will BTC go up?', 'what does the AI think about BTC?', 'what is an AI forecast?', 'Is it legit?', 'When should I take profit on ETH?'])
    assert.ok(!TRADER_Q.test(q), q);
  assert.equal(traderAnswer('Will BTC go up?', {}), null);
});

test('before it has started, it says so and how to start it', () => {
  const a = traderAnswer('How is my AI trader doing?', { saved: { interval: '1h' } });
  assert.match(a.text, /has not started yet/);
  assert.match(a.text, /\[Trading\]\(#\/trader\)/);
  assert.match(a.text, new RegExp(`\\+${CHART_TESTED['1h'].own.ret}% per ${CHART_TESTED['1h'].block}`), 'the chart\'s tested result');
  assert.match(a.text, /Not financial advice/);
});

test('with an account it reports the account, the rules and a named coin', () => {
  const cfg = { ...DEFAULT_CONFIG, interval: '1d' };
  const state = newState(cfg);
  state.balance = 10250.5;
  state.closed = [
    { symbol: 'BTC', pnl: 300, pnlPct: 3, feePaid: 4, exitAt: 2, openedAt: 1 },
    { symbol: 'ETH', pnl: -49.5, pnlPct: -0.5, feePaid: 3, exitAt: 4, openedAt: 3 },
  ];
  state.open = { SOL: { symbol: 'SOL', side: 'long', qty: 2, entry: 150, stop: 140, tp: null, openedAt: Date.UTC(2026, 9, 1) } };
  const fmt = (v) => `$${Number(v).toFixed(2)}`;
  const a = traderAnswer('what rules does the AI use for BTC?', { state, saved: { interval: '1d' }, lessons: [{ at: Date.UTC(2026, 9, 2), lens: 'adx', text: 'Switched ON "skip entries while ADX is under 20".' }], symbol: 'BTC', fmt });
  assert.match(a.text, /on the 1d chart/);
  // the balance is not reduced when a position opens, so at entry prices the account is the balance
  assert.match(a.text, /\$10250\.50 from \$10000\.00 \(\+2\.51%\), counting open positions at the price they were bought at/);
  assert.match(a.text, /2 trades closed: 1 won \(50%\), fees \$7\.00/);
  assert.match(a.text, /SOL bought 2026-10-01 at \$150\.00 \(stop \$140\.00, trailing stop\)/);
  assert.ok(PER_COIN_RULES.rules.BTC);
  assert.match(a.text, /BTC: trades its own rules/);
  assert.match(a.text, /closed 1 BTC trade for \+\$300\.00/);
  assert.match(a.text, /Last change by its self-review \(2026-10-02\)/);
  assert.equal(a.data.aiTrader.closedTrades, 2);
  // switched off in Settings: the coin trades the chart's rules
  const off = traderAnswer('what rules does the AI use for BTC?', { state, saved: { interval: '1d', ownRulesOff: true }, symbol: 'BTC', fmt });
  assert.match(off.text, /BTC: trades the rules above/);
});

test('it says what the settings can be expected to make, from the same test as the Trading page', async () => {
  const { expectedYield } = await import('../js/lib/autotrader.js');
  assert.ok(TRADER_Q.test('what yield will my settings get?') && TRADER_Q.test('expected return of the bot'));
  const a = traderAnswer('What can my AI trader make?', { saved: { interval: '1d', riskPct: 1 } });
  const y = expectedYield({ ...DEFAULT_CONFIG, interval: '1d', riskPct: 1 });
  assert.match(a.text, new RegExp(`at 1% a trade it made \\+${y.ret}% per 18 months on average`));
  assert.equal(a.data.aiTrader.tested.perPeriodPct, y.ret);
  const own = traderAnswer('What can my AI trader make?', { saved: { interval: '1d', strategy: 'custom' } });
  assert.match(own.text, /nothing measured — your own rules have no published test/);
  assert.match(traderAnswer('What can my AI trader make?', { saved: { interval: '30m' } }).text, /the 30m chart has no published test/);
});
