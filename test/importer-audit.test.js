const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../js/importer.js');

test('a debit/credit indicator column sets each row sign, and refunds are never pre-ticked', () => {
  const rows = I.parseCSV('Date,Description,Amount,Transaction Type\n03/14/2026,CVS PHARMACY,42.13,debit\n03/16/2026,CVS PHARMACY,42.13,credit\n03/18/2026,ASPEN DENTAL,210.00,debit');
  const map = I.detectColumns(rows);
  assert.equal(map.type, 3);
  const norm = I.normalize(rows, map);
  assert.deepEqual(norm.rows.map((r) => r.amount), [42.13, -42.13, 210]);
  const rev = I.review(norm.rows, {});
  assert.equal(rev[0].selected, true);
  assert.equal(rev[1].refund, true);
  assert.equal(rev[1].selected, false);
  const chase = I.parseCSV('Transaction Date,Post Date,Description,Category,Type,Amount\n03/14/2026,03/15/2026,CVS PHARMACY,Health,Sale,-42.13\n03/20/2026,03/21/2026,CVS PHARMACY,Health,Return,42.13');
  const cm = I.detectColumns(chase);
  const cn = I.normalize(chase, cm);
  assert.deepEqual(cn.rows.map((r) => r.amount), [42.13, -42.13]);
  assert.equal(I.review(cn.rows, {})[1].refund, true);
});

test('day-first dates are recognised per file and can be forced', () => {
  const rows = I.parseCSV('Date,Description,Amount\n25/01/2025,BOOTS PHARMACY,-12.50\n03/02/2025,DENTIST,-80.00');
  const map = I.detectColumns(rows);
  assert.equal(map.dayFirst, true);
  assert.deepEqual(I.normalize(rows, map).rows.map((r) => r.date), ['2025-01-25', '2025-02-03']);
  const ambiguous = I.parseCSV('Date,Description,Amount\n03/02/2025,DENTIST,-80.00');
  const m2 = I.detectColumns(ambiguous);
  assert.equal(m2.dayFirst, false);
  assert.equal(I.normalize(ambiguous, m2).rows[0].date, '2025-03-02');
  m2.dayFirst = true;
  assert.equal(I.normalize(ambiguous, m2).rows[0].date, '2025-02-03');
  assert.equal(I.parseDateCell('05.01.2025', { dayFirst: true }), '2025-01-05');
});

test('a preamble above the header, a quote inside a field, and unreadable rows are handled', () => {
  const text = 'Account: 1234\nStatement period: Jan 2026\n\nDate,Description,Amount\n01/05/2026,CVS PHARMACY,-42.13\n01/06/2026,12" MONITOR STAND,-30.00\nnot a date,,\n01/07/2026,ASPEN DENTAL,-210.00';
  const rows = I.parseCSV(text);
  const map = I.detectColumns(rows);
  assert.equal(map.headerIndex, 2);
  assert.equal(map.date, 0);
  assert.equal(map.description, 1);
  assert.equal(map.amount, 2);
  const norm = I.normalize(rows, map);
  assert.equal(norm.rows.length, 3);
  assert.equal(norm.rows[1].description, '12" MONITOR STAND');
  assert.equal(norm.skipped, 1);
});

test('semicolon and tab delimited exports, including European decimals', () => {
  const semi = I.parseCSV('Datum;Beschreibung;Betrag\n2026-01-05;APOTHEKE;-42,13\n2026-01-06;ZAHNARZT;-1.210,00');
  assert.equal(semi[0].length, 3);
  assert.equal(I.parseAmountCell('-42,13'), -42.13);
  assert.equal(I.parseAmountCell('-1.210,00'), -1210);
  const tab = I.parseCSV('Date\tDescription\tAmount\n01/05/2026\tCVS PHARMACY\t-42.13');
  const map = I.detectColumns(tab);
  assert.equal(I.normalize(tab, map).rows[0].amount, 42.13);
});

test('the amount column is chosen by its cells, not by being the first numeric column', () => {
  const rows = I.parseCSV('Date,Check No,Payee,Value\n01/05/2026,1042,CVS PHARMACY,-42.13\n01/06/2026,1043,ASPEN DENTAL,-210.00');
  const map = I.detectColumns(rows);
  assert.equal(map.amount, 3);
  assert.equal(map.description, 2);
  const headerless = I.parseCSV('01/05/2026,1042,CVS PHARMACY,-42.13\n01/06/2026,1043,ASPEN DENTAL,-210.00');
  const m2 = I.detectColumns(headerless);
  assert.equal(m2.headerRow, false);
  assert.equal(m2.amount, 3);
});

