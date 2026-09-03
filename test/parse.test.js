const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, formatDate } = require('../js/parse.js');

const ctx = { today: '2026-09-02', defaultYear: 2026 };

test('amount with cents and a trailing numeric date', () => {
  const r = parse('42.13 CVS prescription 3/14', ctx);
  assert.equal(r.amount, 42.13);
  assert.equal(r.date, '2026-03-14');
  assert.equal(r.description, 'CVS prescription');
});

test('dollar sign, thousands separators, ISO date', () => {
  const r = parse('$1,250.00 property tax county treasurer 2026-01-15', ctx);
  assert.equal(r.amount, 1250);
  assert.equal(r.date, '2026-01-15');
  assert.equal(r.description, 'Property tax county treasurer');
});

test('relative dates', () => {
  assert.equal(parse('$300 tithe yesterday', ctx).date, '2026-09-01');
  assert.equal(parse('$300 tithe today', ctx).date, '2026-09-02');
  assert.equal(parse('$12 parking 3 days ago', ctx).date, '2026-08-30');
  // 2026-09-02 is a Wednesday; "last tuesday" is Sept 1
  assert.equal(parse('lunch with client 46.80 last tuesday', ctx).date, '2026-09-01');
  // "last wednesday" is a full week back, never today
  assert.equal(parse('lunch 20 last wednesday', ctx).date, '2026-08-26');
});

test('month names, ordinals, day-first', () => {
  assert.equal(parse('18 miles to physical therapy on Aug 3', ctx).date, '2026-08-03');
  assert.equal(parse('dentist $210 March 14th, 2025', ctx).date, '2025-03-14');
  assert.equal(parse('dentist $210 14 Mar', ctx).date, '2026-03-14');
  assert.equal(parse('dentist $210 on the 14th of March', ctx).date, '2026-03-14');
});

test('a month/day in the future without a year rolls back to last year', () => {
  const r = parse('donated 4 bags of clothes to goodwill 12/28', ctx);
  assert.equal(r.date, '2025-12-28');
  assert.equal(r.amount, null, 'a count of bags is not a dollar amount');
  assert.equal(r.description, 'Donated 4 bags of clothes to goodwill');
});

test('a different selected tax year wins over the current year for bare month/day', () => {
  const r = parse('copay 40 12/28', { today: '2027-02-10', defaultYear: 2026 });
  assert.equal(r.date, '2026-12-28');
});

test('two-digit and dotted years', () => {
  assert.equal(parse('$45 tolls 7-3-26', ctx).date, '2026-07-03');
  assert.equal(parse('03.14.2026 dentist 210', ctx).date, '2026-03-14');
  assert.equal(parse('03.14.2026 dentist 210', ctx).amount, 210);
});

test('miles are separated from dollars', () => {
  const r = parse('18 miles to physical therapy, $6 parking', ctx);
  assert.equal(r.miles, 18);
  assert.equal(r.amount, 6);
  assert.match(r.description, /Physical therapy/);
  assert.equal(parse('odometer 14,220 miles', ctx).miles, 14220);
  assert.equal(parse('12mi to pharmacy', ctx).miles, 12);
});

test('"dollars" and bare integers', () => {
  assert.equal(parse('Navient student loan interest 2,140 dollars', ctx).amount, 2140);
  assert.equal(parse('45', ctx).amount, 45);
  assert.equal(parse('45', ctx).description, '');
});

test('filler words are trimmed but meaning kept', () => {
  const r = parse('Paid 120 to Dr. Lee on 3/14 for copay', ctx);
  assert.equal(r.amount, 120);
  assert.equal(r.description, 'Dr. Lee copay');
});

test('empty and junk input do not throw', () => {
  assert.deepEqual(parse('', ctx).amount, null);
  assert.equal(parse(null, ctx).description, '');
  assert.equal(parse('13/45 nonsense 99/99', ctx).date, null);
});

test('formatDate', () => {
  assert.equal(formatDate('2026-03-14'), 'Mar 14, 2026');
  assert.equal(formatDate('2026-03-14', false), 'Mar 14');
});
