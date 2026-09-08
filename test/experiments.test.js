const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../js/experiments.js');
const C = require('../js/classify.js');

const snap = (today, taxYear, actual, expectedMore, std, itemize) => ({ today, taxYear, actual, expectedMore, projectedTotal: actual + expectedMore, standardDeduction: std, itemize });

test('snapshots: one per month per year, refreshed in place, pruned after the keep window', () => {
  let list = X.snapshot([], snap('2026-03-15', 2026, 5000, 3000, 16100, false));
  list = X.snapshot(list, snap('2026-03-28', 2026, 5200, 2900, 16100, false));
  assert.equal(list.length, 1, 'same month replaces');
  assert.equal(list[0].actual, 5200);
  list = X.snapshot(list, snap('2026-04-05', 2026, 6000, 2500, 16100, false));
  assert.equal(list.length, 2);
  assert.equal(X.changed(list, snap('2026-04-05', 2026, 6000, 2500, 16100, false)), false);
  assert.equal(X.changed(list, snap('2026-04-05', 2026, 6002, 2500, 16100, false)), true);
  list = X.snapshot(list, snap('2028-05-01', 2028, 100, 100, 17000, false));
  assert.equal(list.length, 1, 'snapshots older than 24 months are gone');
  assert.equal(list[0].taxYear, 2028);
});

test('validation compares each forecast with the final figure and flags the verdict', () => {
  const list = [
    X.snapshot([], snap('2025-03-10', 2025, 4000, 6000, 15750, false))[0],
    X.snapshot([], snap('2025-06-10', 2025, 8000, 4000, 15750, false))[0],
    X.snapshot([], snap('2025-11-10', 2025, 14000, 3000, 15750, true))[0],
    X.snapshot([], snap('2026-02-10', 2026, 1000, 9000, 16100, false))[0],
  ];
  const rows = X.validate(list, { 2025: 16000 });
  assert.equal(rows.length, 3, 'only finished years are validated');
  assert.equal(rows[0].error, -6000);
  assert.equal(rows[0].ratio, 2); // 12,000 actually came vs 6,000 predicted
  assert.equal(rows[1].ratio, 2);
  assert.equal(rows[2].ratio, 0.6667);
  assert.equal(rows[0].verdictRight, false, 'said no-itemize, year itemized');
  assert.equal(rows[2].verdictRight, true);
  const s = X.summary(rows);
  assert.equal(s.n, 3);
  assert.equal(s.verdictRight, 1);
});

test('calibration is the clamped median ratio, only with enough finished forecasts', () => {
  assert.equal(X.calibration([]).factor, 1);
  assert.equal(X.calibration([{ ratio: 2 }, { ratio: 2 }]).factor, 1, 'two is not enough');
  assert.equal(X.calibration([{ ratio: 0.9 }, { ratio: 1.1 }, { ratio: 1.2 }]).factor, 1.1);
  assert.equal(X.calibration([{ ratio: 3 }, { ratio: 4 }, { ratio: 9 }]).factor, 1.5, 'clamped high');
  assert.equal(X.calibration([{ ratio: 0.1 }, { ratio: 0.2 }, { ratio: 0.3 }]).factor, 0.5, 'clamped low');
  assert.equal(X.calibration([{ ratio: 1 }, { ratio: null }, { ratio: 1.2 }, { ratio: 0.8 }]).n, 3);
});

test('corrections demote the wrong keywords, boost the right ones, and forget neutral weights', () => {
  let w = X.applyCorrection({}, 'se.car', ['gas'], 'se.utilities', ['gas bill']);
  assert.equal(w.gas, 0.7);
  assert.equal(w['gas bill'], 1.25);
  for (let i = 0; i < 10; i++) w = X.applyCorrection(w, 'se.car', ['gas'], 'se.utilities', ['gas bill']);
  assert.equal(w.gas, X.WEIGHT_FLOOR);
  assert.equal(w['gas bill'], X.WEIGHT_CAP);
  // acceptance reinforces gently and neutral weights are dropped
  const a = X.applyCorrection({ cvs: 0.96 }, 'med.prescriptions', ['cvs'], 'med.prescriptions', ['cvs']);
  assert.equal(a.cvs, undefined, '0.96 × 1.05 ≈ 1 is forgotten');
  assert.equal(X.isKeyword('you filed this here before'), false);
  assert.equal(X.isKeyword('pharmacy'), true);
});

test('the classifier honours learned keyword weights', () => {
  const base = C.classify('CVS pharmacy').suggestions[0].score;
  const half = C.classify('CVS pharmacy', { weights: { cvs: 0.5, pharmacy: 0.5 } }).suggestions[0].score;
  assert.ok(Math.abs(half - base / 2) < 0.01, `${half} vs ${base / 2}`);
  // a demoted keyword can change the ranking
  const plain = C.classify('gas').suggestions[0].lineId;
  assert.equal(plain, 'se.car');
  const learned = C.classify('gas', { weights: { gas: 0.2 } }).suggestions[0];
  assert.equal(learned.lineId, 'se.car', 'still the only candidate, but weaker');
  assert.ok(learned.score < C.classify('gas').suggestions[0].score);
});

test('accepting a suggestion reinforces gently and saturates below an explicit correction', () => {
  let w = {};
  for (let i = 0; i < 40; i++) w = X.applyCorrection(w, 'se.car', ['gas'], 'se.car', ['gas']);
  assert.equal(w.gas, X.ACCEPT_CAP);
  assert.ok(X.ACCEPT_CAP < X.WEIGHT_CAP);
  assert.equal(C.classify('gas bill', { weights: w }).suggestions[0].lineId, 'se.utilities', 'a boosted single word does not beat a two-word keyword');
  // a demoted keyword still heals back to neutral through acceptances
  let d = { gas: 0.2 };
  for (let i = 0; i < 40; i++) d = X.applyCorrection(d, 'se.car', ['gas'], 'se.car', ['gas']);
  assert.equal(d.gas, X.ACCEPT_CAP);
  assert.equal(X.isKeyword('title and name'), false, 'the honorific reason is not a keyword weight');
});