test('debit and credit headers are matched by meaning, in either order, and indicator headers are not amounts', () => {
  const a = I.detectColumns(I.parseCSV('Date,Description,Amount Credit,Amount Debit\n01/05/2026,PAYROLL,2500.00,\n01/06/2026,CVS PHARMACY,,42.13'));
  assert.equal(a.credit, 2); assert.equal(a.debit, 3);
  const b = I.detectColumns(I.parseCSV('Date,Description,Amount Debit,Amount Credit\n01/05/2026,CVS PHARMACY,42.13,\n01/06/2026,PAYROLL,,2500.00'));
  assert.equal(b.debit, 2); assert.equal(b.credit, 3);
  const rows = I.parseCSV('Date,Description,Debit/Credit Indicator,Amount\n01/05/2026,CVS PHARMACY,Debit,42.13\n01/06/2026,PAYROLL,Credit,2500.00');
  const c = I.detectColumns(rows);
  assert.equal(c.debit, -1); assert.equal(c.credit, -1);
  assert.equal(c.type, 2); assert.equal(c.amount, 3);
  assert.deepEqual(I.normalize(rows, c).rows.map((r) => r.amount), [42.13, -2500]);
  const d = I.detectColumns(I.parseCSV('Post Date,Transaction Date,Description,Amount\n01/07/2026,01/05/2026,CVS PHARMACY,-42.13'));
  assert.equal(d.date, 1, 'the transaction date wins over the posting date');
  const e = I.detectColumns(I.parseCSV('Account Name,Payee Name,Date,Amount\nChecking,CVS PHARMACY,01/05/2026,-42.13'));
  assert.equal(e.description, 1);
});

test('only strong matches are pre-ticked, and Schedule C lines only when there is a business', () => {
  const rows = I.parseCSV('Date,Description,Amount\n01/05/2026,CVS PHARMACY,-42.13\n01/06/2026,STARBUCKS,-6.50\n01/07/2026,SHELL OIL,-40.00\n01/08/2026,COMCAST,-89.00\n01/09/2026,ER,-12.00');
  const norm = I.normalize(rows, I.detectColumns(rows));
  const rev = I.review(norm.rows, {});
  assert.equal(rev[0].selected, true, 'CVS PHARMACY');
  assert.equal(rev[1].selected, false, 'STARBUCKS without a business');
  assert.equal(rev[1].lineId, 'se.meals', 'the suggestion is still offered');
  assert.equal(rev[2].selected, false, 'SHELL without a business');
  assert.equal(rev[3].selected, false, 'COMCAST without a business');
  assert.equal(rev[4].selected, false, 'a two-letter word is not a strong match');
  const biz = I.review(norm.rows, { hasBusiness: true });
  assert.equal(biz[1].selected, true);
  assert.equal(biz[2].selected, true);
  const learned = I.review(norm.rows, { learned: { starbucks: 'se.meals' } });
  assert.equal(learned[1].selected, true, 'a learned payee is always strong');
});

test('withdrawal/deposit headers, the sign override, a type column beside the amount, and odd cells', () => {
  const two = I.parseCSV('Date,Description,Withdrawals,Deposits\n03/14/2026,CVS PHARMACY,42.13,\n03/15/2026,PAYROLL,,1500.00');
  const m2 = I.detectColumns(two);
  assert.equal(m2.debit, 2); assert.equal(m2.credit, 3); assert.equal(m2.amount, -1);
  assert.deepEqual(I.normalize(two, m2).rows.map((r) => r.amount), [42.13, -1500]);
  const one = I.parseCSV('Date,Description,Amount\n03/14/2026,CVS PHARMACY,42.13\n03/16/2026,REFUND CVS,-5.00\n03/18/2026,ASPEN DENTAL,10.00');
  const m1 = I.detectColumns(one);
  const auto = I.normalize(one, m1);
  assert.equal(auto.spendIsNegative, false); assert.deepEqual(auto.rows.map((r) => r.amount), [42.13, -5, 10]);
  const forced = I.normalize(one, m1, { spendIsNegative: true });
  assert.equal(forced.spendIsNegative, true); assert.deepEqual(forced.rows.map((r) => r.amount), [-42.13, 5, -10], 'the user\'s override wins over the heuristic');
  const typed = I.parseCSV('Posted Date,Payee,Amount,Type\n03/14/2026,CVS PHARMACY,42.13,Debit\n03/16/2026,CVS PHARMACY,5.00,Credit\n03/18/2026,ASPEN DENTAL,10.00,Debit');
  const mt = I.detectColumns(typed);
  assert.equal(mt.type, 3); assert.equal(mt.memo, -1); assert.equal(mt.description, 1);
  const tn = I.normalize(typed, mt);
  assert.deepEqual(tn.rows.map((r) => r.amount), [42.13, -5, 10]);
  assert.equal(tn.spendIsNegative, false, 'reported from the raw signs even though the indicator decides each row');
  assert.equal(I.parseAmountCell('+12'), 12);
  assert.equal(I.parseAmountCell('12.00 DR'), 12);
  assert.equal(I.parseAmountCell('(3.50)'), -3.5);
  assert.equal(I.parseDateCell('02/30/2026'), null);
  assert.equal(I.parseDateCell('2026-02-28'), '2026-02-28');
});

test('a learned payee is filed where it was filed before and says so', () => {
  const rows = I.parseCSV('Date,Description,Amount\n03/14/2026,JOES AUTO #12,88.00');
  const norm = I.normalize(rows, I.detectColumns(rows));
  const out = I.review(norm.rows, { learned: { 'joes auto': 'se.car' }, hasBusiness: true });
  assert.equal(out[0].lineId, 'se.car'); assert.equal(out[0].suggestions[0].learned, true); assert.equal(out[0].selected, true);
});
