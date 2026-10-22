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
import { appendFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'https://umer-78.github.io/coinvantage/').replace(/\/?$/, '/');
const COINS = (process.argv[3] || 'BTC,ETH,SOL,XRP,DOGE,BNB,SHIB,PEPE,QNT,ZEC,HYPE,XMR,LEO,GT,BTT').split(',');
const CHARTS = (process.argv[4] || '1m,5m,15m,1h,4h,1d').split(',');

const browser = await chromium.launch();
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

const rows = [];
for (const sym of COINS) {
  for (const iv of CHARTS) {
    errors.length = 0;
    await page.goto(`${BASE}#/coin/${encodeURIComponent(sym)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const btn = await page.$(`#ivSeg button[data-v="${iv}"]`);
    if (btn) await btn.click();
    const src = await textOf('#srcChip', /\S/, 20000);
    const sig = await textOf('#signalCard', /score|Score|wait|BUY|SELL|HOLD|trend/i, 25000);
    const fc = await textOf('#fcCard', /range|Range|chance|%/, 40000);
    const chart = await ink('#chart canvas');
    const ai = await page.evaluate(() => document.querySelector('.ai-signal')?.innerText || '').catch(() => '');
    const learn = await page.evaluate(() => [...document.querySelectorAll('#fcCard dt')].some((d) => /AI learning/.test(d.textContent))).catch(() => false);
    const problems = [];
    if (!/Binance|Gate|HTX|OKX/i.test(src)) problems.push(`source: ${short(src) || 'none'}`);
    if (chart < 50) problems.push('chart not drawn');
    if (!/score|wait|BUY|SELL|HOLD/i.test(sig)) problems.push(`signal: ${short(sig) || 'empty'}`);
    if (!/range|chance/i.test(fc)) problems.push(`forecast: ${short(fc) || 'empty'}`);
    if (/could not|cannot|unavailable|failed/i.test(fc)) problems.push(`forecast says: ${short(fc.match(/[^.]*(could not|cannot|unavailable|failed)[^.]*/i)?.[0] || '')}`);
    if (['15m', '1h', '4h', '1d'].includes(iv) && !ai) problems.push('no AI signal');
    if (!learn && /Binance|Gate|HTX|OKX/i.test(src)) problems.push('no learning check');
    if (errors.length) problems.push(`page error: ${errors[0]}`);
    rows.push({ sym, iv, src: short(src).slice(0, 40), ok: !problems.length, problems });
    console.log(`${sym.padEnd(6)} ${iv.padEnd(4)} ${problems.length ? '✗ ' + problems.join(' · ') : '✓'}  [${short(src).slice(0, 40)}]`);
  }
}

// pages that read many coins at once
const pages = [
  ['scanner', '#/scanner', '#tbl', /Scanned \d+ coins|tbody/i, 90000],
  ['advice', '#/advice', '#view', /scanned|no edge|BUY|AVOID|leans/i, 120000],
  ['learn', '#/learn', '#view', /calls logged|scored|release test/i, 30000],
  ['track record', '#/track', '#view', /graded|resolved|signals|record/i, 30000],
  ['trader', '#/trader', '#view', /Start the trader|Catch up now|Balance now/i, 30000],
];
for (const [name, hash, sel, re, ms] of pages) {
  errors.length = 0;
  await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' });
  const t = await textOf(sel, re, ms);
  const ok = re.test(t) && !errors.length;
  console.log(`page ${name.padEnd(13)} ${ok ? '✓' : `✗ ${errors[0] || short(t) || 'nothing read'}`}`);
  rows.push({ sym: `page:${name}`, iv: '', ok, problems: ok ? [] : [errors[0] || short(t) || 'nothing read'] });
}
await browser.close();

const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length} of ${rows.length} read everything`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live data check\n${rows.length - bad.length} of ${rows.length} read everything.\n\n${bad.length ? bad.map((r) => `- ${r.sym} ${r.iv}: ${r.problems.join(' · ')}`).join('\n') : 'No problems.'}\n`);
}
