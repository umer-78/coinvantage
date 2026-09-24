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
  assert.equal(labelFor(60).action, 'EXTENDED_UP');
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
  // Pin endTime: demoCandles defaults to Date.now(), and pattern-match
  // counts drift with the wall clock — bitcoin/1h can fall below minMatches.
  const END = Date.UTC(2026, 8, 24, 12, 0, 0);
  for (const [id, iv, H, ms] of [['bitcoin', '1h', 12, 3600e3], ['ethereum', '4h', 6, 4 * 3600e3], ['solana', '15m', 8, 900e3]]) {
    const c = demoCandles(id, iv, 900, END);
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

test('no score band is presented as a tradeable edge, because none survived the test', async () => {
  const { SIGNAL_EDGE_TESTED, edgeBand } = await import('../js/lib/signals.js');
  const { tradeSummary } = await import('../js/lib/summary.js');

  // Every published band must record that it FAILED the sequential test — this
  // guards against quietly reinstating a bucket average as if it were an edge.
  for (const [iv, t] of Object.entries(SIGNAL_EDGE_TESTED)) {
    assert.equal(t.beatsRandom, false, `${iv} is marked as beating random — re-measure before claiming that`);
    assert.ok(t.trades >= 300, `${iv} conclusion drawn from too few trades`);
    assert.ok(typeof t.randomR === 'number', `${iv} has no random control to compare against`);
  }
  // the 1h band, which looked strongest as a bucket, lost to random entries
  assert.ok(SIGNAL_EDGE_TESTED['1h'].tradedR < SIGNAL_EDGE_TESTED['1h'].randomR);

  // edgeBand no longer hands anyone a band to treat as evidence
  assert.equal(edgeBand('1h', 50).band, null);
  assert.equal(edgeBand('1h', 50).inside, false);
  assert.ok(edgeBand('1h', 50).tested, 'but the test result is still available to show');
  assert.equal(edgeBand('1d', 50).tested, null, 'untested timeframes claim nothing');

  const sum = tradeSummary({
    signal: { ok: true, score: 50, coinSymbol: 'BTC',
      plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: 0.055, geometryTested: true },
      waitFor: [] },
    forecast: { probUpPct: 60, validatedAccuracyPct: 58 }, interval: '1h', fmt: String,
  });
  assert.ok(!sum.steps.some((x) => x.label === 'Tested zone'), 'no step may present the score as evidence');
  const said = sum.caveats.join(' ');
  assert.match(said, /not a prediction of profit/i);
  assert.match(said, /entering at random/i);
  assert.match(said, /higher score does not mean a better trade/i);
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
  assert.equal(losing.tone, 'warn', 'a losing setup cannot be presented as a clean reading');
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
    ok: true, score: 31, coinSymbol: 'BTC', text: 'Leaning up',
    plan: { side: 'long', entryZone: [76946, 77248], stopLoss: 76343, takeProfits: [78605, 79509, 79652], riskPct: 1.17 },
    waitFor: [],
  };
  const s = tradeSummary({
    signal, forecast: { probUpPct: 63, validatedAccuracyPct: 58 },
    timing: { rising: true, bars: 6, targetPrice: 79000, turnBars: 8 },
    interval: '4h', horizonText: '1 day', fmt,
  });

  assert.equal(s.verdict, 'LEANING UP');
  const labels = s.steps.map((x) => x.label);
  for (const need of ['What this is', 'Entry zone, if you take it', 'Where to take profit', 'Where you are wrong', 'How much', 'How long']) {
    assert.ok(labels.includes(need), `the summary must answer "${need}" — got ${labels.join(', ')}`);
  }
  const sell = s.steps.find((x) => x.label === 'Where to take profit').text;
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
  assert.equal(clash.verdict, 'READINGS DISAGREE');
  assert.equal(clash.confidence, 'low');
  assert.ok(!clash.steps.some((x) => x.label === 'Entry zone, if you take it'), 'no entry plan is offered when the readings disagree');

  // no plan at all → it says what to wait for instead of inventing a trade
  const idle = tradeSummary({
    signal: { ok: true, score: 4, coinSymbol: 'BTC', plan: null, waitFor: ['Close above 79,000 on rising volume'] },
    interval: '4h', fmt,
  });
  assert.equal(idle.verdict, 'NO CLEAR TREND');
  assert.match(idle.steps.find((x) => x.label === 'What to wait for').text, /79,000/);

  // and it renders to markdown for the assistant and exports
  assert.match(summaryMarkdown(s), /\*\*Where to take profit:\*\*/);
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
    signal: { ...sig, text: 'Leaning up', tone: 'up', price: 77248,
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

test('a timeframe with no measured edge can never be sold as a confident call', async () => {
  const { tradeSummary, reconcileTimeframes } = await import('../js/lib/summary.js');
  const { TESTED_ACCURACY } = await import('../js/lib/predict.js');

  // Whichever timeframes the table lists as having no edge, the UI must not
  // render a confident verdict on them. The test picks one from the list rather
  // than naming a timeframe, so re-measuring can move the list without silently
  // disabling the rule.
  assert.ok(TESTED_ACCURACY.noEdge.length, 'the table must record which timeframes failed');
  const weak = TESTED_ACCURACY.noEdge[0];
  const strong = ['1m', '5m', '15m', '1h', '4h', '1d'].find((iv) => !TESTED_ACCURACY.noEdge.includes(iv));
  // every listed timeframe must genuinely be at or below its own baseline
  for (const iv of TESTED_ACCURACY.noEdge) {
    assert.ok(TESTED_ACCURACY[iv] <= TESTED_ACCURACY.baseline[iv], `${iv} is listed as no-edge but beats its baseline`);
  }
  // and an accuracy may never be published without the number it had to beat
  for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
    assert.equal(typeof TESTED_ACCURACY[iv], 'number', `${iv} has no measured accuracy`);
    assert.equal(typeof TESTED_ACCURACY.baseline[iv], 'number', `${iv} publishes an accuracy with no baseline beside it`);
  }

  const strongDaily = {
    ok: true, score: 67, coinSymbol: 'BTC', text: 'Extended up', tone: 'up',
    plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: 0.058 },
    waitFor: [],
  };
  const s = tradeSummary({
    signal: strongDaily, forecast: { probUpPct: 62, validatedAccuracyPct: 58 },
    interval: weak, horizonText: '2 weeks', fmt: String,
  });

  assert.notEqual(s.confidence, 'high', 'the worst-measured timeframe cannot be the most confident one');
  assert.doesNotMatch(s.verdict, /\bBUY\b|\bSELL\b/i, 'the verdict must describe the reading, never instruct');
  assert.ok(s.confidenceWhy && s.confidenceWhy.includes(weak), 'and the label says what it is based on');
  assert.ok(s.caveats.some((c) => /below a coin flip/i.test(c)), 'the reader is told the daily forecast has no edge');

  // the same setup on a timeframe that does have a record is allowed to rate higher
  const measured = tradeSummary({
    signal: { ...strongDaily, text: 'Leaning up' }, forecast: { probUpPct: 62, validatedAccuracyPct: 58 },
    interval: strong, horizonText: '1 hour', fmt: String,
  });
  assert.ok(!measured.caveats.some((c) => /below a coin flip/i.test(c)));
});

