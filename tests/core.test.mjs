// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr } from '../js/lib/indicators.js';
import { generateSignal, backtest, labelFor } from '../js/lib/signals.js';
import { forecast, findPatterns } from '../js/lib/predict.js';
import { analyzeHistory } from '../js/lib/history.js';
import { ruleBasedAnswer } from '../js/lib/analyst.js';
import { demoCandles } from '../js/lib/demo.js';

test('SMA and EMA basics', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
  assert.equal(e[4], 4);
});

test('RSI is 100 on a straight rise and ~50 on alternating moves', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const zig = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
  assert.ok(Math.abs(rsi(zig, 14).at(-1) - 50) < 5);
});

test('MACD, Bollinger and ATR shapes', () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = macd(closes);
  assert.equal(m.line.length, 100);
  assert.ok(m.hist.at(-1) !== null);
  const bb = bollinger(closes);
  assert.ok(bb.upper.at(-1) > bb.mid.at(-1) && bb.mid.at(-1) > bb.lower.at(-1));
  const candles = closes.map((c, i) => ({ t: i, o: c, h: c + 1, l: c - 1, c, v: 1 }));
  assert.ok(atr(candles).at(-1) >= 2);
});

test('signal engine returns a coherent trade plan', () => {
  const c = demoCandles('bitcoin', '1h', 500);
  const s = generateSignal(c, { interval: '1h' });
  assert.ok(s.ok);
  assert.ok(s.score >= -100 && s.score <= 100);
  assert.equal(labelFor(60).action, 'STRONG_BUY');
  if (s.plan?.side === 'long') {
    assert.ok(s.plan.stopLoss < s.price);
    assert.ok(s.plan.takeProfits[0] > s.price);
  }
  if (s.plan?.side === 'short') assert.ok(s.plan.stopLoss > s.price);
});

test('backtest produces stats', () => {
  const bt = backtest(demoCandles('ethereum', '4h', 800));
  assert.ok(bt.ok);
  assert.equal(typeof bt.totalReturnPct, 'number');
});

test('pattern search never looks into the future', () => {
  const c = demoCandles('solana', '1h', 900);
  const end = 700;
  const r = findPatterns(c, end, { window: 32, horizon: 12 });
  for (const m of r.matches) assert.ok(m.endIndex + 12 <= end, 'match future must end before the query point');
});

test('forecast returns probabilities, calibrated range and accuracy report', () => {
  const c = demoCandles('bitcoin', '4h', 800);
  const f = forecast(c, { horizon: 6, fast: true });
  assert.ok(f.ok, f.reason);
  assert.ok(f.probUp > 0 && f.probUp < 1);
  assert.ok(f.range.p10 < f.range.p50 && f.range.p50 < f.range.p90);
  assert.equal(f.path.length, 6);
  assert.ok(f.ensemble.samples > 20);
});

test('analyst answers entry, exit, risk and forecast questions', () => {
  const c = demoCandles('bitcoin', '1h', 500);
  const signal = generateSignal(c);
  const ctx = { coin: { name: 'Bitcoin', symbol: 'BTC', price: signal.price, change24h: 1 }, signal };
  for (const q of ['should I buy now?', 'when to sell?', 'I have $1000, how much?', 'will it go up tomorrow?']) {
    const a = ruleBasedAnswer(q, ctx);
    assert.ok(a.length > 80, q);
    assert.match(a, /not financial advice/i);
  }
  assert.match(ruleBasedAnswer('I have $1000, how much?', ctx), /\$1,000/);
});

test('history: analogs, seasonality and year paths on multi-year daily data', () => {
  // 6 years of synthetic daily candles with a cycle, so analogs must exist.
  const daily = demoCandles('bitcoin', '1d', 2200);
  const h = analyzeHistory(daily, { window: 45, horizons: [7, 30, 90], horizon: 30 });
  assert.ok(h.ok, h.reason);
  assert.ok(h.analogs.matches.length >= 1);
  for (const m of h.analogs.matches) {
    assert.ok(m.similarity <= 1.0001 && m.similarity >= -1.0001);
    if (!h.weak) assert.ok(m.similarity >= h.minCorr);
    assert.equal(m.series.length, 45 + 90); // window + max horizon (+1 endpoint - 1 index)
    assert.ok(Math.abs(m.series[44] - 100) < 1e-6, 'match series is rebased to 100 at the match day');
    for (const hz of [7, 30, 90]) assert.ok(Number.isFinite(m.outcomes[hz]));
  }
  assert.ok(Math.abs(h.analogs.current.at(-1) - 100) < 1e-6, 'today is rebased to 100');
  assert.equal(h.analogs.current.length, 45);
  const s = h.analogs.stats[30];
  assert.ok(s.probUp >= 0 && s.probUp <= 1);
  assert.ok(s.worst <= s.median && s.median <= s.best);
  assert.equal(s.total, h.analogs.matches.length);

  // seasonality covers 12 months and win rates are percentages
  assert.equal(h.season.summary.length, 12);
  for (const m of h.season.summary) if (m.count) assert.ok(m.winRate >= 0 && m.winRate <= 100);

  // year paths start at 0% and are ordered newest first
  assert.ok(h.years.length >= 2);
  for (const y of h.years) assert.ok(Math.abs(y.points[0].y) < 1e-9);
  assert.ok(h.years[0].year > h.years[1].year);

  // the honesty check must be a real out-of-sample number, not a fabricated one
  assert.ok(h.validation.tests > 0);
  assert.ok(h.validation.accuracy === null || (h.validation.accuracy >= 0 && h.validation.accuracy <= 1));
  assert.ok(['UP', 'DOWN', 'MIXED'].includes(h.verdict.direction));
  assert.ok(h.verdict.text.length > 40);
  assert.equal(h.summary.wentUpAfter, `${s.upCount}/${s.total}`);
  // a weak match set must say so rather than being presented as a finding
  if (h.weak) assert.match(h.verdict.text, /weak evidence/);
});

test('history: refuses to guess when there is not enough data', () => {
  const short = demoCandles('bitcoin', '1d', 120);
  const h = analyzeHistory(short, { horizon: 30 });
  assert.equal(h.ok, false);
  assert.match(h.reason, /history/i);
});

test('analyst quotes the multi-year history when it is supplied', () => {
  const candles = demoCandles('ethereum', '4h', 700);
  const sig = generateSignal(candles, { interval: '4h' });
  const answer = ruleBasedAnswer('will eth go up next week?', {
    coin: { name: 'Ethereum', symbol: 'ETH', price: sig.price, change24h: 1.2 },
    interval: '4h', signal: sig, horizonText: '2 days',
    forecast: { probUpPct: 56, direction: 'UP', confidence: 'Moderate', expectedMovePct: 1.8, targetPrice: sig.price * 1.018, likelyRange: [1, 2], wideRange: [1, 3], horizonBars: 12, validatedAccuracyPct: 55, baselineAccuracyPct: 51, accuracyWhenConfidentPct: 58 },
    history: { similarPastCases: 6, windowDays: 45, horizonDays: 30, wentUpAfter: '4/6', medianMovePct: 7.4, bestCasePct: 22, worstCasePct: -9, methodAccuracyPct: 52, thisMonthHistoricalAvgPct: 3.1, examples: [{ date: '2021-07-20', similarityPct: 91, thenMovedPct: 12.3 }], verdict: 'UP' },
  });
  assert.match(answer, /4\/6/);
  assert.match(answer, /2021-07-20/);
  assert.match(answer, /52%/);
  assert.match(answer, /coin flip/i); // 52% must be flagged as weak, not sold as an edge
});
