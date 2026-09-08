const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/classify.js');
const S = require('../js/schema.js');

const top = (text, opts) => C.classify(text, opts).suggestions[0]?.lineId;
const strong = (text, lineId) => C.classify(text).suggestions.some((s) => s.lineId === lineId && s.score >= 0.9);

test('a two-letter state code or a generic word is not a Doctor visit', () => {
  assert.ok(!C.classify('SAFEWAY BALTIMORE MD').suggestions.some((s) => s.lineId === 'med.doctor'));
  assert.ok(!strong('Dr Pepper 12 pack', 'med.doctor'), 'a soft drink is not a doctor');
  assert.notEqual(top('DR HORTON HOMES'), 'med.doctor');
  assert.notEqual(top('Dr Martens boots'), 'med.doctor');
  assert.equal(top('Dr Patel'), 'med.doctor', 'a title plus a name still is');
  assert.equal(top('dr visit copay'), 'med.doctor');
  assert.ok(!strong('carpet cleaning', 'med.dental'));
  assert.ok(!strong('museum admission', 'med.hospital'));
  assert.ok(!strong('toilet paper', 'se.office'));
  assert.equal(top('printer paper'), 'se.office');
  assert.equal(top('teeth cleaning'), 'med.dental');
});

test('personal gifts warn instead of filing as charity; gifts to organizations still do', () => {
  for (const t of ['gift card', 'birthday gift for mom', 'wedding gift']) {
    const r = C.classify(t);
    assert.ok(r.nonDeductible.length >= 1, t);
    assert.ok(!r.suggestions.some((s) => s.lineId === 'ch.org' && s.score >= 0.9), t);
  }
  assert.equal(top('gift to United Way'), 'ch.org');
  assert.equal(top('donations to food bank'), 'ch.org');
});

test('vets, K-12 tuition, life insurance and personal subscriptions carry a warning', () => {
  assert.ok(C.classify('VCA Animal Hospital').nonDeductible.length >= 1);
  assert.ok(C.classify('private school tuition').nonDeductible.length >= 1);
  assert.ok(C.classify('preschool tuition').nonDeductible.length >= 1);
  assert.ok(C.classify('life insurance premium').nonDeductible.length >= 1);
  assert.ok(!C.classify('life insurance premium').suggestions.some((s) => s.lineId === 'med.insurance'));
  assert.equal(top('health insurance premium'), 'med.insurance');
  assert.equal(top('auto insurance premium'), 'se.car');
  assert.ok(C.classify('Netflix').nonDeductible.length >= 1);
  assert.ok(C.classify('nanny').nonDeductible.length >= 1);
});

test('car loan interest is not Student Loan Interest', () => {
  const r = C.classify('car loan interest');
  assert.ok(r.nonDeductible.length >= 1);
  assert.ok(!r.suggestions.some((s) => s.lineId === 'edu.loan_interest'));
  assert.equal(top('Navient student loan interest'), 'edu.loan_interest');
  assert.equal(top('US Dept of Education student ln'), 'edu.loan_interest');
});

test('federal tax payments warn and are never offered as State Income Tax', () => {
  for (const t of ['IRS USATAXPYMT', 'IRS estimated tax', 'EFTPS payment', 'US Treasury 1040ES']) {
    const r = C.classify(t);
    assert.ok(r.nonDeductible.length >= 1, t);
    assert.ok(!r.suggestions.some((s) => /^tax\./.test(s.lineId) && s.score >= 0.9), t);
  }
  assert.equal(top('state estimated tax payment'), 'tax.state_income');
  assert.equal(top('Franchise Tax Board'), 'tax.state_income');
});

test('brand names only match the business they belong to', () => {
  assert.ok(!C.classify('Caliber Collision').suggestions.some((s) => s.lineId === 'int.mortgage'));
  assert.equal(top('Caliber Home Loans'), 'int.mortgage');
  assert.equal(top('Frontier internet bill'), 'se.utilities');
  assert.equal(top('Frontier Airlines'), 'se.travel');
  assert.equal(top('Delta Air Lines'), 'se.travel');
  assert.equal(top('Delta Dental'), 'med.insurance');
  assert.ok(!C.classify('Spirit Halloween').suggestions.some((s) => s.lineId === 'se.travel'));
});

