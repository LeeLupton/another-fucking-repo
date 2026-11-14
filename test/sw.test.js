const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

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
    };
  };
  const caches = {
    open: async (name) => openCache(name),
    keys: async () => [...store.keys()],
    has: async (name) => store.has(name),
    delete: async (name) => store.delete(name),
    match: async (req, opts) => { for (const m of store.values()) { const r = m.get(keyOf(req, opts)); if (r) return r.clone(); } return undefined; },
  };
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting: async () => { self.skipped = true; }, clients: { claim: async () => { self.claimed = true; } }, location: new URL('https://example.test/app/sw.js') };
  // In a worker, relative URLs resolve against the scope; Node's Request needs that done for it.
  class ScopedRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, 'https://example.test/app/').href : input, init); } }
  const ctx = { self, caches, fetch: fetchImpl, Request: ScopedRequest, Response, URL, console, crypto: crypto.webcrypto };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8'), ctx);
  return { handlers, self, caches, store };
}
const repo = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SW_SOURCE = repo('sw.js');
// The worker caches under its own stamp, so the tests have to seed the same cache the code will read.
const CACHE = 'itemizer-checked-' + SW_SOURCE.match(/const STAMP = '([^']*)'/)[1];
const ok = (body, type) => new Response(body, { status: 200, headers: { 'Content-Type': type || 'text/plain' } });
const bytes = (p) => fs.readFileSync(path.join(__dirname, '..', p));
const sha256 = (data) => crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
// What build.js wrote into the worker: each shell file, keyed without the leading './', and the hash of its bytes.
const SHELL = Object.fromEntries([...SW_SOURCE.match(/const SHELL = \{([^}]*)\};/)[1].matchAll(/'\.\/([^']*)': '([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]));
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', webmanifest: 'application/manifest+json', svg: 'image/svg+xml', png: 'image/png' };
/** Mark a response the way fetch marks one that followed a redirect; Node's own are never redirected, and a clone keeps the mark. */
function redirected(res) {
  const clone = res.clone.bind(res);
  Object.defineProperty(res, 'redirected', { value: true });
  res.clone = () => redirected(clone());
  return res;
}
/**
 * A fetch that answers the way the deployed site does: with this repository's files, byte for byte. `other` swaps
 * the body of chosen paths (null for a 404), which is what a deploy this worker was not built from looks like.
 * `moved` lists paths the server answers with a redirect to the same bytes, as one with clean URLs does for /index.html.
 */
