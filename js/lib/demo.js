// Synthetic market data used when DEMO_MODE=1 or when upstream APIs are
// unreachable (and DEMO_FALLBACK is not disabled). Prices follow a
// deterministic function of time, so every endpoint and timeframe agrees and
// the chart keeps moving. All responses carrying this data are flagged `demo: true`.

const COINS = [
  ['bitcoin', 'BTC', 'Bitcoin', 62000, 19.7e6],
  ['ethereum', 'ETH', 'Ethereum', 3100, 120.2e6],
  ['tether', 'USDT', 'Tether', 1, 118e9, true],
  ['binancecoin', 'BNB', 'BNB', 560, 146e6],
  ['solana', 'SOL', 'Solana', 145, 470e6],
  ['usd-coin', 'USDC', 'USDC', 1, 36e9, true],
  ['ripple', 'XRP', 'XRP', 0.58, 56e9],
  ['dogecoin', 'DOGE', 'Dogecoin', 0.125, 146e9],
  ['cardano', 'ADA', 'Cardano', 0.45, 35.6e9],
  ['tron', 'TRX', 'TRON', 0.13, 87e9],
  ['avalanche-2', 'AVAX', 'Avalanche', 28, 406e6],
  ['shiba-inu', 'SHIB', 'Shiba Inu', 0.0000185, 589e12],
  ['chainlink', 'LINK', 'Chainlink', 13.5, 608e6],
  ['polkadot', 'DOT', 'Polkadot', 5.9, 1.45e9],
  ['bitcoin-cash', 'BCH', 'Bitcoin Cash', 380, 19.7e6],
  ['near', 'NEAR', 'NEAR Protocol', 5.1, 1.1e9],
  ['litecoin', 'LTC', 'Litecoin', 72, 75e6],
  ['uniswap', 'UNI', 'Uniswap', 8.2, 600e6],
  ['aptos', 'APT', 'Aptos', 8.8, 480e6],
  ['internet-computer', 'ICP', 'Internet Computer', 9.1, 468e6],
  ['stellar', 'XLM', 'Stellar', 0.1, 29e9],
  ['cosmos', 'ATOM', 'Cosmos Hub', 6.6, 390e6],
  ['filecoin', 'FIL', 'Filecoin', 4.2, 590e6],
  ['arbitrum', 'ARB', 'Arbitrum', 0.75, 3.3e9],
  ['optimism', 'OP', 'Optimism', 1.7, 1.2e9],
  ['injective-protocol', 'INJ', 'Injective', 21, 97e6],
  ['render-token', 'RENDER', 'Render', 6.4, 388e6],
  ['sui', 'SUI', 'Sui', 1.05, 2.7e9],
  ['pepe', 'PEPE', 'Pepe', 0.0000092, 420e12],
  ['the-graph', 'GRT', 'The Graph', 0.19, 9.5e9],
  ['aave', 'AAVE', 'Aave', 115, 14.8e6],
  ['algorand', 'ALGO', 'Algorand', 0.16, 8.2e9],
  ['fantom', 'FTM', 'Fantom', 0.55, 2.8e9],
  ['hedera-hashgraph', 'HBAR', 'Hedera', 0.07, 35e9],
  ['vechain', 'VET', 'VeChain', 0.026, 81e9],
  ['maker', 'MKR', 'Maker', 1900, 0.9e6],
  ['the-sandbox', 'SAND', 'The Sandbox', 0.32, 2.3e9],
  ['decentraland', 'MANA', 'Decentraland', 0.34, 1.9e9],
  ['axie-infinity', 'AXS', 'Axie Infinity', 5.4, 150e6],
  ['floki', 'FLOKI', 'FLOKI', 0.00014, 9.5e12],
];

export const DEMO_EXCHANGES = ['Binance', 'Coinbase', 'Kraken', 'OKX', 'Bybit', 'KuCoin', 'Gate.io'];

