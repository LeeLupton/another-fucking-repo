const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/geo.js');

const M_PER_DEG_LAT = (Math.PI / 180) * 6371008.8;
const north = (lat, meters) => lat + meters / M_PER_DEG_LAT;

test('a parked car with GPS jitter accumulates almost no distance', () => {
  const pts = [];
  let t = 0;
  for (let i = 0; i < 100; i++) { const wobble = ((i % 7) - 3) * 3; pts.push({ lat: north(35.78, wobble), lon: -78.64, acc: 20 + (i % 10), t: (t += 1000) }); }
  assert.ok(G.trackMeters(pts) < 40, `${G.trackMeters(pts)} m`);
  // a fix that reports itself as standing still is ignored outright
  const still = [{ lat: 35.78, lon: -78.64, acc: 5, speed: 0, t: 1000 }, { lat: north(35.78, 30), lon: -78.64, acc: 5, speed: 0, t: 2000 }];
  assert.equal(G.trackMeters(still), 0);
});

// A seeded random walk: correlated GPS noise, optionally on top of steady motion north. No `speed` field,
// which is what a Wi-Fi or network fix gives.
function noisyTrack(sigma, acc, seconds, rho, seed, metersPerSecond) {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const gauss = () => { const u = Math.max(1e-9, rand()), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pts = [];
  let ex = 0, ey = 0;
  for (let i = 0; i < seconds; i++) {
    ex = rho * ex + Math.sqrt(1 - rho * rho) * gauss() * sigma;
    ey = rho * ey + Math.sqrt(1 - rho * rho) * gauss() * sigma;
    pts.push({ lat: north(35.78, ex + (metersPerSecond || 0) * i), lon: -78.64 + ey / (M_PER_DEG_LAT * Math.cos((35.78 * Math.PI) / 180)), acc, t: i * 1000 });
  }
  return pts;
}

test('a parked phone whose fixes report no speed books no miles, and a real drive still measures right', () => {
  const parked = G.trackMiles(noisyTrack(10, 20, 3600, 0.9, 3));
  assert.ok(parked < 0.3, `an hour parked recorded ${parked.toFixed(2)} mi`);
  assert.equal(G.roundMiles(parked), 0, 'the trip screen shows 0.0 mi');
  // the same noise on twenty minutes at 15 m/s: the guard must not eat a genuine drive
  const driven = G.trackMiles(noisyTrack(10, 20, 1200, 0.9, 3, 15));
  assert.ok(Math.abs(driven - 11.2) < 1.2, `a 11.2 mi drive recorded ${driven.toFixed(2)} mi`);
});

test('a stale first fix is re-anchored once two real fixes agree, without adding the jump', () => {
  const pts = [{ lat: north(35.78, 700), lon: -78.64, acc: 10, t: 0 }];
  for (let i = 1; i <= 60; i++) pts.push({ lat: north(35.78, i * 10), lon: -78.64, acc: 5, t: i * 1000 });
  const d = G.trackMeters(pts);
  assert.ok(Math.abs(d - 590) < 25, `${d} m vs ~590 m`);
});

test('a pause marker breaks the track: the straight line across a pause is not driven', () => {
  const a = [{ lat: 35.78, lon: -78.64, acc: 5, t: 0 }, { lat: north(35.78, 100), lon: -78.64, acc: 5, t: 10000 }];
  const b = [{ lat: north(35.78, 5000), lon: -78.64, acc: 5, t: 110000 }, { lat: north(35.78, 5100), lon: -78.64, acc: 5, t: 120000 }];
  const withGap = a.concat([{ gap: true }], b);
  assert.ok(Math.abs(G.trackMeters(withGap) - 200) < 2);
  assert.ok(G.trackMeters(a.concat(b)) > 5000, 'without the marker the jump counts (it is under the speed limit)');
  const thinned = G.thin(withGap, 10);
  assert.ok(thinned.some((p) => p.gap));
  assert.equal(G.bounds(withGap).minLat, 35.78);
});

test('county names compare exactly, whatever suffix FEMA or the user attached', () => {
  assert.equal(G.areaName('Wake (County)'), 'wake');
  assert.equal(G.areaName('Orleans (Parish)'), 'orleans');
  assert.equal(G.areaName('Wake County'), 'wake');
  assert.notEqual(G.areaName('Clayton (County)'), G.areaName('Clay'));
});

test('lookup failures name the real problem', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await assert.rejects(G.geocode('anywhere'), /busy/);
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await assert.rejects(G.geocode('anywhere'), /refused this request \(403\)/);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(G.geocode('anywhere'), /not available here/);
  } finally { globalThis.fetch = realFetch; }
});

