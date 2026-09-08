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
const repo = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SW_SOURCE = repo('sw.js');
// The worker caches under its own stamp, so the tests have to seed the same cache the code will read.
const CACHE = 'itemizer-' + SW_SOURCE.match(/const STAMP = '([^']*)'/)[1];
const ok = (body, type) => new Response(body, { status: 200, headers: { 'Content-Type': type || 'text/plain' } });
// Node cannot construct a Request in navigate mode, so events carry a plain request-like object.
const fetchEvent = (url, init) => {
  const req = Object.assign({ url, method: 'GET', mode: 'cors', cache: 'default' }, init || {});
  let response = null; const waits = [];
  return { req, event: { request: req, respondWith: (p) => { response = Promise.resolve(p); }, waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); } }, response: () => response, settled: async () => { for (let i = 0; i < 5; i++) { const n = waits.length; await Promise.all(waits); if (waits.length === n) return; } } }; // a waitUntil can register another one
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

test('same-origin assets are served from cache ignoring the query string, and refreshed under waitUntil', async () => {
  let calls = 0;
  const { handlers, caches } = loadSW(async () => { calls++; return ok('fresh'); });
  const c = await caches.open(CACHE);
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
  await (await c2.open(CACHE)).put(new Request('https://fonts.gstatic.com/s/x.woff2'), ok('woff', 'font/woff2'));
  const ev = fetchEvent('https://fonts.gstatic.com/s/x.woff2');
  offline.fetch(ev.event);
  assert.equal(await (await ev.response()).text(), 'woff');
});

test('a SKIP_WAITING message activates the waiting worker, and activation drops old caches', async () => {
  const { handlers, self, caches } = loadSW(async () => ok('x'));
  await (await caches.open('itemizer-old')).put(new Request('https://example.test/app/index.html'), ok('old'));
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

test('a navigation to the app refreshes the cached shell in the background, and only with a page', async () => {
  const { handlers, caches } = loadSW(async () => ok('<html>fresh shell</html>', 'text/html'));
  const c = await caches.open(CACHE);
  await c.put(new Request('https://example.test/app/index.html'), ok('<html>shell</html>', 'text/html'));
  const nav = fetchEvent('https://example.test/app/?source=pwa', { mode: 'navigate' });
  handlers.fetch(nav.event);
  assert.equal(await (await nav.response()).text(), '<html>shell</html>', 'the running version answers the launch');
  await nav.settled();
  assert.equal(await (await caches.match(new Request('https://example.test/app/index.html'))).text(), '<html>fresh shell</html>');
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
  const { handlers, caches } = loadSW(async () => ok('NEW app.js'));
  const old = await caches.open('itemizer-OLDDEPLOY'); // created first, so a cross-cache lookup finds it first
  await old.put(new Request('https://example.test/app/js/app.js'), ok('OLD app.js'));
  await old.put(new Request('https://example.test/app/index.html'), ok('<html>OLD shell</html>', 'text/html'));
  const waits = [];
  await handlers.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const script = fetchEvent('https://example.test/app/js/app.js');
  handlers.fetch(script.event);
  assert.equal(await (await script.response()).text(), 'NEW app.js');
});

test('the precache list covers everything the page loads', async () => {
  const shell = [...SW_SOURCE.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);
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
});

test('the cache name is the stamp build.js wrote, with no fallback branch left over', async () => {
  const { handlers, caches } = loadSW(async () => ok('x'));
  const waits = [];
  await handlers.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(await caches.keys(), [CACHE]);
  assert.doesNotMatch(SW_SOURCE, /startsWith\('__'\)/, 'the placeholder scheme is gone from the code as well as the comment');
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
  const shell = [...SW_SOURCE.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);
  for (const entry of shell) {
    if (entry === '') continue; // the root is index.html under another name
    assert.ok(staged.includes(entry.split('/')[0]), entry + ' is precached but is not staged for the deploy');
  }
  assert.ok(staged.includes('sw.js'), 'without the worker there is no offline app');
  for (const stray of ['dist', 'test', 'README.md', 'build.js', 'package.json']) {
    assert.ok(!staged.includes(stray), stray + ' has no business inside the service worker scope');
  }
});
