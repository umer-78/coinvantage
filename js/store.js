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

export function save(key, value) {
  mem[key] = value;
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('cv:store', { detail: { key } }));
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