function site(other, moved) {
  const seen = [];
  const fetchImpl = async (req) => {
    seen.push(req);
    const rel = new URL(typeof req === 'string' ? req : req.url).pathname.replace(/^\/app\//, '') || 'index.html';
    const type = TYPES[rel.split('.').pop()];
    if (other && rel in other) return other[rel] === null ? new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } }) : ok(other[rel], type);
    if (!fs.existsSync(path.join(__dirname, '..', rel))) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
    return moved && moved.includes(new URL(typeof req === 'string' ? req : req.url).pathname.replace(/^\/app\//, '')) ? redirected(ok(bytes(rel), type)) : ok(bytes(rel), type);
  };
  return { fetchImpl, seen };
}
const install = async (handlers) => { const waits = []; handlers.install({ waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
// Node cannot construct a Request in navigate mode, so events carry a plain request-like object.
const fetchEvent = (url, init) => {
  const req = Object.assign({ url, method: 'GET', mode: 'cors', cache: 'default' }, init || {});
  let response = null; const waits = [];
  return { req, event: { request: req, respondWith: (p) => { response = Promise.resolve(p); }, waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); } }, response: () => response, settled: async () => { for (let i = 0; i < 5; i++) { const n = waits.length; await Promise.all(waits); if (waits.length === n) return; } } }; // a waitUntil can register another one
};

test('install fetches the whole shell past the HTTP cache, checks every file, and stores it under this version', async () => {
  const { fetchImpl, seen } = site();
  const { handlers, self, caches } = loadSW(fetchImpl);
  await install(handlers);
  assert.equal(seen.length, Object.keys(SHELL).length, 'each shell file was fetched once');
  assert.ok(seen.length > 15, 'the shell files were fetched');
  assert.ok(seen.every((r) => r.cache === 'reload'), 'every precache request bypasses the HTTP cache');
  assert.ok(seen.some((r) => /icon-maskable-512\.png$/.test(r.url)), 'the maskable icon is part of the shell');
  const names = await caches.keys();
  assert.equal(names.length, 1);
  assert.match(names[0], /^itemizer-/);
  const cache = await caches.open(names[0]);
  for (const [p, sum] of Object.entries(SHELL)) {
    const res = await cache.match('./' + p);
    assert.ok(res, (p || 'the root') + ' is cached');
    assert.equal(sha256(await res.arrayBuffer()), sum, (p || 'the root') + ' is cached as the file this version was built from');
  }
  assert.equal(self.skipped, undefined, 'the new worker waits instead of taking over a running page');
});

test('install stores nothing when a file is not the one this version was built from', async () => {
  // A CDN still handing out the last deploy's copy of one file, and a file that is not there at all.
  for (const [p, body, why] of [['js/app.js', 'the app.js of some other deploy', /js\/app\.js is not the file this version was built from/], ['icons/icon-192.png', null, /icons\/icon-192\.png answered 404/]]) {
    const { handlers, caches } = loadSW(site({ [p]: body }).fetchImpl);
    await assert.rejects(install(handlers), why, 'the install fails, so the browser keeps the worker it has and tries again later');
    assert.deepEqual(await caches.keys(), [], 'no part of a shell that failed its check is left where a launch could read it');
  }
});

test('a shell that could not be stored whole is not left behind, unless the cache was there before', async () => {
  // Out of room: one put fails after others went through. What was written would only take space the records need.
  const failing = (caches, key) => { const open = caches.open; caches.open = async (name) => { const c = await open(name); if (name === CACHE) { const put = c.put; c.put = async (req, res) => { if (req === key) throw new Error('QuotaExceededError'); return put(req, res); }; } return c; }; };
  const fresh = loadSW(site().fetchImpl);
  failing(fresh.caches, './js/geo.js');
  await assert.rejects(install(fresh.handlers), /QuotaExceededError/);
  assert.deepEqual(await fresh.caches.keys(), [], 'the half-written cache is removed');
  // The same build installing again over its own cache (it may be the one in use) leaves that cache where it is.
  const again = loadSW(site().fetchImpl);
  await (await again.caches.open(CACHE)).put('./index.html', ok('<html>in use</html>', 'text/html'));
  failing(again.caches, './js/geo.js');
  await assert.rejects(install(again.handlers), /QuotaExceededError/);
  assert.deepEqual(await again.caches.keys(), [CACHE]);
});

test('a file the server redirected is stored as a plain response, so a launch is never handed a redirected one', async () => {
  // A static server with clean URLs answers /index.html with a redirect to /. fetch follows it and the bytes pass
  // their hash, but a browser refuses a redirected response for a navigation, and nothing ever replaces a cached file.
  const { handlers, caches } = loadSW(site(null, ['index.html', 'js/app.js']).fetchImpl);
  await install(handlers);
  const cache = await caches.open(CACHE);
  for (const p of Object.keys(SHELL)) assert.equal((await cache.match('./' + p)).redirected, false, (p || 'the root') + ' is stored as a plain response');
  for (const url of ['https://example.test/app/', 'https://example.test/app/index.html']) {
    const nav = fetchEvent(url, { mode: 'navigate' });
    handlers.fetch(nav.event);
    const res = await nav.response();
    assert.equal(res.redirected, false, 'the launch gets a response the browser will accept');
    assert.equal(sha256(await res.arrayBuffer()), SHELL['index.html'], 'and it is still the page this version was built from');
  }
  // The same holds for a file put back after the cache lost it.
  const lost = loadSW(site(null, ['js/app.js']).fetchImpl);
  const ev = fetchEvent('https://example.test/app/js/app.js');
  lost.handlers.fetch(ev.event);
  await ev.response();
  await ev.settled();
  const kept = await (await lost.caches.open(CACHE)).match('./js/app.js');
  assert.equal(kept.redirected, false);
  assert.equal(sha256(await kept.arrayBuffer()), SHELL['js/app.js']);
});

test('the worker\'s list is every shell file with the hash of its bytes as committed, and the root is the page', () => {
  assert.ok(Object.keys(SHELL).length > 15);
  for (const [p, sum] of Object.entries(SHELL)) {
    assert.equal(sha256(bytes(p || 'index.html')), sum, (p || 'the root') + ' changed after the last build: run npm run build and commit sw.js');
  }
  assert.equal(SHELL[''], SHELL['index.html']);
});

test('offline navigation to any same-origin URL falls back to the cached shell; nothing ever resolves to undefined', async () => {
  const { handlers, caches } = loadSW(async () => { throw new TypeError('offline'); });
  const c = await caches.open(CACHE);
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

test('same-origin assets are served from this version\'s cache ignoring the query string, and the network never replaces them', async () => {
  let calls = 0;
  const { handlers, caches } = loadSW(async () => { calls++; return ok('the app.js of the next deploy'); });
  const c = await caches.open(CACHE);
  await c.put(new Request('https://example.test/app/js/app.js'), ok('this version'));
  const ev = fetchEvent('https://example.test/app/js/app.js?v=2');
  handlers.fetch(ev.event);
  const res = await ev.response();
  assert.equal(await res.text(), 'this version');
  await ev.settled();
  assert.equal(calls, 0, 'a file the cache holds is not fetched again, so the next deploy cannot arrive one file at a time');
  assert.equal(await (await c.match('./js/app.js')).text(), 'this version');
});

test('a shell file the cache has lost is fetched again, and kept only if it is this version\'s', async () => {
  // The file this version was built from: served and put back, so the next launch needs no network.
  const same = loadSW(site().fetchImpl);
  const ev = fetchEvent('https://example.test/app/js/app.js?v=2');
  same.handlers.fetch(ev.event);
  assert.equal(sha256(await (await ev.response()).arrayBuffer()), SHELL['js/app.js']);
  await ev.settled();
  const kept = await (await same.caches.open(CACHE)).match('./js/app.js');
  assert.ok(kept, 'the file is back in the cache');
  assert.equal(sha256(await kept.arrayBuffer()), SHELL['js/app.js']);
  // The start page is put back the same way.
  const nav = fetchEvent('https://example.test/app/?source=pwa', { mode: 'navigate' });
  same.handlers.fetch(nav.event);
  assert.equal(sha256(await (await nav.response()).arrayBuffer()), SHELL['index.html']);
  await nav.settled();
  assert.equal(sha256(await (await (await same.caches.open(CACHE)).match('./index.html')).arrayBuffer()), SHELL['index.html']);
  // Another deploy's copy is all there is, so it is served, but it never enters this version's cache.
  const next = loadSW(site({ 'js/app.js': 'the app.js of the next deploy', 'index.html': '<html>the next deploy</html>' }).fetchImpl);
  for (const [url, init, key, body] of [['https://example.test/app/js/app.js', {}, './js/app.js', 'the app.js of the next deploy'], ['https://example.test/app/', { mode: 'navigate' }, './index.html', '<html>the next deploy</html>']]) {
    const e = fetchEvent(url, init);
    next.handlers.fetch(e.event);
    assert.equal(await (await e.response()).text(), body);
    await e.settled();
    assert.equal(await (await next.caches.open(CACHE)).match(key), undefined, key + ' from another deploy was not stored');
  }
  // A same-origin file that is no part of the shell is passed through and not kept either.
  const stray = fetchEvent('https://example.test/app/README.md');
  same.handlers.fetch(stray.event);
  assert.match(await (await stray.response()).text(), /Itemizer/);
  await stray.settled();
  assert.equal(await (await same.caches.open(CACHE)).match('./README.md'), undefined);
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
  await (await c2.open(CACHE)).put(new Request('https://fonts.gstatic.com/s/x.woff2'), ok('woff', 'font/woff2'));
  const ev = fetchEvent('https://fonts.gstatic.com/s/x.woff2');
  offline.fetch(ev.event);
  assert.equal(await (await ev.response()).text(), 'woff');
});

test('a SKIP_WAITING message activates the waiting worker, and activation drops old caches', async () => {
  const { handlers, self, caches } = loadSW(async () => ok('x'));
  await (await caches.open('itemizer-old')).put(new Request('https://example.test/app/index.html'), ok('old'));
  await (await caches.open('itemizer-checked-old')).put(new Request('https://example.test/app/index.html'), ok('older, of this design'));
  // Cache Storage belongs to the origin, which on a github.io account is shared with every other project site.
  await (await caches.open('someone-else-v1')).put(new Request('https://example.test/other/index.html'), ok('other shell'));
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(self.skipped, true);
  const waits = [];
  await handlers.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(await caches.keys(), ['someone-else-v1'], 'only this app\'s old caches are dropped');
  assert.equal(self.claimed, true);
});

test('a navigation to another document on this origin is passed through and never becomes the offline shell', async () => {
  const { handlers, caches } = loadSW(async () => ok('# Itemizer\n\nA deductible-expense tracker.', 'text/markdown'));
  const c = await caches.open(CACHE);
  await c.put(new Request('https://example.test/app/index.html'), ok('<html>shell</html>', 'text/html'));
  const doc = fetchEvent('https://example.test/app/README.md', { mode: 'navigate' });
  handlers.fetch(doc.event);
  assert.match(await (await doc.response()).text(), /^# Itemizer/, 'the other document is served, not the app');
  await doc.settled();
  assert.equal(await (await caches.match(new Request('https://example.test/app/index.html'))).text(), '<html>shell</html>');
});

test('a launch is answered from this version\'s cache, and a newer page on the network never replaces the cached one', async () => {
  let calls = 0;
  const { handlers, caches } = loadSW(async () => { calls++; return ok('<html>the next deploy</html>', 'text/html'); });
  const c = await caches.open(CACHE);
  await c.put(new Request('https://example.test/app/index.html'), ok('<html>shell</html>', 'text/html'));
  for (const url of ['https://example.test/app/?source=pwa', 'https://example.test/app/index.html']) {
    const nav = fetchEvent(url, { mode: 'navigate' });
    handlers.fetch(nav.event);
    assert.equal(await (await nav.response()).text(), '<html>shell</html>', 'the running version answers the launch');
    await nav.settled();
  }
  assert.equal(calls, 0, 'a launch the cache can answer asks the network for nothing');
  assert.equal(await (await caches.match(new Request('https://example.test/app/index.html'))).text(), '<html>shell</html>', 'the page stays the one its scripts were installed with');
});

test('a navigation whose request never settles is answered from the cache instead of waiting', async () => {
  const { handlers, caches } = loadSW(() => new Promise(() => {}));
  const c = await caches.open(CACHE);
  await c.put(new Request('https://example.test/app/index.html'), ok('<html>shell</html>', 'text/html'));
  const nav = fetchEvent('https://example.test/app/', { mode: 'navigate' });
  handlers.fetch(nav.event);
  const stalled = Symbol('stalled');
  const res = await Promise.race([nav.response(), new Promise((r) => setTimeout(() => r(stalled), 200))]);
  assert.notEqual(res, stalled, 'the launch did not wait on the network');
  assert.equal(await res.text(), '<html>shell</html>');
});

test('a first visit with nothing cached and no network still resolves with a Response', async () => {
  const { handlers } = loadSW(async () => { throw new TypeError('offline'); });
  const nav = fetchEvent('https://example.test/app/', { mode: 'navigate' });
  handlers.fetch(nav.event);
  const res = await nav.response();
  assert.ok(res instanceof Response);
  assert.equal(res.type, 'error');
});

test('the page and its scripts are served from this version, not from whichever cache is oldest', async () => {
  const { handlers, caches } = loadSW(site().fetchImpl);
  const old = await caches.open('itemizer-OLDDEPLOY'); // created first, so a cross-cache lookup finds it first
  await old.put(new Request('https://example.test/app/js/app.js'), ok('OLD app.js'));
  await old.put(new Request('https://example.test/app/index.html'), ok('<html>OLD shell</html>', 'text/html'));
  await install(handlers);
  const script = fetchEvent('https://example.test/app/js/app.js');
  handlers.fetch(script.event);
  assert.equal(sha256(await (await script.response()).arrayBuffer()), SHELL['js/app.js']);
  const nav = fetchEvent('https://example.test/app/', { mode: 'navigate' });
  handlers.fetch(nav.event);
  assert.equal(sha256(await (await nav.response()).arrayBuffer()), SHELL['index.html']);
});

test('installing brings the cache of a worker from before this design to this build, whole, and waits for that', async () => {
  // That worker refreshes its own cache one file at a time, so it holds this build's page beside scripts of its own
  // and none of the new ones. A build that installed and was never accepted may have left its own copies there too.
  const { handlers, caches, store } = loadSW(site().fetchImpl);
  const old = await caches.open('itemizer-0c7b71ba5f76');
  await old.put('./', ok('<html>the old page</html>', 'text/html'));
  await old.put('./index.html', ok('<html>the page the old worker fetched for itself</html>', 'text/html'));
  await old.put('./js/app.js', ok('the app.js the old worker stored'));
  await old.put('./js/money.js', ok('the money.js an earlier build left here'));
  await old.put(new Request('https://fonts.gstatic.com/s/x.woff2'), ok('woff', 'font/woff2'));
  // a real cache takes time to write; the install must not be reported done before the old cache is whole
  const open = caches.open;
  caches.open = async (name) => { const c = await open(name); if (name === 'itemizer-0c7b71ba5f76') { const fast = c.put; c.put = (req, res) => new Promise((done) => setTimeout(done, 20)).then(() => fast(req, res)); } return c; };
  await install(handlers);
  for (const p of Object.keys(SHELL)) {
    const res = await old.match('./' + p);
    assert.ok(res, (p || 'the root') + ' is in the old cache');
    assert.equal(sha256(await res.arrayBuffer()), SHELL[p], (p || 'the root') + ' in the old cache is this build\'s');
  }
  assert.equal(await (await old.match(new Request('https://fonts.gstatic.com/s/x.woff2'))).text(), 'woff', 'what is no part of the shell is left as it was');
  assert.equal(store.get(CACHE).size, Object.keys(SHELL).length, 'and this version\'s own cache is whole');
});

test('installing never touches a cache of this design, or another site\'s', async () => {
  const { handlers, caches, store } = loadSW(site().fetchImpl);
  // an older build of this design, whole; one that has lost a file; and one that was emptied
  const whole = await caches.open('itemizer-checked-aaaaaaaaaaaa');
  for (const p of Object.keys(SHELL)) await whole.put('./' + p, ok('older build: ' + p));
  const holed = await caches.open('itemizer-checked-bbbbbbbbbbbb');
  await holed.put('./index.html', ok('<html>older build</html>', 'text/html'));
  await caches.open('itemizer-checked-cccccccccccc');
  await (await caches.open('someone-else-v1')).put(new Request('https://example.test/other/index.html'), ok('other shell'));
  await install(handlers);
  for (const p of Object.keys(SHELL)) assert.equal(await (await whole.match('./' + p)).text(), 'older build: ' + p, 'no file of an older checked build is replaced');
  assert.equal(store.get('itemizer-checked-aaaaaaaaaaaa').size, Object.keys(SHELL).length, 'and none is added');
  assert.equal(store.get('itemizer-checked-bbbbbbbbbbbb').size, 1, 'a hole in an older checked build is not filled with this build\'s file');
  assert.equal(store.get('itemizer-checked-cccccccccccc').size, 0, 'and an emptied one is not refilled with this build');
  assert.equal(store.get('someone-else-v1').size, 1, 'another site\'s cache on the same origin is not touched');
});

test('an older cache that cannot be written to does not stop this version from installing', async () => {
  const { handlers, caches, store } = loadSW(site().fetchImpl);
  await (await caches.open('itemizer-OLDDEPLOY')).put('./index.html', ok('<html>old</html>', 'text/html'));
  const open = caches.open;
  caches.open = async (name) => { const c = await open(name); if (name === 'itemizer-OLDDEPLOY') c.put = async () => { throw new Error('QuotaExceededError'); }; return c; };
  await install(handlers);
  assert.equal(store.get(CACHE).size, Object.keys(SHELL).length);
});

test('the precache list covers everything the page loads', async () => {
  const shell = Object.keys(SHELL);
  const html = repo('index.html');
  for (const ref of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
    if (/^(https?:|data:|mailto:|#)/.test(ref)) continue;
    assert.ok(shell.includes(ref), ref + ' is loaded by index.html but is not precached');
  }
  for (const f of fs.readdirSync(path.join(__dirname, '../js'))) {
    assert.ok(shell.includes('js/' + f), 'js/' + f + ' is not precached');
  }
  for (const icon of JSON.parse(repo('manifest.webmanifest')).icons) {
    assert.ok(shell.includes(icon.src), icon.src + ' is in the manifest but is not precached');
  }
  const scripts = [...repo('build.js').match(/const SCRIPTS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(scripts, shell.filter((p) => p.startsWith('js/')), 'the single-file build and the shell list the same scripts');
  // build.js writes the worker's list from its own, so its own has to be the page's: the same scripts, in the page's order.
  assert.deepEqual(scripts, [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]), 'build.js lists the scripts index.html loads, in the same order');
});

test('the cache name is the stamp build.js wrote, with no fallback branch left over', async () => {
  const { handlers, caches } = loadSW(site().fetchImpl);
  await install(handlers);
  assert.deepEqual(await caches.keys(), [CACHE]);
  assert.doesNotMatch(SW_SOURCE, /startsWith\('__'\)/, 'the placeholder scheme is gone from the code as well as the comment');
});

/** Run build.js on a copy of the sources it reads, so the working tree is never written to. `edit` changes the copy first. */
function buildCopy(edit, then) {
  const build = repo('build.js');
  const listed = (name) => [...build.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'))[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const sources = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'build.js', ...listed('SCRIPTS'), ...listed('ICONS')];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itemizer-build-'));
  try {
    for (const p of sources) {
      fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', p), path.join(dir, p));
    }
    if (edit) edit(dir);
    execFileSync(process.execPath, [path.join(dir, 'build.js')], { stdio: 'ignore' });
    return then(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the committed worker and single-file build are the ones build.js makes from these sources', () => {
  // Only build.js writes the worker's file list, its hashes and its stamp, so a change to the app that skipped
  // `npm run build` would ship a worker that still describes the old files. Building a copy proves all three are current.
  buildCopy(null, (dir) => {
    // files are compared by hash so a failure reads as two short strings instead of a diff of the whole app
    const digest = (text) => sha256(text).slice(0, 12);
    assert.equal(digest(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')), digest(SW_SOURCE), 'the worker\'s file list or cache version is stale: run npm run build and commit sw.js');
    for (const out of ['dist/itemizer.html', 'dist/itemizer.fragment.html']) {
      assert.equal(digest(repo(out)), digest(fs.readFileSync(path.join(dir, out), 'utf8')), out + ' is stale: run npm run build and commit it');
    }
  });
});

test('one changed byte in any shell file gives the worker a new hash for that file and a new cache version', () => {
  const stampOf = (src) => src.match(/const STAMP = '([^']*)'/)[1];
  // an icon is a file nothing but the build reads: it is not a script, and no test loads it
  for (const p of ['icons/icon-192.png', 'js/money.js', 'index.html']) {
    buildCopy((dir) => fs.appendFileSync(path.join(dir, p), '\n'), (dir) => {
      const built = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
      assert.notEqual(stampOf(built), stampOf(SW_SOURCE), 'a change to ' + p + ' moves the cache version');
      assert.ok(!built.includes("'./" + p + "': '" + SHELL[p] + "'"), 'and the list carries the new hash of ' + p);
      assert.ok(built.includes("'./" + p + "': '" + sha256(fs.readFileSync(path.join(dir, p))) + "'"));
    });
  }
  // The worker's own code is part of the version too: a fix to the worker has to reach installed browsers as a new one.
  buildCopy((dir) => fs.appendFileSync(path.join(dir, 'sw.js'), '// a change to the worker itself\n'), (dir) => {
    assert.notEqual(stampOf(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')), stampOf(SW_SOURCE), 'a change to sw.js moves the cache version');
  });
});

test('the build stops when it cannot find the lines it writes in the worker, or finds them twice', () => {
  // It used to print a stamp, write nothing and exit 0, which leaves the old version in place without a word.
  // Every edit below leaves a worker that still runs, so only the build's own check of its lines can stop it.
  const stamp = SW_SOURCE.match(/^const STAMP = '[^']*';/m)[0];
  const edits = [
    [stamp, stamp.replace(/'/g, '"')], // the line in a form the build does not write
    ['const SHELL = {', 'const SHELL  = {'],
    ['const FONT_HOSTS', "{\nconst STAMP = 'aaaaaaaaaaaa';\n}\nconst FONT_HOSTS"], // the line a second time
    ['const FONT_HOSTS', '{\nconst SHELL = {};\n}\nconst FONT_HOSTS'], // the block a second time
  ];
  for (const [from, to] of edits) {
    assert.throws(() => buildCopy((dir) => {
      const file = path.join(dir, 'sw.js');
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(src.includes(from));
      const edited = src.replace(from, to);
      new vm.Script(edited); // still a script: the edit is not caught merely by failing to compile
      fs.writeFileSync(file, edited);
    }, () => {}), /Command failed/, 'a worker changed at ' + JSON.stringify(from.slice(0, 20)) + ' fails the build');
  }
  // A worker that is not a script at all is not stamped and saved as if it were.
  assert.throws(() => buildCopy((dir) => fs.appendFileSync(path.join(dir, 'sw.js'), '\n});\n'), () => {}), /Command failed/);
  // A shell file whose name would break out of the list it is written into.
  assert.throws(() => buildCopy((dir) => {
    fs.writeFileSync(path.join(dir, 'js/od{d.js'), '');
    const file = path.join(dir, 'build.js');
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(src.includes("'js/app.js'];"));
    fs.writeFileSync(file, src.replace("'js/app.js'];", "'js/app.js', \"js/od{d.js\"];"));
  }, () => {}), /Command failed/);
});

test('the same words in a comment are not taken for the lines the build writes', () => {
  // The declaration is found at the start of a line. Found anywhere, a mention in the header would have made the
  // build cut everything between the comment and the real list, the cache name with it, and still exit 0.
  buildCopy((dir) => {
    const file = path.join(dir, 'sw.js');
    const src = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, src.replace(' * Service worker:', " * The list is written as const SHELL = { path: hash } and the version as const STAMP = '...';\n * Service worker:"));
  }, (dir) => {
    const built = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    for (const line of [/^const PREFIX = /m, /^const STAMP = '[0-9a-f]{12}';/m, /^const CACHE = /m, /^const SHELL = \{$/m]) assert.match(built, line);
    assert.equal((built.match(/'\.\/[^']*': '[0-9a-f]{64}',/g) || []).length, Object.keys(SHELL).length);
    new vm.Script(built);
  });
});

test('the manifest describes an installable app that is not locked to one orientation', () => {
  const m = JSON.parse(repo('manifest.webmanifest'));
  assert.equal(m.orientation, undefined, 'WCAG 1.3.4: nothing here needs a fixed orientation');
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
});

test('the page shell asks for a policy that allows only what the app uses', () => {
  const html = repo('index.html');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src [^;]*'unsafe-inline'/, 'an injected <script> must never run');
  assert.match(csp, /style-src [^;]*'unsafe-inline'/, 'the generated style attributes need this');
  for (const host of ['https://nominatim.openstreetmap.org', 'https://router.project-osrm.org', 'https://www.fema.gov']) {
    assert.match(csp, new RegExp('connect-src [^;]*' + host.replace(/[.]/g, '\\.')), host + ' is looked up by js/geo.js');
  }
  assert.equal(html.indexOf('Content-Security-Policy') < html.indexOf('<link'), true, 'the policy is declared before anything loads');
});

test('the shell markup declares a standalone app and asks Google for nothing it can avoid', () => {
  const html = repo('index.html');
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/, 'older Safari still reads the prefixed one');
  for (const link of html.match(/<link rel="preconnect"[^>]*>/g)) {
    assert.match(link, /crossorigin/, 'a preconnect without crossorigin opens a socket the font fetch cannot reuse');
  }
  assert.match(html.match(/<link rel="stylesheet"[^>]*fonts\.googleapis\.com[^>]*>/)[0], /referrerpolicy="no-referrer"/);
});

test('the workflows never interpolate a value into a shell command', () => {
  const dir = path.join(__dirname, '../.github/workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length, 'the workflows directory should not be empty');
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)-?\s*run:\s*(.*)$/);
      if (!m) continue;
      const script = [m[2]];
      if (/^[|>]/.test(m[2])) {
        for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) script.push(lines[j]);
      }
      assert.doesNotMatch(script.join('\n'), /\$\{\{/, f + ' line ' + (i + 1) + ': pass the value through env instead, so it stays data');
    }
  }
});

test('the deploy stages the files the worker precaches, and nothing else', () => {
  const cp = repo('.github/workflows/pages.yml').match(/cp -r ([^\n]*) site\//);
  assert.ok(cp, 'the deploy stages a site directory instead of publishing the whole repository');
  const staged = cp[1].trim().split(/\s+/);
  for (const entry of Object.keys(SHELL)) {
    if (entry === '') continue; // the root is index.html under another name
    assert.ok(staged.includes(entry.split('/')[0]), entry + ' is precached but is not staged for the deploy');
  }
  assert.ok(staged.includes('sw.js'), 'without the worker there is no offline app');
  for (const stray of ['dist', 'test', 'README.md', 'build.js', 'package.json']) {
    assert.ok(!staged.includes(stray), stray + ' has no business inside the service worker scope');
  }
});
