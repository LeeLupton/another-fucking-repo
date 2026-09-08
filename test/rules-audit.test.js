const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../js/rules.js');
const C = require('../js/classify.js');
require('../js/store.js');
const DB = globalThis.ItemizerStore;

const E = (date, lineId, amount, extra) => Object.assign({ id: `${lineId}-${date}-${amount}`, date, lineId, amount, hasReceipt: true }, extra || {});
const base = { taxYear: 2026, filingStatus: 'single', agi: 80000, today: '2026-09-02' };
const titles = (r) => r.insights.map((i) => i.title);
// Name the insight that went missing instead of failing on an undefined property.
const mustFind = (list, re, label) => { const x = list.find((i) => re.test(i.title)); assert.ok(x, `${label} is present`); return x; };

test('a qualifying surviving spouse files alone: no spouse add-on, single phase-out range, $1,000 non-itemizer gift cap', () => {
  const r = Rules.compute([], { ...base, filingStatus: 'qss', spouseAge65: true, spouseBlind: true });
  assert.equal(r.standardDeduction.total, 32200);
  assert.equal(r.standardDeduction.conditions.length, 0);
  // the taxpayer's own condition still uses the married amount (§63(f)(3) covers a surviving spouse)
  assert.equal(Rules.compute([], { ...base, filingStatus: 'qss', age65: true }).standardDeduction.total, 32200 + 1650);
  const sli = Rules.compute([E('2025-06-01', 'edu.loan_interest', 2500)], { ...base, taxYear: 2025, filingStatus: 'qss', agi: 150000 });
  assert.equal(sli.adjustments.studentLoanInterest.phase, 'out');
  assert.equal(sli.adjustments.studentLoanInterest.deductible, 0);
  const gift = Rules.compute([E('2026-03-01', 'ch.org', 3000)], { ...base, filingStatus: 'qss' });
  const ins = gift.insights.find((i) => /count even without itemizing/.test(i.title));
  assert.ok(ins && /\$1,000/.test(ins.body), ins && ins.body);
  const joint = Rules.compute([E('2026-03-01', 'ch.org', 3000)], { ...base, filingStatus: 'mfj' });
  assert.match(mustFind(joint.insights, /count even without itemizing/, 'the non-itemizer gift insight').body, /\$2,000/);
});

test('2026 student loan interest phases out between $85k and $100k ($175k–$205k joint)', () => {
  const r = Rules.compute([E('2026-06-01', 'edu.loan_interest', 3000)], { ...base, agi: 150000 });
  assert.equal(r.adjustments.studentLoanInterest.deductible, 0);
  assert.equal(r.adjustments.studentLoanInterest.phase, 'out');
  assert.ok(titles(r).some((t) => /above the student loan interest phase-out/.test(t)));
  const mid = Rules.compute([E('2026-06-01', 'edu.loan_interest', 3000)], { ...base, agi: 92500 });
  assert.equal(mid.adjustments.studentLoanInterest.deductible, 1250);
  const joint = Rules.compute([E('2026-06-01', 'edu.loan_interest', 3000)], { ...base, filingStatus: 'mfj', agi: 190000 });
  assert.equal(joint.adjustments.studentLoanInterest.deductible, 1250);
  // without an AGI the deduction is shown as unchecked, not as a sure thing
  const noAgi = Rules.compute([E('2026-06-01', 'edu.loan_interest', 3000)], { ...base, agi: '' });
  const ins = noAgi.insights.find((i) => /student loan interest/.test(i.title));
  assert.equal(ins.level, 'info');
  assert.match(ins.body, /enter your estimated AGI/i);
  assert.equal(noAgi.verdict.agiPending, true);
});

