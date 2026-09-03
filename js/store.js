/*
 * store.js — local-first persistence: one object store per kind of record.
 *
 * Everything stays on the device. Each kind of record has its own IndexedDB object store with a primary
 * key, and every change writes or deletes the one row it concerns. Nothing is kept as a document that has
 * to be rewritten whole; JSON is used only for the backup file.
 *
 *   store        key         row
 *   entries      id          { id, date, taxYear, lineId, amount, description, note, hasReceipt, receiptId, createdAt, updatedAt, sample, source?, items?, tripId?, fullAmount?, share? }
 *   receipts     id          { id, entryId, type, createdAt, blob }
 *   places       id          { id, name, category, address, lat, lon, note, sample, updatedAt }
 *   trips        id          { id, date, taxYear, fromId, toId, fromLabel, toLabel, purpose, miles, roundTrip, method, lineId, entryId, points, startedAt, endedAt, createdAt }
 *   settings     key         { key: 'main', value: { scalar configuration only, see DEFAULT_SETTINGS } }
 *   learned      key         { key, lineId, updatedAt }                       a payee key and the worksheet line it was filed on
 *   weights      keyword     { keyword, weight, updatedAt }                   a classifier keyword and its learned multiplier
 *   dismissals   id          { id, dismissedAt }                              an advisor recommendation the user dismissed
 *   layouts      signature   { signature, map, spendIsNegative, updatedAt }   a statement header and the column layout chosen for it
 *   snapshots    id          { id: 'taxYear:month', taxYear, month, takenOn, actual, expectedMore, projectedTotal, standardDeduction, itemize }
 *   overrides    id          { id: 'taxYear:path', taxYear, path, value, updatedAt }   one overridden tax parameter
 *
 * Records reference other records by id (lineId, entryId, receiptId, fromId, toId); display labels are looked up
 * from the schema or the referenced row when shown. The two labels a trip keeps (fromLabel, toLabel) are the
 * mileage log's own record of where it went, kept so the log survives a deleted place.
 *
 * Version 3 of the database split the settings document of versions 1 and 2, which carried six of these
 * collections inside one JSON value, into the six stores above; the upgrade does that in place and loses nothing.
 * Without IndexedDB the same layout is kept in localStorage, one key per store; without either (tests), in memory.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'itemizer';
  const DB_VERSION = 3;
  const LS_PREFIX = 'itemizer:store:'; // fallback: one key per store
  const LS_LEGACY_KEY = 'itemizer:fallback'; // the single document the fallback kept before version 3
  const SETTINGS_KEY = 'main';

  /** Every store, its primary key, and its indexes; the one table drives IndexedDB, the fallback, backups and clears. */
  const STORES = {
    entries: { key: 'id', indexes: { taxYear: 'taxYear', date: 'date' } },
    receipts: { key: 'id' },
    places: { key: 'id' },
    trips: { key: 'id', indexes: { date: 'date' } },
    settings: { key: 'key' },
    learned: { key: 'key' },
    weights: { key: 'keyword' },
    dismissals: { key: 'id' },
    layouts: { key: 'signature' },
    snapshots: { key: 'id', indexes: { taxYear: 'taxYear' } },
    overrides: { key: 'id', indexes: { taxYear: 'taxYear' } },
  };
  const STORE_NAMES = Object.keys(STORES);
  const DATA_STORES = ['entries', 'receipts', 'places', 'trips']; // the ledger itself
  const ROW_STORES = ['learned', 'weights', 'dismissals', 'layouts', 'snapshots', 'overrides']; // what the settings document used to carry
  const STAMPED = new Set(['learned', 'weights', 'layouts', 'overrides']); // rows that carry updatedAt

  /** The settings row: scalar configuration only. Collections have their own stores. */
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
    theme: 'system',
    state: '',
    county: '',
    disasterNumber: '',
    experimentSnapshots: true,
    experimentCorrections: true,
    experimentNudges: true,
  };
  const LEGACY_EXPERIMENT_FLAGS = { snapshots: 'experimentSnapshots', corrections: 'experimentCorrections', nudges: 'experimentNudges' };

  let dbPromise = null;
  let mode = 'idb'; // 'idb' | 'local' (localStorage, one key per store) | 'memory' (nothing survives the session)
  let notice = null; // a storage condition the UI should mention ("close other tabs")

  const nowISO = () => new Date().toISOString();
  const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH = /^\d{4}-\d{2}$/;
  const PARAM_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
  const yearOf = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null; };
  const finite = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const schemaOf = (opts) => (opts && opts.schema) || root.ItemizerSchema || null;

  /** Copy only known settings keys, coerced to the type of the default. Backups and stored records are untrusted input. */
  function sanitizeSettings(raw) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (!(k in raw)) continue;
      const def = DEFAULT_SETTINGS[k], v = raw[k];
      if (typeof def === 'boolean') out[k] = !!v;
      else if (typeof def === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
      else out[k] = v == null ? '' : String(v).slice(0, 200);
    }
    // the experiment switches used to be one nested object; a flat key wins when both are present
    if (raw.experiments && typeof raw.experiments === 'object') {
      for (const [old, flat] of Object.entries(LEGACY_EXPERIMENT_FLAGS)) if (!(flat in raw) && old in raw.experiments) out[flat] = raw.experiments[old] !== false;
    }
    if (!(out.taxYear >= 2000 && out.taxYear <= 2100)) out.taxYear = DEFAULT_SETTINGS.taxYear;
    if (!['single', 'mfj', 'mfs', 'hoh', 'qss'].includes(out.filingStatus)) out.filingStatus = 'single';
    if (!['system', 'light', 'dark'].includes(out.theme)) out.theme = 'system';
    return out;
  }

  /** A clean row for `store`, or null when the input cannot be trusted. `schema` (ItemizerSchema) validates line ids when given. */
  function sanitizeRow(store, r, schema) {
    if (!r || typeof r !== 'object') return null;
    switch (store) {
      case 'learned': {
        const key = str(r.key, 120).trim();
        if (!key || typeof r.lineId !== 'string' || !r.lineId || r.lineId.length > 40) return null;
        if (schema && schema.getLine && !schema.getLine(r.lineId)) return null;
        return { key, lineId: r.lineId, updatedAt: str(r.updatedAt, 40) || nowISO() };
      }
      case 'weights': {
        const keyword = str(r.keyword, 120).trim(), weight = finite(r.weight);
        if (!keyword || weight == null || weight <= 0 || weight > 10) return null;
        return { keyword, weight: Math.round(weight * 1000) / 1000, updatedAt: str(r.updatedAt, 40) || nowISO() };
      }
      case 'dismissals': {
        const id = str(r.id, 200).trim(), dismissedAt = str(r.dismissedAt, 10);
        if (!id || !ISO_DAY.test(dismissedAt)) return null;
        return { id, dismissedAt };
      }
      case 'layouts': {
        const signature = str(r.signature, 400).trim();
        if (!signature || !r.map || typeof r.map !== 'object') return null;
        const map = {};
        for (const c of ['date', 'description', 'amount', 'debit', 'credit', 'type', 'memo']) { const n = Number(r.map[c]); map[c] = Number.isInteger(n) && n >= -1 && n < 200 ? n : -1; }
        map.headerRow = r.map.headerRow !== false;
        const hi = Number(r.map.headerIndex); map.headerIndex = Number.isInteger(hi) && hi >= 0 && hi < 50 ? hi : 0;
        map.dayFirst = !!r.map.dayFirst;
        const out = { signature, map, updatedAt: str(r.updatedAt, 40) || nowISO() };
        if (typeof r.spendIsNegative === 'boolean') out.spendIsNegative = r.spendIsNegative;
        return out;
      }
      case 'snapshots': {
        const taxYear = yearOf(r.taxYear), month = str(r.month, 7);
        const nums = ['actual', 'expectedMore', 'projectedTotal', 'standardDeduction'].map((k) => finite(r[k]));
        if (taxYear == null || !MONTH.test(month) || nums.some((n) => n == null)) return null;
        const [actual, expectedMore, projectedTotal, standardDeduction] = nums.map((n) => Math.round(n * 100) / 100);
        return { id: `${taxYear}:${month}`, taxYear, month, takenOn: ISO_DAY.test(str(r.takenOn, 10)) ? str(r.takenOn, 10) : `${month}-01`, actual, expectedMore, projectedTotal, standardDeduction, itemize: !!r.itemize };
      }
      case 'overrides': {
        const taxYear = yearOf(r.taxYear), path = str(r.path, 80), value = finite(r.value);
        if (taxYear == null || !PARAM_PATH.test(path) || value == null) return null;
        return { id: `${taxYear}:${path}`, taxYear, path, value, updatedAt: str(r.updatedAt, 40) || nowISO() };
      }
      case 'places': return r && typeof r.id === 'string' && r.id && typeof r.name === 'string' ? r : null;
      case 'trips': return r && typeof r.id === 'string' && r.id && typeof r.date === 'string' && ISO_DAY.test(r.date) ? r : null;
      case 'settings': return r && typeof r.key === 'string' ? { key: r.key, value: sanitizeSettings(r.value) } : null;
      default: return r && r[STORES[store].key] != null ? r : null;
    }
  }

  // ---- overrides: the tax engine reads them nested by year, the store keeps one row per parameter ----
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = value;
    return obj;
  }
  /** { mileage: { medical: 0.5 } } for one year → [{ taxYear, path: 'mileage.medical', value: 0.5 }] */
  function flattenOverrides(taxYear, nested, prefix, out) {
    out = out || [];
    if (!nested || typeof nested !== 'object') return out;
    for (const [k, v] of Object.entries(nested)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flattenOverrides(taxYear, v, path, out);
      else out.push({ taxYear: Number(taxYear), path, value: v });
    }
    return out;
  }
  /** rows → { [taxYear]: nested } as rules.getParams expects */
  function nestOverrides(rows) {
    const out = {};
    for (const r of rows || []) { if (!out[r.taxYear]) out[r.taxYear] = {}; setPath(out[r.taxYear], r.path, r.value); }
    return out;
  }

  /**
   * Split a settings document from before version 3 (or a version-2 backup) into the scalar row and the rows of the
   * six stores it used to carry. Pure; bad rows are dropped, nothing else is changed.
   */
  function splitLegacySettings(raw, schema) {
    const out = { settings: sanitizeSettings(raw), learned: [], weights: [], dismissals: [], layouts: [], snapshots: [], overrides: [] };
    if (!raw || typeof raw !== 'object') return out;
    const push = (store, row) => { const clean = sanitizeRow(store, row, schema); if (clean) out[store].push(clean); };
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    for (const [key, lineId] of Object.entries(obj(raw.learned))) push('learned', { key, lineId });
    for (const [keyword, weight] of Object.entries(obj(raw.keywordWeights))) push('weights', { keyword, weight });
    for (const [id, dismissedAt] of Object.entries(obj(raw.advisorDismissed))) push('dismissals', { id, dismissedAt: str(dismissedAt, 10) });
    for (const [signature, v] of Object.entries(obj(raw.importMappings))) push('layouts', { signature, map: v && v.map, spendIsNegative: v ? v.spendIsNegative : undefined, updatedAt: v && v.savedAt });
    for (const s of Array.isArray(raw.forecastSnapshots) ? raw.forecastSnapshots : []) push('snapshots', s);
    for (const [year, nested] of Object.entries(obj(raw.paramOverrides))) for (const r of flattenOverrides(year, nested)) push('overrides', r);
    return out;
  }
  /** True when a settings document still carries the collections of versions 1 and 2. */
  const isLegacySettings = (s) => !!s && typeof s === 'object' && ['learned', 'keywordWeights', 'advisorDismissed', 'importMappings', 'forecastSnapshots', 'paramOverrides'].some((k) => k in s);

  // ---- IndexedDB ------------------------------------------------------------

  /** v1/v2 → v3: the settings document is split into rows inside the upgrade transaction, so no data is ever in two places. */
  function migrateSettingsDocument(t) {
    const req = t.objectStore('settings').get(SETTINGS_KEY);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec || !rec.value || !isLegacySettings(rec.value)) return;
      const split = splitLegacySettings(rec.value, root.ItemizerSchema || null);
      t.objectStore('settings').put({ key: SETTINGS_KEY, value: split.settings });
      for (const store of ROW_STORES) for (const row of split[store]) t.objectStore(store).put(row);
    };
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      // localStorage is only for browsers with no IndexedDB at all; a blocked or failing open must not fork the data
      if (typeof indexedDB === 'undefined') { mode = storageArea() === memoryArea ? 'memory' : 'local'; migrateLegacyLocal(); resolve(null); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { mode = storageArea() === memoryArea ? 'memory' : 'local'; migrateLegacyLocal(); resolve(null); return; }
      req.onupgradeneeded = (ev) => {
        const db = req.result, t = req.transaction;
        for (const [name, def] of Object.entries(STORES)) {
          const os = db.objectStoreNames.contains(name) ? t.objectStore(name) : db.createObjectStore(name, { keyPath: def.key });
          for (const [idx, path] of Object.entries(def.indexes || {})) if (!os.indexNames.contains(idx)) os.createIndex(idx, path);
        }
        if (ev.oldVersion > 0 && ev.oldVersion < 3) migrateSettingsDocument(t);
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

  // ---- fallback: the same stores as keys in localStorage, or in memory when there is no localStorage either ----
  const memoryArea = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; })();
  function storageArea() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) { /* access denied: memory */ }
    return memoryArea;
  }
  const LS = {
    read(store) { try { const o = JSON.parse(storageArea().getItem(LS_PREFIX + store) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } },
    write(store, obj) { try { storageArea().setItem(LS_PREFIX + store, JSON.stringify(obj)); } catch (e) { throw new Error('Storage is full or unavailable; nothing was saved. Download a backup and free some space.'); } },
    all(store) { return Object.values(this.read(store)); },
    get(store, key) { const o = this.read(store); return o[key] === undefined ? null : o[key]; },
    put(store, row) { const o = this.read(store); o[row[STORES[store].key]] = row; this.write(store, o); },
    putMany(store, rows) { const o = this.read(store); for (const r of rows) o[r[STORES[store].key]] = r; this.write(store, o); },
    del(store, key) { const o = this.read(store); if (key in o) { delete o[key]; this.write(store, o); } },
    delMany(store, keys) { const o = this.read(store); let hit = false; for (const k of keys) if (k in o) { delete o[k]; hit = true; } if (hit) this.write(store, o); },
    clear(store) { try { storageArea().removeItem(LS_PREFIX + store); } catch (e) { /* nothing to clear */ } },
    count(store) { return Object.keys(this.read(store)).length; },
  };
  /** The fallback's pre-v3 single document becomes one key per store. */
  function migrateLegacyLocal() {
    const area = storageArea();
    let legacy = null;
    try { legacy = JSON.parse(area.getItem(LS_LEGACY_KEY) || 'null'); } catch (e) { legacy = null; }
    if (!legacy || typeof legacy !== 'object') return;
    try {
      for (const s of ['entries', 'places', 'trips']) LS.putMany(s, (Array.isArray(legacy[s]) ? legacy[s] : []).filter((r) => r && typeof r.id === 'string' && LS.get(s, r.id) == null));
      if (legacy.settings) {
        const split = splitLegacySettings(legacy.settings, root.ItemizerSchema || null);
        if (!LS.get('settings', SETTINGS_KEY)) LS.put('settings', { key: SETTINGS_KEY, value: split.settings });
        for (const s of ROW_STORES) LS.putMany(s, split[s].filter((r) => LS.get(s, r[STORES[s].key]) == null));
      }
      area.removeItem(LS_LEGACY_KEY);
    } catch (e) { /* leave the document in place for the next start */ }
  }
  /** Once IndexedDB is back, anything a localStorage-only session saved (either fallback layout) is folded in so no data is orphaned. */
  async function migrateFallback(db) {
    const area = storageArea();
    if (area === memoryArea) return;
    const pending = {};
    const add = (s, rows) => { if (rows && rows.length) pending[s] = (pending[s] || []).concat(rows); };
    let legacy = null;
    try { legacy = JSON.parse(area.getItem(LS_LEGACY_KEY) || 'null'); } catch (e) { legacy = null; }
    if (legacy && typeof legacy === 'object') {
      for (const s of ['entries', 'places', 'trips']) add(s, (Array.isArray(legacy[s]) ? legacy[s] : []).filter((r) => r && typeof r.id === 'string'));
      if (legacy.settings) { const split = splitLegacySettings(legacy.settings, root.ItemizerSchema || null); add('settings', [{ key: SETTINGS_KEY, value: split.settings }]); for (const s of ROW_STORES) add(s, split[s]); }
    }
    for (const s of STORE_NAMES) add(s, LS.all(s));
    if (!Object.keys(pending).length) return;
    try {
      for (const [s, rows] of Object.entries(pending)) {
        const keyName = STORES[s].key;
        const have = new Set((await tx(db, s, 'readonly', (os) => os.getAllKeys())) || []);
        const fresh = rows.filter((r) => r && r[keyName] != null && !have.has(r[keyName]));
        if (fresh.length) await tx(db, s, 'readwrite', (os) => { fresh.forEach((r) => os.put(r)); });
      }
      area.removeItem(LS_LEGACY_KEY);
      for (const s of STORE_NAMES) area.removeItem(LS_PREFIX + s);
    } catch (e) { /* leave the fallback data in place for the next start */ }
  }

  // ---- the row layer: every store, one interface ----------------------------------

  async function allRows(store) {
    const db = await openDB();
    if (!db) return LS.all(store);
    return (await tx(db, store, 'readonly', (os) => os.getAll())) || [];
  }
  async function getRow(store, key) {
    const db = await openDB();
    if (!db) return LS.get(store, key);
    return (await tx(db, store, 'readonly', (os) => os.get(key))) || null;
  }
  async function putRow(store, row) {
    const db = await openDB();
    if (!db) { LS.put(store, row); return row; }
    await tx(db, store, 'readwrite', (os) => os.put(row));
    return row;
  }
  async function putRows(store, rows) {
    if (!rows.length) return rows;
    const db = await openDB();
    if (!db) { LS.putMany(store, rows); return rows; }
    await tx(db, store, 'readwrite', (os) => { rows.forEach((r) => os.put(r)); });
    return rows;
  }
  async function deleteRow(store, key) {
    const db = await openDB();
    if (!db) { LS.del(store, key); return; }
    await tx(db, store, 'readwrite', (os) => os.delete(key));
  }
  async function clearStore(store) {
    const db = await openDB();
    if (!db) { LS.clear(store); return; }
    await tx(db, store, 'readwrite', (os) => os.clear());
  }
  async function countRows(store) {
    const db = await openDB();
    if (!db) return LS.count(store);
    return (await tx(db, store, 'readonly', (os) => os.count())) || 0;
  }
  const withoutStamp = (r) => { const c = Object.assign({}, r); delete c.updatedAt; return JSON.stringify(c, Object.keys(c).sort()); };
  /**
   * Make the store hold exactly `rows` (within `scope`, when given: only existing rows that match it may be deleted).
   * Unchanged rows are left alone; new and changed rows are written and stamped; rows no longer wanted are deleted.
   * Returns { put, deleted }.
   */
  async function syncRows(store, rows, scope) {
    const keyName = STORES[store].key;
    const existing = (await allRows(store)).filter(scope || (() => true));
    const have = new Map(existing.map((r) => [r[keyName], r]));
    const want = new Map(rows.map((r) => [r[keyName], r]));
    const deleted = existing.filter((r) => !want.has(r[keyName])).map((r) => r[keyName]);
    const stamp = STAMPED.has(store) ? nowISO() : null;
    const put = rows.filter((r) => { const cur = have.get(r[keyName]); return !cur || withoutStamp(cur) !== withoutStamp(r); }).map((r) => (stamp ? Object.assign({}, r, { updatedAt: stamp }) : r));
    if (!deleted.length && !put.length) return { put: 0, deleted: 0 };
    const db = await openDB();
    if (!db) { LS.delMany(store, deleted); LS.putMany(store, put); return { put: put.length, deleted: deleted.length }; }
    await tx(db, store, 'readwrite', (os) => { deleted.forEach((k) => os.delete(k)); put.forEach((r) => os.put(r)); });
    return { put: put.length, deleted: deleted.length };
  }

  // ---- the ledger ---------------------------------------------------------------

  const getEntries = () => allRows('entries');
  const putEntry = (entry) => putRow('entries', entry);
  const putEntries = (entries) => putRows('entries', entries);
  async function deleteEntry(id) {
    const entry = await getRow('entries', id);
    await deleteRow('entries', id);
    if (entry && entry.receiptId) await deleteReceipt(entry.receiptId);
  }
  async function deleteEntries(ids) { for (const id of ids) await deleteEntry(id); }

  async function putReceipt(receipt) {
    const db = await openDB();
    if (!db) throw new Error('Receipt photos need IndexedDB, which this browser does not provide.');
    await tx(db, 'receipts', 'readwrite', (os) => os.put(receipt));
    return receipt;
  }
  async function getReceipt(id) { if (!id) return null; const db = await openDB(); if (!db) return null; return (await tx(db, 'receipts', 'readonly', (os) => os.get(id))) || null; }
  async function deleteReceipt(id) { if (!id) return; const db = await openDB(); if (!db) return; await tx(db, 'receipts', 'readwrite', (os) => os.delete(id)); }
  async function getAllReceipts() { const db = await openDB(); if (!db) return []; return (await tx(db, 'receipts', 'readonly', (os) => os.getAll())) || []; }

  const getPlaces = () => allRows('places');
  const putPlace = (place) => putRow('places', place);
  const deletePlace = (id) => deleteRow('places', id);
  const getTrips = () => allRows('trips');
  const putTrip = (trip) => putRow('trips', trip);
  const deleteTrip = (id) => deleteRow('trips', id);

  // ---- settings: one row of scalars ----------------------------------------------

  async function getSettings() {
    const rec = await getRow('settings', SETTINGS_KEY);
    return sanitizeSettings(rec ? rec.value : null);
  }
  async function saveSettings(settings) {
    const value = sanitizeSettings(settings);
    await putRow('settings', { key: SETTINGS_KEY, value });
    return value;
  }

  // ---- the six stores the app reads as maps and lists ----------------------------------

  const mapOf = (rows, k, v) => { const o = {}; for (const r of rows) o[r[k]] = v ? r[v] : r; return o; };

  /** { payeeKey: lineId } */
  const getLearned = async () => mapOf(await allRows('learned'), 'key', 'lineId');
  const putLearned = (key, lineId) => putRow('learned', { key, lineId, updatedAt: nowISO() });
  const deleteLearned = (key) => deleteRow('learned', key);
  const clearLearned = () => clearStore('learned');

  /** { keyword: weight } */
  const getWeights = async () => mapOf(await allRows('weights'), 'keyword', 'weight');
  const syncWeights = (map) => syncRows('weights', Object.entries(map || {}).map(([keyword, weight]) => sanitizeRow('weights', { keyword, weight })).filter(Boolean));
  const clearWeights = () => clearStore('weights');

  /** { recommendationId: 'YYYY-MM-DD' } */
  const getDismissals = async () => mapOf(await allRows('dismissals'), 'id', 'dismissedAt');
  const putDismissal = (id, dismissedAt) => putRow('dismissals', { id, dismissedAt });
  const clearDismissals = () => clearStore('dismissals');

  /** { signature: { map, spendIsNegative, updatedAt } } */
  const getLayouts = async () => mapOf(await allRows('layouts'), 'signature');
  const putLayout = async (layout) => { const row = sanitizeRow('layouts', Object.assign({}, layout, { updatedAt: nowISO() })); if (!row) throw new Error('Not a statement layout.'); return putRow('layouts', row); };
  const clearLayouts = () => clearStore('layouts');

  /** snapshots, oldest month first */
  const getSnapshots = async () => (await allRows('snapshots')).sort((a, b) => a.month.localeCompare(b.month) || a.taxYear - b.taxYear);
  const syncSnapshots = (list) => syncRows('snapshots', (list || []).map((s) => sanitizeRow('snapshots', s)).filter(Boolean));
  const clearSnapshots = () => clearStore('snapshots');

  /** { taxYear: nested overrides } as rules.getParams reads them */
  const getOverrides = async () => nestOverrides(await allRows('overrides'));
  /** Make one year's overrides exactly `nested` (an empty object removes them all); other years are untouched. */
  const syncOverrides = (taxYear, nested) => syncRows('overrides', flattenOverrides(taxYear, nested).map((r) => sanitizeRow('overrides', r)).filter(Boolean), (r) => Number(r.taxYear) === Number(taxYear));
  const clearOverrides = () => clearStore('overrides');

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

  /** The backup without receipts: the settings row, then every other store as an array of rows. Receipts are appended by exportBackup. */
  async function exportJSON(opts) {
    opts = opts || {};
    const [settings, learned, weights, dismissals, layouts, snapshots, overrides, entries, places, trips] = await Promise.all([getSettings(), ...ROW_STORES.map(allRows), getEntries(), getPlaces(), getTrips()]);
    const out = { app: 'itemizer', version: 3, exportedAt: nowISO(), settings, learned, weights, dismissals, layouts, snapshots, overrides, entries, places, trips, receipts: [] };
    if (opts.includeReceipts !== false) {
      for (const r of await getAllReceipts()) {
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

  /** An entry from a backup, or null when it cannot be trusted. `schema` (ItemizerSchema) validates the line id when given. */
  function sanitizeEntry(e, schema) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.lineId !== 'string' || typeof e.date !== 'string' || !ISO_DAY.test(e.date)) return null;
    if (schema && schema.getLine && !schema.getLine(e.lineId)) return null;
    const amount = Number(e.amount);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const out = {
      id: e.id.slice(0, 64), date: e.date, taxYear: Number(e.taxYear) || Number(e.date.slice(0, 4)), lineId: e.lineId, amount: Math.round(amount * 100) / 100,
      description: str(e.description, 300), note: str(e.note, 4000), hasReceipt: !!e.hasReceipt, receiptId: typeof e.receiptId === 'string' ? e.receiptId.slice(0, 64) : null,
      createdAt: str(e.createdAt, 40) || nowISO(), updatedAt: str(e.updatedAt, 40) || nowISO(), sample: !!e.sample,
    };
    if (typeof e.source === 'string') out.source = e.source.slice(0, 40);
    if (Array.isArray(e.items)) out.items = e.items.filter((x) => x && typeof x === 'object').slice(0, 200);
    if (typeof e.tripId === 'string') out.tripId = e.tripId.slice(0, 64);
    if (e.fullAmount != null && Number.isFinite(Number(e.fullAmount))) out.fullAmount = Number(e.fullAmount);
    if (e.share != null && Number.isFinite(Number(e.share))) out.share = Number(e.share);
    return out;
  }

  /**
   * Merge a backup in. Existing rows with the same key are replaced; version-2 backups (collections inside `settings`)
   * are split into rows on the way in. Returns counts, including rows that were rejected.
   */
  async function importJSON(data, opts) {
    opts = opts || {};
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'itemizer' || !Array.isArray(data.entries)) throw new Error('That file is not an Itemizer backup.');
    const schema = schemaOf(opts);
    if (opts.replace) await clearAll({ keepSettings: true });
    const entries = data.entries.map((e) => sanitizeEntry(e, schema)).filter(Boolean);
    const skipped = data.entries.length - entries.length;
    await putEntries(entries);
    let receipts = 0, badReceipts = 0;
    for (const r of data.receipts || []) {
      if (!r || typeof r.id !== 'string' || !r.dataURL) { badReceipts++; continue; }
      try { await putReceipt({ id: r.id.slice(0, 64), entryId: typeof r.entryId === 'string' ? r.entryId : null, type: /^image\//.test(r.type) ? r.type : 'image/jpeg', createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowISO(), blob: await dataURLToBlob(r.dataURL) }); receipts++; } catch (e) { badReceipts++; }
    }
    await putRows('places', (Array.isArray(data.places) ? data.places : []).map((p) => sanitizeRow('places', p)).filter(Boolean));
    await putRows('trips', (Array.isArray(data.trips) ? data.trips : []).map((t) => sanitizeRow('trips', t)).filter(Boolean));
    // the six memory stores: rows in a version-3 file, or split out of the settings document of an older one
    const rows = {};
    const legacy = isLegacySettings(data.settings) ? splitLegacySettings(data.settings, schema) : null;
    for (const store of ROW_STORES) {
      const incoming = Array.isArray(data[store]) ? data[store].map((r) => sanitizeRow(store, r, schema)).filter(Boolean) : [];
      rows[store] = legacy ? legacy[store].concat(incoming) : incoming;
      await putRows(store, rows[store]);
    }
    if (data.settings && typeof data.settings === 'object' && opts.settings !== false) {
      const cur = await getSettings();
      await saveSettings(Object.assign({}, cur, sanitizeSettings(data.settings)));
    }
    const counts = {}; for (const store of ROW_STORES) counts[store] = rows[store].length;
    return { entries: entries.length, skipped, receipts, badReceipts, rows: counts };
  }

  /** Remove everything; with keepSettings, only the ledger (entries, receipts, places, trips) goes and what the app has learned stays. */
  async function clearAll(opts) {
    opts = opts || {};
    for (const store of opts.keepSettings ? DATA_STORES : STORE_NAMES) await clearStore(store);
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

  /** How many rows each store holds. */
  async function counts() {
    const out = {};
    for (const store of STORE_NAMES) { try { out[store] = await countRows(store); } catch (e) { out[store] = null; } }
    return out;
  }
  async function storageInfo() {
    let estimate = null, persisted = null;
    try { if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
    try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (e) { /* ignore */ }
    let rows = null;
    try { await openDB(); rows = await counts(); } catch (e) { /* reported by the caller */ }
    return { mode, estimate, persisted, notice, version: DB_VERSION, stores: STORE_NAMES.slice(), counts: rows };
  }
  /** Ask the browser not to evict this origin's data. Call from a user gesture; resolves to the browser's answer or null. */
  async function requestPersistence() {
    try { if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* optional */ }
    return null;
  }

  root.ItemizerStore = {
    DB_VERSION, STORES, STORE_NAMES, DATA_STORES, ROW_STORES, DEFAULT_SETTINGS,
    sanitizeSettings, sanitizeRow, sanitizeEntry, splitLegacySettings, isLegacySettings, flattenOverrides, nestOverrides,
    openDB, allRows, getRow, putRow, putRows, deleteRow, clearStore, syncRows, countRows, counts,
    getEntries, putEntry, putEntries, deleteEntry, deleteEntries, putReceipt, getReceipt, deleteReceipt, getAllReceipts,
    getPlaces, putPlace, deletePlace, getTrips, putTrip, deleteTrip, getSettings, saveSettings,
    getLearned, putLearned, deleteLearned, clearLearned, getWeights, syncWeights, clearWeights, getDismissals, putDismissal, clearDismissals,
    getLayouts, putLayout, clearLayouts, getSnapshots, syncSnapshots, clearSnapshots, getOverrides, syncOverrides, clearOverrides,
    exportJSON, exportBackup, importJSON, clearAll, toCSV, csvEscape, csvText, dataURLToBlob, uid, storageInfo, requestPersistence,
    get mode() { return mode; }, get notice() { return notice; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
