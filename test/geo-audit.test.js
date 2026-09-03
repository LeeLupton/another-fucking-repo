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
