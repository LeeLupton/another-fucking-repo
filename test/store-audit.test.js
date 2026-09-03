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

test('settings are whitelisted and coerced, and never share objects with the defaults', () => {
  const s = DB.sanitizeSettings({ taxYear: '<img src=x onerror=alert(1)>', filingStatus: 'bogus', theme: 'neon', agi: 95000, age65: 'yes', evil: true, advisorDismissed: { a: '2026-01-01' }, learned: { cvs: 'med.prescriptions' } });
  assert.equal(s.taxYear, new Date().getFullYear());
  assert.equal(s.filingStatus, 'single');
  assert.equal(s.theme, 'system');
  assert.equal(s.agi, '95000');
  assert.equal(s.age65, true);
  assert.equal('evil' in s, false);
  assert.deepEqual(s.advisorDismissed, { a: '2026-01-01' });
  assert.deepEqual(s.learned, { cvs: 'med.prescriptions' });
  const a = DB.sanitizeSettings(null), b = DB.sanitizeSettings(null);
  a.advisorDismissed.x = 1;
  assert.equal(b.advisorDismissed.x, undefined, 'fresh objects each time');
  assert.equal(DB.DEFAULT_SETTINGS.advisorDismissed.x, undefined);
});

test('receipt data URLs are decoded locally and only when they are images', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const blob = await DB.dataURLToBlob(png);
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.size > 50);
  await assert.rejects(DB.dataURLToBlob('https://example.com/x.png'), /Not an image/);
  await assert.rejects(DB.dataURLToBlob('data:text/html;base64,PHNjcmlwdD4='), /Not an image/);
});
