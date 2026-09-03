/* Service worker: cache the app shell so Itemizer opens offline and installs to a home screen. */
const CACHE = 'itemizer-v6';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/schema.js',
  './js/rules.js',
  './js/parse.js',
  './js/classify.js',
  './js/advisor.js',
  './js/geo.js',
  './js/importer.js',
  './js/valuation.js',
  './js/experiments.js',
  './js/store.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Same-origin shell files: cache first, then network (and refresh the cache in the background).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => { if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }
  // Fonts and anything else: network, falling back to whatever is cached.
  event.respondWith(fetch(req).then((res) => { if (res && res.ok && url.hostname.endsWith('gstatic.com')) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; }).catch(() => caches.match(req)));
});
