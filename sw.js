// Offline shell for CoinVantage.
// Market data is never cached — only the app's own files, so the site opens
// instantly and still loads on a flaky connection. Bump VERSION on each release.
const VERSION = "cv-20260926-170339";
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './icon.svg', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Same-origin app files only. Exchange APIs, Supabase and CDNs always go to the network.
  if (url.origin !== location.origin) return;

  // version.txt is the freshness probe the app uses to decide whether a new
  // build shipped. It must never be served from here: it is requested with a
  // fresh ?t= every time, so caching it grew the cache by one dead entry per
  // check, and answering it from the cache is what made the app believe a new
  // build existed while offline.
  if (url.pathname.endsWith('/version.txt')) return;

  // Network first so a new deploy is picked up immediately; cache is the fallback.
  // `no-cache` forces a revalidation with the server on every app file. Without
  // it the browser's own 10-minute HTTP cache keeps serving yesterday's modules
  // after a deploy, which looks exactly like the update never shipped. The
  // server answers 304 when nothing changed, so this costs almost nothing.
  e.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      })
      // Offline. A page navigation falls back to the app shell so the site still
      // opens; anything else returns its own cached copy or fails honestly.
      // Handing index.html to a request for a script or a data file made
      // callers read an HTML document as if it were their own content.
      .catch(() => caches.match(request).then((hit) => {
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      })),
  );
});
