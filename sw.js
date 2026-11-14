/*
 * Service worker: cache the app shell so Itemizer opens offline and installs to a home screen.
 *
 * build.js writes SHELL and STAMP below; they are committed with the files they describe and neither is
 * edited by hand. SHELL is every file of the app with the SHA-256 of its bytes. STAMP is a hash of this file
 * once SHELL is in it, so the cache name moves when any byte of the app does, and a docs-only commit leaves
 * it alone.
 *
 * One cache holds one build. Installing fetches every file and checks it against its hash before anything is
 * stored, so a copy from some other deploy fails the install and the browser tries again at its next update
 * check. After that no file of the shell is replaced, by the network or by a later build: what the cache
 * holds of the page and its scripts is one generation, and the next deploy arrives whole, in a cache of its
 * own. A file the cache has lost is fetched again, and kept only if it is this build's (see restore). The
 * two typefaces from Google are kept in the same cache and are the one thing in it that is refreshed.
 *
 * A new worker waits until the page asks it to take over (see registerSW in js/app.js), so a version
 * change never swaps the cache under a running session; the page offers a reload instead.
 */
const PREFIX = 'itemizer-'; // every cache this app has made; activation drops all of them but its own
// 'checked' in a name marks a cache of this design: filled once, from files that passed their hash. A cache named
// with the stamp alone belongs to a worker from before it, which refreshes its own cache (see bringAlong).
const CHECKED = PREFIX + 'checked-';
const STAMP = 'b3b6e299572e'; // written by build.js: a hash of this file, SHELL included
const CACHE = CHECKED + STAMP;
// written by build.js: each file of the shell and the SHA-256 of its bytes
const SHELL = {
  './': '69609198a8f4eca223ed639557c9612f26e555b3844e47997640f81a4f1fda18',
  './index.html': '69609198a8f4eca223ed639557c9612f26e555b3844e47997640f81a4f1fda18',
  './styles.css': '27da1fd9d5264d855d2476390b1d3e8b9e2dd7cd5ce8b54e463c73167222d39d',
  './manifest.webmanifest': 'fc3e1795609872b77663432860305174af0865fc6fb5826af1ddeb29b69859a4',
  './js/schema.js': '7bd6a5243dc924c8db006d84ab659acf1d4a0e16a446ad8b0793e8b8e33de059',
  './js/rules.js': '23375e12144d6fc51a452bad88635fcdf5e5956d8f7b841d26328c94acfb085c',
  './js/parse.js': 'dbcd7989cebae8aa74be3f09572cbe2b03214495451c8385dc0dcec16150019c',
  './js/classify.js': '242b054b20014faea78ae523a738609b01f0d5213f55c86a3069bff8d076ffdd',
  './js/advisor.js': 'a75b1c40996dd76443fb8636827fbdfe26754c6f17e48190cc28ab030a347a60',
  './js/geo.js': 'd6683002ad011afae581c65270b75b7b2fd39efacd4b3ebbf61741598807463b',
  './js/importer.js': 'f2c090158982a9cf6225830cb07da5b59aaec4172d9b20e9671cbe008c92b356',
  './js/money.js': '0c990a1e42014ef60ff76e9846a8c9448e7ad1b6bd0e4644fd727ce361f6d46f',
  './js/money-import.js': '7a586b2feb4193f40cdb9c3ac96297c603c5781ad8491dd0d283add5cda40e77',
  './js/valuation.js': 'd942b0d16c0c82f98949654a15f2b5b4a1623cd92d3b72815494bf9ee7e18e62',
  './js/experiments.js': '23137b3296639f7dbf45df54e97d326a2e9e65ea5452ae10c0666dfa88e3944d',
  './js/store.js': 'ceb74ad4cee3fb2ca12e76a94246056dc633cca197ccb727f9fca01181c28401',
  './js/money-app.js': '2480df770bcb9512242921480f46a0f6fb4dd721d46ceeff61c8c63ace70b50c',
  './js/app.js': 'f5e59d5a7d6bb37e2e390b423681ecdd47f0e8a1eab929684a7e653b256aa3f6',
  './icons/icon.svg': 'c007aa297b7187a88c8bd93f527d604e046470214b8bedddf0f12ed4bc2b90ee',
  './icons/icon-192.png': 'f1b04874e36eadba9f3bafb8cab38e7cae4b030a20b184ebac43002684a6e34c',
  './icons/icon-512.png': 'f7d7f3bfe1af73029f37997513752cf0749c80e10c8f4871f93691a843e44490',
  './icons/icon-maskable-512.png': '0948e1acaa246bb59bce2c2dae67288934d34f836759fffdbf2215abfffd0232',
};
const FONT_HOSTS = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/;
// The app's own page, so another document on this origin is never mistaken for it.
const ROOT = new URL('./', self.location).pathname;

