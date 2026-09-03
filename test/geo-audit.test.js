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
    assert.equal(rows[0].declared, '2024-09-28'); assert.equal(rows[0].begin, '2024-09-25'); assert.equal(rows[0].end, '2024-10-01'); assert.equal(rows[0].area, 'Buncombe (County)');
    assert.equal(rows[1].area, 'Statewide'); assert.equal(rows[1].type, 'EM'); assert.equal(rows[1].end, '');
    const filter = decodeURIComponent(calledUrl);
    assert.match(filter, /state eq 'NC'/); assert.match(filter, /2024-01-01T00:00:00/);
    assert.match(filter, /substringof\('Buncombe', designatedArea\)/i); assert.match(filter, /designatedArea eq 'Statewide'/);
    const all = await G.femaDeclarations({ state: 'NC', since: '2024-01-01' });
    assert.deepEqual(all.map((r) => r.number), [4827, 3617], 'without a county every declaration is kept once');
    await assert.rejects(() => G.femaDeclarations({ state: 'North Carolina' }), /Pick a state first/);
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(() => G.femaDeclarations({ state: 'NC', since: '2024-01-01' }), /refused this request \(503\)/);
  } finally { globalThis.fetch = savedFetch; }
});