test('state and local withholding counts toward the SALT deduction, wherever it was withheld', () => {
  const entries = [E('2026-01-05', 'tax.real_estate', 5000)];
  const r = Rules.compute(entries, { ...base, stateWithholding: '6200' });
  assert.equal(r.scheduleA.taxes.withheld, 6200);
  assert.equal(r.scheduleA.taxes.entered, 5000);
  assert.equal(r.scheduleA.taxes.gross, 11200);
  assert.equal(r.scheduleA.taxes.deductible, 11200);
  assert.equal(r.verdict.difference, 11200 - 16100);
  assert.ok(titles(r).some((t) => /withholding is counted/.test(t)));
  // living in a state with no income tax does not mean nothing was withheld: WA and OR, NH and MA
  const wa = Rules.compute(entries, { ...base, state: 'WA', stateWithholding: '7500' });
  assert.equal(wa.scheduleA.taxes.withheld, 7500);
  assert.equal(wa.scheduleA.taxes.gross, 12500);
  assert.equal(wa.scheduleA.taxes.deductible, 12500);
  assert.equal(wa.verdict.difference, 12500 - 16100);
  assert.match(mustFind(wa.insights, /counted as another state/, 'the out-of-state withholding note').body, /clear the figure in Settings/i);
  assert.ok(titles(wa).some((t) => /sales tax may be the better claim/.test(t)));
  const waNone = Rules.compute(entries, { ...base, state: 'WA', stateWithholding: '' });
  assert.equal(waNone.scheduleA.taxes.withheld, 0);
  assert.ok(titles(waNone).some((t) => /sales tax may be the better claim/.test(t)));
  assert.ok(!titles(waNone).some((t) => /counted as another state/.test(t)));
  // the standard-deduction verdict points at the missing withholding
  const none = Rules.compute(entries, base);
  assert.match(mustFind(none.insights, /Standard deduction still wins/, 'the standard-deduction verdict').body, /withheld from your pay/);
});

test('charitable gifts above the AGI limit carry forward instead of inflating the total', () => {
  const entries = [E('2025-03-01', 'ch.org', 9000)];
  const r = Rules.compute(entries, { ...base, taxYear: 2025, agi: 10000 });
  assert.equal(r.scheduleA.charity.deductible, 6000);
  assert.equal(r.scheduleA.charity.carryforward, 3000);
  assert.equal(r.scheduleA.total, 6000);
  assert.equal(r.verdict.itemize, false);
  assert.ok(titles(r).some((t) => /exceed the AGI limit/.test(t)));
  const noAgi = Rules.compute(entries, { ...base, taxYear: 2025, agi: '' });
  assert.equal(noAgi.scheduleA.charity.deductible, 9000, 'no limit can be applied without an AGI');
  assert.equal(noAgi.scheduleA.charity.limitPending, true);
  assert.equal(noAgi.verdict.agiPending, true);
});

test('a qualified disaster loss uses the $500 floor, skips the AGI reduction, and rides on top of the standard deduction', () => {
  const entries = [E('2025-05-01', 'cas.loss', 10000)];
  const plain = Rules.compute(entries, { ...base, taxYear: 2025, casualtyFederalDisaster: true });
  assert.equal(plain.scheduleA.casualty.afterLimits, 10000 - 100 - 8000);
  assert.equal(plain.standardDeduction.total, 15750);
  assert.match(mustFind(plain.insights, /disaster loss counts/, 'the disaster loss insight').body, /qualified disaster loss/);
  const q = Rules.compute(entries, { ...base, taxYear: 2025, casualtyFederalDisaster: true, casualtyQualifiedDisaster: true });
  assert.equal(q.scheduleA.casualty.qualified, true);
  assert.equal(q.scheduleA.casualty.deductible, 9500);
  assert.equal(q.standardDeduction.disasterLoss, 9500);
  assert.equal(q.standardDeduction.total, 15750 + 9500);
  assert.equal(q.scheduleA.total, 9500);
  assert.equal(q.verdict.itemize, false, 'the loss counts either way, so it does not tip the verdict');
  // the flag alone does nothing without the disaster declaration
  const noDecl = Rules.compute(entries, { ...base, taxYear: 2025, casualtyQualifiedDisaster: true });
  assert.equal(noDecl.scheduleA.casualty.deductible, 0);
  assert.equal(noDecl.standardDeduction.total, 15750);
});

test('a $0 standard-deduction override is honoured (spouse itemizes)', () => {
  const r = Rules.compute([], { ...base, filingStatus: 'mfs', paramOverrides: { 2026: { standardDeduction: { mfs: 0 } } } });
  assert.equal(r.standardDeduction.base, 0);
  assert.equal(r.standardDeduction.total, 0);
});