test('the timeframes are reconciled into one standing view instead of three verdicts', async () => {
  const { tradeSummary, reconcileTimeframes } = await import('../js/lib/summary.js');

  // the exact readings a user reported: 1h flat, 4h buy, 1d strongly buy
  const mtf = {
    '15m': { ok: true, score: 28, text: 'Buy', tone: 'up' },
    '1h': { ok: true, score: 5, text: 'Neutral', tone: 'flat' },
    '4h': { ok: true, score: 33, text: 'Buy', tone: 'up' },
    '1d': { ok: true, score: 67, text: 'Strong Buy', tone: 'up' },
  };

  const rec = reconcileTimeframes(mtf, '1h');
  assert.equal(rec.rows.length, 4);
  assert.ok(rec.score > 20, 'the weighted view leans buy');
  assert.equal(rec.relation, 'quiet', '1h has no direction of its own inside a rising market');
  assert.equal(rec.anchor.interval, '1d', 'the longest timeframe anchors direction');

  // every timeframe must produce the SAME combined number, or the page is still
  // telling the reader three different things
  const seen = new Set();
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const s = tradeSummary({
      signal: { ...mtf[iv], coinSymbol: 'BTC', plan: null, waitFor: ['no trigger'] },
      forecast: null, interval: iv, mtf, fmt: String,
    });
    const across = s.steps.find((x) => x.label === 'Across timeframes');
    assert.ok(across, `${iv} must carry the cross-timeframe paragraph`);
    assert.match(across.text, /Combined|combined view/i);
    assert.ok(s.steps.some((x) => x.label === 'Which timeframe to follow'), `${iv} must say which chart leads`);
    seen.add(s.reconciled.score);
  }
  assert.equal(seen.size, 1, 'the standing view must not change when the reader switches timeframe');

  // a timeframe pointing the other way is not served as a clean trade
  const against = tradeSummary({
    signal: { ok: true, score: -40, coinSymbol: 'BTC', text: 'Sell', tone: 'down',
      plan: { side: 'short', entryZone: [100, 101], stopLoss: 103, takeProfits: [97, 95, 92], riskPct: 2, expectancyR: 0.058 },
      waitFor: [] },
    forecast: null, interval: '1d', mtf: { ...mtf, '1d': { ok: true, score: -40, text: 'Sell', tone: 'down' } }, fmt: String,
  });
  assert.ok(/DISAGREE|WAIT/.test(against.verdict) || against.confidence === 'low',
    'a chart fighting the rest of the board is flagged, not presented as a trade');
});

