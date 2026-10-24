// Candles for any coin the site trades, read on the server from the exchange
// the browser reads it from (js/api/market.js): Binance, or Gate.io, HTX or OKX
// for a coin Binance does not list (tools/universe.json names which). A coin
// with a short Binance history (a recent listing, like HYPE) takes the
// exchange with the longer one, as the browser does.
import { fetchJson, binance } from './lib.ts';
import { COIN_VENUE } from './coins.js';

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// Every chart the trader offers (js/lib/autotrader.js TRADER_CHARTS). The cloud
// trader knew only six, so an account on 30m, 2h, 6h, 12h or 1w was never checked.
export const STEP_MS: Record<string, number> = {
  '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '2h': 72e5, '4h': 144e5, '6h': 216e5, '12h': 432e5, '1d': 864e5, '1w': 6048e5,
};
const BAR: Record<string, Record<string, string>> = {
  gate: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '7d' },
  htx: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour', '1d': '1day', '1w': '1week' },
  okx: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc' },
};
// A chart an exchange does not publish (Gate.io and HTX have no 2h, 6h or 12h)
// is built from its 1h candles on Binance's UTC boundaries, as the browser does
// (js/api/market.js EX_AGG).
const AGG: Record<string, { base: string; n: number }> = { '2h': { base: '1h', n: 2 }, '6h': { base: '1h', n: 6 }, '12h': { base: '1h', n: 12 } };
export function aggregateCandles(rows: Candle[], step: number): Candle[] {
  const out: (Candle & { first: number })[] = [];
  for (const r of rows) {
    const t = Math.floor(r.t / step) * step;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, r.h);
      last.l = Math.min(last.l, r.l);
      last.c = r.c;
      last.v += r.v;
    } else out.push({ t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, first: r.t });
  }
  return out.filter((b) => b.first === b.t).map(({ first: _first, ...b }) => b);
}
const viaHour = (fetch: (sym: string, iv: string, total: number) => Promise<Candle[]>, venue: string) =>
  async (sym: string, iv: string, total: number): Promise<Candle[]> => {
    const agg = !BAR[venue][iv] && AGG[iv];
    return agg ? aggregateCandles(await fetch(sym, agg.base, total * agg.n + agg.n), STEP_MS[iv]) : fetch(sym, iv, total);
  };
// what the browser asks Binance for before it looks elsewhere (market.js MIN_HISTORY)
const MIN_HISTORY = 260;

async function fromBinance(sym: string, iv: string, total: number): Promise<Candle[]> {
  const map = (rows: unknown[][]) => rows.map((k) => ({ t: k[0] as number, o: +(k[1] as string), h: +(k[2] as string), l: +(k[3] as string), c: +(k[4] as string), v: +(k[5] as string) }));
  const pair = `${encodeURIComponent(sym)}USDT`;
  let out = map(await binance(`/api/v3/klines?symbol=${pair}&interval=${iv}&limit=${Math.min(1000, total)}`) as unknown[][]);
  // older pages, 1,000 at a time
  while (out.length && out.length < total) {
    const rows = map(await binance(`/api/v3/klines?symbol=${pair}&interval=${iv}&limit=${Math.min(1000, total - out.length)}&endTime=${out[0].t - 1}`) as unknown[][]);
    if (!rows.length) break;
    out = rows.concat(out);
  }
  return out;
}

async function fromGate(sym: string, iv: string, total: number): Promise<Candle[]> {
  const base = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${sym}_USDT&interval=${BAR.gate[iv]}`;
  const map = (rows: string[][]) => rows.map((r) => ({ t: +r[0] * 1e3, o: +r[5], h: +r[3], l: +r[4], c: +r[2], v: +r[6] }));
  let out = map(await fetchJson(`${base}&limit=${Math.min(1000, total)}`));
  // Gate refuses `limit` together with a time window: older pages ask for a from/to range
  while (out.length && out.length < total) {
    const to = out[0].t / 1e3 - 1, n = Math.min(1000, total - out.length);
    const rows = map(await fetchJson(`${base}&from=${Math.floor(to - (n - 1) * STEP_MS[iv] / 1e3)}&to=${Math.floor(to)}`));
    if (!rows.length) break;
    out = rows.concat(out);
  }
  return out;
}

async function fromHtx(sym: string, iv: string, total: number): Promise<Candle[]> {
  const j = await fetchJson(`https://api.huobi.pro/market/history/kline?symbol=${sym.toLowerCase()}usdt&period=${BAR.htx[iv]}&size=${Math.min(2000, total)}`);
  if (j?.status !== 'ok' || !Array.isArray(j.data)) return [];
  return j.data.map((r: Record<string, number>) => ({ t: r.id * 1e3, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.amount })).reverse();
}

async function fromOkx(sym: string, iv: string, total: number): Promise<Candle[]> {
  const inst = `${sym}-USDT`;
  const map = (j: { data?: string[][] }) => (Array.isArray(j?.data) ? j.data : []).map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).reverse();
  let out = map(await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${BAR.okx[iv]}&limit=300`));
  for (let i = 0; out.length && out.length < Math.min(total, 1000) && i < 8; i++) {
    const rows = map(await fetchJson(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${BAR.okx[iv]}&after=${out[0].t}&limit=100`));
    if (!rows.length) break;
    out = rows.concat(out);
  }
  return out;
}

const FETCH: Record<string, (sym: string, iv: string, total: number) => Promise<Candle[]>> = { binance: fromBinance, gate: viaHour(fromGate, 'gate'), htx: viaHour(fromHtx, 'htx'), okx: fromOkx };
const usable = (c: Candle) => [c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x) && x > 0);

/**
 * The last `total` candles of a coin, oldest first (the newest may still be
 * forming), and the exchange they came from; null when no exchange has recent ones.
 */
export async function candlesFor(symbol: string, interval: string, total = 500): Promise<{ candles: Candle[]; venue: string } | null> {
  const step = STEP_MS[interval];
  if (!step) return null;
  const known = COIN_VENUE[symbol as keyof typeof COIN_VENUE] as string | undefined;
  // A coin not on the list is read from Binance only: without the coin's market
  // price to compare (the browser checks it), another exchange's token with the
  // same ticker could be taken for it.
  const order = known ? [known, ...['binance', 'gate', 'htx', 'okx'].filter((v) => v !== known)] : ['binance'];
  let best: { candles: Candle[]; venue: string } | null = null;
  for (const venue of order) {
    try {
      const rows = (await FETCH[venue](symbol, interval, total)).filter(usable);
      if (!rows.length || Date.now() - rows[rows.length - 1].t > step * 3 + 2 * 864e5) continue;
      if (!best || rows.length > best.candles.length) best = { candles: rows.slice(-total), venue };
      // enough history: the first exchange that has it is the one the browser uses
      if (best.candles.length >= Math.min(total, MIN_HISTORY)) return best;
    } catch { /* the next exchange */ }
    // a coin the list places on one exchange is not looked for on others unless its history is short
    if (known && venue === known && !best) break;
  }
  return best;
}
