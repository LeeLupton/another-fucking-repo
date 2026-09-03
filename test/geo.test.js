const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/geo.js');

const NYC = { lat: 40.7128, lon: -74.006 };
const LA = { lat: 34.0522, lon: -118.2437 };

test('great-circle distance: New York to Los Angeles is about 2,450 miles', () => {
  const mi = G.haversineMiles(NYC, LA);
  assert.ok(mi > 2440 && mi < 2460, `got ${mi}`);
  assert.equal(G.haversineMeters(NYC, NYC), 0);
  assert.equal(G.roundMiles(12.34), 12.3);
  assert.equal(G.ROAD_FACTOR, 1.25);
  assert.equal(G.estimateRoadMiles({ lat: 35.0, lon: -80.0 }, { lat: 35.0, lon: -80.1 }), 7.1, '5.66 straight-line miles at 35°N, times 1.25, to a tenth');
  assert.equal(G.estimateRoadMiles({ lat: 35.0, lon: -80.0 }, { lat: 35.0, lon: -80.0 }), 0);
});

test('track length ignores GPS jitter, poor fixes, and teleports', () => {
  // ~0.9 km east along a parallel, 100 m per point, 10 s apart
  const pts = [];
  for (let i = 0; i <= 9; i++) pts.push({ lat: 35.0, lon: -80.0 + (i * 100) / 91000, t: i * 10000, acc: 10 });
  const clean = G.trackMeters(pts);
  assert.ok(clean > 880 && clean < 920, `clean ${clean}`);
  // jitter: tiny wobbles under the minimum step do not add up
  const jitter = pts.flatMap((p, i) => [p, { lat: p.lat + 0.00001, lon: p.lon, t: p.t + 1000, acc: 10 }]);
  assert.ok(Math.abs(G.trackMeters(jitter) - clean) < 15);
  // a point with 500 m accuracy is skipped; a teleport 50 km away in one second is skipped
  const bad = pts.slice();
  bad.splice(5, 0, { lat: 35.01, lon: -80.0, t: 45000, acc: 500 });
  bad.splice(7, 0, { lat: 35.45, lon: -80.0, t: 61000, acc: 5 });
  assert.ok(Math.abs(G.trackMeters(bad) - clean) < 15, `filtered ${G.trackMeters(bad)}`);
  assert.equal(G.trackMiles([]), 0);
});

test('thinning keeps shape with fewer points; bounds are right', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push({ lat: 35.0 + i * 0.00002, lon: -80.0, t: i * 1000, acc: 5 });
  const thin = G.thin(pts, 50);
  assert.ok(thin.length < pts.length && thin.length >= 4);
  assert.equal(thin[thin.length - 1], pts[pts.length - 1], 'last point kept');
  const b = G.bounds(pts);
  assert.equal(b.minLat, 35.0);
  assert.equal(b.maxLat, 35.0 + 100 * 0.00002);
  assert.equal(G.bounds([]), null);
});

test('sketch degrades gracefully without a canvas', () => {
  assert.equal(G.sketch(null, []), false);
  assert.equal(G.sketch({}, []), false);
});

test('place categories map to the right mileage lines', () => {
  assert.equal(G.lineForCategory('medical'), 'med.miles');
  assert.equal(G.lineForCategory('business'), 'se.miles');
  assert.equal(G.lineForCategory('charity'), 'vol.miles');
  assert.equal(G.lineForCategory('home'), null);
  assert.equal(G.US_STATES.length, 51);
  assert.match(G.osmLink(35, -80), /openstreetmap\.org/);
});
