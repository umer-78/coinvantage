// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr } from '../js/lib/indicators.js';
import { generateSignal, backtest, labelFor } from '../js/lib/signals.js';
import { forecast, findPatterns } from '../js/lib/predict.js';
import { analyzeHistory } from '../js/lib/history.js';
import { timingOutlook, summarizeTiming } from '../js/lib/timing.js';
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


test('timing: shaped path ends where the ensemble says, and never peaks on the last bar', () => {
  for (const [id, iv, H, ms] of [['bitcoin', '1h', 12, 3600e3], ['ethereum', '4h', 6, 4 * 3600e3], ['solana', '15m', 8, 900e3]]) {
    const c = demoCandles(id, iv, 900);
    const f = forecast(c, { horizon: H });
    assert.ok(f.ok, f.reason);
    const t = timingOutlook(f, { intervalMs: ms });
    assert.ok(t.ok, t.reason);
    assert.equal(t.path.length, H + 1);
    assert.equal(t.path[0].pct, 0, 'the path starts at now = 0%');
    // the shape is tilted to land exactly on the ensemble's expected move
    assert.ok(Math.abs(t.endPct - f.expectedReturnPct) < 1e-6, `${id} endpoint must match the forecast`);
    // bands bracket the line
    for (const p of t.path) assert.ok(p.lo <= p.hi);
    // timestamps march forward from the last candle
    assert.equal(t.path[1].t - t.path[0].t, ms);
    if (t.shaped) {
      const turn = t.rising ? t.peak.bar : t.trough.bar;
      assert.ok(turn > 0 && turn < H, 'a turning point on the final bar is just the endpoint restated');
      assert.ok(!(t.rising && t.falling), 'it cannot both rise and fall');
      const s = summarizeTiming(t);
      assert.ok(s && ['rise then fade', 'fall then bounce'].includes(s.direction));
    }
  }
});

test('timing: refuses to guess when there are too few matching charts', () => {
  const fake = { ok: true, horizon: 6, lastPrice: 100, lastTime: 0, expectedReturnPct: 1, path: [], patterns: { matches: [{ similarity: 0.9, futureReturns: [0.01] }] } };
  const t = timingOutlook(fake, { intervalMs: 3600e3 });
  assert.equal(t.ok, false);
  assert.match(t.reason, /not enough/i);
  assert.equal(summarizeTiming(t), null);
});

test('timing: a flat drift reports no turning point rather than inventing one', () => {
  // every match rises steadily to the same endpoint -> no peak before the end
  const matches = Array.from({ length: 8 }, (_, k) => ({
    similarity: 0.9 - k * 0.01,
    futureReturns: [0.002, 0.004, 0.006, 0.008, 0.010, 0.012],
  }));
  const fake = { ok: true, horizon: 6, lastPrice: 100, lastTime: 0, expectedReturnPct: 1.2, path: [], patterns: { matches } };
  const t = timingOutlook(fake, { intervalMs: 3600e3 });
  assert.equal(t.ok, true);
  assert.equal(t.shaped, false, 'a straight climb has no turning point to call');
  assert.equal(summarizeTiming(t), null);
});

test('trade links point at the right pair and never at a stablecoin market', async () => {
  const { venuesFor, tradable } = await import('../js/lib/trade.js');
  assert.equal(tradable('USDT'), false);
  assert.deepEqual(venuesFor('USDC'), []);
  const v = venuesFor('btc');
  assert.ok(v.length >= 5);
  for (const x of v) {
    assert.match(x.href, /^https:\/\//);
    assert.ok(/BTC|btc/.test(x.href), `${x.name} link must contain the symbol`);
    assert.ok(!/ref=|referral|invite/i.test(x.href), 'no referral codes');
  }
});

test('analyst answers whole-market questions with ranked picks, not one coin', async () => {
  const { isMarketWide } = await import('../js/lib/analyst.js');
  for (const q of ['which coin should i buy?', 'what should i buy today', 'best crypto to buy now', 'any good buys?', 'top picks']) {
    assert.ok(isMarketWide(q), q);
  }
  for (const q of ['should i buy btc now?', 'will eth go up?', 'where is my stop on sol']) {
    assert.ok(!isMarketWide(q), `"${q}" names a coin — must stay a single-coin question`);
  }

  const market = {
    interval: '4h', horizonText: '1 day', scanned: 25, waitingCount: 18,
    buys: [{ coin: 'SOL', name: 'Solana', verdict: 'BUY', conviction: 62, price: 145.2, buyBetween: [143, 145.2], stopLoss: 138.4, sellTargets: [155, 162, 170], riskPct: 4.7, holdForBars: 3, expectedPeakPrice: 158.1, turnsDownAfterBars: 5, topReason: 'Chart signal: Buy (+31/100).' }],
    avoid: [{ coin: 'DOGE', name: 'Dogecoin', verdict: 'AVOID', conviction: 44, topReason: 'Chart signal: Sell (−28/100).' }],
  };
  const a = ruleBasedAnswer('which coin should i buy right now?', { market, portfolio: [] });
  assert.match(a, /Market scan/);
  assert.match(a, /SOL/);
  assert.match(a, /Solana/);
  assert.match(a, /stop-loss/i);
  assert.match(a, /Sell targets/);
  assert.match(a, /DOGE/);
  assert.match(a, /not financial advice/i);

  // with nothing to buy it must say so rather than inventing a pick
  const empty = ruleBasedAnswer('what should i buy?', { market: { ...market, buys: [], avoid: [] }, portfolio: [] });
  assert.match(empty, /Nothing currently clears the bar/i);
});
