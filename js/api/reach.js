// Exchanges that refuse whole regions.
//
// Binance (api, fapi and their streams) and Bybit turn away some countries, the
// US among them. The refusal carries no CORS header, so the page only sees a
// network error and the browser logs a red CORS line for every request: the
// futures page used to log a dozen of them on each visit before falling back
// to OKX. Now the first refusal is remembered on this device for half a day and
// the host is skipped until then, so the data comes straight from the next
// source. In a US time zone, where these hosts refuse every request, they are
// skipped from the start.
export const REGION_GATED = new Set([
  'api.binance.com', 'stream.binance.com', 'fapi.binance.com', 'fstream.binance.com',
  'api.bybit.com', 'stream.bybit.com',
]);
// A stream is refused wherever its REST host is.
const SAME_POLICY = {
  'stream.binance.com': 'api.binance.com',
  'fstream.binance.com': 'fapi.binance.com',
  'stream.bybit.com': 'api.bybit.com',
};
export const REFUSAL_MEMORY_MS = 12 * 3600e3;
const KEY = 'cv:refused';

// Zone names used in the 50 states (the IANA "America/..." zones Canada and
// Mexico use have names of their own, so they do not match).
const US_ZONES = /^(?:America\/(?:New_York|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Adak|Boise|Detroit|Juneau|Menominee|Metlakatla|Nome|Sitka|Yakutat|Indiana\/[A-Za-z_]+|Kentucky\/[A-Za-z_]+|North_Dakota\/[A-Za-z_]+)|Pacific\/Honolulu|US\/[A-Za-z_-]+)$/;

export function inUsTimeZone(zone) {
  return US_ZONES.test(String(zone || ''));
}

function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
}

const memory = new Map();   // host -> refused until (ms)

function stored() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

const policyHost = (hostname) => SAME_POLICY[hostname] || hostname;

/** True when requests to this host are known to be refused from here. */
export function refusedHere(hostname, { now = Date.now(), zone = deviceZone() } = {}) {
  if (!REGION_GATED.has(hostname)) return false;
  if (inUsTimeZone(zone)) return true;
  const host = policyHost(hostname);
  const until = memory.get(host) ?? stored()[host];
  return typeof until === 'number' && until > now && until - now <= REFUSAL_MEMORY_MS;
}

/** Remember that this host refused a request from here. */
export function noteRefusal(hostname, { now = Date.now(), forMs = REFUSAL_MEMORY_MS } = {}) {
  if (!REGION_GATED.has(hostname)) return;
  const host = policyHost(hostname);
  const until = now + Math.min(forMs, REFUSAL_MEMORY_MS);
  memory.set(host, until);
  try {
    const all = stored();
    for (const [k, v] of Object.entries(all)) if (!(typeof v === 'number' && v > now)) delete all[k];
    all[host] = until;
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch { /* private mode: the memory lasts for this page */ }
}

/** For tests: forget everything learned in this page. */
export function forgetRefusals() {
  memory.clear();
}
