// The page's locks: what it may load and talk to, what it accepts as an AI
// server, and what it accepts back from storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// a tiny browser for store.js
const items = new Map();
globalThis.localStorage = { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k) };
globalThis.window ??= new EventTarget();
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };

const { checkCustomAI, AI_HOSTS } = await import('../js/ai/engine.js');
const { load, save, settings, watchlist } = await import('../js/store.js');
const { CONFIG } = await import('../js/config.js');

const policy = (html) => Object.fromEntries(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1].split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));

test('every page is locked to its own scripts and a list of hosts, not to any https address', () => {
  const pages = ['index.html', ...read('sitemap.xml').match(/<loc>[^<]+<\/loc>/g).map((l) => l.replace(/<\/?loc>/g, '').replace('https://umer-78.github.io/coinvantage/', '')).filter(Boolean).map((p) => `${decodeURI(p)}index.html`)];
  const base = policy(read('index.html'));
  for (const f of pages) {
    const p = policy(read(f));
    assert.deepEqual(p, base, `${f}: the same policy as the app shell`);
  }
  assert.ok(!base['connect-src'].includes('https:') && !base['connect-src'].includes('wss:'), 'connect-src names its hosts');
  assert.ok(!base['script-src'].includes("'unsafe-inline'") && !base['script-src'].includes("'unsafe-eval'"), 'no inline or eval scripts');
  assert.deepEqual(base['object-src'], ["'none'"]);
  assert.deepEqual(base['base-uri'], ["'self'"]);
  assert.deepEqual(base['form-action'], ["'self'"]);
  // everything the code calls is on the list
  const hosts = [CONFIG.COINGECKO, CONFIG.PAPRIKA, CONFIG.FEAR_GREED, CONFIG.SUPABASE_URL, CONFIG.FUTURES_REST, ...CONFIG.BINANCE_REST, ...CONFIG.BINANCE_WS, ...CONFIG.BTC_API, ...Object.values(CONFIG.RPC || {})]
    .filter(Boolean).map((u) => new URL(u).origin.replace(/:443$/, ''));
  for (const h of hosts) assert.ok(base['connect-src'].includes(h), `${h} is allowed`);
  for (const h of AI_HOSTS) assert.ok(base['connect-src'].includes(`https://${h}`), `AI host ${h} is allowed`);
});

test('no javascript: links anywhere in the app', () => {
  const files = ['index.html', ...fs.readdirSync(path.join(root, 'js'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];
  for (const f of files) assert.doesNotMatch(read(f), /href\s*=\s*["'`]\s*javascript:/i, f);
});

test('an AI server of your own: this computer or a listed service, an http(s) address, a sane model name and key', () => {
  assert.equal(checkCustomAI({ url: 'http://localhost:11434/v1/' }).url, 'http://localhost:11434/v1');
  assert.ok(checkCustomAI({ url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: 'sk-abcdefgh12345' }).ok);
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,x', 'ftp://localhost/v1', 'not a url', 'http://192.168.1.5:11434/v1', 'https://evil.example/v1', 'https://user:pass@api.openai.com/v1'])
    assert.equal(checkCustomAI({ url }).ok, false, url);
  assert.equal(checkCustomAI({ url: 'http://127.0.0.1:1234/v1', model: 'bad name <script>' }).field, 'model');
  assert.equal(checkCustomAI({ url: 'http://127.0.0.1:1234/v1', key: 'has space' }).field, 'key');
});

test('storage returns what the caller expects or its fallback, never a value of another shape', () => {
  localStorage.setItem('cv:alerts', '{"not":"a list"}');
  assert.deepEqual(load('alerts', []), [], 'an object where a list belongs');
  localStorage.setItem('cv:alerts', '[1]');
  assert.deepEqual(load('alerts', []), [1]);
  localStorage.setItem('cv:riskAck', '"yes"');
  assert.equal(load('riskAck', false), false, 'a string where true/false belongs');
  localStorage.setItem('cv:settings', '{broken json');
  assert.deepEqual(load('settings', {}), {});
  localStorage.setItem('cv:settings', JSON.stringify({ customEndpoint: { evil: 1 }, interval: '4h', horizon: 'x' }));
  const s = settings.get();
  assert.equal(s.customEndpoint, '', 'a setting of the wrong type is dropped');
  assert.equal(s.interval, '4h');
  assert.equal(s.horizon, 12);
  localStorage.setItem('cv:watchlist', JSON.stringify(['BTC', '<img src=x>', 42, 'ETH']));
  assert.deepEqual(watchlist.all(), ['BTC', 'ETH']);
  assert.throws(() => save('__proto__', 1));
  assert.equal(load('../x', 'fallback'), 'fallback');
});
