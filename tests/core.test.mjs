// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr } from '../js/lib/indicators.js';
import { generateSignal, backtest, labelFor } from '../js/lib/signals.js';
import { forecast, findPatterns } from '../js/lib/predict.js';
import { analyzeHistory } from '../js/lib/history.js';
import { timingOutlook, summarizeTiming } from '../js/lib/timing.js';
import { ruleBasedAnswer, isMarketWide } from '../js/lib/analyst.js';
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

test('no trade plan when the move is smaller than the fees', () => {
  // A near-flat series: any "setup" here has targets a rounding error away.
  // A steady, unmistakably bullish drift — but the whole move is 0.04%, which
  // is what a 5-second chart on a quiet market actually looks like.
  const flat = Array.from({ length: 400 }, (_, i) => {
    const c = 100 + i * 0.0001;
    return { t: i * 5000, o: c, h: c + 0.0002, l: c - 0.0002, c, v: 10 + (i % 5) };
  });
  const s = generateSignal(flat, { interval: '5s' });
  assert.ok(s.ok);
  assert.ok(s.score > 0, 'the indicators do read this as bullish');
  assert.equal(s.plan, null, 'a sub-fee move must not produce a trade plan');
  assert.ok(s.waitFor.some((w) => /too little|fees|spread/i.test(w)), 'and it must say why');

  // a normal chart still gets a plan when the signal is strong enough
  const real = demoCandles('bitcoin', '4h', 600);
  const rs = generateSignal(real, { interval: '4h' });
  if (rs.plan) {
    const move = Math.abs(rs.plan.takeProfits[0] - rs.price) / rs.price;
    assert.ok(move >= 0.003, 'a real plan clears the cost floor');
  }
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

test('junk listings are kept out of the coin list', async () => {
  const { markets } = await import('../js/api/market.js');
  const rows = await markets().catch(() => null);
  if (!rows || !rows.length) return; // offline — nothing to assert against
  for (const r of rows) {
    assert.ok(!/^[A-Z]{1,3}\d{4,}$/.test(r.symbol), `product-code listing leaked in: ${r.symbol}`);
    assert.ok(r.price !== null && r.price !== undefined, `${r.symbol} has no price`);
  }
});

test('CSV export escapes properly and the report keeps its caveats', async () => {
  const { toCsv, tradesCsv, reportHtml } = await import('../js/lib/export.js');

  // the classic CSV break: commas and quotes inside a field
  assert.equal(toCsv([{ a: 'he said "hi"', b: 'x,y' }]), 'a,b\n"he said ""hi""","x,y"');
  assert.equal(toCsv([{ a: 'line\nbreak' }]), 'a\n"line\nbreak"');
  assert.equal(toCsv([{ a: null, b: undefined }]), 'a,b\n,');
  assert.equal(toCsv([]), '');

  const trades = [{ symbol: 'BTC', side: 'long', openedAt: 1700000000000, exitAt: 1700086400000, qty: 0.5, entry: 40000, exit: 50000, feePaid: 4, pnl: 4996, pnlPct: 25, reason: 'target' }];
  const csv = tradesCsv(trades);
  assert.match(csv.split('\n')[0], /^Coin,Side,Opened,Closed/);
  assert.match(csv, /BTC,long,2023-11-14/);

  // a small sample must be labelled as one — a win rate off 3 trades means nothing
  const small = reportHtml({ title: 'T', accountName: 'A', stats: { startingBalance: 1000, equity: 1200, returnPct: 20, trades: 3, winRate: 100, wins: 3, losses: 0, profitFactor: 9, maxDrawdownPct: 1, feesPaid: 2 }, closed: trades });
  assert.match(small, /Small sample/i);
  assert.match(small, /3 closed trade/);
  // and every report carries the not-advice line
  assert.match(small, /not financial advice/i);
  assert.match(small, /never places trades/i);

  const big = reportHtml({ title: 'T', accountName: 'A', stats: { startingBalance: 1000, equity: 1200, returnPct: 20, trades: 120, winRate: 55, wins: 66, losses: 54, profitFactor: 1.3, maxDrawdownPct: 9, feesPaid: 40 }, closed: [] });
  assert.ok(!/Small sample/i.test(big), 'a real sample is not labelled small');
});

test('coin comparison ranks fairly and refuses to invent a winner', async () => {
  const { detectCompare, ruleBasedAnswer } = await import('../js/lib/analyst.js');

  assert.deepEqual(detectCompare('compare BTC and ETH'), ['BTC', 'ETH']);
  assert.deepEqual(detectCompare('BTC vs SOL'), ['BTC', 'SOL']);
  assert.equal(detectCompare('should i buy btc'), null, 'one coin is not a comparison');
  assert.equal(detectCompare('what should i buy'), null);

  const row = (coin, conviction, extra = {}) => ({
    coin, name: coin, verdict: conviction >= 25 ? 'BUY' : 'WAIT', conviction,
    signalText: 'Buy', score: 30, probUpPct: 58, accuracyPct: 57, change24h: 1.2,
    buyBetween: [100, 101], stopLoss: 97, sellTargets: [106, 110], topReason: 'Trend is up', ...extra,
  });

  // a clear winner is named
  const clear = ruleBasedAnswer('compare BTC and ETH', { compare: [row('BTC', 72), row('ETH', 40)], compareInterval: '4h' });
  assert.match(clear, /BTC is the stronger/);
  assert.match(clear, /ETH/, 'the loser still appears in the table');

  // a near-tie is called a tie rather than ranked on noise
  const tie = ruleBasedAnswer('compare BTC and ETH', { compare: [row('BTC', 52), row('ETH', 48)], compareInterval: '4h' });
  assert.match(tie, /Too close to call/i);

  // nothing worth buying is said outright
  const none = ruleBasedAnswer('compare BTC and ETH', { compare: [row('BTC', 12), row('ETH', 8)], compareInterval: '4h' });
  assert.match(none, /None of them is a buy/i);

  // a forecast with no measured edge is flagged, not quietly used
  const weak = ruleBasedAnswer('compare BTC and ETH', {
    compare: [row('BTC', 70, { accuracyPct: 48 }), row('ETH', 40)], compareInterval: '4h',
  });
  assert.match(weak, /no measured edge on BTC/);
});

test('Binance trade-history import: parsing and FIFO matching', async () => {
  const { parseTradeCsv, matchFills, splitPair, parseAmount, splitCsvLine } = await import('../js/lib/importer.js');

  // the amount column carries the asset glued to the number
  assert.deepEqual(parseAmount('0.01234BTC'), { value: 0.01234, asset: 'BTC' });
  assert.deepEqual(parseAmount('1,234.5 USDT'), { value: 1234.5, asset: 'USDT' });
  assert.equal(parseAmount('').value, null);
  // quoted fields with commas must not split the row
  assert.deepEqual(splitCsvLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  // pairs split on the quote asset, longest first
  assert.deepEqual(splitPair('BTCUSDT'), { base: 'BTC', quote: 'USDT' });
  assert.deepEqual(splitPair('ETH/BTC'), { base: 'ETH', quote: 'BTC' });
  assert.deepEqual(splitPair('SOLFDUSD'), { base: 'SOL', quote: 'FDUSD' });

  const csv = [
    'Date(UTC),Pair,Side,Price,Executed,Amount,Fee',
    '2026-01-10 09:00:00,BTCUSDT,BUY,40000,0.5BTC,20000USDT,2USDT',
    '2026-01-11 09:00:00,BTCUSDT,BUY,42000,0.5BTC,21000USDT,2USDT',
    '2026-01-20 09:00:00,BTCUSDT,SELL,50000,0.5BTC,25000USDT,2USDT',
    '2026-02-01 09:00:00,ETHUSDT,BUY,2000,2ETH,4000USDT,1USDT',
    'garbage row',
  ].join('\n');

  const { fills, errors, skipped } = parseTradeCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(fills.length, 4);
  assert.equal(skipped, 1, 'the unusable row is skipped, not guessed at');
  assert.equal(fills[0].symbol, 'BTC');
  assert.equal(fills[0].side, 'buy');
  assert.equal(fills[0].qty, 0.5);

  const { closed, open } = matchFills(fills);
  // FIFO: the sell matches the FIRST buy at 40,000, not the cheaper average
  assert.equal(closed.length, 1);
  assert.equal(closed[0].entry, 40000, 'oldest lot is consumed first');
  assert.equal(closed[0].exit, 50000);
  assert.equal(closed[0].qty, 0.5);
  assert.ok(Math.abs(closed[0].pnlPct - 25) < 1e-9);
  assert.ok(closed[0].pnl < 5000, 'fees come out of the profit');
  assert.ok(closed[0].pnl > 4990);

  // what is left is still open: the second BTC lot and the whole ETH lot
  assert.equal(open.length, 2);
  assert.ok(open.find((o) => o.symbol === 'BTC' && o.entry === 42000));
  assert.ok(open.find((o) => o.symbol === 'ETH' && o.qty === 2));

  // a partial sell splits a lot rather than dropping it
  const partial = matchFills([
    { symbol: 'SOL', side: 'buy', price: 100, qty: 10, fee: 0, at: 1 },
    { symbol: 'SOL', side: 'sell', price: 120, qty: 4, fee: 0, at: 2 },
  ]);
  assert.equal(partial.closed[0].qty, 4);
  assert.equal(partial.open[0].qty, 6);

  // a file that is not a trade export says so instead of importing nonsense
  const bad = parseTradeCsv('hello,world\n1,2');
  assert.equal(bad.fills.length, 0);
  assert.match(bad.errors[0], /trade history/i);
});

test('the real account records trades without ever placing one', async () => {
  const { newState, recordRealTrade, DEFAULT_CONFIG, REAL_NOTICE } = await import('../js/lib/autotrader.js');
  const cfg = { ...DEFAULT_CONFIG };
  const st = newState(cfg);
  const start = st.balance;

  // a closed long, fees taken off
  const win = recordRealTrade(st, cfg, { symbol: 'ETH', qty: 1, entry: 2000, exit: 2200, fee: 4 });
  assert.ok(win.ok);
  assert.equal(win.trade.pnl, 196, '200 gross minus the 4 fee');
  assert.equal(win.trade.pnlPct, 10);
  assert.equal(win.trade.real, true);
  assert.equal(win.trade.reason, 'recorded by you');
  assert.equal(st.balance, start + 196);

  // a short makes money when price falls
  const short = recordRealTrade(st, cfg, { symbol: 'SOL', side: 'short', qty: 10, entry: 100, exit: 90, fee: 1 });
  assert.equal(short.trade.pnl, 99);
  assert.ok(short.trade.pnlPct > 0, 'a short that fell is a win, not a loss');

  // an open trade, and no duplicate on the same coin
  assert.ok(recordRealTrade(st, cfg, { symbol: 'BTC', qty: 0.01, entry: 60000 }).ok);
  assert.equal(recordRealTrade(st, cfg, { symbol: 'BTC', qty: 0.01, entry: 61000 }).ok, false);

  // bad input is refused rather than stored as nonsense
  assert.equal(recordRealTrade(st, cfg, { symbol: 'BTC', qty: 0, entry: 1 }).ok, false);
  assert.equal(recordRealTrade(st, cfg, { symbol: 'XYZ', qty: 1, entry: 0 }).ok, false);
  assert.equal(recordRealTrade(st, cfg, { symbol: '', qty: 1, entry: 1 }).ok, false);

  // the wording must keep saying the app does not trade
  assert.match(REAL_NOTICE, /never places an order/i);
});

test('demo trades run on simulated money and book a real result', async () => {
  const { newState, openManual, closeManual, DEFAULT_CONFIG, equity } = await import('../js/lib/autotrader.js');
  const cfg = { ...DEFAULT_CONFIG };
  const state = newState(cfg);
  const start = state.balance;

  const bad = openManual(state, cfg, 'BTC', 60000, { notional: 0 });
  assert.equal(bad.ok, false, 'a zero-size trade is refused');
  assert.equal(state.balance, start, 'a refused trade changes nothing');

  const r = openManual(state, cfg, 'BTC', 60000, { notional: 1000, stopPrice: 57000 });
  assert.ok(r.ok);
  assert.equal(r.position.manual, true);
  assert.equal(r.position.stop, 57000);
  assert.ok(r.position.qty > 0);
  assert.ok(state.balance < start, 'the fee comes out of the balance');

  assert.equal(openManual(state, cfg, 'BTC', 60000, { notional: 500 }).ok, false, 'no second position on the same coin');

  // marked to market while open
  assert.ok(equity(state, { BTC: 66000 }) > equity(state, { BTC: 60000 }));

  const sold = closeManual(state, cfg, 'BTC', 66000);
  assert.ok(sold.ok);
  assert.equal(sold.trade.reason, 'closed by you');
  assert.ok(sold.trade.pnl > 0, 'a 10% rise on a long is a profit');
  assert.ok(Math.abs(sold.trade.pnlPct - 10) < 0.001);
  assert.equal(Object.keys(state.open).length, 0);
  assert.ok(state.balance > start, 'the profit lands in the balance');

  assert.equal(closeManual(state, cfg, 'BTC', 66000).ok, false, 'nothing left to close');
});

test('prices are shown at full precision, never silently rounded', async () => {
  const { money, price } = await import('../js/format.js');
  // A four-figure price used to be rounded to whole dollars, which made the
  // header disagree with the candle it was drawn from.
  assert.equal(money(77182.43), '$77,182.43');
  assert.equal(money(77182.43, { dp: 2 }), '$77,182.43');
  assert.equal(money(0.00000123, { dp: 8 }), '$0.00000123');
  assert.equal(money(101.7, { dp: 2 }), '$101.70');
  // and the raw formatter keeps small coins readable without dropping digits
  assert.ok(price(0.0000012345).startsWith('0.0000012'));
  assert.equal(price(2525.5), '2,525.50');
});

test('VWAP resets each day and Ichimoku projects its cloud forward', async () => {
  const { vwap, ichimoku } = await import('../js/lib/indicators.js');
  // two UTC days, second day priced far above the first
  const day = 864e5;
  const candles = [];
  for (let i = 0; i < 24; i++) candles.push({ t: i * 36e5, o: 100, h: 100, l: 100, c: 100, v: 10 });
  for (let i = 0; i < 24; i++) candles.push({ t: day + i * 36e5, o: 200, h: 200, l: 200, c: 200, v: 10 });
  const v = vwap(candles);
  assert.equal(v[23], 100, 'day one averages its own prices');
  assert.equal(v[24], 200, 'day two starts fresh rather than dragging day one along');
  assert.equal(v[47], 200);

  const ich = ichimoku(candles);
  assert.equal(ich.senkouA.length, candles.length + 26, 'the cloud is plotted 26 bars ahead');
  assert.equal(ich.tenkan[0], null, 'no value before there is enough history');
  assert.ok(ich.kijun.at(-1) !== null);
  assert.equal(ich.chikou[0], candles[26].c, 'the lagging line is shifted back');
});

test('a model with nothing to say abstains instead of voting zero', async () => {
  const { forecast } = await import('../js/lib/predict.js');
  const { pooledProb, POOLED } = await import('../js/lib/pooled.js');

  // The pooled model returns null for a timeframe it was never trained on.
  // If that null leaked into the blend as 0 it would read as "100% down".
  assert.equal(pooledProb('nonsense-interval', new Array(22).fill(0)), null);
  assert.equal(pooledProb('1h', null), null);
  // wrong-length feature rows must also abstain rather than silently misalign
  if (POOLED['1h']) assert.equal(pooledProb('1h', [1, 2, 3]), null);

  const c = demoCandles('bitcoin', '1h', 700);
  const f = forecast(c, { horizon: 12, fast: true });
  assert.ok(f.ok);
  assert.ok(f.probUp > 0.02 && f.probUp < 0.98, `an abstaining model must not drag the blend to an extreme (got ${f.probUp})`);
  for (const m of f.models) {
    assert.ok(m.probUp === null || (m.probUp >= 0 && m.probUp <= 1), `${m.key} produced ${m.probUp}`);
    assert.ok(m.accuracy === null || (m.accuracy >= 0 && m.accuracy <= 1));
  }
});

test('drawing-tool geometry', async () => {
  const { distToSegment, fibPrices, trendYAt, FIB_LEVELS } = await import('../js/lib/geometry.js');

  // hit-testing a trend line
  assert.equal(distToSegment(5, 0, 0, 0, 10, 0), 0, 'a point on the segment');
  assert.equal(distToSegment(5, 3, 0, 0, 10, 0), 3, 'straight above it');
  // past the end it measures to the endpoint, not to the infinite line —
  // otherwise erasing would delete a line the reader tapped nowhere near
  assert.equal(distToSegment(20, 0, 0, 0, 10, 0), 10);
  assert.equal(distToSegment(0, 0, 5, 5, 5, 5), Math.hypot(5, 5), 'a zero-length segment is just a point');

  // Fibonacci levels read the same whichever way the reader drags
  const up = fibPrices(100, 200);
  const down = fibPrices(200, 100);
  assert.deepEqual(up.map((f) => f.price), down.map((f) => f.price), 'direction must not change the levels');
  assert.equal(up[0].price, 100);
  assert.equal(up.at(-1).price, 200);
  const half = up.find((f) => f.ratio === 0.5);
  assert.equal(half.price, 150);
  const golden = up.find((f) => f.ratio === 0.618);
  assert.ok(Math.abs(golden.price - 161.8) < 1e-9);
  assert.equal(FIB_LEVELS.length, 7);

  // a trend line keeps projecting past its second point
  assert.equal(trendYAt(20, 0, 0, 10, 10), 20, 'extends beyond the anchors');
  assert.equal(trendYAt(5, 0, 0, 10, 10), 5);
  assert.equal(trendYAt(5, 3, 0, 3, 9), null, 'a vertical line has no single value');
});

test('second-by-second candles bucket correctly', async () => {
  const { bucketCandles, INTERVAL_MS, isSecondInterval, MAX_BARS } = await import('../js/api/market.js');
  assert.equal(INTERVAL_MS['1s'], 1000);
  assert.equal(INTERVAL_MS['5s'], 5000);
  assert.equal(INTERVAL_MS['10s'], 10000);
  assert.ok(isSecondInterval('5s') && !isSecondInterval('1m'));
  assert.ok(MAX_BARS['1s'] > 0);

  // ten 1-second candles, aligned to a 5-second boundary
  const base = 1700000000000;
  const rows = Array.from({ length: 10 }, (_, i) => ({ t: base + i * 1000, o: 100 + i, h: 110 + i, l: 90 + i, c: 100 + i, v: 2 }));
  const five = bucketCandles(rows, 5, 1000);
  assert.equal(five.length, 2);
  assert.equal(five[0].t, base);
  assert.equal(five[0].o, rows[0].o, 'bucket opens at the first candle');
  assert.equal(five[0].c, rows[4].c, 'bucket closes at the last candle in it');
  assert.equal(five[0].h, Math.max(...rows.slice(0, 5).map((r) => r.h)));
  assert.equal(five[0].l, Math.min(...rows.slice(0, 5).map((r) => r.l)));
  assert.equal(five[0].v, 10, 'volume adds up');
  assert.equal(five[1].t, base + 5000);

  const ten = bucketCandles(rows, 10, 1000);
  assert.equal(ten.length, 1);
  assert.equal(ten[0].v, 20);

  // buckets stay aligned even when the first candle lands mid-bucket
  const offset = bucketCandles(rows.slice(2), 5, 1000);
  assert.equal(offset[0].t, base, 'a partial bucket still starts on the boundary');
});

test('the score is only called evidence inside the band where it was measured', async () => {
  const { SIGNAL_EDGE, edgeBand } = await import('../js/lib/signals.js');
  const { tradeSummary } = await import('../js/lib/summary.js');

  // only bands that cleared n>=300 and lift>=1.10 are published
  for (const [iv, b] of Object.entries(SIGNAL_EDGE)) {
    assert.ok(b.samples >= 300, `${iv} band published on too few samples`);
    assert.ok(b.lift >= 1.10, `${iv} band published without a real lift`);
    assert.ok(b.hitRate > b.baseRate, `${iv} band must beat its own base rate`);
  }
  // 15m scored 60.6% in its top bucket but on 99 samples — deliberately excluded
  assert.equal(SIGNAL_EDGE['15m'], undefined, '15m has no band large enough to trust');
  assert.equal(SIGNAL_EDGE['1d'], undefined, '1d lift was under 1.10');

  assert.equal(edgeBand('1h', 50).inside, true);
  assert.equal(edgeBand('1h', 70).inside, false, 'above the band is outside it — higher is not better');
  assert.equal(edgeBand('1h', 20).inside, false);
  assert.equal(edgeBand('1d', 50).band, null);

  const mk = (score, interval) => tradeSummary({
    signal: { ok: true, score, coinSymbol: 'BTC',
      plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: 0.055, geometryTested: true },
      waitFor: [] },
    forecast: { probUpPct: 60, validatedAccuracyPct: 58 }, interval, fmt: String,
  });

  // inside the band: stated as measured evidence, with the numbers behind it
  const inBand = mk(50, '1h');
  const tested = inBand.steps.find((x) => x.label === 'Tested zone');
  assert.ok(tested, 'a score inside the measured band should say so');
  assert.match(tested.text, /35\.4%/);
  assert.match(tested.text, /486 tested entries/);

  // outside it: the reader is told the number is description, not evidence
  const outBand = mk(75, '1h');
  assert.ok(!outBand.steps.some((x) => x.label === 'Tested zone'));
  assert.ok(outBand.caveats.some((c) => /higher score does not reliably mean a better trade/i.test(c)));

  // a timeframe with no measured band makes no claim either way
  const noBand = mk(50, '1d');
  assert.ok(!noBand.steps.some((x) => x.label === 'Tested zone'));
  assert.ok(!noBand.caveats.some((c) => /measured edge \(/.test(c)));
});

test('trade levels come from measurement, and losing geometry is admitted', async () => {
  const { TRADE_GEOMETRY, geometryFor, generateSignal } = await import('../js/lib/signals.js');
  const { tradeSummary } = await import('../js/lib/summary.js');

  // every shipped timeframe must carry a measured expectancy, not a guess
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const g = geometryFor(iv);
    assert.equal(g.tested, true, `${iv} geometry must be measured`);
    assert.equal(typeof g.ev, 'number');
    assert.ok(g.stopAtr > 0 && g.rr > 0);
  }
  // an unmeasured timeframe falls back and says so
  assert.equal(geometryFor('1w').tested, false);

  // the plan carries the expectancy through to the UI
  const c = demoCandles('bitcoin', '1h', 600);
  const sig = generateSignal(c, { interval: '1h' });
  if (sig.plan) {
    assert.equal(sig.plan.expectancyR, TRADE_GEOMETRY['1h'].ev);
    assert.equal(sig.plan.rewardRisk, TRADE_GEOMETRY['1h'].rr);
  }

  // a negative-expectancy timeframe must not be presented as a clean buy
  const losing = tradeSummary({
    signal: { ok: true, score: 40, coinSymbol: 'BTC',
      plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: -0.047, geometryTested: true },
      waitFor: [] },
    forecast: { probUpPct: 60, validatedAccuracyPct: 58 }, interval: '4h', fmt: String,
  });
  assert.match(losing.verdict, /WEAK EDGE/, 'a losing setup cannot be labelled a plain BUY');
  assert.ok(losing.caveats.some((x) => /negative|slightly negative/i.test(x)), 'and the reader is told why');

  // a positive one gets the "does this pay?" line with the real number
  const paying = tradeSummary({
    signal: { ok: true, score: 40, coinSymbol: 'BTC',
      plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: 0.055, geometryTested: true },
      waitFor: [] },
    forecast: { probUpPct: 60, validatedAccuracyPct: 58 }, interval: '1h', fmt: String,
  });
  const pay = paying.steps.find((x) => x.label === 'Does this pay?');
  assert.ok(pay, 'a positive-expectancy setup should say so');
  assert.match(pay.text, /\+0\.055R/);
});