test('matching a coin against its own history never looks into the future', async () => {
  const { historyMatch, backtestAnalog, analogVerdict, shapeFor } = await import('../js/lib/analog.js');
  const c = demoCandles('bitcoin', '1d', 1200);

  const m = historyMatch(c, { interval: '1d' });
  assert.ok(m.ok, 'a long history should produce a reading');
  const { window: W, horizon: H } = shapeFor('1d');
  assert.equal(m.window, W);
  assert.equal(m.horizon, H);

  // every matched stretch, plus the bars it is judged on, must end before the
  // window being matched begins — otherwise the "history" overlaps the present
  const liveStart = c.length - W;
  for (const mm of m.matches) {
    assert.ok(mm.endIndex + H < liveStart + W, 'a match must not reach into the live window');
    assert.ok(mm.endIndex + H <= c.length - 1, 'a match cannot need candles that do not exist');
    assert.equal(mm.series.length, W + H);
  }
  assert.equal(m.currentSeries.length, W);
  assert.ok(m.upCount + m.downCount === m.matches.length);

  // truncating the data must not change what the matcher saw at that point
  const earlier = c.slice(0, c.length - 5);
  const a = historyMatch(c.slice(0, 800), { interval: '1d' });
  const b = historyMatch(earlier.slice(0, 800), { interval: '1d' });
  if (a.ok && b.ok) assert.deepEqual(a.matches.map((x) => x.endIndex), b.matches.map((x) => x.endIndex));

  // the score has to carry a baseline, or the accuracy number means nothing
  const s = backtestAnalog(c, { interval: '1d' });
  assert.ok(s.ok, 'a 1200-candle history should be scoreable');
  assert.ok(s.tests >= 20);
  assert.ok(s.step >= s.horizon, 'test points must be at least one horizon apart');
  assert.equal(typeof s.baselinePct, 'number');
  assert.equal(s.beatsBaseline, s.accuracyPct > s.baselinePct);
  assert.ok(s.baselinePct >= 50, 'the majority-class baseline is never below a coin flip');

  // and a method that loses to the baseline must be described as losing
  const v = analogVerdict(m, { ...s, ok: true, beatsBaseline: false, accuracyPct: 44, baselinePct: 53, tests: 60 }, { symbol: 'BTC', interval: '1d' });
  assert.equal(v.tone, 'warn');
  assert.ok(v.lines.some((l) => /did not earn its keep/i.test(l)));

  // too little history is an answer, not a guess
  assert.equal(historyMatch(c.slice(0, 40), { interval: '1d' }).ok, false);
  assert.equal(backtestAnalog(c.slice(0, 120), { interval: '1d' }).ok, false);
});

test('the shape matcher is published as a picture, not as an edge it failed to earn', async () => {
  const { ANALOG_TESTED, analogVerdict, historyMatch } = await import('../js/lib/analog.js');

  // Measured across 12 coins on real candles, shape matching lost to the
  // majority-class baseline on every timeframe. This guard exists so the result
  // cannot be quietly flipped back to a claim without re-measuring.
  assert.equal(ANALOG_TESTED.beatsBaselineOverall, false);
  for (const iv of ['1h', '4h', '1d']) {
    const t = ANALOG_TESTED[iv];
    assert.ok(t.meanAccuracy < t.meanBaseline, `${iv} is recorded as beating its baseline — re-measure before claiming that`);
    assert.ok(t.tests >= 1000, `${iv} conclusion drawn from too few tests`);
    assert.ok(t.coinsBeatingBaseline <= t.coins / 2, `${iv} claims a majority of coins beat baseline`);
  }

  // a failing score must change how the headline reads, not just add a footnote
  const c = demoCandles('ethereum', '1d', 1200);
  const m = historyMatch(c, { interval: '1d' });
  const lost = analogVerdict(m, { ok: true, beatsBaseline: false, accuracyPct: 44, baselinePct: 53, tests: 60, confidentAccuracyPct: null }, { symbol: 'ETH', interval: '1d' });
  assert.match(lost.headline, /history rather than as a lean|not taking a side/i);
  assert.equal(lost.tone, 'warn');
  assert.ok(lost.lines.some((l) => /12 coins/.test(l)), 'the cross-coin result travels with every reading');
});

