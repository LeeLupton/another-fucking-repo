/*
 * Service worker: cache the app shell so Itemizer opens offline and installs to a home screen.
 *
 * The cache name carries a version: build.js writes a hash of the shell files into STAMP and commits it,
 * so every change to the app is a new cache and a docs-only commit is not.
 *
 * A new worker waits until the page asks it to take over (see registerSW in js/app.js), so a version
 * change never swaps the cache under a running session; the page offers a reload instead. Everything is
 * served from this worker's own cache, so the page and the scripts it loads are always one generation.
 */
const PREFIX = 'itemizer-';
const STAMP = '198059f51652'; // written by build.js: a hash of the files it caches
const CACHE = PREFIX + STAMP;
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
// The app's own page, so another document on this origin is never mistaken for it.
const ROOT = new URL('./', self.location).pathname;

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a fresh worker never pins ten-minute-old copies of the files it is meant to replace
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  // Only this app's own old caches: Cache Storage is shared by every site on the origin, and on a
  // github.io user site that is every other project published from the same account.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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

/** The start page from this worker's own cache, so it always matches the scripts served alongside it. */
function cachedShell() {
  return caches.open(CACHE).then((c) => c.match('./index.html', { ignoreSearch: true }).then((res) => res || c.match('./', { ignoreSearch: true })));
}

/** True for a response that really is an HTML page, so a stray file is never stored as the start page. */
function isPage(res) {
  return !!res && res.ok && /^text\/html\b/i.test(res.headers.get('content-type') || '');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Navigations: the cached shell first, so a stalled connection cannot hold up a launch that needs no
    // network at all, and so a deploy arrives as one piece when the user accepts the waiting worker.
    // Any other document on this origin is fetched as it is and never stored as the shell.
    if (req.mode === 'navigate') {
      const isShell = url.pathname === ROOT || url.pathname === ROOT + 'index.html';
      event.respondWith(
        (isShell ? cachedShell() : Promise.resolve(null)).then((cached) => {
          const network = fetch(req).then((res) => { if (isShell && isPage(res)) remember(event, new Request('./index.html'), res); return res; });
          if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
          return network.catch(() => cachedShell().then((res) => res || Response.error()));
        })
      );
      return;
    }
    // Shell files: cache first, refreshed in the background; never resolve respondWith with nothing.
    event.respondWith(
      caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })).then((cached) => {
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
