// Per-device storage (watchlist, portfolio, alerts, settings). Wrapped so the
// site still works in private mode or when storage is blocked.
const mem = {};
const PREFIX = 'cv:';

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? (key in mem ? mem[key] : fallback) : JSON.parse(v);
  } catch {
    return key in mem ? mem[key] : fallback;
  }
}

// Whether this device is actually persisting anything. A failed write used to
// be swallowed entirely: the value stayed in `mem`, so a recorded trade, a new
// alert or a holding looked saved and worked for the rest of the session, then
// disappeared on reload with no explanation. Private browsing and a full quota
// both do this.
export const storageState = { persists: true, lastError: null };
let warned = false;

export function save(key, value) {
  mem[key] = value;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    storageState.persists = true;
  } catch (err) {
    storageState.persists = false;
    storageState.lastError = String(err && err.name === 'QuotaExceededError'
      ? 'this browser is out of storage space'
      : 'this browser is not allowing the site to store data (private browsing blocks it)');
    if (!warned) {
      warned = true;
      window.dispatchEvent(new CustomEvent('cv:store-failed', { detail: { key, reason: storageState.lastError } }));
    }
  }
  window.dispatchEvent(new CustomEvent('cv:store', { detail: { key } }));
  return storageState.persists;
}

export const watchlist = {
  all: () => load('watchlist', ['BTC', 'ETH', 'SOL']),
  has: (sym) => watchlist.all().includes(sym),
  toggle(sym) {
    const list = watchlist.all();
    save('watchlist', list.includes(sym) ? list.filter((s) => s !== sym) : [...list, sym]);
    return watchlist.has(sym);
  },
};

export const settings = {
  get: () => ({ theme: 'dark', interval: '1h', horizon: 12, llmModel: '', llmAuto: false, customEndpoint: '', customModel: '', customKey: '', ...load('settings', {}) }),
  set(patch) { save('settings', { ...settings.get(), ...patch }); },
};