test('the track record reads the outcome words the scorer actually writes', async () => {
  const fs = await import('node:fs/promises');
  const scorer = await fs.readFile(new URL('../supabase/functions/cv/track.ts', import.meta.url), 'utf8');
  const view = await fs.readFile(new URL('../js/views/track.js', import.meta.url), 'utf8');

  // Every literal the server can store in plan_result.
  const written = new Set([...scorer.matchAll(/planResult = '([a-z0-9]+)'/g)].map((m) => m[1]));
  assert.ok(written.size >= 4, `expected the scorer to write several outcomes, found ${[...written]}`);

  // The page used to test for 'win' and 'loss', which the scorer has never
  // written, so every plan statistic rendered as an em dash. This fails if that
  // vocabulary drifts apart again.
  for (const word of written) {
    if (word === 'none') continue;
    assert.ok(view.includes(`'${word}'`), `the track page never mentions plan_result '${word}' — its statistics will silently read as empty`);
  }
  assert.ok(!/plan_result === 'win'|plan_result === 'loss'/.test(view), 'the page is matching outcome words the server does not write');

  // and it must compare the hit rate against a baseline computed from the rows,
  // not against a hardcoded guess about which way crypto drifts
  assert.ok(/baseline/i.test(view), 'the track record must show what the hit rate has to beat');
  assert.ok(!/always predict up" scores about 51%/.test(view), 'the baseline must be measured, not assumed');
});

test('the score is labelled as what it measured, never as an instruction', async () => {
  const { labelFor, upRateFor, SCORE_BUCKETS_TESTED, THRESHOLDS } = await import('../js/lib/signals.js');

  // Sorting 244,000 bars by score showed the share that rose FALLS as the score
  // rises. A label that says "Buy" for the bars least likely to rise is not a
  // wording preference, it is a false statement, so no label may contain one.
  for (const score of [100, 70, 45, 25, 0, -25, -45, -70, -100]) {
    const l = labelFor(score);
    assert.doesNotMatch(l.text, /\b(buy|sell)\b/i, `labelFor(${score}) says "${l.text}"`);
    assert.doesNotMatch(l.action, /BUY|SELL/, `labelFor(${score}) action is "${l.action}"`);
  }

  // and the measured record has to travel with the reading
  assert.equal(SCORE_BUCKETS_TESTED.higherScoreMeansHigherChance, false);
  assert.equal(SCORE_BUCKETS_TESTED.invertingItAlsoFails, true);
  assert.ok(SCORE_BUCKETS_TESTED.bars > 100000);
  for (const [iv, b] of Object.entries(SCORE_BUCKETS_TESTED.upRateByBucket)) {
    assert.ok(b.extendedUp < b.extendedDown, `${iv}: the top bucket is recorded as better than the bottom — re-measure before claiming that`);
    assert.ok(b.extendedUp < 50, `${iv}: the top bucket is recorded above a coin flip`);
  }

  const top = upRateFor('1h', 70);
  assert.equal(top.bucket, 'extendedUp');
  assert.ok(top.upRatePct < 50);
  assert.equal(upRateFor('1w', 70), null, 'unmeasured timeframes claim nothing');

  // the summary must carry it too
  const { tradeSummary } = await import('../js/lib/summary.js');
  const s = tradeSummary({
    signal: { ok: true, score: 67, coinSymbol: 'BTC', text: labelFor(67).text, tone: 'up',
      plan: { side: 'long', entryZone: [100, 101], stopLoss: 98, takeProfits: [103, 105, 108], riskPct: 2, expectancyR: 0.055 }, waitFor: [] },
    forecast: null, interval: '1h', fmt: String,
  });
  assert.doesNotMatch(s.verdict, /\bBUY\b|\bSELL\b/i);
  assert.match(s.headline, /not a recommendation/i);
  assert.ok(s.caveats.some((c) => /FALLS as this score rises/.test(c)), 'the direction of the measured effect must be stated');
  void THRESHOLDS;
});

test('timing is judged against its own baseline, per timeframe', async () => {
  const { TESTED_TIMING, timingTrust } = await import('../js/lib/timing.js');

  // Every timeframe must carry the number it had to beat. Comparing them all to
  // one global baseline flattered whichever timeframe sat in an easy window.
  for (const [iv, t] of Object.entries(TESTED_TIMING.byInterval)) {
    assert.equal(typeof t.baselinePct, 'number', `${iv} publishes a hit rate with no baseline`);
    assert.ok(t.tests >= 20, `${iv} drawn from too few tests`);
    const trust = timingTrust(iv);
    const edge = t.hitPct - t.baselinePct;
    if (edge < 1) assert.equal(trust.level, 'bad', `${iv} has no edge but is not labelled as such`);
    if (edge >= 4) assert.equal(trust.level, 'good', `${iv} clears its baseline but is not labelled as such`);
    assert.ok(trust.text.includes(String(t.baselinePct)), `${iv} does not show the reader its baseline`);
  }

  // an unmeasured timeframe claims nothing
  const unknown = timingTrust('1w');
  assert.equal(unknown.level, 'unknown');
  assert.doesNotMatch(unknown.text, /\d+(\.\d+)?%/, 'an unmeasured timeframe must not quote a percentage');

  // the headline must stay consistent with the parts
  assert.ok(TESTED_TIMING.peakHitPct > TESTED_TIMING.baselinePct, 'the overall claim must beat its own baseline');
  assert.ok(TESTED_TIMING.tests >= 900);
});

test('the chart score earns no vote in any verdict, because it was measured to point the wrong way', async () => {
  const { adviseCoin } = await import('../js/lib/advice.js');
  const { generateSignal, upRateFor } = await import('../js/lib/signals.js');

  // This module weights each reading by its measured accuracy. The chart signal
  // was the one exception — a hardcoded 0.9, heavier than anything else, never
  // gated — and it is the reading that tests showed is anti-predictive. This
  // fails if that exemption is reinstated.
  for (const iv of ['5m', '15m', '1h', '4h', '1d']) {
    const c = demoCandles('bitcoin', iv === '1d' ? '1d' : '4h', 600);
    const sig = generateSignal(c, { interval: iv });
    if (!sig.ok) continue;
    const a = adviseCoin({ signal: sig, interval: iv });
    const part = a.parts.find((p) => p.key === 'signal');
    assert.ok(part, `${iv}: the signal should still be reported`);
    assert.equal(part.weight, 0, `${iv}: the chart score is voting with weight ${part.weight}`);
    // and with nothing else supplied, there is nothing to be convicted about
    assert.equal(a.conviction, 0, `${iv}: conviction ${a.conviction} from a reading with no edge`);
    assert.equal(a.verdict, 'WAIT');
  }

  // the measured up-rate must still be quoted to the reader
  const c = demoCandles('ethereum', '4h', 600);
  const sig = generateSignal(c, { interval: '4h' });
  const a = adviseCoin({ signal: sig, interval: '4h' });
  const reason = a.reasons.find((r) => /Chart reading/.test(r.text));
  assert.ok(reason, 'the chart reading must still be shown');
  const bucket = upRateFor('4h', sig.score);
  assert.ok(reason.text.includes(String(bucket.upRatePct)), 'the reader must see the measured up-rate for this band');
  assert.match(reason.text, /no weight in the verdict/i);
});

test('the backtest replays the same trade the page prints, not a different one', async () => {
  const { backtest, geometryFor } = await import('../js/lib/signals.js');
  const c = demoCandles('bitcoin', '1h', 900);

  // The coin page shows a plan built from the measured geometry, then used to
  // backtest a fixed 1.5 ATR / 2.5R with a break-even stop — a different trade
  // from the one it had just recommended. Passing the interval must now pick up
  // that timeframe's real stop and target.
  for (const iv of ['15m', '1h', '4h', '1d']) {
    const geo = geometryFor(iv);
    const withIv = backtest(c, { interval: iv });
    const explicit = backtest(c, { atrStop: geo.stopAtr, rMultiple: geo.rr });
    assert.equal(withIv.ok, explicit.ok, `${iv}: differing outcomes`);
    if (withIv.ok) {
      assert.equal(withIv.tradeCount, explicit.tradeCount, `${iv}: interval did not select the measured geometry`);
      assert.equal(withIv.totalReturnPct, explicit.totalReturnPct, `${iv}: interval did not select the measured geometry`);
    }
  }

  // and the break-even move, measured as costly, must be off unless asked for
  const plain = backtest(c, { interval: '1h' });
  const withBe = backtest(c, { interval: '1h', breakEvenAtR: 1 });
  if (plain.ok && withBe.ok) {
    assert.ok(plain.trades.every((t) => t.reason !== 'breakeven'),
      'break-even exits appear with no breakEvenAtR set — the default is meant to be off');
  }
});

test('the assistant never presents the chart score as a buy or sell instruction', async () => {
  const { ruleBasedAnswer } = await import('../js/lib/analyst.js');
  const { generateSignal } = await import('../js/lib/signals.js');

  const candles = demoCandles('bitcoin', '4h', 600);
  const sig = generateSignal(candles, { interval: '4h' });
  const ctx = {
    coin: { name: 'Bitcoin', symbol: 'BTC', price: sig.price, change24h: 1.2 },
    interval: '4h', signal: sig, forecast: null, mtf: null,
  };

  // These are the words the assistant says to a person. A reading that was
  // measured to point the wrong way must not be phrased as a recommendation.
  const banned = [
    /favour[s]? a \*\*long entry\*\*/i,
    /not a good time to buy/i,
    /the chart is \*\*bullish\*\*/i,
    /the chart is \*\*bearish\*\*/i,
    /\*\*Signal: /,
  ];
  for (const q of ['should i buy btc', 'when do i exit btc', 'what is btc doing', 'entry for btc']) {
    const answer = ruleBasedAnswer(q, ctx);
    assert.ok(typeof answer === 'string' && answer.length > 40, `no answer for "${q}"`);
    for (const re of banned) {
      assert.doesNotMatch(answer, re, `"${q}" answered with instruction-shaped wording: ${re}`);
    }
  }

  // and the measured record must travel with the reading it describes
  const plain = ruleBasedAnswer('what is btc doing', ctx);
  assert.match(plain, /Chart reading:/);
  assert.match(plain, /followed by a higher price/i);
});

test('OKX futures fallback maps funding interval, basis and history correctly', async () => {
  const { okxSnapshotFrom, okxOverviewFrom, okxFundingHours, interpretFutures } = await import('../js/api/futures.js');
  assert.equal(okxFundingHours('1789603200000', '1789632000000'), 8);
  assert.equal(okxFundingHours('1789603200000', '1789617600000'), 4);
  assert.equal(okxFundingHours(undefined, undefined), 8);
  const f = okxSnapshotFrom('BTC', {
    mark: { markPx: '101' }, idx: { idxPx: '100' },
    fund: { fundingRate: '0.0001', fundingTime: '1789603200000', nextFundingTime: '1789617600000' },
    oi: { oiCcy: '10', oiUsd: '1010' },
    // newest first, as OKX sends them
    fHist: [{ fundingTime: '2000', realizedRate: '0.0002' }, { fundingTime: '1000', fundingRate: '0.0001' }],
  });
  assert.equal(f.source, 'OKX');
  assert.equal(f.fundingIntervalHours, 4);
  assert.ok(Math.abs(f.basisPct - 1) < 1e-9);
  assert.equal(f.openInterestUsd, 1010);
  assert.deepEqual(f.fundingHistory.map((r) => r.rate), [0.0001, 0.0002]);
  for (const k of ['oiHistory', 'longShort', 'topTraders', 'takerFlow']) assert.deepEqual(f[k], []);
  const iv = interpretFutures(f);
  assert.equal(iv.longAccountsPct, null);
  assert.equal(iv.fundingIntervalHours, 4);
  // the positioning note used to say "Binance" whatever the source was
  const named = interpretFutures({ ...f, longShort: [{ t: 1, longPct: 60 }] });
  assert.ok(named.notes.some((x) => x.includes('60% of OKX futures accounts')));

  const rows = okxOverviewFrom(['BTC', 'NOPE'], {
    marks: [{ instId: 'BTC-USDT-SWAP', markPx: '100' }],
    ois: [{ instId: 'BTC-USDT-SWAP', oiCcy: '2', oiUsd: '200' }],
    funds: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openInterestUsd, 200);
  assert.equal(rows[0].fundingRate, null);                // missing funding stays unknown, not 0
});

test('the liquidation feed falls back when the socket never opens, and never calls a quiet OKX feed dead', async (t) => {
  const { liquidationStream } = await import('../js/api/futures.js');

  // A blocked network often holds the handshake rather than refusing it: no
  // onopen, no onclose, no onerror. The watchdog used to be armed inside
  // onopen, so in that case nothing was ever armed and the pill read
  // "connecting…" for ever with no fallback and no failure.
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(x) { this.sent.push(x); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = realWS; });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const seen = [];
  const stop = liquidationStream((ev, status, venue) => { if (!ev) seen.push(`${status}:${venue}`); });

  assert.equal(sockets.length, 1, 'no socket was opened');
  assert.match(sockets[0].url, /binance/i);

  // the handshake hangs — nothing at all comes back
  t.mock.timers.tick(21000);
  assert.ok(seen.includes('switching:Binance'), `no fallback fired: ${seen.join(', ') || '(silence)'}`);
  assert.equal(sockets.length, 2, 'no replacement socket was opened');
  assert.match(sockets[1].url, /okx/i);

  // the abandoned socket must not schedule a reconnect of its own
  sockets[0].onclose?.();
  assert.equal(sockets.length, 2, 'the discarded socket started a second connection');

  // OKX confirms the subscription and then stays quiet, which is normal
  sockets[1].onopen?.();
  sockets[1].onmessage?.({ data: JSON.stringify({ event: 'subscribe', arg: { channel: 'liquidation-orders' } }) });
  assert.ok(seen.includes('live:OKX'), `the acknowledgement was not taken as proof of life: ${seen.join(', ')}`);

  seen.length = 0;
  t.mock.timers.tick(90000);
  assert.ok(!seen.some((s) => s.startsWith('failed')),
    `a healthy but quiet OKX feed was reported dead: ${seen.join(', ')}`);

  // every status names the venue, so the pill cannot claim Binance while on OKX
  assert.ok(seen.concat(['live:OKX']).every((s) => /:(Binance|OKX)$/.test(s)), 'a status arrived with no venue');

  stop();
});

test('a value the app cannot show is never left as a bare dash with no explanation', async () => {
  const fs = await import('node:fs');

  // This app's rule is that a missing number says why it is missing — the
  // futures page names the OKX limitation, the coin page explains a forecast
  // with no turning point. The scanner's "Move timing" column broke that rule:
  // two unrelated causes both rendered as a silent "—", so a reader could not
  // tell an unmeasurable chart from a broken one.
  const src = fs.readFileSync('js/views/scanner.js', 'utf8');

  const dashes = [...src.matchAll(/<span class="muted"[^>]*>—<\/span>/g)].map((m) => m[0]);
  assert.ok(dashes.length > 0, 'expected the scanner to render placeholder dashes');
  for (const d of dashes) {
    assert.match(d, /title="/, `an unexplained placeholder dash is back in the scanner: ${d}`);
  }

  // and the explanation must be the real reason, not a generic string
  assert.match(src, /t\?\.reason/, 'the scanner no longer carries the timing reason from the engine');
});

test('a suggested question is allowed to wrap, so one long prompt cannot widen a phone screen', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync('css/app.css', 'utf8');
  const view = fs.readFileSync('js/views/assistant.js', 'utf8');

  // The assistant's suggestions are whole sentences rendered with .btn, which
  // pins white-space to nowrap and the height to 38px. One prompt came out
  // 416px wide on a 390px phone; because it could not wrap it pushed the visual
  // viewport to 463px and the entire page rendered zoomed out.
  const rule = css.match(/\.suggest button \{[^}]*\}/);
  assert.ok(rule, '.suggest button rule is gone');
  assert.match(rule[0], /white-space:\s*normal/, 'suggestion chips are back to nowrap');
  assert.match(rule[0], /max-width:\s*100%/, 'a suggestion chip can exceed its container again');
  assert.match(rule[0], /height:\s*auto/, 'a wrapped suggestion is still pinned to one line height');

  // and .btn itself must keep nowrap — real buttons should not wrap
  const btn = css.match(/\n\.btn \{[^}]*\}/);
  assert.ok(btn && /white-space:\s*nowrap/.test(btn[0]), '.btn lost its nowrap');

  // the suggestions really are sentences, which is why this matters
  const longest = [...view.matchAll(/'([^']{25,})'/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0] || '';
  assert.ok(longest.length > 40, 'expected the assistant to offer sentence-length prompts');
});

