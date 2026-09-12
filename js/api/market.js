// Market data layer. Live sources first (CoinGecko → CoinPaprika, Binance),
// clearly-flagged demo data only if every live source is unreachable.
import { CONFIG } from '../config.js';
import { getJson, getJsonAny, peek, postJson, HttpError } from './http.js';
import * as demo from '../lib/demo.js';
import { syncClock, now } from './clock.js';

// ------------------------------------------------------------ status
export const dataStatus = new EventTarget();
dataStatus.demo = false;
function markDemo(reason) {
  if (!dataStatus.demo) {
    dataStatus.demo = true;
    dataStatus.dispatchEvent(new CustomEvent('change', { detail: { demo: true, reason } }));
  }
}
function markLive() {
  if (dataStatus.demo) {
    dataStatus.demo = false;
    dataStatus.dispatchEvent(new CustomEvent('change', { detail: { demo: false } }));
  }
}
const stale = async (p) => { try { return await p; } catch (e) { if (e.staleValue !== undefined) return e.staleValue; throw e; } };
const STABLE = new Set(CONFIG.STABLECOINS);
export const isStable = (sym) => STABLE.has(String(sym).toLowerCase());

// ------------------------------------------------------------ Binance symbols
let symbolSetPromise = null;
export function binanceSymbols() {
  if (!symbolSetPromise) {
    symbolSetPromise = (async () => {
      try {
        const rows = await getJsonAny(CONFIG.BINANCE_REST, '/api/v3/ticker/price', { ttl: 10 * 60e3, persist: true, key: 'bn:prices' });
        return new Set(rows.map((r) => r.symbol).filter((s) => s.endsWith('USDT')));
      } catch {
        return new Set(demo.DEMO_USDT_SYMBOLS);
      }
    })();
  }
  return symbolSetPromise;
}

// ------------------------------------------------------------ markets
function fromGecko(r) {
  return {
    id: r.id, symbol: r.symbol.toUpperCase(), name: r.name, image: r.image, rank: r.market_cap_rank,
    price: r.current_price, marketCap: r.market_cap, volume24h: r.total_volume,
    change1h: r.price_change_percentage_1h_in_currency, change24h: r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h,
    change7d: r.price_change_percentage_7d_in_currency, high24h: r.high_24h, low24h: r.low_24h,
    circulatingSupply: r.circulating_supply, ath: r.ath, sparkline: r.sparkline_in_7d?.price || [], source: 'coingecko',
  };
}
function fromPaprika(r) {
  const q = r.quotes?.USD || {};
  return {
    id: r.id, symbol: r.symbol.toUpperCase(), name: r.name, image: `https://static.coinpaprika.com/coin/${r.id}/logo.png`, rank: r.rank,
    price: q.price, marketCap: q.market_cap, volume24h: q.volume_24h, change1h: q.percent_change_1h, change24h: q.percent_change_24h,
    change7d: q.percent_change_7d, high24h: null, low24h: null, circulatingSupply: r.circulating_supply, ath: q.ath_price, sparkline: [], source: 'paprika',
  };
}

export function cachedMarkets() {
  const g = peek('cg:markets');
  return g ? g.map(fromGecko) : null;
}

export async function getMarkets() {
  let rows;
  try {
    const raw = await stale(getJson(`${CONFIG.COINGECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h,24h,7d`, { ttl: 60e3, persist: true, key: 'cg:markets' }));
    rows = raw.map(fromGecko);
    markLive();
  } catch {
    try {
      const raw = await stale(getJson(`${CONFIG.PAPRIKA}/tickers?limit=250`, { ttl: 60e3, persist: true, key: 'pp:tickers' }));
      rows = raw.map(fromPaprika);
      markLive();
    } catch {
      markDemo('markets');
      rows = demo.demoMarkets().map((m) => ({ ...m, symbol: m.symbol.toUpperCase(), source: 'demo' }));
    }
  }
  const set = await binanceSymbols();
  const seen = new Set();
  return rows.filter((r) => r.price !== null && r.price !== undefined).map((r) => {
    const pair = `${r.symbol}USDT`;
    const binance = !isStable(r.symbol) && set.has(pair) && !seen.has(pair) ? pair : null;
    if (binance) seen.add(pair);
    return { ...r, binance };
  });
}