test('education credits are not offered to married-filing-separately filers', () => {
  const entries = [E('2026-08-20', 'edu.tuition', 4000)];
  const mfs = Rules.compute(entries, { ...base, filingStatus: 'mfs' });
  assert.ok(mfs.insights.some((i) => i.level === 'warn' && /not allowed when married filing separately/.test(i.title)));
  assert.ok(!mfs.insights.some((i) => /may qualify for an education credit/.test(i.title)));
  assert.ok(Rules.compute(entries, base).insights.some((i) => /may qualify for an education credit/.test(i.title)));
});

test('mortgage insurance premiums are flagged as deductible again from 2026, and PMI no longer warns', () => {
  const r26 = Rules.compute([E('2026-12-31', 'int.mortgage', 9000)], base);
  assert.ok(titles(r26).some((t) => /Mortgage insurance premiums count again/.test(t)));
  const r25 = Rules.compute([E('2025-12-31', 'int.mortgage', 9000)], { ...base, taxYear: 2025 });
  assert.ok(!titles(r25).some((t) => /Mortgage insurance premiums count again/.test(t)));
  assert.equal(C.classify('PMI mortgage insurance premium').nonDeductible.length, 0);
});

test('a missing AGI is flagged whenever an income-based limit could not be checked', () => {
  const salt = Rules.compute([E('2026-01-05', 'tax.real_estate', 30000)], { ...base, agi: '' });
  assert.equal(salt.verdict.agiPending, true);
  assert.match(mustFind(salt.insights, /Itemizing wins/, 'the itemizing verdict').body, /enter your estimated AGI/);
  const small = Rules.compute([E('2026-01-05', 'tax.real_estate', 3000)], { ...base, agi: '' });
  assert.equal(small.verdict.agiPending, false);
});

test('charity, interest, casualty and education insights fire on the right facts', () => {
  const has = (r, re) => titles(r).some((x) => re.test(x));
  const big = Rules.compute([E('2026-04-01', 'ch.noncash', 6000)], base);
  assert.equal(big.scheduleA.charity.nonCashNeedsAppraisal, true);
  assert.ok(has(big, /qualified appraisal/) && !has(big, /Form 8283/), 'over $5,000 the appraisal note replaces the Form 8283 note');
  const mid = Rules.compute([E('2026-04-01', 'ch.noncash', 600)], base);
  assert.ok(has(mid, /Form 8283/) && !has(mid, /qualified appraisal/));
  const gifts = Rules.compute([E('2026-04-01', 'ch.org', 60000)], base);
  assert.equal(gifts.scheduleA.charity.cashLimit, 48000, '60% of an $80,000 AGI');
  assert.ok(has(gifts, /exceed the AGI limit/));
  const mort = Rules.compute([E('2026-02-01', 'int.mortgage', 20000)], base);
  const escrow = mort.insights.find((i) => /no property tax/.test(i.title));
  assert.ok(escrow); assert.equal(escrow.level, 'act'); assert.equal(escrow.view, 'capture');
  assert.ok(!has(Rules.compute([E('2026-02-01', 'int.mortgage', 20000), E('2026-02-02', 'tax.real_estate', 1)], base), /no property tax/));
  const cas = Rules.compute([E('2026-05-01', 'cas.loss', 5000)], { ...base, agi: '', casualtyFederalDisaster: true });
  assert.equal(cas.scheduleA.casualty.afterLimits, null); assert.equal(cas.scheduleA.casualty.deductible, 0);
  const sizing = cas.insights.find((i) => /Enter AGI to size the casualty loss/.test(i.title));
  assert.ok(sizing); assert.equal(sizing.level, 'act'); assert.equal(sizing.view, 'settings');
  const tuition = Rules.compute([E('2026-08-20', 'edu.tuition', 4000)], base);
  const credit = tuition.insights.find((i) => /education credit/.test(i.title));
  assert.ok(credit); assert.equal(credit.level, 'good');
});