test('a coin reference lookup that failed is never shown as a coin with no supply cap', async () => {
  const fs = await import('node:fs');
  const market = fs.readFileSync('js/api/market.js', 'utf8');
  const view = fs.readFileSync('js/views/coin.js', 'utf8');

  // CoinGecko rate-limits free requests, so getCoinProfile fails intermittently.
  // It used to answer a failure and "this coin has no profile" with the same
  // null, and the About tab rendered both as "Max supply ∞ / —". Bitcoin is
  // capped at 21 million, so on a throttled load the page stated the opposite
  // of the truth.
  const fn = market.match(/export async function getCoinProfile[\s\S]*?\n}/);
  assert.ok(fn, 'getCoinProfile is gone');
  assert.match(fn[0], /unavailable:\s*true/, 'a failed profile lookup is indistinguishable from an absent one again');

  // the infinity claim may only be made about a profile that actually loaded
  const infinity = [...view.matchAll(/[^\n]*∞[^\n]*/g)].map((m) => m[0]);
  for (const line of infinity) {
    assert.fail(`the About tab still claims an infinite supply: ${line.trim()}`);
  }
  assert.match(view, /loaded \? 'No cap' : unknown/, 'the max-supply cell no longer distinguishes "no cap" from "not loaded"');

  // and a failed load must say so rather than printing bare dashes
  assert.match(view, /Reference data did not load/, 'a failed reference lookup is silent again');
});

