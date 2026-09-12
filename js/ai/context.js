// Gathers everything the assistant needs about a coin: live candles, signals on
// several timeframes, the AI forecast, backtest, sentiment and the user's holdings.
import { markets, findCoin, getCandles, getFearGreed } from '../api/market.js';
import { generateSignal, confluence, backtest } from '../lib/signals.js';
import { summarizeForecast } from '../lib/predict.js';
import { runForecast, runHistory } from '../lib/compute.js';
import { horizonText } from '../format.js';
import { load } from '../store.js';

const cache = new Map();
export const DEFAULT_HORIZON = { '15m': 8, '1h': 12, '4h': 6, '1d': 7 };

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
  const fng = await getFearGreed().catch(() => null);
  const result = {
    coin, interval, candles: main.candles, source: main.source, signal, mtf, confluence: conf, backtest: bt,
    forecast, history, horizon, horizonText: horizonText(interval, horizon), fearGreed: fng?.[0] || null, at: Date.now(),
  };
  cache.set(key, result);
  return result;
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
