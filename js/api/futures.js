// Derivatives data: funding rate, open interest, long/short ratios and live liquidations.
// Binance USD-M futures first, then Bybit, then OKX. Binance and Bybit both
// geo-block their APIs in several regions (the browser only sees a CORS error),
// and before the OKX step the whole futures page came up empty there.
import { CONFIG } from '../config.js';
import { getJson } from './http.js';

const F = CONFIG.FUTURES_REST;
const OKX_REST = 'https://www.okx.com';
const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
// null * 100 is 0, so a missing ratio used to render as a confident "0% are
// long" rather than "unknown". Every percentage conversion goes through this.
const pctOf = (v) => { const x = n(v); return x === null || !Number.isFinite(x) ? null : x * 100; };

// How often this contract settles funding. Binance sets it per symbol — 8 hours
// for most, 4 for some — and publishes it at /fapi/v1/fundingInfo. The page used
// to assume 8 hours for everything and annualise at 3x/day, which understates a
// 4-hour contract by exactly half and states the wrong interval as a fact.
let fundingInfoPromise = null;
export function fundingIntervals() {
  if (!fundingInfoPromise) {
    fundingInfoPromise = getJson(`${F}/fapi/v1/fundingInfo`, { ttl: 6 * 3600e3, persist: true, key: 'bn:fundinginfo' })
      .then((rows) => new Map((rows || []).map((r) => [r.symbol, n(r.fundingIntervalHours) || 8])))
      .catch(() => new Map());
  }
  return fundingInfoPromise;
}

/** Funding as an annual rate, using the contract's real settlement interval. */
export function annualiseFunding(ratePct, intervalHours = 8) {
  if (ratePct === null || ratePct === undefined || !Number.isFinite(ratePct)) return null;
  const perDay = 24 / (intervalHours || 8);
  return ratePct * perDay * 365;
}

