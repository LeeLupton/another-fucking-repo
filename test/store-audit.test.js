const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/store.js');
const Schema = require('../js/schema.js');
const DB = globalThis.ItemizerStore;

test('free-text CSV cells cannot start a spreadsheet formula', () => {
  assert.equal(DB.csvText('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(DB.csvText('+1 lunch'), "'+1 lunch");
  assert.equal(DB.csvText('@cmd'), "'@cmd");
  assert.equal(DB.csvText('\tpayee'), "'\tpayee");
  assert.equal(DB.csvText('- lunch'), "'- lunch");
  assert.equal(DB.csvText('-12 refund'), '-12 refund', 'a negative number is left alone');
  assert.equal(DB.csvText('CVS, Raleigh'), '"CVS, Raleigh"');
  const csv = DB.toCSV([{ id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.prescriptions', amount: 42.13, description: '=2+2', note: '', hasReceipt: true, receiptId: null }], Schema);
  assert.match(csv, /,'=2\+2,/);
  assert.match(csv, /,42\.13,/);
});

test('backup entries are validated before they are stored', () => {
  const good = DB.sanitizeEntry({ id: 'e1', date: '2026-01-05', lineId: 'med.prescriptions', amount: '42.13', description: 'CVS', note: 5, hasReceipt: 'yes', receiptId: 9 }, Schema);
  assert.equal(good.amount, 42.13);
  assert.equal(good.taxYear, 2026);
  assert.equal(good.note, '5');
  assert.equal(good.hasReceipt, true);
  assert.equal(good.receiptId, null);
  assert.equal(DB.sanitizeEntry({ id: 'e2', date: '2026-01-05', lineId: 'nope', amount: 1 }, Schema), null, 'unknown line');
  assert.equal(DB.sanitizeEntry({ id: 'e3', date: 'Jan 5', lineId: 'med.doctor', amount: 1 }, Schema), null, 'bad date');
  assert.equal(DB.sanitizeEntry({ id: 'e4', date: '2026-01-05', lineId: 'med.doctor', amount: 'lots' }, Schema), null, 'bad amount');
  assert.equal(DB.sanitizeEntry({ id: 7, date: '2026-01-05', lineId: 'med.doctor', amount: 1 }, Schema), null, 'id must be a string');
  assert.equal(DB.sanitizeEntry(null, Schema), null);
});

test('settings are whitelisted and coerced; collections are no longer part of the row', () => {
  const s = DB.sanitizeSettings({ taxYear: '<img src=x onerror=alert(1)>', filingStatus: 'bogus', theme: 'neon', agi: 95000, age65: 'yes', evil: true, advisorDismissed: { a: '2026-01-01' }, learned: { cvs: 'med.prescriptions' }, experiments: { snapshots: false, nudges: true } });
  assert.equal(s.taxYear, new Date().getFullYear(), 'a bad year falls back to the default');
  assert.equal(s.filingStatus, 'single');
  assert.equal(s.theme, 'system');
  assert.equal(s.agi, '95000', 'strings stay strings');
  assert.equal(s.age65, true);
  assert.equal(s.evil, undefined, 'unknown keys are dropped');
  assert.equal(s.advisorDismissed, undefined, 'dismissals live in their own store');
  assert.equal(s.learned, undefined, 'learned payees live in their own store');
  assert.equal(s.experimentSnapshots, false, 'the old nested switches map onto the flat ones');
  assert.equal(s.experimentCorrections, true);
  assert.equal(s.experimentNudges, true);
  assert.equal(DB.sanitizeSettings({ experiments: { snapshots: false }, experimentSnapshots: true }).experimentSnapshots, true, 'a flat key wins over the old nested one');
  const a = DB.sanitizeSettings(null), b = DB.sanitizeSettings(null);
  assert.notEqual(a, b); assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(DB.DEFAULT_SETTINGS).sort());
  assert.ok(Object.values(DB.DEFAULT_SETTINGS).every((v) => ['string', 'number', 'boolean'].includes(typeof v)), 'the settings row holds scalars only');
});

test('receipt data URLs are decoded locally and only when they are images', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const blob = await DB.dataURLToBlob(png);
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.size > 50);
  await assert.rejects(DB.dataURLToBlob('https://example.com/x.png'), /Not an image/);
  await assert.rejects(DB.dataURLToBlob('data:text/html;base64,PHNjcmlwdD4='), /Not an image/);
});

test('toCSV: header, date order, section and line names, units, and escaping', () => {
  const rows = DB.toCSV([
    { id: 'b', date: '2026-03-02', taxYear: 2026, lineId: 'med.doctor', amount: 45, description: 'Dr "Lee", copay', note: '', hasReceipt: true, receiptId: 'r1' },
    { id: 'a', date: '2026-01-01', taxYear: 2026, lineId: 'se.miles', amount: 12, description: 'Client visit', note: 'n', hasReceipt: false, receiptId: null },
  ], Schema).split('\r\n');
  assert.equal(rows[0], 'date,tax_year,section,line,amount,unit,description,note,has_receipt,receipt_attached,id');
  assert.equal(rows.length, 3);
  assert.equal(rows[1], '2026-01-01,2026,Self-Employed Expenses,Business Miles,12,miles,Client visit,n,no,no,a', 'sorted by date, not by input order');
  assert.equal(rows[2], '2026-03-02,2026,Medical Expenses,Doctor,45,usd,"Dr ""Lee"", copay",,yes,yes,b');
  assert.equal(DB.toCSV([], Schema).split('\r\n').length, 1, 'header only when there is nothing to export');
});

test('backup places and trips are validated too, and keep every field the app writes', () => {
  assert.equal(DB.sanitizeRow('trips', { id: 't1', date: '2026-03-01', miles: 'eighteen', lineId: 'med.miles' }, Schema), null, 'a mileage log needs a number of miles');
  assert.equal(DB.sanitizeRow('trips', { id: 't1', date: '2026-03-01', miles: 18, lineId: 'no.such.line' }, Schema), null, 'unknown line');
  assert.equal(DB.sanitizeRow('trips', { id: 't1', date: '2026-03-01', miles: 18, lineId: 'med.doctor' }, Schema), null, 'a line that is not measured in miles');
  const cleaned = DB.sanitizeRow('trips', { id: 't2', date: '2026-03-01', miles: '12.34', taxYear: 'twenty26', lineId: 'med.miles', entryId: 5, roundTrip: 'maybe', method: '=cmd|calc', evil: 'x' }, Schema);
  assert.match(cleaned.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'a trip with no createdAt is stamped as it comes in');
  assert.deepEqual(Object.assign({}, cleaned, { createdAt: 'stamped' }), {
    id: 't2', date: '2026-03-01', taxYear: 2026, fromId: null, toId: null, fromLabel: '', toLabel: '', purpose: '', miles: 12.3,
    roundTrip: true, method: 'manual', lineId: 'med.miles', entryId: null, sample: false, points: null, startedAt: null, endedAt: null, createdAt: 'stamped',
  });
  const place = DB.sanitizeRow('places', { id: 'p1', name: 'Clinic', lat: 'north', lon: {}, category: 999, evil: '<script>' }, Schema);
  assert.equal(place.lat, null); assert.equal(place.lon, null, 'half a pair of coordinates would measure trips as NaN');
  assert.equal(place.category, 'other');
  assert.equal(place.evil, undefined, 'unknown keys are dropped');
  assert.equal(DB.sanitizeRow('places', { id: 'p2' }, Schema), null, 'a place needs a name');
  // the round trip that matters: what the app saves must survive a backup unchanged
  const saved = { id: 'p3', name: 'Clinic', category: 'medical', address: '1 Main St', lat: 35.77, lon: -78.63, note: '', sample: false, updatedAt: '2026-03-01T00:00:00.000Z' };
  assert.deepEqual(DB.sanitizeRow('places', saved, Schema), saved);
  const trip = {
    id: 't3', date: '2026-03-01', taxYear: 2026, fromId: 'p3', toId: 'p4', fromLabel: 'Home', toLabel: 'Clinic', purpose: 'Check-up', miles: 12.3,
    roundTrip: true, method: 'gps', lineId: 'med.miles', entryId: 'e1', sample: false, points: [{ lat: 35.77, lon: -78.63, t: 1772000000000, acc: 5 }, { gap: true }, { lat: 35.78, lon: -78.64, t: 1772000060000, acc: 4 }],
    startedAt: 1772000000000, endedAt: 1772000600000, createdAt: '2026-03-01T00:00:00.000Z',
  };
  assert.deepEqual(DB.sanitizeRow('trips', trip, Schema), trip);
  assert.equal(DB.sanitizeRow('trips', Object.assign({}, trip, { sample: true }), Schema).sample, true, 'an example trip is still known to be one after a restore');
});

test('the id column of the ledger CSV cannot start a spreadsheet formula either', () => {
  const csv = DB.toCSV([{ id: '=2+2', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 1, description: 'x', note: '' }], Schema).split('\r\n')[1];
  assert.equal(csv, "2026-01-05,2026,Medical Expenses,Doctor,1,usd,x,,no,no,'=2+2");
  assert.equal(DB.sanitizeEntry({ id: "=cmd|' /C calc'!A0", date: '2026-01-05', lineId: 'med.doctor', amount: 1 }, Schema), null, 'an id that is not one of ours is not stored at all');
  assert.equal(DB.sanitizeEntry({ id: '3f2a1b0c-0000-4000-8000-000000000001', date: '2026-01-05', lineId: 'med.doctor', amount: 1 }, Schema).id, '3f2a1b0c-0000-4000-8000-000000000001');
  assert.equal(DB.sanitizeRow('trips', { id: 't1', date: '2026-01-05', miles: 3, method: "=cmd|' /C calc'!A0" }).method, 'manual', 'the mileage log only prints methods the app knows');
});

test('a restored entry only claims a receipt photo that came with the file', async () => {
  await DB.clearAll();
  const entry = { id: 'e1', date: '2026-01-05', taxYear: 2026, lineId: 'med.doctor', amount: 100, hasReceipt: true, receiptId: 'r-missing' };
  const res = await DB.importJSON({ app: 'itemizer', version: 3, entries: [entry], receipts: [] }, { schema: Schema });
  assert.equal(res.dangling, 1);
  const stored = (await DB.getEntries())[0];
  assert.equal(stored.receiptId, null);
  assert.equal(stored.hasReceipt, true, 'the mark can still mean a paper receipt; only the claim to a photo is cleared');
  assert.equal(DB.toCSV(await DB.getEntries(), Schema).split('\r\n')[1], '2026-01-05,2026,Medical Expenses,Doctor,100,usd,,,yes,no,e1');
  await DB.clearAll();
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const kept = await DB.importJSON({ app: 'itemizer', version: 3, entries: [Object.assign({}, entry, { receiptId: 'r1' })], receipts: [{ id: 'r1', entryId: 'e1', type: 'image/png', createdAt: '2026-01-05T00:00:00.000Z', dataURL: png }, { id: 'r2', entryId: 'gone', type: 'image/png', createdAt: '2026-01-05T00:00:00.000Z', dataURL: png }] }, { schema: Schema });
  assert.deepEqual([kept.receipts, kept.dangling, kept.orphanReceipts], [1, 0, 1], 'a photo whose entry is not in the file is not kept either');
  assert.equal((await DB.getEntries())[0].receiptId, 'r1');
});
