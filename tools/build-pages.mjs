// Writes the pages search engines can index, sitemap.xml and robots.txt.
//
// The app routes with #/… addresses, and search engines treat every #/…
// address as the home page, so the old sitemap of #/ links gave them one page.
// Each page worth finding now gets a real address (coin/btc/, trader/, …): a
// copy of index.html with its own title, description, canonical link,
// structured data and a short text of what the page holds, plus the route it
// opens (<html data-route>). The app boots from it exactly as from index.html
// and moves the address to /#/… (js/app.js), so links inside it stay in the page.
//
// Facts in the texts are read from the tested records in js/lib, never typed
// here, so a re-measure that changes them changes the pages on the next build.
//
// usage: node tools/build-pages.mjs [--site=https://user.github.io/repo/]   write everything
//        node tools/build-pages.mjs --check  exit 1 if anything on disk is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORECAST_TESTED } from '../js/lib/forecastview.js';
import { TESTED_ACCURACY } from '../js/lib/predict.js';
import { CHART_TESTED, TESTED_COINS } from '../js/lib/autotrader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the site's address; a copy deployed elsewhere passes its own (--site=https://…/)
const arg = process.argv.find((a) => a.startsWith('--site='));
export const SITE = (arg ? arg.slice(7) : 'https://umer-78.github.io/coinvantage/').replace(/\/?$/, '/');
const BASE = new URL(SITE).pathname; // '/coinvantage/'
const check = process.argv.includes('--check');

// Names only where there is no doubt; every other coin is titled by its ticker.
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', XRP: 'XRP', SOL: 'Solana', TRX: 'TRON', ZEC: 'Zcash', DOGE: 'Dogecoin',
  XMR: 'Monero', LINK: 'Chainlink', ADA: 'Cardano', NEAR: 'NEAR Protocol', XLM: 'Stellar', BCH: 'Bitcoin Cash',
  UNI: 'Uniswap', LTC: 'Litecoin', AVAX: 'Avalanche', SUI: 'Sui', HBAR: 'Hedera', TAO: 'Bittensor', QNT: 'Quant',
  SHIB: 'Shiba Inu', CRO: 'Cronos', ENA: 'Ethena', AAVE: 'Aave', ONDO: 'Ondo', DOT: 'Polkadot', WLD: 'Worldcoin',
  MNT: 'Mantle', PEPE: 'Pepe', ICP: 'Internet Computer', ETC: 'Ethereum Classic', ARB: 'Arbitrum', JUP: 'Jupiter',
  ALGO: 'Algorand', RENDER: 'Render', KAS: 'Kaspa', ATOM: 'Cosmos', FIL: 'Filecoin', STX: 'Stacks', INJ: 'Injective',
  APT: 'Aptos', CAKE: 'PancakeSwap', PYTH: 'Pyth Network', STRK: 'Starknet', DASH: 'Dash', VET: 'VeChain',
  TIA: 'Celestia', CRV: 'Curve DAO', RAY: 'Raydium', SEI: 'Sei', BSV: 'Bitcoin SV', PENDLE: 'Pendle', BTT: 'BitTorrent',
  XTZ: 'Tezos', LDO: 'Lido DAO', OP: 'Optimism', GNO: 'Gnosis', CFX: 'Conflux', SAND: 'The Sandbox', HYPE: 'Hyperliquid',
  PI: 'Pi Network', ETHFI: 'ether.fi', FLR: 'Flare', XDC: 'XDC Network', KAIA: 'Kaia', AERO: 'Aerodrome', PENGU: 'Pudgy Penguins',
};
const VENUE = { binance: 'Binance', gate: 'Gate.io', htx: 'HTX', okx: 'OKX' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const span = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return lo === hi ? `${lo}` : `${lo}–${hi}`; };

// ---------------------------------------------------------------- measured facts
const centred = Object.values(FORECAST_TESTED.centred);
const rangeTests = centred.reduce((a, x) => a + x.tests, 0);
const facts = {
  coins: TESTED_COINS.length,
  band80: span(centred.map((x) => x.band80)),
  rangeTests: Math.round(rangeTests / 1000) * 1000,
  recheckTests: TESTED_ACCURACY.recheck?.tests,
};
const rangeLine = `Its price range is measured: the 80% range held ${facts.band80}% of the time across about ${facts.rangeTests.toLocaleString('en-US')} tests on ${facts.coins} coins.`;
const directionLine = 'No model has beaten chance at calling which way price goes next, so the page never presents a direction as a buy or sell call.';

