const test = require('node:test');
const assert = require('node:assert/strict');
const Advisor = require('../js/advisor.js');

let seq = 0;
const E = (date, lineId, amount, description, extra) => Object.assign({ id: `a${++seq}`, date, taxYear: Number(date.slice(0, 4)), lineId, amount, description: description || '', note: '', hasReceipt: true, createdAt: `${date}T12:00:00.000Z` }, extra || {});
const monthly = (year, months, lineId, amount, description, day) => months.map((m) => E(`${year}-${String(m).padStart(2, '0')}-${String(day || 5).padStart(2, '0')}`, lineId, amount, description));
const base = { taxYear: 2026, filingStatus: 'single', agi: '', today: '2026-09-20' };
const run = (entries, settings, today) => Advisor.analyze({ entries, settings: Object.assign({}, base, settings || {}), today: today || base.today });

test('a payee that stopped is lapsed: shown in the table, projected nowhere, never nagged about', () => {
  const entries = monthly(2025, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.worship', 200, 'Old church');
  const r = run(entries);
  assert.equal(r.recurrences.length, 1);
  assert.equal(r.recurrences[0].status, 'lapsed');
  assert.equal(r.projection.expectedMore, 0, 'nothing is projected for a lapsed payee');
  assert.equal(r.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
});

test('dismissing "if it stopped, dismiss this" also stops the projection for that payee', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.worship', 200, 'Tithe');
  const first = run(entries);
  assert.equal(first.projection.expectedMore, 800);
  const id = first.recommendations.find((x) => x.id.startsWith('recur:')).id;
  const muted = run(entries, { advisorDismissed: { [id]: '2026-09-18' } });
  assert.equal(muted.projection.expectedMore, 0);
  assert.ok(muted.dismissed.some((x) => x.id === id), 'it still shows under dismissed');
});

test('an expected occurrence logged under another spelling counts as done', () => {
  const entries = monthly(2026, [1, 2, 3, 4, 5, 6, 7], 'ch.worship', 200, "Tithe — St. Andrew's");
  entries.push(E('2026-08-06', 'ch.worship', 200, 'St Andrews tithe Aug'));
  const r = run(entries);
  const rec = r.recurrences.find((x) => /St\. Andrew/.test(x.description));
  assert.ok(rec);
  assert.equal(rec.nextDate, '2026-09-05', 'August was satisfied by the other spelling');
  assert.ok(!rec.expected.includes('2026-08-05'));
  assert.equal(r.projection.expectedMore, 800, 'no double counting of August');
});

test('state estimated payments follow the IRS calendar', () => {
  const dates = ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15', '2026-04-15', '2026-06-15', '2026-09-15'];
  const entries = dates.map((d) => E(d, 'tax.state_income', 1500, 'NC DOR estimated payment'));
  entries.push(E('2026-12-31', 'int.mortgage', 8000, 'Mortgage interest')); // close enough to itemizing that the plan lists what to prepay
  const r = run(entries, { agi: 120000 }, '2026-09-20');
  const rec = r.recurrences[0];
  assert.equal(rec.cadence, 'estimated');
  assert.equal(rec.nextDate, '2027-01-15');
  assert.equal(rec.status, 'upcoming');
  assert.deepEqual(rec.expected, []);
  assert.deepEqual(rec.nextYearEarly, ['2027-01-15', '2027-04-15']);
  const plan = r.recommendations.find((x) => x.id.startsWith('plan:'));
  assert.ok(plan && /Jan 15/.test(plan.body), plan && plan.body);
});

test('every-four-weeks payees are recognised; month-end payees stay monthly; anchors never drift', () => {
  const four = ['01-02', '01-30', '02-27', '03-27', '04-24', '05-22', '06-19', '07-17'].map((md) => E(`2026-${md}`, 'med.insurance', 90, 'Dental plan'));
  const r4 = run(four, {}, '2026-08-20');
  assert.equal(r4.recurrences[0].cadence, 'fourweekly');
  assert.deepEqual(r4.recurrences[0].expected, ['2026-08-14', '2026-09-11', '2026-10-09', '2026-11-06', '2026-12-04']);
  const firsts = monthly(2026, [1, 2, 3, 4], 'med.insurance', 90, 'Vision plan', 1);
  assert.equal(run(firsts, {}, '2026-05-02').recurrences[0].cadence, 'monthly');
  const ends = ['01-31', '02-28', '03-31', '04-30', '05-31', '06-30', '07-31', '08-31'].map((md) => E(`2026-${md}`, 'ch.worship', 100, 'Month-end gift'));
  const rEnd = run(ends, {}, '2026-09-20');
  assert.equal(rEnd.recurrences[0].cadence, 'monthly');
  assert.deepEqual(rEnd.recurrences[0].expected, ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
});

test('undescribed entries need a much clearer outlier before they are flagged', () => {
  const five = [10, 10, 10, 10, 60].map((mi, i) => E(`2026-0${i + 1}-10`, 'med.miles', mi, ''));
  assert.equal(run(five).recommendations.filter((x) => x.id.startsWith('anomaly:')).length, 0);
  const six = [10, 10, 10, 10, 10, 70].map((mi, i) => E(`2026-0${i + 1}-10`, 'med.miles', mi, ''));
  const a = run(six).recommendations.find((x) => x.id.startsWith('anomaly:'));
  assert.ok(a);
  assert.match(a.because, /undescribed entries/);
});

test('the stop-chasing-receipts plan is never issued while medical costs wait on AGI', () => {
  const entries = [E('2026-02-01', 'med.doctor', 5000, 'Dr Patel'), E('2026-03-01', 'ch.org', 100, 'Red Cross')];
  const r = run(entries, { agi: '' });
  assert.ok(!r.recommendations.some((x) => x.id.startsWith('plan:stop')));
  const agiRec = r.recommendations.find((x) => x.id.startsWith('plan:agi'));
  assert.ok(agiRec && agiRec.action.type === 'settings');
  const withAgi = run(entries, { agi: 80000 });
  assert.ok(!withAgi.recommendations.some((x) => x.id.startsWith('plan:agi')));
});

test('a closed year gets a past-tense summary and no projection', () => {
  const entries = monthly(2025, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'ch.worship', 200, 'Tithe');
  const r = run(entries, { taxYear: 2025 }, '2026-09-20');
  assert.equal(r.projection.closed, true);
  assert.equal(r.projection.expectedMore, 0);
  const plan = r.recommendations.find((x) => x.id.startsWith('plan:'));
  assert.ok(plan && /^plan:closed/.test(plan.id));
  assert.match(plan.title, /2025/);
});

test('habits never report a negative gap, and the aggregate hides age and blindness', () => {
  const entries = [E('2026-09-19', 'ch.org', 50, 'Food bank', { createdAt: '2026-09-21T01:00:00.000Z' })];
  const r = run(entries, { age65: true, blind: true }, '2026-09-20');
  assert.equal(r.habits.daysSinceLast, 0);
  assert.equal(r.aggregate.standardDeduction, 16100);
  assert.equal(r.aggregate.hasAdditionalStandardDeduction, true);
  assert.ok(r.aggregate.excluded.includes('age and disability flags'));
});

test('the open list is capped after dismissed items are removed', () => {
  const entries = [];
  for (let k = 0; k < 15; k++) entries.push(...monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.org', 20 + k, `Charity ${String.fromCharCode(65 + k)}`));
  const r = run(entries);
  assert.equal(r.recommendations.length, 12);
  const dismissedAt = {};
  for (const x of r.recommendations.slice(0, 5)) dismissedAt[x.id] = '2026-09-18';
  const r2 = run(entries, { advisorDismissed: dismissedAt });
  assert.ok(r2.recommendations.length > 7, `dismissing five brings the next ones forward (${r2.recommendations.length} shown)`);
  assert.equal(r2.recommendations.length + r2.dismissed.length, Math.min(12, 16 - 5) + 5, '16 recommendations exist in total: 15 payees and one plan');
  assert.equal(r2.dismissed.length, 5);
});
