const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/classify.js');

const top = (text, opts) => C.classify(text, opts).suggestions[0]?.lineId;

test('common payees land on the right line', () => {
  assert.equal(top('CVS pharmacy'), 'med.prescriptions');
  assert.equal(top('Dr. Lee copay'), 'med.doctor');
  assert.equal(top('Tithe'), 'ch.worship');
  assert.equal(top('Lunch with client'), 'se.meals');
  assert.equal(top('property tax county treasurer'), 'tax.real_estate');
  assert.equal(top('Navient student loan interest'), 'edu.loan_interest');
  assert.equal(top('Goodwill drop-off'), 'ch.noncash');
  assert.equal(top('LensCrafters new glasses'), 'med.glasses');
  assert.equal(top('HELOC interest'), 'int.second');
  assert.equal(top('DraftKings'), 'oth.gambling');
});

test('context words disambiguate shared vocabulary', () => {
  assert.equal(top('donation to college alumni fund'), 'ch.college');
  assert.equal(top('college tuition fall semester'), 'edu.tuition');
  assert.equal(top('gas bill'), 'se.utilities');
  assert.equal(top('gas'), 'se.car');
});

test('miles route to mileage lines by section context', () => {
  assert.equal(top('Physical therapy', { miles: true }), 'med.miles');
  assert.equal(top('drove to client site', { miles: true }), 'se.miles');
  assert.equal(top('meals on wheels delivery', { miles: true }), 'vol.miles');
  assert.equal(top('odometer', { miles: true }), 'se.total_miles');
  // dollars typed: mileage lines are not offered unless "miles" is in the text
  assert.ok(!C.classify('Physical therapy').suggestions.some((s) => s.lineId === 'med.miles'));
});

test('learned payees outrank keywords and explain themselves', () => {
  const learned = C.learn({}, "Joe's Auto #12", 'se.car');
  assert.deepEqual(Object.values(learned), ['se.car']);
  const r = C.classify("Joe's Auto oil change", { learned });
  assert.equal(r.suggestions[0].lineId, 'se.car');
  assert.equal(r.suggestions[0].learned, true);
  const learned2 = C.learn({}, 'Anthem', 'med.insurance');
  assert.equal(top('Anthem premium', { learned: learned2 }), 'med.insurance');
  // an exact learned key wins even against strong keywords
  const learned3 = C.learn({}, 'CVS pharmacy', 'se.supplies');
  assert.equal(top('CVS pharmacy', { learned: learned3 }), 'se.supplies');
  C.forget(learned3, C.keyFor('CVS pharmacy'));
  assert.equal(Object.keys(learned3).length, 0);
});

test('non-deductible payments are warned about, not silently filed', () => {
  const r = C.classify('gofundme for coworker');
  assert.equal(r.nonDeductible.length, 1);
  assert.match(r.nonDeductible[0].reason, /individuals/);
  assert.equal(C.classify('raffle tickets at church').nonDeductible.length, 1);
  assert.equal(C.classify('miles to work', { miles: true }).nonDeductible.length, 1);
  assert.equal(C.classify('CVS pharmacy').nonDeductible.length, 0);
});

test('every suggestion carries the words that produced it', () => {
  const r = C.classify('CVS pharmacy');
  assert.ok(r.suggestions[0].because.includes('cvs'));
  assert.ok(r.suggestions[0].because.includes('pharmacy'));
});

test('empty and unknown input', () => {
  assert.equal(C.classify('').suggestions.length, 0);
  assert.equal(C.classify('random thing').suggestions.length, 0);
  assert.equal(C.classify(null).nonDeductible.length, 0);
});

test('parking and tolls on a business trip are an Other expense, not an actual car expense', () => {
  assert.equal(top('12 parking for work'), 'se.other');
  assert.equal(top('tolls for work'), 'se.other');
  assert.equal(top('business parking'), 'se.other');
  assert.equal(top('gas'), 'se.car', 'the vehicle line still holds the actual expenses');
  assert.equal(C.classify('parking at work').nonDeductible.length, 1, 'commuting still warns');
});
