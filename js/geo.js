/*
 * geo.js — geography for the mileage lines.
 *
 * Every deductible mile needs a contemporaneous log: date, destination,
 * purpose, miles. This module supplies the geography behind that log:
 *
 *   - great-circle distance between two points, and the length of a recorded
 *     track with GPS noise filtered out
 *   - a trip recorder over the browser's Geolocation API: the user starts it
 *     when they leave and stops it when they arrive; positions stay on the
 *     device with the trip they belong to
 *   - a canvas sketch of a track, so a trip can be seen without map tiles
 *   - optional online lookups that fail soft when offline: address search and
 *     reverse lookup (OpenStreetMap Nominatim), road distance (OSRM), and
 *     federal disaster declarations (OpenFEMA) for the casualty line
 *
 * Pure functions run under node --test; the browser parts guard for absence.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerGeo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EARTH_RADIUS_M = 6371008.8;
  const M_PER_MILE = 1609.344;
  /** Typical ratio of road distance to straight-line distance for US driving. */
  const ROAD_FACTOR = 1.25;
  const toRad = (d) => (d * Math.PI) / 180;

  // ---- distances ---------------------------------------------------------------

  function haversineMeters(a, b) {
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  const metersToMiles = (m) => m / M_PER_MILE;
  const milesToMeters = (mi) => mi * M_PER_MILE;
  const haversineMiles = (a, b) => metersToMiles(haversineMeters(a, b));
  const roundMiles = (mi) => Math.round(mi * 10) / 10;
  const estimateRoadMiles = (a, b) => roundMiles(haversineMiles(a, b) * ROAD_FACTOR);

  /**
   * Length of a recorded track with GPS noise removed.
   * points: [{lat, lon, t (ms), acc (m)}]. Points with poor accuracy are skipped,
   * tiny wobbles are ignored, and impossible jumps (teleports) are dropped.
   */
  function trackMeters(points, opts) {
    const o = Object.assign({ maxAccuracy: 60, maxSpeed: 70, minStep: 6 }, opts || {}); // maxSpeed in m/s
    let total = 0, last = null;
    for (const p of points || []) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (p.acc != null && p.acc > o.maxAccuracy) continue;
      if (!last) { last = p; continue; }
      const d = haversineMeters(last, p);
      if (d < o.minStep) continue;
      if (p.t != null && last.t != null) {
        const dt = (p.t - last.t) / 1000;
        if (dt > 0 && d / dt > o.maxSpeed) continue;
      }
      total += d;
      last = p;
    }
    return total;
  }
  const trackMiles = (points, opts) => metersToMiles(trackMeters(points, opts));

  /** Keep a point only when it has moved at least `stepMeters` from the last kept one. */
  function thin(points, stepMeters) {
    const step = stepMeters || 10;
    const out = [];
    for (const p of points || []) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (!out.length || haversineMeters(out[out.length - 1], p) >= step) out.push(p);
    }
    if (points && points.length > 1 && out.length && out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  function bounds(points) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points || []) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    return isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;
  }

  /** Draw a track on a canvas: equirectangular projection fitted to the box, start/end markers, scale bar. */
  function sketch(canvas, points, opts) {
    if (!canvas || !canvas.getContext) return false;
    const o = Object.assign({ line: '#0e6b52', start: '#0e6b52', end: '#d03b3b', ink: '#75817a', bg: 'transparent', pad: 18 }, opts || {});
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (o.bg !== 'transparent') { ctx.fillStyle = o.bg; ctx.fillRect(0, 0, W, H); }
    const pts = (points || []).filter((p) => p && isFinite(p.lat) && isFinite(p.lon));
    const b = bounds(pts);
    if (!b || pts.length < 2) {
      ctx.fillStyle = o.ink; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(pts.length ? 'Waiting for movement…' : 'No track yet', W / 2, H / 2);
      return false;
    }
    const midLat = (b.minLat + b.maxLat) / 2;
    const kx = Math.cos(toRad(midLat));
    const spanX = Math.max(1e-6, (b.maxLon - b.minLon) * kx), spanY = Math.max(1e-6, b.maxLat - b.minLat);
    const scale = Math.min((W - 2 * o.pad) / spanX, (H - 2 * o.pad) / spanY);
    const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    const X = (p) => offX + (p.lon - b.minLon) * kx * scale;
    const Y = (p) => H - (offY + (p.lat - b.minLat) * scale);
    ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = o.line;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))));
    ctx.stroke();
    const dot = (p, color) => { ctx.beginPath(); ctx.arc(X(p), Y(p), 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); };
    dot(pts[0], o.start); dot(pts[pts.length - 1], o.end);
    // scale bar: a round number of miles that fits a third of the width
    const metersPerPx = 1 / (scale * (Math.PI / 180) * EARTH_RADIUS_M); // degrees → meters, latitude direction
    const targetMiles = metersToMiles((W / 3) * metersPerPx);
    const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((n) => n <= targetMiles).pop() || 0.1;
    const barPx = milesToMeters(nice) / metersPerPx;
    ctx.strokeStyle = o.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(o.pad, H - 8); ctx.lineTo(o.pad + barPx, H - 8); ctx.stroke();
    ctx.fillStyle = o.ink; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`${nice} mi`, o.pad, H - 12);
    return true;
  }

  // ---- geolocation --------------------------------------------------------------

  const hasGeolocation = () => typeof navigator !== 'undefined' && !!navigator.geolocation;

  function toPoint(pos) {
    return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: pos.timestamp || Date.now() };
  }

  function getPosition(opts) {
    return new Promise((resolve, reject) => {
      if (!hasGeolocation()) { reject(new Error('This device does not offer location.')); return; }
      navigator.geolocation.getCurrentPosition((pos) => resolve(toPoint(pos)), (err) => reject(new Error(geoErrorText(err))), Object.assign({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }, opts || {}));
    });
  }

  function geoErrorText(err) {
    if (!err) return 'Location unavailable.';
    if (err.code === 1) return 'Location permission was denied. Allow it in the browser settings to record trips.';
    if (err.code === 2) return 'Location is unavailable right now.';
    if (err.code === 3) return 'Location timed out. Try again outdoors or with GPS on.';
    return err.message || 'Location unavailable.';
  }

  /**
   * A user-controlled trip recorder. Nothing runs until start() is called, and stop()
   * releases the position watch and the screen wake lock.
   */
  function createRecorder(handlers) {
    handlers = handlers || {};
    const rec = { state: 'idle', points: [], miles: 0, startedAt: null, endedAt: null, last: null, error: null, watchId: null, wakeLock: null };
    const update = () => { rec.miles = roundMiles(trackMiles(rec.points)); if (handlers.onUpdate) handlers.onUpdate(rec); };
    const onPos = (pos) => { if (rec.state !== 'recording') return; const p = toPoint(pos); rec.points.push(p); rec.last = p; update(); };
    const onErr = (err) => { if (rec.state !== 'recording') return; rec.error = geoErrorText(err); if (handlers.onError) handlers.onError(rec.error, rec); };
    async function lock() {
      try { if (typeof navigator !== 'undefined' && navigator.wakeLock && !rec.wakeLock) rec.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    }
    async function unlock() {
      try { if (rec.wakeLock) { await rec.wakeLock.release(); rec.wakeLock = null; } } catch (e) { /* optional */ }
    }
    rec.start = function () {
      if (!hasGeolocation()) { rec.error = 'This device does not offer location.'; if (handlers.onError) handlers.onError(rec.error, rec); return false; }
      if (rec.state === 'recording') return true;
      if (rec.state === 'idle') { rec.points = []; rec.miles = 0; rec.startedAt = Date.now(); rec.endedAt = null; }
      rec.state = 'recording'; rec.error = null;
      rec.watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      lock();
      update();
      return true;
    };
    rec.pause = function () {
      if (rec.state !== 'recording') return;
      rec.state = 'paused';
      if (rec.watchId != null) { navigator.geolocation.clearWatch(rec.watchId); rec.watchId = null; }
      unlock();
      update();
    };
    rec.resume = function () { if (rec.state === 'paused') rec.start(); };
    rec.stop = function () {
      if (rec.watchId != null) { navigator.geolocation.clearWatch(rec.watchId); rec.watchId = null; }
      unlock();
      rec.state = 'idle';
      rec.endedAt = Date.now();
      rec.error = null;
      update();
      return { points: thin(rec.points, 10), miles: rec.miles, startedAt: rec.startedAt, endedAt: rec.endedAt };
    };
    return rec;
  }

  // ---- online lookups (fail soft) ----------------------------------------------------

  const isOnline = () => (typeof navigator === 'undefined' ? false : navigator.onLine !== false);

  async function fetchJSON(url, opts) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), (opts && opts.timeout) || 9000) : null;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
      if (!res.ok) throw new Error(`Lookup failed (${res.status}).`);
      return await res.json();
    } catch (e) {
      throw new Error(/abort/i.test(String(e && e.name)) ? 'The lookup timed out.' : 'Online lookup is not available here. Check the connection, or enter the value by hand.');
    } finally { if (timer) clearTimeout(timer); }
  }

  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  function stateCodeFrom(address) {
    const iso = address && (address['ISO3166-2-lvl4'] || address['ISO3166-2-lvl3']);
    return iso && /^US-([A-Z]{2})$/.test(iso) ? iso.slice(3) : null;
  }
  /** Address search. Returns up to five candidates. */
  async function geocode(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const data = await fetchJSON(`${NOMINATIM}/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`);
    return (data || []).map((r) => ({ name: r.display_name, lat: Number(r.lat), lon: Number(r.lon), state: r.address && r.address.state, stateCode: stateCodeFrom(r.address), county: r.address && r.address.county, postcode: r.address && r.address.postcode }));
  }
  /** What is at these coordinates. */
  async function reverse(lat, lon) {
    const r = await fetchJSON(`${NOMINATIM}/reverse?format=jsonv2&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    if (!r || r.error) throw new Error('No address found for that location.');
    return { name: r.display_name, state: r.address && r.address.state, stateCode: stateCodeFrom(r.address), county: r.address && r.address.county, postcode: r.address && r.address.postcode, city: r.address && (r.address.city || r.address.town || r.address.village) };
  }
  /** Driving distance in miles between two points. */
  async function routeMiles(from, to) {
    const data = await fetchJSON(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`);
    const route = data && data.routes && data.routes[0];
    if (!route) throw new Error('No road route found between those points.');
    return roundMiles(metersToMiles(route.distance));
  }
  /**
   * Federal disaster declarations for a state since a date, optionally narrowed to a county.
   * Source: OpenFEMA DisasterDeclarationsSummaries (public, no key).
   */
  async function femaDeclarations(params) {
    const state = String(params.state || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw new Error('Pick a state first.');
    const since = params.since || `${new Date().getFullYear()}-01-01`;
    const filter = `state eq '${state}' and declarationDate ge '${since}T00:00:00.000z'`;
    const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(filter)}&$orderby=declarationDate%20desc&$top=100&$select=disasterNumber,declarationTitle,declarationDate,declarationType,designatedArea,incidentType,incidentBeginDate,incidentEndDate,state`;
    const data = await fetchJSON(url, { timeout: 12000 });
    let items = (data && data.DisasterDeclarationsSummaries) || [];
    if (params.county) { const c = String(params.county).toLowerCase().replace(/\s+county$/, ''); items = items.filter((d) => String(d.designatedArea || '').toLowerCase().includes(c) || /statewide/i.test(d.designatedArea || '')); }
    // one row per declaration number
    const seen = new Set();
    return items.filter((d) => { if (seen.has(d.disasterNumber)) return false; seen.add(d.disasterNumber); return true; })
      .map((d) => ({ number: d.disasterNumber, title: d.declarationTitle, type: d.declarationType, declared: String(d.declarationDate || '').slice(0, 10), area: d.designatedArea, incident: d.incidentType, begin: String(d.incidentBeginDate || '').slice(0, 10), end: String(d.incidentEndDate || '').slice(0, 10) }));
  }

  const osmLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
  const geoURI = (lat, lon) => `geo:${lat},${lon}`;

  const US_STATES = [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming']].map(([code, name]) => ({ code, name }));

  const PLACE_CATEGORIES = [
    { id: 'home', label: 'Home', lineId: null },
    { id: 'medical', label: 'Medical (doctor, pharmacy, therapy)', lineId: 'med.miles' },
    { id: 'business', label: 'Business (client, job site, supplier)', lineId: 'se.miles' },
    { id: 'charity', label: 'Charity (church, scouts, food bank)', lineId: 'vol.miles' },
    { id: 'school', label: 'School', lineId: null },
    { id: 'other', label: 'Other', lineId: null },
  ];
  const lineForCategory = (cat) => { const c = PLACE_CATEGORIES.find((x) => x.id === cat); return c ? c.lineId : null; };

  return { ROAD_FACTOR, haversineMeters, haversineMiles, metersToMiles, milesToMeters, roundMiles, estimateRoadMiles, trackMeters, trackMiles, thin, bounds, sketch, hasGeolocation, getPosition, createRecorder, isOnline, geocode, reverse, routeMiles, femaDeclarations, osmLink, geoURI, US_STATES, PLACE_CATEGORIES, lineForCategory };
});
