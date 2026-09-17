// Gathers everything the assistant needs about a coin: live candles, signals on
// several timeframes, the AI forecast, backtest, sentiment and the user's holdings.
import { markets, findCoin, getCandles, getFearGreed, INTERVAL_MS } from '../api/market.js';
import { generateSignal, confluence, backtest } from '../lib/signals.js';
import { summarizeForecast } from '../lib/predict.js';
import { runForecast, runHistory } from '../lib/compute.js';
import { timingOutlook, summarizeTiming, timingText } from '../lib/timing.js';
import { adviseCoin, rankAdvice } from '../lib/advice.js';
import { isStable } from '../api/market.js';
import { horizonText } from '../format.js';
import { load } from '../store.js';
import { getNews, backendEnabled } from '../api/backend.js';

const cache = new Map();
export const DEFAULT_HORIZON = { '1s': 30, '5s': 24, '10s': 18, '1m': 15, '5m': 12, '15m': 8, '1h': 12, '4h': 6, '1d': 7 };

export function remember(symbol, interval, patch) {
  const key = `${symbol}:${interval}`;
  cache.set(key, { ...(cache.get(key) || {}), ...patch, at: Date.now() });
}

export async function analyzeCoin(symbol, { interval = '4h', withForecast = true, onStep } = {}) {
  const key = `${symbol}:${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 90e3 && (!withForecast || hit.forecast)) return hit;
  const coin = await findCoin(symbol);
  if (!coin) throw new Error(`I couldn't find ${symbol} in the top 250 coins.`);
  onStep?.('Loading live chart data…');
  const main = await getCandles(coin, interval, 1500);
  const signal = generateSignal(main.candles, { interval });
  onStep?.('Checking other timeframes…');
  const others = ['15m', '1h', '4h', '1d'].filter((iv) => iv !== interval);
  const mtf = { [interval]: signal };
  await Promise.all(others.map(async (iv) => {
    try { const r = await getCandles(coin, iv, 300); mtf[iv] = generateSignal(r.candles, { interval: iv }); } catch { /* skip */ }
  }));
  const conf = confluence(mtf);
  const bt = backtest(main.candles.slice(-1000));
  let forecast = hit?.forecast || null;
  const horizon = DEFAULT_HORIZON[interval] || 12;
  if (withForecast && !forecast) {
    onStep?.('Running AI forecast (pattern matching + ML models)…');
    forecast = await runForecast(main.candles, { horizon });
  }
  // Long-range study on daily candles: what happened the last times this chart
  // looked like today, plus this coin's seasonality. Never blocks the answer.
  let history = hit?.history || null;
  if (!history) {
    onStep?.('Comparing today with previous years…');
    history = await getCandles(coin, '1d', 2000)
      .then((d) => runHistory(d.candles, { window: 45, horizons: [7, 30, 90], horizon: 30 }))
      .catch(() => null);
  }
  // How long the move lasts and when it turns — the other half of "will it go up".
  const timing = forecast?.ok ? timingOutlook(forecast, { intervalMs: INTERVAL_MS[interval] }) : null;
  // Recent headlines for this coin. Context for the answer only — never an
  // input to the price model, whose accuracy is measured on price data alone.
  let news = hit?.news || null;
  if (!news && backendEnabled()) {
    news = await getNews({ coin: coin.symbol, limit: 6 }).catch(() => []);
  }
  const fng = await getFearGreed().catch(() => null);
  const result = {
    coin, interval, candles: main.candles, source: main.source, signal, mtf, confluence: conf, backtest: bt,
    forecast, history, timing, news, horizon, horizonText: horizonText(interval, horizon), fearGreed: fng?.[0] || null, at: Date.now(),
  };
  cache.set(key, result);
  return result;
}