test('lookups map a successful response', async () => {
  const realFetch = globalThis.fetch;
  let calledUrl = null, calls = 0;
  try {
    globalThis.fetch = async (url) => { calls++; calledUrl = String(url); return { ok: true, status: 200, json: async () => [{ display_name: 'Wake County, North Carolina, United States', lat: '35.78', lon: '-78.64', address: { state: 'North Carolina', county: 'Wake County', 'ISO3166-2-lvl4': 'US-NC', postcode: '27601' } }] }; };
    assert.deepEqual(await G.geocode('Raleigh NC'), [{ name: 'Wake County, North Carolina, United States', lat: 35.78, lon: -78.64, state: 'North Carolina', stateCode: 'NC', county: 'Wake County', postcode: '27601' }]);
    assert.match(calledUrl, /countrycodes=us/); assert.match(calledUrl, /limit=5/);
    assert.equal(calls, 1);
    assert.deepEqual(await G.geocode('   '), [], 'an empty search never reaches the network');
    assert.equal(calls, 1);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ display_name: 'Cary, Wake County, North Carolina', address: { town: 'Cary', county: 'Wake County', state: 'North Carolina', 'ISO3166-2-lvl4': 'US-NC', postcode: '27511' } }) });
    const there = await G.reverse(35.79, -78.78);
    assert.equal(there.city, 'Cary', 'a town or village stands in for a city'); assert.equal(there.stateCode, 'NC'); assert.equal(there.county, 'Wake County'); assert.equal(there.postcode, '27511');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ error: 'Unable to geocode' }) });
    await assert.rejects(G.reverse(35.78, -78.64), /No address found/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ routes: [{ distance: 16093.4 }] }) });
    assert.equal(await G.routeMiles({ lat: 35, lon: -80 }, { lat: 35.1, lon: -80 }), 10, 'ten miles of road, to a tenth');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ routes: [] }) });
    await assert.rejects(G.routeMiles({ lat: 35, lon: -80 }, { lat: 35.1, lon: -80 }), /No road route found/);
  } finally { globalThis.fetch = realFetch; }
});

const fakeNavigator = (value) => { const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value }); return () => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; }; };

test('recorder: start watches, fixes accumulate, pause drops fixes and releases the watch, resume marks a gap, stop returns the track', () => {
  const cbs = {}, cleared = []; let nextId = 7, watches = 0;
  const restore = fakeNavigator({ geolocation: { watchPosition: (ok, err) => { cbs.ok = ok; cbs.err = err; watches++; return nextId++; }, clearWatch: (id) => { cleared.push(id); } } });
  try {
    const states = [], errors = [];
    const rec = G.createRecorder({ onUpdate: (r) => states.push(r.state), onError: (msg) => errors.push(msg) });
    assert.equal(rec.state, 'idle');
    assert.equal(rec.start(), true);
    assert.equal(rec.state, 'recording'); assert.equal(rec.watchId, 7); assert.equal(rec.waiting, true);
    const fix = (meters, t) => ({ coords: { latitude: north(35.78, meters), longitude: -78.64, accuracy: 5, speed: 10 }, timestamp: t });
    cbs.err({ code: 3, message: 'timeout' }); // no fix yet is a quiet wait, not an error
    assert.equal(rec.waiting, true); assert.equal(rec.error, null); assert.deepEqual(errors, []);
    cbs.ok(fix(0, 1000)); cbs.ok(fix(500, 51000)); cbs.ok(fix(1000, 101000)); // one kilometre at 10 m/s
    assert.equal(rec.waiting, false); assert.equal(rec.points.length, 3); assert.equal(rec.miles, 0.6);
    rec.pause();
    assert.equal(rec.state, 'paused'); assert.deepEqual(cleared, [7]);
    cbs.ok(fix(5000, 151000)); // a fix while paused is dropped
    assert.equal(rec.points.length, 3);
    rec.resume();
    assert.equal(rec.state, 'recording'); assert.equal(rec.watchId, 8); assert.equal(watches, 2);
    assert.ok(rec.points[rec.points.length - 1].gap, 'the pause is marked in the track');
    cbs.ok(fix(5000, 201000)); cbs.ok(fix(5500, 251000)); // the jump across the pause is not driven
    assert.equal(rec.miles, 0.9);
    const out = rec.stop();
    assert.equal(rec.state, 'idle'); assert.deepEqual(cleared, [7, 8]); assert.equal(rec.watchId, null);
    assert.equal(out.miles, 0.9); assert.ok(out.points.some((p) => p.gap)); assert.ok(out.endedAt >= out.startedAt); assert.ok(out.pausedMs >= 0);
    assert.ok(states.includes('paused') && states.includes('recording') && states[states.length - 1] === 'idle');
    assert.equal(rec.start(), true, 'a stopped recorder starts a fresh trip');
    assert.deepEqual(rec.points, []); assert.equal(rec.miles, 0);
    rec.stop();
  } finally { restore(); }
});

