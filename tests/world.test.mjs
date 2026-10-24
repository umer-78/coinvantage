// The 3D world behind the pages shows readings, not decoration: these check
// that what it draws follows the market (js/world/mapping.js), and that the
// page shell loads it the way the CSP allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ringCoins, ringSize, heightFor, gemFor, GEMS, FLAT_PCT, ripple, tickerChange, viewOf, VIEWS } from '../js/world/mapping.js';

const coin = (symbol, marketCap, change24h = 0, price = 1) => ({ symbol, marketCap, change24h, price });

test('the ring holds the largest coins with a price and a cap, stablecoins left out', () => {
  const list = [coin('ETH', 3e11), coin('BTC', 1.3e12), coin('USDT', 1.6e11), coin('DOGE', 2e10), coin('NOPRICE', 5e11, 0, null), coin('NOCAP', null), coin('SOL', 7e10)];
  const ring = ringCoins(list, { size: 3, stable: (s) => s === 'USDT' });
  assert.deepEqual(ring.map((c) => c.symbol), ['BTC', 'ETH', 'SOL']);
  assert.equal(ringSize(true), 28);
  assert.equal(ringSize(false), 18);
  assert.deepEqual(ringCoins(null), []);
});

test('a monolith stands taller the larger its coin, on a log scale between the smallest and largest', () => {
  const lo = 1e9, hi = 1e12;
  assert.equal(heightFor(lo, lo, hi), 1.7);
  assert.equal(heightFor(hi, lo, hi), 4.4);
  assert.ok(Math.abs(heightFor(Math.sqrt(lo * hi), lo, hi) - (1.7 + 4.4) / 2) < 1e-9, 'halfway in log terms is halfway up');
  const hs = [1e9, 5e9, 2e10, 3e11, 1e12].map((c) => heightFor(c, lo, hi));
  for (let i = 1; i < hs.length; i++) assert.ok(hs[i] > hs[i - 1]);
  assert.equal(heightFor(null, lo, hi), 1.7, 'no cap: the shortest');
  assert.equal(heightFor(5e9, 5e9, 5e9), (1.7 + 4.4) / 2, 'one size for all when every cap is the same');
});

test('the light is the last 24 hours: jade up, coral down, gold when flat, brighter the bigger the move', () => {
  assert.equal(gemFor(3).color, GEMS.up);
  assert.equal(gemFor(-3).color, GEMS.down);
  assert.equal(gemFor(FLAT_PCT / 2).kind, 'flat');
  assert.equal(gemFor(null).kind, 'flat');
  assert.ok(gemFor(5).glow > gemFor(1).glow);
  assert.equal(gemFor(-5).glow, gemFor(5).glow, 'a fall shines as bright as a rise the same size');
  assert.ok(Math.abs(gemFor(0).glow - 0.35) < 1e-9);
  assert.equal(gemFor(40).glow, 1);
});

test('the gold ripples with how much the market moved, within bounds', () => {
  assert.ok(ripple([0.1, -0.2, 0.1]) < ripple([5, -6, 4]));
  assert.equal(ripple([]), 0.12);
  assert.equal(ripple([60, -70]), 0.24);
  assert.ok(ripple([0, 0]) >= 0.08);
});

test('a live move is read from the exchange\'s 24-hour open and last price', () => {
  assert.ok(Math.abs(tickerChange({ c: '110', o: '100' }) - 10) < 1e-9);
  assert.equal(tickerChange({ c: '0', o: '100' }), null);
  assert.equal(tickerChange({}), null);
});

test('every page has a view of the ring; the Markets page orbits live', () => {
  assert.equal(viewOf('markets'), null);
  for (const [page, v] of Object.entries(VIEWS)) if (v) assert.equal(v.length, 4, page);
  const other = viewOf('tools');
  assert.equal(other.length, 4);
  assert.deepEqual(viewOf('tools'), other, 'the same page gets the same view each time');
  // far enough that the bright centrepiece never fills the screen behind a page's text
  for (const v of [...Object.values(VIEWS).filter(Boolean), other]) assert.ok(v[1] >= 20, `distance ${v[1]}`);
});

test('the page shell loads three.js through an import map the CSP allows by its hash, before any module', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(map, 'an import map');
  const hash = createHash('sha256').update(map[1]).digest('base64');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.ok(csp.includes(`'sha256-${hash}'`), 'the CSP names the import map by its hash');
  const imports = JSON.parse(map[1]).imports;
  assert.match(imports.three, /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@\d+\.\d+\.\d+\//, 'a pinned version');
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('rel="modulepreload"'), 'the map comes before the first module is fetched');
  assert.equal((html.match(/<script(?![^>]*type="(?:importmap|module|application\/ld\+json)")[^>]*>/g) || []).length, 0, 'no other inline script');
  assert.match(html, /<canvas id="world" aria-hidden="true"><\/canvas>/);
});
