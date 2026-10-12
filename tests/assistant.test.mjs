// The assistant's answers to questions that are not about a chart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignal } from '../js/lib/signals.js';
import { TESTED_ACCURACY } from '../js/lib/predict.js';
import { ruleBasedAnswer } from '../js/lib/analyst.js';
import { conversationalAnswer, termsIn, GLOSSARY } from '../js/lib/glossary.js';
import { markdown } from '../js/ui.js';
import { demoCandles } from '../js/lib/demo.js';

const signal = generateSignal(demoCandles('bitcoin', '4h', 500));
const ctx = { coin: { name: 'Bitcoin', symbol: 'BTC', price: signal.price, change24h: 1 }, signal, interval: '4h' };
// the header every chart answer starts with
const CHART = /\*\*Bitcoin \(BTC\)\*\* ·/;

test('a greeting gets a greeting, not a chart reading', () => {
  for (const q of ['hello', 'Hi there!', 'hey', 'good morning', 'salam', 'who are you?', 'help']) {
    const a = ruleBasedAnswer(q, ctx);
    assert.doesNotMatch(a, CHART, q);
    assert.match(a, /What is RSI\?/, q);
  }
  // A greeting in front of a real question answers the question.
  assert.match(ruleBasedAnswer('hi, will BTC go up tomorrow?', ctx), CHART);
  assert.match(ruleBasedAnswer('hey, what is MACD?', ctx), /\*\*MACD\*\* — The gap between/);
});

test('"what is X?" explains the term; "what is BTC\'s X?" gives the reading too', () => {
  const rsi = ruleBasedAnswer('what is RSI?', ctx);
  assert.doesNotMatch(rsi, CHART);
  assert.match(rsi, /0–100 scale/);
  assert.match(ruleBasedAnswer('RSI', ctx), /Relative Strength Index/);
  const two = conversationalAnswer('explain stop loss and take profit');
  assert.match(two, /Stop-loss/);
  assert.match(two, /Take-profit/);
  // the reading, followed by what the number means
  const reading = ruleBasedAnswer("what is BTC's RSI?", ctx);
  assert.match(reading, /Indicator readout/);
  assert.match(reading, /RSI\(14\): \d/);
  assert.match(reading, /\*\*RSI \(Relative Strength Index\):\*\* Compares/);
  // asking for the current value is not a definition request
  assert.equal(conversationalAnswer('what is the RSI now'), null);
  assert.equal(conversationalAnswer('what are the support levels?'), null);
  // "long term" is not the trading term "long"
  assert.equal(conversationalAnswer('what is the long term trend'), null);
});

test('every glossary entry is reachable and short enough to read', () => {
  const ids = new Set();
  for (const g of GLOSSARY) {
    assert.ok(!ids.has(g.id), `duplicate ${g.id}`);
    ids.add(g.id);
    assert.ok(g.text.length < 520, `${g.id} is ${g.text.length} characters`);
    assert.ok(termsIn(`what is ${g.title.replace(/\(.*\)/, '')}?`).some((t) => t.id === g.id), `${g.id} is not found by its own title`);
  }
});

test('"how does it work?" explains the method and quotes the measured accuracy', () => {
  for (const q of ['how does the forecast work?', 'how do you predict prices', 'are you ChatGPT?', 'where does the data come from?', 'how is the score calculated?']) {
    const a = ruleBasedAnswer(q, ctx);
    assert.doesNotMatch(a, CHART, q);
    assert.match(a, /seven models/, q);
    assert.ok(a.includes(`${TESTED_ACCURACY.all}%`) && a.includes(`${TESTED_ACCURACY.allBaseline}%`), q);
  }
  // asking how accurate it is still gets the live accuracy answer
  assert.match(ruleBasedAnswer('how accurate are your predictions?', ctx), /Measured forecast accuracy|baseline/);
});

test('scam questions get an honest checklist, about the coin or the site', () => {
  const doge = ruleBasedAnswer('is DOGE a scam?', ctx);
  assert.match(doge, /Charts can't tell you whether DOGE is a scam/);
  assert.doesNotMatch(doge, CHART);
  const site = ruleBasedAnswer('is this site legit?', ctx);
  assert.match(site, /never takes deposits/);
  assert.match(conversationalAnswer('is this coin a scam?', { symbol: 'SOL' }), /whether SOL is a scam/);
  // a chart question that happens to use the word
  assert.equal(conversationalAnswer('is this breakout legit?'), null);
});

test('"should I sell everything?" reviews the portfolio, not the coin in focus', () => {
  const none = ruleBasedAnswer('should I sell everything?', ctx);
  assert.match(none, /haven't added any holdings/);
  const held = ruleBasedAnswer('should I sell everything?', { ...ctx, portfolio: [{ symbol: 'ETH', value: 500, pnlPct: -4 }] });
  assert.match(held, /Portfolio review/);
});

test('markdown links stay inside the app', () => {
  assert.match(markdown('See [Track record](#/track).'), /<a href="#\/track">Track record<\/a>/);
  assert.doesNotMatch(markdown('[click](https://evil.example)'), /<a /);
  assert.doesNotMatch(markdown('[x](javascript:alert(1))'), /<a /);
});

test('the language model gets valid data that keeps the comparison, scan and portfolio', async () => {
  const { fitJson } = await import('../js/ai/engine.js');
  const big = {
    coin: 'Bitcoin (BTC)', signal: { verdict: 'Rising', score: 30 },
    aiForecast: { probUpPct: 52, models: Array.from({ length: 7 }, (_, i) => ({ model: `m${i}`, note: 'x'.repeat(300) })), notes: ['n'.repeat(800)] },
    recentHeadlines: Array.from({ length: 5 }, () => 'h'.repeat(200)), multiYearHistory: 'y'.repeat(2000),
    comparison: [{ sym: 'BTC', verdict: 'WAIT' }, { sym: 'ETH', verdict: 'WAIT' }],
    portfolio: [{ coin: 'ETH', valueUsd: 500 }],
  };
  const s = fitJson(big, 5000);
  assert.ok(s.length <= 5000);
  const o = JSON.parse(s); // the old cut at 5,000 characters left broken JSON
  assert.deepEqual(o.comparison, big.comparison);
  assert.deepEqual(o.portfolio, big.portfolio);
  assert.equal(o.aiForecast.probUpPct, 52, 'the forecast itself stays; only its per-model detail goes');
  assert.equal(o.aiForecast.models, undefined);
  // a whole-market scan too large for the limit is shortened, not cut mid-value
  const scan = { marketByTimeframe: { frames: Array.from({ length: 3 }, (_, f) => ({ interval: `f${f}`, picks: Array.from({ length: 20 }, (_, i) => ({ sym: `C${i}`, plan: 'p'.repeat(60) })) })) } };
  const t = fitJson(scan, 5000);
  assert.ok(t.length <= 5000);
  assert.equal(JSON.parse(t).marketByTimeframe.frames.length, 3);
  // small data passes through unchanged
  assert.equal(fitJson({ a: 1 }), '{"a":1}');
});