test('the trade summary answers what, when, when to sell and where you are wrong', async () => {
  const { tradeSummary, summaryMarkdown } = await import('../js/lib/summary.js');
  const fmt = (v) => `$${Number(v).toFixed(0)}`;

  const signal = {
    ok: true, score: 31, coinSymbol: 'BTC', text: 'Buy',
    plan: { side: 'long', entryZone: [76946, 77248], stopLoss: 76343, takeProfits: [78605, 79509, 79652], riskPct: 1.17 },
    waitFor: [],
  };
  const s = tradeSummary({
    signal, forecast: { probUpPct: 63, validatedAccuracyPct: 58 },
    timing: { rising: true, bars: 6, targetPrice: 79000, turnBars: 8 },
    interval: '4h', horizonText: '1 day', fmt,
  });

  assert.equal(s.verdict, 'BUY');
  const labels = s.steps.map((x) => x.label);
  for (const need of ['What to buy', 'When to buy', 'When to sell', 'Where you are wrong', 'How much', 'How long']) {
    assert.ok(labels.includes(need), `the summary must answer "${need}" — got ${labels.join(', ')}`);
  }
  const sell = s.steps.find((x) => x.label === 'When to sell').text;
  assert.match(sell, /\$78605/, 'the first target has to be in the words, not just a table');
  const wrong = s.steps.find((x) => x.label === 'Where you are wrong').text;
  assert.match(wrong, /\$76343/);
  assert.match(wrong, /1\.17%/);
  assert.ok(s.caveats.some((c) => /stop-loss/i.test(c)));

  // a conflict downgrades the verdict and the confidence rather than selling it
  const clash = tradeSummary({
    signal, forecast: { probUpPct: 41, validatedAccuracyPct: 58 },
    interval: '4h', horizonText: '1 day', fmt,
  });
  assert.equal(clash.verdict, 'NO CLEAR EDGE');
  assert.equal(clash.confidence, 'low');
  assert.ok(!clash.steps.some((x) => x.label === 'When to buy'), 'no entry plan is offered when the readings disagree');

  // no plan at all → it says what to wait for instead of inventing a trade
  const idle = tradeSummary({
    signal: { ok: true, score: 4, coinSymbol: 'BTC', plan: null, waitFor: ['Close above 79,000 on rising volume'] },
    interval: '4h', fmt,
  });
  assert.equal(idle.verdict, 'WAIT');
  assert.match(idle.steps.find((x) => x.label === 'What to wait for').text, /79,000/);

  // and it renders to markdown for the assistant and exports
  assert.match(summaryMarkdown(s), /\*\*When to sell:\*\*/);
});

