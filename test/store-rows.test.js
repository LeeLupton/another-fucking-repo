// The storage layer as a database: one keyed store per kind of record, row-level writes, and a lossless split of the
// old settings document. Under node there is neither IndexedDB nor localStorage, so the store runs in memory with the
// same row layer the browser uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
require('../js/store.js');
const Schema = require('../js/schema.js');
const DB = globalThis.ItemizerStore;
const STORE = require.resolve('../js/store.js');
const SCHEMA = require.resolve('../js/schema.js');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * A few paths (a blocked IndexedDB open, an aborted transaction, the localStorage fallback) need their own browser
 * globals and their own copy of the module, which this process cannot have twice: run them in a child node process,
 * where `setup` installs the globals, `body` is an async function body, and what it returns comes back as JSON.
 */
function inChild(setup, body) {
  const src = `${setup}\nrequire(${JSON.stringify(STORE)});\nconst DB = globalThis.ItemizerStore;\n(async () => { const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out)); })().catch((e) => { console.error(e); process.exit(1); });`;
  return JSON.parse(execFileSync(process.execPath, ['-e', src], { encoding: 'utf8' }));
}

const legacyDoc = {
  taxYear: 2026, filingStatus: 'mfj', agi: '95000', theme: 'dark', experiments: { snapshots: true, corrections: false, nudges: true },
  learned: { cvs: 'med.prescriptions', 'joes auto': 'se.car', 'bad line': 'nope.nothing', '': 'med.doctor' },
  keywordWeights: { pharmacy: 1.25, gas: 0.7, junk: 'x', zero: 0 },
  advisorDismissed: { 'plan:stop:2026': '2026-09-18', 'miles:abc': 'not a date' },
  importMappings: { 'date|description|amount': { map: { date: 0, description: 1, amount: 2, debit: -1, credit: -1, type: -1, memo: -1, headerRow: true, headerIndex: 0, dayFirst: false }, spendIsNegative: true, savedAt: '2026-03-01T00:00:00.000Z' }, '': { map: {} } },
  forecastSnapshots: [{ month: '2026-03', taxYear: 2026, takenOn: '2026-03-15', actual: 5000, expectedMore: 3000, projectedTotal: 8000, standardDeduction: 16100, itemize: false }, { month: 'bad', taxYear: 2026 }],
  paramOverrides: { 2026: { mileage: { medical: 0.5 }, standardDeduction: { mfs: 0 } }, 1999: { mileage: { medical: 1 } } },
};

test('every store has a primary key, and the ledger, the settings row and the six memory stores are all accounted for', () => {
  assert.equal(DB.DB_VERSION, 3);
  assert.deepEqual(DB.STORE_NAMES, ['entries', 'receipts', 'places', 'trips', 'settings', 'learned', 'weights', 'dismissals', 'layouts', 'snapshots', 'overrides']);
  for (const name of DB.STORE_NAMES) assert.equal(typeof DB.STORES[name].key, 'string', name);
  assert.deepEqual(DB.DATA_STORES, ['entries', 'receipts', 'places', 'trips']);
  assert.deepEqual(DB.ROW_STORES, ['learned', 'weights', 'dismissals', 'layouts', 'snapshots', 'overrides']);
});

