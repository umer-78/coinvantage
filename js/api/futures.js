// Derivatives data: funding rate, open interest, long/short ratios and live liquidations.
// Binance USD-M futures first, Bybit as a fallback where Binance futures is blocked.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const F = CONFIG.FUTURES_REST;
const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

export async function futuresSnapshot(symbol) {
  const pair = `${symbol}USDT`;
  try {
    const [premium, oi, oiHist, ls, top, taker, funding] = await Promise.all([
      getJson(`${F}/fapi/v1/premiumIndex?symbol=${pair}`, { ttl: 15e3 }),
      getJson(`${F}/fapi/v1/openInterest?symbol=${pair}`, { ttl: 30e3 }),
      getJson(`${F}/futures/data/openInterestHist?symbol=${pair}&period=1h&limit=72`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/topLongShortPositionRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/takerlongshortRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/fapi/v1/fundingRate?symbol=${pair}&limit=30`, { ttl: 10 * 60e3 }).catch(() => []),
    ]);
    const mark = n(premium.markPrice);
    const oiBase = n(oi.openInterest);
    return {
      source: 'Binance Futures',
      pair,
      markPrice: mark,
      indexPrice: n(premium.indexPrice),
      basisPct: n(premium.indexPrice) ? ((mark - n(premium.indexPrice)) / n(premium.indexPrice)) * 100 : null,
      fundingRate: n(premium.lastFundingRate),
      nextFundingTime: n(premium.nextFundingTime),
      openInterest: oiBase,
      openInterestUsd: oiBase && mark ? oiBase * mark : null,
      oiHistory: (oiHist || []).map((r) => ({ t: n(r.timestamp), oi: n(r.sumOpenInterest), usd: n(r.sumOpenInterestValue) })),
      longShort: (ls || []).map((r) => ({ t: n(r.timestamp), ratio: n(r.longShortRatio), longPct: n(r.longAccount) * 100 })),
      topTraders: (top || []).map((r) => ({ t: n(r.timestamp), ratio: n(r.longShortRatio), longPct: n(r.longAccount) * 100 })),
      takerFlow: (taker || []).map((r) => ({ t: n(r.timestamp), ratio: n(r.buySellRatio), buy: n(r.buyVol), sell: n(r.sellVol) })),
      fundingHistory: (funding || []).map((r) => ({ t: n(r.fundingTime), rate: n(r.fundingRate) })),
    };
  } catch {
    // Bybit fallback (funding + open interest only)
    try {
      const r = await getJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${pair}`, { ttl: 20e3 });
      const d = r.result?.list?.[0];
      if (!d) throw new Error('no data');
      const hist = await getJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${pair}&intervalTime=1h&limit=72`, { ttl: 5 * 60e3 }).catch(() => null);
      return {
        source: 'Bybit', pair,
        markPrice: n(d.markPrice), indexPrice: n(d.indexPrice),
        basisPct: n(d.indexPrice) ? ((n(d.markPrice) - n(d.indexPrice)) / n(d.indexPrice)) * 100 : null,
        fundingRate: n(d.fundingRate), nextFundingTime: n(d.nextFundingTime),
        openInterest: n(d.openInterest), openInterestUsd: n(d.openInterestValue),
        oiHistory: (hist?.result?.list || []).map((x) => ({ t: n(x.timestamp), oi: n(x.openInterest), usd: n(x.openInterest) * n(d.markPrice) })).reverse(),
        longShort: [], topTraders: [], takerFlow: [], fundingHistory: [],
      };
    } catch {
      return null;
    }
  }
}

// Market-wide funding / open interest table for the futures page.
export async function futuresOverview(symbols) {
  try {
    const all = await getJson(`${F}/fapi/v1/premiumIndex`, { ttl: 30e3 });
    const byPair = new Map(all.map((r) => [r.symbol, r]));
    const rows = await Promise.all(symbols.map(async (s) => {
      const p = byPair.get(`${s}USDT`);
      if (!p) return null;
      const oi = await getJson(`${F}/fapi/v1/openInterest?symbol=${s}USDT`, { ttl: 60e3 }).catch(() => null);
      const mark = n(p.markPrice);
      return {
        symbol: s, markPrice: mark, fundingRate: n(p.lastFundingRate), nextFundingTime: n(p.nextFundingTime),
        basisPct: n(p.indexPrice) ? ((mark - n(p.indexPrice)) / n(p.indexPrice)) * 100 : null,
        openInterest: oi ? n(oi.openInterest) : null,
        openInterestUsd: oi && mark ? n(oi.openInterest) * mark : null,
      };
    }));
    return rows.filter(Boolean);
  } catch {
    return [];
  }
}

// Live liquidation feed (all markets). Returns an unsubscribe function.
export function liquidationStream(onEvent) {
  if (typeof WebSocket === 'undefined') return () => {};
  let ws, closed = false, retry = 0;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${CONFIG.FUTURES_WS}/ws/!forceOrder@arr`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data).o;
        if (!o) return;
        onEvent({
          symbol: o.s.replace(/USDT$/, ''), pair: o.s,
          side: o.S === 'SELL' ? 'long' : 'short', // a SELL liquidation closes a long
          qty: +o.q, price: +(o.ap || o.p), usd: +o.q * +(o.ap || o.p), time: o.T,
        });
      } catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => { if (!closed) setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++)); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  };
  connect();
  return () => { closed = true; try { ws?.close(); } catch { /* ignore */ } };
}

// Plain-language reading of funding + open interest for the AI context and the UI.
export function interpretFutures(f) {
  if (!f) return null;
  const fundingPct = f.fundingRate === null ? null : f.fundingRate * 100;
  const annual = fundingPct === null ? null : fundingPct * 3 * 365;
  const oiChange = f.oiHistory?.length > 12 ? (f.oiHistory[f.oiHistory.length - 1].usd / f.oiHistory[f.oiHistory.length - 13].usd - 1) * 100 : null;
  const longPct = f.longShort?.length ? f.longShort[f.longShort.length - 1].longPct : null;
  const notes = [];
  if (fundingPct !== null) {
    if (fundingPct > 0.05) notes.push('Funding is high and positive — longs are paying shorts heavily, which often precedes long squeezes.');
    else if (fundingPct > 0.01) notes.push('Funding is positive — traders lean long.');
    else if (fundingPct < -0.05) notes.push('Funding is deeply negative — shorts are paying longs, which often precedes short squeezes.');
    else if (fundingPct < -0.01) notes.push('Funding is negative — traders lean short.');
    else notes.push('Funding is close to neutral.');
  }
  if (oiChange !== null) {
    if (oiChange > 5) notes.push(`Open interest is up ${oiChange.toFixed(1)}% in 12h — new leveraged positions are being opened.`);
    else if (oiChange < -5) notes.push(`Open interest is down ${Math.abs(oiChange).toFixed(1)}% in 12h — positions are being closed or liquidated.`);
  }
  if (longPct !== null) notes.push(`${longPct.toFixed(0)}% of Binance futures accounts are long.`);
  return { fundingPct, annualisedFundingPct: annual, oiChange12hPct: oiChange, longAccountsPct: longPct, notes };
}
