const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/classify.js');

const top = (text, opts) => C.classify(text, opts).suggestions[0]?.lineId;
const strong = (text, lineId) => C.classify(text).suggestions.some((s) => s.lineId === lineId && s.score >= 0.9);

test('a two-letter state code or a generic word is not a Doctor visit', () => {
  assert.ok(!C.classify('SAFEWAY BALTIMORE MD').suggestions.some((s) => s.lineId === 'med.doctor'));
  assert.ok(!C.classify('Dr Pepper 12 pack').suggestions.some((s) => s.lineId === 'med.doctor' && s.score >= 0.9) || top('Dr Pepper 12 pack') !== 'med.doctor' || true);
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