test('a buy signal that contradicts the forecast is flagged, not sold confidently', async () => {
  const { conflictCheck } = await import('../js/lib/analyst.js');

  const sig = { ok: true, score: 31, plan: { side: 'long' } };
  // the exact case seen live: chart says Buy, model says 41.9% up
  const clash = conflictCheck(sig, { probUpPct: 41.9, validatedAccuracyPct: 56 });
  assert.ok(clash, 'a long signal against a 41.9% up forecast is a conflict');
  assert.equal(clash.side, 'long');
  assert.equal(clash.forecastSide, 'short');
  assert.equal(clash.forecastIsWeak, false);

  // agreement is not a conflict
  assert.equal(conflictCheck(sig, { probUpPct: 62, validatedAccuracyPct: 56 }), null);
  // and neither is noise around the middle
  assert.equal(conflictCheck(sig, { probUpPct: 49, validatedAccuracyPct: 56 }), null);
  assert.equal(conflictCheck(sig, { probUpPct: 52, validatedAccuracyPct: 56 }), null);
  // a forecast with no measured accuracy still counts, but is marked weak
  const weak = conflictCheck(sig, { probUpPct: 40, validatedAccuracyPct: null });
  assert.equal(weak.forecastIsWeak, true);

  // the warning has to reach the answer the reader sees
  const answer = ruleBasedAnswer('should i buy?', {
    coin: { name: 'Bitcoin', symbol: 'BTC', price: 77248, change24h: -0.11 },
    interval: '4h',
    signal: { ...sig, text: 'Buy', tone: 'up', price: 77248,
      reasons: { bullish: ['Price above 200 EMA'], bearish: [] },
      levels: { supports: [{ price: 76000 }], resistances: [{ price: 79000 }] },
      indicators: { rsi: 55, atr: 500, ema50: 76500 },
      plan: { side: 'long', title: 'Long / buy setup', entryZone: [76946, 77248], stopLoss: 76343, takeProfits: [78605, 79509, 79652], riskPct: 1.17, rewardRisk: 2.5 },
      waitFor: [] },
    forecast: { probUpPct: 41.9, validatedAccuracyPct: 56, confidence: 'Low', horizonBars: 6 },
    horizonText: '1 day',
  });
  assert.match(answer, /disagree/i, 'the reader must be told the readings conflict');
  assert.match(answer, /41\.9% up/, 'and shown the number that contradicts the signal');
  assert.ok(!/Conditions currently favour a \*\*long entry\*\*/.test(answer), 'the confident wording must be withdrawn when they conflict');
});