test('Schedule C mileage guards, the married-filing-separately note, and the date-gated year-end checklist', () => {
  const has = (r, re) => titles(r).some((x) => re.test(x));
  const alone = Rules.compute([E('2026-03-01', 'se.miles', 100)], base);
  const log = alone.insights.find((i) => /Log total miles/.test(i.title));
  assert.ok(log); assert.equal(log.level, 'act'); assert.equal(log.view, 'capture');
  const over = Rules.compute([E('2026-03-01', 'se.miles', 100), E('2026-12-31', 'se.total_miles', 50)], base);
  assert.ok(has(over, /Business miles exceed total miles/));
  assert.equal(over.scheduleC.vehicle.businessUseShare, 1, 'the share is clamped');
  assert.ok(!has(Rules.compute([E('2026-03-01', 'se.miles', 100), E('2026-12-31', 'se.total_miles', 500)], base), /Log total miles|exceed total miles/));
  assert.ok(has(Rules.compute([E('2026-03-01', 'ch.worship', 100)], { ...base, filingStatus: 'mfs' }), /itemize together or not at all/));
  const gift = [E('2026-03-01', 'ch.worship', 100)];
  assert.ok(has(Rules.compute(gift, { ...base, today: '2026-11-15' }), /Year-end checklist/));
  assert.ok(!has(Rules.compute(gift, { ...base, today: '2026-09-02' }), /Year-end checklist/), 'not before November');
  assert.ok(!has(Rules.compute(gift, { ...base, today: '2027-11-15' }), /Year-end checklist/), 'not once the year is over');
  const itemizer = [E('2026-01-05', 'tax.real_estate', 9000), E('2026-01-06', 'int.mortgage', 12000)];
  assert.ok(!has(Rules.compute(itemizer, { ...base, today: '2026-11-15' }), /Year-end checklist/), 'only while the standard deduction is winning');
});

test('mileage is valued by the date of the drive, so the July 1, 2026 increase is picked up', () => {
  const r = Rules.compute([E('2026-03-10', 'med.miles', 1000), E('2026-08-10', 'med.miles', 1000), E('2026-03-10', 'se.miles', 1000), E('2026-08-10', 'se.miles', 1000)], { ...base, agi: 0 });
  assert.equal(r.scheduleA.medical.milesValue, 1000 * 0.205 + 1000 * 0.235);
  assert.equal(r.scheduleC.vehicle.milesValue, 1000 * 0.725 + 1000 * 0.76);
  assert.equal(r.months[2], 205 + 725);
  assert.equal(r.months[7], 235 + 760);
  // the day the rates change
  assert.equal(Rules.compute([E('2026-06-30', 'med.miles', 1000)], { ...base, agi: 0 }).scheduleA.medical.milesValue, 205);
  assert.equal(Rules.compute([E('2026-07-01', 'med.miles', 1000)], { ...base, agi: 0 }).scheduleA.medical.milesValue, 235);
  // a year with one set of rates is unchanged
  const r25 = Rules.compute([E('2025-03-10', 'med.miles', 1000), E('2025-08-10', 'se.miles', 1000)], { ...base, taxYear: 2025, agi: 0 });
  assert.equal(r25.scheduleA.medical.milesValue, 210);
  assert.equal(r25.scheduleC.vehicle.milesValue, 700);
  // and the wording follows: both figures in a split year, one in every other
  assert.equal(Rules.perMileText(Rules.getParams(2026), 'medical'), '20.5¢/mile before July 1 and 23.5¢/mile after');
  assert.equal(Rules.perMileText(Rules.getParams(2026), 'charity'), '14¢/mile');
  assert.equal(Rules.perMileText(Rules.getParams(2025), 'medical'), '21¢/mile');
  assert.match(mustFind(Rules.compute([E('2026-08-10', 'med.miles', 1000)], base).insights, /Medical miles are worth/, 'the medical mileage insight').body, /20\.5¢\/mile before July 1 and 23\.5¢\/mile after/);
});

test('money() rounds half away from zero and never prints a signed zero', () => {
  assert.equal(Rules.money(-0.3), '$0');
  assert.equal(Rules.money(-0.49), '$0');
  assert.equal(Rules.money(-0.5), '-$1');
  assert.equal(Rules.money(-1234.5), '-$1,235');
  assert.equal(Rules.money(1234.5), '$1,235');
  assert.equal(Rules.money(0), '$0');
});