test('statement spellings: no apostrophes, MTG, DDS, optical, copays', () => {
  assert.equal(top('MCDONALDS #4412'), 'se.meals');
  assert.equal(top("McDonald's"), 'se.meals');
  assert.equal(top('HOME MTG PYMT'), 'int.mortgage');
  assert.equal(top('SMITH FAMILY DENTISTRY'), 'med.dental');
  assert.equal(top('JOHN DOE DDS'), 'med.dental');
  assert.equal(top('LENS OPTICAL'), 'med.glasses');
  assert.equal(top('copays'), 'med.doctor');
  assert.equal(top('GEICO'), 'se.car');
});

test('learned short generic words no longer hijack unrelated entries', () => {
  const learned = C.learn({}, 'gas', 'se.utilities');
  assert.equal(top('gas', { learned }), 'se.utilities', 'the exact key still wins');
  assert.equal(top('shell gas fill up', { learned }), 'se.car', 'a 3-letter learned key does not match as a substring');
  const learned2 = C.learn({}, 'Aspen Dental', 'med.dental');
  assert.equal(top('Aspen Dental crown', { learned: learned2 }), 'med.dental');
  // the capture view classifies description and raw text together; the description alone is still the learned key
  assert.equal(top('Gas $40 gas', { learned, description: 'Gas' }), 'se.utilities');
  // keys learned before apostrophes were stripped still match
  assert.equal(top("Joe's Auto oil change", { learned: { "joe's auto": 'se.repairs' } }), 'se.repairs');
  // form numbers keep their identity in the key
  assert.notEqual(C.keyFor('form 1098e'), C.keyFor('form 1099k'));
  assert.equal(C.keyFor('Shell #1234 $40.12'), 'shell');
});

test('section context only falls back to a real catch-all line', () => {
  assert.equal(top('school'), 'edu.expenses');
  assert.equal(C.classify('tax').suggestions.length, 0, 'no fallback for taxes');
  assert.equal(C.classify('loan').suggestions.length, 0, 'no fallback for interest');
});

test('the limit option caps suggestions, the key is the learned-map key, and more never-deductible groups warn', () => {
  const full = C.classify('office supplies');
  assert.ok(full.suggestions.length >= 2, 'an ambiguous phrase offers several lines');
  assert.ok(full.suggestions.length <= 4, 'four by default');
  const one = C.classify('office supplies', { limit: 1 });
  assert.equal(one.suggestions.length, 1); assert.equal(one.suggestions[0].lineId, full.suggestions[0].lineId);
  assert.equal(C.classify('CVS #123').key, 'cvs');
  const political = C.classify('ActBlue donation');
  assert.equal(political.nonDeductible.length, 1); assert.match(political.nonDeductible[0].reason, /Political/);
  assert.match(C.classify('daycare for Sam').nonDeductible[0].reason, /2441|credit/i);
});

test('a title and a surname is a doctor visit, even when the surname is a keyword somewhere else', () => {
  assert.equal(top('Dr Walker'), 'med.doctor');
  assert.equal(top('DR WALKER MD'), 'med.doctor');
  assert.equal(top('Dr Cox'), 'med.doctor');
  assert.equal(top('Dr Ward'), 'med.doctor');
  assert.equal(top('Dr Smith office'), 'med.doctor');
  assert.ok(!C.classify('KROGER 500 OAK DR').suggestions.some((s) => s.lineId === 'med.doctor'));
  assert.equal(top('SHELL 1234 MAIN DR RALEIGH NC'), 'se.car', 'a street address is not a doctor');
});

test('practice names on a statement reach a real medical line', () => {
  assert.equal(top('TRIANGLE PEDIATRICS'), 'med.doctor');
  assert.equal(top('DUKE CARDIOLOGY'), 'med.doctor');
  assert.equal(top('ASSOCIATED PHYSICIANS PA'), 'med.doctor');
  assert.equal(top('CAROLINA DERMATOLOGY'), 'med.doctor');
  assert.equal(top('INTERNAL MEDICINE ASSOC'), 'med.doctor');
  assert.equal(top('WAKEMED PHYSICIAN PRACTICE'), 'med.doctor');
  assert.equal(top('ACME FAMILY PRACTICE'), 'med.doctor');
  assert.equal(top('REX MEDICAL CENTER'), 'med.hospital');
  // "medical" on its own is only the section fallback, far below the score that auto-selects a line
  assert.equal(C.classify('medical').suggestions[0].lineId, 'med.other');
  assert.ok(C.classify('medical').suggestions[0].score < 0.9);
});