let marketsCache = { at: 0, promise: null };
export function markets() {
  if (!marketsCache.promise || Date.now() - marketsCache.at > 60e3) {
    marketsCache = { at: Date.now(), promise: getMarkets().catch((e) => { marketsCache.at = 0; throw e; }) };
  }
  return marketsCache.promise;
}

export async function findCoin(symbolOrId) {
  const list = await markets();
  const s = String(symbolOrId).toUpperCase();
  return list.find((c) => c.symbol === s) || list.find((c) => c.id === symbolOrId) || null;
}

export async function getGlobal() {
  try {
    const { data } = await stale(getJson(`${CONFIG.COINGECKO}/global`, { ttl: 120e3, persist: true, key: 'cg:global' }));
    return {
      totalMarketCap: data.total_market_cap?.usd, totalVolume: data.total_volume?.usd,
      btcDominance: data.market_cap_percentage?.btc, ethDominance: data.market_cap_percentage?.eth,
      marketCapChange24h: data.market_cap_change_percentage_24h_usd, activeCryptocurrencies: data.active_cryptocurrencies, markets: data.markets,
    };
  } catch {
    try {
      const g = await stale(getJson(`${CONFIG.PAPRIKA}/global`, { ttl: 120e3, persist: true, key: 'pp:global' }));
      return { totalMarketCap: g.market_cap_usd, totalVolume: g.volume_24h_usd, btcDominance: g.bitcoin_dominance_percentage, ethDominance: null, marketCapChange24h: g.market_cap_change_24h, activeCryptocurrencies: g.cryptocurrencies_number, markets: null };
    } catch {
      markDemo('global');
      return demo.demoGlobal();
    }
  }
}

export async function getFearGreed() {
  try {
    const r = await stale(getJson(`${CONFIG.FEAR_GREED}?limit=30`, { ttl: 30 * 60e3, persist: true, key: 'fng' }));
    return r.data.map((d) => ({ value: +d.value, classification: d.value_classification, timestamp: +d.timestamp }));
  } catch {
    return demo.demoFearGreed();
  }
}

export async function getTrending() {
  try {
    const { coins } = await stale(getJson(`${CONFIG.COINGECKO}/search/trending`, { ttl: 10 * 60e3, persist: true, key: 'cg:trending' }));
    return coins.slice(0, 8).map(({ item }) => ({
      id: item.id, symbol: item.symbol.toUpperCase(), name: item.name, image: item.small || item.thumb, rank: item.market_cap_rank,
      price: item.data?.price ?? null, change24h: item.data?.price_change_percentage_24h?.usd ?? null,
    }));
  } catch {
    return demo.demoTrending().map((t) => ({ ...t, image: null }));
  }
}

export async function getCoinProfile(coin) {
  if (!coin || coin.source !== 'coingecko') return null;
  try {
    const r = await stale(getJson(`${CONFIG.COINGECKO}/coins/${encodeURIComponent(coin.id)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`, { ttl: 30 * 60e3, persist: true, key: `cg:coin:${coin.id}` }));
    const md = r.market_data || {};
    return {
      description: (r.description?.en || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 1400),
      categories: (r.categories || []).filter(Boolean).slice(0, 6),
      homepage: r.links?.homepage?.find(Boolean) || null,
      explorer: r.links?.blockchain_site?.find(Boolean) || null,
      genesisDate: r.genesis_date, athDate: md.ath_date?.usd, atl: md.atl?.usd,
      change30d: md.price_change_percentage_30d, change1y: md.price_change_percentage_1y,
      totalSupply: md.total_supply, maxSupply: md.max_supply, fdv: md.fully_diluted_valuation?.usd,
    };
  } catch { return null; }
}

export async function searchCoins(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const list = await markets().catch(() => []);
  const local = list.filter((c) => c.symbol.toLowerCase().startsWith(s) || c.name.toLowerCase().includes(s)).slice(0, 8);
  return local;
}

// Keep the app on the exchange's clock, re-checked every 10 minutes.
export async function syncExchangeClock() {
  return syncClock(() => getJsonAny(CONFIG.BINANCE_REST, '/api/v3/time', { ttl: 0 }));
}