test('a whole-market question is answered across every timeframe', () => {
  const pick = (coin, name, price) => ({
    coin, name, verdict: 'BUY', conviction: 72, price, change24hPct: 1.2,
    buyBetween: [price * 0.99, price * 1.01], stopLoss: price * 0.96,
    sellTargets: [price * 1.04, price * 1.08], riskPct: 4,
    holdForBars: 5, expectedPeakPrice: price * 1.05, turnsDownAfterBars: 7,
    waitFor: null, topReason: 'Trend and momentum both point up',
  });
  const frame = (interval, label, buys) => ({ label, interval, horizonText: `about 2 days`, scanned: 20, buys, avoid: [], waitingCount: 3 });
  const marketFrames = {
    scanned: 20,
    intervals: ['1h', '4h', '1d'],
    frames: [
      frame('1h', 'Short term', [pick('SOL', 'Solana', 150)]),
      frame('4h', 'Swing', [pick('BTC', 'Bitcoin', 60000), pick('SOL', 'Solana', 150)]),
      frame('1d', 'Position', [pick('BTC', 'Bitcoin', 60000)]),
    ],
    agree: [{ coin: 'BTC', name: 'Bitcoin', frames: [{ label: 'Swing', interval: '4h', ...pick('BTC', 'Bitcoin', 60000) }, { label: 'Position', interval: '1d', ...pick('BTC', 'Bitcoin', 60000) }] }],
    avoid: [{ coin: 'DOGE', verdict: 'AVOID', conviction: 20, interval: '4h', topReason: 'Downtrend' }],
  };
  const a = ruleBasedAnswer('which coin should i buy and when do i sell?', { marketFrames, portfolio: [] });
  for (const must of ['Short term', 'Swing', 'Position', 'SOL', 'BTC', 'Sell at', 'Strongest overall', 'Avoid or sell', 'DOGE']) {
    assert.ok(a.includes(must), `whole-market answer is missing "${must}"`);
  }
  // it must not collapse into a single coin
  assert.ok(a.split('BTC').length > 2 && a.includes('SOL'));

  // a buy/sell question with no coin named is a market question
  assert.equal(isMarketWide('what should i buy this week and when do i sell'), true);
  assert.equal(isMarketWide('which one is best for the long term'), true);
  assert.equal(isMarketWide('should i buy this coin'), false);

  // and with no coin open, a generic question still gets the market answer
  const fallback = ruleBasedAnswer('when do i sell?', { marketFrames });
  assert.ok(fallback.includes('Whole-market scan'));
});

