const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, formatDate } = require('../js/parse.js');

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

test('relative-date aliases, weekday phrases, and the dateSource the UI explains the date with', () => {
  const d = (s) => { const r = parse(s, T); return [r.date, r.dateSource]; };
  assert.deepEqual(d('lunch 20 day before yesterday'), ['2026-08-31', 'relative']);
  assert.deepEqual(d('lunch 20 yday'), ['2026-09-01', 'relative']);
  assert.deepEqual(d('tithe $300 tonight'), ['2026-09-02', 'relative']);
  assert.deepEqual(d('coffee 4 this morning'), ['2026-09-02', 'relative']);
  assert.deepEqual(d('lunch 20 this past monday'), ['2026-08-31', 'relative']);
  assert.deepEqual(d('lunch 20 on monday'), ['2026-08-31', 'relative']);
  assert.deepEqual(d('lunch 20 last tue'), ['2026-09-01', 'relative']);
  assert.deepEqual(d('$45 tolls 7-3-26'), ['2026-07-03', 'numeric']);
  assert.deepEqual(d('dentist $210 14 Mar'), ['2026-03-14', 'month-name']);
  assert.deepEqual(d('lunch 20 2026-03-04'), ['2026-03-04', 'iso']);
  assert.deepEqual(d('lunch 20'), [null, null]);
  assert.equal(parse('20 bucks lunch', T).amount, 20);
  assert.equal(parse('15 usd parking', T).amount, 15);
  const mls = parse('12 mls to clinic', T);
  assert.equal(mls.miles, 12); assert.equal(mls.amount, null); assert.equal(mls.description, 'Clinic');
});

test('a dollar amount before a month name is not a day, and an impossible month-name date does not eat the money', () => {
  const a = parse('$20 Dec tithe', T);
  assert.equal(a.amount, 20); assert.equal(a.date, null); assert.equal(a.description, 'Dec tithe');
  assert.equal(parse('$5 Sept', T).amount, 5);
  const b = parse('$15 March of Dimes donation', T);
  assert.equal(b.amount, 15); assert.equal(b.date, null); assert.equal(b.description, 'March of Dimes donation');
  assert.equal(parse('paid 40 Aug', T).amount, 40);
  assert.equal(parse('Dr. May 40 copay', T).amount, 40);
  // the day-first and impossible-date readings that must not move
  assert.equal(parse('5 Sept', T).date, '2026-09-05');
  assert.equal(parse('dentist $210 14 Mar', T).date, '2026-03-14');
  assert.equal(parse('dentist $210 on the 14th of March', T).date, '2026-03-14');
  const feb = parse('Feb 29 pharmacy copay', T);
  assert.equal(feb.date, null); assert.equal(feb.amount, null);
  assert.equal(parse('Feb 30 pharmacy 40', T).amount, 40);
});

test('a year that names a bill period is not the amount', () => {
  assert.equal(parse('Dec 2025 property tax', T).amount, null);
  assert.equal(parse('Dec 2025 property tax', T).description, 'Dec 2025 property tax');
  assert.equal(parse('tithe March 2026', T).amount, null);
  // a year with nothing else to go on is still the amount
  assert.equal(parse('paid 2025', T).amount, 2025);
  assert.equal(parse('property tax 2025 3120', T).amount, 3120);
  const dated = parse('Dec 14 2025 property tax 3120', T);
  assert.equal(dated.date, '2025-12-14'); assert.equal(dated.amount, 3120);
});

test('a measurement is a quantity, not a dollar amount', () => {
  const a = parse('physical therapy 45 min 60', T);
  assert.equal(a.amount, 60); assert.equal(a.description, 'Physical therapy 45 min');
  assert.equal(parse('2 hrs parking 12', T).amount, 12);
  const b = parse('30 minute massage 80', T);
  assert.equal(b.amount, 80); assert.equal(b.description, '30 minute massage');
  assert.equal(parse('5 lb bag 20', T).amount, 20);
  assert.equal(parse('18 km to clinic', T).amount, null);
  assert.equal(parse('$45 min session', T).amount, 45, 'a typed dollar sign still wins');
});

test('week and month relative phrases', () => {
  const a = parse('lunch 20 2 weeks ago', T);
  assert.equal(a.date, '2026-08-19'); assert.equal(a.amount, 20); assert.equal(a.description, 'Lunch');
  assert.equal(parse('lunch 20 two days ago', T).date, '2026-08-31');
  assert.equal(parse('lunch 20 a week ago', T).date, '2026-08-26');
  assert.equal(parse('lunch 20 last week', T).date, '2026-08-26');
  assert.equal(parse('lunch 20 last month', T).date, '2026-08-02');
  // a month back from the 31st lands on the last day of the shorter month
  assert.equal(parse('lunch 20 last month', { today: '2026-03-31', defaultYear: 2026 }).date, '2026-02-28');
  assert.equal(parse('$12 parking 3 days ago', T).date, '2026-08-30');
  const rent = parse("last month's rent 1200", T);
  assert.equal(rent.date, '2026-08-02'); assert.equal(rent.amount, 1200); assert.equal(rent.description, 'Rent');
});

