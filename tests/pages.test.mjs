import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://umer-78.github.io/coinvantage/';

test('every address in the sitemap is a real page search engines can index, with its own title and canonical link', () => {
  const xml = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 100, 'sections and every tested coin');
  assert.ok(locs.every((l) => l.startsWith(SITE) && !l.includes('#')), 'no #/ addresses: search engines read them all as the home page');
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const views = [...app.match(/const VIEWS = \{([\s\S]*?)\};/)[1].matchAll(/^\s*'?([a-z]*)'?:/gm)].map((m) => m[1]);
  const titles = new Set();
  for (const loc of locs) {
    const rel = decodeURI(loc.slice(SITE.length));
    const html = fs.readFileSync(path.join(root, rel, 'index.html'), 'utf8');
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    assert.ok(!titles.has(title), `duplicate title ${title}`);
    titles.add(title);
    assert.match(html, new RegExp(`<link rel="canonical" href="${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`), `${rel}: canonical points at itself`);
    const desc = html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(desc.length >= 50 && desc.length <= 230, `${rel}: description length ${desc.length}`);
    assert.match(html, /<script type="application\/ld\+json">/, `${rel}: structured data`);
    assert.match(html, /<main id="view" tabindex="-1">\s*<section class="card seo-intro"><h1>/, `${rel}: readable text before the app runs`);
    if (rel) {
      assert.match(html, /<base href="\/coinvantage\/">/, `${rel}: one base for the copied relative addresses`);
      const route = html.match(/data-route="#\/([^"/]*)/)[1];
      assert.ok(views.includes(route), `${rel}: route ${route} is a page`);
    }
  }
  assert.match(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8'), new RegExp(`Sitemap: ${SITE}sitemap.xml`));
});
