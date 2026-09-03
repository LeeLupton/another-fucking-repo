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
    filingStatus: 'single',
    agi: '',
    age65: false,
    blind: false,
    spouseAge65: false,
    spouseBlind: false,
    gamblingWinnings: '',
    casualtyFederalDisaster: false,
    paramOverrides: {},
    learned: {},
    theme: 'system',
    onboarded: false,
    advisorDismissed: {},
    state: '',
    county: '',
    disasterNumber: '',
    importMappings: {},
  };

  let dbPromise = null;
  let mode = 'idb';

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { mode = 'local'; resolve(null); };
      req.onblocked = () => { mode = 'local'; resolve(null); };
    });
    return dbPromise;
  }

  function tx(db, store, modeName, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, modeName);
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
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); return true; } catch (e) { return false; }
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
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved || {});
    merged.paramOverrides = Object.assign({}, merged.paramOverrides || {});
    merged.learned = Object.assign({}, merged.learned || {});
    return merged;
  }
  async function saveSettings(settings) {
    const db = await openDB();
    const value = Object.assign({}, settings);
    if (!db) { const d = lsRead(); d.settings = value; lsWrite(d); return value; }
    await tx(db, 'settings', 'readwrite', (os) => os.put({ key: SETTINGS_KEY, value }));
    return value;
  }

  // ---- backup / restore -------------------------------------------------------

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  }
  async function dataURLToBlob(dataURL) {
    const res = await fetch(dataURL);
    return res.blob();
  }

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

  /** Merge a backup in. Existing entries with the same id are replaced. Returns counts. */
  async function importJSON(data, opts) {
    opts = opts || {};
    if (!data || data.app !== 'itemizer' || !Array.isArray(data.entries)) throw new Error('That file is not an Itemizer backup.');
    if (opts.replace) await clearAll({ keepSettings: true });
    const entries = data.entries.filter((e) => e && e.id && e.lineId && e.date);
    await putEntries(entries);
    let receipts = 0;
    for (const r of data.receipts || []) {
      if (!r.id || !r.dataURL) continue;
      try { await putReceipt({ id: r.id, entryId: r.entryId, type: r.type || 'image/jpeg', createdAt: r.createdAt || new Date().toISOString(), blob: await dataURLToBlob(r.dataURL) }); receipts++; } catch (e) { /* skip */ }
    }
    for (const p of data.places || []) if (p && p.id && p.name) await putPlace(p);
    for (const t of data.trips || []) if (t && t.id && t.date) await putTrip(t);
    if (data.settings && opts.settings !== false) {
      const cur = await getSettings();
      const next = Object.assign({}, cur, data.settings);
      next.learned = Object.assign({}, cur.learned, data.settings.learned || {});
      next.paramOverrides = Object.assign({}, cur.paramOverrides, data.settings.paramOverrides || {});
      await saveSettings(next);
    }
    return { entries: entries.length, receipts };
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
  /** CSV of entries with section/line names resolved. */
  function toCSV(entries, Schema) {
    const head = ['date', 'tax_year', 'section', 'line', 'amount', 'unit', 'description', 'note', 'has_receipt', 'receipt_attached', 'id'];
    const rows = [head.join(',')];
    const sorted = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const e of sorted) {
      const line = Schema.getLine(e.lineId);
      rows.push([e.date, e.taxYear || String(e.date).slice(0, 4), line ? line.sectionTitle : '', line ? line.label : e.lineId, e.amount, line ? line.unit : '', e.description, e.note, e.hasReceipt ? 'yes' : 'no', e.receiptId ? 'yes' : 'no', e.id].map(csvEscape).join(','));
    }
    return rows.join('\r\n');
  }

  function uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function storageInfo() {
    let estimate = null;
    try { if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    await openDB();
    return { mode, estimate };
  }

  root.ItemizerStore = { DEFAULT_SETTINGS, openDB, getEntries, putEntry, putEntries, deleteEntry, deleteEntries, putReceipt, getReceipt, deleteReceipt, getAllReceipts, getPlaces, putPlace, deletePlace, getTrips, putTrip, deleteTrip, getSettings, saveSettings, exportJSON, importJSON, clearAll, toCSV, uid, storageInfo, get mode() { return mode; } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
