/*
 * experiments.js — short-lived data the app collects about its own judgement,
 * and how it checks that judgement later.
 *
 * Three experiments, all on the device, all switchable, all expiring:
 *
 *   1. Forecast snapshots. Once a month the advisor's year-end forecast is
 *      written down. When the tax year is over, each snapshot is compared with
 *      the final figure; the advisor learns how far it tends to run high or
 *      low and calibrates the "expected to come" part of future forecasts.
 *      Snapshots older than KEEP_MONTHS are dropped.
 *   2. Correction learning. When a suggested worksheet line is overridden, the
 *      keywords that produced the wrong suggestion lose weight for this user
 *      and the keywords behind the chosen line gain some. Weights that drift
 *      back to 1 are forgotten.
 *   3. Session nudges (in app.js). Right after an entry is saved, the app may
 *      offer one follow-up based only on what was just logged. Nothing about
 *      that is stored.
 *
 * Nothing here leaves the device. Pure functions; tested under node --test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerExperiments = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEEP_MONTHS = 24;
  // Keeping the top suggestion is weak evidence, so acceptance saturates well below the cap an
  // explicit correction can reach: a common single word must not ratchet past a longer phrase.
  const WEIGHT_FLOOR = 0.2, WEIGHT_CAP = 2.5, ACCEPT_CAP = 1.2;
  const r2 = (n) => Math.round(n * 100) / 100;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const monthKey = (iso) => String(iso || '').slice(0, 7);
  function monthsBetween(a, b) {
    const [ay, am] = String(a).split('-').map(Number), [by, bm] = String(b).split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // ---- forecast snapshots ---------------------------------------------------------

  // The settings a forecast was made under. They ride along on the snapshot so a finished year is graded the way it
  // was projected: a filing status or an AGI entered later must not change what a past forecast is compared with.
  const CARRIED_SETTINGS = ['agi', 'filingStatus', 'age65', 'blind', 'spouseAge65', 'spouseBlind'];

  /**
   * Add or refresh this month's snapshot for a tax year and drop stale ones.
   * @param {Array} list  existing snapshots
   * @param {{today, taxYear, actual, expectedMore, projectedTotal, standardDeduction, itemize}} s
   *   may also carry the settings of CARRIED_SETTINGS; the ones it does not carry are left off the row
   * @returns {Array} a new list
   */
  function snapshot(list, s) {
    const key = monthKey(s.today);
    const rest = (list || []).filter((x) => !(x.month === key && x.taxYear === s.taxYear));
    const row = { month: key, taxYear: Number(s.taxYear), takenOn: s.today, actual: r2(s.actual), expectedMore: r2(s.expectedMore), projectedTotal: r2(s.projectedTotal), standardDeduction: r2(s.standardDeduction), itemize: !!s.itemize };
    // a setting that is not there says nothing, so it is left off: an old row and a new one then look the same
    for (const k of CARRIED_SETTINGS) if (s[k] !== undefined && s[k] !== null && s[k] !== '') row[k] = s[k];
    rest.push(row);
    rest.sort((a, b) => a.month.localeCompare(b.month) || a.taxYear - b.taxYear);
    return rest.filter((x) => monthsBetween(x.month, key) <= KEEP_MONTHS);
  }

  /** True when a snapshot differs enough from the stored one to be worth saving. */
  function changed(list, s) {
    const key = monthKey(s.today);
    const cur = (list || []).find((x) => x.month === key && x.taxYear === Number(s.taxYear));
    if (!cur) return true;
    return Math.abs(cur.projectedTotal - s.projectedTotal) >= 1 || Math.abs(cur.actual - s.actual) >= 1 || cur.itemize !== !!s.itemize;
  }

  /**
   * Compare past forecasts for finished years with the final figure.
   * @param {Array} list       snapshots
   * @param {Object} finals    { [taxYear]: final Schedule A total after limits }
   */
  function validate(list, finals) {
    const rows = [];
    for (const x of list || []) {
      const final = finals && finals[x.taxYear];
      if (final == null) continue;
      const actualRemaining = r2(final - x.actual);
      const predictedRemaining = x.expectedMore;
      const meaningful = predictedRemaining >= Math.max(100, 0.05 * final);
      rows.push({
        taxYear: x.taxYear, month: x.month, projectedTotal: x.projectedTotal, final,
        error: r2(x.projectedTotal - final),
        pct: final > 0 ? r4((x.projectedTotal - final) / final) : null,
        ratio: meaningful ? r4(actualRemaining / predictedRemaining) : null,
        verdictRight: x.itemize === final > x.standardDeduction,
      });
    }
    return rows;
  }

  /** Multiplier for the "expected to come" part of a forecast, learned from finished years. */
  function calibration(rows) {
    const ratios = (rows || []).map((r) => r.ratio).filter((r) => r != null && isFinite(r));
    if (ratios.length < 3) return { factor: 1, n: ratios.length, basis: ratios.length ? 'fewer than three finished forecasts' : 'no finished forecasts yet' };
    const factor = Math.min(1.5, Math.max(0.5, median(ratios)));
    return { factor: r4(factor), n: ratios.length, basis: `median of ${ratios.length} finished forecasts` };
  }

  function summary(rows) {
    const withPct = (rows || []).filter((r) => r.pct != null);
    if (!withPct.length) return null;
    const bias = withPct.reduce((a, r) => a + r.pct, 0) / withPct.length;
    const mae = withPct.reduce((a, r) => a + Math.abs(r.pct), 0) / withPct.length;
    const right = (rows || []).filter((r) => r.verdictRight).length;
    return { n: withPct.length, biasPct: r4(bias), maePct: r4(mae), verdictRight: right, verdictTotal: (rows || []).length };
  }

  // ---- correction learning --------------------------------------------------------

  /**
   * Update keyword weights after the user picks a line.
   * @param {Object} weights        { keyword: multiplier }
   * @param {string} suggestedLineId the top suggestion
   * @param {string[]} because       keywords that produced it
   * @param {string} chosenLineId    what the user chose
   * @param {string[]} chosenBecause keywords that pointed at the chosen line
   */
  function applyCorrection(weights, suggestedLineId, because, chosenLineId, chosenBecause) {
    const w = Object.assign({}, weights || {});
    const get = (k) => (w[k] == null ? 1 : w[k]);
    if (!chosenLineId || suggestedLineId === chosenLineId) {
      for (const k of because || []) w[k] = r3(Math.min(ACCEPT_CAP, get(k) * 1.05));
    } else {
      for (const k of because || []) w[k] = r3(Math.max(WEIGHT_FLOOR, get(k) * 0.7));
      for (const k of chosenBecause || []) w[k] = r3(Math.min(WEIGHT_CAP, get(k) * 1.25));
    }
    for (const k of Object.keys(w)) if (Math.abs(w[k] - 1) < 0.02 || !isFinite(w[k])) delete w[k];
    return w;
  }

  /** Keywords the classifier reports as reasons; pseudo reasons are not weights. */
  const isKeyword = (k) => typeof k === 'string' && !/here before|section context|^miles|odometer|^title and name$/.test(k);

  return { KEEP_MONTHS, WEIGHT_FLOOR, WEIGHT_CAP, ACCEPT_CAP, CARRIED_SETTINGS, monthKey, snapshot, changed, validate, calibration, summary, applyCorrection, isKeyword };
});
