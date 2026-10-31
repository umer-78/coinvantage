// Checks for anything typed into the app or read back from this device's
// storage before it is used. Each returns either a clean value or a reason a
// person can act on; nothing here throws.
//
// The custom AI endpoint is the sharpest edge: whatever address is saved
// receives every question and the market data behind it, plus the API key.
// So it is limited to this computer (Ollama, LM Studio, vLLM) or a short list
// of well-known OpenAI-compatible providers, the same list the page's
// Content-Security-Policy allows in connect-src (tests/security.test.mjs
// keeps the two in step).

/** Providers an https endpoint may point at. Add one here AND to the CSP. */
export const AI_ENDPOINT_HOSTS = [
  'api.openai.com', 'openrouter.ai', 'api.groq.com', 'api.together.xyz', 'api.mistral.ai', 'api.deepseek.com',
];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/**
 * An OpenAI-compatible base URL, e.g. http://localhost:11434/v1.
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
export function checkEndpoint(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: '' };
  if (s.length > 300) return { ok: false, reason: 'That address is too long.' };
  let url;
  try { url = new URL(s); } catch { return { ok: false, reason: 'Enter a full address that starts with http:// or https://.' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'Only http:// (this computer) and https:// addresses are allowed.' };
  if (url.username || url.password) return { ok: false, reason: 'Put the API key in its own box, not in the address.' };
  if (url.search || url.hash) return { ok: false, reason: 'Leave out ?query and #fragment parts; enter the base URL only (e.g. …/v1).' };
  const host = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.includes(host);
  if (!local && url.protocol !== 'https:') return { ok: false, reason: 'A server on another machine must use https://.' };
  if (!local && !AI_ENDPOINT_HOSTS.includes(host)) {
    return { ok: false, reason: `Only this computer (localhost) or these providers are allowed: ${AI_ENDPOINT_HOSTS.join(', ')}.` };
  }
  if (!/^[A-Za-z0-9/_.~-]*$/.test(url.pathname)) return { ok: false, reason: 'The path has characters an API address does not use.' };
  // the app adds /chat/completions itself
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return { ok: true, value: `${url.protocol}//${url.host}${path}` };
}

/** A model id such as llama3.1, qwen2.5:7b or meta-llama/Llama-3.1-8B-Instruct. */
export function checkModelName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: '' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(s)) return { ok: false, reason: 'Model names use letters, digits and . _ : / @ + - only (up to 128 characters).' };
  return { ok: true, value: s };
}

/** An API key: printable characters, no spaces. Optional for a local server. */
export function checkApiKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, value: '' };
  if (!/^[\x21-\x7e]{8,256}$/.test(s)) return { ok: false, reason: 'An API key is 8 to 256 characters with no spaces.' };
  return { ok: true, value: s };
}

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];

/**
 * Settings as read back from storage, with anything malformed or tampered
 * with replaced by its default. Saved settings outlive app versions and can be
 * edited by hand, so nothing in them is trusted as-is.
 */
export function cleanSettings(saved, defaults) {
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const out = { ...defaults };
  for (const [k, v] of Object.entries(s)) {
    if (!(k in defaults) || typeof v !== typeof defaults[k]) continue;
    out[k] = v;
  }
  if (!INTERVALS.includes(out.interval)) out.interval = defaults.interval;
  if (!Number.isFinite(out.horizon) || out.horizon < 1 || out.horizon > 500) out.horizon = defaults.horizon;
  if (!/^[A-Z]{3}$/.test(out.currency)) out.currency = defaults.currency;
  if (!/^[a-z]{2}$/.test(out.lang)) out.lang = defaults.lang;
  if (out.theme !== 'dark' && out.theme !== 'light') out.theme = defaults.theme;
  if (typeof out.llmModel !== 'string' || !/^[A-Za-z0-9._-]{0,80}$/.test(out.llmModel)) out.llmModel = '';
  const ep = checkEndpoint(out.customEndpoint), model = checkModelName(out.customModel), key = checkApiKey(out.customKey);
  // a bad endpoint takes the key with it, so a key is never sent somewhere unchecked
  if (!ep.ok) { out.customEndpoint = ''; out.customKey = ''; } else out.customEndpoint = ep.value;
  out.customModel = model.ok ? model.value : '';
  if (!key.ok) out.customKey = '';
  return out;
}
