// Worksheet fidelity: the printed sheet follows the paper organizer it was built from.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/schema.js');
const R = require('../js/rules.js');
require('../js/store.js');
const DB = globalThis.ItemizerStore;

test('the paper continues Self-Employed at the foot of the right column, from Repairs & Maintenance to Total Miles', () => {
  const se = S.linesForSection('selfemp');
  assert.deepEqual(se.filter((l) => l.column === 'left').map((l) => l.id), ['se.advertising', 'se.car', 'se.professional', 'se.office', 'se.rent', 'se.utilities', 'se.miles']);
  assert.deepEqual(se.filter((l) => l.column === 'right').map((l) => l.id), ['se.repairs', 'se.supplies', 'se.taxes', 'se.travel', 'se.meals', 'se.other', 'se.total_miles']);
  assert.equal(S.getSection('selfemp').column, 'left');
});

test('every other line sits in its own section\'s column', () => {
  for (const l of S.LINES) {
    assert.ok(['left', 'right'].includes(l.column), l.id);
    if (l.sectionId !== 'selfemp') assert.equal(l.column, S.getSection(l.sectionId).column, l.id);
  }
});

test('Education is the one section whose lines land on different forms, so it alone gets no section total', () => {
  const mixed = (id) => new Set(S.linesForSection(id).filter((l) => l.treatment !== 'info').map((l) => l.treatment)).size > 1;
  assert.equal(mixed('education'), true);
  for (const s of S.SECTIONS) if (s.id !== 'education') assert.equal(mixed(s.id), false, s.id);
});

test('two labels keep the paper\'s punctuation (the photo reads "Post-secondary, Tuition & Fees" and "Place of Worship, Scouts, School, etc")', () => {
  assert.equal(S.getLine('edu.tuition').label, 'Post-secondary, Tuition & Fees');
  assert.equal(S.getLine('vol.expenses').label, 'Place of Worship, Scouts, School, etc');
  assert.equal(S.linesForSection('medical').filter((l) => l.label === 'Doctor').length, 1, 'the paper has one Doctor line');
});

test('the name on the return is a bounded string setting', () => {
  assert.equal(DB.sanitizeSettings({}).taxpayerName, '');
  assert.equal(DB.sanitizeSettings({ taxpayerName: 'x'.repeat(500) }).taxpayerName.length, 200);
  assert.equal(DB.sanitizeSettings({ taxpayerName: null }).taxpayerName, '');
  assert.equal(DB.sanitizeSettings({ taxpayerName: 42 }).taxpayerName, '42');
  assert.equal(DB.sanitizeSettings(null).taxpayerName, '');
});

test('a section total is the sum of its own monthly bars, information lines included', () => {
  // edu.expenses is an information line: it is a note for the preparer, so it belongs in neither figure.
  const entries = [
    { id: 'a', date: '2026-03-01', lineId: 'edu.expenses', amount: 1000, hasReceipt: true },
    { id: 'b', date: '2026-04-01', lineId: 'edu.tuition', amount: 500, hasReceipt: true },
    { id: 'c', date: '2026-05-01', lineId: 'med.miles', amount: 100, hasReceipt: true },
    { id: 'd', date: '2026-08-01', lineId: 'se.total_miles', amount: 9000, hasReceipt: true },
  ];
  const r = R.compute(entries, { taxYear: 2026, filingStatus: 'single', agi: 50000, today: '2026-09-02' });
  assert.equal(r.sections.education.value, 500);
  assert.equal(r.sections.education.count, 2, 'both entries are still counted in the ledger badge');
  for (const sec of S.SECTIONS) {
    const bars = R.cents(r.sections[sec.id].months.reduce((a, b) => a + b, 0));
    assert.equal(bars, r.sections[sec.id].value, sec.id);
  }
  assert.equal(R.cents(r.months.reduce((a, b) => a + b, 0)), R.cents(S.SECTIONS.reduce((a, sec) => a + r.sections[sec.id].value, 0)));
});

test('mileage rates print as cents per mile', () => {
  assert.equal(R.perMile(0.7), '70¢/mile');
  assert.equal(R.perMile(0.21), '21¢/mile');
  assert.equal(R.perMile(0.725), '72.5¢/mile');
});
