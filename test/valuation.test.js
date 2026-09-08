const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/valuation.js');

test('the catalog is sane: every range is positive and low is below high', () => {
  assert.ok(V.CATALOG.length > 60);
  for (const c of V.CATALOG) { assert.ok(c.low > 0 && c.high > c.low, c.name); assert.ok(V.CATEGORIES.includes(c.category)); }
});

test('search finds items by whole or partial words, best first', () => {
  assert.equal(V.find('sofa')[0].name, 'Sofa');
  assert.equal(V.find('jeans')[0].name, 'Pants or jeans');
  assert.ok(V.find('shoes').some((c) => c.name === 'Shoes (pair)'));
  assert.equal(V.find("child's shirt")[0].name, "Child's shirt or top");
  assert.equal(V.find('zzz').length, 0);
  assert.equal(V.find('').length, 10);
  assert.equal(V.byName('Lamp').category, 'Household');
});

test('suggested value follows condition within the range, in quarter dollars', () => {
  const shirt = V.byName('Shirt or blouse');
  assert.equal(V.suggestValue(shirt, 'good'), 2.5);
  assert.equal(V.suggestValue(shirt, 'very-good'), 7.25);
  assert.equal(V.suggestValue(shirt, 'excellent'), 12);
  assert.equal(V.suggestValue(shirt, 'nonsense'), 2.5, 'unknown condition falls back to good');
  assert.equal(V.suggestValue(null, 'good'), null);
});

test('totals, counts, summary, and the record text', () => {
  const items = [
    { name: 'Shirt or blouse', qty: 4, condition: 'good', value: 3 },
    { name: 'Pants or jeans', qty: 2, condition: 'very-good', value: 7.75 },
    { name: 'Lamp', qty: 1, condition: 'excellent', value: 40 },
  ];
  assert.equal(V.total(items), 12 + 15.5 + 40);
  assert.equal(V.count(items), 7);
  assert.equal(V.summarize(items), '7 items: 4× Shirt or blouse, 2× Pants or jeans, 1× Lamp');
  const rec = V.recordText(items, 'Goodwill', '2026-05-10');
  assert.match(rec, /Donated to Goodwill on 2026-05-10/);
  assert.match(rec, /4× Shirt or blouse \(good\) @ \$3\.00 = \$12\.00/);
  assert.match(rec, /Total \$67\.50\./);
  assert.deepEqual(V.thresholds(67.5), { form8283: false, appraisal: false });
  assert.deepEqual(V.thresholds(600), { form8283: true, appraisal: false });
  assert.deepEqual(V.thresholds(6000), { form8283: true, appraisal: true });
});

test('the words people actually type find the catalog row, and appliances are in it', () => {
  assert.equal(V.find('couch')[0].name, 'Sofa');
  assert.equal(V.find('bike')[0].name, 'Bicycle');
  assert.equal(V.find('fridge')[0].name, 'Refrigerator');
  assert.equal(V.find('television')[0].name, 'Flat-screen TV');
  assert.equal(V.byName('fridge').name, 'Refrigerator');
  assert.equal(V.find('washer')[0].name, 'Washing machine');
  assert.equal(V.find('dryer')[0].name, 'Clothes dryer');
  assert.equal(V.find('stove')[0].name, 'Stove or range');
  assert.equal(V.find('mattress')[0].name, 'Mattress');
  // a name match still outranks an alias match
  assert.equal(V.find('sofa')[0].name, 'Sofa');
  assert.equal(V.find('jeans')[0].name, 'Pants or jeans');
  assert.equal(V.find('zzz').length, 0);
});

test('aliases are lower case, spelled once, and never repeat a catalog name', () => {
  const seen = new Set(V.CATALOG.map((c) => c.name.toLowerCase()));
  for (const c of V.CATALOG) {
    assert.ok(Array.isArray(c.aliases), c.name);
    for (const a of c.aliases) {
      assert.equal(a, a.toLowerCase().trim(), c.name);
      assert.ok(a.length > 0, c.name);
      assert.ok(!seen.has(a), `${a} is already a catalog name or alias`);
      seen.add(a);
    }
  }
});