function hash(n) {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function seedOf(str) { let h = 2166136261; for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h; }

// Smooth value noise in [-1, 1]
function noise(x, seed) {
  const i = Math.floor(x), f = x - i;
  const a = hash(i * 374761393 + seed) * 2 - 1;
  const b = hash((i + 1) * 374761393 + seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

// Deterministic standard normal from two hashes
function gauss(n, seed) {
  const u1 = Math.max(hash(n * 2654435761 + seed), 1e-12);
  const u2 = hash(n * 40503 + seed * 7 + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const ORIGIN = Date.UTC(2015, 0, 1);
const REF = Date.UTC(2026, 0, 1);
const DAY = 864e5;
const walks = new Map(); // id -> Float64Array of daily log-price walk

// Daily random walk with slowly changing drift, so the demo market trends and ranges like a real one.
function dailyWalk(id, upto) {
  let w = walks.get(id);
  if (w && w.length > upto + 1) return w;
  const len = upto + 400;
  const seed = seedOf(id);
  const vol = id === 'bitcoin' ? 0.028 : 0.04;
  const arr = new Float64Array(len);
  let drift = 0;
  const btc = id === 'bitcoin' ? null : dailyWalk('bitcoin', len);
  for (let d = 1; d < len; d++) {
    drift = 0.985 * drift + 0.015 * gauss(d, seed + 99) * 0.012;
    const own = drift + vol * gauss(d, seed);
    arr[d] = arr[d - 1] + (btc ? 0.75 * (btc[d] - btc[d - 1]) * 1.2 + 0.6 * own : own);
  }
  walks.set(id, arr);
  return arr;
}

function bridge(a, b, steps, pos, seed, sigma) {
  // Brownian bridge between a and b with `steps` sub-steps, evaluated at fractional position pos∈[0,steps]
  const j = Math.floor(pos), f = pos - j;
  let sj = 0, sj1 = 0, total = 0;
  for (let k = 1; k <= steps; k++) {
    const z = gauss(k, seed) * sigma;
    total += z;
    if (k <= j) sj += z;
    if (k <= j + 1) sj1 += z;
  }
  const at = (idx, cum) => a + (b - a) * (idx / steps) + (cum - (total * idx) / steps);
  const v0 = at(j, sj);
  const v1 = j + 1 <= steps ? at(j + 1, sj1) : v0;
  return v0 + (v1 - v0) * f;
}

export function demoPrice(id, t) {
  const coin = COINS.find((c) => c[0] === id);
  if (!coin) return null;
  if (coin[5]) return 1 + noise(t / 36e5, seedOf(id)) * 0.0008;
  const seed = seedOf(id);
  const x = Math.max(0, (t - ORIGIN) / DAY);
  const d = Math.floor(x);
  const refDay = Math.floor((REF - ORIGIN) / DAY);
  const w = dailyWalk(id, Math.max(d + 2, refDay + 2));
  const vol = id === 'bitcoin' ? 0.028 : 0.04;
  // within the day: hourly bridge; within the hour: 5-minute bridge
  const hourPos = (x - d) * 24;
  const hA = bridge(w[d], w[d + 1], 24, Math.floor(hourPos), seed + d * 31, vol / Math.sqrt(24));
  const hB = bridge(w[d], w[d + 1], 24, Math.min(24, Math.floor(hourPos) + 1), seed + d * 31, vol / Math.sqrt(24));
  const mPos = (hourPos - Math.floor(hourPos)) * 12;
  const hourIdx = d * 24 + Math.floor(hourPos);
  const lg = bridge(hA, hB, 12, mPos, seed + hourIdx * 17, vol / Math.sqrt(288));
  return coin[3] * Math.exp(lg - w[refDay] - (id === 'bitcoin' ? 0 : 0));
}

const INTERVAL_MS = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5, '1d': 864e5, '3d': 2592e5, '1w': 6048e5 };

export function demoCandles(id, interval = '1h', limit = 500, endTime = Date.now()) {
  const step = INTERVAL_MS[interval] || 36e5;
  const lastOpen = Math.floor(endTime / step) * step;
  const out = [];
  const coin = COINS.find((c) => c[0] === id);
  const baseVol = coin ? coin[3] * (coin[4] / 4000) : 1e6;
  for (let k = limit - 1; k >= 0; k--) {
    const t0 = lastOpen - k * step;
    const t1 = Math.min(t0 + step, endTime);
    const samples = 10;
    let h = -Infinity, l = Infinity;
    const o = demoPrice(id, t0);
    for (let s = 0; s <= samples; s++) {
      const p = demoPrice(id, t0 + ((t1 - t0) * s) / samples);
      h = Math.max(h, p); l = Math.min(l, p);
    }
    const c = demoPrice(id, t1);
    const wig = 1 + hash(t0 / step + seedOf(id)) * 0.002;
    const vol = (baseVol * (step / 36e5) * (0.5 + hash(t0 / step * 13 + seedOf(id)) + Math.abs(c - o) / o * 60)) / (coin ? coin[3] : 1);
    out.push({ t: t0, o, h: h * wig, l: l / wig, c, v: vol });
  }
  return out;
}

export function demoSymbolToId(symbol) {
  const base = symbol.replace(/USDT$/, '');
  return COINS.find((c) => c[1] === base)?.[0] || null;
}

export function demoMarkets(now = Date.now()) {
  return COINS.map((c, idx) => {
    const [id, sym, name, , supply] = c;
    const price = demoPrice(id, now);
    const ago = (ms) => demoPrice(id, now - ms);
    const spark = [];
    for (let h = 167; h >= 0; h--) spark.push(demoPrice(id, now - h * 36e5));
    const mcap = price * supply;
    return {
      id, symbol: sym.toLowerCase(), name, image: null, rank: idx + 1,
      price, marketCap: mcap, volume24h: mcap * (0.02 + hash(idx * 31) * 0.08),
      change1h: (price / ago(36e5) - 1) * 100,
      change24h: (price / ago(864e5) - 1) * 100,
      change7d: (price / ago(7 * 864e5) - 1) * 100,
      high24h: price * 1.02, low24h: price * 0.98,
      circulatingSupply: supply, sparkline: spark, ath: price * 1.6,
    };
  }).sort((a, b) => b.marketCap - a.marketCap).map((m, i) => ({ ...m, rank: i + 1 }));
}

export function demoGlobal() {
  const m = demoMarkets();
  const total = m.reduce((s, c) => s + c.marketCap, 0) * 1.12;
  const btc = m.find((c) => c.id === 'bitcoin');
  const eth = m.find((c) => c.id === 'ethereum');
  return {
    totalMarketCap: total,
    totalVolume: m.reduce((s, c) => s + c.volume24h, 0) * 1.3,
    btcDominance: (btc.marketCap / total) * 100,
    ethDominance: (eth.marketCap / total) * 100,
    marketCapChange24h: m.slice(0, 10).reduce((s, c) => s + c.change24h, 0) / 10,
    activeCryptocurrencies: 14000,
    markets: 1100,
  };
}

export function demoFearGreed() {
  const now = Date.now();
  const data = [];
  for (let d = 0; d < 30; d++) {
    const v = Math.round(50 + noise((now - d * 864e5) / (6 * 864e5), 42) * 40);
    data.push({ value: v, classification: classifyFng(v), timestamp: Math.floor((now - d * 864e5) / 1000) });
  }
  return data;
}

export function classifyFng(v) {
  return v <= 24 ? 'Extreme Fear' : v <= 44 ? 'Fear' : v <= 55 ? 'Neutral' : v <= 75 ? 'Greed' : 'Extreme Greed';
}

export function demoCoinDetail(id) {
  const m = demoMarkets().find((c) => c.id === id);
  if (!m) return null;
  return {
    ...m,
    description: `${m.name} — demo profile. Connect the app to the internet to load the live description, links and supply data.`,
    homepage: null, genesisDate: null, categories: ['Demo'],
    totalSupply: m.circulatingSupply, maxSupply: null, fdv: m.marketCap,
    atl: m.price * 0.1, athDate: null, links: {},
  };
}

export function demoExchangeQuotes(base) {
  const id = COINS.find((c) => c[1] === base.toUpperCase())?.[0];
  if (!id) return [];
  const now = Date.now();
  const p = demoPrice(id, now);
  return DEMO_EXCHANGES.map((ex, i) => {
    const drift = (hash(Math.floor(now / 5000) + i * 97) - 0.5) * 0.0024;
    const price = p * (1 + drift);
    const spread = price * (0.0001 + hash(i * 11) * 0.0004);
    return { exchange: ex, pair: `${base}/USDT`, price, bid: price - spread / 2, ask: price + spread / 2, volume24hUsd: p * 1e3 * (8 - i) * 1e3 * (1 + hash(i)), ok: true };
  });
}

export function demoSearch(q) {
  const s = q.toLowerCase();
  return COINS.filter((c) => c[0].includes(s) || c[1].toLowerCase().includes(s) || c[2].toLowerCase().includes(s))
    .slice(0, 10).map((c) => ({ id: c[0], symbol: c[1], name: c[2], thumb: null, rank: COINS.indexOf(c) + 1 }));
}

export function demoTrending() {
  return demoMarkets().filter((c) => !['tether', 'usd-coin'].includes(c.id)).sort((a, b) => b.change24h - a.change24h).slice(0, 7)
    .map((c) => ({ id: c.id, symbol: c.symbol.toUpperCase(), name: c.name, thumb: null, rank: c.rank, price: c.price, change24h: c.change24h }));
}

export const DEMO_USDT_SYMBOLS = COINS.filter((c) => !c[5]).map((c) => `${c[1]}USDT`);
export const DEMO_IDS = COINS.map((c) => c[0]);