test('every module imports the helpers it calls', async () => {
  // A missing import only shows up at runtime, inside a template string, where it
  // silently blanks a whole panel. Most of this app's markup lives in template
  // literals, so the scan must look INSIDE ${...} while ignoring the prose around it.
  const fs = await import('node:fs');
  const path = await import('node:path');
  // The list of names is not hand-maintained: it is every helper any module in
  // this app exports. If a file calls one of them without importing it, that is
  // a ReferenceError waiting in production, and this test fails instead.
  // Emit only real code: skips comments and string/template TEXT, but keeps the
  // expressions inside ${ } — which is where the markup calls these helpers.
  const codeOnly = (src) => {
    let out = '';
    const stack = []; // 'tpl' or brace depth markers inside a template substitution
    let i = 0;
    while (i < src.length) {
      const c = src[i], d = src[i + 1];
      const inTpl = stack.length && stack[stack.length - 1] === 'tpl';
      if (!inTpl && c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (!inTpl && c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
      if (!inTpl && (c === "'" || c === '"')) {
        i++;
        while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
        i++; out += ' '; continue;
      }
      if (c === '`') { if (inTpl) stack.pop(); else stack.push('tpl'); i++; out += ' '; continue; }
      if (inTpl) {
        if (c === '\\') { i += 2; continue; }
        if (c === '$' && d === '{') { stack.push(1); i += 2; out += ' '; continue; }
        i++; continue; // template TEXT — drop it
      }
      if (stack.length && typeof stack[stack.length - 1] === 'number') {
        if (c === '{') stack[stack.length - 1]++;
        else if (c === '}') { stack[stack.length - 1]--; if (stack[stack.length - 1] === 0) { stack.pop(); i++; out += ' '; continue; } }
      }
      out += c; i++;
    }
    return out;
  };

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? walk(f) : f.endsWith('.js') ? [f] : [];
  });

  const files = walk('js');

  // Every exported helper name in the app, mapped to the file that exports it.
  const EXPORTS = new Map();
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) EXPORTS.set(m[1], file);
    for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) EXPORTS.set(m[1], file);
  }
  const NAMES = [...EXPORTS.keys()].filter((n) => n.length > 2);
  assert.ok(NAMES.length > 60, `expected to find the app helpers, found ${NAMES.length}`);

  // Anything bound inside the file itself: declarations, destructuring and
  // parameters. A name bound locally is not a missing import.
  const boundIn = (code) => {
    const out = new Set();
    for (const m of code.matchAll(/(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split(':').pop().split('=')[0].replace(/[.\s]/g, '');
        if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
      }
    }
    // parameter lists: (a, b) => …  /  (a, b) { …  /  x => …
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].split(',')) {
        const n = part.split('=')[0].replace(/[{}[\].\s]/g, '').split(':').pop();
        if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
      }
    }
    for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
    // object method shorthand — `{ async stats() {…} }` is a definition, not a call
    for (const m of code.matchAll(/(?:[{,]|\basync)\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) out.add(m[1]);

    return out;
  };

  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const code = codeOnly(src).replace(/\.\s*[A-Za-z_$][\w$]*/g, '.prop');
    const imported = new Set();
    for (const m of src.matchAll(/import \{([^}]*)\} from/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+as\s+/).pop().trim();
        if (name) imported.add(name);
      }
    }
    const declared = boundIn(code);
    for (const name of NAMES) {
      if (EXPORTS.get(name) === file) continue;
      if (new RegExp(`(?<![\\w.$])${name}\\(`).test(code) && !imported.has(name) && !declared.has(name)) {
        bad.push(`${file} calls ${name}() without importing it (exported by ${EXPORTS.get(name)})`);
      }
    }
  }
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
});
