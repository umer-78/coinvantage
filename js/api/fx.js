// Display currency: everything is priced in USD upstream and converted here.
import { CONFIG } from '../config.js';
import { settings } from '../store.js';

export const fx = { code: 'USD', symbol: '$', rate: 1, updated: 0 };

const SYMBOLS = Object.fromEntries(CONFIG.CURRENCIES.map(([c, s]) => [c, s]));
export const currencyName = (code) => CONFIG.CURRENCIES.find((c) => c[0] === code)?.[2] || code;

let ratesPromise = null;
export function rates() {
  if (!ratesPromise) {
    ratesPromise = (async () => {
      const cached = (() => { try { return JSON.parse(localStorage.getItem('cv:fx') || 'null'); } catch { return null; } })();
      if (cached && Date.now() - cached.at < 6 * 3600e3) return cached.rates;
      try {
        const r = await fetch('https://open.er-api.com/v6/latest/USD').then((x) => x.json());
        if (r.result === 'success' && r.rates) {
          try { localStorage.setItem('cv:fx', JSON.stringify({ at: Date.now(), rates: r.rates })); } catch { /* ignore */ }
          return r.rates;
        }
        throw new Error('bad response');
      } catch {
        try {
          const g = await fetch(`${CONFIG.COINGECKO}/exchange_rates`).then((x) => x.json());
          const usd = g.rates?.usd?.value;
          if (usd) {
            const out = {};
            for (const [k, v] of Object.entries(g.rates)) if (v.type === 'fiat') out[k.toUpperCase()] = v.value / usd;
            try { localStorage.setItem('cv:fx', JSON.stringify({ at: Date.now(), rates: out })); } catch { /* ignore */ }
            return out;
          }
        } catch { /* offline */ }
        return cached?.rates || { USD: 1 };
      }
    })();
  }
  return ratesPromise;
}

export async function initCurrency() {
  const code = settings.get().currency || 'USD';
  await setCurrency(code, false);
}

export async function setCurrency(code, notify = true) {
  const all = await rates();
  const rate = code === 'USD' ? 1 : all[code];
  if (!rate) return false;
  fx.code = code; fx.symbol = SYMBOLS[code] || `${code} `; fx.rate = rate; fx.updated = Date.now();
  settings.set({ currency: code });
  if (notify) window.dispatchEvent(new CustomEvent('cv:currency', { detail: { code } }));
  return true;
}

export const toDisplay = (usdValue) => (usdValue === null || usdValue === undefined ? usdValue : usdValue * fx.rate);