// ---------------------------------------------------------------- pages
const SECTIONS = [
  { route: '#/', path: '', title: 'CoinVantage — Live Crypto Prices, Charts, Tested AI Forecasts & AI Trading Simulator',
    desc: `Live prices and candlestick charts for the top crypto coins, price-range forecasts tested on ${facts.coins} coins, an AI paper-trading simulator and a public track record. Every figure is measured, not promised. Not financial advice.`,
    h1: 'Live crypto prices, charts and tested AI forecasts',
    body: [`Prices and charts for the largest coins, from the exchange each one trades on (Binance first, then Gate.io and HTX). Open any coin for its chart, 13 indicators, a price-range forecast and the AI trader's signal.`, rangeLine, directionLine] },
  { route: '#/scanner', path: 'scanner/', title: 'Crypto Scanner — Indicator Scores for the Top Coins | CoinVantage',
    desc: 'Ranks the top 20 to 50 coins by how strongly their indicators agree, with the same forecast and AI signal as each coin page. Filters for rising, falling, oversold and overbought.',
    h1: 'Crypto scanner', body: ['Ranks the top coins by how strongly trend, momentum, RSI, MACD, Bollinger, Stoch RSI, volume and ADX agree right now.', 'Tested on 1.58 million candles across 106 coins, the highest readings were followed by a rise least often on every chart: the score describes the move so far, it does not predict the next one.'] },
  { route: '#/trader', path: 'trader/', title: 'AI Crypto Trading Simulator — Paper Trading with Tested Rules | CoinVantage',
    desc: `An AI trader that runs tested rules on live prices with simulated money, plus a demo account and a record of your real trades. Walk-forward results on ${facts.coins} coins are shown next to it. No orders are ever placed.`,
    h1: 'AI trading simulator',
    body: ['An AI trader that buys and sells with simulated money on live prices, using rules tested walk-forward on every coin it can trade, fees included. It places no orders on any exchange.', `On each chart the page shows what the same rules made in the test, the worst drop, and what simply holding the coins made. In the latest test (${CHART_TESTED.measuredOn}) holding made more on some charts: the page says which.`] },
  { route: '#/learn', path: 'learn/', title: 'How the AI Learns and How It Is Tested | CoinVantage',
    desc: 'Every indicator, the forecast and the AI trader are graded against what the market did. See the walk-forward tests, the live record on this device, and what was tried and rejected.',
    h1: 'How the AI learns and how it is tested', body: ['Every call the app makes is graded against what price did next, on this device and on the server. A method only takes over when it beats the current one on that record.', directionLine, rangeLine] },
  { route: '#/track', path: 'track/', title: 'Public Track Record of Every Logged Signal | CoinVantage',
    desc: 'Every signal the server logged before the outcome was known, scored against the hit rate of always calling the more common outcome.',
    h1: 'Public track record', body: ['Each signal is logged before its outcome is known and scored when the horizon passes, against the hit rate of always calling the more common outcome.'] },
  { route: '#/advice', path: 'advice/', title: 'Crypto Market Scan — Where the Evidence Is Strongest | CoinVantage',
    desc: 'A scan of your holdings and the top coins across charts, weighting every reading by how accurate it has actually been.',
    h1: 'Market scan', body: ['Reads your holdings and the top coins across several charts and weights every reading by its measured accuracy, so a reading that has never earned trust counts for little.'] },
  { route: '#/compare', path: 'compare/', title: 'Compare Crypto Coins — Performance, Volatility, Drawdown & Correlation | CoinVantage',
    desc: 'Compare up to six coins: normalised performance, volatility, maximum drawdown, return against risk and a correlation matrix.',
    h1: 'Compare coins', body: ['Up to six coins side by side: normalised performance, volatility, maximum drawdown, return against risk and how closely they move together.'] },
  { route: '#/futures', path: 'futures/', title: 'Crypto Futures — Funding Rates and Open Interest | CoinVantage',
    desc: 'Funding rates, open interest and long/short ratios for the main crypto futures markets.',
    h1: 'Crypto futures', body: ['Funding rates, open interest and long/short ratios for the main perpetual futures markets.'] },
  { route: '#/news', path: 'news/', title: 'Crypto News | CoinVantage', desc: 'Recent crypto news headlines from public sources, next to live prices and charts for the coins they mention.', h1: 'Crypto news', body: ['Recent headlines from public crypto news sources.'] },
  { route: '#/tools', path: 'tools/', title: 'Crypto Tools — Converter, DCA Backtest, Position Sizer | CoinVantage',
    desc: 'A currency converter, a dollar-cost-averaging backtest on real prices and a position sizer that keeps each trade to a set risk.',
    h1: 'Crypto tools', body: ['A converter, a dollar-cost-averaging backtest on real prices, and a position sizer that keeps each trade to the risk you set.'] },
  { route: '#/exchanges', path: 'exchanges/', title: 'Crypto Exchanges — Volume and Trust | CoinVantage', desc: 'The main crypto exchanges ranked by trading volume, and which of them the app reads live prices and candles from.', h1: 'Crypto exchanges', body: ['The main exchanges by trading volume.'] },
  { route: '#/ai', path: 'ai/', title: 'Crypto AI Assistant — Answers from Live Data | CoinVantage',
    desc: 'Ask about any coin, the market or your AI trader. Answers come from live prices and the app\'s tested models, in your browser.',
    h1: 'Crypto AI assistant', body: ['Ask about a coin, the market or your AI trader. The answers are built from live prices and the app\'s tested models, and every figure in them comes from that data, with nothing to download.'] },
  { route: '#/alerts', path: 'alerts/', title: 'Crypto Price Alerts | CoinVantage', desc: 'Set price and indicator alerts for any coin and get notified in the browser, by e-mail or on Telegram when they trigger.', h1: 'Price alerts', body: ['Set price and signal alerts for any coin.'] },
  { route: '#/wallet', path: 'wallet/', title: 'Read-only Crypto Wallet View | CoinVantage', desc: 'See a wallet\'s balances read-only. The app never asks for keys or signatures.', h1: 'Wallet', body: ['Connect a wallet read-only to see its balances. The app never asks for private keys, seed phrases or signatures.'] },
  { route: '#/premium', path: 'premium/', title: 'Free and Premium Plans | CoinVantage', desc: 'What the free plan of CoinVantage includes, what Premium adds, and what neither of them can promise about returns.', h1: 'Plans', body: ['What the free plan includes and what Premium adds.'] },
  { route: '#/legal/terms', path: 'legal/terms/', title: 'Terms of Use | CoinVantage', desc: 'The terms of use for CoinVantage: an educational tool for crypto markets, not financial advice or a trading service.', h1: 'Terms of use', body: ['The terms that apply to using CoinVantage.'] },
  { route: '#/legal/privacy', path: 'legal/privacy/', title: 'Privacy Policy | CoinVantage', desc: 'What CoinVantage stores on your device and on its server, why, for how long, and how to delete it.', h1: 'Privacy policy', body: ['What the app stores on your device and on its server, and for how long.'] },
  { route: '#/legal/risk', path: 'legal/risk/', title: 'Risk Disclosure | CoinVantage', desc: 'The risks of trading crypto and of relying on any forecast, signal or simulation, including the ones on this site.', h1: 'Risk disclosure', body: ['Crypto is volatile. No forecast, signal or simulation on this site is financial advice, and past results are not a promise.'] },
];