test('cash gifts a non-itemizer may deduct sit on the standard-deduction side of the verdict', () => {
  const entries = [E('2026-01-05', 'tax.real_estate', 6000), E('2026-01-06', 'int.mortgage', 8900), E('2026-03-01', 'ch.worship', 2000)];
  const r = Rules.compute(entries, base);
  assert.equal(r.scheduleA.total, 16500);
  assert.equal(r.standardDeduction.charity, 1000);
  assert.equal(r.standardDeduction.total, 17100);
  assert.equal(r.verdict.itemize, false);
  assert.equal(r.verdict.difference, -600);
  assert.ok(titles(r).some((t) => /count even without itemizing/.test(t)));
  const mfj = Rules.compute([E('2026-01-05', 'tax.real_estate', 12000), E('2026-01-06', 'int.mortgage', 18000), E('2026-03-01', 'ch.worship', 3500)], { ...base, filingStatus: 'mfj', agi: 100000 });
  assert.equal(mfj.standardDeduction.charity, 2000);
  assert.equal(mfj.standardDeduction.total, 34200);
  assert.equal(mfj.verdict.itemize, false);
  assert.equal(mfj.verdict.difference, -1200);
  // never more than the cash actually given
  assert.equal(Rules.compute([E('2026-03-01', 'ch.worship', 400)], base).standardDeduction.charity, 400);
  // and nothing before 2026
  const r25 = Rules.compute(entries.map((e) => ({ ...e, date: e.date.replace('2026', '2025') })), { ...base, taxYear: 2025 });
  assert.equal(r25.standardDeduction.charity, 0);
  assert.equal(r25.verdict.itemize, true);
  assert.equal(r25.verdict.difference, 16900 - 15750);
});

test('the non-itemizer gift note says what does not count', () => {
  const r = Rules.compute([E('2026-03-10', 'ch.org', 500)], { ...base, agi: 50000 });
  const ins = mustFind(r.insights, /count even without itemizing/, 'the non-itemizer gift insight');
  assert.match(ins.body, /donor-advised fund/);
  assert.match(ins.body, /\$500/);
  assert.ok(!titles(Rules.compute([E('2025-03-10', 'ch.org', 500)], { ...base, taxYear: 2025, agi: 50000 })).some((t) => /count even without itemizing/.test(t)));
});

test('a qualified disaster loss does not wait on an AGI', () => {
  const entries = [E('2026-05-01', 'cas.loss', 10000)];
  const q = Rules.compute(entries, { ...base, agi: '', casualtyFederalDisaster: true, casualtyQualifiedDisaster: true });
  assert.equal(q.scheduleA.casualty.afterLimits, 9500);
  assert.equal(q.verdict.agiPending, false);
  const plain = Rules.compute(entries, { ...base, agi: '', casualtyFederalDisaster: true });
  assert.equal(plain.scheduleA.casualty.afterLimits, null);
  assert.equal(plain.verdict.agiPending, true);
});

test('a margin of less than a dollar is announced in cents, not as $0', () => {
  const c = Rules.compute([E('2026-01-05', 'tax.real_estate', 16100.4)], base);
  assert.equal(c.verdict.itemize, true);
  assert.equal(mustFind(c.insights, /Itemizing wins/, 'the itemizing verdict').title, 'Itemizing wins by $0.40');
  const onFloor = Rules.compute([E('2026-01-05', 'med.doctor', 6000)], base);
  assert.equal(onFloor.scheduleA.medical.shortfall, 0);
  assert.ok(!/Another \$0 of medical/.test(mustFind(onFloor.insights, /under the/, 'the medical floor insight').body));
});

test('bunching advice waits for a year you can still act on', () => {
  const entries = [E('2025-01-05', 'tax.real_estate', 6000), E('2025-01-06', 'int.mortgage', 7000)];
  const settings = { ...base, taxYear: 2025, agi: 80000 };
  const open = Rules.compute(entries, { ...settings, today: '2025-09-02' });
  const bunching = mustFind(open.insights, /consider bunching/, 'the bunching advice');
  assert.equal(bunching.level, 'act');
  assert.match(bunching.body, /before Dec 31/);
  const closed = Rules.compute(entries, { ...settings, today: '2026-09-02' });
  assert.ok(!titles(closed).some((t) => /consider bunching/.test(t)));
  const past = mustFind(closed.insights, /fell \$2,750 short/, 'the closed-year summary');
  assert.equal(past.level, 'info');
  assert.ok(!/before Dec 31/.test(past.body));
  assert.ok(!closed.insights.some((i) => i.level === 'act'), 'nothing is actionable about a year that is over');
});

