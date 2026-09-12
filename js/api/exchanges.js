// Same coin, 10 exchanges: live price, bid/ask spread, volume, and the best
// place to buy / sell. All endpoints are public and allow browser requests.
import { CONFIG } from '../config.js';
import { getJson, getJsonAny } from './http.js';
import { demoExchangeQuotes } from '../lib/demo.js';

const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const KRAKEN = { BTC: 'XBT', DOGE: 'XDG' };
const T = { ttl: 8000, timeout: 7000 };

const EXCHANGES = [
  ['Binance', async (b) => {
    const r = await getJsonAny(CONFIG.BINANCE_REST, `/api/v3/ticker/24hr?symbol=${b}USDT`, { ...T, key: `ex:bn:${b}` });
    return { pair: `${b}/USDT`, price: n(r.lastPrice), bid: n(r.bidPrice), ask: n(r.askPrice), vol: n(r.quoteVolume), change24h: n(r.priceChangePercent) };
  }],
  ['Coinbase', async (b) => {
    const [t, s] = await Promise.all([
      getJson(`https://api.exchange.coinbase.com/products/${b}-USD/ticker`, T),
      getJson(`https://api.exchange.coinbase.com/products/${b}-USD/stats`, T).catch(() => null),
    ]);
    const price = n(t.price);
    return { pair: `${b}/USD`, price, bid: n(t.bid), ask: n(t.ask), vol: n(t.volume) * price, change24h: s?.open ? (price / n(s.open) - 1) * 100 : null };
  }],
  ['Kraken', async (b) => {
    const r = await getJson(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN[b] || b}USD`, T);
    const d = r.result && Object.values(r.result)[0];
    if (!d) throw new Error('not listed');
    const price = n(d.c[0]);
    return { pair: `${b}/USD`, price, bid: n(d.b[0]), ask: n(d.a[0]), vol: n(d.v[1]) * price, change24h: n(d.o) ? (price / n(d.o) - 1) * 100 : null };
  }],
  ['OKX', async (b) => {
    const r = await getJson(`https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`, T);
    const d = r.data?.[0];
    if (!d) throw new Error('not listed');
    const price = n(d.last);
    return { pair: `${b}/USDT`, price, bid: n(d.bidPx), ask: n(d.askPx), vol: n(d.volCcy24h), change24h: n(d.open24h) ? (price / n(d.open24h) - 1) * 100 : null };
  }],
  ['Bybit', async (b) => {
    const r = await getJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${b}USDT`, T);
    const d = r.result?.list?.[0];
    if (!d) throw new Error('not listed');
    return { pair: `${b}/USDT`, price: n(d.lastPrice), bid: n(d.bid1Price), ask: n(d.ask1Price), vol: n(d.turnover24h), change24h: n(d.price24hPcnt) * 100 };
  }],
  ['Gate.io', async (b) => {
    const r = await getJson(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${b}_USDT`, T);
    const d = Array.isArray(r) ? r[0] : null;
    if (!d) throw new Error('not listed');
    return { pair: `${b}/USDT`, price: n(d.last), bid: n(d.highest_bid), ask: n(d.lowest_ask), vol: n(d.quote_volume), change24h: n(d.change_percentage) };
  }],
  ['Bitget', async (b) => {
    const r = await getJson(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${b}USDT`, T);
    const d = r.data?.[0];
    if (!d) throw new Error('not listed');
    return { pair: `${b}/USDT`, price: n(d.lastPr), bid: n(d.bidPr), ask: n(d.askPr), vol: n(d.quoteVolume), change24h: n(d.change24h) * 100 };
  }],
  ['HTX', async (b) => {
    const r = await getJson(`https://api.huobi.pro/market/detail/merged?symbol=${b.toLowerCase()}usdt`, T);
    const d = r.tick;
    if (!d) throw new Error('not listed');
    return { pair: `${b}/USDT`, price: n(d.close), bid: n(d.bid?.[0]), ask: n(d.ask?.[0]), vol: n(d.vol), change24h: n(d.open) ? (n(d.close) / n(d.open) - 1) * 100 : null };
  }],
  ['Gemini', async (b) => {
    const r = await getJson(`https://api.gemini.com/v1/pubticker/${b.toLowerCase()}usd`, T);
    if (!r.last) throw new Error('not listed');
    return { pair: `${b}/USD`, price: n(r.last), bid: n(r.bid), ask: n(r.ask), vol: n(r.volume?.USD), change24h: null };
  }],
  ['Crypto.com', async (b) => {
    const r = await getJson(`https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${b}_USDT`, T);
    const d = r.result?.data?.[0];
    if (!d) throw new Error('not listed');
    return { pair: `${b}/USDT`, price: n(d.a), bid: n(d.b), ask: n(d.k), vol: n(d.vv), change24h: n(d.c) * 100 };
  }],
];

export const EXCHANGE_NAMES = EXCHANGES.map(([name]) => name);

export async function compareExchanges(base) {
  const b = base.toUpperCase();
  const rows = await Promise.all(EXCHANGES.map(async ([exchange, fn]) => {
    try {
      const q = await fn(b);
      if (!q.price) throw new Error('no price');
      return { exchange, ok: true, ...q };
    } catch (e) {
      return { exchange, ok: false, error: e.message || 'unavailable' };
    }
  }));
  let demo = false;
  let list = rows;
  if (!rows.some((r) => r.ok)) {
    const d = demoExchangeQuotes(b);
    if (d.length) { demo = true; list = d.map((q) => ({ ...q, vol: q.volume24hUsd })); }
  }
  return { demo, ...summarize(list) };
}

function summarize(quotes) {
  const ok = quotes.filter((q) => q.ok && q.price);
  const prices = ok.map((q) => q.price).sort((a, b) => a - b);
  const mid = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) : null;
  const rows = quotes.map((q) => (q.ok ? {
    ...q,
    spreadPct: q.bid && q.ask ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 : null,
    deviationPct: mid ? (q.price / mid - 1) * 100 : null,
  } : q));
  const bestBuy = [...ok].filter((q) => q.ask).sort((a, b) => a.ask - b.ask)[0] || null;
  const bestSell = [...ok].filter((q) => q.bid).sort((a, b) => b.bid - a.bid)[0] || null;
  const gap = bestBuy && bestSell && bestBuy.exchange !== bestSell.exchange ? ((bestSell.bid - bestBuy.ask) / bestBuy.ask) * 100 : null;
  return { rows, median: mid, bestBuy, bestSell, gapPct: gap, okCount: ok.length };
}