// ------------------------------------------------------------ candles
export const INTERVAL_MS = { '1s': 1e3, '5s': 5e3, '10s': 1e4, '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5, '1d': 864e5, '3d': 2592e5, '1w': 6048e5 };

// Binance publishes 1-second candles but nothing between 1s and 1m, so 5s and
// 10s are built here by merging 1s candles into fixed buckets. Anything faster
// than 1s does not exist as a candle anywhere — that is raw trade data.
export const SECOND_INTERVALS = ['1s', '5s', '10s'];
const BUILT_FROM_1S = { '5s': 5, '10s': 10 };
// One request returns 1000 candles, so a second-chart is capped where the wait
// is still short: 1s ≈ 17 min of history, 5s ≈ 1.4 h, 10s ≈ 1.7 h.
export const MAX_BARS = { '1s': 1000, '5s': 1000, '10s': 600 };

export const isSecondInterval = (iv) => SECOND_INTERVALS.includes(iv);

/** Merge candles into buckets of `factor` (e.g. five 1s candles → one 5s candle). */
export function bucketCandles(rows, factor, stepMs) {
  const size = factor * stepMs;
  const out = [];
  for (const r of rows) {
    const t = Math.floor(r.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, r.h);
      last.l = Math.min(last.l, r.l);
      last.c = r.c;
      last.v += r.v;
    } else {
      out.push({ t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
    }
  }
  return out;
}

const mapKlines = (rows) => rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));

