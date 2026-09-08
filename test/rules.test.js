const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../js/rules.js');

const E = (date, lineId, amount, extra) => Object.assign({ id: `${lineId}-${date}-${amount}`, date, lineId, amount, hasReceipt: true }, extra || {});
const base = { taxYear: 2026, filingStatus: 'single', agi: 80000, today: '2026-09-02' };

test('standard deduction by filing status with age/blind add-ons', () => {
  assert.equal(Rules.compute([], base).standardDeduction.total, 16100);
  assert.equal(Rules.compute([], { ...base, filingStatus: 'mfj' }).standardDeduction.total, 32200);
  assert.equal(Rules.compute([], { ...base, filingStatus: 'hoh', age65: true }).standardDeduction.total, 24150 + 2050);
  const r = Rules.compute([], { ...base, filingStatus: 'mfj', age65: true, spouseAge65: true, spouseBlind: true });
  assert.equal(r.standardDeduction.total, 32200 + 3 * 1650);
  assert.equal(r.standardDeduction.conditions.length, 3);
  // spouse conditions ignored when single
  assert.equal(Rules.compute([], { ...base, spouseAge65: true }).standardDeduction.total, 16100);
  const blind = Rules.compute([], { ...base, blind: true });
  assert.equal(blind.standardDeduction.total, 16100 + 2050);
  assert.deepEqual(blind.standardDeduction.conditions, ['you are blind']);
  // a qualifying surviving spouse: the joint base and the married add-on for their own condition, never the spouse's
  assert.equal(Rules.compute([], { ...base, filingStatus: 'qss', blind: true }).standardDeduction.total, 32200 + 1650);
  assert.equal(Rules.compute([], { ...base, filingStatus: 'qss', blind: true, spouseAge65: true }).standardDeduction.total, 32200 + 1650);
  assert.equal(Rules.compute([], { ...base, filingStatus: 'mfs', blind: true }).standardDeduction.total, 16100 + 1650);
});

test('medical: 7.5% AGI floor, miles at the medical rate, pending without AGI', () => {
  const entries = [E('2026-02-01', 'med.doctor', 5000), E('2026-02-02', 'med.miles', 1000)];
  const r = Rules.compute(entries, base);
  assert.equal(r.scheduleA.medical.gross, 5205); // 5000 + 1000 × 0.205, the rate before July 1, 2026
  assert.equal(r.scheduleA.medical.floor, 6000);
  assert.equal(r.scheduleA.medical.deductible, 0);
  assert.equal(r.scheduleA.medical.shortfall, 795);
  const r2 = Rules.compute(entries, { ...base, agi: 40000 });
  assert.equal(r2.scheduleA.medical.deductible, 2205);
  const r3 = Rules.compute(entries, { ...base, agi: '' });
  assert.equal(r3.scheduleA.medical.deductible, null);
  assert.equal(r3.verdict.medicalPending, true);
  assert.equal(r3.scheduleA.total, 0, 'medical is excluded from the total until AGI is known');
  assert.ok(r3.insights.some((i) => /Enter your estimated AGI/.test(i.title)));
});

test('SALT cap by year and filing status, with the high-income phase-down', () => {
  const entries = [E('2026-01-05', 'tax.real_estate', 30000), E('2026-04-15', 'tax.state_income', 20000)];
  const r26 = Rules.compute(entries, base);
  assert.equal(r26.scheduleA.taxes.cap, 40400);
  assert.equal(r26.scheduleA.taxes.deductible, 40400);
  assert.equal(r26.scheduleA.taxes.excess, 9600);
  assert.ok(r26.insights.some((i) => /hit the cap/.test(i.title)));
  const r24 = Rules.compute(entries.map((e) => ({ ...e, date: e.date.replace('2026', '2024') })), { ...base, taxYear: 2024 });
  assert.equal(r24.scheduleA.taxes.deductible, 10000);
  const mfs = Rules.compute(entries, { ...base, filingStatus: 'mfs' });
  assert.equal(mfs.scheduleA.taxes.cap, 20200);
  // $600k AGI in 2026: 40,400 − 30% × (600,000 − 505,000) = 11,900
  const rich = Rules.compute(entries, { ...base, agi: 600000 });
  assert.equal(rich.scheduleA.taxes.cap, 11900);
  assert.equal(rich.scheduleA.taxes.phasedOut, true);
  // floor never below 10,000
  const richer = Rules.compute(entries, { ...base, agi: 2000000 });
  assert.equal(richer.scheduleA.taxes.cap, 10000);
});

