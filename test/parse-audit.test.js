const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../js/parse.js');

const T = { today: '2026-09-02', defaultYear: 2026 };

test('"on <word>" is not a weekday unless it is one', () => {
  const a = parse('$20 on sunscreen', T);
  assert.equal(a.date, null); assert.equal(a.amount, 20); assert.equal(a.description, 'Sunscreen');
  const b = parse('$40 on wedding gift', T);
  assert.equal(b.date, null); assert.equal(b.description, 'Wedding gift');
  assert.equal(parse('$300 on monitor', T).description, 'Monitor');
  assert.equal(parse('$9 on Monday', T).date, '2026-08-31');
  assert.equal(parse('$9 last tue', T).date, '2026-09-01');
  assert.equal(parse('$9 this past Fri.', T).date, '2026-08-28');
});

test('a sentence-ending period does not hide the amount or the date', () => {
  assert.equal(parse('Lunch 20.', T).amount, 20);
  assert.equal(parse('Lunch 20.', T).description, 'Lunch');
  assert.equal(parse('Spent 42.13.', T).amount, 42.13);
  const c = parse('charged $42.13 at CVS on 03/14/2026.', T);
  assert.equal(c.date, '2026-03-14'); assert.equal(c.amount, 42.13); assert.equal(c.description, 'Charged at CVS');
  const d = parse('03.14.2026 dentist 210', T);
  assert.equal(d.date, '2026-03-14'); assert.equal(d.amount, 210);
  assert.equal(parse('42.13 CVS', T).amount, 42.13, 'a decimal amount is still an amount');
});

test('Feb 29 is validated after the year is chosen, and an impossible date is not re-read as money', () => {
  assert.equal(parse('2/29 pharmacy', { today: '2024-01-10' }).date, '2024-02-29');
  assert.equal(parse('2/29 pharmacy', { today: '2025-01-10' }).date, '2024-02-29');
  const r = parse('Feb 29 pharmacy copay', T);
  assert.equal(r.date, null); assert.equal(r.amount, null); assert.equal(r.description, 'Pharmacy copay');
  const bad = parse('parking 2/30 receipt 2/3', T);
  assert.equal(bad.date, '2026-02-03'); assert.equal(bad.amount, null); assert.equal(bad.description, 'Parking receipt');
});

test('matched tokens are removed by position, not by first occurrence', () => {
  const a = parse('20 stamps 20', T);
  assert.equal(a.amount, 20); assert.equal(a.description, '20 stamps');
  const b = parse('12 pills 1', T);
  assert.equal(b.amount, 1); assert.equal(b.description, '12 pills');
});

test('one or three decimals: 12.5 is money, $42.135 and $1.2k are left alone', () => {
  assert.equal(parse('copay 12.5', T).amount, 12.5);
  assert.equal(parse('$4.5 parking', T).amount, 4.5);
  assert.equal(parse('$42.135 odd', T).amount, null);
  assert.equal(parse('$1.2k deposit', T).amount, null);
  assert.equal(parse('$1,200 deposit', T).amount, 1200);
});

test('a four-digit year is only the amount when nothing else could be', () => {
  const a = parse('property tax 2025 3120', T);
  assert.equal(a.amount, 3120);
  assert.equal(parse('paid 2025', T).amount, 2025);
  assert.equal(parse('Sallie Mae 1098-E 2025 interest 640', T).amount, 640);
});

test('content words survive the description cleanup', () => {
  assert.equal(parse('Gas bill 120', T).description, 'Gas bill');
  assert.equal(parse('Vitamin A 12', T).description, 'Vitamin A');
  assert.equal(parse('bought a lamp 30', T).description, 'Lamp');
  assert.equal(parse('water bill 80 paid', T).description, 'Water bill');
});