// Paginates backwards, 1000 candles per request.
async function fetchKlines(pair, interval, total, ttl) {
  let out = [];
  let endTime = null;
  while (out.length < total) {
    const limit = Math.min(1000, total - out.length);
    const path = `/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
    const rows = mapKlines(await getJsonAny(CONFIG.BINANCE_REST, path, { ttl, key: `bn:${path}` }));
    if (!rows.length) break;
    out = rows.concat(out);
    endTime = rows[0].t - 1;
    if (rows.length < limit) break;
  }
  return out;
}

// Fetch up to `total` candles (paginates backwards, 1000 per request).
export async function getCandles(coin, interval = '1h', total = 500) {
  const pair = typeof coin === 'string' ? coin : coin?.binance;

  // Second-by-second charts: fetch 1s candles and merge them where needed.
  if (isSecondInterval(interval)) {
    const factor = BUILT_FROM_1S[interval] || 1;
    const want = Math.min(total, MAX_BARS[interval] || 600);
    if (!pair) {
      const demoId = (typeof coin === 'object' && coin?.source === 'demo' && coin.id) || demo.demoSymbolToId(`${coin?.symbol}USDT`);
      if (demoId) { markDemo('candles'); return { candles: demo.demoCandles(demoId, interval, want), source: 'demo', pair: null }; }
      throw new HttpError('Second-by-second candles are only available for coins that trade on Binance.', 404);
    }
    try {
      const raw = await fetchKlines(pair, '1s', want * factor, 1200);
      if (raw.length) {
        markLive();
        const candles = factor === 1 ? raw : bucketCandles(raw, factor, 1e3);
        return { candles, source: 'binance', pair, seconds: true };
      }
    } catch { /* fall through to demo */ }
    const demoId = demo.demoSymbolToId(pair);
    if (demoId) { markDemo('candles'); return { candles: demo.demoCandles(demoId, interval, want), source: 'demo', pair }; }
    throw new HttpError('Second-by-second candles are not available for this pair.', 404);
  }

  if (pair) {
    try {
      const ttl = interval.endsWith('m') ? 15e3 : 60e3;
      let out = [];
      let endTime = null;
      while (out.length < total) {
        const limit = Math.min(1000, total - out.length);
        const path = `/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}${endTime ? `&endTime=${endTime}` : ''}`;
        const rows = mapKlines(await getJsonAny(CONFIG.BINANCE_REST, path, { ttl, key: `bn:${path}` }));
        if (!rows.length) break;
        out = rows.concat(out);
        endTime = rows[0].t - 1;
        if (rows.length < limit) break;
      }
      // a pair that stopped trading long ago is treated as unavailable
      if (out.length && now() - out[out.length - 1].t < INTERVAL_MS[interval] * 3 + 2 * 864e5) {
        markLive();
        return { candles: out, source: 'binance', pair };
      }
    } catch { /* fall through */ }
  }
  if (coin && typeof coin === 'object' && coin.source === 'coingecko') {
    try {
      const days = interval.endsWith('m') || interval === '1h' ? 1 : ['2h', '4h', '6h', '12h'].includes(interval) ? 30 : 365;
      const rows = await stale(getJson(`${CONFIG.COINGECKO}/coins/${encodeURIComponent(coin.id)}/ohlc?vs_currency=usd&days=${days}`, { ttl: 5 * 60e3, key: `cg:ohlc:${coin.id}:${days}` }));
      return { candles: rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c, v: 0 })), source: 'coingecko', pair: null, lowRes: true };
    } catch { /* fall through */ }
  }
  const demoId = (typeof coin === 'object' && coin?.source === 'demo' && coin.id) || demo.demoSymbolToId(pair || `${coin?.symbol}USDT`);
  if (demoId) {
    markDemo('candles');
    return { candles: demo.demoCandles(demoId, interval, Math.min(total, 1500)), source: 'demo', pair };
  }
  throw new HttpError('No price history available for this coin', 404);
}

// How many decimals the exchange itself quotes this pair to. Showing fewer is a
// rounded price pretending to be the real one, so the coin page asks for this.
const tickCache = new Map();
export async function getTickSize(pair) {
  if (!pair) return null;
  if (tickCache.has(pair)) return tickCache.get(pair);
  try {
    const r = await getJsonAny(CONFIG.BINANCE_REST, `/api/v3/exchangeInfo?symbol=${pair}`, { ttl: 864e5, key: `bn:info:${pair}` });
    const f = r.symbols?.[0]?.filters?.find((x) => x.filterType === 'PRICE_FILTER');
    const tick = f ? +f.tickSize : null;
    const dp = tick && tick > 0 ? Math.max(0, Math.round(-Math.log10(tick))) : null;
    tickCache.set(pair, dp);
    return dp;
  } catch { tickCache.set(pair, null); return null; }
}

export async function getDepth(pair, limit = 20) {
  try {
    const r = await getJsonAny(CONFIG.BINANCE_REST, `/api/v3/depth?symbol=${pair}&limit=${limit}`, { ttl: 2000 });
    return { bids: r.bids.map(([p, q]) => [+p, +q]), asks: r.asks.map(([p, q]) => [+p, +q]) };
  } catch { return null; }
}

export async function getTrades(pair, limit = 30) {
  try {
    const r = await getJsonAny(CONFIG.BINANCE_REST, `/api/v3/trades?symbol=${pair}&limit=${limit}`, { ttl: 2000 });
    return r.map((t) => ({ id: t.id, price: +t.price, qty: +t.qty, time: t.time, buyerMaker: t.isBuyerMaker })).reverse();
  } catch { return null; }
}

export async function getTickers24h(pairs) {
  if (!pairs.length) return {};
  try {
    const rows = await getJsonAny(CONFIG.BINANCE_REST, `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`, { ttl: 15e3 });
    return Object.fromEntries(rows.map((r) => [r.symbol, { price: +r.lastPrice, change24h: +r.priceChangePercent, quoteVolume: +r.quoteVolume, high: +r.highPrice, low: +r.lowPrice }]));
  } catch { return {}; }
}

// ------------------------------------------------------------ wallets
export const CHAINS = {
  btc: { name: 'Bitcoin', symbol: 'BTC', pattern: /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/ },
  eth: { name: 'Ethereum', symbol: 'ETH', pattern: /^0x[a-fA-F0-9]{40}$/ },
  bsc: { name: 'BNB Smart Chain', symbol: 'BNB', pattern: /^0x[a-fA-F0-9]{40}$/ },
  polygon: { name: 'Polygon', symbol: 'POL', pattern: /^0x[a-fA-F0-9]{40}$/ },
  sol: { name: 'Solana', symbol: 'SOL', pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ },
};

export async function walletBalance(chain, address) {
  const def = CHAINS[chain];
  if (!def) throw new Error('Unsupported chain');
  if (!def.pattern.test(address)) throw new Error(`That is not a valid ${def.name} address`);
  if (chain === 'btc') {
    const r = await getJsonAny(CONFIG.BTC_API, `/address/${address}`, { ttl: 60e3, timeout: 12000 });
    const sats = r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum + r.mempool_stats.funded_txo_sum - r.mempool_stats.spent_txo_sum;
    return { balance: sats / 1e8, symbol: def.symbol, txCount: r.chain_stats.tx_count };
  }
  if (chain === 'sol') {
    const r = await postJson(CONFIG.RPC.sol, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] });
    if (r.error) throw new Error(r.error.message);
    return { balance: r.result.value / 1e9, symbol: def.symbol };
  }
  const r = await postJson(CONFIG.RPC[chain], { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] });
  if (r.error) throw new Error(r.error.message);
  return { balance: Number(BigInt(r.result) / 10n ** 9n) / 1e9, symbol: def.symbol };
}
