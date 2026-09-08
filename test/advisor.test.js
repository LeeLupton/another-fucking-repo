const test = require('node:test');
const assert = require('node:assert/strict');
const Advisor = require('../js/advisor.js');

let seq = 0;
const E = (date, lineId, amount, description, extra) => Object.assign({ id: `e${++seq}`, date, taxYear: Number(date.slice(0, 4)), lineId, amount, description: description || '', note: '', hasReceipt: true, createdAt: `${date}T12:00:00.000Z` }, extra || {});
const monthly = (year, months, lineId, amount, description, day) => months.map((m) => E(`${year}-${String(m).padStart(2, '0')}-${String(day || 5).padStart(2, '0')}`, lineId, amount, description));
const base = { taxYear: 2026, filingStatus: 'single', agi: '', today: '2026-09-20' };
const run = (entries, settings, today) => Advisor.analyze({ entries, settings: Object.assign({}, base, settings || {}), today: today || base.today });

test('a monthly payee is detected, flagged when a month is missing, and projected to year end', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.worship', 200, "Tithe — St. Andrew's");
  const r = run(entries);
  assert.equal(r.recurrences.length, 1);
  const rec = r.recurrences[0];
  assert.equal(rec.cadence, 'monthly');
  assert.equal(rec.typicalAmount, 200);
  assert.equal(rec.nextDate, '2026-09-05');
  assert.equal(rec.status, 'overdue');
  assert.deepEqual(rec.expected, ['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05']);
  const gap = r.recommendations.find((x) => x.id.startsWith('recur:'));
  assert.ok(gap, 'an overdue recurrence becomes a recommendation');
  assert.equal(gap.action.type, 'prefill');
  assert.equal(gap.action.entry.lineId, 'ch.worship');
  assert.equal(gap.action.entry.amount, 200);
  assert.equal(gap.action.entry.date, '2026-09-05');
  assert.equal(r.projection.expectedMore, 800);
  assert.equal(r.projection.projectedTotal, 1600 + 800);
});

test('a recurrence that is on time is "due" near its date and "upcoming" otherwise', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'med.insurance', 118.5, 'Delta Dental premium');
  assert.equal(run(entries, {}, '2026-09-03').recurrences[0].status, 'due');
  assert.equal(run(entries, {}, '2026-08-20').recurrences[0].status, 'upcoming');
  assert.equal(run(entries, {}, '2026-08-20').recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
});

test('semiannual property tax is recognised across years and becomes a bunching candidate', () => {
  const entries = [
    E('2025-01-15', 'tax.real_estate', 6000, 'County treasurer property tax'),
    E('2025-07-15', 'tax.real_estate', 6000, 'County treasurer property tax'),
    E('2026-01-15', 'tax.real_estate', 6000, 'County treasurer property tax'),
    E('2026-07-15', 'tax.real_estate', 6000, 'County treasurer property tax'),
  ].concat(monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'ch.worship', 200, 'Tithe'));
  const r = run(entries);
  const tax = r.recurrences.find((x) => x.lineId === 'tax.real_estate');
  assert.equal(tax.cadence, 'semiannual');
  assert.equal(tax.nextDate, '2027-01-15');
  assert.deepEqual(tax.nextYearEarly, ['2027-01-15']);
  // 12,000 of taxes + 2,400 of projected gifts = 14,400 against a 16,100 standard deduction
  assert.equal(r.projection.projectedTotal, 14400);
  assert.equal(r.projection.itemize, false);
  const plan = r.recommendations.find((x) => x.id === 'plan:bunch:2026');
  assert.ok(plan, 'bunching recommendation present');
  assert.match(plan.body, /Jan 15/);
  assert.match(plan.body, /\+\$6,000/);
});