test('weekday phrases survive punctuation and possessives', () => {
  const a = parse('lunch 20 last Tuesday, client meeting', T);
  assert.equal(a.date, '2026-09-01');
  assert.doesNotMatch(a.description, /Tuesday/);
  const b = parse("yesterday's lunch 20", T);
  assert.equal(b.date, '2026-09-01'); assert.equal(b.description, 'Lunch');
  assert.equal(parse("lunch 20 last Friday's", T).date, '2026-08-28');
  assert.equal(parse('$9 this past Fri.', T).date, '2026-08-28');
  assert.equal(parse('lunch 20 last tue', T).date, '2026-09-01');
});

test('"on <weekday>" written on that weekday means today, while "last <weekday>" means the week before', () => {
  assert.equal(parse('$300 tithe on Sunday', { today: '2026-01-04', defaultYear: 2026 }).date, '2026-01-04');
  assert.equal(parse('$300 tithe on Sunday', { today: '2026-09-06', defaultYear: 2026 }).date, '2026-09-06');
  assert.equal(parse('$300 tithe last Sunday', { today: '2026-01-04', defaultYear: 2026 }).date, '2025-12-28');
  assert.equal(parse('lunch 20 last wednesday', T).date, '2026-08-26');
  assert.equal(parse('lunch 20 on monday', T).date, '2026-08-31');
});

test('a typed minus is a refund, not an expense', () => {
  const a = parse('-$20 refund from CVS', T);
  assert.equal(a.amount, -20); assert.equal(a.description, 'Refund from CVS');
  assert.equal(parse('refund -$20 CVS', T).amount, -20);
  assert.equal(parse('$20 CVS', T).amount, 20);
  assert.equal(parse('lunch - $20', T).amount, 20, 'a dash between words is a separator');
  assert.equal(parse('$1,250.00 property tax', T).amount, 1250);
  assert.equal(parse('$4.5 parking', T).amount, 4.5);
  assert.equal(parse('property tax 2025 3120', T).amount, 3120);
});

test('cents written without a leading zero', () => {
  const a = parse('$.50 parking meter', T);
  assert.equal(a.amount, 0.5); assert.equal(a.description, 'Parking meter');
  assert.equal(parse('$.99 pen', T).amount, 0.99);
  assert.equal(parse('$42.135 odd', T).amount, null);
  assert.equal(parse('$1.2k deposit', T).amount, null);
  assert.equal(parse('copay 12.5', T).amount, 12.5);
});

test('a long paste parses quickly', () => {
  // parse() runs on every keystroke, so a pasted column of numbers must not scan the whole
  // remainder for each one. The bound is generous: this takes about 30 ms, and seconds before.
  const started = Date.now();
  assert.equal(parse('1 '.repeat(20000), T).amount, 1);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `a 40 KB paste took ${elapsed} ms`);
  // the shortened look-ahead still sees the word after the number
  assert.equal(parse('20 stamps 20', T).amount, 20);
  assert.equal(parse('4 bags', T).amount, null);
  assert.equal(parse('12 pills 1', T).amount, 1);
});

test('a leading donated or gave survives a following filler', () => {
  assert.equal(parse('donated to goodwill 50', T).description, 'Donated goodwill');
  assert.equal(parse('gave to church 100', T).description, 'Gave church');
  assert.equal(parse('donated 50', T).description, 'Donated');
  assert.equal(parse('donated 4 bags of clothes to goodwill 12/28', T).description, 'Donated 4 bags of clothes to goodwill');
});

test('a brand the user capitalised is left alone', () => {
  assert.equal(parse('iPhone case 30', T).description, 'iPhone case');
  assert.equal(parse('eBay printer ink 22', T).description, 'eBay printer ink');
  assert.equal(parse('lunch 20', T).description, 'Lunch');
  assert.equal(parse('Vitamin A 12', T).description, 'Vitamin A');
});

test('formatDate keeps its wording and its empty-input guard', () => {
  assert.equal(formatDate('2025-03-09', false), 'Mar 9');
  assert.equal(formatDate('2025-03-09'), 'Mar 9, 2025');
  assert.equal(formatDate('2024-02-29'), 'Feb 29, 2024');
  assert.equal(formatDate('2026-01-01', false), 'Jan 1');
  assert.equal(formatDate(''), '');
  assert.equal(formatDate(null), '');
});