test('long-term-care premiums are held to the age-based limit and the bands are shown', () => {
  const e = [E('2025-01-01', 'med.ltc', 9000)];
  const r = Rules.compute(e, { ...base, taxYear: 2025, agi: 20000, age65: true });
  assert.equal(r.scheduleA.medical.gross, 6020);
  assert.equal(r.scheduleA.medical.ltc.counted, 6020);
  const capped = mustFind(r.insights, /Long-term-care premiums are limited/, 'the long-term-care warning');
  assert.equal(capped.level, 'warn');
  assert.match(capped.body, /\$4,810/); assert.match(capped.body, /\$6,020/); assert.match(capped.body, /per insured person/);
  // a joint return can hold two policies, so the bound doubles
  assert.equal(Rules.compute(e, { ...base, taxYear: 2025, agi: 20000, age65: true, filingStatus: 'mfj' }).scheduleA.medical.gross, 9000);
  // a plausible premium is left alone, with the bands as information
  const small = Rules.compute([E('2025-01-01', 'med.ltc', 1200)], { ...base, taxYear: 2025, agi: 20000 });
  assert.equal(small.scheduleA.medical.gross, 1200);
  assert.equal(mustFind(small.insights, /Long-term-care premiums have an age limit/, 'the long-term-care note').level, 'info');
  // the 2026 table
  assert.equal(Rules.compute([E('2026-01-01', 'med.ltc', 9000)], { ...base, agi: 20000, age65: true }).scheduleA.medical.gross, 6200);
});

test('the senior deduction is figured per person and phases out on income', () => {
  const senior = (extra) => Rules.compute([], { ...base, taxYear: 2025, age65: true, ...extra }).adjustments.seniorDeduction;
  assert.equal(senior({ agi: 50000 }).amount, 6000);
  assert.equal(senior({ agi: 100000 }).amount, 4500);
  assert.equal(senior({ agi: 175000 }).amount, 0);
  assert.equal(senior({ filingStatus: 'mfj', spouseAge65: true, agi: 150000 }).amount, 12000);
  assert.equal(senior({ filingStatus: 'mfj', spouseAge65: true, agi: 200000 }).amount, 6000);
  assert.equal(senior({ filingStatus: 'mfj', spouseAge65: true, agi: 250000 }).amount, 0);
  assert.equal(senior({ filingStatus: 'mfs', agi: 50000 }).amount, 0, 'married taxpayers must file jointly for it');
  assert.equal(Rules.compute([], { ...base, taxYear: 2024, age65: true, agi: 50000 }).adjustments.seniorDeduction, null);
  // it is an extra deduction, not part of the standard-deduction comparison
  const r = Rules.compute([], { ...base, taxYear: 2025, age65: true, agi: 50000 });
  assert.equal(r.standardDeduction.total, 17750);
  assert.ok(titles(r).some((t) => /senior deduction/i.test(t)));
  assert.ok(!titles(Rules.compute([], { ...base, taxYear: 2024, age65: true, agi: 50000 })).some((t) => /senior deduction/i.test(t)));
});

test('education credits are only called good news at incomes where they exist', () => {
  const e = [E('2025-09-01', 'edu.tuition', 8000)];
  const at = (extra) => Rules.compute(e, { ...base, taxYear: 2025, today: '2025-10-01', ...extra }).insights;
  const out = mustFind(at({ agi: 150000 }), /education-credit phase-out/, 'the phased-out credit warning');
  assert.equal(out.level, 'warn');
  assert.ok(!at({ agi: 150000 }).some((i) => i.level === 'good' && /education credit/i.test(i.title)));
  assert.equal(mustFind(at({ agi: 60000 }), /may qualify for an education credit/, 'the credit note').level, 'good');
  assert.equal(mustFind(at({ agi: 170000, filingStatus: 'mfj' }), /partly phased out/, 'the partial credit note').level, 'info');
  const unchecked = mustFind(at({ agi: '' }), /may qualify for an education credit/, 'the unchecked credit note');
  assert.equal(unchecked.level, 'good');
  assert.match(unchecked.body, /\$80,000/);
  assert.equal(unchecked.view, 'settings');
  assert.equal(mustFind(at({ filingStatus: 'mfs' }), /not allowed when married filing separately/, 'the separate-return warning').level, 'warn');
});