test('a medical visit without a drive gets a mileage suggestion from the payee history', () => {
  // Patel is a 30-mile round trip; the other drives (10, 6, 8) pull the overall median down to 10, so the two branches differ
  const entries = [
    E('2026-02-11', 'med.doctor', 45, 'Dr. Patel copay'),
    E('2026-02-11', 'med.miles', 30, 'Round trip to Dr. Patel'),
    E('2026-03-20', 'med.doctor', 60, 'Dr. Kim checkup'),
    E('2026-03-20', 'med.miles', 10, 'Round trip to Dr. Kim'),
    E('2026-04-02', 'med.doctor', 45, 'Dr. Patel copay'),
    E('2026-04-02', 'med.miles', 30, 'Round trip to Dr. Patel'),
    E('2026-05-06', 'med.doctor', 40, 'Dr. Lee visit'),
    E('2026-05-06', 'med.miles', 6, 'Round trip to Dr. Lee'),
    E('2026-06-03', 'med.dental', 210, 'Aspen Dental crown'),
    E('2026-07-08', 'med.doctor', 40, 'Dr. Lee visit'),
    E('2026-07-08', 'med.miles', 8, 'Round trip to Dr. Lee'),
    E('2026-08-19', 'med.doctor', 45, 'Dr. Patel copay'),
  ];
  const r = run(entries);
  const dental = r.recommendations.find((x) => x.title.includes('Aspen Dental'));
  assert.ok(dental);
  assert.equal(dental.action.entry.lineId, 'med.miles');
  assert.equal(dental.action.entry.amount, 10, 'overall median when the payee has no mileage history');
  assert.match(dental.body, /Your medical trips are usually about 10 mi\./);
  const patel = r.recommendations.find((x) => x.title.includes('Dr. Patel') && x.title.includes('Aug 19'));
  assert.ok(patel);
  assert.equal(patel.action.entry.amount, 30, 'this payee\'s own median');
  assert.match(patel.body, /You logged 30 mi for this trip before/);
});

test('an amount far above a payee\'s usual is flagged for a second look', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5], 'med.prescriptions', 42, 'CVS pharmacy');
  entries.push(E('2026-06-05', 'med.prescriptions', 4200, 'CVS pharmacy'));
  const r = run(entries);
  const a = r.recommendations.find((x) => x.id.startsWith('anomaly:'));
  assert.ok(a);
  assert.equal(a.action.type, 'edit');
  assert.match(a.title, /\$4,200/);
});

test('far from itemizing: advise stopping the Schedule A receipt chase', () => {
  const r = run([E('2026-03-01', 'ch.org', 100, 'Red Cross')]);
  const stop = r.recommendations.find((x) => x.id === 'plan:stop:2026');
  assert.ok(stop);
  assert.match(stop.body, /business costs and student loan interest/);
});

test('dismissed recommendations stay hidden for thirty days', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.worship', 200, 'Tithe');
  const id = run(entries).recommendations.find((x) => x.id.startsWith('recur:')).id;
  const hidden = run(entries, { advisorDismissed: { [id]: '2026-09-10' } });
  assert.ok(!hidden.recommendations.some((x) => x.id === id));
  assert.ok(hidden.dismissed.some((x) => x.id === id));
  const back = run(entries, { advisorDismissed: { [id]: '2026-07-01' } });
  assert.ok(back.recommendations.some((x) => x.id === id), 'old dismissals expire');
});

test('logging cadence: a long silence relative to habit is pointed out', () => {
  const entries = [];
  for (let i = 0; i < 8; i++) entries.push(E('2026-05-01', 'se.supplies', 20 + i, 'Supplies', { createdAt: `2026-0${5 + Math.floor(i / 4)}-${String(1 + (i % 4) * 3).padStart(2, '0')}T10:00:00.000Z` }));
  const r = run(entries, {}, '2026-08-30');
  const c = r.recommendations.find((x) => x.id.startsWith('habit:cadence'));
  assert.ok(c);
  assert.equal(c.action.type, 'capture');
});

test('the aggregate profile is coarse and carries nothing identifying', () => {
  const entries = monthly(2026, [1, 2, 3], 'ch.worship', 212.34, "Tithe — St. Andrew's").concat([E('2026-01-15', 'tax.real_estate', 3120.44, 'County treasurer', { note: 'parcel 12-345' })]);
  const r = run(entries, { agi: 95000 });
  const a = r.aggregate;
  const text = JSON.stringify(a);
  assert.ok(!/Andrew|treasurer|parcel|3120|212\.34/.test(text));
  assert.equal(a.agiBand, '50k-100k');
  assert.equal(a.sections.charity.total, 600);
  assert.equal(a.sections.taxes.total, 3100);
  assert.equal(a.generated, '2026-09');
  assert.ok(a.excluded.includes('payees'));
});
