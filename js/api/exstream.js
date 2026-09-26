// Live candles for coins Binance does not list. Gate.io, HTX and OKX each push
// candle updates over a public WebSocket, each in its own format: parseCandle()
// reads one message into {t, o, h, l, c, v}, and streamCandles() keeps one socket
// open, answers the venue's keep-alive and reconnects with backoff. The coin page
// keeps a slow poll for whenever nothing has streamed for a while, so a blocked
// socket costs freshness, never the chart.
import { EX_BAR } from './market.js';

const VENUES = {
  gate: {
    url: 'wss://api.gateio.ws/ws/v4/',
    subscribe: (sym, bar) => ({ time: Math.floor(Date.now() / 1e3), channel: 'spot.candlesticks', event: 'subscribe', payload: [bar, `${sym}_USDT`] }),
    // result: t = open time in seconds, a = base volume (v is quote volume)
    read: (m) => (m.channel === 'spot.candlesticks' && m.event === 'update' && m.result
      ? [m.result.t * 1e3, m.result.o, m.result.h, m.result.l, m.result.c, m.result.a] : null),
  },
  htx: {
    url: 'wss://api.huobi.pro/ws',
    gzip: true, // every frame is gzipped JSON
    subscribe: (sym, bar) => ({ sub: `market.${sym.toLowerCase()}usdt.kline.${bar}`, id: 'cv' }),
    // HTX pings the client and drops it after two unanswered pings
    reply: (m) => (m.ping ? { pong: m.ping } : null),
    read: (m) => (m.tick && /\.kline\./.test(m.ch)
      ? [m.tick.id * 1e3, m.tick.open, m.tick.high, m.tick.low, m.tick.close, m.tick.amount] : null),
  },
  okx: {
    url: 'wss://ws.okx.com:8443/ws/v5/business', // candle channels live here, not on /public
    subscribe: (sym, bar) => ({ op: 'subscribe', args: [{ channel: `candle${bar}`, instId: `${sym}-USDT` }] }),
    ping: 'ping', // OKX closes a socket that sends nothing for 30 s
    // data: [[ts ms, o, h, l, c, base volume, ...]]
    read: (m) => (/^candle/.test(m.arg?.channel) && Array.isArray(m.data?.[0]) ? m.data[0].slice(0, 6) : null),
  },
};

/** One venue message as a candle, or null for anything else (acks, pings, errors, bad prices). */
export function parseCandle(venue, msg) {
  const row = VENUES[venue]?.read(msg);
  if (!row) return null;
  const [t, o, h, l, c, v] = row.map(Number);
  if (!Number.isFinite(t) || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) return null;
  return { t, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

/**
 * Stream one USDT pair's candles. onCandle(c) gets every update of the open
 * candle; onLive(true/false) fires when candles start or stop arriving. Returns
 * stop(), or null when this venue, interval or browser cannot stream.
 */
export function streamCandles(venue, sym, interval, onCandle, onLive = () => {}) {
  const v = VENUES[venue], bar = EX_BAR[venue]?.[interval];
  if (!v || !bar || typeof WebSocket === 'undefined' || (v.gzip && typeof DecompressionStream === 'undefined')) return null;
  let ws = null, stopped = false, live = false, retry = 0, reopen = null, keepAlive = null;
  let queue = Promise.resolve(); // unzipping is async; this keeps messages in order
  const text = (data) => (v.gzip ? new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : data);
  const handle = (raw) => {
    if (stopped) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; } // OKX answers its ping with a bare "pong"
    const reply = v.reply?.(m);
    if (reply && ws?.readyState === 1) ws.send(JSON.stringify(reply));
    const c = parseCandle(venue, m);
    if (!c) return;
    retry = 0;
    if (!live) { live = true; onLive(true); }
    onCandle(c);
  };
  const open = () => {
    const sock = new WebSocket(v.url);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      sock.send(JSON.stringify(v.subscribe(sym, bar)));
      if (v.ping) keepAlive = setInterval(() => { if (sock.readyState === 1) sock.send(v.ping); }, 20e3);
    };
    sock.onmessage = (ev) => { queue = queue.then(() => text(ev.data)).then(handle, () => {}).catch((e) => console.error(e)); };
    sock.onclose = () => {
      clearInterval(keepAlive);
      if (ws === sock) ws = null;
      if (live) { live = false; onLive(false); }
      if (!stopped) reopen = setTimeout(open, Math.min(30e3, 1e3 * 2 ** retry++));
    };
    sock.onerror = () => sock.close();
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(reopen);
    clearInterval(keepAlive);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  };
}