test('recorder: a denied permission stops the recording and reports it; a device without location refuses to start', () => {
  const cbs = {}, cleared = [];
  const restore = fakeNavigator({ geolocation: { watchPosition: (ok, err) => { cbs.ok = ok; cbs.err = err; return 3; }, clearWatch: (id) => cleared.push(id) } });
  try {
    const errors = [];
    const rec = G.createRecorder({ onError: (msg) => errors.push(msg) });
    rec.start();
    cbs.err({ code: 1, message: 'User denied Geolocation' });
    assert.equal(rec.state, 'idle'); assert.deepEqual(cleared, [3]);
    assert.equal(errors.length, 1); assert.equal(typeof rec.error, 'string'); assert.ok(rec.error.length > 10);
    cbs.ok({ coords: { latitude: 35.78, longitude: -78.64, accuracy: 5 }, timestamp: 5000 });
    assert.equal(rec.points.length, 0, 'nothing is recorded after the denial');
    restore();
    const restore2 = fakeNavigator({});
    try {
      const rec2 = G.createRecorder({ onError: (msg) => errors.push(msg) });
      assert.equal(rec2.start(), false); assert.match(rec2.error, /does not offer location/); assert.equal(errors.length, 2);
    } finally { restore2(); }
  } finally { try { restore(); } catch (e) { /* already restored */ } }
});

test('recorder: the track is checkpointed as it goes, and a checkpoint carries the same trip on', () => {
  const cbs = {};
  const restore = fakeNavigator({ geolocation: { watchPosition: (ok, err) => { cbs.ok = ok; cbs.err = err; return 1; }, clearWatch: () => {} } });
  try {
    const saved = [];
    const rec = G.createRecorder({ onCheckpoint: (c) => saved.push(c) });
    rec.start();
    const fix = (meters, t) => ({ coords: { latitude: north(35.78, meters), longitude: -78.64, accuracy: 5, speed: 10 }, timestamp: t });
    for (let i = 0; i < 12; i++) cbs.ok(fix(i * 100, 1000 + i * 10000)); // twelve fixes, 100 m and 10 s apart
    assert.equal(saved.length, 2, 'once on the first fix, again ten fixes later');
    const last = saved[saved.length - 1];
    assert.equal(last.points.length, 11); assert.equal(last.state, 'recording');
    assert.equal(last.startedAt, rec.startedAt); assert.equal(last.miles, 0.6);
    // the phone discards the page here: the twelfth fix is gone, the first eleven are not
    const rec2 = G.createRecorder({}, last);
    assert.equal(rec2.startedAt, rec.startedAt); assert.equal(rec2.miles, 0.6);
    rec2.start();
    assert.ok(rec2.points[rec2.points.length - 1].gap, 'the interval the app was not running is marked, not driven');
    cbs.ok(fix(5000, 300000)); cbs.ok(fix(5300, 320000)); cbs.ok(fix(5600, 340000)); // 600 m more, four kilometres from where it left off
    assert.equal(rec2.miles, 1, 'one kilometre before the checkpoint plus 600 m after it, and none of the jump');
    const out = rec2.stop();
    assert.equal(out.startedAt, rec.startedAt); assert.equal(out.miles, 1);
  } finally { restore(); }
});