test('charity: cash + non-cash + volunteer miles; 2026 floor only matters when itemizing', () => {
  const entries = [E('2026-03-01', 'ch.worship', 4000), E('2026-03-02', 'ch.noncash', 600), E('2026-03-03', 'vol.miles', 500), E('2026-03-04', 'vol.expenses', 100)];
  const r = Rules.compute(entries, base);
  assert.equal(r.scheduleA.charity.cash, 4000);
  assert.equal(r.scheduleA.charity.volunteer, 170); // 100 + 500 × 0.14
  assert.equal(r.scheduleA.charity.gross, 4770);
  assert.equal(r.scheduleA.charity.floor, 400); // 0.5% of 80,000
  assert.equal(r.scheduleA.charity.deductible, 4370);
  assert.equal(r.scheduleA.charity.nonCashNeedsForm8283, true);
  assert.ok(r.insights.some((i) => /Form 8283/.test(i.title)));
  assert.ok(r.insights.some((i) => /without itemizing/.test(i.title)), 'non-itemizer cash gift deduction is mentioned in 2026');
  const r25 = Rules.compute(entries.map((e) => ({ ...e, date: e.date.replace('2026', '2025') })), { ...base, taxYear: 2025 });
  assert.equal(r25.scheduleA.charity.floor, 0);
  assert.equal(r25.scheduleA.charity.deductible, 4770);
});

test('gifts of $250+ without an acknowledgment are flagged once, not twice', () => {
  const r = Rules.compute([E('2026-03-01', 'ch.org', 300, { hasReceipt: false }), E('2026-03-02', 'med.doctor', 90, { hasReceipt: false })], base);
  assert.equal(r.substantiation.giftsNoAck.length, 1);
  assert.equal(r.substantiation.missingReceipts.length, 1);
  assert.equal(r.substantiation.missingReceipts[0].lineId, 'med.doctor');
});

test('gambling losses limited to winnings and to 90% from 2026', () => {
  const e = [E('2026-05-05', 'oth.gambling', 2000)];
  assert.equal(Rules.compute(e, base).scheduleA.other.deductible, 0);
  assert.ok(Rules.compute(e, base).insights.some((i) => /need winnings/.test(i.title)));
  assert.equal(Rules.compute(e, { ...base, gamblingWinnings: 1500 }).scheduleA.other.deductible, 1500);
  assert.equal(Rules.compute(e, { ...base, gamblingWinnings: 5000 }).scheduleA.other.deductible, 1800);
  const e25 = [E('2025-05-05', 'oth.gambling', 2000)];
  assert.equal(Rules.compute(e25, { ...base, taxYear: 2025, gamblingWinnings: 5000 }).scheduleA.other.deductible, 2000);
});

test('casualty losses count only when marked as a federal disaster', () => {
  const e = [E('2026-06-01', 'cas.loss', 20000)];
  assert.equal(Rules.compute(e, base).scheduleA.casualty.deductible, 0);
  const r = Rules.compute(e, { ...base, casualtyFederalDisaster: true });
  assert.equal(r.scheduleA.casualty.deductible, 20000 - 100 - 8000);
});

test('verdict: itemize when Schedule A beats the standard deduction', () => {
  const entries = [E('2026-01-05', 'tax.real_estate', 9000), E('2026-01-06', 'int.mortgage', 12000), E('2026-01-07', 'ch.worship', 3000)];
  const r = Rules.compute(entries, base);
  assert.equal(r.scheduleA.total, 9000 + 12000 + (3000 - 400));
  assert.equal(r.verdict.itemize, true);
  // the standard-deduction side carries the $1,000 of cash gifts a non-itemizer may deduct from 2026
  assert.equal(r.standardDeduction.charity, 1000);
  assert.equal(r.verdict.difference, 23600 - 17100);
  const win = r.insights.find((i) => /Itemizing wins/.test(i.title));
  assert.ok(win, 'the verdict is an insight'); assert.equal(win.level, 'good'); assert.match(win.title, /\$6,500/);
  // insights sort by urgency: an unacknowledged $300 gift outranks the good news
  const flagged = Rules.compute(entries.concat([E('2026-02-01', 'ch.org', 300, { hasReceipt: false })]), base);
  assert.equal(flagged.insights[0].level, 'act');
  const mfj = Rules.compute(entries, { ...base, filingStatus: 'mfj' });
  assert.equal(mfj.verdict.itemize, false);
  assert.equal(mfj.standardDeduction.total, 32200 + 2000);
  // $24,600 against a $34,200 standard deduction: inside the bunching band
  const nearly = Rules.compute(entries.concat([E('2026-01-08', 'int.mortgage', 1000)]), { ...base, filingStatus: 'mfj' });
  assert.ok(nearly.insights.some((i) => /bunching/.test(i.title)), 'close-to-the-line bunching advice');
});

