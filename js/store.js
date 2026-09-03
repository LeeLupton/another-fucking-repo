/*
 * store.js — local-first persistence.
 *
 * Everything stays on the device: entries, settings, and receipt images live in
 * IndexedDB (receipts are Blobs, so a year of photos fits comfortably). When
 * IndexedDB is unavailable the store falls back to localStorage for entries and
 * settings (receipts then cannot be stored, and the UI says so).
 *
 * Backups are a single JSON file (receipts embedded as data URLs) that imports
 * back into any browser.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'itemizer';
  const DB_VERSION = 2;
  const LS_KEY = 'itemizer:fallback';
  const SETTINGS_KEY = 'main';

  const DEFAULT_SETTINGS = {
    taxYear: new Date().getFullYear(),
    taxpayerName: '', // the name on the return, printed on the worksheet so the preparer knows whose sheet it is
    filingStatus: 'single',
    agi: '',
    age65: false,
    blind: false,
    spouseAge65: false,
    spouseBlind: false,
    gamblingWinnings: '',
    stateWithholding: '',
    casualtyFederalDisaster: false,
    casualtyQualifiedDisaster: false,
    paramOverrides: {},
    learned: {},
    theme: 'system',
    advisorDismissed: {},
    state: '',
    county: '',
    disasterNumber: '',
    importMappings: {},
    experiments: { snapshots: true, corrections: true, nudges: true },
    forecastSnapshots: [],
    keywordWeights: {},
  };

  let dbPromise = null;
  let mode = 'idb';
  let notice = null; // a storage condition the UI should mention ("close other tabs")

  /** Copy only known settings keys, coerced to the type of the default. Backups and stored records are untrusted input. */
  function sanitizeSettings(raw) {
    const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); // fresh objects every time: nothing shared with the defaults
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in raw)) continue;
      const def = DEFAULT_SETTINGS[k], v = raw[k];
      if (typeof def === 'boolean') out[k] = !!v;
      else if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
      else if (typeof def === 'string') out[k] = v == null ? '' : String(v).slice(0, 200);
      else if (Array.isArray(def)) out[k] = Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, 500) : def;
      else if (def && typeof def === 'object') out[k] = v && typeof v === 'object' && !Array.isArray(v) ? Object.assign({}, v) : {};
    }
    if (!(out.taxYear >= 2000 && out.taxYear <= 2100)) out.taxYear = DEFAULT_SETTINGS.taxYear;
    if (!['single', 'mfj', 'mfs', 'hoh', 'qss'].includes(out.filingStatus)) out.filingStatus = 'single';
    if (!['system', 'light', 'dark'].includes(out.theme)) out.theme = 'system';
    out.experiments = Object.assign({}, DEFAULT_SETTINGS.experiments, out.experiments);
    return out;
  }

  /** Once IndexedDB is back, anything an earlier localStorage-only session saved is folded in so no data is orphaned. */
  async function migrateFallback(db) {
    let d = null;
    try { d = typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) ? JSON.parse(localStorage.getItem(LS_KEY)) : null; } catch (e) { d = null; }
    if (!d || typeof d !== 'object') return;
    try {
      const have = new Set((await tx(db, 'entries', 'readonly', (os) => os.getAllKeys())) || []);
      const entries = (d.entries || []).filter((e) => e && typeof e.id === 'string' && !have.has(e.id));
      if (entries.length) await tx(db, 'entries', 'readwrite', (os) => { entries.forEach((e) => os.put(e)); });
      for (const store of ['places', 'trips']) {
        const keys = new Set((await tx(db, store, 'readonly', (os) => os.getAllKeys())) || []);
        const rows = (d[store] || []).filter((x) => x && typeof x.id === 'string' && !keys.has(x.id));
        if (rows.length) await tx(db, store, 'readwrite', (os) => { rows.forEach((x) => os.put(x)); });
      }
      const cur = await tx(db, 'settings', 'readonly', (os) => os.get(SETTINGS_KEY));
      if (!cur && d.settings) await tx(db, 'settings', 'readwrite', (os) => os.put({ key: SETTINGS_KEY, value: sanitizeSettings(d.settings) }));
      localStorage.removeItem(LS_KEY);
    } catch (e) { /* leave the fallback data in place for the next start */ }
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      // localStorage is only for browsers with no IndexedDB at all; a blocked or failing open must not fork the data
      if (typeof indexedDB === 'undefined') { mode = 'local'; resolve(null); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { mode = 'local'; resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) {
          const es = db.createObjectStore('entries', { keyPath: 'id' });
          es.createIndex('taxYear', 'taxYear');
          es.createIndex('date', 'date');
        }
        if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        // v2: saved places and the mileage log
        if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('trips')) {
          const ts = db.createObjectStore('trips', { keyPath: 'id' });
          ts.createIndex('date', 'date');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        notice = null;
        // another tab wants to upgrade, or the browser closed the connection: let go and reopen on the next call
        db.onversionchange = () => { db.close(); dbPromise = null; notice = 'Storage was updated in another tab; reload to continue.'; };
        db.onclose = () => { dbPromise = null; };
        migrateFallback(db).then(() => resolve(db), () => resolve(db));
      };
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('The browser refused to open local storage.')); };
      req.onblocked = () => { notice = 'Close other Itemizer tabs to finish updating storage.'; /* onsuccess still fires once they close */ };
    });
    return dbPromise;
  }

  function tx(db, store, modeName, fn, retried) {
    return new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(store, modeName); } catch (e) {
        // the connection was closed underneath us: reopen once and retry
        if (!retried && e && e.name === 'InvalidStateError') { dbPromise = null; openDB().then((db2) => tx(db2, store, modeName, fn, true)).then(resolve, reject); return; }
        reject(e); return;
      }
      const os = t.objectStore(store);
      let result;
      try { result = fn(os); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }
  function reqToPromise(req) {
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }

  // ---- localStorage fallback ------------------------------------------------
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function lsWrite(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); return true; } catch (e) { throw new Error('Storage is full or unavailable; nothing was saved. Download a backup and free some space.'); }
  }

  // ---- public API -----------------------------------------------------------

  async function getEntries() {
    const db = await openDB();
    if (!db) return (lsRead().entries || []);
    const all = await tx(db, 'entries', 'readonly', (os) => os.getAll());
    return all || [];
  }

  async function putEntry(entry) {
    const db = await openDB();
    if (!db) { const d = lsRead(); d.entries = (d.entries || []).filter((e) => e.id !== entry.id).concat([entry]); lsWrite(d); return entry; }
    await tx(db, 'entries', 'readwrite', (os) => os.put(entry));
    return entry;
  }

  async function putEntries(entries) {
    const db = await openDB();
    if (!db) { const d = lsRead(); const ids = new Set(entries.map((e) => e.id)); d.entries = (d.entries || []).filter((e) => !ids.has(e.id)).concat(entries); lsWrite(d); return entries; }
    await tx(db, 'entries', 'readwrite', (os) => { entries.forEach((e) => os.put(e)); });
    return entries;
  }

  async function deleteEntry(id) {
    const db = await openDB();
    if (!db) { const d = lsRead(); d.entries = (d.entries || []).filter((e) => e.id !== id); lsWrite(d); return; }
    const entry = await tx(db, 'entries', 'readonly', (os) => os.get(id));
    await tx(db, 'entries', 'readwrite', (os) => os.delete(id));
    if (entry && entry.receiptId) await deleteReceipt(entry.receiptId);
  }

  async function deleteEntries(ids) {
    for (const id of ids) await deleteEntry(id);
  }

  async function putReceipt(receipt) {
    const db = await openDB();
    if (!db) throw new Error('Receipt photos need IndexedDB, which this browser does not provide.');
    await tx(db, 'receipts', 'readwrite', (os) => os.put(receipt));
    return receipt;
  }
  async function getReceipt(id) {
    const db = await openDB();
    if (!db || !id) return null;
    return (await tx(db, 'receipts', 'readonly', (os) => os.get(id))) || null;
  }
  async function deleteReceipt(id) {
    const db = await openDB();
    if (!db || !id) return;
    await tx(db, 'receipts', 'readwrite', (os) => os.delete(id));
  }
  async function getAllReceipts() {
    const db = await openDB();
    if (!db) return [];
    return (await tx(db, 'receipts', 'readonly', (os) => os.getAll())) || [];
  }

  // ---- places and trips (the mileage log) ----------------------------------------
  async function getAllFrom(store) {
    const db = await openDB();
    if (!db) return lsRead()[store] || [];
    return (await tx(db, store, 'readonly', (os) => os.getAll())) || [];
  }
  async function putInto(store, obj) {
    const db = await openDB();
    if (!db) { const d = lsRead(); d[store] = (d[store] || []).filter((x) => x.id !== obj.id).concat([obj]); lsWrite(d); return obj; }
    await tx(db, store, 'readwrite', (os) => os.put(obj));
    return obj;
  }
  async function deleteFrom(store, id) {
    const db = await openDB();
    if (!db) { const d = lsRead(); d[store] = (d[store] || []).filter((x) => x.id !== id); lsWrite(d); return; }
    await tx(db, store, 'readwrite', (os) => os.delete(id));
  }
  const getPlaces = () => getAllFrom('places');
  const putPlace = (place) => putInto('places', place);
  const deletePlace = (id) => deleteFrom('places', id);
  const getTrips = () => getAllFrom('trips');
  const putTrip = (trip) => putInto('trips', trip);
  const deleteTrip = (id) => deleteFrom('trips', id);

  async function getSettings() {
    const db = await openDB();
    let saved = null;
    if (!db) saved = lsRead().settings || null;
    else { const rec = await tx(db, 'settings', 'readonly', (os) => os.get(SETTINGS_KEY)); saved = rec ? rec.value : null; }
    return sanitizeSettings(saved);
  }
  async function saveSettings(settings) {
    const db = await openDB();
    const value = sanitizeSettings(settings);
    if (!db) { const d = lsRead(); d.settings = value; lsWrite(d); return value; }
    await tx(db, 'settings', 'readwrite', (os) => os.put({ key: SETTINGS_KEY, value }));
    return value;
  }

  // ---- backup / restore -------------------------------------------------------

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  }
  const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|jpg|png|webp|gif|heic|heif));base64,([A-Za-z0-9+/=\s]+)$/i;
  const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;
  /** Decode an image data URL locally (no fetch of untrusted URLs); rejects anything that is not a base64 image or is too large. */
  async function dataURLToBlob(dataURL) {
    const m = IMAGE_DATA_URL.exec(String(dataURL || ''));
    if (!m) throw new Error('Not an image.');
    const b64 = m[2].replace(/\s+/g, '');
    if (b64.length * 0.75 > MAX_RECEIPT_BYTES) throw new Error('Receipt image too large.');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1].toLowerCase().replace('jpg', 'jpeg') });
  }

  /** The backup without receipts; the receipt images are added as separate Blob parts by exportBackup so no giant string is built. */
  async function exportJSON(opts) {
    opts = opts || {};
    const [entries, settings, places, trips] = await Promise.all([getEntries(), getSettings(), getPlaces(), getTrips()]);
    const out = { app: 'itemizer', version: 2, exportedAt: new Date().toISOString(), settings, entries, places, trips, receipts: [] };
    if (opts.includeReceipts !== false) {
      const receipts = await getAllReceipts();
      for (const r of receipts) {
        try { out.receipts.push({ id: r.id, entryId: r.entryId, type: r.type, createdAt: r.createdAt, dataURL: await blobToDataURL(r.blob) }); } catch (e) { /* skip unreadable */ }
      }
    }
    return out;
  }
  /**
   * The backup as a Blob assembled from parts: one JSON string for everything but the receipts, then each receipt's data URL as
   * its own part, so a year of photos never has to exist as one string. Returns { blob, receipts, failed }.
   */
  async function exportBackup(opts) {
    opts = opts || {};
    const head = await exportJSON({ includeReceipts: false });
    const json = JSON.stringify(head);
    const parts = [json.slice(0, json.lastIndexOf('"receipts":[]') + '"receipts":['.length)];
    let count = 0, failed = 0;
    if (opts.includeReceipts !== false) {
      for (const r of await getAllReceipts()) {
        try {
          const dataURL = await blobToDataURL(r.blob);
          parts.push((count ? ',' : '') + JSON.stringify({ id: r.id, entryId: r.entryId, type: r.type, createdAt: r.createdAt }).slice(0, -1) + ',"dataURL":"', dataURL, '"}');
          count++;
        } catch (e) { failed++; }
      }
    }
    parts.push(']}');
    return { blob: new Blob(parts, { type: 'application/json' }), receipts: count, failed };
  }

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  /** An entry from a backup, or null when it cannot be trusted. `schema` (ItemizerSchema) validates the line id when given. */
  function sanitizeEntry(e, schema) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.lineId !== 'string' || typeof e.date !== 'string' || !ISO_DAY.test(e.date)) return null;
    if (schema && schema.getLine && !schema.getLine(e.lineId)) return null;
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
    const out = {
      id: e.id.slice(0, 64), date: e.date, taxYear: Number(e.taxYear) || Number(e.date.slice(0, 4)), lineId: e.lineId, amount: Math.round(amount * 100) / 100,
      description: str(e.description, 300), note: str(e.note, 4000), hasReceipt: !!e.hasReceipt, receiptId: typeof e.receiptId === 'string' ? e.receiptId.slice(0, 64) : null,
      createdAt: str(e.createdAt, 40) || new Date().toISOString(), updatedAt: str(e.updatedAt, 40) || new Date().toISOString(), sample: !!e.sample,
    };
    if (typeof e.source === 'string') out.source = e.source.slice(0, 40);
    if (Array.isArray(e.items)) out.items = e.items.filter((x) => x && typeof x === 'object').slice(0, 200);
    if (typeof e.tripId === 'string') out.tripId = e.tripId.slice(0, 64);
    return out;
  }

  /** Merge a backup in. Existing entries with the same id are replaced. Returns counts, including rows that were rejected. */
  async function importJSON(data, opts) {
    opts = opts || {};
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'itemizer' || !Array.isArray(data.entries)) throw new Error('That file is not an Itemizer backup.');
    const schema = opts.schema || root.ItemizerSchema || null;
    if (opts.replace) await clearAll({ keepSettings: true });
    const entries = data.entries.map((e) => sanitizeEntry(e, schema)).filter(Boolean);
    const skipped = data.entries.length - entries.length;
    await putEntries(entries);
    let receipts = 0, badReceipts = 0;
    for (const r of data.receipts || []) {
      if (!r || typeof r.id !== 'string' || !r.dataURL) { badReceipts++; continue; }
      try { await putReceipt({ id: r.id.slice(0, 64), entryId: typeof r.entryId === 'string' ? r.entryId : null, type: /^image\//.test(r.type) ? r.type : 'image/jpeg', createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(), blob: await dataURLToBlob(r.dataURL) }); receipts++; } catch (e) { badReceipts++; }
    }
    for (const p of data.places || []) if (p && typeof p.id === 'string' && typeof p.name === 'string') await putPlace(p);
    for (const t of data.trips || []) if (t && typeof t.id === 'string' && typeof t.date === 'string' && ISO_DAY.test(t.date)) await putTrip(t);
    if (data.settings && typeof data.settings === 'object' && opts.settings !== false) {
      const cur = await getSettings();
      const incoming = sanitizeSettings(data.settings);
      const next = Object.assign({}, cur, incoming);
      next.learned = Object.assign({}, cur.learned, incoming.learned || {});
      next.paramOverrides = Object.assign({}, cur.paramOverrides, incoming.paramOverrides || {});
      await saveSettings(next);
    }
    return { entries: entries.length, skipped, receipts, badReceipts };
  }

  async function clearAll(opts) {
    opts = opts || {};
    const db = await openDB();
    if (!db) { const d = lsRead(); lsWrite(opts.keepSettings ? { settings: d.settings } : {}); return; }
    await tx(db, 'entries', 'readwrite', (os) => os.clear());
    await tx(db, 'receipts', 'readwrite', (os) => os.clear());
    await tx(db, 'places', 'readwrite', (os) => os.clear());
    await tx(db, 'trips', 'readwrite', (os) => os.clear());
    if (!opts.keepSettings) await tx(db, 'settings', 'readwrite', (os) => os.clear());
  }

  function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  /**
   * A free-text CSV cell (description, note, purpose): quoted as needed, and a leading formula trigger (=, +, @, tab, CR, or a
   * minus not followed by a number) is defused with a leading apostrophe, since statement text comes from third parties.
   */
  function csvText(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s)) s = "'" + s;
    return csvEscape(s);
  }
  /** CSV of entries with section/line names resolved. */
  function toCSV(entries, Schema) {
    const head = ['date', 'tax_year', 'section', 'line', 'amount', 'unit', 'description', 'note', 'has_receipt', 'receipt_attached', 'id'];
    const rows = [head.join(',')];
    const sorted = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const e of sorted) {
      const line = Schema.getLine(e.lineId);
      rows.push([e.date, e.taxYear || String(e.date).slice(0, 4), line ? line.sectionTitle : '', line ? line.label : e.lineId, Number(e.amount) || 0, line ? line.unit : ''].map(csvEscape)
        .concat([csvText(e.description), csvText(e.note)], [e.hasReceipt ? 'yes' : 'no', e.receiptId ? 'yes' : 'no', e.id].map(csvEscape)).join(','));
    }
    return rows.join('\r\n');
  }

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function storageInfo() {
    let estimate = null, persisted = null;
    try { if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
    try { await openDB(); } catch (e) { /* reported by the caller */ }
    return { mode, estimate, persisted, notice };
  }
  /** Ask the browser not to evict this origin's data. Call from a user gesture; resolves to the browser's answer or null. */
  async function requestPersistence() {
    try { if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* optional */ }
    return null;
  }

  root.ItemizerStore = { DEFAULT_SETTINGS, sanitizeSettings, sanitizeEntry, openDB, getEntries, putEntry, putEntries, deleteEntry, deleteEntries, putReceipt, getReceipt, deleteReceipt, getAllReceipts, getPlaces, putPlace, deletePlace, getTrips, putTrip, deleteTrip, getSettings, saveSettings, exportJSON, exportBackup, importJSON, clearAll, toCSV, csvEscape, csvText, dataURLToBlob, uid, storageInfo, requestPersistence, get mode() { return mode; }, get notice() { return notice; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