test('the old settings document splits into a scalar row and clean rows for six stores; bad rows are dropped', () => {
  const split = DB.splitLegacySettings(legacyDoc, Schema);
  assert.equal(split.settings.filingStatus, 'mfj'); assert.equal(split.settings.experimentCorrections, false); assert.equal(split.settings.learned, undefined);
  assert.deepEqual(split.learned.map((r) => [r.key, r.lineId]), [['cvs', 'med.prescriptions'], ['joes auto', 'se.car']], 'an unknown line and an empty key are dropped');
  assert.ok(split.learned.every((r) => typeof r.updatedAt === 'string'));
  assert.deepEqual(split.weights.map((r) => [r.keyword, r.weight]), [['pharmacy', 1.25], ['gas', 0.7]], 'weights must be finite and positive');
  assert.deepEqual(split.dismissals, [{ id: 'plan:stop:2026', dismissedAt: '2026-09-18' }], 'a dismissal needs a real date');
  assert.equal(split.layouts.length, 1); assert.equal(split.layouts[0].signature, 'date|description|amount'); assert.equal(split.layouts[0].spendIsNegative, true); assert.equal(split.layouts[0].map.amount, 2); assert.equal(split.layouts[0].updatedAt, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(split.snapshots.map((r) => r.id), ['2026:2026-03']);
  assert.deepEqual(split.overrides.map((r) => [r.id, r.value]), [['2026:mileage.medical', 0.5], ['2026:standardDeduction.mfs', 0]], 'an impossible year is dropped');
  assert.equal(DB.isLegacySettings(legacyDoc), true);
  assert.equal(DB.isLegacySettings(split.settings), false);
  assert.deepEqual(DB.splitLegacySettings(null).learned, []);
});

test('overrides go from one row per parameter to the nested shape the tax engine reads, and back', () => {
  const rows = DB.flattenOverrides(2026, { mileage: { medical: 0.5, business: 0.7 }, saltCap: { default: 12000 } });
  assert.deepEqual(rows, [{ taxYear: 2026, path: 'mileage.medical', value: 0.5 }, { taxYear: 2026, path: 'mileage.business', value: 0.7 }, { taxYear: 2026, path: 'saltCap.default', value: 12000 }]);
  const nested = DB.nestOverrides(rows.map((r) => DB.sanitizeRow('overrides', r)).concat([DB.sanitizeRow('overrides', { taxYear: 2025, path: 'receiptThreshold', value: 50 })]));
  assert.deepEqual(nested, { 2026: { mileage: { medical: 0.5, business: 0.7 }, saltCap: { default: 12000 } }, 2025: { receiptThreshold: 50 } });
  assert.equal(DB.sanitizeRow('overrides', { taxYear: 2026, path: '__proto__.x', value: 1 }), null, 'paths are plain identifiers');
  assert.equal(DB.sanitizeRow('overrides', { taxYear: 2026, path: 'mileage.medical', value: 'abc' }), null);
});

test('rows are written, replaced, deleted and counted one at a time, and synced without touching unchanged rows', async () => {
  await DB.clearAll();
  assert.equal(DB.mode, 'memory');
  await DB.putLearned('cvs', 'med.prescriptions');
  await DB.putLearned('joes auto', 'se.car');
  await DB.putLearned('cvs', 'med.supplies');
  assert.deepEqual(await DB.getLearned(), { cvs: 'med.supplies', 'joes auto': 'se.car' });
  assert.equal(await DB.countRows('learned'), 2);
  await DB.deleteLearned('cvs');
  assert.deepEqual(await DB.getLearned(), { 'joes auto': 'se.car' });
  let r = await DB.syncWeights({ pharmacy: 1.25, gas: 0.7 });
  assert.deepEqual(r, { put: 2, deleted: 0 });
  r = await DB.syncWeights({ pharmacy: 1.25, gas: 0.7 });
  assert.deepEqual(r, { put: 0, deleted: 0 }, 'nothing changed, nothing written');
  r = await DB.syncWeights({ pharmacy: 1.3 });
  assert.deepEqual(r, { put: 1, deleted: 1 });
  assert.deepEqual(await DB.getWeights(), { pharmacy: 1.3 });
  await DB.putDismissal('plan:stop:2026', '2026-09-18');
  assert.deepEqual(await DB.getDismissals(), { 'plan:stop:2026': '2026-09-18' });
  await DB.clearDismissals();
  assert.deepEqual(await DB.getDismissals(), {});
  await DB.putLayout({ signature: 'date|payee|amount', map: { date: 0, description: 1, amount: 2 }, spendIsNegative: false });
  const layouts = await DB.getLayouts();
  assert.equal(layouts['date|payee|amount'].map.amount, 2); assert.equal(layouts['date|payee|amount'].map.debit, -1); assert.equal(layouts['date|payee|amount'].spendIsNegative, false);
  await assert.rejects(() => DB.putLayout({ signature: '', map: {} }), /Not a statement layout/);
  const snap = (month, actual) => ({ month, taxYear: 2026, takenOn: `${month}-15`, actual, expectedMore: 100, projectedTotal: actual + 100, standardDeduction: 16100, itemize: false });
  await DB.syncSnapshots([snap('2026-03', 5000), snap('2026-04', 6000)]);
  assert.deepEqual((await DB.getSnapshots()).map((s) => s.id), ['2026:2026-03', '2026:2026-04']);
  r = await DB.syncSnapshots([snap('2026-04', 6000), snap('2026-05', 7000)]);
  assert.deepEqual(r, { put: 1, deleted: 1 }, 'a pruned month is deleted, a new one written');
  await DB.syncOverrides(2026, { mileage: { medical: 0.5 } });
  await DB.syncOverrides(2025, { receiptThreshold: 50 });
  assert.deepEqual(await DB.getOverrides(), { 2025: { receiptThreshold: 50 }, 2026: { mileage: { medical: 0.5 } } });
  r = await DB.syncOverrides(2026, {});
  assert.deepEqual(r, { put: 0, deleted: 1 });
  assert.deepEqual(await DB.getOverrides(), { 2025: { receiptThreshold: 50 } }, 'clearing one year leaves the other alone');
  const counts = await DB.counts();
  assert.equal(counts.learned, 1); assert.equal(counts.weights, 1); assert.equal(counts.dismissals, 0); assert.equal(counts.layouts, 1); assert.equal(counts.snapshots, 2); assert.equal(counts.overrides, 1);
});

test('the settings row holds scalars only and round-trips', async () => {
  await DB.clearAll();
  const saved = await DB.saveSettings({ taxYear: 2025, taxYearPickedAt: '2026-02-14', filingStatus: 'hoh', taxpayerName: '  Alex ', learned: { cvs: 'med.prescriptions' }, experiments: { nudges: false } });
  assert.equal(saved.learned, undefined);
  const back = await DB.getSettings();
  assert.equal(back.taxYear, 2025); assert.equal(back.filingStatus, 'hoh'); assert.equal(back.taxpayerName, '  Alex '); assert.equal(back.experimentNudges, false);
  assert.equal(back.taxYearPickedAt, '2026-02-14', 'the day a year was chosen by hand is kept, so the New Year roll-over leaves that choice alone');
  assert.deepEqual(await DB.getLearned(), {}, 'a collection passed on the settings object is not silently stored anywhere');
});

test('the two figures the tax engine cannot see — the age band and the investment income — are stored and checked', async () => {
  await DB.clearAll();
  assert.equal(DB.sanitizeSettings({}).ltcAgeBracket, '', 'unset until the taxpayer says');
  assert.equal(DB.sanitizeSettings({}).investmentIncome, '');
  assert.equal(DB.sanitizeSettings({ ltcAgeBracket: '61-70' }).ltcAgeBracket, '61-70');
  assert.equal(DB.sanitizeSettings({ ltcAgeBracket: '65' }).ltcAgeBracket, '', 'a band the engine does not know is dropped, not stored');
  assert.equal(DB.sanitizeSettings({ ltcAgeBracket: { toString: () => '41-50' } }).ltcAgeBracket, '41-50');
  const saved = await DB.saveSettings({ ltcAgeBracket: '71+', investmentIncome: 4200 });
  const back = await DB.getSettings();
  assert.equal(back.ltcAgeBracket, '71+');
  assert.equal(back.investmentIncome, '4200', 'money fields are kept as the strings the settings form writes');
  assert.equal(saved.ltcAgeBracket, back.ltcAgeBracket);
});

test('a spouse insured under a second long-term-care policy has an age band of their own', async () => {
  await DB.clearAll();
  assert.ok('spouseLtcAgeBracket' in DB.DEFAULT_SETTINGS, 'sanitizeSettings copies known keys only, so an unknown one could never be saved');
  assert.equal(DB.sanitizeSettings({}).spouseLtcAgeBracket, '', 'unset until the taxpayer says: one policy is entitled to one limit');
  assert.equal(DB.sanitizeSettings({ spouseLtcAgeBracket: '71+' }).spouseLtcAgeBracket, '71+');
  assert.equal(DB.sanitizeSettings({ spouseLtcAgeBracket: '65' }).spouseLtcAgeBracket, '', 'a band the engine does not know is dropped, not stored');
  assert.equal(DB.sanitizeSettings({ ltcAgeBracket: '41-50', spouseLtcAgeBracket: '61-70' }).ltcAgeBracket, '41-50', 'the two bands are independent');
  await DB.saveSettings({ filingStatus: 'mfj', ltcAgeBracket: '41-50', spouseLtcAgeBracket: '61-70' });
  const back = await DB.getSettings();
  assert.equal(back.spouseLtcAgeBracket, '61-70');
  assert.equal(back.ltcAgeBracket, '41-50');
});

test('a version-2 backup imports into rows; a version-3 backup is rows already; the export is version 3', async () => {
  await DB.clearAll();
  const entry = { id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.prescriptions', amount: 42.13, description: 'CVS', note: '', hasReceipt: false, receiptId: null };
  const v2 = { app: 'itemizer', version: 2, settings: legacyDoc, entries: [entry, { id: 'bad' }], places: [{ id: 'p1', name: 'Home', category: 'home', lat: 35, lon: -78 }, { id: 'p2' }], trips: [{ id: 't1', date: '2026-02-02', fromId: 'p1', toId: 'p1', miles: 3 }, { id: 't2', date: 'nope' }] };
  const res = await DB.importJSON(v2, { schema: Schema });
  assert.equal(res.entries, 1); assert.equal(res.skipped, 1);
  assert.deepEqual(res.rows, { learned: 2, weights: 2, dismissals: 1, layouts: 1, snapshots: 1, overrides: 2 });
  assert.deepEqual(await DB.getLearned(), { cvs: 'med.prescriptions', 'joes auto': 'se.car' });
  assert.deepEqual(await DB.getOverrides(), { 2026: { mileage: { medical: 0.5 }, standardDeduction: { mfs: 0 } } });
  assert.equal((await DB.getPlaces()).length, 1); assert.equal((await DB.getTrips()).length, 1);
  const s = await DB.getSettings();
  assert.equal(s.filingStatus, 'mfj'); assert.equal(s.experimentCorrections, false); assert.equal(s.learned, undefined);
  const out = await DB.exportJSON();
  assert.equal(out.version, 3);
  assert.deepEqual(Object.keys(out), ['app', 'version', 'exportedAt', 'settings', 'learned', 'weights', 'dismissals', 'layouts', 'snapshots', 'overrides', 'entries', 'places', 'trips', 'receipts'], 'receipts stay last so the streamed backup can append them');
  assert.equal(out.settings.learned, undefined);
  assert.deepEqual(out.learned.map((r) => r.key).sort(), ['cvs', 'joes auto']);
  assert.equal(out.overrides.length, 2);
  // a version-3 file merges row by row
  await DB.clearAll();
  const res3 = await DB.importJSON(Object.assign({}, out, { learned: out.learned.concat([{ key: 'x', lineId: 'no.such' }]) }), { schema: Schema });
  assert.deepEqual(res3.rows, { learned: 2, weights: 2, dismissals: 1, layouts: 1, snapshots: 1, overrides: 2 }, 'the unknown line is rejected');
  assert.deepEqual(await DB.getWeights(), { pharmacy: 1.25, gas: 0.7 });
  await assert.rejects(() => DB.importJSON({ app: 'other', entries: [] }), /not an Itemizer backup/);
});

test('a restore that replaces the ledger keeps what the app has learned; delete-everything removes every store', async () => {
  await DB.clearAll();
  await DB.putLearned('cvs', 'med.prescriptions');
  await DB.putEntry({ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.prescriptions', amount: 1 });
  await DB.importJSON({ app: 'itemizer', version: 3, entries: [{ id: 'e2', date: '2026-01-06', taxYear: 2026, lineId: 'med.doctor', amount: 2 }] }, { replace: true, schema: Schema });
  assert.deepEqual((await DB.getEntries()).map((e) => e.id), ['e2'], 'the old ledger is gone');
  assert.deepEqual(await DB.getLearned(), { cvs: 'med.prescriptions' }, 'learned payees survive a replace');
  await DB.clearAll();
  const c = await DB.counts();
  assert.ok(Object.values(c).every((n) => n === 0), JSON.stringify(c));
  const info = await DB.storageInfo();
  assert.equal(info.mode, 'memory'); assert.equal(info.version, 3); assert.deepEqual(info.stores, DB.STORE_NAMES); assert.equal(info.counts.entries, 0);
});

test('deleting an entry takes the trip that was logged for it, and leaves the other trips alone', async () => {
  await DB.clearAll();
  await DB.putEntry({ id: 'e1', date: '2026-03-01', taxYear: 2026, lineId: 'med.miles', amount: 18 });
  await DB.putEntry({ id: 'e2', date: '2026-03-02', taxYear: 2026, lineId: 'med.miles', amount: 4 });
  await DB.putTrip({ id: 't1', date: '2026-03-01', taxYear: 2026, miles: 18, lineId: 'med.miles', entryId: 'e1' });
  await DB.putTrip({ id: 't2', date: '2026-03-02', taxYear: 2026, miles: 4, lineId: 'med.miles', entryId: 'e2' });
  const removed = await DB.deleteEntry('e1');
  assert.deepEqual(removed.map((t) => t.id), ['t1'], 'the caller is told which trips went, so it can offer to undo them');
  assert.deepEqual((await DB.getTrips()).map((t) => t.id), ['t2'], 'the mileage log cannot list a drive the ledger no longer has');
  assert.deepEqual((await DB.getEntries()).map((e) => e.id), ['e2']);
  assert.deepEqual((await DB.deleteEntries(['e2'])).map((t) => t.id), ['t2']);
  assert.equal((await DB.getTrips()).length, 0);
});

test('a restore keeps the settings the file does not carry, and a patch does not undo what another tab saved', async () => {
  await DB.clearAll();
  await DB.saveSettings({ taxpayerName: 'Alex', stateWithholding: '4200', filingStatus: 'single' });
  await DB.importJSON({ app: 'itemizer', version: 3, entries: [], settings: { filingStatus: 'hoh' } }, { schema: Schema });
  let s = await DB.getSettings();
  assert.equal(s.filingStatus, 'hoh', 'the file wins for the keys it carries');
  assert.equal(s.taxpayerName, 'Alex'); assert.equal(s.stateWithholding, '4200');
  await DB.importJSON({ app: 'itemizer', version: 2, entries: [], settings: { experiments: { nudges: false } } }, { schema: Schema });
  s = await DB.getSettings();
  assert.equal(s.experimentNudges, false, 'the old nested switches still arrive');
  assert.equal(s.taxpayerName, 'Alex');
  const stale = await DB.getSettings(); // the copy a tab that has been open a while is holding
  await DB.updateSettings({ agi: '95000' }); // the other tab
  await DB.updateSettings({ theme: 'dark' }); // this tab, from its stale copy
  s = await DB.getSettings();
  assert.equal(stale.agi, '', 'the stale copy really did not have the AGI');
  assert.equal(s.theme, 'dark'); assert.equal(s.agi, '95000'); assert.equal(s.taxpayerName, 'Alex');
});

test('a tab that syncs the keywords it knows does not delete the one another tab has just learned', async () => {
  await DB.clearAll();
  await DB.syncWeights({ cvs: 1.2 });
  const known = await DB.getWeights(); // what this tab loaded
  await DB.syncWeights({ cvs: 1.2, pharmacy: 0.7 }); // the other tab learns a keyword
  assert.deepEqual(await DB.syncWeights(Object.assign({}, known, { copay: 1.3 }), known), { put: 1, deleted: 0 });
  assert.deepEqual(await DB.getWeights(), { cvs: 1.2, pharmacy: 0.7, copay: 1.3 });
  assert.deepEqual(await DB.syncWeights({}, { cvs: 1.2, copay: 1.3 }), { put: 0, deleted: 2 }, 'keywords the caller did know about are still dropped');
  assert.deepEqual(await DB.getWeights(), { pharmacy: 0.7 });
});

test('a backup carries the receipt photos out and back, and deleting the entry takes the photo with it', async () => {
  await DB.clearAll();
  await DB.putEntry({ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 100, hasReceipt: true, receiptId: 'r1' });
  await DB.putReceipt({ id: 'r1', entryId: 'e1', type: 'image/png', createdAt: '2026-01-05T00:00:00.000Z', blob: await DB.dataURLToBlob(PNG) });
  const backup = await DB.exportBackup();
  assert.deepEqual([backup.receipts, backup.failed], [1, 0]);
  const parsed = JSON.parse(await backup.blob.text());
  assert.equal(parsed.receipts.length, 1);
  assert.equal(parsed.receipts[0].dataURL, PNG, 'the photo comes back byte for byte');
  await DB.clearAll();
  const res = await DB.importJSON(parsed, { schema: Schema });
  assert.deepEqual([res.receipts, res.badReceipts, res.dangling], [1, 0, 0]);
  assert.equal((await DB.getEntries())[0].receiptId, 'r1');
  assert.equal((await DB.getReceipt('r1')).blob.type, 'image/png');
  assert.equal(await DB.countRows('receipts'), 1);
  await DB.deleteEntry('e1');
  assert.equal(await DB.getReceipt('r1'), null, 'the photo goes with the entry it belonged to');
});

test('a row keyed like a built-in JavaScript name is refused at the door and never corrupts a map', async () => {
  assert.equal(DB.sanitizeEntry({ id: '__proto__', date: '2026-01-05', lineId: 'med.doctor', amount: 10 }, Schema), null);
  assert.equal(DB.sanitizeRow('learned', { key: '__proto__', lineId: 'med.doctor' }, Schema), null);
  assert.equal(DB.sanitizeRow('dismissals', { id: 'constructor', dismissedAt: '2026-09-18' }), null);
  await DB.clearAll();
  await DB.putLearned('constructor', 'med.doctor');
  const learned = await DB.getLearned();
  assert.equal(learned.constructor, 'med.doctor');
  assert.deepEqual(Object.keys(learned), ['constructor']);
  await DB.putRow('entries', { id: '__proto__', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 10 });
  const back = await DB.getRow('entries', '__proto__');
  assert.notEqual(back, Object.prototype, 'the row is a row, not the prototype of every object');
  assert.equal(back.amount, 10);
  assert.equal(await DB.countRows('entries'), 1);
});

test('an upgrade another tab is blocking gives up rather than leave the app waiting for ever', () => {
  const out = inChild(
    "globalThis.indexedDB = { open() { const req = {}; setTimeout(() => req.onblocked && req.onblocked({}), 1); globalThis.req = req; return req; } };",
    `DB.blockedTimeoutMs = 20;
     const error = await DB.getSettings().then(() => null, (e) => e.message);
     let closed = false;
     globalThis.req.result = { close() { closed = true; } };
     globalThis.req.onsuccess();
     return { error, notice: DB.notice, closed, mode: DB.mode };`);
  assert.match(out.error, /Close other Itemizer tabs/);
  assert.match(out.notice, /Close other Itemizer tabs/);
  assert.equal(out.closed, true, 'a connection that arrives after we gave up is closed, not left to block the next open');
  assert.equal(out.mode, 'unavailable', 'the settings screen can say that storage is not working');
});

test('a request that throws aborts its transaction, so nothing of the batch is written', () => {
  const out = inChild(
    `let aborted = false; const written = [];
     const os = { put(r) { if (r.id === 'bad') { const e = new Error('invalid key'); e.name = 'DataError'; throw e; } written.push(r.id); } };
     globalThis.written = written; globalThis.state = () => aborted;
     globalThis.indexedDB = { open() {
       const req = {};
       const db = { transaction() { const t = { objectStore: () => os, abort() { aborted = true; queueMicrotask(() => t.onabort && t.onabort({})); } }; queueMicrotask(() => { if (!aborted && t.oncomplete) t.oncomplete({}); }); return t; }, close() {} };
       setTimeout(() => { req.result = db; req.onsuccess({}); }, 1);
       return req;
     } };`,
    `const error = await DB.putRows('places', [{ id: 'good', name: 'A' }, { id: 'bad', name: 'B' }]).then(() => null, (e) => e.name);
     return { error, aborted: globalThis.state(), written: globalThis.written };`);
  assert.equal(out.error, 'DataError');
  assert.equal(out.aborted, true, 'the row queued before the bad one must not commit on its own');
  assert.deepEqual(out.written, ['good'], 'that row was queued, which is exactly why the transaction has to be aborted');
});

test('without IndexedDB the same stores are kept in localStorage, and the pre-v3 document is split into them', () => {
  const seed = {
    settings: { taxYear: 2026, filingStatus: 'mfj', learned: { cvs: 'med.prescriptions' }, paramOverrides: { 2026: { mileage: { medical: 0.5 } } } },
    entries: [{ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 10 }],
    places: [{ id: 'p1', name: 'Home', category: 'home', lat: 35, lon: -78 }],
    trips: [{ id: 't1', date: '2026-02-02', taxYear: 2026, miles: 3, lineId: 'med.miles' }],
  };
  const out = inChild(
    `const m = new Map();
     globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
     globalThis.localStorage.setItem('itemizer:fallback', JSON.stringify(${JSON.stringify(seed)}));`,
    `const entries = (await DB.getEntries()).map((e) => e.id);
     const first = { mode: DB.mode, entries, learned: await DB.getLearned(), overrides: await DB.getOverrides(), filingStatus: (await DB.getSettings()).filingStatus, legacy: localStorage.getItem('itemizer:fallback'), places: (await DB.getPlaces()).length, trips: (await DB.getTrips()).length };
     await DB.putEntry({ id: 'e2', date: '2026-01-06', taxYear: 2026, lineId: 'med.doctor', amount: 2 });
     first.afterPut = (await DB.getEntries()).map((e) => e.id).sort();
     await DB.deleteEntry('e2');
     first.afterDelete = (await DB.getEntries()).map((e) => e.id);
     localStorage.setItem = () => { const e = new Error('no room'); e.name = 'QuotaExceededError'; throw e; };
     first.quota = await DB.putEntry({ id: 'e3', date: '2026-01-07', taxYear: 2026, lineId: 'med.doctor', amount: 3 }).then(() => null, (e) => e.message);
     return first;`);
  assert.equal(out.mode, 'local');
  assert.deepEqual(out.entries, ['e1']);
  assert.deepEqual(out.learned, { cvs: 'med.prescriptions' });
  assert.deepEqual(out.overrides, { 2026: { mileage: { medical: 0.5 } } });
  assert.equal(out.filingStatus, 'mfj');
  assert.deepEqual([out.places, out.trips], [1, 1]);
  assert.equal(out.legacy, null, 'the one document of versions 1 and 2 is gone once it has been split');
  assert.deepEqual(out.afterPut, ['e1', 'e2']);
  assert.deepEqual(out.afterDelete, ['e1']);
  assert.match(out.quota, /Storage is full/);
});

test('a restore that runs out of room leaves the ledger that was already here', () => {
  const out = inChild(
    `const m = new Map();
     globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (k === 'itemizer:store:places') { const e = new Error('no room'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };`,
    `const Schema = require(${JSON.stringify(SCHEMA)});
     await DB.putEntry({ id: 'old', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 1 });
     const file = { app: 'itemizer', version: 3, entries: [{ id: 'new1', date: '2026-01-06', taxYear: 2026, lineId: 'med.doctor', amount: 2 }], places: [{ id: 'p1', name: 'Home' }] };
     const error = await DB.importJSON(file, { schema: Schema, replace: true }).then(() => null, (e) => e.message);
     return { error, entries: (await DB.getEntries()).map((e) => e.id).sort() };`);
  assert.match(out.error, /Storage is full/);
  assert.match(out.error, /Only part of the backup could be saved: 1 entry was written/, 'the message says what landed rather than claiming nothing did');
  assert.deepEqual(out.entries, ['new1', 'old'], 'a replace only takes the old ledger away once the new one is written');
});

test('a receipt whose entry is gone is left out of the backup instead of riding along in every one', async () => {
  await DB.clearAll();
  assert.deepEqual(DB.orphanReceiptIds([{ id: 'r1', entryId: 'e1' }, { id: 'r2', entryId: 'gone' }, { id: 'r3', entryId: null }], [{ id: 'e1' }]), ['r2'], 'only a receipt that names an entry the ledger does not have');
  await DB.putEntry({ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 100, hasReceipt: true, receiptId: 'r1' });
  const blob = await DB.dataURLToBlob(PNG);
  await DB.putReceipt({ id: 'r1', entryId: 'e1', type: 'image/png', createdAt: '2026-01-05T00:00:00.000Z', blob });
  await DB.putReceipt({ id: 'r2', entryId: 'gone', type: 'image/png', createdAt: '2026-01-05T00:00:00.000Z', blob });
  assert.equal(await DB.countRows('receipts'), 2, 'both photos are still stored; only the backup leaves one behind');
  assert.deepEqual((await DB.exportJSON()).receipts.map((r) => r.id), ['r1']);
  const backup = await DB.exportBackup();
  assert.deepEqual([backup.receipts, backup.failed], [1, 0]);
  assert.deepEqual(JSON.parse(await backup.blob.text()).receipts.map((r) => r.id), ['r1']);
});

test('an entry and the trip logged for it are written together', async () => {
  await DB.clearAll();
  const entry = { id: 'e1', date: '2026-03-01', taxYear: 2026, lineId: 'med.miles', amount: 18 };
  const trip = { id: 't1', date: '2026-03-01', taxYear: 2026, miles: 18, lineId: 'med.miles', entryId: 'e1' };
  await DB.putTripWithEntry(entry, trip);
  assert.deepEqual((await DB.getEntries()).map((e) => e.id), ['e1']);
  assert.deepEqual((await DB.getTrips()).map((t) => t.id), ['t1']);
});

test('entries and the photo one of them names go in a single transaction, so a failure leaves neither', () => {
  const out = inChild(
    `let aborted = false, names = null; const written = { entries: [], receipts: [] };
     const store = (name) => ({ put(r) { if (name === 'receipts') { const e = new Error('invalid key'); e.name = 'DataError'; throw e; } written[name].push(r.id); } });
     globalThis.indexedDB = { open() {
       const req = {};
       const db = { transaction(n) { names = n; const t = { objectStore: (s) => store(s), abort() { aborted = true; queueMicrotask(() => t.onabort && t.onabort({})); } }; queueMicrotask(() => { if (!aborted && t.oncomplete) t.oncomplete({}); }); return t; }, close() {} };
       setTimeout(() => { req.result = db; req.onsuccess({}); }, 1);
       return req;
     } };
     globalThis.peek = () => ({ aborted, names, written });`,
    `const error = await DB.putEntriesWithReceipt([{ id: 'e1' }], { id: 'r1' }).then(() => null, (e) => e.name);
     return Object.assign({ error }, globalThis.peek());`);
  assert.deepEqual(out.names, ['entries', 'receipts'], 'one transaction over both stores, so neither needs a compensating delete');
  assert.equal(out.error, 'DataError');
  assert.deepEqual(out.written.entries, ['e1'], 'the entry was queued, which is why the transaction has to be aborted');
  assert.equal(out.aborted, true, 'an entry claiming a photo that could not be stored must not commit on its own');
});

test('a wipe that cannot clear a store says which ones are left instead of reporting success', () => {
  const out = inChild(
    `const m = new Map();
     globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: () => { throw new Error('denied'); } };`,
    `await DB.putEntry({ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 1 });
     const error = await DB.clearAll().then(() => null, (e) => e.message);
     return { error, entries: (await DB.getEntries()).map((e) => e.id) };`);
  assert.match(out.error, /not cleared/);
  assert.match(out.error, /entries/);
  assert.deepEqual(out.entries, ['e1'], 'the row is still here, so the wipe must not report that everything went');
});
