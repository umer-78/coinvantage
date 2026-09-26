// Route smoke test: loads every page in a real browser and fails on any
// console error, page error or failed module import. Market APIs are
// unreachable from CI, so the site falls back to demo data — that is fine,
// the point is that no route throws.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8099/';
const ROUTES = [
  ['markets', '#/'],
  ['coin', '#/coin/BTC'],
  ['advice', '#/advice'],
  ['assistant', '#/ai'],
  ['trader', '#/trader'],
  ['learn', '#/learn'],
  ['scanner', '#/scanner'],
  ['track record', '#/track'],
  ['futures', '#/futures'],
  ['news', '#/news'],
  ['compare', '#/compare'],
  ['tools', '#/tools'],
  ['exchanges', '#/exchanges'],
  ['wallet', '#/wallet'],
  ['alerts', '#/alerts'],
  ['premium', '#/premium'],
  ['account', '#/account'],
  ['admin', '#/admin'],
  ['terms', '#/legal/terms'],
  ['privacy', '#/legal/privacy'],
  ['risk', '#/legal/risk'],
];

// Network noise we expect in a sandbox with no internet.
const IGNORE = /Failed to load resource|net::ERR|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|fonts\.googleapis|429|403|backend unavailable|Failed to fetch|NetworkError|Load failed|ServiceWorker|sw\.js|WebSocket connection to/i;
// Binance and Bybit geo-block some regions, and CoinGecko rate-limits; all three
// answer those with no CORS header, so the browser logs a CORS error that the
// app already handles by falling back. A CORS error from any OTHER host is still
// reported — that is how a browser-unreadable endpoint gets caught.
const GEO_CORS = /blocked by CORS policy/i;
const GEO_HOSTS = /(fapi\.binance\.com|api\.bybit\.com|api\.coingecko\.com)/i;

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
let current = '';

page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (IGNORE.test(text)) return;
  if (GEO_CORS.test(text) && GEO_HOSTS.test(text.split(' from origin')[0])) return;
  problems.push(`[${current}] console: ${text}`);
});
page.on('pageerror', (e) => { problems.push(`[${current}] pageerror: ${e.message}`); });

// The first-visit risk disclosure is modal by design; accept it up front so the
// test exercises the pages behind it.
await page.addInitScript(() => { try { localStorage.setItem('cv:riskAck', 'true'); } catch { /* private mode */ } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

for (const [name, hash] of ROUTES) {
  current = name;
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(1800);
  const view = await page.$eval('#view', (el) => el.textContent.trim().length).catch(() => 0);
  if (view < 20) problems.push(`[${name}] rendered almost nothing (${view} chars)`);
  const crashed = await page.$eval('#view', (el) => el.innerHTML.includes('Something went wrong')).catch(() => false);
  if (crashed) problems.push(`[${name}] router error boundary was shown`);
  console.log(`${problems.some((p) => p.startsWith(`[${name}]`)) ? '✗' : '✓'} ${name} (${hash})`);
}

// Coin page tabs, including the new History & cycles study.
current = 'coin tabs';
await page.evaluate(() => { location.hash = '#/coin/BTC'; });
await page.waitForTimeout(2500);
let histText = '';
for (const tab of ['patterns', 'history', 'periods', 'backtest', 'exchanges', 'about']) {
  const btn = await page.$(`#tabs [data-tab="${tab}"]`);
  if (!btn) { problems.push(`[coin tabs] tab "${tab}" is missing`); continue; }
  await btn.click();
  await page.waitForTimeout(tab === 'history' ? 8000 : 2000);
  const txt = await page.$eval('#tabBody', (el) => el.textContent.trim()).catch(() => '');
  if (tab === 'history') histText = txt;
  if (txt.length < 30) problems.push(`[coin tabs] tab "${tab}" rendered ${txt.length} chars`);
  console.log(`  ${txt.length >= 30 ? '✓' : '✗'} tab ${tab} (${txt.length} chars)`);
}
// The history tab must publish its own measured accuracy and the actual matches,
// not just a verdict — an unfalsifiable "history says up" is what we are avoiding.
if (!/past tests/i.test(histText)) problems.push('[coin tabs] history tab did not show how often the method was right');
if (!/similar shape/i.test(histText)) problems.push('[coin tabs] history tab did not list the matching past periods');
if (!/Seasonality/i.test(histText)) problems.push('[coin tabs] history tab did not show seasonality');

await browser.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}
console.log('\nAll routes rendered with no page errors.');