// "Which coin should I buy?" needs the whole market, not one chart. Scans the
// top coins and returns a ranked verdict for each, same engine as the advice page.
const scanCache = new Map();
export async function scanMarket({ interval = '4h', count = 20, onStep } = {}) {
  const key = `${interval}:${count}`;
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < 180e3) return hit.rows;

  const list = (await markets()).filter((c) => c.binance && !isStable(c.symbol)).slice(0, count);
  const rows = [];
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const coin = queue.shift();
      try {
        const { candles } = await getCandles(coin, interval, 500);
        rows.push({ coin, signal: generateSignal(candles, { interval }), candles });
      } catch { /* skip */ }
      onStep?.(`Scanning the market… ${++done}/${list.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Forecast + timing only for the coins with a real technical signal — that
  // keeps the answer fast without dropping anything that could be a pick.
  const shortlist = rows.filter((r) => r.signal.ok).sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score)).slice(0, 10);
  const horizon = DEFAULT_HORIZON[interval] || 12;
  for (const row of shortlist) {
    onStep?.(`Forecasting ${row.coin.symbol}…`);
    try {
      const fc = await runForecast(row.candles, { horizon, fast: true, intervalMs: INTERVAL_MS[interval] });
      row.forecast = fc;
      row.timing = fc?.ok ? timingOutlook(fc, { intervalMs: INTERVAL_MS[interval] }) : null;
    } catch { /* advice still works from the signal alone */ }
  }
  for (const row of rows) {
    row.advice = adviseCoin({ signal: row.signal, forecast: row.forecast, timing: row.timing, interval: row.interval || interval });
    row.candles = null;
  }
  scanCache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Compact market picks for the analyst and the LLM. */
export function marketContext(rows, interval) {
  const { buys, avoid, wait, total } = rankAdvice(rows);
  const shape = (r) => ({
    coin: r.coin.symbol,
    name: r.coin.name,
    verdict: r.advice.verdict,
    conviction: r.advice.conviction,
    price: r.advice.price,
    change24hPct: r.coin.change24h === null || r.coin.change24h === undefined ? null : +r.coin.change24h.toFixed(2),
    buyBetween: r.advice.plan ? r.advice.plan.entryZone : null,
    stopLoss: r.advice.plan ? r.advice.plan.stopLoss : null,
    sellTargets: r.advice.plan ? r.advice.plan.takeProfits : null,
    riskPct: r.advice.plan ? r.advice.plan.riskPct : null,
    holdForBars: r.advice.timing?.rising ? r.advice.timing.bars : null,
    expectedPeakPrice: r.advice.timing?.rising ? +r.advice.timing.targetPrice.toPrecision(6) : null,
    turnsDownAfterBars: r.advice.timing?.turnBars ?? null,
    waitFor: r.advice.waitFor?.[0] || null,
    topReason: r.advice.reasons[0]?.text || null,
  });
  return {
    interval,
    horizonText: horizonText(interval, DEFAULT_HORIZON[interval] || 12),
    scanned: total,
    buys: buys.slice(0, 6).map(shape),
    avoid: avoid.slice(0, 4).map(shape),
    waitingCount: wait.length,
  };
}

// The whole market, read on several timeframes at once. "Which coin should I
// buy?" has a different answer over the next few hours than over the next few
// weeks, so the assistant answers all three rather than picking one for you.
export const SCAN_FRAMES = [
  { interval: '1h', label: 'Short term' },
  { interval: '4h', label: 'Swing' },
  { interval: '1d', label: 'Position' },
];

export async function scanMarketMulti({ intervals = SCAN_FRAMES.map((f) => f.interval), count = 20, onStep } = {}) {
  const byInterval = {};
  for (const interval of intervals) {
    onStep?.(`Scanning the market on the ${interval} chart…`);
    byInterval[interval] = await scanMarket({ interval, count, onStep: (t) => onStep?.(`${interval}: ${t.replace('Scanning the market… ', '')}`) });
  }
  return byInterval;
}

/** Per-timeframe picks plus the coins that look good on more than one timeframe. */
export function marketContextMulti(byInterval) {
  const frames = SCAN_FRAMES
    .filter((f) => byInterval[f.interval])
    .map((f) => ({ label: f.label, ...marketContext(byInterval[f.interval], f.interval) }));

  // A coin that ranks as a buy on two or three timeframes is a stronger call
  // than one that only looks good on a single chart — say which, and how many.
  const tally = new Map();
  for (const fr of frames) {
    for (const b of fr.buys) {
      const e = tally.get(b.coin) || { coin: b.coin, name: b.name, frames: [], convictionSum: 0 };
      e.frames.push({ label: fr.label, interval: fr.interval, horizonText: fr.horizonText, ...b });
      e.convictionSum += b.conviction;
      tally.set(b.coin, e);
    }
  }
  const agree = [...tally.values()]
    .sort((a, b) => b.frames.length - a.frames.length || b.convictionSum - a.convictionSum)
    .slice(0, 5);

  const avoidAll = new Map();
  for (const fr of frames) for (const a of fr.avoid) if (!avoidAll.has(a.coin)) avoidAll.set(a.coin, { ...a, label: fr.label, interval: fr.interval });

  return {
    frames,
    agree,
    avoid: [...avoidAll.values()].slice(0, 5),
    scanned: frames[0]?.scanned || 0,
    intervals: frames.map((f) => f.interval),
  };
}

/** Read two to four coins on the same timeframe so they can be ranked fairly. */
export async function compareCoins(symbols, { interval = '4h', onStep } = {}) {
  const list = await markets().catch(() => []);
  const rows = [];
  for (const sym of symbols.slice(0, 4)) {
    onStep?.(`Reading ${sym}…`);
    try {
      const coin = await findCoin(sym);
      if (!coin) continue;
      const { candles } = await getCandles(coin, interval, 600);
      const signal = generateSignal(candles, { interval });
      let forecast = null, timing = null;
      try {
        forecast = await runForecast(candles, { horizon: DEFAULT_HORIZON[interval] || 12, fast: true, intervalMs: INTERVAL_MS[interval] });
        timing = forecast?.ok ? timingOutlook(forecast, { intervalMs: INTERVAL_MS[interval] }) : null;
      } catch { /* the chart signal alone still ranks */ }
      const advice = adviseCoin({ signal, forecast, timing, interval });
      const live = list.find((c) => c.symbol === coin.symbol);
      const f = forecast?.ok ? summarizeForecast(forecast) : null;
      rows.push({
        coin: coin.symbol, name: coin.name,
        verdict: advice.verdict, conviction: advice.conviction,
        signalText: signal.ok ? signal.text : null,
        score: signal.ok ? signal.score : null,
        probUpPct: f ? f.probUpPct : null,
        accuracyPct: f ? f.validatedAccuracyPct : null,
        change24h: live?.change24h ?? coin.change24h ?? null,
        buyBetween: advice.plan ? advice.plan.entryZone : null,
        stopLoss: advice.plan ? advice.plan.stopLoss : null,
        sellTargets: advice.plan ? advice.plan.takeProfits : null,
        topReason: advice.reasons?.[0]?.text || null,
      });
    } catch { /* skip a coin we cannot read rather than failing the whole answer */ }
  }
  return rows;
}

export async function portfolioSummary() {
  const holdings = load('holdings', []);
  if (!holdings.length) return [];
  const list = await markets().catch(() => []);
  return holdings.map((h) => {
    const c = list.find((m) => m.symbol === h.symbol);
    const price = c?.price ?? null;
    return { symbol: h.symbol, amount: h.amount, avgBuy: h.avgBuy, price, value: price ? price * h.amount : 0, pnlPct: price && h.avgBuy ? (price / h.avgBuy - 1) * 100 : null };
  });
}

// Context for the rule-based analyst (shape it expects)
export function analystContext(a, portfolio) {
  const mtfShort = Object.fromEntries(Object.entries(a.mtf).map(([iv, s]) => [iv, s?.ok ? { score: s.score, text: s.text } : null]));
  return {
    coin: { name: a.coin.name, symbol: a.coin.symbol, price: a.signal.price ?? a.coin.price, change24h: a.coin.change24h },
    interval: a.interval,
    signal: a.signal,
    mtf: mtfShort,
    confluence: a.confluence,
    backtest: a.backtest,
    forecast: summarizeForecast(a.forecast),
    timing: summarizeTiming(a.timing),
    timingSentence: a.timing?.ok && a.timing.shaped
      ? timingText(a.timing, (bars) => horizonText(a.interval, bars), (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 }))
      : null,
    news: (a.news || []).slice(0, 5).map((n) => ({ title: n.title, source: n.source, at: n.published_at })),
    history: a.history?.ok ? { ...a.history.summary, verdictText: a.history.verdict.text, seasonMonth: a.history.season?.current || null } : null,
    horizonText: a.horizonText,
    fearGreed: a.fearGreed,
    portfolio,
  };
}

// Compact JSON for the LLM
export function llmData(a) {
  const s = a.signal;
  return {
    coin: `${a.coin.name} (${a.coin.symbol})`,
    price: s.price, change24hPct: a.coin.change24h !== null && a.coin.change24h !== undefined ? +a.coin.change24h.toFixed(2) : null,
    chart: a.interval,
    signal: s.ok ? { verdict: s.text, score: s.score, plan: s.plan && { side: s.plan.side, entryZone: s.plan.entryZone, stopLoss: s.plan.stopLoss, takeProfits: s.plan.takeProfits }, supports: s.levels.supports, resistances: s.levels.resistances, rsi: s.indicators.rsi && +s.indicators.rsi.toFixed(1) } : null,
    timeframes: Object.fromEntries(Object.entries(a.mtf).map(([iv, x]) => [iv, x?.ok ? x.text : null])),
    aiForecast: summarizeForecast(a.forecast) && { horizon: a.horizonText, ...summarizeForecast(a.forecast) },
    moveTiming: summarizeTiming(a.timing),
    recentHeadlines: (a.news || []).slice(0, 5).map((n) => `${n.source}: ${n.title}`),
    multiYearHistory: a.history?.ok ? a.history.summary : null,
    fearGreed: a.fearGreed && `${a.fearGreed.value} (${a.fearGreed.classification})`,
  };
}

export async function detectSymbol(text) {
  const list = await markets().catch(() => []);
  const words = String(text).replace(/[^A-Za-z0-9$ ]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    const t = w.replace(/^\$/, '').toUpperCase();
    if (t.length < 2 || ['I', 'A', 'AN', 'IS', 'IT', 'TO', 'OR', 'ON', 'AT', 'BE', 'MY', 'ME', 'DO', 'SO', 'UP', 'IN', 'OF', 'THE', 'AND', 'FOR', 'NOW', 'BUY', 'SELL', 'CAN', 'WILL', 'GO', 'NEXT', 'HOW', 'WHAT', 'WHEN', 'SHOULD', 'ONE', 'ANY', 'ALL', 'NEW', 'OUT', 'GET', 'PUT', 'TOP'].includes(t)) continue;
    const bySym = list.find((c) => c.symbol === t && c.binance);
    if (bySym) return bySym.symbol;
  }
  const lower = String(text).toLowerCase();
  const byName = list.filter((c) => c.name.length > 3).find((c) => lower.includes(c.name.toLowerCase()));
  return byName?.symbol || null;
}