test('student loan interest: cap and phase-out', () => {
  const e = [E('2025-12-31', 'edu.loan_interest', 3000)];
  const r = Rules.compute(e, { ...base, taxYear: 2025, agi: 50000 });
  assert.equal(r.adjustments.studentLoanInterest.deductible, 2500);
  assert.equal(r.adjustments.studentLoanInterest.phase, 'full');
  assert.equal(Rules.compute(e, { ...base, taxYear: 2025, agi: 92500 }).adjustments.studentLoanInterest.deductible, 1250);
  assert.equal(Rules.compute(e, { ...base, taxYear: 2025, agi: 120000 }).adjustments.studentLoanInterest.deductible, 0);
  assert.equal(Rules.compute(e, { ...base, taxYear: 2025, filingStatus: 'mfs' }).adjustments.studentLoanInterest.phase, 'mfs');
});

test('Schedule C: meals at 50%, vehicle method conflict, business-use share', () => {
  const entries = [E('2026-02-01', 'se.meals', 400), E('2026-02-02', 'se.office', 100), E('2026-02-03', 'se.car', 500), E('2026-02-04', 'se.miles', 1000), E('2026-12-31', 'se.total_miles', 4000)];
  const r = Rules.compute(entries, base);
  assert.equal(r.scheduleC.meals.deductible, 200);
  assert.equal(r.scheduleC.vehicle.milesValue, 725);
  assert.equal(r.scheduleC.vehicle.methodConflict, true);
  assert.equal(r.scheduleC.vehicle.best, 'standard');
  assert.equal(r.scheduleC.vehicle.businessUseShare, 0.25);
  assert.equal(r.scheduleC.total, 100 + 200 + 725);
  assert.ok(r.insights.some((i) => /Pick one vehicle method/.test(i.title)));
  // total miles is information only — never a dollar value
  assert.equal(r.sections.selfemp.value, 100 + 400 + 500 + 725);
});

test('entries from other years are ignored; duplicates are detected', () => {
  const entries = [E('2025-03-01', 'med.doctor', 100), E('2026-03-01', 'med.doctor', 100), E('2026-03-01', 'med.doctor', 100, { id: 'dupe' })];
  const r = Rules.compute(entries, base);
  assert.equal(r.entries.length, 2);
  assert.equal(r.duplicates.length, 1);
  assert.ok(r.insights.some((i) => /duplicate/.test(i.title)));
});

test('unknown years fall back to the nearest known parameters and say so', () => {
  const r = Rules.compute([], { ...base, taxYear: 2031 });
  assert.equal(r.params.baseYear, 2026);
  assert.equal(r.params.isFallback, true);
  assert.ok(r.insights.some((i) => /No built-in figures/.test(i.title)));
  assert.equal(Rules.compute([], { ...base, taxYear: 2019 }).params.baseYear, 2024);
});

test('parameter overrides apply per year', () => {
  const r = Rules.compute([E('2026-02-02', 'med.miles', 100)], { ...base, agi: 1000, paramOverrides: { 2026: { mileage: { medical: 0.5 }, standardDeduction: { single: 20000 } } } });
  assert.equal(r.scheduleA.medical.gross, 50);
  assert.equal(r.standardDeduction.base, 20000);
  assert.equal(r.params.hasOverrides, true);
});

test('state awareness: no-income-tax states get the sales-tax note instead of the timing note', () => {
  const e = [E('2026-04-15', 'tax.state_income', 640)];
  const tx = Rules.compute(e, { ...base, state: 'tx' });
  assert.equal(tx.state, 'TX');
  assert.ok(tx.insights.some((i) => /sales tax may be the better claim/.test(i.title)));
  assert.ok(!tx.insights.some((i) => /timing matters/.test(i.title)));
  const nc = Rules.compute(e, { ...base, state: 'NC' });
  assert.ok(nc.insights.some((i) => /timing matters/.test(i.title)));
  assert.ok(!nc.insights.some((i) => /sales tax/.test(i.title)));
  assert.equal(Rules.compute(e, base).state, null);
});

test('formatting helpers', () => {
  assert.equal(Rules.money(1234.56), '$1,235');
  assert.equal(Rules.moneyCents(1234.5), '$1,234.50');
  assert.equal(Rules.pct(0.075), '7.5%');
  assert.equal(Rules.perMile(0.725), '72.5¢/mile');
  assert.equal(Rules.perMile(0.14), '14¢/mile');
});
