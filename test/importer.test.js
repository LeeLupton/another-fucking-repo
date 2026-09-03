const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/importer.js');

test('CSV parsing handles quotes, escaped quotes, CRLF, and a BOM', () => {
  const rows = I.parseCSV('﻿Date,Description,Amount\r\n01/05/2026,"CVS PHARMACY #1234, RALEIGH NC",-42.13\r\n01/06/2026,"He said ""hi""",-5\r\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['01/05/2026', 'CVS PHARMACY #1234, RALEIGH NC', '-42.13']);
  assert.equal(rows[2][1], 'He said "hi"');
});

test('date and amount cells in the usual bank formats', () => {
  assert.equal(I.parseDateCell('01/05/2026'), '2026-01-05');
  assert.equal(I.parseDateCell('1/5/26'), '2026-01-05');
  assert.equal(I.parseDateCell('2026-01-05'), '2026-01-05');
  assert.equal(I.parseDateCell('Jan 5, 2026'), '2026-01-05');
  assert.equal(I.parseDateCell('05-Jan-2026'), '2026-01-05');
  assert.equal(I.parseDateCell('not a date'), null);
  assert.equal(I.parseAmountCell('$1,234.56'), 1234.56);
  assert.equal(I.parseAmountCell('(12.00)'), -12);
  assert.equal(I.parseAmountCell('-12.00'), -12);
  assert.equal(I.parseAmountCell('12.00 CR'), -12);
  assert.equal(I.parseAmountCell('abc'), null);
});

test('card export with a single amount column: spending is negative and gets flipped', () => {
  const rows = I.parseCSV('Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n03/14/2026,03/15/2026,CVS PHARMACY,Health,Sale,-42.13,\n03/16/2026,03/17/2026,PAYMENT THANK YOU,,Payment,500.00,\n03/18/2026,03/19/2026,ST ANDREWS CHURCH,Gifts,Sale,-200.00,');
  const map = I.detectColumns(rows);
  assert.equal(map.date, 0);
  assert.equal(map.description, 2);
  assert.equal(map.amount, 5);
  assert.equal(map.memo, 3, 'category column doubles as memo');
  const norm = I.normalize(rows, map);
  assert.equal(norm.spendIsNegative, true);
  assert.deepEqual(norm.rows.map((r) => r.amount), [42.13, -500, 200]);
  const rev = I.review(norm.rows, {});
  assert.equal(rev[0].lineId, 'med.prescriptions');
  assert.equal(rev[0].selected, true);
  assert.equal(rev[1].refund, true);
  assert.equal(rev[1].selected, false, 'a payment is never proposed');
  assert.equal(rev[2].lineId, 'ch.worship');
});

test('bank export with debit and credit columns, and duplicate detection', () => {
  const rows = I.parseCSV('Date,Details,Debit,Credit,Balance\n2026-02-11,Dr Patel copay,45.00,,1000.00\n2026-02-12,Payroll,,2500.00,3500.00\n2026-02-11,Dr Patel copay,45.00,,955.00');
  const map = I.detectColumns(rows);
  assert.equal(map.debit, 2);
  assert.equal(map.credit, 3);
  assert.equal(map.description, 1);
  const norm = I.normalize(rows, map);
  assert.deepEqual(norm.rows.map((r) => r.amount), [45, -2500, 45]);
  const rev = I.review(norm.rows, { existingEntries: [{ date: '2026-02-11', amount: 45, description: 'Dr. Patel copay' }] });
  assert.equal(rev[0].duplicate, true, 'already in the ledger');
  assert.equal(rev[2].duplicate, true, 'same date, amount and payee twice in the file');
  assert.equal(rev[0].selected, false);
  // a ledger entry with no description only earns a soft warning: the row stays ticked
  const soft = I.review(norm.rows, { existingEntries: [{ date: '2026-02-11', amount: 45, description: '' }] });
  assert.equal(soft[0].duplicate, false);
  assert.equal(soft[0].possibleDuplicate, true);
  assert.equal(soft[0].selected, true);
});

test('a file with no header row is sniffed', () => {
  const rows = I.parseCSV('03/14/2026,CVS PHARMACY,-42.13\n03/18/2026,ST ANDREWS CHURCH,-200.00');
  const map = I.detectColumns(rows);
  assert.equal(map.headerRow, false);
  assert.equal(map.date, 0);
  assert.equal(map.description, 1);
  assert.equal(map.amount, 2);
  assert.equal(I.normalize(rows, map).rows.length, 2);
});

test('non-deductible rows are shown but not pre-selected', () => {
  const rows = I.parseCSV('Date,Description,Amount\n03/14/2026,GOFUNDME FOR SAM,-50.00');
  const rev = I.review(I.normalize(rows, I.detectColumns(rows)).rows, {});
  assert.equal(rev[0].nonDeductible.length, 1);
  assert.equal(rev[0].selected, false);
});