test('the educator classroom-expense figure follows the tax year', () => {
  assert.equal(Rules.getParams(2025).educatorExpenseCap, 300);
  assert.equal(Rules.getParams(2026).educatorExpenseCap, 350);
  const r26 = Rules.compute([E('2026-01-01', 'edu.expenses', 400)], { ...base, agi: 50000 });
  const note26 = mustFind(r26.insights, /Education costs/, 'the education costs note');
  assert.match(note26.body, /\$350/);
  assert.match(note26.body, /itemize classroom expenses above that cap/);
  const note25 = mustFind(Rules.compute([E('2025-01-01', 'edu.expenses', 400)], { ...base, taxYear: 2025, agi: 50000 }).insights, /Education costs/, 'the education costs note');
  assert.match(note25.body, /\$300/);
  assert.ok(!/\$350/.test(note25.body));
});

test('the appraisal note states the per-item rule, not a year total', () => {
  const two = Rules.compute([E('2025-03-01', 'ch.noncash', 2600), E('2025-09-01', 'ch.noncash', 2800)], { ...base, taxYear: 2025, agi: 90000, today: '2025-10-01' });
  const ins = mustFind(two.insights, /appraisal/, 'the appraisal note');
  assert.ok(!/gifts over \$5,000 need a qualified appraisal/.test(ins.title));
  // the first sentence is what the worksheet's preparer notes print
  assert.match(ins.body.split(/(?<=\.)\s/)[0], /similar items/);
});

test('every figure the fallback insight asks for can be entered in Settings', () => {
  const paths = Rules.paramFields(2026).map((f) => f.path);
  for (const p of ['saltPhaseout.start.default', 'saltPhaseout.floor.mfs', 'studentLoanPhaseout.single.start', 'nonItemizerCharity.mfj', 'casualtyAgiRate', 'nonCashAppraisal', 'educatorExpenseCap', 'pmiPhaseout.default.end', 'mileageJul.business']) assert.ok(paths.includes(p), `${p} is editable`);
  // rows a year has no figure for are not offered
  const paths24 = Rules.paramFields(2024).map((f) => f.path);
  assert.ok(!paths24.includes('saltPhaseout.start.default'));
  assert.ok(!paths24.includes('mileageJul.business'));
  // and the phase-down threshold can actually be corrected for a year with no built-in figures
  const r = Rules.compute([E('2027-01-05', 'tax.real_estate', 45000)], { ...base, taxYear: 2027, agi: 507000, today: '2027-09-02', paramOverrides: { 2027: { saltCap: { default: 40804 }, saltPhaseout: { start: { default: 510050 } } } } });
  assert.equal(r.scheduleA.taxes.cap, 40804);
  assert.equal(r.scheduleA.taxes.phasedOut, false);
  // the store keeps one row per parameter, so each path must survive the round trip
  const rows = DB.flattenOverrides(2027, { saltPhaseout: { start: { default: 510050 } }, studentLoanPhaseout: { single: { start: 86000 } } });
  assert.deepEqual(rows.map((x) => x.path), ['saltPhaseout.start.default', 'studentLoanPhaseout.single.start']);
  for (const row of rows) assert.ok(DB.sanitizeRow('overrides', row), row.path);
});

test('the mileage override fields are labelled in the unit the box takes', () => {
  for (const f of Rules.PARAM_FIELDS.concat(Rules.CONDITIONAL_PARAM_FIELDS)) {
    if (f.kind === 'permile') { assert.match(f.label, /¢\/mile/); assert.ok(!/\$/.test(f.label), f.label); }
    if (f.kind === 'usd') assert.ok(!/¢|%/.test(f.label), f.label);
  }
});

