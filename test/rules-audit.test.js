const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../js/rules.js');
const C = require('../js/classify.js');

const E = (date, lineId, amount, extra) => Object.assign({ id: `${lineId}-${date}-${amount}`, date, lineId, amount, hasReceipt: true }, extra || {});
const base = { taxYear: 2026, filingStatus: 'single', agi: 80000, today: '2026-09-02' };
const titles = (r) => r.insights.map((i) => i.title);

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
  assert.match(joint.insights.find((i) => /count even without itemizing/.test(i.title)).body, /\$2,000/);
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

test('state and local withholding counts toward the SALT deduction, except in states without an income tax', () => {
  const entries = [E('2026-01-05', 'tax.real_estate', 5000)];
  const r = Rules.compute(entries, { ...base, stateWithholding: '6200' });
  assert.equal(r.scheduleA.taxes.withheld, 6200);
  assert.equal(r.scheduleA.taxes.entered, 5000);
  assert.equal(r.scheduleA.taxes.gross, 11200);
  assert.equal(r.scheduleA.taxes.deductible, 11200);
  assert.equal(r.verdict.difference, 11200 - 16100);
  assert.ok(titles(r).some((t) => /withholding is counted/.test(t)));
  const tx = Rules.compute(entries, { ...base, state: 'TX', stateWithholding: '6200' });
  assert.equal(tx.scheduleA.taxes.withheld, 0);
  assert.equal(tx.scheduleA.taxes.gross, 5000);
  // the standard-deduction verdict points at the missing withholding
  const none = Rules.compute(entries, base);
  assert.match(none.insights.find((i) => /Standard deduction still wins/.test(i.title)).body, /withheld from your pay/);
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
  assert.match(plain.insights.find((i) => /disaster loss counts/.test(i.title)).body, /qualified disaster loss/);
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
  assert.match(salt.insights.find((i) => /Itemizing wins/.test(i.title)).body, /enter your estimated AGI/);
  const small = Rules.compute([E('2026-01-05', 'tax.real_estate', 3000)], { ...base, agi: '' });
  assert.equal(small.verdict.agiPending, false);
});