export async function futuresSnapshot(symbol) {
  const pair = `${symbol}USDT`;
  try {
    const [premium, oi, oiHist, ls, top, taker, funding] = await Promise.all([
      getJson(`${F}/fapi/v1/premiumIndex?symbol=${pair}`, { ttl: 15e3 }),
      // one transient open-interest failure used to discard the whole Binance
      // snapshot and downgrade the card to a fallback with far less data
      getJson(`${F}/fapi/v1/openInterest?symbol=${pair}`, { ttl: 30e3 }).catch(() => ({})),
      getJson(`${F}/futures/data/openInterestHist?symbol=${pair}&period=1h&limit=72`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/topLongShortPositionRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/futures/data/takerlongshortRatio?symbol=${pair}&period=1h&limit=24`, { ttl: 5 * 60e3 }).catch(() => []),
      getJson(`${F}/fapi/v1/fundingRate?symbol=${pair}&limit=30`, { ttl: 10 * 60e3 }).catch(() => []),
    ]);
    const mark = n(premium.markPrice);
    const oiBase = n(oi?.openInterest);
    const intervalHours = (await fundingIntervals()).get(pair) || 8;
    return {
      source: 'Binance Futures',
      pair,
      fundingIntervalHours: intervalHours,
      fetchedAt: Date.now(),
      markPrice: mark,
      indexPrice: n(premium.indexPrice),
      basisPct: n(premium.indexPrice) ? ((mark - n(premium.indexPrice)) / n(premium.indexPrice)) * 100 : null,
      fundingRate: n(premium.lastFundingRate),
      nextFundingTime: n(premium.nextFundingTime),
      openInterest: oiBase,
      openInterestUsd: oiBase && mark ? oiBase * mark : null,
      oiHistory: (oiHist || []).map((r) => ({ t: n(r.timestamp), oi: n(r.sumOpenInterest), usd: n(r.sumOpenInterestValue) })),
      longShort: (ls || []).map((r) => ({ t: n(r.timestamp), ratio: n(r.longShortRatio), longPct: pctOf(r.longAccount) })),
      // this endpoint reports the long share of top traders' POSITIONS, not of
      // their accounts — the field is named for what it actually is
      topTraders: (top || []).map((r) => ({ t: n(r.timestamp), ratio: n(r.longShortRatio), longPositionPct: pctOf(r.longAccount) })),
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
        source: 'Bybit', pair, fundingIntervalHours: 8, fetchedAt: Date.now(),
        markPrice: n(d.markPrice), indexPrice: n(d.indexPrice),
        basisPct: n(d.indexPrice) ? ((n(d.markPrice) - n(d.indexPrice)) / n(d.indexPrice)) * 100 : null,
        fundingRate: n(d.fundingRate), nextFundingTime: n(d.nextFundingTime),
        openInterest: n(d.openInterest), openInterestUsd: n(d.openInterestValue),
        oiHistory: (hist?.result?.list || []).map((x) => ({ t: n(x.timestamp), oi: n(x.openInterest), usd: n(x.openInterest) * n(d.markPrice) })).reverse(),
        longShort: [], topTraders: [], takerFlow: [], fundingHistory: [],
      };
    } catch {
      return okxSnapshot(symbol).catch(() => null);
    }
  }
}

// ---------------------------------------------------------------- OKX fallback
// OKX wraps every answer as { code: '0', data: [...] } and reports an unknown
// instrument as HTTP 200 with a non-zero code, so the code has to be checked.
const okxRows = (j) => {
  if (!j || j.code !== '0' || !Array.isArray(j.data)) throw new Error(`OKX: ${j?.msg || 'no data'}`);
  return j.data;
};
const okxGet = (path, ttl) => getJson(`${OKX_REST}${path}`, { ttl }).then(okxRows);
/** OKX funding interval in hours, from the two settlement times it publishes. */
export function okxFundingHours(fundingTime, nextFundingTime) {
  const h = (n(nextFundingTime) - n(fundingTime)) / 3600e3;
  return Number.isFinite(h) && h >= 1 && h <= 24 ? Math.round(h) : 8;
}

/** Pure mapping from raw OKX rows to the snapshot shape (unit-tested). */
export function okxSnapshotFrom(symbol, { mark, fund, idx, oi, fHist }) {
  const markPx = n(mark?.markPx);
  const indexPx = n(idx?.idxPx);
  return {
    source: 'OKX',
    pair: `${symbol}-USDT-SWAP`,
    fundingIntervalHours: okxFundingHours(fund?.fundingTime, fund?.nextFundingTime),
    fetchedAt: Date.now(),
    markPrice: markPx,
    indexPrice: indexPx,
    basisPct: indexPx && markPx !== null ? ((markPx - indexPx) / indexPx) * 100 : null,
    fundingRate: n(fund?.fundingRate),
    nextFundingTime: n(fund?.fundingTime),
    openInterest: n(oi?.oiCcy),
    openInterestUsd: n(oi?.oiUsd),
    // OKX's positioning and open-interest history live under /rubik, which
    // sends no CORS header, so a browser cannot read them. Worse, each blocked
    // call trips the per-host breaker in http.js and takes every other OKX
    // request down with it for 15 seconds. They are left empty on purpose.
    oiHistory: [], longShort: [], topTraders: [], takerFlow: [],
    fundingHistory: [...(fHist || [])]
      .map((r) => ({ t: n(r.fundingTime), rate: n(r.realizedRate) ?? n(r.fundingRate) }))
      .sort((a, b) => a.t - b.t),
  };
}

async function okxSnapshot(symbol) {
  const inst = `${symbol}-USDT-SWAP`;
  // these two decide whether OKX lists the contract at all; if either fails
  // the coin has no OKX perpetual and the caller shows "no futures data"
  const [[mark], [fund]] = await Promise.all([
    okxGet(`/api/v5/public/mark-price?instType=SWAP&instId=${inst}`, 15e3),
    okxGet(`/api/v5/public/funding-rate?instId=${inst}`, 60e3),
  ]);
  if (!mark || !fund) throw new Error('OKX: no contract');
  const opt = (path, ttl) => okxGet(path, ttl).catch(() => []);
  const [idx, oi, fHist] = await Promise.all([
    opt(`/api/v5/market/index-tickers?instId=${symbol}-USDT`, 15e3),
    opt(`/api/v5/public/open-interest?instType=SWAP&instId=${inst}`, 30e3),
    opt(`/api/v5/public/funding-rate-history?instId=${inst}&limit=30`, 10 * 60e3),
  ]);
  return okxSnapshotFrom(symbol, { mark, fund, idx: idx[0], oi: oi[0], fHist });
}

/** Pure mapping for the market table from OKX's bulk lists (unit-tested). */
export function okxOverviewFrom(symbols, { marks = [], ois = [], funds = [] }) {
  const byInst = (rows) => new Map(rows.map((r) => [r.instId, r]));
  const m = byInst(marks), o = byInst(ois), f = byInst(funds);
  return symbols.map((s) => {
    const inst = `${s}-USDT-SWAP`;
    const mk = m.get(inst);
    if (!mk) return null;
    const oi = o.get(inst), fr = f.get(inst);
    return {
      symbol: s, markPrice: n(mk.markPx),
      fundingRate: fr ? n(fr.fundingRate) : null,
      nextFundingTime: fr ? n(fr.fundingTime) : null,
      fundingIntervalHours: fr ? okxFundingHours(fr.fundingTime, fr.nextFundingTime) : 8,
      // OKX's bulk lists carry no index price, so there is no basis to show
      basisPct: null,
      openInterest: oi ? n(oi.oiCcy) : null,
      openInterestUsd: oi ? n(oi.oiUsd) : null,
    };
  }).filter(Boolean);
}

async function okxOverview(symbols) {
  const [marks, ois, funds] = await Promise.all([
    okxGet('/api/v5/public/mark-price?instType=SWAP', 30e3),
    okxGet('/api/v5/public/open-interest?instType=SWAP', 60e3).catch(() => []),
    // every contract's funding in one ~300 KB answer; without it the table
    // still shows prices and open interest, just no funding column
    okxGet('/api/v5/public/funding-rate?instId=ANY', 60e3).catch(() => []),
  ]);
  return okxOverviewFrom(symbols, { marks, ois, funds });
}

// Market-wide funding / open interest table for the futures page.
export async function futuresOverview(symbols) {
  try {
    const [all, intervals] = await Promise.all([
      getJson(`${F}/fapi/v1/premiumIndex`, { ttl: 30e3 }),
      fundingIntervals(),
    ]);
    const byPair = new Map(all.map((r) => [r.symbol, r]));
    const rows = await Promise.all(symbols.map(async (s) => {
      const p = byPair.get(`${s}USDT`);
      if (!p) return null;
      const oi = await getJson(`${F}/fapi/v1/openInterest?symbol=${s}USDT`, { ttl: 60e3 }).catch(() => null);
      const mark = n(p.markPrice);
      return {
        symbol: s, markPrice: mark, fundingRate: n(p.lastFundingRate), nextFundingTime: n(p.nextFundingTime),
        fundingIntervalHours: intervals.get(`${s}USDT`) || 8,
        basisPct: n(p.indexPrice) ? ((mark - n(p.indexPrice)) / n(p.indexPrice)) * 100 : null,
        openInterest: oi ? n(oi.openInterest) : null,
        openInterestUsd: oi && mark ? n(oi.openInterest) * mark : null,
      };
    }));
    const out = rows.filter(Boolean);
    out.source = 'Binance';
    return out;
  } catch {
    try {
      const out = await okxOverview(symbols);
      out.source = 'OKX';
      return out;
    } catch {
      return [];
    }
  }
}

// Live liquidation feed. Returns an unsubscribe function.
//
// Binance is the first choice, but in some regions its futures WebSocket
// completes the handshake and then relays nothing at all — measured from a
// browser where BOTH !forceOrder@arr and !miniTicker@arr opened successfully
// and delivered zero frames in 40 seconds, while the busy ticker stream should
// push several per second. The old code treated "opened" as "working", so the
// card sat on a silent socket indefinitely and the feature looked broken with
// no explanation.
//
// So the socket is now watched: if nothing arrives within SILENCE_MS of opening,
// it is treated as dead and OKX takes over. OKX publishes the same events on a
// channel that does reach those regions, sized in contracts rather than coins —
// hence the contract-value lookup below, without which every figure would be out
// by the instrument's multiplier.
const SILENCE_MS = 20000;

// OKX reports liquidation size in contracts, so each instrument's contract
// value is needed to turn that into an amount of coin.
//
// This was originally one request for the whole instrument list, which failed
// from this network — measured in the browser, /public/time answers fine while
// /public/instruments?instType=SWAP does not, so it is the megabyte of response
// that does not get through rather than CORS or a block. Asking for a single
// instId returns a few hundred bytes and works every time.
//
// So values are looked up lazily, per symbol, the first time one is liquidated,
// and cached. A symbol that cannot be resolved is remembered as unknown for ten
// minutes rather than re-requested on every frame.
const UNKNOWN_TTL = 600000;
const okxCtVal = new Map();   // instId -> { value: number|null, at: number }
const okxPending = new Map(); // instId -> Promise

async function okxContractValue(instId) {
  const hit = okxCtVal.get(instId);
  if (hit && (hit.value !== null || Date.now() - hit.at < UNKNOWN_TTL)) return hit.value;
  if (okxPending.has(instId)) return okxPending.get(instId);

  const p = (async () => {
    try {
      const j = await fetch(`${OKX_REST}/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`).then((r) => r.json());
      const d = (j?.data || [])[0];
      const v = d ? Number(d.ctVal) * (Number(d.ctMult) || 1) : NaN;
      const value = Number.isFinite(v) && v > 0 ? v : null;
      okxCtVal.set(instId, { value, at: Date.now() });
      return value;
    } catch {
      okxCtVal.set(instId, { value: null, at: Date.now() });
      return null;
    } finally {
      okxPending.delete(instId);
    }
  })();
  okxPending.set(instId, p);
  return p;
}

export function liquidationStream(onEvent) {
  if (typeof WebSocket === 'undefined') return () => {};
  let ws = null, timer = null, watchdog = null, closed = false, retry = 0;
  let source = 'binance', gotFrame = false;
  const recent = new Set();

  const clearTimers = () => { clearTimeout(timer); clearTimeout(watchdog); timer = null; watchdog = null; };
  const shut = () => { try { ws?.close(); } catch { /* ignore */ } ws = null; };

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (closed || gotFrame) return;
      // Opened, stayed silent: the connection exists but nothing is coming
      // through it. Binance has a documented fallback; OKX does not, so a
      // silent OKX is reported as unavailable rather than cycled forever.
      if (source === 'binance') { onEvent(null, 'switching'); shut(); source = 'okx'; retry = 0; connect(); }
      else onEvent(null, 'failed');
    }, SILENCE_MS);
  };

  const onFrame = () => { if (!gotFrame) { gotFrame = true; clearTimeout(watchdog); onEvent(null, 'live'); } };

  function connectBinance() {
    ws = new WebSocket(`${CONFIG.FUTURES_WS}/ws/!forceOrder@arr`);
    ws.onopen = () => { retry = 0; onEvent(null, 'open'); armWatchdog(); };
    ws.onmessage = (ev) => {
      onFrame();
      try {
        const o = JSON.parse(ev.data).o;
        if (!o) return;
        // o.q is the ORIGINAL quantity and o.z the filled part, so a partial
        // fill was reported at its full requested size. o.ap is a string and
        // "0" is truthy, so the intended fallback to the order price never
        // fired and both price and size came out as zero.
        const avg = +o.ap;
        const price = Number.isFinite(avg) && avg > 0 ? avg : +o.p;
        const filled = +o.z;
        const qty = Number.isFinite(filled) && filled > 0 ? filled : +o.q;
        if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
        onEvent({
          symbol: o.s.replace(/(USDT|USDC|BUSD)(_\d+)?$/, ''), pair: o.s,
          side: o.S === 'SELL' ? 'long' : 'short', // a SELL liquidation closes a long
          qty, price, usd: qty * price, time: o.T, venue: 'Binance',
        });
      } catch { /* ignore malformed frame */ }
    };
  }

  function connectOkx() {
    ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
    ws.onopen = () => {
      retry = 0;
      onEvent(null, 'open');
      try { ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })); } catch { /* ignore */ }
      armWatchdog();
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(msg?.data)) return; // subscribe acknowledgement
      onFrame();
      for (const row of msg.data) {
        const instId = row.instId || '';
        if (!instId.endsWith('-USDT-SWAP')) continue;
        const per = await okxContractValue(instId);
        for (const d of row.details || []) {
          const price = +d.bkPx;
          const contracts = +d.sz;
          if (!Number.isFinite(price) || !Number.isFinite(contracts)) continue;
          // OKX repeats a liquidation across frames, so the same fill was being
          // listed twice with an identical timestamp and price.
          const id = `${instId}|${d.ts}|${d.sz}|${d.bkPx}|${d.posSide}`;
          if (recent.has(id)) continue;
          recent.add(id);
          if (recent.size > 400) for (const k of recent) { recent.delete(k); if (recent.size <= 300) break; }
          // Without the contract value the coin amount is unknown. The row still
          // shows — it is a real liquidation — with contracts reported instead of
          // a dollar figure that would be wrong by the instrument's multiplier.
          const qty = per ? contracts * per : null;
          onEvent({
            symbol: instId.replace(/-USDT-SWAP$/, ''), pair: instId,
            side: d.posSide === 'long' ? 'long' : 'short',
            qty, price, contracts,
            usd: qty === null ? null : qty * price,
            time: +d.ts || Date.now(), venue: 'OKX',
          });
        }
      }
    };
  }

  function connect() {
    if (closed) return;
    gotFrame = false;
    try {
      if (source === 'binance') connectBinance(); else connectOkx();
    } catch { onEvent(null, 'failed'); return; }
    ws.onclose = () => {
      if (closed) return;
      clearTimeout(watchdog);
      onEvent(null, retry >= 4 ? 'failed' : 'reconnecting');
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  connect();
  return () => { closed = true; clearTimers(); shut(); };
}

// Plain-language reading of funding + open interest for the AI context and the UI.
export function interpretFutures(f) {
  if (!f) return null;
  const fundingPct = f.fundingRate === null ? null : f.fundingRate * 100;
  const intervalHours = f.fundingIntervalHours || 8;
  const annual = annualiseFunding(fundingPct, intervalHours);
  // a null or zero bucket used to make this Infinity, which printed as a green
  // dash in one place and the literal words "up Infinity%" in another
  let oiChange = null;
  if (f.oiHistory?.length > 12) {
    const nowUsd = f.oiHistory[f.oiHistory.length - 1]?.usd;
    const thenUsd = f.oiHistory[f.oiHistory.length - 13]?.usd;
    if (Number.isFinite(nowUsd) && Number.isFinite(thenUsd) && thenUsd > 0) oiChange = (nowUsd / thenUsd - 1) * 100;
  }
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
  if (longPct !== null) notes.push(`${longPct.toFixed(0)}% of ${String(f.source || 'Binance').replace(/ Futures$/, '')} futures accounts are long.`);
  return { fundingPct, annualisedFundingPct: annual, fundingIntervalHours: intervalHours, oiChange12hPct: oiChange, longAccountsPct: longPct, notes };
}