test('plurals match the singular keyword the schema carries', () => {
  assert.equal(top('medications'), 'med.prescriptions');
  assert.equal(top('doctors visit'), 'med.doctor');
  assert.equal(top('dentists'), 'med.dental');
  assert.equal(top('x-rays'), 'med.lab');
  assert.equal(top('flights to Denver'), 'se.travel');
  assert.equal(top('Smith Dermatology'), 'med.doctor');
  // stemming only adds matches: the guards that were green stay green
  assert.ok(!C.classify('SAFEWAY BALTIMORE MD').suggestions.some((s) => s.lineId === 'med.doctor'));
  assert.equal(top('gas'), 'se.car');
  assert.ok(C.classify('Netflix').nonDeductible.length >= 1);
});

test('an ambiguous word does not outrank the specific one next to it', () => {
  assert.equal(top('emergency plumber'), 'se.repairs');
  assert.equal(top('attorney retainer'), 'se.professional');
  assert.equal(top('legal retainer fee'), 'se.professional');
  assert.equal(top('monthly retainer fee for the lawyer'), 'se.professional');
  assert.equal(top('Shell filling station'), 'se.car');
  assert.notEqual(top('picture frames'), 'med.glasses');
  assert.ok(!C.classify('Sling TV').suggestions.some((s) => s.lineId === 'med.canes'));
  assert.ok(strong('bp monitor', 'med.supplies'));
  // and the specific words still work
  assert.equal(top('ER visit'), 'med.hospital');
  assert.equal(top('teeth cleaning'), 'med.dental');
  assert.equal(top('LENS OPTICAL'), 'med.glasses');
  assert.equal(top('orthodontic retainer'), 'med.dentures');
  assert.equal(top('new retainer from the orthodontist'), 'med.dentures');
  assert.equal(top('invisalign retainer'), 'med.dentures');
});

test('an exact tie goes to the line with the longer matched keyword, not the first line id', () => {
  const tied = C.classify('gp chiropractor', { weights: { gp: 2, chiropractor: 1.5 } }).suggestions;
  assert.equal(tied[0].score, tied[1].score, 'the two lines really do tie');
  assert.deepEqual(tied.map((s) => s.lineId), ['med.therapy', 'med.doctor']);
});

test('everyday purchases are not filed on a medical, travel, gambling or rent line', () => {
  assert.ok(C.classify('SLING TV').nonDeductible.length >= 1);
  assert.ok(!C.classify('SLING TV').suggestions.some((s) => /^med\./.test(s.lineId) && s.score >= 0.9));
  assert.equal(top('SOUTHWEST GAS CORP'), 'se.utilities');
  assert.equal(top('Southwest Airlines flight'), 'se.travel');
  assert.equal(top('Caesars Palace hotel'), 'se.travel');
  assert.equal(top('Caesars casino'), 'oth.gambling');
  assert.notEqual(top('Costco Warehouse'), 'se.rent');
  assert.equal(top('warehouse rent'), 'se.rent');
  assert.notEqual(top('designer handbag'), 'se.professional');
  assert.equal(top('graphic designer invoice'), 'se.professional');
  assert.notEqual(top('Vineyard Vines'), 'ch.worship');
  assert.equal(top('Vineyard Church tithe'), 'ch.worship');
});

test('insurance on a home is a premium, not a casualty loss', () => {
  for (const t of ['flood insurance premium', 'fire insurance', 'hazard insurance escrow']) {
    assert.ok(C.classify(t).nonDeductible.length >= 1, t);
    assert.ok(!C.classify(t).suggestions.some((s) => s.lineId === 'cas.loss'), t);
  }
  assert.ok(!C.classify('Amazon Fire tablet').suggestions.some((s) => s.lineId === 'cas.loss'));
  assert.equal(top('flood damage to basement'), 'cas.loss');
  assert.equal(top('house fire'), 'cas.loss');
});

test('cookies bought from a youth group and Sierra Club dues warn instead of being filed', () => {
  for (const t of ['Girl Scout cookies', 'Girl Scouts cookies']) {
    assert.ok(C.classify(t).nonDeductible.length >= 1, t);
    assert.ok(!C.classify(t).suggestions.some((s) => (s.lineId === 'vol.expenses' || s.lineId === 'ch.org') && s.score >= 0.9), t);
  }
  assert.ok(C.classify('Sierra Club').nonDeductible.length >= 1);
  assert.equal(top('sierra club foundation'), 'ch.org');
  assert.equal(top('girl scouts uniform'), 'vol.expenses', 'real volunteer costs still count');
});