test('a question about how well the engine works is answered with its measured record, not a price forecast', async () => {
  const { ruleBasedAnswer } = await import('../js/lib/analyst.js');
  const { generateSignal } = await import('../js/lib/signals.js');
  const { forecast, summarizeForecast, TESTED_ACCURACY } = await import('../js/lib/predict.js');

  const candles = demoCandles('bitcoin', '4h', 600);
  const sig = generateSignal(candles, { interval: '4h' });
  const fc = forecast(candles, { horizon: 6, fast: true });
  const ctx = {
    coin: { name: 'Bitcoin', symbol: 'BTC', price: sig.price, change24h: 1.2 },
    interval: '4h', signal: sig, forecast: fc.ok ? summarizeForecast(fc) : null, mtf: null,
  };

  // "predictions" contains "predict", so this used to match the forecast intent
  // first and answer a question about the model with output from the model.
  for (const q of ['how accurate are your predictions', 'how reliable is this forecast', 'can I trust this']) {
    const a = ruleBasedAnswer(q, ctx);
    assert.match(a, /easured forecast accuracy/, `"${q}" was not answered with the measured record`);
    assert.ok(a.includes(String(TESTED_ACCURACY.all)), `"${q}" did not quote the overall tested accuracy`);
    assert.match(a, /does \*\*not\*\* beat|no measured edge/, `"${q}" omitted that it does not beat its baseline`);
  }

  // a real forecast question must still get a forecast
  const f = ruleBasedAnswer('will btc go up tomorrow', ctx);
  assert.match(f, /chance of going up|AI forecast/i, 'a forecast question stopped getting a forecast');
});

