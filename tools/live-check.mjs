// usage: node tools/live-check.mjs [siteUrl] [coins] [charts]
//
// Opens the deployed site with live market data and reports, for each coin
// and chart, whether every part of the coin page actually read its data: the
// candle chart, the source, the signal, the forecast with its ranges, the
// timing, the AI signal and the learning check. Then the pages that read many
// coins at once (scanner, advice), the learning page and the track record.
// Nothing is mocked: what fails here fails for a visitor. It reports and does
// not fail the job, because an exchange being down for a minute is not a bug.
import { chromium } from 'playwright';
import { appendFileSync, readFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'https://umer-78.github.io/coinvantage/').replace(/\/?$/, '/');
const COINS = (process.argv[3] || 'BTC,ETH,SOL,XRP,DOGE,BNB,SHIB,PEPE,QNT,ZEC,HYPE,XMR,LEO,GT,BTT').split(',');
const CHARTS = (process.argv[4] || '1m,5m,15m,1h,4h,1d').split(',');

// PW_CHANNEL=chrome uses the machine's own Chrome (the Actions runner has one)
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
await ctx.addInitScript(() => { try { localStorage.setItem('cv:riskAck', 'true'); } catch { /* private mode */ } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));

// Wait until the text of `sel` matches `re` (or time runs out); return the text.
async function textOf(sel, re, ms) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) {
    t = await page.evaluate((s) => document.querySelector(s)?.innerText || '', sel).catch(() => '');
    if (re.test(t)) return t;
    await page.waitForTimeout(500);
  }
  return t;
}
const ink = (sel) => page.evaluate((s) => {
  const c = document.querySelector(s);
  if (!c) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 64) if (d[i]) n++;
  return n;
}, sel).catch(() => 0);
const short = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 120);
// The last price on the exchange the site reads the coin from (tools/universe.json),
// in USD. Binance was asked first for every coin, and still answers for pairs it
// delisted long ago (XMR at 118.7 against 610 on HTX), so a coin is asked only
// where it trades.
const VENUE = Object.fromEntries(JSON.parse(readFileSync(new URL('./universe.json', import.meta.url), 'utf8')).coins.map((c) => [c.symbol, c.venue]));
async function exchangePrice(sym) {
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const venue = VENUE[sym] || 'binance';
  if (venue === 'binance') { const b = await get(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}USDT`); return b?.price ? +b.price : null; }
  if (venue === 'gate') { const g = await get(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${sym}_USDT`); return Array.isArray(g) && g[0]?.last ? +g[0].last : null; }
  if (venue === 'htx') { const h = await get(`https://api.huobi.pro/market/detail/merged?symbol=${sym.toLowerCase()}usdt`); return h?.tick?.close ? +h.tick.close : null; }
  const o = await get(`https://www.okx.com/api/v5/market/ticker?instId=${sym}-USDT`);
  return o?.data?.[0]?.last ? +o.data[0].last : null;
}