const universe = JSON.parse(fs.readFileSync(path.join(root, 'tools/universe.json'), 'utf8'));
const slug = (sym) => sym.toLowerCase();
const COINS = universe.coins.map((c) => {
  const sym = c.symbol, name = NAMES[sym];
  const label = name && name !== sym ? `${name} (${sym})` : sym;
  const venue = VENUE[c.venue] || c.venue;
  return {
    route: `#/coin/${sym}`, path: `coin/${slug(sym)}/`, coin: sym,
    title: `${label} Price, Live Chart & Tested AI Forecast | CoinVantage`,
    desc: `Live ${sym} price and chart from ${venue}, 13 indicators, a price-range forecast tested on ${facts.coins} coins and an AI paper-trading signal with its measured record.`,
    h1: `${label} price, chart and AI forecast`,
    body: [`The live ${sym} price and candlestick chart come from ${venue}. When you open the page the app trains its forecast models on ${sym}'s own candles, in your browser, and shows the price range they give for the next candles, the indicators and the AI trader's signal for ${sym}.`, rangeLine, directionLine],
  };
});

// ---------------------------------------------------------------- render
const template = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const swap = (html, re, to, what) => {
  if (!re.test(html)) throw new Error(`index.html: no ${what} to replace`);
  return html.replace(re, to);
};