test('a one-shot location request that times out says so, while the recorder keeps waiting quietly', async () => {
  const restore = fakeNavigator({ geolocation: { getCurrentPosition: (ok, err) => err({ code: 3, message: 'Timeout expired' }) } });
  try {
    await assert.rejects(G.getPosition(), (e) => !/Waiting/.test(e.message) && /No location fix arrived in time/.test(e.message));
  } finally { restore(); }
  const cbs = {};
  const restore2 = fakeNavigator({ geolocation: { watchPosition: (ok, err) => { cbs.ok = ok; cbs.err = err; return 1; }, clearWatch: () => {} } });
  try {
    const rec = G.createRecorder({});
    rec.start();
    cbs.err({ code: 3, message: 'Timeout expired' });
    assert.equal(rec.waiting, true); assert.equal(rec.error, null);
  } finally { restore2(); }
});

test('a lookup whose reply stalls halfway times out; a quick reply is not cut off', async (t) => {
  const savedFetch = globalThis.fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // headers arrive, then the body never does
    globalThis.fetch = async (url, init) => ({ ok: true, status: 200, json: () => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
    const stalled = G.femaDeclarations({ state: 'NC', since: '2024-01-01' });
    await new Promise((r) => setImmediate(r)); // let the request reach the body
    t.mock.timers.tick(13000);
    await assert.rejects(stalled, /The lookup timed out\./);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ DisasterDeclarationsSummaries: [] }) });
    assert.deepEqual(await G.femaDeclarations({ state: 'NC', since: '2024-01-01' }), []);
  } finally { t.mock.timers.reset(); globalThis.fetch = savedFetch; }
});