const rows = [];
for (const sym of COINS) {
  for (const iv of CHARTS) {
    errors.length = 0;
    await page.goto(`${BASE}#/coin/${encodeURIComponent(sym)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const btn = await page.$(`#ivSeg button[data-v="${iv}"]`);
    if (btn) await btn.click();
    const src = await textOf('#srcChip', /Binance|Gate|HTX|OKX|CoinGecko|demo/i, 25000);
    const sig = await textOf('#signalCard', /score|Score|wait|BUY|SELL|HOLD|trend/i, 25000);
    const fc = await textOf('#fcCard', /range|Range|chance|%/, 40000);
    const chart = await ink('#chart canvas');
    const ai = await page.evaluate(() => document.querySelector('.ai-signal')?.innerText || '').catch(() => '');
    const learn = await page.evaluate(() => [...document.querySelectorAll('dt')].some((d) => /AI learning/.test(d.textContent))).catch(() => false);
    // the price shown against the exchange's own last price, read at the same moment
    const shown = await page.evaluate(() => document.querySelector('#px')?.textContent || '').catch(() => '');
    const problems = [];
    if (!/Binance|Gate|HTX|OKX/i.test(src)) problems.push(`source: ${short(src) || 'none'}`);
    if (chart < 50) problems.push('chart not drawn');
    if (!/score|wait|BUY|SELL|HOLD/i.test(sig)) problems.push(`signal: ${short(sig) || 'empty'}`);
    if (!/range|chance/i.test(fc)) problems.push(`forecast: ${short(fc) || 'empty'}`);
    if (/could not|cannot|unavailable|failed/i.test(fc)) problems.push(`forecast says: ${short(fc.match(/[^.]*(could not|cannot|unavailable|failed)[^.]*/i)?.[0] || '')}`);
    if (['15m', '1h', '4h', '1d'].includes(iv) && !ai) problems.push('no AI signal');
    if (!learn && /Binance|Gate|HTX|OKX/i.test(src)) problems.push('no learning check');
    if (errors.length) problems.push(`page error: ${errors[0]}`);
    if (iv === CHARTS[0]) {
      const ref = await exchangePrice(sym);
      const px = parseFloat(shown.replace(/[^0-9.]/g, ''));
      if (ref && Number.isFinite(px) && px > 0 && Math.abs(px / ref - 1) > 0.01) problems.push(`price ${shown} is ${((px / ref - 1) * 100).toFixed(2)}% off the exchange's ${ref}`);
      if (!Number.isFinite(px) || px <= 0) problems.push(`price not shown (${short(shown) || 'empty'})`);
    }
    rows.push({ sym, iv, src: short(src).slice(0, 40), ok: !problems.length, problems });
    console.log(`${sym.padEnd(6)} ${iv.padEnd(4)} ${problems.length ? '✗ ' + problems.join(' · ') : '✓'}  [${short(src).slice(0, 40)}]`);
  }
}

// pages that read many coins at once
const pages = [
  ['markets list', '#/', '#mkSummary', /\d+ coins|Live prices/i, 30000, '#mkt tbody tr[data-sym]', 50],
  ['scanner', '#/scanner', '#view', /Scanned \d+ coins|coins scanned|scanned/i, 90000, 'tbody tr', 10],
  ['advice', '#/advice', '#view', /scanned|no edge|BUY|AVOID|leans/i, 120000],
  // the learning page must read the cloud's record, not fall back to this browser
  ['learn', '#/learn', '#status', /Learning in the cloud/i, 30000],
  ['track record', '#/track', '#view', /graded|resolved|signals|record/i, 30000],
  ['trader', '#/trader', '#view', /Start the trader|Catch up now|Balance now/i, 30000],
];
for (const [name, hash, sel, re, ms, rowSel, minRows] of pages) {
  errors.length = 0;
  await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });
  const t = await textOf(sel, re, ms);
  // a page that lists coins must list them: count its rows
  let n = null;
  if (rowSel) {
    const end = Date.now() + ms;
    while (Date.now() < end && (n = await page.evaluate((s) => document.querySelectorAll(s).length, rowSel).catch(() => 0)) < minRows) await page.waitForTimeout(1000);
  }
  const problem = errors[0] || (!re.test(t) ? short(t) || 'nothing read' : null) || (rowSel && n < minRows ? `${n} rows listed, expected ${minRows}+` : null);
  console.log(`page ${name.padEnd(13)} ${problem ? `✗ ${problem}` : `✓${rowSel ? ` (${n} rows)` : ''}`}`);
  rows.push({ sym: `page:${name}`, iv: '', ok: !problem, problems: problem ? [problem] : [] });
}
// The 3D world: three.js must come through the page's CSP and import map from the
// CDN. A runner without a GPU may have no WebGL, which the page handles (no-webgl);
// a world that fails to load where WebGL works is the failure.
{
  const blocked = [];
  const onConsole = (m) => { if (m.type() === 'error' && /Content Security Policy|import ?map|three/i.test(m.text())) blocked.push(m.text().slice(0, 160)); };
  page.on('console', onConsole);
  errors.length = 0;
  await page.goto(`${BASE}#/`, { waitUntil: 'domcontentloaded' });
  const end = Date.now() + 30000;
  let state = '';
  while (Date.now() < end && !(state = await page.evaluate(() => (document.documentElement.classList.contains('webgl') ? 'webgl' : document.documentElement.classList.contains('no-webgl') ? 'no-webgl' : '')))) await page.waitForTimeout(500);
  const gl = await page.evaluate(() => { try { return Boolean(document.createElement('canvas').getContext('webgl2')); } catch { return false; } });
  const problem = blocked[0] || errors[0] || (!state ? 'never started' : state === 'no-webgl' && gl ? 'WebGL works but the world did not load' : null);
  console.log(`page ${'3D world'.padEnd(13)} ${problem ? `✗ ${problem}` : `✓ (${state}${gl ? '' : ', no WebGL on this machine'})`}`);
  rows.push({ sym: 'page:3D world', iv: '', ok: !problem, problems: problem ? [problem] : [] });
  page.off('console', onConsole);
}
await browser.close();

const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length} of ${rows.length} read everything`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live data check\n${rows.length - bad.length} of ${rows.length} read everything.\n\n${bad.length ? bad.map((r) => `- ${r.sym} ${r.iv}: ${r.problems.join(' · ')}`).join('\n') : 'No problems.'}\n`);
}
