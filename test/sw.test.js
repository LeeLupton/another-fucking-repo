const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Load sw.js into a fake service-worker global with an in-memory Cache Storage and a scripted fetch. */
function loadSW(fetchImpl) {
  const handlers = {};
  const store = new Map(); // cacheName -> Map(urlKey -> Response)
  const keyOf = (req, opts) => { const u = new URL(typeof req === 'string' ? new URL(req, 'https://example.test/app/').href : req.url); if (opts && opts.ignoreSearch) u.search = ''; return u.href; };
  const openCache = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      put: async (req, res) => { m.set(keyOf(req), res); },
      match: async (req, opts) => { const r = m.get(keyOf(req, opts)); return r ? r.clone() : undefined; },
      addAll: async (reqs) => { for (const r of reqs) { const res = await fetchImpl(r); if (!res.ok) throw new Error('addAll failed for ' + (r.url || r)); m.set(keyOf(r), res); } },
    };
  };
  const caches = {
    open: async (name) => openCache(name),
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (req, opts) => { for (const m of store.values()) { const r = m.get(keyOf(req, opts)); if (r) return r.clone(); } return undefined; },
  };
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => { self.skipped = true; }, clients: { claim: async () => { self.claimed = true; } }, location: new URL('https://example.test/app/sw.js') };
  // In a worker, relative URLs resolve against the scope; Node's Request needs that done for it.
  class ScopedRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, 'https://example.test/app/').href : input, init); } }
  const ctx = { self, caches, fetch: fetchImpl, Request: ScopedRequest, Response, URL, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8'), ctx);
  return { handlers, self, caches, store };
}
const ok = (body, type) => new Response(body, { status: 200, headers: { 'Content-Type': type || 'text/plain' } });
// Node cannot construct a Request in navigate mode, so events carry a plain request-like object.
const fetchEvent = (url, init) => {
  const req = Object.assign({ url, method: 'GET', mode: 'cors', cache: 'default' }, init || {});
  let response = null; const waits = [];
  return { req, event: { request: req, respondWith: (p) => { response = Promise.resolve(p); }, waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); } }, response: () => response, settled: () => Promise.all(waits) };
};

test('install precaches the shell bypassing the HTTP cache, and the cache name carries a version', async () => {
  const seen = [];
  const { handlers, self, caches } = loadSW(async (req) => { const r = typeof req === 'string' ? new Request(req) : req; seen.push(r); return ok('x'); });
  const waits = [];
  await handlers.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(seen.length > 15, 'the shell files were fetched');
  assert.ok(seen.every((r) => r.cache === 'reload'), 'every precache request bypasses the HTTP cache');
  assert.ok(seen.some((r) => /icon-maskable-512\.png$/.test(r.url)), 'the maskable icon is part of the shell');
  const names = await caches.keys();
  assert.equal(names.length, 1);
  assert.match(names[0], /^itemizer-/);
  assert.equal(self.skipped, undefined, 'the new worker waits instead of taking over a running page');
});

test('offline navigation to any same-origin URL falls back to the cached shell; nothing ever resolves to undefined', async () => {
  const { handlers, caches } = loadSW(async () => { throw new TypeError('offline'); });
  const c = await caches.open('itemizer-test');
  await c.put(new Request('https://example.test/app/index.html'), ok('<html>shell</html>', 'text/html'));
  const nav = fetchEvent('https://example.test/app/?source=pwa', { mode: 'navigate' });
  handlers.fetch(nav.event);
  const res = await nav.response();
  assert.ok(res instanceof Response);
  assert.equal(await res.text(), '<html>shell</html>');
  const miss = fetchEvent('https://example.test/app/js/nothing.js');
  handlers.fetch(miss.event);
  const r2 = await miss.response();
  assert.ok(r2 instanceof Response, 'respondWith receives a Response, not undefined');
  assert.equal(r2.type, 'error');
});

test('same-origin assets are served from cache ignoring the query string, and refreshed under waitUntil', async () => {
  let calls = 0;
  const { handlers, caches } = loadSW(async () => { calls++; return ok('fresh'); });
  const c = await caches.open('itemizer-test');
  await c.put(new Request('https://example.test/app/js/app.js'), ok('stale'));
  const ev = fetchEvent('https://example.test/app/js/app.js?v=2');
  handlers.fetch(ev.event);
  const res = await ev.response();
  assert.equal(await res.text(), 'stale');
  await ev.settled();
  assert.equal(calls, 1, 'the network refresh ran and was kept alive with waitUntil');
});

test('Google Fonts CSS and font files are cached and served cache-first', async () => {
  let calls = 0;
  const { handlers, caches } = loadSW(async () => { calls++; return ok('@font-face{}', 'text/css'); });
  const first = fetchEvent('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono');
  handlers.fetch(first.event);
  assert.equal(await (await first.response()).text(), '@font-face{}');
  await first.settled();
  const cached = await caches.match(new Request('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono'));
  assert.ok(cached, 'the stylesheet was cached');
  const { handlers: offline, caches: c2 } = loadSW(async () => { throw new TypeError('offline'); });
  await (await c2.open('itemizer-test')).put(new Request('https://fonts.gstatic.com/s/x.woff2'), ok('woff', 'font/woff2'));
  const ev = fetchEvent('https://fonts.gstatic.com/s/x.woff2');
  offline.fetch(ev.event);
  assert.equal(await (await ev.response()).text(), 'woff');
});

test('a SKIP_WAITING message activates the waiting worker, and activation drops old caches', async () => {
  const { handlers, self, caches } = loadSW(async () => ok('x'));
  await (await caches.open('itemizer-old')).put(new Request('https://example.test/app/index.html'), ok('old'));
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(self.skipped, true);
  const waits = [];
  await handlers.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.ok(!(await caches.keys()).includes('itemizer-old'));
  assert.equal(self.claimed, true);
});
