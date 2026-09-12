// Writes sitemap.xml and points robots.txt at it.
// Usage: node tools/build-sitemap.mjs https://your-domain.example/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || '').replace(/\/?$/, '/');
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node tools/build-sitemap.mjs https://your-domain.example/');
  process.exit(1);
}

const COINS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'AVAX', 'LINK', 'DOT', 'MATIC', 'LTC', 'SHIB', 'TON', 'BCH', 'NEAR', 'UNI', 'ICP', 'APT'];
const PAGES = ['', '#/scanner', '#/track', '#/futures', '#/news', '#/compare', '#/exchanges', '#/wallet', '#/alerts', '#/ai', '#/premium', '#/legal/terms', '#/legal/privacy', '#/legal/risk'];
const today = new Date().toISOString().slice(0, 10);

const urls = [
  ...PAGES.map((p) => ({ loc: base + p, pri: p === '' ? '1.0' : '0.6' })),
  ...COINS.map((c) => ({ loc: `${base}#/coin/${c}`, pri: '0.8' })),
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`;
fs.writeFileSync(path.join(root, 'sitemap.xml'), xml);
fs.writeFileSync(path.join(root, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${base}sitemap.xml\n`);
console.log(`Wrote sitemap.xml with ${urls.length} URLs and pointed robots.txt at ${base}sitemap.xml`);
