// The storage layer as a database: one keyed store per kind of record, row-level writes, and a lossless split of the
// old settings document. Under node there is neither IndexedDB nor localStorage, so the store runs in memory with the
// same row layer the browser uses.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/store.js');
const Schema = require('../js/schema.js');
const DB = globalThis.ItemizerStore;

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
  const saved = await DB.saveSettings({ taxYear: 2025, filingStatus: 'hoh', taxpayerName: '  Alex ', learned: { cvs: 'med.prescriptions' }, experiments: { nudges: false } });
  assert.equal(saved.learned, undefined);
  const back = await DB.getSettings();
  assert.equal(back.taxYear, 2025); assert.equal(back.filingStatus, 'hoh'); assert.equal(back.taxpayerName, '  Alex '); assert.equal(back.experimentNudges, false);
  assert.deepEqual(await DB.getLearned(), {}, 'a collection passed on the settings object is not silently stored anywhere');
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
