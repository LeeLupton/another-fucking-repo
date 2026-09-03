/*
 * Service worker: cache the app shell so Itemizer opens offline and installs to a home screen.
 *
 * The cache name carries a version. The Pages deploy stamps the placeholder below with the commit
 * hash, so every deploy invalidates the previous shell without anyone remembering to bump a number;
 * a checkout that is never stamped falls back to the fixed name after the "||".
 *
 * A new worker waits until the page asks it to take over (see registerSW in js/app.js), so a version
 * change never swaps the cache under a running session; the page offers a reload instead.
 */
const STAMP = '61fe3e7ba375'; // written by build.js (a hash of the shell) and by the deploy (the commit)
const VERSION = STAMP.startsWith('__') ? 'v7' : STAMP;
const CACHE = 'itemizer-' + VERSION;
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
  './icons/icon-maskable-512.png',
];
const FONT_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a fresh worker never pins ten-minute-old copies of the files it is meant to replace
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page posts this once the user chose "Reload" for a waiting update.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Store a good response in the cache, kept alive past respondWith by waitUntil. */
function remember(event, req, res) {
  if (!res || !res.ok) return;
  const copy = res.clone();
  event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Navigations: the network first so a deploy shows up, the cached shell when offline, whatever the URL or query string.
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req).then((res) => { remember(event, new Request('./index.html'), res); return res; })
          .catch(() => caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || caches.match('./', { ignoreSearch: true })).then((cached) => cached || Response.error()))
      );
      return;
    }
    // Shell files: cache first, refreshed in the background; never resolve respondWith with nothing.
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        const network = fetch(req).then((res) => { remember(event, req, res); return res; });
        if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
        return network.catch(() => Response.error());
      })
    );
    return;
  }

  // Google Fonts: the stylesheet and the font files are served from cache when present (stale while revalidating), so
  // the installed app keeps its typography offline instead of falling back to the system stack.
  if (FONT_HOSTS.test(url.hostname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => { remember(event, req, res); return res; });
        if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
        return network.catch(() => Response.error());
      })
    );
    return;
  }

  // Anything else (lookups): network only; nothing is cached and an offline failure surfaces to the page as a normal error.
});
