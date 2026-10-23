// fetch wrapper: timeout, in-memory + localStorage cache, per-host circuit breaker,
// request spacing for rate-limited hosts (CoinGecko public API).

const mem = new Map();
const inflight = new Map();
const hostDown = new Map();
const hostFails = new Map();   // host -> network failures in a row
const lastCall = new Map();
const SPACING = { 'api.coingecko.com': 1500 };

export class HttpError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lsGet(key) {
  try { const v = localStorage.getItem('cv:cache:' + key); return v ? JSON.parse(v) : null; } catch { return null; }
}
// What is kept on the device stays bounded: the dozen most recent responses, at
// most about 1.6 MB in all, oldest out first. It used to keep every response
// it was asked to (one per coin page visited) until the browser ran out of room,
// and then the account's own saves failed. The coin list with its 7-day lines
// (about 1 MB) fits, so the home page still opens from it straight away.
const LS_MAX_KEYS = 12, LS_MAX_BYTES = 1.6e6, LS_ONE_MAX = 1.2e6, LS_INDEX = 'cv:cacheIndex';
function lsIndex() {
  try { const v = JSON.parse(localStorage.getItem(LS_INDEX) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function lsSet(key, value) {
  try {
    const text = JSON.stringify(value);
    if (text.length > LS_ONE_MAX) return;   // too big to be worth keeping
    localStorage.setItem('cv:cache:' + key, text);
    const idx = lsIndex().filter((e) => e.k !== key);
    idx.push({ k: key, n: text.length });
    let total = idx.reduce((a, e) => a + e.n, 0);
    while (idx.length > LS_MAX_KEYS || total > LS_MAX_BYTES) {
      const old = idx.shift();
      total -= old.n;
      localStorage.removeItem('cv:cache:' + old.k);
    }
    localStorage.setItem(LS_INDEX, JSON.stringify(idx));
  } catch { /* quota or private mode */ }
}
/** Drop kept responses the index does not know (left by older versions, which kept everything). */
export function tidyHttpCache() {
  try {
    const known = new Set(lsIndex().map((e) => 'cv:cache:' + e.k));
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('cv:cache:') && !known.has(k)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
    return stale.length;
  } catch { return 0; }
}

async function rawFetch(url, { timeout = 10000, method = 'GET', body, headers } = {}) {
  const host = new URL(url).host;
  if ((hostDown.get(host) || 0) > Date.now()) throw new HttpError(`${host} unavailable`, 503);
  const gap = SPACING[host];
  if (gap) {
    const wait = (lastCall.get(host) || 0) + gap - Date.now();
    lastCall.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { method, body, headers, signal: ctrl.signal });
    hostFails.delete(host);   // it answered, so it is up
    if (res.status === 429) {
      hostDown.set(host, Date.now() + 20000);
      throw new HttpError(`${host} rate limit reached`, 429);
    }
    if (!res.ok) throw new HttpError(`${host} error ${res.status}`, res.status);
    return await res.json();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Three failures in a row take a host out for 15 s. It used to be one: on a
    // slow connection a single timed-out request made every coin on that
    // exchange fail for 15 s — no chart, no forecast, coins skipped by the AI.
    const n = (hostFails.get(host) || 0) + 1;
    if (n >= 3) { hostDown.set(host, Date.now() + 15000); hostFails.delete(host); } else hostFails.set(host, n);
    throw new HttpError(err.name === 'AbortError' ? `${host} timed out` : `${host} unreachable`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * getJson(url, { ttl, persist, ...fetchOpts })
 * ttl: ms to reuse a cached response. persist: also keep in localStorage so pages
 * render instantly on the next visit (and survive a temporary outage).
 */
export async function getJson(url, { ttl = 0, persist = false, key = url, ...opts } = {}) {
  const now = Date.now();
  const hit = mem.get(key) || (persist ? lsGet(key) : null);
  if (hit && now - hit.at < ttl) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await rawFetch(url, opts);
      const entry = { at: Date.now(), value };
      mem.set(key, entry);
      if (mem.size > 400) mem.delete(mem.keys().next().value);
      if (persist) lsSet(key, entry);
      return value;
    } catch (err) {
      if (hit && now - hit.at < 6 * 3600e3) { err.staleValue = hit.value; }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// Returns cached value immediately if present (even if expired), for instant paint.
export function peek(key) {
  return (mem.get(key) || lsGet(key))?.value ?? null;
}

// Try a list of base URLs in order; fall back to stale cache only if all fail.
export async function getJsonAny(bases, path, opts = {}) {
  let lastErr, stale;
  for (const b of bases) {
    try { return await getJson(b + path, { ...opts, key: opts.key || path }); }
    catch (e) { lastErr = e; if (e.staleValue !== undefined) stale = e.staleValue; }
  }
  if (stale !== undefined) return stale;
  throw lastErr;
}

export function postJson(url, payload, opts = {}) {
  return rawFetch(url, { ...opts, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
