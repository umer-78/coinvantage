// The 3D world behind the pages shows readings, not decoration: these check
// that what it draws follows the market (js/world/mapping.js), and that the
// page shell loads it the way the CSP allows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ringCoins, ringSize, tokenSize, gemFor, GEMS, FLAT_PCT, ripple, breadth, tickerChange, viewOf, VIEWS, candleBars, ema, arcAngle } from '../js/world/mapping.js';

const coin = (symbol, marketCap, change24h = 0, price = 1) => ({ symbol, marketCap, change24h, price });

test('the ring holds the largest coins with a price and a cap, stablecoins left out', () => {
  const list = [coin('ETH', 3e11), coin('BTC', 1.3e12), coin('USDT', 1.6e11), coin('DOGE', 2e10), coin('NOPRICE', 5e11, 0, null), coin('NOCAP', null), coin('SOL', 7e10)];
  const ring = ringCoins(list, { size: 3, stable: (s) => s === 'USDT' });
  assert.deepEqual(ring.map((c) => c.symbol), ['BTC', 'ETH', 'SOL']);
  assert.equal(ringSize(true), 28);
  assert.equal(ringSize(false), 18);
  assert.deepEqual(ringCoins(null), []);
});

test('a token is bigger the larger its coin, on a log scale between the smallest and largest', () => {
  const lo = 1e9, hi = 1e12;
  assert.equal(tokenSize(lo, lo, hi), 0.36);
  assert.equal(tokenSize(hi, lo, hi), 0.86);
  assert.ok(Math.abs(tokenSize(Math.sqrt(lo * hi), lo, hi) - (0.36 + 0.86) / 2) < 1e-9, 'halfway in log terms is halfway');
  const ss = [1e9, 5e9, 2e10, 3e11, 1e12].map((c) => tokenSize(c, lo, hi));
  for (let i = 1; i < ss.length; i++) assert.ok(ss[i] > ss[i - 1]);
  assert.equal(tokenSize(null, lo, hi), 0.36, 'no cap: the smallest');
  assert.equal(tokenSize(5e9, 5e9, 5e9), (0.36 + 0.86) / 2, 'one size for all when every cap is the same');
});

test('the 3D chart is the real candles scaled like a price axis: lowest low at the floor, highest high at the top', () => {
  const candles = [
    { t: 1, o: 100, h: 110, l: 90, c: 105 },
    { t: 2, o: 105, h: 106, l: 95, c: 96 },
    { t: 3, o: 96, h: 120, l: 96, c: 96 },
    { t: 4, o: NaN, h: 1, l: 1, c: 1 },
  ];
  const bars = candleBars(candles, { floor: 1, top: 4 });
  assert.equal(bars.length, 3, 'a candle with a missing price is left out');
  assert.equal(bars[0].wickLo, 1, 'the lowest low at the floor');
  assert.equal(bars[2].wickHi, 4, 'the highest high at the top');
  assert.deepEqual(bars.map((b) => b.up), [true, false, true]);
  assert.ok(bars[2].bodyHi - bars[2].bodyLo >= 0.03 - 1e-12, 'a doji keeps a sliver of body');
  assert.ok(Math.abs(bars[0].close - (1 + (105 - 90) / 30 * 3)) < 1e-9);
  assert.deepEqual(candleBars([]), []);
});

test('the chart runs oldest to newest left to right, and its average line follows the closes', () => {
  assert.ok(arcAngle(0, 10) < 0 && arcAngle(9, 10) > 0, 'oldest on the left, newest on the right');
  assert.equal(arcAngle(0, 1), 0);
  assert.ok(Math.abs(arcAngle(0, 5, 2) + 1) < 1e-12 && Math.abs(arcAngle(4, 5, 2) - 1) < 1e-12);
  const e = ema([10, 10, 10, 20], 3);
  assert.deepEqual(e.slice(0, 3), [10, 10, 10]);
  assert.equal(e[3], 15, 'k = 2/(3+1)');
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

test('the world is livelier the more the market moved, and its drift is coloured by how many coins rose', () => {
  assert.ok(ripple([0.1, -0.2, 0.1]) < ripple([5, -6, 4]));
  assert.equal(ripple([]), 0.12);
  assert.equal(ripple([60, -70]), 0.24);
  assert.ok(ripple([0, 0]) >= 0.08);
  assert.equal(breadth([1, -1, 2, 3]), 0.75);
  assert.equal(breadth([]), 0.5);
});

test('a live move is read from the exchange\'s 24-hour open and last price', () => {
  assert.ok(Math.abs(tickerChange({ c: '110', o: '100' }) - 10) < 1e-9);
  assert.equal(tickerChange({ c: '0', o: '100' }), null);
  assert.equal(tickerChange({}), null);
});

test('every page has a view of the world; the Markets page orbits live', () => {
  assert.equal(viewOf('markets'), null);
  for (const [page, v] of Object.entries(VIEWS)) if (v) assert.equal(v.length, 4, page);
  const other = viewOf('tools');
  assert.equal(other.length, 4);
  assert.deepEqual(viewOf('tools'), other, 'the same page gets the same view each time');
  // far enough that the bright coin never fills the screen behind a page's text
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
