const test = require('node:test');
const assert = require('node:assert/strict');
const Advisor = require('../js/advisor.js');
const Rules = require('../js/rules.js');

let seq = 0;
const E = (date, lineId, amount, description, extra) => Object.assign({ id: `a${++seq}`, date, taxYear: Number(date.slice(0, 4)), lineId, amount, description: description || '', note: '', hasReceipt: true, createdAt: `${date}T12:00:00.000Z` }, extra || {});
const monthly = (year, months, lineId, amount, description, day) => months.map((m) => E(`${year}-${String(m).padStart(2, '0')}-${String(day || 5).padStart(2, '0')}`, lineId, amount, description));
const base = { taxYear: 2026, filingStatus: 'single', agi: '', today: '2026-09-20' };
const run = (entries, settings, today) => Advisor.analyze({ entries, settings: Object.assign({}, base, settings || {}), today: today || base.today });
// a missing recommendation should say which one was missing, not fail on a property of undefined
const mustFind = (list, pred, label) => { const x = list.find(pred); assert.ok(x, label); return x; };

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
  const id = mustFind(first.recommendations, (x) => x.id.startsWith('recur:'), 'a recurrence recommendation').id;
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

test('a closed year decided by cents says so in the title, where whole dollars would read as $0', () => {
  const mortgage = (amount) => [E('2025-03-01', 'int.mortgage', amount, 'Mortgage interest')];
  const short = run(mortgage(15749.6), { taxYear: 2025 }, '2026-09-20'); // $15,750 standard deduction, 40c under it
  const shortPlan = mustFind(short.recommendations, (x) => x.id.startsWith('plan:closed'), 'the closed-year plan');
  assert.equal(short.projection.gap, 0.4);
  assert.equal(shortPlan.title, '2025 fell $0.40 short of itemizing');
  assert.match(shortPlan.body, /\$15,750 counted against a \$15,750 standard deduction/, 'the body prints totals, so it stays on whole dollars');
  const won = run(mortgage(15750.25), { taxYear: 2025 }, '2026-09-20');
  const wonPlan = mustFind(won.recommendations, (x) => x.id.startsWith('plan:closed'), 'the closed-year plan');
  assert.equal(wonPlan.kind, 'good');
  assert.equal(wonPlan.title, '2025: itemizing won by $0.25');
});