test('FEMA declarations: the county filter runs on the server and again locally, statewide rows pass, one row per declaration, dates are trimmed', async () => {
  const savedFetch = globalThis.fetch;
  let calledUrl = null;
  const row = (n, area, extra) => Object.assign({ disasterNumber: n, declarationTitle: 'Hurricane Helene', declarationType: 'DR', designatedArea: area, declarationDate: '2024-09-28T00:00:00.000Z', incidentType: 'Hurricane' }, extra || {});
  globalThis.fetch = async (url) => { calledUrl = String(url); return { ok: true, status: 200, json: async () => ({ DisasterDeclarationsSummaries: [
    row(4827, 'Buncombe (County)', { incidentBeginDate: '2024-09-25T00:00:00.000Z', incidentEndDate: '2024-10-01T00:00:00.000Z' }),
    row(4827, 'Buncombe (County)'), // the same declaration listed twice (individual and public assistance)
    row(4827, 'Wake (County)'),
    row(3617, 'Statewide', { declarationType: 'EM', declarationDate: '2024-09-26T00:00:00.000Z' }),
  ] }) }; };
  try {
    const rows = await G.femaDeclarations({ state: 'nc', county: 'Buncombe County', since: '2024-01-01' });
    assert.deepEqual(rows.map((r) => r.number), [4827, 3617]);
    assert.equal(rows[0].declared, '2024-09-28'); assert.equal(rows[0].begin, '2024-09-25'); assert.equal(rows[0].end, '2024-10-01'); assert.equal(rows[0].area, 'covers Buncombe'); assert.equal(rows[0].coversCounty, true);
    assert.equal(rows[1].area, 'Statewide'); assert.equal(rows[1].type, 'EM'); assert.equal(rows[1].end, '');
    const filter = decodeURIComponent(calledUrl);
    assert.match(filter, /state eq 'NC'/); assert.match(filter, /2024-01-01T00:00:00/);
    assert.match(filter, /substringof\('Buncombe', designatedArea\)/); assert.doesNotMatch(filter, /substringof\('buncombe'/, "FEMA's filter is case-sensitive");
    assert.match(filter, /designatedArea eq 'Statewide'/);
    const all = await G.femaDeclarations({ state: 'NC', since: '2024-01-01' });
    assert.deepEqual(all.map((r) => r.number), [4827, 3617], 'without a county every declaration is kept once');
    await assert.rejects(() => G.femaDeclarations({ state: 'North Carolina' }), /Pick a state first/);
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(() => G.femaDeclarations({ state: 'NC', since: '2024-01-01' }), /refused this request \(503\)/);
  } finally { globalThis.fetch = savedFetch; }
});

test('FEMA: a county the server does not recognise is asked again as the whole state and narrowed here', async () => {
  const savedFetch = globalThis.fetch;
  const urls = [];
  const row = (n, area, extra) => Object.assign({ disasterNumber: n, declarationTitle: 'Tropical Storm Helene', declarationType: 'DR', designatedArea: area, declarationDate: '2024-09-28T00:00:00.000Z', incidentType: 'Hurricane', incidentBeginDate: '2024-09-25T00:00:00.000Z' }, extra || {});
  globalThis.fetch = async (url) => {
    urls.push(decodeURIComponent(String(url)));
    const rows = urls.length === 1 ? [] : [row(4827, 'Buncombe (County)'), row(4827, 'Wake (County)'), row(3617, 'Statewide', { declarationType: 'EM' })];
    return { ok: true, status: 200, json: async () => ({ DisasterDeclarationsSummaries: rows }) };
  };
  try {
    const rows = await G.femaDeclarations({ state: 'NC', county: 'buncombe', since: '2024-01-01' });
    assert.equal(urls.length, 2, 'an empty county answer is retried without the county clause');
    assert.match(urls[0], /substringof\('buncombe', designatedArea\)/);
    assert.doesNotMatch(urls[1], /substringof/);
    assert.deepEqual(rows.map((r) => r.number), [4827, 3617], 'the Wake row is dropped here, the statewide row is kept');
  } finally { globalThis.fetch = savedFetch; }
});

test('FEMA: the window stops at the end of the tax year, so a later year is not offered first', async () => {
  const savedFetch = globalThis.fetch;
  let calledUrl = null;
  const row = (n, begin, declared) => ({ disasterNumber: n, declarationTitle: 'Storm', declarationType: 'DR', designatedArea: 'Statewide', declarationDate: declared, incidentType: 'Storm', incidentBeginDate: begin });
  globalThis.fetch = async (url) => { calledUrl = decodeURIComponent(String(url)); return { ok: true, status: 200, json: async () => ({ DisasterDeclarationsSummaries: [row(5582, '2025-05-03T00:00:00.000Z', '2025-05-03T00:00:00.000Z'), row(4827, '2024-09-25T00:00:00.000Z', '2024-09-28T00:00:00.000Z')] }) }; };
  try {
    const bounded = await G.femaDeclarations({ state: 'NC', since: '2024-01-01', until: '2025-01-01' });
    assert.match(calledUrl, /incidentBeginDate lt '2025-01-01/);
    assert.deepEqual(bounded.map((r) => r.number), [4827], 'the next year is dropped here too, whatever the server sends');
    const unbounded = await G.femaDeclarations({ state: 'NC', since: '2024-01-01' });
    assert.doesNotMatch(calledUrl, /incidentBeginDate lt/, 'the bound is opt-in');
    assert.deepEqual(unbounded.map((r) => r.number), [5582, 4827]);
  } finally { globalThis.fetch = savedFetch; }
});

test('FEMA: a declaration carries every area it designates, so coverage is not read off one arbitrary row', async () => {
  const savedFetch = globalThis.fetch;
  const row = (n, area, extra) => Object.assign({ disasterNumber: n, declarationTitle: 'Tropical Storm Helene', declarationType: 'DR', designatedArea: area, declarationDate: '2024-09-28T00:00:00.000Z', incidentType: 'Hurricane', incidentBeginDate: '2024-09-25T00:00:00.000Z' }, extra || {});
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ DisasterDeclarationsSummaries: [
    row(4827, 'Clay (County)'), row(4827, 'Buncombe (County)'), row(4827, 'Wake (County)'), row(3617, 'Statewide', { declarationType: 'EM' }),
  ] }) });
  try {
    const all = await G.femaDeclarations({ state: 'NC', since: '2024-01-01' });
    assert.deepEqual(all[0].areas, ['Buncombe', 'Clay', 'Wake']);
    assert.equal(all[0].areaCount, 3); assert.equal(all[0].coversCounty, null); assert.equal(all[0].area, '3 areas designated');
    assert.equal(all[1].statewide, true); assert.equal(all[1].area, 'Statewide');
    const mine = await G.femaDeclarations({ state: 'NC', county: 'Buncombe', since: '2024-01-01' });
    assert.equal(mine[0].coversCounty, true); assert.equal(mine[0].area, 'covers Buncombe');
    const elsewhere = await G.femaDeclarations({ state: 'NC', county: 'Durham', since: '2024-01-01' });
    assert.deepEqual(elsewhere.map((r) => r.number), [3617], 'only the statewide declaration reaches a county it does not designate');
    assert.equal(elsewhere[0].coversCounty, true);
  } finally { globalThis.fetch = savedFetch; }
});
