// Binance WebSocket hub: one combined connection, dynamic subscribe/unsubscribe,
// automatic reconnect with backoff and endpoint fallback.
import { CONFIG } from '../config.js';

class LiveHub extends EventTarget {
  constructor() {
    super();
    this.handlers = new Map(); // stream -> Set(fn)
    this.ws = null;
    this.urlIndex = 0;
    this.retry = 0;
    this.connected = false;
    this.nextId = 1;
    this.closedByUser = false;
  }

  subscribe(stream, fn) {
    if (!stream.startsWith('!')) stream = stream.toLowerCase(); // e.g. btcusdt@kline_1h; "!miniTicker@arr" is case-sensitive
    if (!this.handlers.has(stream)) {
      this.handlers.set(stream, new Set());
      this.send('SUBSCRIBE', [stream]);
    }
    this.handlers.get(stream).add(fn);
    this.ensure();
    return () => this.unsubscribe(stream, fn);
  }

  unsubscribe(stream, fn) {
    const set = this.handlers.get(stream);
    if (!set) return;
    set.delete(fn);
    if (!set.size) {
      this.handlers.delete(stream);
      this.send('UNSUBSCRIBE', [stream]);
    }
  }

  send(method, params) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ method, params, id: this.nextId++ }));
  }

  ensure() {
    if (this.ws || typeof WebSocket === 'undefined') return;
    const base = CONFIG.BINANCE_WS[this.urlIndex % CONFIG.BINANCE_WS.length];
    const ws = new WebSocket(`${base}/stream`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this.retry = 0;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: true } }));
      const streams = [...this.handlers.keys()];
      for (let i = 0; i < streams.length; i += 100) this.send('SUBSCRIBE', streams.slice(i, i + 100));
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg.stream) return;
      const set = this.handlers.get(msg.stream);
      if (set) for (const fn of set) { try { fn(msg.data); } catch (e) { console.error(e); } }
    };
    ws.onclose = () => {
      const wasConnected = this.connected;
      this.ws = null; this.connected = false;
      this.dispatchEvent(new CustomEvent('status', { detail: { connected: false } }));
      if (!wasConnected) this.urlIndex++; // try the other endpoint next time
      if (!this.handlers.size) return;
      const delay = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.ensure(), delay);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
}

export const live = new LiveHub();

// Pause streams when the tab is hidden for a while to save battery/data on phones.
if (typeof document !== 'undefined') {
  let hideTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideTimer = setTimeout(() => { if (live.ws) { live.ws.onclose = null; live.ws.close(); live.ws = null; live.connected = false; } }, 60000);
    } else {
      clearTimeout(hideTimer);
      live.ensure();
    }
  });
}
