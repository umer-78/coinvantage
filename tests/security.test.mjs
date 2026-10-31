import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEndpoint, checkModelName, checkApiKey, cleanSettings, AI_ENDPOINT_HOSTS } from '../js/lib/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '').split(/\s+/).slice(1);

test('the CSP is strict where it matters', () => {
  for (const d of ["default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "script-src-attr 'none'"]) {
    assert.ok(csp.includes(d), `has ${d}`);
  }
  const script = directive('script-src');
  assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"), 'no inline or eval scripts');
  assert.ok(!script.includes('https:') && !script.includes('blob:') && !script.includes('data:'), 'scripts only from named origins');
  const connect = directive('connect-src');
  assert.ok(!connect.includes('https:') && !connect.includes('wss:'), 'connect-src names its hosts');
});

test('every host the app fetches from is allowed by connect-src, and nothing else is needed', () => {
  const connect = directive('connect-src');
  const allowed = (origin) => connect.some((src) => {
    if (src === origin) return true;
    const m = /^(https?|wss?):\/\/\*\.(.+)$/.exec(src);
    return m && origin.startsWith(`${m[1]}://`) && origin.endsWith(`.${m[2]}`);
  });
  // addresses that are only ever links or text, never fetched
  const LINK_ONLY = new Set(['https://www.binance.com', 'https://www.gate.io', 'https://www.coinbase.com', 'https://www.bybit.com', 'https://pro.kraken.com',
    'https://github.com', 'https://umer-78.github.io', 'https://you.github.io', 'https://schema.org', 'http://www.w3.org', 'https://fonts.gstatic.com', 'https://fonts.googleapis.com',
    'https://static.coinpaprika.com', 'http://localhost:11434', 'http://localhost:*', 'http://127.0.0.1:*']);
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(root, 'js'));
  const unused = fs.readFileSync(path.join(root, 'js/api/UNUSED.md'), 'utf8');
  const missing = new Set();
  for (const f of files) {
    if (unused.includes(path.basename(f))) continue; // not loaded by the app
    for (const [origin] of fs.readFileSync(f, 'utf8').matchAll(/(?:https?|wss?):\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d+)?/g)) {
      if (!LINK_ONLY.has(origin) && !allowed(origin)) missing.add(`${origin} (${path.relative(root, f)})`);
    }
  }
  assert.deepEqual([...missing], []);
  for (const host of AI_ENDPOINT_HOSTS) assert.ok(allowed(`https://${host}`), `AI provider ${host} is in connect-src`);
});

test('every generated page carries the same CSP as the template', () => {
  for (const rel of ['ai', 'learn', 'trader', 'coin/btc']) {
    const page = fs.readFileSync(path.join(root, rel, 'index.html'), 'utf8');
    assert.equal(page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], csp, rel);
  }
});

test('a custom AI endpoint must be this computer or a listed provider', () => {
  assert.deepEqual(checkEndpoint('http://localhost:11434/v1/'), { ok: true, value: 'http://localhost:11434/v1' });
  assert.deepEqual(checkEndpoint('https://api.openai.com/v1/chat/completions'), { ok: true, value: 'https://api.openai.com/v1' });
  assert.equal(checkEndpoint('').value, '');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://evil.example/v1', 'https://evil.example/v1', 'https://api.openai.com.evil.example/v1',
    'https://user:pw@api.openai.com/v1', 'http://api.openai.com/v1', 'https://api.openai.com/v1?x=1', 'ftp://localhost/v1', 'not a url', `https://api.openai.com/${'a'.repeat(400)}`]) {
    assert.equal(checkEndpoint(bad).ok, false, bad);
  }
});

test('model names and keys are checked', () => {
  for (const ok of ['llama3.1', 'qwen2.5:7b', 'meta-llama/Llama-3.1-8B-Instruct', 'gpt-4o-mini']) assert.ok(checkModelName(ok).ok, ok);
  for (const bad of ['<img src=x>', 'a b', '"; drop', '-x', 'x'.repeat(200)]) assert.equal(checkModelName(bad).ok, false, bad);
  assert.ok(checkApiKey('sk-abcdefgh12345').ok);
  assert.equal(checkApiKey('short').ok, false);
  assert.equal(checkApiKey('has space inside').ok, false);
});

test('settings read back from storage are cleaned, and a bad endpoint takes its key with it', () => {
  const defaults = { theme: 'dark', interval: '1h', horizon: 12, currency: 'USD', lang: 'en', digest: true, llmModel: '', llmAuto: false, customEndpoint: '', customModel: '', customKey: '' };
  const s = cleanSettings({ interval: '<script>', horizon: 'NaN', currency: 'usd!', customEndpoint: 'https://evil.example/v1', customKey: 'sk-secret-123456', customModel: '<b>', extra: 1 }, defaults);
  assert.equal(s.interval, '1h');
  assert.equal(s.horizon, 12);
  assert.equal(s.currency, 'USD');
  assert.equal(s.customEndpoint, '');
  assert.equal(s.customKey, '');
  assert.equal(s.customModel, '');
  assert.ok(!('extra' in s));
  assert.deepEqual(cleanSettings(null, defaults), defaults);
  assert.deepEqual(cleanSettings([1, 2], defaults), defaults);
});

test('outside addresses are limited to https before they reach an href or src', async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const { safeUrl, finite } = await import('../js/format.js');
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeUrl('#/coin/BTC'), '#/coin/BTC');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'http://example.com', '//evil.example', '/coinvantage/x', 'https://u:p@x.com', null, undefined, 42]) {
    assert.equal(safeUrl(bad, '#'), '#', String(bad));
  }
  assert.equal(finite('1.5'), 1.5);
  assert.equal(finite('abc', 0), 0);
  assert.equal(finite(NaN), null);
  assert.equal(finite(Infinity), null);
  assert.equal(finite(true), null);
});

test('no view writes an outside link or image without checking its scheme', () => {
  const dir = path.join(root, 'js/views');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:href|src)="\$\{esc\(([^)]*)\)\}"/g)) {
      assert.match(m[1], /^safeUrl\(/, `${f}: ${m[0]}`);
    }
  }
});
