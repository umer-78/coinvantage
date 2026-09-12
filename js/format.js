import { fx } from './api/fx.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function price(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  v = +v;
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (a === 0) return '0.00';
  const digits = Math.min(10, Math.max(4, -Math.floor(Math.log10(a)) + 3));
  return v.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, '$1');
}
// Money in the visitor's display currency (values come in as USD).
export function money(v, { showCode = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  const converted = +v * fx.rate;
  const digits = Math.abs(converted) >= 1000 ? 0 : undefined;
  const text = digits === 0 ? Math.round(converted).toLocaleString('en-US') : price(converted);
  return `${fx.symbol}${text}${showCode && fx.code !== 'USD' ? ` ${fx.code}` : ''}`;
}
// Kept for readability at call sites: same thing, currency-aware.
export const usd = (v) => money(v);

export function compact(v, prefix = '$') {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  // '$' means "this is money": convert to the display currency and use its symbol.
  const isMoney = prefix === '$';
  const value = isMoney ? +v * fx.rate : +v;
  const sign = isMoney ? fx.symbol : prefix;
  const a = Math.abs(value);
  const f = (x, suffix) => `${sign}${x.toLocaleString('en-US', { maximumFractionDigits: x >= 100 ? 1 : 2 })}${suffix}`;
  if (a >= 1e12) return f(value / 1e12, 'T');
  if (a >= 1e9) return f(value / 1e9, 'B');
  if (a >= 1e6) return f(value / 1e6, 'M');
  if (a >= 1e3) return f(value / 1e3, 'K');
  return `${sign}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

export function pct(v, dp = 2, sign = true) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  return `${sign && v > 0 ? '+' : ''}${(+v).toFixed(dp)}%`;
}

export function num(v, dp = 2) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  return (+v).toLocaleString('en-US', { maximumFractionDigits: dp });
}

export function amount(v) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '—';
  const a = Math.abs(v);
  return (+v).toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 2 : a >= 1 ? 4 : 8 });
}

export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

export function changeHtml(v, dp = 2) {
  if (v === null || v === undefined || !Number.isFinite(+v)) return '<span class="chg flat">—</span>';
  const t = tone(v);
  const arrow = t === 'up' ? '▲' : t === 'down' ? '▼' : '';
  return `<span class="chg ${t}"><span aria-hidden="true">${arrow}</span>${Math.abs(v).toFixed(dp)}%</span>`;
}

export function dateTime(t, withTime = true) {
  const d = new Date(t);
  return d.toLocaleString('en-US', withTime ? { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const INTERVAL_LABEL = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '30m': '30 minutes', '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '6h': '6 hours', '12h': '12 hours', '1d': '1 day', '3d': '3 days', '1w': '1 week' };

export function horizonText(interval, bars) {
  const ms = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080 }[interval] * bars;
  const unit = (v, u) => `${v} ${u}${v === 1 ? '' : 's'}`;
  if (ms < 60) return unit(ms, 'minute');
  if (ms < 1440) return unit(+(ms / 60).toFixed(1), 'hour');
  if (ms < 10080 * 2) return unit(+(ms / 1440).toFixed(1), 'day');
  return unit(+(ms / 10080).toFixed(1), 'week');
}