test('habits never report a negative gap, and the aggregate hides age and blindness', () => {
  const entries = [E('2026-09-19', 'ch.org', 50, 'Food bank', { createdAt: '2026-09-21T01:00:00.000Z' })];
  const r = run(entries, { age65: true, blind: true }, '2026-09-20');
  assert.equal(r.habits.daysSinceLast, 0);
  assert.equal(r.aggregate.standardDeduction, 16100);
  assert.ok(r.aggregate.excluded.includes('age and disability flags'));
  const withFlags = run(entries, { age65: true, blind: true, spouseAge65: true }, '2026-09-20').aggregate;
  const without = run(entries, {}, '2026-09-20').aggregate;
  assert.deepEqual(withFlags, without, 'the profile is identical with and without the flags');
  assert.ok(!('hasAdditionalStandardDeduction' in withFlags));
  assert.ok(!Object.keys(withFlags).some((k) => /additional|age65|blind/i.test(k)));
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

test('a line that usually comes with another gets a prefill for the missing partner; drives are never paired', () => {
  const entries = [];
  for (const d of ['2026-02-01', '2026-03-01', '2026-04-01']) entries.push(E(d, 'se.travel', 300, 'Client site trip'), E(d, 'se.meals', 60, 'Dinner on the road'));
  entries.push(E('2026-05-01', 'se.travel', 300, 'Client site trip'));
  const r = run(entries);
  const pair = r.recommendations.find((x) => x.id.startsWith('pair:'));
  assert.ok(pair, 'a co-occurrence recommendation');
  assert.equal(pair.title, 'Travel on May 1 usually comes with Meals');
  assert.equal(pair.action.type, 'prefill');
  assert.deepEqual(pair.action.entry, { description: '', lineId: 'se.meals', amount: 60, date: '2026-05-01' });
  assert.match(pair.body, /On 3 dates/);
  assert.ok(!r.recommendations.some((x) => x.id.startsWith('pair:') && x.action.entry.lineId === 'se.travel'), 'meals never went without travel, so no prefill the other way');
  const visits = [];
  for (const d of ['2026-02-11', '2026-04-02', '2026-06-03']) visits.push(E(d, 'med.doctor', 45, 'Dr. Patel copay'), E(d, 'med.miles', 14, 'Round trip to Dr. Patel'));
  visits.push(E('2026-08-19', 'med.doctor', 45, 'Dr. Patel copay'));
  const v = run(visits);
  assert.ok(!v.recommendations.some((x) => x.id.startsWith('pair:')), 'the mileage rule owns doctor + drive');
  assert.ok(v.recommendations.some((x) => x.id.startsWith('miles:')));
});

test('thin receipts in a section become a habit recommendation that opens the ledger filter', () => {
  const entries = [E('2026-03-01', 'se.supplies', 80, 'Uline boxes', { hasReceipt: false }), E('2026-04-01', 'se.supplies', 45, 'Uline tape', { hasReceipt: false }), E('2026-05-01', 'se.supplies', 120, 'Uline labels', { hasReceipt: false }), E('2026-05-02', 'ch.worship', 100, 'Tithe')];
  const r = run(entries);
  const habit = r.recommendations.find((x) => x.id === 'habit:receipts:selfemp:2026');
  assert.ok(habit, 'the weakest section is named');
  assert.equal(habit.title, 'Receipts are thin for Self-Employed Expenses: 0 of 3');
  assert.match(habit.body, /examiner/);
  assert.deepEqual(habit.action, { type: 'ledger', filter: 'noreceipt' });
  const fine = run([E('2026-03-01', 'se.supplies', 80, 'Uline boxes'), E('2026-04-01', 'se.supplies', 45, 'Uline tape'), E('2026-05-01', 'se.supplies', 120, 'Uline labels')]);
  assert.ok(!fine.recommendations.some((x) => x.id.startsWith('habit:receipts:')), 'all receipts present: nothing to say');
});

test('the year plan: on pace to itemize, a gap planning can close, or stop chasing Schedule A receipts', () => {
  const pace = run([E('2026-01-05', 'tax.real_estate', 9000, 'County tax'), E('2026-01-06', 'int.mortgage', 12000, 'Mortgage interest')]);
  const onPace = pace.recommendations.find((x) => x.id === 'plan:itemize:2026');
  assert.ok(onPace); assert.equal(onPace.kind, 'good'); assert.match(onPace.title, /^On pace to itemize/); assert.equal(pace.projection.itemize, true);
  const close = run([E('2026-01-06', 'int.mortgage', 13000, 'Mortgage interest')]);
  const c = close.recommendations.find((x) => x.id === 'plan:close:2026');
  assert.ok(c, 'a $3,100 gap is under 30% of the standard deduction'); assert.match(c.title, /\$3,100 short of itemizing/);
  assert.ok(!close.recommendations.some((x) => x.id === 'plan:stop:2026'));
  const stop = run([E('2026-01-06', 'int.mortgage', 10000, 'Mortgage interest')]);
  const s = stop.recommendations.find((x) => x.id === 'plan:stop:2026');
  assert.ok(s, 'a $6,100 gap is past the 30% line'); assert.match(s.title, /stop chasing Schedule A receipts/); assert.match(s.body, /\$6,100 short/);
  assert.ok(!stop.recommendations.some((x) => x.id === 'plan:close:2026' || x.id === 'plan:itemize:2026'));
});

test('weekly, biweekly, quarterly and yearly payees are recognised; same-day entries are one occurrence; one miss is tolerated after five', () => {
  const sundays = [];
  for (let i = 0; i < 8; i++) { const d = new Date(2026, 0, 4 + 7 * i); sundays.push(E(`2026-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 'ch.worship', 50, 'Sunday offering')); }
  const weekly = run(sundays, {}, '2026-03-05').recurrences.find((x) => x.description === 'Sunday offering');
  assert.ok(weekly); assert.equal(weekly.cadence, 'weekly'); assert.equal(weekly.perYear, 52); assert.equal(weekly.nextDate, '2026-03-01'); assert.equal(weekly.status, 'overdue'); assert.equal(weekly.typicalAmount, 50);
  const biweekly = [];
  for (let i = 0; i < 6; i++) { const d = new Date(2026, 0, 2 + 14 * i); biweekly.push(E(`2026-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 'ch.org', 25, 'Food bank payroll gift')); }
  assert.equal(mustFind(run(biweekly).recurrences, (x) => x.description === 'Food bank payroll gift', 'the biweekly payee').cadence, 'biweekly');
  const quarterly = ['2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'].map((d) => E(d, 'med.insurance', 900, 'Blue Cross premium'));
  const q = run(quarterly).recurrences.find((x) => x.description === 'Blue Cross premium');
  assert.ok(q); assert.equal(q.cadence, 'quarterly'); assert.equal(q.perYear, 4); assert.equal(q.nextDate, '2026-10-01'); assert.equal(q.status, 'due');
  const yearly = ['2025-03-10', '2026-03-10'].map((d) => E(d, 'tax.personal_property', 320, 'Vehicle tax'));
  const y = run(yearly).recurrences.find((x) => x.description === 'Vehicle tax');
  assert.ok(y); assert.equal(y.cadence, 'annual'); assert.equal(y.nextDate, '2027-03-10'); assert.equal(y.status, 'upcoming');
  const split = [];
  for (const m of [1, 2, 3, 4, 5, 6]) split.push(E(`2026-${String(m).padStart(2, '0')}-05`, 'ch.worship', 30, 'St. Mark'), E(`2026-${String(m).padStart(2, '0')}-05`, 'ch.worship', 20, 'St. Mark'));
  const merged = run(split).recurrences.find((x) => x.description === 'St. Mark');
  assert.ok(merged); assert.equal(merged.cadence, 'monthly'); assert.equal(merged.count, 6); assert.equal(merged.typicalAmount, 50);
  const tolerant = run(monthly(2026, [1, 2, 3, 5, 6], 'se.utilities', 80, 'Verizon')).recurrences.find((x) => x.description === 'Verizon');
  assert.ok(tolerant, 'one skipped month after five occurrences is still monthly'); assert.equal(tolerant.cadence, 'monthly');
  assert.equal(run(monthly(2026, [1, 2, 4], 'se.utilities', 80, 'Verizon')).recurrences.length, 0, 'three occurrences with a gap are no pattern');
});

test('an estimated payment made early does not re-expect its own deadline', () => {
  const early = ['2026-01-14', '2026-04-13', '2026-06-12', '2026-09-10'].map((d) => E(d, 'tax.state_income', 900, 'NC DOR estimated payment'));
  const r = run(early, {}, '2026-09-20');
  assert.equal(r.recurrences[0].cadence, 'estimated');
  assert.equal(r.recurrences[0].nextDate, '2027-01-15');
  assert.equal(r.recurrences[0].status, 'upcoming');
  assert.deepEqual(r.recurrences[0].expected, []);
  assert.equal(r.projection.expectedMore, 0);
  assert.equal(r.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
  // the Q4 estimate paid by Dec 31, which the year-end checklist itself asks for, satisfies the Jan 15 deadline
  const q4 = ['2026-04-15', '2026-06-15', '2026-09-15', '2026-12-31'].map((d) => E(d, 'tax.state_income', 900, 'NC DOR estimated payment'));
  const r2 = run(q4, { taxYear: 2027 }, '2027-01-20');
  assert.equal(r2.recurrences[0].nextDate, '2027-04-15');
  assert.equal(r2.recurrences[0].status, 'upcoming');
  assert.deepEqual(r2.recurrences[0].expected, ['2027-04-15', '2027-06-15', '2027-09-15']);
  assert.equal(r2.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
});

test('quarterly property tax near the IRS deadlines keeps its own calendar', () => {
  const nyc = ['2025-07-01', '2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'].map((d) => E(d, 'tax.real_estate', 2200, 'NYC Dept of Finance property tax'));
  const rec = run(nyc, {}, '2026-09-20').recurrences[0];
  assert.equal(rec.cadence, 'quarterly');
  assert.equal(rec.cadenceLabel, 'quarterly');
  assert.equal(rec.nextDate, '2026-10-01');
  assert.equal(rec.status, 'due');
  assert.deepEqual(rec.nextYearEarly, ['2027-01-01', '2027-04-01']);
});

test('a payee with a cadence of its own never props up another one', () => {
  const respelled = monthly(2026, [1, 2, 3, 4], 'ch.worship', 200, "Tithe — St. Andrew's").concat(monthly(2026, [5, 6, 7, 8], 'ch.worship', 200, 'St Andrews tithe', 6));
  const r = run(respelled, {}, '2026-09-20');
  assert.equal(r.recommendations.filter((x) => x.id.startsWith('recur:')).length, 1);
  assert.equal(r.projection.expectedMore, 800);
  assert.equal(mustFind(r.recurrences, (x) => /St\. Andrew/.test(x.description), 'the St. Andrew recurrence').status, 'lapsed');
  const masked = monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.org', 50, 'Red Cross', 1).concat(monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'ch.org', 50, 'Food Bank', 3));
  const m = run(masked, {}, '2026-09-20');
  const red = m.recurrences.find((x) => x.description === 'Red Cross');
  assert.equal(red.status, 'overdue');
  assert.equal(red.nextDate, '2026-09-01');
  assert.equal(m.recommendations.filter((x) => x.id.startsWith('recur:')).length, 1);
  assert.equal(m.projection.expectedMore, 350);
  const keptAlive = monthly(2026, [1, 2, 3, 4], 'ch.org', 50, 'Old church').concat(monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'ch.org', 50, 'Food Bank', 3));
  const k = run(keptAlive, {}, '2026-09-20');
  assert.equal(mustFind(k.recurrences, (x) => x.description === 'Old church', 'the Old church recurrence').status, 'lapsed');
  assert.equal(k.projection.expectedMore, 150);
});

test('a weekly payee survives a missed statement cycle before it is called stopped', () => {
  const sundays = [];
  for (let i = 0; i < 35; i++) { const d = new Date(2026, 0, 4 + 7 * i); sundays.push(E(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 'ch.worship', 50, 'Sunday offering')); }
  const soon = run(sundays, {}, '2026-09-25');
  assert.equal(soon.recurrences[0].status, 'overdue');
  assert.equal(soon.projection.expectedMore, 850);
  assert.equal(soon.recommendations.filter((x) => x.id.startsWith('recur:')).length, 1);
  const later = run(sundays, {}, '2026-11-15');
  assert.equal(later.recurrences[0].status, 'lapsed');
  assert.equal(later.projection.expectedMore, 0);
  assert.equal(later.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
});

test('dismissing a recurrence keeps it quiet until it lapses, however long its period is', () => {
  const pledge = ['2025-09-10', '2025-12-10', '2026-03-10'].map((d) => E(d, 'ch.worship', 300, 'Quarterly pledge'));
  const first = run(pledge, {}, '2026-07-01');
  assert.equal(first.recurrences[0].cadence, 'quarterly');
  assert.equal(first.projection.expectedMore, 900);
  const id = mustFind(first.recommendations, (x) => x.id.startsWith('recur:'), 'a recurrence recommendation').id;
  const later = run(pledge, { advisorDismissed: { [id]: '2026-07-01' } }, '2026-09-01');
  assert.equal(later.recurrences[0].muted, true);
  assert.equal(later.projection.expectedMore, 0);
  assert.equal(later.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
  const stopped = run(pledge, { advisorDismissed: { [id]: '2026-07-01' } }, '2026-12-01');
  assert.equal(stopped.recurrences[0].status, 'lapsed');
  assert.equal(stopped.projection.expectedMore, 0);
  assert.equal(stopped.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0);
  const vehicle = ['2024-03-10', '2025-03-10'].map((d) => E(d, 'tax.personal_property', 320, 'Vehicle tax'));
  const vid = mustFind(run(vehicle, {}, '2026-05-01').recommendations, (x) => x.id.startsWith('recur:'), 'the vehicle tax recommendation').id;
  for (const day of ['2026-09-01', '2026-12-15']) {
    const v = run(vehicle, { advisorDismissed: { [vid]: '2026-05-01' } }, day);
    assert.equal(v.projection.expectedMore, 0, day);
    assert.equal(v.recommendations.filter((x) => x.id.startsWith('recur:')).length, 0, day);
  }
});

test('entries per week for a closed year is measured to Dec 31, not to today', () => {
  const entries = [];
  for (let m = 1; m <= 12; m++) for (const d of [3, 10, 17, 24]) entries.push(E(`2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 'ch.org', 25, 'Food bank'));
  for (const day of ['2025-12-31', '2026-09-20', '2027-09-20']) {
    const r = run(entries, { taxYear: 2025 }, day);
    assert.equal(r.habits.entriesPerWeek, 0.9, day);
    assert.equal(r.aggregate.entriesPerWeek, 0.9, day);
  }
});

test('a suggested drive is rounded to a tenth of a mile and described the way the ledger shows it', () => {
  const visits = [E('2026-02-03', 'med.doctor', 40, 'Dr Patel'), E('2026-02-03', 'med.miles', 12.3, 'Round trip — Dr Patel'), E('2026-04-07', 'med.doctor', 40, 'Dr Patel'), E('2026-04-07', 'med.miles', 12.6, 'Round trip — Dr Patel'), E('2026-08-11', 'med.doctor', 40, 'Dr Patel')];
  const two = run(visits, { agi: 60000 }, '2026-09-07').recommendations.find((x) => x.id.startsWith('miles:'));
  assert.equal(two.action.entry.amount, 12.5);
  assert.match(two.body, /12\.5 mi/);
  assert.ok(!/You logged/.test(two.body), 'a median of two different drives was never logged');
  const one = run(visits.filter((e) => e.amount !== 12.6), { agi: 60000 }, '2026-09-07').recommendations.find((x) => x.id === `miles:${visits[4].id}`);
  assert.equal(one.action.entry.amount, 12.3);
  assert.match(one.body, /You logged 12\.3 mi for this trip before/);
});

test('the suggested drive quotes the mileage rate for its own date, not the January one', () => {
  const before = [E('2026-01-05', 'med.miles', 24, 'Round trip — Dr Patel'), E('2026-01-05', 'med.doctor', 100, 'Dr Patel'), E('2026-02-10', 'med.doctor', 100, 'Dr Patel')];
  const early = mustFind(run(before, { agi: 60000 }, '2026-09-20').recommendations, (x) => x.id.startsWith('miles:'), 'the drive to add');
  assert.match(early.body, /At 20\.5¢\/mile /, 'a February drive is worth the January rate');
  const after = before.slice(0, 2).concat([E('2026-08-10', 'med.doctor', 100, 'Dr Patel')]);
  const late = mustFind(run(after, { agi: 60000 }, '2026-09-20').recommendations, (x) => x.id.startsWith('miles:'), 'the drive to add');
  assert.match(late.body, /At 23\.5¢\/mile /, 'the rate changed on July 1, 2026, and the drive is in August');
});

test('an entry filed to this tax year but dated in the next one carries its year on every card', () => {
  const pair = [];
  for (const d of ['2026-02-01', '2026-03-01', '2026-04-01']) pair.push(E(d, 'ch.worship', 200, 'Tithe'), E(d, 'ch.org', 40, 'Food bank'));
  pair.push(Object.assign(E('2027-01-03', 'ch.worship', 200, 'Tithe'), { taxYear: 2026 }));
  const p = mustFind(run(pair, {}, '2026-12-20').recommendations, (x) => x.id.startsWith('pair:'), 'the pair suggestion');
  assert.equal(p.title, 'Place of Worship on Jan 3, 2027 usually comes with Charity Organization');
  const med = [];
  for (const d of ['2026-02-01', '2026-03-01', '2026-04-01']) med.push(E(d, 'med.doctor', 100, 'Dr Patel'), E(d, 'med.miles', 12, 'Round trip — Dr Patel'));
  med.push(Object.assign(E('2027-01-03', 'med.doctor', 100, 'Dr Patel'), { taxYear: 2026 }));
  const m = mustFind(run(med, { agi: 60000 }, '2026-12-20').recommendations, (x) => x.id.startsWith('miles:'), 'the drive to add');
  assert.equal(m.title, 'Add the drive to Dr Patel on Jan 3, 2027?');
});

test('bunching is priced through the tax engine, so a capped or floored payment is never suggested', () => {
  const capped = [E('2023-01-15', 'tax.real_estate', 6000, 'County property tax'), E('2023-07-15', 'tax.real_estate', 6000, 'County property tax'), E('2024-01-15', 'tax.real_estate', 6000, 'County property tax'), E('2024-07-15', 'tax.real_estate', 6000, 'County property tax'), E('2024-02-01', 'int.mortgage', 3500, 'Mortgage interest')];
  const c = run(capped, { taxYear: 2024, agi: 120000 }, '2024-09-20');
  assert.ok(!c.recommendations.some((x) => x.id === 'plan:bunch:2024'), 'the SALT cap already swallows the next payment');
  const cPlan = c.recommendations.find((x) => x.id.startsWith('plan:'));
  assert.equal(cPlan.id, 'plan:close:2024');
  assert.ok(!/\+\$6,000/.test(cPlan.body));
  assert.ok(!/state estimated payment/.test(cPlan.body), 'SALT is at the cap, so a state payment buys nothing');
  const floored = [];
  for (const m of [1, 4, 7, 10]) floored.push(E(`2025-${String(m).padStart(2, '0')}-05`, 'med.insurance', 900, 'Blue Cross premium'));
  for (const m of [1, 4, 7]) floored.push(E(`2026-${String(m).padStart(2, '0')}-05`, 'med.insurance', 900, 'Blue Cross premium'));
  floored.push(E('2026-02-01', 'int.mortgage', 15400, 'Mortgage interest'));
  const f = run(floored, { agi: 100000 }, '2026-11-20');
  assert.ok(!f.recommendations.some((x) => x.id === 'plan:bunch:2026'), 'the premium stays under the medical floor');
  assert.ok(!/[Ee]lective dental or vision work/.test(mustFind(f.recommendations, (x) => x.id.startsWith('plan:'), 'a plan recommendation').body));
  const under = [E('2023-01-15', 'tax.real_estate', 3000, 'County property tax'), E('2023-07-15', 'tax.real_estate', 3000, 'County property tax'), E('2025-01-15', 'tax.real_estate', 3000, 'County property tax'), E('2025-07-15', 'tax.real_estate', 3000, 'County property tax'), E('2026-01-15', 'tax.real_estate', 3000, 'County property tax'), E('2026-07-15', 'tax.real_estate', 3000, 'County property tax'), E('2026-02-01', 'int.mortgage', 9000, 'Mortgage interest')];
  const u = run(under, { agi: 90000 }, '2026-09-20').recommendations.find((x) => x.id === 'plan:bunch:2026');
  assert.ok(u, 'under the cap the payment is worth its face value');
  assert.match(u.body, /\+\$3,000/);
});

test('the cadence nudge is keyed to the last logging day, so dismissing it lasts thirty days', () => {
  const entries = [];
  // the advisor reads createdAt as a local calendar day, so the stamps are built from local midday: 10:00 UTC would be the day before in Samoa
  for (let i = 0; i < 8; i++) entries.push(E('2026-05-01', 'se.supplies', 20 + i, 'Supplies', { createdAt: new Date(2026, 4 + Math.floor(i / 4), 1 + (i % 4) * 3, 12).toISOString() }));
  const id = mustFind(run(entries, {}, '2026-09-29').recommendations, (x) => x.id.startsWith('habit:cadence'), 'the cadence nudge').id;
  assert.equal(id, 'habit:cadence:2026-06-10');
  const nextDay = run(entries, { advisorDismissed: { [id]: '2026-09-29' } }, '2026-10-01');
  assert.equal(nextDay.recommendations.filter((x) => x.id.startsWith('habit:cadence')).length, 0);
  const afterThirty = run(entries, { advisorDismissed: { [id]: '2026-09-29' } }, '2026-10-29');
  assert.equal(afterThirty.recommendations.filter((x) => x.id.startsWith('habit:cadence')).length, 1);
});

test('an overdue payee whose last entry was last year shows the year', () => {
  const grace = ['2024-09-10', '2024-10-10', '2024-11-10', '2024-12-10'].map((d) => E(d, 'ch.worship', 200, 'Grace Church tithe'));
  const title = mustFind(run(grace, { taxYear: 2025 }, '2025-01-25').recommendations, (x) => x.id.startsWith('recur:'), 'the overdue recurrence').title;
  assert.equal(title, 'Grace Church tithe: nothing logged since Dec 10, 2024');
  const inYear = mustFind(run(monthly(2026, [1, 2, 3, 4, 5, 6, 7, 8], 'ch.worship', 200, 'Tithe'), {}, '2026-09-20').recommendations, (x) => x.id.startsWith('recur:'), 'the overdue recurrence').title;
  assert.equal(inYear, 'Tithe: nothing logged since Aug 5', 'a date inside the year being viewed needs no year');
});

test('the anomaly rule sees the same outlier in a large ledger', () => {
  const entries = [];
  for (const [description, lineId] of [['Dr Patel', 'med.doctor'], ['Grace Church', 'ch.worship'], ['Uline', 'se.supplies'], ['Vision plan', 'med.insurance'], ['County tax', 'tax.real_estate']]) {
    for (let i = 0; i < 120; i++) { const d = new Date(2026, 0, 1 + i * 3); entries.push(E(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, lineId, 100, description)); }
  }
  const outlier = E('2026-06-15', 'med.doctor', 4200, 'Dr Patel');
  entries.push(outlier);
  const r = run(entries, { agi: 90000 }, '2026-09-20');
  const a = r.recommendations.find((x) => x.id === `anomaly:${outlier.id}`);
  assert.ok(a);
  assert.equal(a.title, 'Dr Patel for $4,200 is far above its usual $100');
  assert.equal(a.because, '121 entries for the same payee');
  assert.deepEqual(r.recommendations.map((x) => x.id).sort(), [`anomaly:${outlier.id}`, 'plan:itemize:2026']);
});

test('the payee median is worked out once per payee, so thousands of entries for one payee stay quick', () => {
  // the median was re-sorted for every entry, which made this quadratic: 5,000 entries for one payee took five seconds
  // and takes about 70 ms now. The bound is generous because a slow machine is still nowhere near a second.
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    const d = new Date(2026, 0, 1 + (i % 300));
    entries.push(E(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, 'med.doctor', 40 + ((i * 37) % 400) / 4, 'Dr Patel'));
  }
  const outlier = E('2026-06-15', 'med.doctor', 4200, 'Dr Patel');
  entries.push(outlier);
  const started = Date.now();
  const r = run(entries, { agi: 90000 }, '2026-09-20');
  const elapsed = Date.now() - started;
  const a = mustFind(r.recommendations, (x) => x.id === `anomaly:${outlier.id}`, 'the outlier');
  assert.equal(a.because, '5001 entries for the same payee');
  assert.ok(elapsed < 2000, `5,001 entries for one payee took ${elapsed} ms`);
});

test('the stop-chasing-receipts plan waits until the year is far enough along', () => {
  const two = [E('2026-01-05', 'ch.worship', 100, 'Tithe'), E('2026-01-08', 'med.doctor', 60, 'Copay')];
  const early = run(two, { agi: 60000 }, '2026-01-20');
  assert.ok(!early.recommendations.some((x) => x.id === 'plan:stop:2026'));
  const e = early.recommendations.find((x) => x.id === 'plan:early:2026');
  assert.ok(e);
  assert.ok(!/You will not itemize/.test(e.title));
  assert.equal(e.title, 'On what is logged so far, $16,200 short of itemizing');
  const late = run(two, { agi: 60000 }, '2026-10-20');
  assert.ok(late.recommendations.some((x) => x.id === 'plan:stop:2026'));
  assert.ok(!late.recommendations.some((x) => x.id === 'plan:early:2026'));
  // two live recurrences are evidence enough to project the rest of the year, even in May
  const recurring = monthly(2026, [1, 2, 3, 4], 'ch.worship', 200, 'Tithe').concat(monthly(2026, [1, 2, 3, 4], 'ch.org', 90, 'Food bank', 12));
  const evidence = run(recurring, {}, '2026-05-02');
  assert.equal(evidence.recurrences.length, 2);
  assert.ok(evidence.recommendations.some((x) => x.id === 'plan:stop:2026'));
  assert.ok(!evidence.recommendations.some((x) => x.id === 'plan:early:2026'));
});

test('a co-occurring line the schema no longer has is skipped instead of throwing', () => {
  // an id a later schema dropped can still sit in the ledger, and the pair rule has no label to print for it
  const entries = [];
  for (const d of ['2026-02-01', '2026-03-01', '2026-04-01']) entries.push(E(d, 'ch.worship', 200, 'Tithe'), E(d, 'ch.retired', 40, 'A line that was removed'));
  entries.push(E('2026-05-01', 'ch.worship', 200, 'Tithe'));
  const r = run(entries);
  assert.ok(!r.recommendations.some((x) => x.id.startsWith('pair:')), 'nothing is suggested for a line with no label');
  assert.ok(r.recommendations.some((x) => x.id.startsWith('plan:')), 'the rest of the advice still runs');
});

test('a year with its own rates and standard deduction is projected on those numbers', () => {
  // what the caller computed and what the advisor projects have to rest on the same parameters, or the two disagree on screen
  const entries = [E('2026-02-02', 'med.miles', 5000, 'Round trip \u2014 dialysis'), E('2026-03-02', 'med.doctor', 3000, 'Dr Patel')];
  const settings = { taxYear: 2026, filingStatus: 'single', agi: 10000, paramOverrides: { 2026: { mileage: { medical: 0.5 }, standardDeduction: { single: 12000 } } } };
  const today = '2026-09-02';
  const computed = Rules.compute(entries, Object.assign({}, settings, { today }));
  const p = Advisor.analyze({ entries, settings, computed, today }).projection;
  // 5,000 miles at 50c and 3,000 of bills is 5,500, less the 7.5% floor on a 10,000 AGI
  assert.equal(p.actual, 4750);
  assert.equal(p.standardDeduction, 12000);
  assert.equal(p.expectedMore, 0);
  assert.equal(p.projectedTotal, 4750);
  assert.equal(p.itemize, false);
  assert.equal(p.gap, 7250);
});

test('estimated-tax dates are the day the payment is actually due, not the raw 15th', () => {
  assert.equal(Advisor.dueDate(2026, '04-15'), '2026-04-15', 'a plain Wednesday stays where it is');
  assert.equal(Advisor.dueDate(2024, '01-15'), '2024-01-16', 'Martin Luther King Day');
  assert.equal(Advisor.dueDate(2028, '01-15'), '2028-01-18', 'Saturday, Sunday, then the holiday');
  assert.equal(Advisor.dueDate(2029, '04-15'), '2029-04-17', 'Sunday, then Emancipation Day on the Monday');
  assert.equal(Advisor.dueDate(2022, '04-15'), '2022-04-18', 'Emancipation Day kept on the Friday, then the weekend');
  const paid = ['2023-04-18', '2023-06-15', '2023-09-15', '2024-01-16'].map((d) => E(d, 'tax.state_income', 900, 'NC DOR estimated payment'));
  const rec = run(paid, { taxYear: 2024 }, '2024-05-20').recurrences[0];
  assert.equal(rec.cadence, 'estimated');
  assert.deepEqual(rec.expected, ['2024-04-15', '2024-06-17', '2024-09-16'], 'the June and September deadlines fall on a weekend in 2024');
  assert.deepEqual(rec.nextYearEarly, ['2025-01-15', '2025-04-15']);
});