/** Whether a response carries, byte for byte, the file this version was built from. The response is left unread. */
function isBuilt(key, res) {
  if (!SHELL[key] || !res || !res.ok) return Promise.resolve(false);
  return res.clone().arrayBuffer().then((bytes) => crypto.subtle.digest('SHA-256', bytes)).then((sum) =>
    Array.from(new Uint8Array(sum), (b) => b.toString(16).padStart(2, '0')).join('') === SHELL[key]);
}

/**
 * A response as a launch can be given it. A browser refuses a redirected response for a navigation, and nothing
 * here is ever fetched a second time, so a file that was redirected on its way (a server that sends /index.html
 * to /) is stored as a plain copy of the same bytes.
 */
function plain(res) {
  return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a fresh worker is never checked against ten-minute-old copies of the files it is meant to replace
  const files = Object.keys(SHELL).map((key) => fetch(new Request(key, { cache: 'reload' })).then((res) => isBuilt(key, res).then((yes) => {
    if (!yes) throw new Error(key + (res.ok ? ' is not the file this version was built from' : ' answered ' + res.status));
    return [key, res];
  })));
  // Nothing is stored until every file has passed, so a launch can never read a shell that is half one deploy.
  event.waitUntil(Promise.all(files).then((all) => caches.has(CACHE).then((had) => caches.open(CACHE).then((mine) =>
    Promise.allSettled(all.map(([key, res]) => mine.put(key, plain(res)))).then((puts) => {
      const failed = puts.find((p) => p.status === 'rejected');
      if (!failed) return bringAlong(mine);
      // Out of room part-way: what did get written would sit there, taking space the app's own records need.
      // A cache that was here before this install is left alone; it is this same build, and may be in use.
      return (had ? Promise.resolve() : caches.delete(CACHE)).then(() => { throw failed.reason; });
    })))));
});

/**
 * A worker from before this design refreshes its own cache from the network, one file at a time, and only the
 * files a page asks for. While this worker waits, that one is still in control: it moves to this build's page by
 * itself and then serves a page whose new scripts its cache never held. Online they arrive; offline the launch is
 * left without them. So its cache is brought to this build whole, here, once this build is known to be complete.
 * A cache of this design is never touched: each stays the one checked build it was installed as.
 * This never fails the install, and it can go once no worker from before this design is in use.
 */
function bringAlong(mine) {
  return caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith(PREFIX) && !n.startsWith(CHECKED)).map((n) => caches.open(n).then((theirs) =>
    Promise.all(Object.keys(SHELL).map((key) => mine.match(key).then((copy) => copy && theirs.put(key, copy))))
  )))).catch(() => {});
}

self.addEventListener('activate', (event) => {
  // Only this app's own old caches: Cache Storage is shared by every site on the origin, and on a
  // github.io user site that is every other project published from the same account.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page posts this once the user chose "Reload" for a waiting update.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Store a good response in the cache, kept alive past respondWith by waitUntil. Only the fonts are kept this way. */
function remember(event, req, res) {
  if (!res || !res.ok) return;
  const copy = res.clone();
  event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
}

/**
 * Put back a shell file the cache no longer holds (Cache Storage is shared with every site on the origin, and any
 * of them can empty it). Only the file this version was built from is kept. If the site has moved on to another
 * deploy, the page is still given what the network sent, since that is all there is, but none of it is stored:
 * until the waiting version is accepted, such a launch needs the network.
 */
function restore(event, key, res) {
  if (!SHELL[key] || !res || !res.ok) return;
  const copy = res.clone();
  event.waitUntil(isBuilt(key, copy).then((yes) => yes && caches.open(CACHE).then((c) => c.put(key, plain(copy)))).catch(() => {}));
}

/** The name SHELL has for a URL of this app, whatever its query string. */
function shellKey(url) {
  return url.pathname.startsWith(ROOT) ? './' + url.pathname.slice(ROOT.length) : '';
}

/** The start page from this worker's own cache, so it always matches the scripts served alongside it. */
function cachedShell() {
  return caches.open(CACHE).then((c) => c.match('./index.html', { ignoreSearch: true }).then((res) => res || c.match('./', { ignoreSearch: true })));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // Navigations: the cached shell, so a stalled connection cannot hold up a launch that needs no network at
    // all, and so a deploy arrives as one piece when the user accepts the waiting worker. The network is asked
    // only when the cache has no page. Any other document on this origin is fetched as it is and never stored.
    if (req.mode === 'navigate') {
      const isShell = url.pathname === ROOT || url.pathname === ROOT + 'index.html';
      event.respondWith(
        (isShell ? cachedShell() : Promise.resolve(null)).then((cached) => cached ||
          fetch(req).then((res) => { if (isShell) restore(event, './index.html', res); return res; })
            .catch(() => cachedShell().then((res) => res || Response.error())))
      );
      return;
    }
    // Shell files: from this build's cache, which no later deploy is written into. The network is asked only
    // for a file the cache has lost; never resolve respondWith with nothing.
    event.respondWith(
      caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })).then((cached) => cached ||
        fetch(req).then((res) => { restore(event, shellKey(url), res); return res; }).catch(() => Response.error()))
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