function page(p) {
  const url = SITE + encodeURI(p.path);
  const crumbs = [{ name: 'CoinVantage', url: SITE }];
  if (p.coin) crumbs.push({ name: 'Coins', url: SITE }, { name: p.coin, url });
  else if (p.path) crumbs.push({ name: p.h1, url });
  const ld = p.path === ''
    ? [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'CoinVantage', url: SITE, description: p.desc },
      { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'CoinVantage', url: SITE, applicationCategory: 'FinanceApplication', operatingSystem: 'Any (web browser)', description: p.desc }]
    : [{ '@context': 'https://schema.org', '@type': 'WebPage', name: p.title, url, description: p.desc, isPartOf: { '@type': 'WebSite', name: 'CoinVantage', url: SITE } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) }];
  let html = template;
  html = swap(html, /<html lang="en"[^>]*>/, `<html lang="en" data-theme="dark"${p.path ? ` data-route="${esc(p.route)}"` : ''}>`, 'html tag');
  // one base for every relative address in the copy (assets, sw.js, version.txt)
  if (p.path) html = swap(html, /<meta charset="utf-8">/, `<meta charset="utf-8">\n  <base href="${BASE}">`, 'charset');
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`, 'title');
  html = swap(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(p.desc)}">`, 'description');
  html = swap(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(p.title)}">`, 'og:title');
  html = swap(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(p.desc)}">`, 'og:description');
  html = swap(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, 'og:url');
  html = swap(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, 'canonical');
  html = swap(html, /<!-- ld:start -->[\s\S]*?<!-- ld:end -->/, `<!-- ld:start -->\n${ld.map((x) => `  <script type="application/ld+json">${JSON.stringify(x)}</script>`).join('\n')}\n  <!-- ld:end -->`, 'structured data');
  const links = p.coin
    ? `<a class="btn primary" href="${p.route}">Open the live ${esc(p.coin)} chart</a> <a class="btn" href="#/trader">AI trading simulator</a> <a class="btn" href="#/learn">How it is tested</a>`
    : `<a class="btn primary" href="${p.route}">Open ${esc(p.h1.toLowerCase())}</a>`;
  const main = `<main id="view" tabindex="-1">\n        <section class="card seo-intro"><h1>${esc(p.h1)}</h1>${p.body.map((t) => `<p>${esc(t)}</p>`).join('')}<p class="row" style="gap:8px;flex-wrap:wrap">${links}</p><p class="fine">Not financial advice. Crypto is volatile; never risk money you cannot afford to lose.</p></section>\n      </main>`;
  html = swap(html, /<main id="view" tabindex="-1">[\s\S]*?<\/main>/, main, 'main');
  return html;
}

const all = [...SECTIONS, ...COINS];
const outputs = new Map();
for (const p of all) outputs.set(path.join(root, p.path, 'index.html'), page(p));

const stamp = fs.readFileSync(path.join(root, 'version.txt'), 'utf8').trim().slice(0, 8);
const lastmod = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
outputs.set(path.join(root, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${all.map((p) => `  <url><loc>${SITE}${encodeURI(p.path)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`);
outputs.set(path.join(root, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);

let stale = 0;
for (const [file, text] of outputs) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (now === text) continue;
  stale++;
  if (check) { console.error(`stale: ${path.relative(root, file)}`); continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
if (check && stale) { console.error(`${stale} file(s) out of date: run node tools/build-pages.mjs`); process.exit(1); }
console.log(check ? `pages, sitemap and robots.txt are up to date (${all.length} pages)` : `wrote ${stale} file(s); ${all.length} pages in the sitemap`);