test('the assistant never calls the chart score a buy or a sell, including when the readings disagree', async () => {
  const { ruleBasedAnswer, conflictCheck } = await import('../js/lib/analyst.js');
  const { generateSignal } = await import('../js/lib/signals.js');
  const { forecast, summarizeForecast } = await import('../js/lib/predict.js');

  // The disagreement warning survived the audit that removed buy/sell verdicts
  // everywhere else: it said "The chart signal says **buy**" two sentences
  // below a line explaining the score does not say where price goes next.
  // The block only renders when the two readings actually disagree, so the
  // forecast is forced to lean against the chart rather than left to chance —
  // otherwise this test passes without ever reaching the line it guards.
  const banned = [/signal says \*\*(buy|sell)\*\*/i, /chart signal says/i];
  let exercised = 0;

  for (const coin of ['bitcoin', 'ethereum', 'solana']) {
    for (const iv of ['15m', '1h', '4h', '1d']) {
      const c = demoCandles(coin, iv === '1d' ? '1d' : '4h', 600);
      const sig = generateSignal(c, { interval: iv });
      if (!sig.ok) continue;
      const fc = forecast(c, { horizon: 6, fast: true });
      if (!fc.ok) continue;
      const side = sig.plan?.side ?? (sig.score > 0 ? 'long' : sig.score < 0 ? 'short' : null);
      if (!side) continue;

      // point the forecast the other way, keeping the real summary shape
      const f = { ...summarizeForecast(fc), probUpPct: side === 'long' ? 30 : 70 };
      const ctx = { coin: { name: coin, symbol: coin.slice(0, 3).toUpperCase(), price: sig.price, change24h: 0.4 },
                    interval: iv, signal: sig, forecast: f };
      assert.ok(conflictCheck(sig, f), `${coin}/${iv}: the disagreement was not set up`);

      for (const q of ['should i buy', 'what is it doing', 'when do i exit']) {
        const a = ruleBasedAnswer(q, ctx);
        if (/readings disagree/i.test(a)) exercised++;
        // a fallback beginning with "the" once produced "the next the forecast horizon"
        assert.doesNotMatch(a, /\bthe next the\b/i, `${coin}/${iv} "${q}" has a doubled article`);
        for (const re of banned) {
          assert.doesNotMatch(a, re, `${coin}/${iv} "${q}" calls the chart score a buy or sell`);
        }
      }
    }
  }

  assert.ok(exercised > 0, 'the disagreement warning never rendered, so this test proved nothing');
});
