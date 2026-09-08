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
    const o = Object.assign({ maxAccuracy: 60, maxSpeed: 70, minStep: 6, minSpeed: 0.5, stillWindow: 90, stillFactor: 5 }, opts || {}); // speeds in m/s, window in s
    let total = 0, last = null, pending = null, recent = [];
    for (const p of points || []) {
      if (p && p.gap) { last = null; pending = null; recent = []; continue; } // a pause: the straight line to the resume point is not driven
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (p.acc != null && p.acc > o.maxAccuracy) continue;
      const speed = p.speed != null && isFinite(p.speed) && p.speed >= 0 ? p.speed : null;
      // a fix that reports itself as standing still is jitter, not distance
      if (speed != null && speed < o.minSpeed) continue;
      recent.push(p);
      while (recent.length > 1 && (Number(p.t) - Number(recent[0].t)) / 1000 > o.stillWindow) recent.shift();
      if (!last) { last = p; continue; }
      const d = haversineMeters(last, p);
      // a point must move farther than its own error radius before it counts, or a parked car drifts for miles
      const step = Math.max(o.minStep, ((Number(last.acc) || 0) + (Number(p.acc) || 0)) / 2);
      if (d < step) continue;
      // Wi-Fi and network fixes carry no speed, and drift clears the step above every few seconds, so a parked
      // phone books miles. Ask the whole window to have gone somewhere before such a fix may extend the track.
      if (speed == null && recent.length > 1) {
        const first = recent[0];
        const span = (Number(p.t) - Number(first.t)) / 1000;
        if (span >= 30 && haversineMeters(first, p) < Math.max(o.minSpeed * span, o.stillFactor * Math.max(Number(p.acc) || 0, Number(first.acc) || 0))) continue;
      }
      if (p.t != null && last.t != null) {
        const dt = (p.t - last.t) / 1000;
        if (dt <= 0 || d / dt > o.maxSpeed) {
          // impossible jump: if two rejected fixes agree with each other, the old anchor was the outlier — re-anchor without adding the jump
          if (pending && pending.t != null && p.t > pending.t && haversineMeters(pending, p) / ((p.t - pending.t) / 1000) <= o.maxSpeed) last = pending;
          pending = p;
          continue;
        }
      }
      total += d;
      last = p;
      pending = null;
    }
    return total;
  }
  const trackMiles = (points, opts) => metersToMiles(trackMeters(points, opts));

  /** Keep a point only when it has moved at least `stepMeters` from the last kept one. */
  function thin(points, stepMeters) {
    const step = stepMeters || 10;
    const out = [];
    let lastKept = null;
    for (const p of points || []) {
      if (p && p.gap) { if (out.length && !out[out.length - 1].gap) out.push(p); lastKept = null; continue; } // keep the pause marker
      if (!p || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (!lastKept || haversineMeters(lastKept, p) >= step) { out.push(p); lastKept = p; }
    }
    const tail = points && points.length > 1 ? points[points.length - 1] : null;
    if (tail && !tail.gap && out.length && out[out.length - 1] !== tail) out.push(tail);
    return out;
  }

  function bounds(points) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points || []) {
      if (!p || p.gap || !isFinite(p.lat) || !isFinite(p.lon)) continue;
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    return isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null;
  }

  /** Draw a track on a canvas: equirectangular projection fitted to the box, start/end markers, scale bar. */
  function sketch(canvas, points, opts) {
    if (!canvas || !canvas.getContext) return false;
    const o = Object.assign({ line: '#0e6b52', start: '#0e6b52', end: '#d03b3b', ink: '#75817a', bg: 'transparent', pad: 18, dpr: 1, maxAccuracy: 60, minExtentMeters: 150 }, opts || {});
    const ctx = canvas.getContext('2d');
    const dpr = o.dpr > 0 ? o.dpr : 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels on a device-pixel buffer
    const W = canvas.width / dpr, H = canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    if (o.bg !== 'transparent') { ctx.fillStyle = o.bg; ctx.fillRect(0, 0, W, H); }
    const finite = (points || []).filter((p) => p && (p.gap || (isFinite(p.lat) && isFinite(p.lon))));
    // the same accuracy gate as the distance, so a few wild fixes do not stretch the picture
    let pts = finite.filter((p) => p.gap || p.acc == null || p.acc <= o.maxAccuracy);
    if (pts.filter((p) => !p.gap).length < 2) pts = finite;
    const real = pts.filter((p) => !p.gap);
    const b = bounds(real);
    if (!b || real.length < 2) {
      ctx.fillStyle = o.ink; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(real.length ? 'Waiting for movement…' : 'No track yet', W / 2, H / 2);
      return false;
    }
    const midLat = (b.minLat + b.maxLat) / 2;
    const kx = Math.cos(toRad(midLat));
    // never magnify GPS jitter to fill the box: a track spans at least minExtentMeters
    const minDeg = o.minExtentMeters / ((Math.PI / 180) * EARTH_RADIUS_M);
    const spanX = Math.max(minDeg, (b.maxLon - b.minLon) * kx), spanY = Math.max(minDeg, b.maxLat - b.minLat);
    const scale = Math.min((W - 2 * o.pad) / spanX, (H - 2 * o.pad) / spanY);
    const cx = ((b.minLon + b.maxLon) / 2) * kx, cy = (b.minLat + b.maxLat) / 2;
    const X = (p) => W / 2 + (p.lon * kx - cx) * scale;
    const Y = (p) => H / 2 - (p.lat - cy) * scale;
    ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = o.line;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (p.gap) { pen = false; continue; } // a pause is a break in the line
      if (pen) ctx.lineTo(X(p), Y(p)); else ctx.moveTo(X(p), Y(p));
      pen = true;
    }
    ctx.stroke();
    const dot = (p, color) => { ctx.beginPath(); ctx.arc(X(p), Y(p), 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); };
    dot(real[0], o.start); dot(real[real.length - 1], o.end);
    // scale bar: a round number of miles that fits a third of the width (skipped when even the smallest would not fit)
    const metersPerPx = ((Math.PI / 180) * EARTH_RADIUS_M) / scale; // scale is px per degree of latitude
    const targetMiles = metersToMiles((W / 3) * metersPerPx);
    const nice = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100].filter((n) => n <= targetMiles).pop() || 0.05;
    const barPx = milesToMeters(nice) / metersPerPx;
    if (barPx <= W - 2 * o.pad) {
      ctx.strokeStyle = o.ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(o.pad, H - 8); ctx.lineTo(o.pad + barPx, H - 8); ctx.stroke();
      ctx.fillStyle = o.ink; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`${nice} mi`, o.pad, H - 12);
    }
    return true;
  }

  // ---- geolocation --------------------------------------------------------------

  const hasGeolocation = () => typeof navigator !== 'undefined' && !!navigator.geolocation;

  function toPoint(pos) {
    const speed = pos.coords.speed;
    return { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, speed: speed != null && isFinite(speed) ? speed : null, t: pos.timestamp || Date.now() };
  }

  function getPosition(opts) {
    return new Promise((resolve, reject) => {
      if (!hasGeolocation()) { reject(new Error('This device does not offer location.')); return; }
      navigator.geolocation.getCurrentPosition((pos) => resolve(toPoint(pos)), (err) => reject(new Error(geoErrorText(err, false))), Object.assign({ enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }, opts || {}));
    });
  }

  /** `watching` is true for the recorder's watch, which keeps trying; a one-shot request that timed out is over. */
  function geoErrorText(err, watching) {
    if (!err) return 'Location unavailable.';
    if (err.code === 1) return 'Location permission was denied. Allow it in the browser settings to record trips.';
    if (err.code === 2) return 'Location is unavailable right now.';
    if (err.code === 3) return watching ? 'Waiting for a GPS fix…' : 'No location fix arrived in time. Move somewhere with a clearer view of the sky, or type the coordinates.';
    return err.message || 'Location unavailable.';
  }

  const CHECKPOINT_FIXES = 10, CHECKPOINT_MS = 30000;
  /**
   * A user-controlled trip recorder. Nothing runs until start() is called, and stop()
   * releases the position watch and the screen wake lock.
   * handlers.onCheckpoint is handed the track so far every few fixes: a phone that discards the
   * page mid-drive loses only the seconds since the last one. Pass a checkpoint back as
   * `resumeFrom` to carry the same trip on.
   */
  function createRecorder(handlers, resumeFrom) {
    handlers = handlers || {};
    const rec = { state: 'idle', points: [], miles: 0, startedAt: null, endedAt: null, pausedMs: 0, pausedAt: null, last: null, error: null, waiting: false, watchId: null, wakeLock: null };
    let fromCheckpoint = false, sinceCheckpoint = 0, checkpointAt = 0;
    if (resumeFrom && resumeFrom.points && resumeFrom.points.length) {
      rec.points = resumeFrom.points.slice();
      rec.startedAt = resumeFrom.startedAt || Date.now();
      rec.pausedMs = Number(resumeFrom.pausedMs) || 0;
      rec.miles = roundMiles(trackMiles(rec.points));
      fromCheckpoint = true;
    }
    const checkpoint = (force) => {
      if (!handlers.onCheckpoint) return;
      const now = Date.now();
      if (!force && sinceCheckpoint < CHECKPOINT_FIXES && now - checkpointAt < CHECKPOINT_MS) return;
      sinceCheckpoint = 0; checkpointAt = now;
      handlers.onCheckpoint({ points: rec.points.slice(), miles: rec.miles, startedAt: rec.startedAt, pausedMs: rec.pausedMs, state: rec.state });
    };
    const update = () => { rec.miles = roundMiles(trackMiles(rec.points)); if (handlers.onUpdate) handlers.onUpdate(rec); };
    const clearWatch = () => { if (rec.watchId != null && hasGeolocation()) navigator.geolocation.clearWatch(rec.watchId); rec.watchId = null; };
    const onPos = (pos) => { if (rec.state !== 'recording') return; const p = toPoint(pos); rec.points.push(p); rec.last = p; rec.error = null; rec.waiting = false; sinceCheckpoint++; update(); checkpoint(false); };
    const onErr = (err) => {
      if (rec.state !== 'recording') return;
      if (err && err.code === 3) { rec.waiting = true; update(); return; } // no fix yet: a quiet status, not an error
      rec.error = geoErrorText(err, true);
      if (err && err.code === 1) { clearWatch(); unlock(); rec.state = 'idle'; rec.endedAt = Date.now(); } // permission denied: nothing is being recorded
      if (handlers.onError) handlers.onError(rec.error, rec);
      update();
    };
    const onVis = () => { if (rec.state === 'recording' && typeof document !== 'undefined' && document.visibilityState === 'visible') lock(); };
    async function lock() {
      try {
        if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
        if (rec.wakeLock && !rec.wakeLock.released) return;
        const wl = await navigator.wakeLock.request('screen');
        rec.wakeLock = wl;
        wl.addEventListener('release', () => { if (rec.wakeLock === wl) rec.wakeLock = null; }); // the browser released it (screen off, tab hidden)
      } catch (e) { /* optional */ }
    }
    async function unlock() {
      const wl = rec.wakeLock; rec.wakeLock = null;
      try { if (wl) await wl.release(); } catch (e) { /* optional */ }
    }
    rec.start = function () {
      if (!hasGeolocation()) { rec.error = 'This device does not offer location.'; if (handlers.onError) handlers.onError(rec.error, rec); return false; }
      if (rec.state === 'recording') return true;
      if (rec.state === 'idle') {
        // a recorder built from a checkpoint carries the same trip on: the interval the app was not running
        // was not recorded, so it is marked as a gap rather than counted as driven
        if (fromCheckpoint) { fromCheckpoint = false; rec.endedAt = null; rec.points.push({ gap: true }); }
        else { rec.points = []; rec.miles = 0; rec.startedAt = Date.now(); rec.endedAt = null; rec.pausedMs = 0; }
      }
      if (rec.state === 'paused') {
        if (rec.pausedAt) rec.pausedMs += Date.now() - rec.pausedAt;
        if (rec.points.length) rec.points.push({ gap: true }); // the distance between the pause and resume points was not driven
      }
      rec.pausedAt = null;
      rec.state = 'recording'; rec.error = null; rec.waiting = true;
      rec.watchId = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
      if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onVis);
      lock();
      update();
      return true;
    };
    rec.pause = function () {
      if (rec.state !== 'recording') return;
      rec.state = 'paused';
      rec.pausedAt = Date.now();
      clearWatch();
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVis);
      unlock();
      update();
      checkpoint(true);
    };
    rec.resume = function () { if (rec.state === 'paused') rec.start(); };
    rec.stop = function () {
      clearWatch();
      if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVis);
      unlock();
      if (rec.state === 'paused' && rec.pausedAt) rec.pausedMs += Date.now() - rec.pausedAt;
      rec.pausedAt = null;
      rec.state = 'idle';
      rec.endedAt = Date.now();
      rec.error = null; rec.waiting = false;
      update();
      checkpoint(true); // the track is still only in memory until the trip is logged
      return { points: thin(rec.points, 10), miles: rec.miles, startedAt: rec.startedAt, endedAt: rec.endedAt, pausedMs: rec.pausedMs };
    };
    return rec;
  }

  // ---- online lookups (fail soft) ----------------------------------------------------

  const isOnline = () => (typeof navigator === 'undefined' ? false : navigator.onLine !== false);

  async function fetchJSON(url, opts) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), (opts && opts.timeout) || 9000) : null;
    // the timer stays armed until the body has been read, so a reply that stalls halfway also times out
    try {
      let res;
      try {
        res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
      } catch (e) {
        throw new Error(/abort/i.test(String(e && e.name)) ? 'The lookup timed out.' : 'Online lookup is not available here. Check the connection, or enter the value by hand.');
      }
      // the status says what went wrong; "check the connection" would be misleading for a refusal
      if (res.status === 429) throw new Error('The lookup service is busy; try again in a minute.');
      if (!res.ok) throw new Error(`The lookup service refused this request (${res.status}). Enter the value by hand.`);
      try { return await res.json(); } catch (e) { throw new Error(/abort/i.test(String(e && e.name)) ? 'The lookup timed out.' : 'The lookup service sent an unreadable reply. Enter the value by hand.'); }
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
  /** "Wake (County)", "Orleans (Parish)", "Wake County" → "wake": the bare area name for exact comparison. */
  const areaName = (s) => String(s || '').toLowerCase().replace(/\s*\(.*\)\s*$/, '').replace(/\s+(county|parish|borough|census area|municipality|municipio|independent city|city and borough)$/, '').trim();
  /** The same trim with the capitals left alone: FEMA's own filter is case-sensitive, and this is what we show. */
  const bareArea = (s) => String(s || '').replace(/\s*\(.*\)\s*$/, '').replace(/\s+(county|parish|borough|census area|municipality|municipio|independent city|city and borough)$/i, '').trim();
  async function femaDeclarations(params) {
    const state = String(params.state || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) throw new Error('Pick a state first.');
    const since = params.since || `${new Date().getFullYear()}-01-01`;
    const until = params.until || '';
    const county = areaName(params.county);
    // A declaration is often dated weeks after the incident, so match either date against the tax year. The upper bound is
    // on the incident, so a late declaration of an in-year event still counts while a later year's disaster does not.
    let base = `state eq '${state}' and (declarationDate ge '${since}T00:00:00.000z' or incidentBeginDate ge '${since}T00:00:00.000z')`;
    if (until) base += ` and incidentBeginDate lt '${until}T00:00:00.000z'`;
    const ask = async (filter) => {
      const url = `https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=${encodeURIComponent(filter)}&$orderby=declarationDate%20desc&$top=1000&$select=disasterNumber,declarationTitle,declarationDate,declarationType,designatedArea,incidentType,incidentBeginDate,incidentEndDate,state`;
      const data = await fetchJSON(url, { timeout: 12000 });
      return (data && data.DisasterDeclarationsSummaries) || [];
    };
    // The county filter runs on the server too, so the row cap applies to this county's declarations rather than to the
    // whole state's. It is a case-sensitive string match, so the name goes over the wire as FEMA writes it.
    let items = await ask(county ? `${base} and (substringof('${bareArea(params.county).replace(/'/g, "''")}', designatedArea) or designatedArea eq 'Statewide')` : base);
    // a county spelled differently from FEMA's own list must not read as "no disasters here": ask again for the
    // whole state and narrow it below
    if (county && !items.length) items = await ask(base);
    if (county) items = items.filter((d) => areaName(d.designatedArea) === county || /statewide/i.test(d.designatedArea || ''));
    if (until) items = items.filter((d) => { const b = String(d.incidentBeginDate || '').slice(0, 10); return !b || b < until; });
    // FEMA lists a declaration once per designated area. Gather them all: naming whichever row came first would
    // tell the user their own county is or is not covered on the strength of an accident of ordering.
    const byNumber = new Map();
    for (const d of items) {
      let rec = byNumber.get(d.disasterNumber);
      if (!rec) {
        rec = { number: d.disasterNumber, title: d.declarationTitle, type: d.declarationType, declared: String(d.declarationDate || '').slice(0, 10), incident: d.incidentType, begin: String(d.incidentBeginDate || '').slice(0, 10), end: String(d.incidentEndDate || '').slice(0, 10), areas: [], areaCount: 0, statewide: false, coversCounty: county ? false : null, area: '' };
        byNumber.set(d.disasterNumber, rec);
      }
      if (/statewide/i.test(d.designatedArea || '')) { rec.statewide = true; if (county) rec.coversCounty = true; }
      else {
        const name = bareArea(d.designatedArea);
        if (name && rec.areas.indexOf(name) < 0) rec.areas.push(name);
        if (county && areaName(d.designatedArea) === county) rec.coversCounty = true;
      }
    }
    const out = Array.from(byNumber.values());
    for (const rec of out) {
      rec.areas.sort();
      rec.areaCount = rec.areas.length;
      rec.area = rec.statewide ? 'Statewide'
        : rec.coversCounty ? `covers ${bareArea(params.county)}`
        : rec.areaCount === 1 ? rec.areas[0]
        : rec.areaCount ? `${rec.areaCount} areas designated` : 'Designated areas not listed';
    }
    return out;
  }

  const osmLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;

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

  return { ROAD_FACTOR, areaName, haversineMeters, haversineMiles, metersToMiles, milesToMeters, roundMiles, estimateRoadMiles, trackMeters, trackMiles, thin, bounds, sketch, hasGeolocation, getPosition, createRecorder, isOnline, geocode, reverse, routeMiles, femaDeclarations, osmLink, US_STATES, PLACE_CATEGORIES, lineForCategory };
});