test('the standard deduction, caps and rates of every year and filing status', () => {
  const table = {
    2024: { single: 14600, mfj: 29200, mfs: 14600, hoh: 21900, qss: 29200 },
    2025: { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625, qss: 31500 },
    2026: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150, qss: 32200 },
  };
  for (const [year, byStatus] of Object.entries(table)) {
    for (const [filingStatus, total] of Object.entries(byStatus)) {
      assert.equal(Rules.compute([], { ...base, taxYear: Number(year), filingStatus }).standardDeduction.total, total, `${year} ${filingStatus}`);
    }
  }
  assert.equal(Rules.compute([], { ...base, taxYear: 2024, age65: true }).standardDeduction.total, 16550);
  assert.equal(Rules.compute([], { ...base, taxYear: 2024, filingStatus: 'mfj', age65: true }).standardDeduction.total, 30750);
  assert.equal(Rules.compute([], { ...base, taxYear: 2025, age65: true }).standardDeduction.total, 17750);
  assert.equal(Rules.compute([], { ...base, taxYear: 2025, filingStatus: 'mfj', age65: true }).standardDeduction.total, 33100);
  assert.equal(Rules.compute([], { ...base, age65: true, blind: true }).standardDeduction.total, 20200);
  // SALT: the 2025 cap and its phase-down, and the separate-return cap and floor
  const salt = (extra) => Rules.compute([E(`${extra.taxYear || 2026}-01-05`, 'tax.real_estate', 30000)], { ...base, ...extra }).scheduleA.taxes;
  assert.equal(salt({ taxYear: 2025 }).cap, 40000);
  assert.equal(salt({ taxYear: 2025, agi: 550000 }).cap, 25000);
  assert.equal(salt({ taxYear: 2025, agi: 600000 }).cap, 10000);
  assert.equal(salt({ taxYear: 2025, filingStatus: 'mfs' }).cap, 20000);
  const mfs = salt({ filingStatus: 'mfs', agi: 300000 });
  assert.equal(mfs.cap, 5950); assert.equal(mfs.phasedOut, true);
  assert.equal(salt({ filingStatus: 'mfs', agi: 600000 }).cap, 5000);
  // mileage per year
  for (const [year, business] of [[2024, 670], [2025, 700]]) {
    const drives = [E(`${year}-03-01`, 'se.miles', 1000), E(`${year}-12-31`, 'se.total_miles', 5000), E(`${year}-03-02`, 'med.miles', 1000), E(`${year}-03-03`, 'vol.miles', 1000)];
    const r = Rules.compute(drives, { ...base, taxYear: year, agi: 0 });
    assert.equal(r.scheduleC.vehicle.milesValue, business, `${year} business miles`);
    assert.equal(r.scheduleA.medical.gross, 210, `${year} medical miles`);
    assert.equal(r.scheduleA.charity.volunteer, 140, `${year} charitable miles`);
  }
  // 2024 student loan interest range, and 2024 gambling losses before the 90% rule
  const sli = (extra) => Rules.compute([E('2024-06-01', 'edu.loan_interest', 3000)], { ...base, taxYear: 2024, ...extra }).adjustments.studentLoanInterest.deductible;
  assert.equal(sli({ agi: 87500 }), 1250);
  assert.equal(sli({ filingStatus: 'mfj', agi: 180000 }), 1250);
  assert.equal(sli({ agi: 100000 }), 0);
  assert.equal(Rules.compute([E('2024-05-05', 'oth.gambling', 2000)], { ...base, taxYear: 2024, gamblingWinnings: 5000 }).scheduleA.other.deductible, 2000);
  // the non-itemizer gift cap is the single figure for every status but a joint return
  for (const filingStatus of ['hoh', 'mfs']) {
    const r = Rules.compute([E('2026-03-01', 'ch.org', 3000)], { ...base, filingStatus });
    assert.equal(r.standardDeduction.charity, 1000, filingStatus);
    assert.match(mustFind(r.insights, /count even without itemizing/, `the ${filingStatus} gift insight`).body, /\$1,000/);
  }
  // a year with no built-in figures still takes overrides
  const later = Rules.compute([], { ...base, taxYear: 2027, paramOverrides: { 2027: { standardDeduction: { single: 16500 } } } });
  assert.equal(later.standardDeduction.base, 16500);
  assert.equal(later.params.baseYear, 2026);
  assert.equal(later.params.isFallback, true);
  assert.equal(later.params.hasOverrides, true);
});