test('a car loan carries the 2025-2028 vehicle-interest rule, a credit card does not', () => {
  const car = C.classify('car loan interest').nonDeductible[0].reason;
  assert.match(car, /\$10,000/);
  assert.match(car, /2025 through 2028/);
  assert.ok(!/\$10,000/.test(C.classify('credit card interest').nonDeductible[0].reason));
  assert.ok(C.classify('car payment').nonDeductible.length >= 1);
  assert.ok(!strong('car payment', 'se.car'));
});

test('statement dates drop out of the learned key, so the same payee matches next month', () => {
  assert.equal(C.keyFor('CVS/PHARMACY #04412 BALTIMORE MD 03/14'), 'cvs/pharmacy baltimore md');
  assert.equal(C.keyFor('CVS/PHARMACY #04412 BALTIMORE MD 04/02'), 'cvs/pharmacy baltimore md');
  assert.ok(!/\d/.test(C.keyFor('PURCHASE AUTHORIZED ON 03/14 SQ *SHOP')));
  const learned = C.learn({}, 'CVS/PHARMACY #04412 BALTIMORE MD 03/14', 'se.supplies');
  const later = C.classify('CVS/PHARMACY #04412 BALTIMORE MD 04/02', { learned }).suggestions[0];
  assert.equal(later.lineId, 'se.supplies');
  assert.equal(later.learned, true);
  // form numbers keep their identity, and amounts still drop out
  assert.notEqual(C.keyFor('form 1098e'), C.keyFor('form 1099k'));
  assert.equal(C.keyFor('Shell #1234 $40.12'), 'shell');
});

test('line hints and treatments describe what the app actually does', () => {
  const casualty = S.getLine('cas.loss').hint;
  assert.ok(!/only if attributable to a federally declared disaster/i.test(casualty));
  assert.match(casualty, /state|governor/i);
  assert.match(casualty, /qualified disaster/i);
  assert.match(casualty, /4684/);
  assert.match(casualty, /10% of AGI/);
  assert.match(S.TREATMENTS['A-casualty'].label, /declared disasters/i);
  assert.ok(!/federal disasters/i.test(S.TREATMENTS['A-casualty'].label));
  assert.match(S.getLine('tax.state_income').hint, /Settings/);
  assert.ok(!/already on your W-2/i.test(S.getLine('tax.state_income').hint));
  // both limits are applied from a figure the taxpayer sets, so both hints send them to Settings
  const ltcHint = S.getLine('med.ltc').hint, invHint = S.getLine('int.investment').hint;
  assert.match(ltcHint, /Settings/);
  assert.match(ltcHint, /preparer/, 'a second policy at another age is still the preparer\'s to apply');
  assert.ok(!/holds back only an amount above the highest limit/.test(ltcHint));
  assert.match(invHint, /Settings/);
  assert.ok(!/without applying that limit/.test(invHint));
});

test('the long-term-care hint gives the shape of the limit: five age bands, one per insured person', () => {
  const ltc = S.getLine('med.ltc').hint;
  assert.match(ltc, /five age bands/i);
  assert.match(ltc, /each insured person/i);
  assert.match(ltc, /each spouse/i, 'a joint return has two limits, not one');
  // the figures themselves move every year and live in the engine's params, not in the worksheet text
  assert.ok(!/\$\s*\d/.test(ltc), 'no dollar figure is baked into the hint');
});

test('a treatment label never quotes a rate or a dollar figure, because both are editable', () => {
  for (const [id, t] of Object.entries(S.TREATMENTS)) {
    assert.ok(!/\d+(\.\d+)?\s*%|\$\s*\d/.test(t.label), `${id}: ${t.label}`);
  }
  assert.equal(S.TREATMENTS['A-medical'].label, 'Medical (above the AGI floor)');
});

test('the charity hints warn at capture time about what a non-itemizer cannot count', () => {
  assert.match(S.getLine('ch.org').hint, /donor-advised fund/i);
  assert.match(S.getLine('ch.org').hint, /without itemizing/i);
  // the education hint leaves this year's classroom cap to Insights rather than naming a figure
  const edu = S.getLine('edu.expenses').hint;
  assert.ok(!/\$\s*\d/.test(edu), 'no classroom-expense figure is baked into the hint');
  assert.match(edu, /Insights/);
});

test('no line promises a credit and an above-the-line deduction at once', () => {
  for (const l of S.LINES) {
    const t = S.TREATMENTS[l.treatment];
    assert.ok(!(/credit/i.test(t.label) && /above the line/i.test(l.hint || '')), l.id);
  }
  assert.equal(S.getLine('edu.expenses').treatment, 'info');
});
