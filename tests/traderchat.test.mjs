// The assistant answers questions about the user's AI trader from the account
// itself, with the rules and tested numbers the Trading page shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { traderAnswer, TRADER_Q, isTraderFollowUp } from '../js/lib/traderchat.js';
import { newState, DEFAULT_CONFIG, PER_COIN_RULES, CHART_TESTED } from '../js/lib/autotrader.js';
import { pct } from '../js/format.js';

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
  const t = CHART_TESTED['1h'].adopt ? CHART_TESTED['1h'].own : CHART_TESTED['1h'].standard; // the rules the chart trades
  assert.match(a.text, new RegExp(`${pct(t.ret).replace(/[+.]/g, '\\$&')} per ${CHART_TESTED['1h'].block}`), 'the chart\'s tested result, gain or loss');
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

test('a short follow-up to a question about the AI trader stays on the trader', () => {
  const asked = 'How is my AI trader doing?';
  for (const q of ['why?', 'What should I change?', 'and on 4h?', 'how do I fix it', 'Explain'])
    assert.ok(isTraderFollowUp(q, asked), q);
  assert.ok(!isTraderFollowUp('what is bitcoin?', asked), 'a new question');
  assert.ok(!isTraderFollowUp('why?', 'Will BTC go up?'), 'after a market question');
  assert.ok(!isTraderFollowUp('why?', ''), 'nothing asked before');
  assert.ok(!isTraderFollowUp('why does the market crash every time the dollar index rises sharply?', asked), 'too long to lean on the last question');
});

test('asked why, or down, it says how the trades ended, what the settings risk and what tested best', () => {
  const cfg = { ...DEFAULT_CONFIG, interval: '1h', maxPositions: 10, maxPositionPct: 25 };
  const state = newState(cfg);
  state.balance = 9700;
  state.closed = [
    { symbol: 'BTC', pnl: -200, pnlPct: -2, reason: 'stop', exitAt: 2, openedAt: 1 },
    { symbol: 'ETH', pnl: -150, pnlPct: -1.5, reason: 'stop', exitAt: 4, openedAt: 3 },
    { symbol: 'SOL', pnl: 50, pnlPct: 0.5, reason: 'target', exitAt: 6, openedAt: 5 },
  ];
  const saved = { interval: '1h', maxPositions: 10, maxPositionPct: 25 };
  const a = traderAnswer('How is my AI trader doing? why?', { state, saved, followUp: true, latest: 'why?' });
  assert.match(a.text, /Why it is down/);
  assert.match(a.text, /3 closed trades ended: 2 by stop, 1 by target/);
  assert.match(a.text, /Losing trades averaged −1\.75%, winning ones \+0\.50%/);
  assert.match(a.text, /Up to 10 open trades/, 'the settings warning about open trades the cash cannot fund');
  assert.match(a.text, /3 trades are too few to judge the rules by/);
  assert.doesNotMatch(a.text, /Account:/, 'a follow-up answers the question, not the account again');
  assert.equal(a.data.aiTrader.why.closedTrades, 3);
  assert.equal(traderAnswer('why?', { state }), null, 'a bare "why?" with nothing before it is not about the trader');
});

test('asked what to change, it gives the steps with the numbers behind them, not the diagnosis again', () => {
  const saved = { interval: '1h', riskPct: 5, maxPositions: 10, maxPositionPct: 25 };
  const b = traderAnswer('How is my AI trader doing? what should I change?', { saved, followUp: true, latest: 'what should I change?' });
  assert.match(b.text, /Before you start: what to change/);
  assert.match(b.text, /1\. \*\*Chart:\*\* switch to/);
  assert.match(b.text, /\*\*Risk:\*\* lower it from 5% to 1\.5% a trade/);
  assert.match(b.text, /\*\*Open trades:\*\* set Max open trades to 4/);
  assert.match(b.text, /\*\*Then leave it:\*\*/);
  assert.doesNotMatch(b.text, /has not started yet\*\*/, 'not the status again');
  // settings that match the tests get only the last step
  const ok = traderAnswer('what should I change on my AI trader?', { saved: { interval: '1d', riskPct: 1.5, maxPositions: 5, maxPositionPct: 25 } });
  assert.doesNotMatch(ok.text, /\*\*Risk:\*\*|\*\*Open trades:\*\*/);
});
