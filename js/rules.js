/*
 * rules.js — the tax intelligence.
 *
 * Given the year's entries and a few facts about the taxpayer (filing status,
 * estimated AGI, age), this computes what the worksheet actually turns into on
 * the return: Schedule A totals after floors and caps, the standard-vs-itemized
 * verdict, Schedule C, above-the-line items, substantiation gaps, and a list of
 * plain-English insights.
 *
 * Every rate and threshold lives in PARAMS and can be overridden from Settings.
 * Figures are for planning — the preparer and the IRS publications are the
 * authority for the actual return.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema.js'));
  else root.ItemizerRules = factory(root.ItemizerSchema);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Schema) {
  'use strict';

  const FILING_STATUSES = [
    { id: 'single', label: 'Single', married: false },
    { id: 'mfj', label: 'Married filing jointly', married: true },
    { id: 'mfs', label: 'Married filing separately', married: true },
    { id: 'hoh', label: 'Head of household', married: false },
    { id: 'qss', label: 'Qualifying surviving spouse', married: true },
  ];
  const FILING_BY_ID = Object.fromEntries(FILING_STATUSES.map((f) => [f.id, f]));
  /** States with no tax on wages: the sales-tax election is usually the better state-tax deduction there. */
  const NO_INCOME_TAX_STATES = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);
  /** The §213(d)(10) age bands: the value stored in settings, the params key holding that year's limit, and how to say it. */
  const LTC_BRACKETS = [
    { id: '40-', key: 'to40', label: '40 or under' },
    { id: '41-50', key: 'to50', label: '41 to 50' },
    { id: '51-60', key: 'to60', label: '51 to 60' },
    { id: '61-70', key: 'to70', label: '61 to 70' },
    { id: '71+', key: 'over70', label: '71 or older' },
  ];
  const LTC_BRACKET_BY_ID = Object.fromEntries(LTC_BRACKETS.map((b) => [b.id, b]));

  // ---- Tax-year parameters -------------------------------------------------
  // Sources: IRS Rev. Proc. 2023-34 / 2024-40 / 2025-32 (inflation adjustments),
  // IRS standard mileage notices (Notice 2026-10 and Announcement 2026-11 for 2026),
  // and P.L. 119-21 (2025) for the SALT cap, standard deduction, senior deduction,
  // charitable floor, and gambling-loss changes.
  // `mileage` holds the rates from January 1; `mileageJul` holds a mid-year set when
  // the IRS changed the rates during the year, and is null when it did not.
  const PARAMS = {
    2024: {
      standardDeduction: { single: 14600, mfj: 29200, mfs: 14600, hoh: 21900, qss: 29200 },
      additionalStdDed: { married: 1550, unmarried: 1950 },
      medicalFloorRate: 0.075,
      saltCap: { default: 10000, mfs: 5000 },
      saltPhaseout: null,
      mileage: { business: 0.67, medical: 0.21, charity: 0.14 },
      mileageJul: null,
      // §213(d)(10) eligible long-term-care premiums by age at the end of the year (Rev. Proc. 2023-34 §3.28).
      ltcPremiumLimits: { to40: 470, to50: 880, to60: 1760, to70: 4710, over70: 5880 },
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: { single: { start: 80000, end: 95000 }, mfj: { start: 165000, end: 195000 } },
      // §25A(d): the education-credit range is set by statute and is not indexed.
      educationCreditPhaseout: { single: { start: 80000, end: 90000 }, mfj: { start: 160000, end: 180000 } },
      educatorExpenseCap: 300,
      seniorDeduction: null,
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 1.0,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0,
      nonItemizerCharity: null,
      casualtyPerEvent: 100,
      casualtyQualifiedPerEvent: 500,
      qualifiedDisasterLoss: true,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
      pmiPhaseout: null,
    },
    2025: {
      standardDeduction: { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625, qss: 31500 },
      additionalStdDed: { married: 1600, unmarried: 2000 },
      medicalFloorRate: 0.075,
      saltCap: { default: 40000, mfs: 20000 },
      saltPhaseout: { start: { default: 500000, mfs: 250000 }, rate: 0.3, floor: { default: 10000, mfs: 5000 } },
      mileage: { business: 0.70, medical: 0.21, charity: 0.14 },
      mileageJul: null,
      ltcPremiumLimits: { to40: 480, to50: 900, to60: 1800, to70: 4810, over70: 6020 }, // Rev. Proc. 2024-40 §3.28
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: { single: { start: 85000, end: 100000 }, mfj: { start: 170000, end: 200000 } },
      educationCreditPhaseout: { single: { start: 80000, end: 90000 }, mfj: { start: 160000, end: 180000 } },
      educatorExpenseCap: 300,
      // P.L. 119-21 §70103: an extra $6,000 per person aged 65 or older for 2025 through 2028, itemizing or not.
      seniorDeduction: { perPerson: 6000, phaseoutStart: { default: 75000, mfj: 150000 }, rate: 0.06 },
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 1.0,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0,
      nonItemizerCharity: null,
      casualtyPerEvent: 100,
      casualtyQualifiedPerEvent: 500,
      qualifiedDisasterLoss: true,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
      pmiPhaseout: null,
    },
    2026: {
      standardDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150, qss: 32200 },
      additionalStdDed: { married: 1650, unmarried: 2050 },
      medicalFloorRate: 0.075,
      saltCap: { default: 40400, mfs: 20200 },
      saltPhaseout: { start: { default: 505000, mfs: 252500 }, rate: 0.3, floor: { default: 10000, mfs: 5000 } },
      mileage: { business: 0.725, medical: 0.205, charity: 0.14 }, // Notice 2026-10: Jan 1 – Jun 30
      mileageJul: { from: '2026-07-01', business: 0.76, medical: 0.235, charity: 0.14 }, // Announcement 2026-11: from Jul 1
      ltcPremiumLimits: { to40: 500, to50: 930, to60: 1860, to70: 4960, over70: 6200 }, // Rev. Proc. 2025-32 §3.27
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: { single: { start: 85000, end: 100000 }, mfj: { start: 175000, end: 205000 } }, // Rev. Proc. 2025-32
      educationCreditPhaseout: { single: { start: 80000, end: 90000 }, mfj: { start: 160000, end: 180000 } },
      educatorExpenseCap: 350, // Rev. Proc. 2025-32 §3.12
      seniorDeduction: { perPerson: 6000, phaseoutStart: { default: 75000, mfj: 150000 }, rate: 0.06 },
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 0.9,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0.005,
      nonItemizerCharity: { single: 1000, mfj: 2000 },
      casualtyPerEvent: 100,
      casualtyQualifiedPerEvent: 500,
      qualifiedDisasterLoss: false,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
      pmiPhaseout: { default: { start: 100000, end: 109000 }, mfs: { start: 50000, end: 54500 } }, // P.L. 119-21 §70108
    },
  };
  const KNOWN_YEARS = Object.keys(PARAMS).map(Number).sort();

  // Editable in Settings. `path` is dotted into the params object.
  const PARAM_FIELDS = [
    { path: 'standardDeduction.single', label: 'Standard deduction — Single', kind: 'usd' },
    { path: 'standardDeduction.mfj', label: 'Standard deduction — Married filing jointly', kind: 'usd' },
    { path: 'standardDeduction.mfs', label: 'Standard deduction — Married filing separately', kind: 'usd' },
    { path: 'standardDeduction.hoh', label: 'Standard deduction — Head of household', kind: 'usd' },
    { path: 'standardDeduction.qss', label: 'Standard deduction — Qualifying surviving spouse', kind: 'usd' },
    { path: 'additionalStdDed.married', label: 'Extra standard deduction per 65+/blind condition (married)', kind: 'usd' },
    { path: 'additionalStdDed.unmarried', label: 'Extra standard deduction per 65+/blind condition (unmarried)', kind: 'usd' },
    { path: 'medicalFloorRate', label: 'Medical floor (% of AGI)', kind: 'rate' },
    { path: 'saltCap.default', label: 'State & local tax cap', kind: 'usd' },
    { path: 'saltCap.mfs', label: 'State & local tax cap (married filing separately)', kind: 'usd' },
    { path: 'mileage.business', label: 'Business mileage rate (¢/mile)', kind: 'permile' },
    { path: 'mileage.medical', label: 'Medical mileage rate (¢/mile)', kind: 'permile' },
    { path: 'mileage.charity', label: 'Charitable mileage rate (¢/mile)', kind: 'permile' },
    { path: 'studentLoanInterestCap', label: 'Student loan interest cap', kind: 'usd' },
    { path: 'studentLoanPhaseout.single.start', label: 'Student loan interest phase-out starts', kind: 'usd' },
    { path: 'studentLoanPhaseout.single.end', label: 'Student loan interest phase-out ends', kind: 'usd' },
    { path: 'studentLoanPhaseout.mfj.start', label: 'Student loan interest phase-out starts (joint)', kind: 'usd' },
    { path: 'studentLoanPhaseout.mfj.end', label: 'Student loan interest phase-out ends (joint)', kind: 'usd' },
    { path: 'educationCreditPhaseout.single.start', label: 'Education credit phase-out starts', kind: 'usd' },
    { path: 'educationCreditPhaseout.single.end', label: 'Education credit phase-out ends', kind: 'usd' },
    { path: 'educationCreditPhaseout.mfj.start', label: 'Education credit phase-out starts (joint)', kind: 'usd' },
    { path: 'educationCreditPhaseout.mfj.end', label: 'Education credit phase-out ends (joint)', kind: 'usd' },
    { path: 'educatorExpenseCap', label: 'Educator classroom-expense deduction', kind: 'usd' },
    { path: 'ltcPremiumLimits.to40', label: 'Long-term-care premium limit — age 40 or under', kind: 'usd' },
    { path: 'ltcPremiumLimits.to50', label: 'Long-term-care premium limit — age 41 to 50', kind: 'usd' },
    { path: 'ltcPremiumLimits.to60', label: 'Long-term-care premium limit — age 51 to 60', kind: 'usd' },
    { path: 'ltcPremiumLimits.to70', label: 'Long-term-care premium limit — age 61 to 70', kind: 'usd' },
    { path: 'ltcPremiumLimits.over70', label: 'Long-term-care premium limit — over 70', kind: 'usd' },
    { path: 'mealsDeductibleRate', label: 'Business meals deductible share (%)', kind: 'rate' },
    { path: 'gamblingLossRate', label: 'Share of gambling losses allowed (%)', kind: 'rate' },
    { path: 'charityFloorRate', label: 'Charitable floor for itemizers (% of AGI)', kind: 'rate' },
    { path: 'charityCashAgiLimit', label: 'Charitable gift limit (% of AGI)', kind: 'rate' },
    { path: 'casualtyPerEvent', label: 'Casualty loss reduction per event', kind: 'usd' },
    { path: 'casualtyQualifiedPerEvent', label: 'Qualified disaster loss reduction per event', kind: 'usd' },
    { path: 'casualtyAgiRate', label: 'Casualty loss reduction (% of AGI)', kind: 'rate' },
    { path: 'nonCashForm8283', label: 'Non-cash gifts needing Form 8283', kind: 'usd' },
    { path: 'nonCashAppraisal', label: 'Non-cash gifts needing a qualified appraisal', kind: 'usd' },
    { path: 'acknowledgmentThreshold', label: 'Gift size needing written acknowledgment', kind: 'usd' },
    { path: 'receiptThreshold', label: 'Expense size flagged when no receipt', kind: 'usd' },
  ];

  // Rows that only exist in some years: shown when the year has a figure to correct.
  const CONDITIONAL_PARAM_FIELDS = [
    { path: 'mileageJul.business', label: 'Business mileage rate from July 1 (¢/mile)', kind: 'permile' },
    { path: 'mileageJul.medical', label: 'Medical mileage rate from July 1 (¢/mile)', kind: 'permile' },
    { path: 'mileageJul.charity', label: 'Charitable mileage rate from July 1 (¢/mile)', kind: 'permile' },
    { path: 'saltPhaseout.start.default', label: 'State & local cap phase-down starts', kind: 'usd' },
    { path: 'saltPhaseout.start.mfs', label: 'State & local cap phase-down starts (married filing separately)', kind: 'usd' },
    { path: 'saltPhaseout.rate', label: 'State & local cap phase-down (% of income above the threshold)', kind: 'rate' },
    { path: 'saltPhaseout.floor.default', label: 'State & local cap floor', kind: 'usd' },
    { path: 'saltPhaseout.floor.mfs', label: 'State & local cap floor (married filing separately)', kind: 'usd' },
    { path: 'nonItemizerCharity.single', label: 'Cash gift deduction without itemizing', kind: 'usd' },
    { path: 'nonItemizerCharity.mfj', label: 'Cash gift deduction without itemizing (joint)', kind: 'usd' },
    { path: 'seniorDeduction.perPerson', label: 'Senior deduction per person aged 65 or older', kind: 'usd' },
    { path: 'seniorDeduction.phaseoutStart.default', label: 'Senior deduction phase-out starts', kind: 'usd' },
    { path: 'seniorDeduction.phaseoutStart.mfj', label: 'Senior deduction phase-out starts (joint)', kind: 'usd' },
    { path: 'seniorDeduction.rate', label: 'Senior deduction phase-out (% of income above the threshold)', kind: 'rate' },
    { path: 'pmiPhaseout.default.start', label: 'Mortgage insurance phase-out starts', kind: 'usd' },
    { path: 'pmiPhaseout.default.end', label: 'Mortgage insurance phase-out ends', kind: 'usd' },
    { path: 'pmiPhaseout.mfs.start', label: 'Mortgage insurance phase-out starts (married filing separately)', kind: 'usd' },
    { path: 'pmiPhaseout.mfs.end', label: 'Mortgage insurance phase-out ends (married filing separately)', kind: 'usd' },
    // A yes/no row: the qualified-disaster window has been reopened by Congress before, and a filer
    // with a genuinely qualified loss needs a way to say so without waiting for a new release.
    { path: 'qualifiedDisasterLoss', label: 'Qualified disaster loss treatment is available', kind: 'bool' },
  ];

  // ---- helpers -------------------------------------------------------------

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Round half away from zero so a gain and a loss of the same size print the same,
  // and never show a signed zero: -$0 reads as a fall when nothing really moved.
  function money(n) {
    const v = Number(n) || 0;
    const r = (v < 0 ? -1 : 1) * Math.round(Math.abs(v));
    return usd.format(r === 0 ? 0 : r);
  }
  function moneyCents(n) { return usdCents.format(n || 0); }
  /** Margins decide the verdict, so print the cents when the whole-dollar figure would read as $0. */
  function moneyNear(n) { return Math.abs(Number(n) || 0) < 1 ? moneyCents(n) : money(n); }
  // Round the decimal figure half up, the way the IRS does, rather than the binary double:
  // 101 miles at 72.5¢ is 73.225 on paper, and $73.23 on the return. Halves go away from zero,
  // as in money(), so a gain and a loss of the same size round to the same figure.
  function cents(n) {
    const x = Number(n) || 0;
    const r = (x < 0 ? -1 : 1) * Math.round(Math.round(Math.abs(x) * 1e6) / 1e4);
    return r === 0 ? 0 : r / 100;
  }
  function pct(rate) { const p = rate * 100; return (Number.isInteger(p) ? p : p.toFixed(1).replace(/\.0$/, '')) + '%'; }
  function perMile(rate) { return (rate * 100).toFixed(1).replace(/\.0$/, '') + '¢/mile'; }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

  function deepMerge(base, over) {
    if (!over || typeof over !== 'object') return base;
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over)) {
      const v = over[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
      else if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
  }
  function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) { if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = value;
    return obj;
  }

  /** Resolve the parameter set for a year, falling back to the nearest known year, then applying user overrides. */
  function getParams(taxYear, overrides) {
    const y = Number(taxYear);
    let baseYear = y;
    if (!PARAMS[y]) baseYear = y < KNOWN_YEARS[0] ? KNOWN_YEARS[0] : KNOWN_YEARS[KNOWN_YEARS.length - 1];
    // A mid-year rate change belongs to the year it was published for. Carried into a fallback year it
    // would date every drive from another year's July 1, so drop it and let the January rates stand
    // until the user enters that year's own figures.
    const base = baseYear === y ? PARAMS[baseYear] : Object.assign({}, PARAMS[baseYear], { mileageJul: null });
    const merged = deepMerge(base, overrides && overrides[y]);
    return Object.assign({}, merged, { year: y, baseYear, isFallback: baseYear !== y, hasOverrides: !!(overrides && overrides[y] && Object.keys(overrides[y]).length) });
  }

  /** The settings rows that apply to one year: the standing list plus whatever that year actually has. */
  function paramFields(taxYear, overrides) {
    const P = getParams(taxYear, overrides);
    // In a year with a mid-year change the January rows sit above the July rows, so say which half each governs.
    const standing = P.mileageJul
      ? PARAM_FIELDS.map((f) => (f.path.startsWith('mileage.') ? Object.assign({}, f, { label: f.label.replace(' (¢/mile)', ' to June 30 (¢/mile)') }) : f))
      : PARAM_FIELDS;
    return standing.concat(CONDITIONAL_PARAM_FIELDS.filter((f) => getPath(P, f.path) != null));
  }

  /**
   * The mileage rate for one date. The IRS sometimes changes the rates mid-year
   * (it did on July 1, 2026), so a year can have two sets and the entry's date picks one.
   * An entry with no date takes the rate from the start of the year.
   */
  function mileageRate(P, key, dateISO) {
    const late = P.mileageJul;
    // A split entered in Settings carries no date, so it takes effect on July 1 of the year being computed.
    const from = late ? (late.from || `${P.year}-07-01`) : null;
    if (late && dateISO && String(dateISO) >= from) return Number(late[key]) || 0;
    return (P.mileage && Number(P.mileage[key])) || 0;
  }

  /** "21¢/mile", or both figures when the rate changed during the year. */
  function perMileText(P, key) {
    const early = (P.mileage && Number(P.mileage[key])) || 0;
    const late = P.mileageJul ? Number(P.mileageJul[key]) || 0 : early;
    if (late === early) return perMile(early);
    return `${perMile(early)} before July 1 and ${perMile(late)} after`;
  }

  /** An amount from an old backup or a hand-edited import can be Infinity or NaN; one of those would poison every total it touches. */
  function amountOf(entry) {
    const n = Number(entry && entry.amount);
    return Number.isFinite(n) ? n : 0;
  }

  function taxYearOf(entry) {
    if (entry.taxYear) return Number(entry.taxYear);
    return Number(String(entry.date || '').slice(0, 4)) || null;
  }

  function isMarried(filingStatus) { return !!(FILING_BY_ID[filingStatus] && FILING_BY_ID[filingStatus].married); }

  // ---- the computation -----------------------------------------------------

  /**
   * @param {Array} allEntries  every entry in the store (any year)
   * @param {Object} settings   { taxYear, filingStatus, agi, age65, blind, spouseAge65, spouseBlind,
   *                              gamblingWinnings, stateWithholding, casualtyFederalDisaster,
   *                              casualtyQualifiedDisaster, state, paramOverrides, today }
   */
  function compute(allEntries, settings) {
    const s = Object.assign({ filingStatus: 'single' }, settings || {});
    const taxYear = Number(s.taxYear) || new Date().getFullYear();
    const P = getParams(taxYear, s.paramOverrides);
    const agi = (s.agi === '' || s.agi == null || isNaN(Number(s.agi))) ? null : Math.max(0, Number(s.agi));
    const married = isMarried(s.filingStatus);
    const isMFS = s.filingStatus === 'mfs';
    const entries = (allEntries || []).filter((e) => taxYearOf(e) === taxYear && Schema.getLine(e.lineId));

    // per-line totals
    const lines = {};
    for (const line of Schema.LINES) lines[line.id] = { id: line.id, total: 0, count: 0, milesValue: 0, missingReceipts: 0, entries: [] };
    const months = new Array(12).fill(0);
    const monthsBySection = {};
    for (const sec of Schema.SECTIONS) monthsBySection[sec.id] = new Array(12).fill(0);

    for (const e of entries) {
      const line = Schema.getLine(e.lineId);
      const amt = amountOf(e);
      const L = lines[line.id];
      L.total += amt; L.count += 1; L.entries.push(e);
      // Miles are valued one entry at a time, because the rate can change during the year.
      if (line.unit === 'miles' && line.rate) L.milesValue += amt * mileageRate(P, line.rate, e.date);
      if (line.unit === 'usd' && amt >= P.receiptThreshold && !e.hasReceipt) L.missingReceipts += 1;
    }
    for (const id of Object.keys(lines)) { lines[id].total = cents(lines[id].total); lines[id].milesValue = cents(lines[id].milesValue); }

    const T = (id) => lines[id].total;
    /** dollar value of a line: dollars, or miles at the rate for each entry's date; info lines carry no value */
    const valueOf = (line) => {
      if (line.treatment === 'info') return 0;
      return line.unit === 'miles' ? lines[line.id].milesValue : T(line.id);
    };

    // month buckets (in dollar value)
    for (const e of entries) {
      const line = Schema.getLine(e.lineId);
      if (line.treatment === 'info') continue;
      const m = Number(String(e.date || '').slice(5, 7)) - 1;
      if (m < 0 || m > 11) continue;
      const v = line.unit === 'miles' ? amountOf(e) * mileageRate(P, line.rate, e.date) : amountOf(e);
      months[m] += v;
      monthsBySection[line.sectionId][m] += v;
    }

    // per-section totals
    const sections = {};
    for (const sec of Schema.SECTIONS) {
      const secLines = Schema.linesForSection(sec.id);
      let dollars = 0, miles = 0, milesValue = 0, count = 0, missingReceipts = 0;
      for (const l of secLines) {
        count += lines[l.id].count; missingReceipts += lines[l.id].missingReceipts;
        // An info line is a note for the preparer, not a deduction: it carries no value here and none
        // in the month buckets either, so the section total and its monthly bars agree.
        if (l.treatment === 'info') continue;
        if (l.unit === 'miles') { miles += T(l.id); milesValue += valueOf(l); }
        else dollars += T(l.id);
      }
      sections[sec.id] = { id: sec.id, title: sec.title, dollars: cents(dollars), miles, milesValue: cents(milesValue), value: cents(dollars + milesValue), count, missingReceipts, months: monthsBySection[sec.id].map(cents) };
    }

    // ---- Schedule A ----
    const medicalLines = Schema.linesForSection('medical');
    // §213(d)(10) caps long-term-care premiums by age, and the cap belongs to each insured person. The age
    // band from Settings sets the taxpayer's own limit; with no band stated only an obviously excessive
    // figure is trimmed, at the top band. A second limit is added for a spouse's own policy on a joint
    // return, but only once that spouse's band is given: a couple with one policy is entitled to one limit.
    const ltcPaid = T('med.ltc');
    const ltcLimits = P.ltcPremiumLimits || null;
    const ltcBracket = LTC_BRACKET_BY_ID[s.ltcAgeBracket] || null;
    const ltcSpouseBracket = s.filingStatus === 'mfj' ? (LTC_BRACKET_BY_ID[s.spouseLtcAgeBracket] || null) : null;
    const ltcOwnLimit = ltcLimits ? Number(ltcLimits[ltcBracket ? ltcBracket.key : 'over70']) || 0 : null;
    const ltcSpouseLimit = ltcLimits && ltcSpouseBracket ? Number(ltcLimits[ltcSpouseBracket.key]) || 0 : 0;
    const ltcBound = ltcLimits ? cents(ltcOwnLimit + ltcSpouseLimit) : null;
    const ltcCounted = ltcBound == null ? ltcPaid : Math.min(ltcPaid, ltcBound);
    // The medical figure people expect to see is what they logged; the limit shows up in `gross`.
    const medEntered = cents(medicalLines.reduce((a, l) => a + valueOf(l), 0));
    const medGross = cents(medEntered - (ltcPaid - ltcCounted));
    const medFloor = agi == null ? null : cents(agi * P.medicalFloorRate);
    const medical = {
      entered: medEntered,
      gross: medGross,
      ltc: {
        paid: ltcPaid, counted: cents(ltcCounted), excess: cents(ltcPaid - ltcCounted),
        bracket: ltcBracket ? ltcBracket.id : '', bracketLabel: ltcBracket ? ltcBracket.label : null,
        spouseBracket: ltcSpouseBracket ? ltcSpouseBracket.id : '', spouseBracketLabel: ltcSpouseBracket ? ltcSpouseBracket.label : null,
        limit: ltcOwnLimit, spouseLimit: ltcSpouseLimit, bound: ltcBound, limits: ltcLimits,
        capped: ltcCounted < ltcPaid, pending: !ltcBracket && ltcPaid > 0,
        spousePending: s.filingStatus === 'mfj' && !ltcSpouseBracket && ltcPaid > 0,
      },
      milesValue: valueOf(Schema.getLine('med.miles')),
      floor: medFloor,
      deductible: medFloor == null ? null : cents(Math.max(0, medGross - medFloor)),
      pending: medFloor == null && medGross > 0,
      shortfall: medFloor == null ? null : cents(Math.max(0, medFloor - medGross)),
    };

    // W-2 state and local withholding is usually the largest SALT item and is never an entry. It counts
    // wherever it was withheld: someone living in a state with no income tax may still work in one.
    const stateCode = String(s.state || '').toUpperCase() || null;
    const withheld = cents(Math.max(0, Number(s.stateWithholding) || 0));
    const taxGross = cents(sections.taxes.value + withheld);
    let saltCap = isMFS ? P.saltCap.mfs : P.saltCap.default;
    let saltPhasedOut = false;
    if (P.saltPhaseout && agi != null) {
      const start = isMFS ? P.saltPhaseout.start.mfs : P.saltPhaseout.start.default;
      const floor = isMFS ? P.saltPhaseout.floor.mfs : P.saltPhaseout.floor.default;
      if (agi > start) { saltCap = Math.max(floor, saltCap - P.saltPhaseout.rate * (agi - start)); saltPhasedOut = true; }
    }
    const taxes = { gross: taxGross, entered: cents(sections.taxes.value), withheld, cap: cents(saltCap), deductible: cents(Math.min(taxGross, saltCap)), excess: cents(Math.max(0, taxGross - saltCap)), phasedOut: saltPhasedOut };

    // §163(d) allows investment interest only up to net investment income, with the rest carried forward on
    // Form 4952. That income is nowhere in the ledger, so it comes from Settings; until it is entered the
    // whole amount counts and the verdict says it is waiting on a figure.
    const invPaid = T('int.investment');
    const invIncome = (s.investmentIncome === '' || s.investmentIncome == null || isNaN(Number(s.investmentIncome))) ? null : Math.max(0, Number(s.investmentIncome));
    const invAllowed = invIncome == null ? invPaid : Math.min(invPaid, invIncome);
    const interestTotal = cents(sections.interest.value);
    const interest = {
      total: interestTotal,
      investment: invPaid,
      investmentIncome: invIncome,
      allowedInvestment: cents(invAllowed),
      carryforward: invIncome == null ? 0 : cents(invPaid - invAllowed),
      pending: invIncome == null && invPaid > 0,
      deductible: cents(interestTotal - invPaid + invAllowed),
    };

    const cash = cents(['ch.worship', 'ch.college', 'ch.org', 'ch.cfc', 'ch.other'].reduce((a, id) => a + T(id), 0));
    const noncash = T('ch.noncash');
    const volunteer = cents(sections.volunteer.value);
    const charGross = cents(cash + noncash + volunteer);
    const charFloor = P.charityFloorRate > 0 ? (agi == null ? null : cents(agi * P.charityFloorRate)) : 0;
    // One bound that is always right: no more than the cash AGI limit counts this year; the rest carries forward.
    // (The lower 30%/50% limits for property gifts cannot be told apart on a single worksheet line.)
    const charAfterFloor = cents(Math.max(0, charGross - (charFloor || 0)));
    const charLimit = agi == null ? null : cents(agi * P.charityCashAgiLimit);
    const charity = {
      cash, noncash, volunteer, volunteerMilesValue: valueOf(Schema.getLine('vol.miles')),
      gross: charGross,
      floor: charFloor,
      floorPending: charFloor == null && charGross > 0,
      deductible: charLimit == null ? charAfterFloor : cents(Math.min(charAfterFloor, charLimit)),
      carryforward: charLimit == null ? 0 : cents(Math.max(0, charAfterFloor - charLimit)),
      limitPending: charLimit == null && charGross > 0,
      cashLimit: charLimit,
      nonCashNeedsForm8283: noncash > P.nonCashForm8283,
      nonCashNeedsAppraisal: noncash > P.nonCashAppraisal,
    };

    const winnings = Math.max(0, Number(s.gamblingWinnings) || 0);
    const losses = T('oth.gambling');
    const other = { gamblingLosses: losses, gamblingWinnings: winnings, allowedLosses: cents(losses * P.gamblingLossRate), deductible: cents(Math.min(losses * P.gamblingLossRate, winnings)) };

    const casGross = T('cas.loss');
    // A "qualified disaster loss" (declarations covered by P.L. 118-148 and P.L. 119-21) uses a $500 floor, no AGI reduction,
    // and counts on top of the standard deduction for non-itemizers. Those acts reach declarations made between
    // January 2020 and September 2025, so a later year cannot use the treatment unless Congress extends the
    // window again — which is why the year's `qualifiedDisasterLoss` figure is editable in Settings.
    const qualifiedDisaster = P.qualifiedDisasterLoss !== false && !!s.casualtyFederalDisaster && !!s.casualtyQualifiedDisaster;
    const perEvent = qualifiedDisaster ? (P.casualtyQualifiedPerEvent || 500) : P.casualtyPerEvent;
    const casualty = {
      gross: casGross,
      federalDisaster: !!s.casualtyFederalDisaster,
      qualified: qualifiedDisaster,
      qualifiedRequested: !!s.casualtyQualifiedDisaster,
      perEvent,
      afterLimits: qualifiedDisaster ? cents(Math.max(0, casGross - perEvent)) : (agi == null ? null : cents(Math.max(0, casGross - perEvent - agi * P.casualtyAgiRate))),
      deductible: 0,
      addedToStandard: false,
    };
    if (casualty.federalDisaster && casualty.afterLimits != null) casualty.deductible = casualty.afterLimits;
    if (qualifiedDisaster && casualty.deductible > 0) casualty.addedToStandard = true;

    const scheduleA = { medical, taxes, interest, charity, other, casualty };
    scheduleA.total = cents((medical.deductible || 0) + taxes.deductible + interest.deductible + charity.deductible + other.deductible + casualty.deductible);
    // What the worksheet adds up to before any floor or cap — the number people expect to see.
    scheduleA.grossEntered = cents(medEntered + taxGross + interest.total + charGross + losses + casGross);

    // ---- standard deduction ----
    const conditions = [];
    if (s.age65) conditions.push('you are 65 or older');
    if (s.blind) conditions.push('you are blind');
    // Only a joint return carries the spouse's age/blindness add-on (§63(f)); a qualifying surviving spouse files alone.
    if (s.filingStatus === 'mfj') {
      if (s.spouseAge65) conditions.push('your spouse is 65 or older');
      if (s.spouseBlind) conditions.push('your spouse is blind');
    }
    const perCondition = married ? P.additionalStdDed.married : P.additionalStdDed.unmarried;
    const baseStd = P.standardDeduction[s.filingStatus];
    // From 2026 a non-itemizer also deducts cash gifts (§170(p)), so they belong on the standard-deduction
    // side of the comparison, exactly like a qualified disaster loss.
    const nonItemizerCap = P.nonItemizerCharity ? (s.filingStatus === 'mfj' ? P.nonItemizerCharity.mfj : P.nonItemizerCharity.single) : 0;
    const standardDeduction = {
      base: Number.isFinite(baseStd) ? baseStd : P.standardDeduction.single,
      additional: cents(conditions.length * perCondition),
      conditions,
      disasterLoss: casualty.addedToStandard ? casualty.deductible : 0,
      charity: P.nonItemizerCharity ? cents(Math.min(nonItemizerCap, charity.cash)) : 0,
      charityCap: P.nonItemizerCharity ? nonItemizerCap : 0,
      total: 0,
    };
    standardDeduction.total = cents(standardDeduction.base + standardDeduction.additional + standardDeduction.disasterLoss + standardDeduction.charity);

    const sliPaid = T('edu.loan_interest');
    const saltFloor = P.saltPhaseout ? (isMFS ? P.saltPhaseout.floor.mfs : P.saltPhaseout.floor.default) : Infinity;
    const verdict = {
      itemize: scheduleA.total > standardDeduction.total,
      difference: cents(scheduleA.total - standardDeduction.total),
      progress: standardDeduction.total ? Math.min(1, scheduleA.total / standardDeduction.total) : 0,
      medicalPending: medical.pending,
      interestPending: interest.pending,
      // Without an AGI the engine assumes the best case for every income-based limit; say so instead of staying quiet.
      // A qualified disaster loss is fully sized without an AGI, so it is not waiting on one.
      agiPending: agi == null && !!(medical.pending || charity.floorPending || charity.limitPending || taxGross > saltFloor || (casGross > 0 && casualty.federalDisaster && casualty.afterLimits == null) || sliPaid > 0),
    };

    // ---- above the line / credits ----
    let sliDeductible = cents(Math.min(sliPaid, P.studentLoanInterestCap));
    let sliPhase = 'n/a';
    if (P.studentLoanPhaseout && agi != null && sliPaid > 0) {
      const range = s.filingStatus === 'mfj' ? P.studentLoanPhaseout.mfj : P.studentLoanPhaseout.single; // the joint range is for joint returns only
      if (isMFS) { sliDeductible = 0; sliPhase = 'mfs'; }
      else if (agi >= range.end) { sliDeductible = 0; sliPhase = 'out'; }
      else if (agi > range.start) { sliDeductible = cents(sliDeductible * (1 - (agi - range.start) / (range.end - range.start))); sliPhase = 'partial'; }
      else sliPhase = 'full';
    } else if (isMFS && sliPaid > 0) { sliDeductible = 0; sliPhase = 'mfs'; }
    const adjustments = { studentLoanInterest: { paid: sliPaid, cap: P.studentLoanInterestCap, deductible: sliDeductible, phase: sliPhase, phaseoutChecked: !!(P.studentLoanPhaseout && agi != null) || isMFS } };

    // P.L. 119-21 §70103 (§151(d)(5)): $6,000 for each person aged 65 or older, 2025 through 2028,
    // whether or not you itemize. The reduction applies to each person's own $6,000, and married
    // taxpayers must file jointly to claim it.
    adjustments.seniorDeduction = null;
    if (P.seniorDeduction) {
      const seniors = (s.age65 ? 1 : 0) + (s.filingStatus === 'mfj' && s.spouseAge65 ? 1 : 0);
      const startAt = s.filingStatus === 'mfj' ? P.seniorDeduction.phaseoutStart.mfj : P.seniorDeduction.phaseoutStart.default;
      const perPerson = agi == null ? P.seniorDeduction.perPerson : Math.max(0, cents(P.seniorDeduction.perPerson - P.seniorDeduction.rate * Math.max(0, agi - startAt)));
      const amount = isMFS ? 0 : cents(seniors * perPerson);
      adjustments.seniorDeduction = {
        people: seniors,
        perPerson: isMFS ? 0 : perPerson,
        amount,
        phase: isMFS ? 'mfs' : agi == null ? 'unchecked' : amount === 0 && seniors > 0 ? 'out' : perPerson < P.seniorDeduction.perPerson ? 'partial' : 'full',
      };
    }

    const eduRange = P.educationCreditPhaseout ? (s.filingStatus === 'mfj' ? P.educationCreditPhaseout.mfj : P.educationCreditPhaseout.single) : null;
    const credits = {
      educationCosts: cents(['edu.expenses', 'edu.tuition', 'edu.books', 'edu.lab', 'edu.supplies'].reduce((a, id) => a + T(id), 0)),
      tuition: T('edu.tuition'),
      // §25A(d) phases both education credits out on income; the ranges are statutory, not indexed.
      educationCreditRange: eduRange,
      educationCreditPhase: isMFS ? 'mfs' : !eduRange || agi == null ? 'unchecked' : agi >= eduRange.end ? 'out' : agi > eduRange.start ? 'partial' : 'full',
    };

    // ---- Schedule C ----
    const seUsd = Schema.linesForSection('selfemp').filter((l) => l.unit === 'usd' && !['se.meals', 'se.car'].includes(l.id));
    const seOther = cents(seUsd.reduce((a, l) => a + T(l.id), 0));
    const mealsPaid = T('se.meals');
    const mealsDeductible = cents(mealsPaid * P.mealsDeductibleRate);
    const actualCar = T('se.car');
    const bizMiles = T('se.miles');
    const bizMilesValue = valueOf(Schema.getLine('se.miles'));
    const totalMiles = T('se.total_miles');
    const scheduleC = {
      otherExpenses: seOther,
      meals: { paid: mealsPaid, deductible: mealsDeductible, rate: P.mealsDeductibleRate },
      vehicle: {
        actual: actualCar,
        miles: bizMiles,
        milesValue: bizMilesValue,
        totalMiles,
        businessUseShare: totalMiles > 0 ? Math.min(1, bizMiles / totalMiles) : null,
        methodConflict: actualCar > 0 && bizMiles > 0,
        best: bizMilesValue >= actualCar ? 'standard' : 'actual',
      },
      total: cents(seOther + mealsDeductible + Math.max(actualCar, bizMilesValue)),
      hasActivity: sections.selfemp.count > 0,
    };

    // ---- substantiation ----
    const usdEntries = entries.filter((e) => Schema.getLine(e.lineId).unit === 'usd');
    const charityIds = new Set(Schema.linesForSection('charity').concat(Schema.linesForSection('volunteer')).map((l) => l.id));
    const giftsNoAck = usdEntries.filter((e) => charityIds.has(e.lineId) && (Number(e.amount) || 0) >= P.acknowledgmentThreshold && !e.hasReceipt);
    const ackSet = new Set(giftsNoAck);
    // Gifts already flagged for an acknowledgment letter are not flagged a second time for a receipt.
    const missingReceipts = usdEntries.filter((e) => (Number(e.amount) || 0) >= P.receiptThreshold && !e.hasReceipt && !ackSet.has(e));
    const withReceipt = usdEntries.filter((e) => e.hasReceipt).length;
    const substantiation = {
      totalEntries: entries.length,
      usdEntries: usdEntries.length,
      withReceipt,
      coverage: usdEntries.length ? withReceipt / usdEntries.length : 1,
      missingReceipts,
      giftsNoAck,
    };

    // ---- duplicates ----
    const seen = new Map();
    const duplicates = [];
    for (const e of entries) {
      const key = `${e.date}|${e.lineId}|${Number(e.amount)}`;
      if (seen.has(key)) duplicates.push([seen.get(key), e]); else seen.set(key, e);
    }

    const result = {
      taxYear, params: P, agi, filingStatus: s.filingStatus, married,
      state: stateCode,
      entries, lines, sections, months: months.map(cents),
      scheduleA, standardDeduction, verdict, adjustments, credits, scheduleC, substantiation, duplicates,
    };
    result.insights = buildInsights(result, s);
    return result;
  }

  // ---- insights ------------------------------------------------------------

  function buildInsights(R, s) {
    const out = [];
    const add = (level, title, body, opts) => out.push(Object.assign({ level, title, body }, opts || {}));
    const P = R.params, A = R.scheduleA, SD = R.standardDeduction, V = R.verdict, agi = R.agi;
    const T = (id) => R.lines[id].total;
    const today = s.today ? new Date(s.today + 'T00:00:00') : new Date();
    // Three cases, not two: a year that has not started still takes the advice for a year you can act on.
    const inYear = today.getFullYear() === R.taxYear;
    const yearOver = today.getFullYear() > R.taxYear;
    const isMFS0 = R.filingStatus === 'mfs';
    const month = today.getMonth() + 1;
    // What the standard-deduction side of the comparison is made of, when it is more than the table figure.
    const stdPlus = SD.charity > 0 ? `${money(SD.total)} standard deduction (including ${money(SD.charity)} of cash gifts, which count without itemizing)` : `${money(SD.total)} standard deduction`;

    const noIncomeTax0 = NO_INCOME_TAX_STATES.has(R.state || '');
    if (P.isFallback) add('warn', `No built-in figures for ${R.taxYear}`, `Using ${P.baseYear} standard deductions, caps, and mileage rates. Check Settings → Rates & thresholds and enter the ${R.taxYear} figures when the IRS publishes them.`, { view: 'settings' });

    // The verdict
    if (R.entries.length === 0) {
      add('info', `Nothing logged for ${R.taxYear} yet`, `Your standard deduction is ${money(SD.total)}. Log expenses as they happen and this page will tell you the moment itemizing starts to pay.`);
    } else if (V.itemize) {
      add('good', `Itemizing wins by ${moneyNear(V.difference)}`, `Schedule A deductions of ${money(A.total)} beat your ${stdPlus}.${yearOver ? ' Keep the receipts with the return.' : ' Every additional dollar you log now lowers your taxable income — keep the receipts.'}${V.agiPending ? ' This assumes the full state-and-local cap and no income-based limits; enter your estimated AGI in Settings to confirm.' : ''}`, V.agiPending ? { view: 'settings' } : undefined);
    } else {
      const need = moneyNear(-V.difference);
      let body = `Your itemized deductions come to ${money(A.total)} after floors and caps, against a ${stdPlus}. You would need ${need} more for itemizing to help.`;
      if (V.medicalPending) body += ` Medical expenses are not counted yet — enter your AGI in Settings.`;
      if (!A.taxes.withheld && !noIncomeTax0 && T('tax.state_income') + T('tax.real_estate') > 0) body += ` State and local income tax withheld from your pay (W-2 boxes 17 and 19) also counts — enter it in Settings.`;
      add('info', 'Standard deduction still wins', body, { view: 'settings' });
      const closeEnough = -V.difference <= Math.max(3000, SD.total * 0.3);
      if (closeEnough && A.total > 0 && !yearOver) {
        add('act', 'Close to the line — consider bunching', `Paying deductible bills before Dec 31 that you would otherwise pay in January (a property-tax installment, next year's charitable pledge, an elective medical procedure) can push ${R.taxYear} over the standard deduction. Then take the standard deduction the following year. Two years of bunched deductions beat two years of just missing.`);
      } else if (closeEnough && A.total > 0) {
        // The year is over, so this is history: say what happened and where bunching still helps.
        add('info', `${R.taxYear} fell ${need} short of itemizing`, `Nothing can change ${R.taxYear} now. Bunching is the play for a year you can still act on: pay two years of deductible bills in one calendar year — a property-tax installment, a charitable pledge, elective medical work — and take the standard deduction in the other.`);
      }
    }

    // Medical
    if (A.medical.gross > 0) {
      // Once a long-term-care premium is trimmed, what was logged and what counts are two figures: name both.
      const logged = A.medical.ltc.excess > 0
        ? `${money(A.medical.entered)} logged, ${money(A.medical.gross)} of it after the long-term-care limit`
        : `${money(A.medical.gross)} logged`;
      if (agi == null) add('act', 'Enter your estimated AGI', `Medical expenses only count above ${pct(P.medicalFloorRate)} of adjusted gross income. Without an AGI, ${money(A.medical.gross)} of medical costs cannot be evaluated and is left out of the itemized total.`, { view: 'settings' });
      else if (A.medical.deductible === 0) add('info', `Medical costs are under the ${pct(P.medicalFloorRate)} floor`, `${logged}; the first ${money(A.medical.floor)} (${pct(P.medicalFloorRate)} of ${money(agi)}) never counts. ${A.medical.shortfall === 0 ? 'You are exactly on the floor, so the next dollar of medical spending starts to count' : `Another ${moneyNear(A.medical.shortfall)} of medical spending would start to count`} — dental work, glasses, and after-tax premiums add up faster than people expect.`);
      else add('good', `${money(A.medical.deductible)} of medical costs count`, `${logged}, less the ${money(A.medical.floor)} floor (${pct(P.medicalFloorRate)} of AGI).`);
    }
    if (A.medical.gross > 0 && T('med.insurance') === 0) add('info', 'Check for after-tax insurance premiums', 'Medicare Part B/D, marketplace premiums you paid yourself, and dental or vision plans paid after tax all count on the Medical/Dental Insurance line. Premiums withheld pre-tax from a paycheck do not.');
    if (T('med.miles') > 0) add('info', `Medical miles are worth ${money(A.medical.milesValue)}`, `${T('med.miles').toLocaleString()} miles at ${perMileText(P, 'medical')}. Parking and tolls on those trips go under Other Medical Transportation.`);
    const LTC = A.medical.ltc;
    if (LTC && LTC.paid > 0 && LTC.limits) {
      const bands = `${money(LTC.limits.to40)} at age 40 or under, ${money(LTC.limits.to50)} at 41 to 50, ${money(LTC.limits.to60)} at 51 to 60, ${money(LTC.limits.to70)} at 61 to 70, and ${money(LTC.limits.over70)} over 70`;
      const perPerson = `The limit for ${R.taxYear} is ${bands} — per insured person, so a couple who each hold a policy get two limits.`;
      // A spouse's own policy adds a second limit, and only their band can size it.
      const spouseAdd = LTC.spouseBracketLabel ? `, plus the limit at age ${LTC.spouseBracketLabel} for your spouse's own policy` : '';
      const askSpouse = LTC.spousePending ? ' If a second policy insures your spouse, set their age band in Settings as well and it gets its own limit.' : '';
      if (LTC.capped) {
        const held = LTC.bracket
          ? `${money(LTC.counted)} is counted, which is the ${R.taxYear} limit at age ${LTC.bracketLabel}${spouseAdd}`
          : `${money(LTC.counted)} is counted, which is the most any one insured person can claim in ${R.taxYear}${spouseAdd}`;
        add('warn', 'Long-term-care premiums are limited by age', `You logged ${money(LTC.paid)}; ${held}, so ${money(LTC.excess)} is left out of the medical total. ${perPerson}${LTC.bracket ? '' : ' Tell your preparer the age of each insured person.'}${askSpouse}`, LTC.spousePending ? { view: 'settings' } : undefined);
      }
      if (LTC.pending) add('act', 'Tell Settings your age band for long-term-care premiums', `The limit on a long-term-care premium is set by your age at the end of the year, and without your age band the worksheet can only hold back what is above the highest limit${LTC.capped ? '' : ', which leaves the whole premium counted'}. ${perPerson} Choose your band under Age & vision in Settings and the right limit is applied.${askSpouse}`, { view: 'settings' });
      else if (!LTC.capped) add('info', 'Long-term-care premiums have an age limit', `All ${money(LTC.paid)} counts: the ${R.taxYear} limit at age ${LTC.bracketLabel} is ${money(LTC.limit)}${spouseAdd}. The limit is per insured person, so a second policy insuring someone in another band has its own limit — tell your preparer if there is one.${askSpouse}`);
    }
    if (R.scheduleC.hasActivity && T('med.insurance') > 0) add('act', 'Self-employed? Move health premiums above the line', `With self-employment profit, health, dental, and long-term-care premiums (${money(T('med.insurance') + (LTC ? LTC.counted : T('med.ltc')))}) can be deducted on Schedule 1 with no ${pct(P.medicalFloorRate)} floor — usually far better than Schedule A. The same age limit applies to the long-term-care part. Tell your preparer which it is.`);

    // Taxes
    if (A.taxes.withheld > 0) add('info', `${money(A.taxes.withheld)} of state tax withholding is counted`, 'Income tax withheld from your pay (W-2 boxes 17 and 19) counts toward the state-and-local deduction alongside the payments you log here.');
    if (A.taxes.excess > 0) add('warn', 'State and local taxes hit the cap', `${money(A.taxes.gross)} ${A.taxes.withheld > 0 ? 'logged and withheld' : 'logged'} but only ${money(A.taxes.cap)} can be deducted${A.taxes.phasedOut ? ' (the cap is reduced at your income level)' : ''}. ${money(A.taxes.excess)} will not count${yearOver ? '' : ` — there is no reason to prepay more for ${R.taxYear}`}.`);
    if (T('tax.personal_property') > 0) add('info', 'Only the value-based part of vehicle fees counts', 'Personal property tax must be based on the item\'s value (ad valorem). Flat registration or plate fees are not deductible — check the registration notice for the breakdown.');
    if (T('int.mortgage') > 0 && T('tax.real_estate') === 0) add('act', 'Mortgage interest logged but no property tax', 'If your lender pays property tax from escrow, the amount disbursed is on Form 1098 box 10 or your annual escrow statement — it belongs on the Real Estate Tax line.', { view: 'capture' });
    const noIncomeTax = NO_INCOME_TAX_STATES.has(R.state || '');
    if (T('tax.state_income') > 0 && !noIncomeTax) add('info', 'State payments: timing matters', `Estimated payments and any prior-year state balance actually paid during ${R.taxYear} count for ${R.taxYear} — including a Q4 estimate paid by Dec 31. Withholding is already on your W-2.`);
    if (noIncomeTax) add('info', `${R.state} has no income tax: sales tax may be the better claim`, 'Schedule A lets you deduct either the state and local income tax you paid or general sales taxes, whichever is larger. Your preparer uses the IRS table for your state, income, and household size, and can add the sales tax on a vehicle, boat, or home-building materials bought this year — keep those receipts.');
    if (noIncomeTax && A.taxes.withheld > 0) add('info', `The ${money(A.taxes.withheld)} of withholding is counted as another state's tax`, `${R.state} has no income tax on wages, so withholding on your W-2 is presumably another state's or a local one — someone who lives in one state and works in another. It counts toward the state-and-local deduction. Clear the figure in Settings if it is not income tax.`, { view: 'settings' });

    // Interest
    if (T('int.individual') > 0) add('act', 'Record the private lender\'s name, address, and TIN', 'With no Form 1098, Schedule A requires the individual lender\'s name, address, and Social Security or employer ID number. Put them in the entry note.', { view: 'ledger' });
    if (T('int.second') > 0) add('info', 'Home equity interest has a use test', 'Interest on a HELOC or second mortgage counts only if the money was used to buy, build, or substantially improve the home securing it — not for cars, tuition, or paying off cards.');
    if (T('int.points') > 0) add('info', 'Points: purchase vs. refinance', 'Points paid to buy your main home are deductible in full this year. Points on a refinance are spread evenly over the life of the loan (any unamortized balance is deductible when that loan is paid off).');
    if (R.taxYear >= 2026 && P.pmiPhaseout && T('int.mortgage') > 0) add('info', 'Mortgage insurance premiums count again from 2026', `Premiums for mortgage insurance (Form 1098 box 5 — PMI, FHA, VA, or USDA) are deductible as mortgage interest again starting 2026, phasing out between ${money(isMFS0 ? P.pmiPhaseout.mfs.start : P.pmiPhaseout.default.start)} and ${money(isMFS0 ? P.pmiPhaseout.mfs.end : P.pmiPhaseout.default.end)} of AGI. Log the box 5 amount on the Home Mortgage Interest line.`);
    if (A.interest.investment > 0) {
      const I = A.interest;
      if (I.pending) add('act', 'Enter your net investment income', `Margin and other investment interest is deductible only up to net investment income, on Form 4952, and the excess carries forward. All ${money(I.investment)} you logged is counted until you enter that income in Settings.`, { view: 'settings' });
      else if (I.carryforward > 0) add('warn', 'Investment interest is over your investment income', `${money(I.investment)} of investment interest against ${money(I.investmentIncome)} of net investment income, so ${money(I.allowedInvestment)} counts this year and ${money(I.carryforward)} is left out. It is not lost: Form 4952 carries it forward to a year with enough investment income.`);
      else add('info', 'Investment interest is limited to investment income', `All ${money(I.investment)} counts, being within the ${money(I.investmentIncome)} of net investment income you entered. Form 4952 shows the working; anything above that income would carry forward instead.`);
    }

    // Charity
    if (R.substantiation.giftsNoAck.length) {
      const n = R.substantiation.giftsNoAck.length;
      add('act', `${n} ${plural(n, 'gift needs', 'gifts need')} a written acknowledgment`, `Any single gift of ${money(P.acknowledgmentThreshold)} or more requires a contemporaneous written acknowledgment from the charity stating the amount and whether you received anything in return. A cancelled check is not enough. Attach the letter or email to the entry.`, { view: 'ledger', filter: 'noack' });
    }
    if (A.charity.nonCashNeedsAppraisal) add('act', `Donated goods pass ${money(P.nonCashAppraisal)} — check whether a qualified appraisal is needed`, `A qualified appraisal and Section B of Form 8283 are required for any single item, or group of similar items, worth more than ${money(P.nonCashAppraisal)}. You logged ${money(A.charity.noncash)} of donated goods across the year, so check whether any one group crosses the line.`);
    else if (A.charity.nonCashNeedsForm8283) add('act', 'Non-cash gifts total over $500 — Form 8283', `${money(A.charity.noncash)} of donated goods requires Form 8283. For each drop-off keep the dated receipt plus your own list: item, condition, and thrift-shop value. Items must be in good used condition or better.`);
    if (T('ch.cfc') > 0) add('info', 'CFC: keep the pledge card and final pay statement', 'Payroll-deducted Combined Federal Campaign gifts are substantiated by your pledge confirmation together with the last pay statement of the year showing the total withheld.');
    if (A.charity.volunteer > 0) add('info', 'Volunteer costs count, your time does not', `${money(A.charity.volunteer)} of out-of-pocket volunteer costs${T('vol.miles') > 0 ? ` (including ${T('vol.miles').toLocaleString()} miles at ${perMileText(P, 'charity')})` : ''} are treated as gifts to the organization. Keep a note of the event and the organization for each.`);
    if (A.charity.carryforward > 0) add('warn', 'Gifts exceed the AGI limit', `Charitable gifts are deductible up to ${pct(P.charityCashAgiLimit)} of AGI (${money(A.charity.cashLimit)}) this year, so ${money(A.charity.carryforward)} is left out of the total. It is not lost — it carries forward up to five years. Gifts of property can be subject to lower 30% or 50% limits that this worksheet cannot tell apart; your preparer will.`);
    else if (A.charity.limitPending && A.charity.gross > 0 && A.charity.gross > 5000) add('info', 'Large gifts: enter your AGI', `Gifts are deductible only up to ${pct(P.charityCashAgiLimit)} of AGI in a year. Enter your estimated AGI in Settings to see whether ${money(A.charity.gross)} all counts this year.`, { view: 'settings' });
    if (P.charityFloorRate > 0 && A.charity.gross > 0 && V.itemize) {
      if (agi == null) add('info', `A ${pct(P.charityFloorRate)}-of-AGI floor applies to gifts`, `From ${R.taxYear}, itemizers lose the first ${pct(P.charityFloorRate)} of AGI of charitable gifts. Enter your AGI to see the effect.`, { view: 'settings' });
      else add('info', `First ${money(A.charity.floor)} of gifts does not count`, `Itemizers lose the first ${pct(P.charityFloorRate)} of AGI of charitable gifts starting ${R.taxYear}. ${money(A.charity.deductible)} of your ${money(A.charity.gross)} counts.`);
    }
    if (P.nonItemizerCharity && !V.itemize && A.charity.cash > 0) {
      add('good', 'Cash gifts count even without itemizing', `Starting ${R.taxYear}, non-itemizers can deduct up to ${money(SD.charityCap)} of cash gifts. You have logged ${money(A.charity.cash)}, and ${money(SD.charity)} of it is already counted on top of your standard deduction above. Only cash to a public charity counts — not a gift to a donor-advised fund (Fidelity Charitable, Schwab Charitable, Vanguard Charitable), not a gift to a supporting organization, and not donated goods.`);
    }

    // Other / casualty
    if (A.other.gamblingLosses > 0) {
      if (A.other.gamblingWinnings === 0) add('act', 'Gambling losses need winnings to offset', `${money(A.other.gamblingLosses)} of losses logged, but losses are deductible only up to the winnings you report as income. Enter your winnings (W-2G and otherwise) in Settings.`, { view: 'settings' });
      else add('info', `${money(A.other.deductible)} of gambling losses count`, `Limited to ${money(A.other.gamblingWinnings)} of winnings${P.gamblingLossRate < 1 ? `, and only ${pct(P.gamblingLossRate)} of losses are allowed from ${R.taxYear}` : ''}. Keep a diary: date, place, game, amounts won and lost, and any W-2G.`);
    }
    if (A.casualty.gross > 0) {
      if (!A.casualty.federalDisaster) add('warn', 'Casualty losses count only for declared disasters', `${money(A.casualty.gross)} logged. Personal casualty and theft losses are deductible only when attributable to a ${R.taxYear >= 2026 ? 'federally or state-declared disaster (from 2026 a governor\'s declaration also qualifies)' : 'federally declared disaster'}. If yours was, turn that on in Settings and keep the declaration number.`, { view: 'settings' });
      else if (A.casualty.afterLimits == null) add('act', 'Enter AGI to size the casualty loss', 'Disaster losses are reduced by insurance reimbursement, $100 per event, and 10% of AGI (Form 4684).', { view: 'settings' });
      else if (A.casualty.qualifiedRequested && !A.casualty.qualified) add('warn', 'This is not a qualified disaster loss', `That treatment covers federal disasters declared between January 2020 and September 2025, so the loss has been worked with the ${money(P.casualtyPerEvent)} floor and ${pct(P.casualtyAgiRate)} of your AGI: ${money(A.casualty.deductible)} counts.`, { view: 'settings' });
      else if (A.casualty.qualified) add('info', `${money(A.casualty.deductible)} of the qualified disaster loss counts`, `After a ${money(A.casualty.perEvent)} per-event reduction and with no AGI reduction. A qualified disaster loss counts on top of the standard deduction if you do not itemize, so it is included in your ${money(SD.total)} standard deduction figure. Log only the unreimbursed loss (Form 4684).`);
      else add('info', `${money(A.casualty.deductible)} of the disaster loss counts`, `After the ${money(P.casualtyPerEvent)} per-event reduction and ${pct(P.casualtyAgiRate)} of AGI. Log only the unreimbursed loss (Form 4684).${R.taxYear <= 2025 ? ' If FEMA declared this disaster between January 2020 and September 2025 it is probably a "qualified disaster loss": a $500 floor, no AGI reduction, and it counts even without itemizing — turn that on in Settings.' : ''}`, { view: 'settings' });
    }

    // Above the line & credits
    const SLI = R.adjustments.studentLoanInterest;
    if (SLI.paid > 0) {
      if (SLI.phase === 'mfs') add('warn', 'Student loan interest is not allowed when filing separately', 'Married filing separately cannot take the student loan interest deduction.');
      else if (SLI.phase === 'out') add('warn', 'Income is above the student loan interest phase-out', `At ${money(agi)} of AGI the deduction is fully phased out this year.`);
      else if (SLI.phase === 'partial') add('info', 'Student loan interest is partly phased out', `${money(SLI.deductible)} of ${money(Math.min(SLI.paid, SLI.cap))} is allowed at your income.`);
      else add(SLI.phaseoutChecked ? 'good' : 'info', `${money(SLI.deductible)} of student loan interest ${SLI.phaseoutChecked ? 'counts' : 'may count'} without itemizing`, `${SLI.paid > SLI.cap ? `Capped at ${money(SLI.cap)} of the ${money(SLI.paid)} paid. ` : ''}This is an adjustment to income, so it helps even if you take the standard deduction. Your servicer's Form 1098-E is the proof.${SLI.phaseoutChecked ? '' : (agi == null ? ' It phases out at higher incomes — enter your estimated AGI in Settings to check.' : ' It phases out at higher incomes and the range for this year is not built in — see IRS Publication 970.')}`, SLI.phaseoutChecked ? undefined : { view: 'settings' });
    }
    if (R.credits.tuition > 0 && R.filingStatus === 'mfs') add('warn', 'Education credits are not allowed when married filing separately', `The American Opportunity and Lifetime Learning credits require a joint return for married couples, so ${money(R.credits.tuition)} of tuition earns no credit on a separate return. Filing jointly may be worth more than the separate returns — ask your preparer.`);
    else if (R.credits.tuition > 0) {
      const range = R.credits.educationCreditRange;
      // On a joint return `range` is already the joint one, so the aside would repeat the same two figures.
      const band = range ? `${money(range.start)} and ${money(range.end)} of income${R.filingStatus === 'mfj' ? '' : ` (${money(P.educationCreditPhaseout.mfj.start)} to ${money(P.educationCreditPhaseout.mfj.end)} on a joint return)`}` : '';
      if (R.credits.educationCreditPhase === 'out') add('warn', 'Income is above the education-credit phase-out', `At ${money(agi)} of AGI both the American Opportunity and Lifetime Learning credits are fully phased out, so ${money(R.credits.tuition)} of tuition earns no credit on your return. It can still matter: a tax-free 529 withdrawal, employer tuition assistance, a state credit, or the student's own return if they are no longer your dependent. Ask your preparer.`);
      else if (R.credits.educationCreditPhase === 'partial') add('info', 'Education credits are partly phased out', `At ${money(agi)} of AGI the American Opportunity and Lifetime Learning credits are reduced; they phase out between ${band}. Bring Form 1098-T and receipts for required books and supplies (${money(R.credits.educationCosts)} logged) so your preparer can work out what is left.`);
      else add('good', 'Tuition may qualify for an education credit', `The American Opportunity Credit (up to $2,500 per student, first four years) or Lifetime Learning Credit (up to $2,000) is usually worth far more than a deduction. Bring Form 1098-T and receipts for required books and supplies (${money(R.credits.educationCosts)} logged).${R.credits.educationCreditPhase === 'unchecked' && range ? ` The credits phase out between ${band} — enter your estimated AGI in Settings to check.` : ''}`, R.credits.educationCreditPhase === 'unchecked' ? { view: 'settings' } : undefined);
    }
    else if (R.credits.educationCosts > 0) add('info', 'Education costs: tell your preparer the purpose', `${money(R.credits.educationCosts)} logged. Costs for a degree program may support a credit; K-12 educators can deduct up to ${money(P.educatorExpenseCap)} of classroom expenses above the line${R.taxYear >= 2026 ? ', and from 2026 an educator can also itemize classroom expenses above that cap' : ''}; other job-related training for employees is generally not deductible.`);
    const SENIOR = R.adjustments.seniorDeduction;
    if (SENIOR && SENIOR.people > 0) {
      const years = `${R.taxYear} through 2028`;
      if (SENIOR.phase === 'mfs') add('info', 'The senior deduction needs a joint return', `A married taxpayer filing separately cannot take the extra ${money(P.seniorDeduction.perPerson)} deduction for being 65 or older. Filing jointly may be worth more than two separate returns — ask your preparer.`);
      else if (SENIOR.phase === 'unchecked') add('info', `An extra ${money(SENIOR.perPerson)} deduction for being 65 or older`, `For ${years}, each person aged 65 or older deducts up to ${money(P.seniorDeduction.perPerson)} whether or not they itemize. It shrinks by ${pct(P.seniorDeduction.rate)} of income above ${money(R.filingStatus === 'mfj' ? P.seniorDeduction.phaseoutStart.mfj : P.seniorDeduction.phaseoutStart.default)} — enter your estimated AGI in Settings to see the figure.`, { view: 'settings' });
      else if (SENIOR.phase === 'out') add('info', 'Income is above the senior deduction', `The extra ${money(P.seniorDeduction.perPerson)} deduction for being 65 or older is fully phased out at ${money(agi)} of AGI. It falls by ${pct(P.seniorDeduction.rate)} of income above ${money(R.filingStatus === 'mfj' ? P.seniorDeduction.phaseoutStart.mfj : P.seniorDeduction.phaseoutStart.default)}.`);
      else add('good', `${money(SENIOR.amount)} senior deduction on top of everything else`, `For ${years}, each person aged 65 or older deducts up to ${money(P.seniorDeduction.perPerson)}${SENIOR.people > 1 ? ` (two of you, so ${money(2 * P.seniorDeduction.perPerson)} before any reduction)` : ''}, whether or not you itemize.${SENIOR.phase === 'partial' ? ` At ${money(agi)} of AGI it is reduced to ${money(SENIOR.perPerson)} each.` : ''} This is separate from the extra standard deduction for age, which the figures above already include. Remind your preparer.`);
    }

    // Schedule C
    const C = R.scheduleC;
    if (C.vehicle.methodConflict) add('warn', 'Pick one vehicle method', `You logged both actual car expenses (${money(C.vehicle.actual)}) and business miles (${C.vehicle.miles.toLocaleString()} mi = ${money(C.vehicle.milesValue)} at ${perMileText(P, 'business')}). Only one method per vehicle is allowed; the ${C.vehicle.best === 'standard' ? 'standard mileage rate' : 'actual expense method'} is worth more so far.`);
    if (C.vehicle.miles > 0 && C.vehicle.totalMiles === 0) add('act', 'Log total miles for the year', 'Schedule C asks for the vehicle\'s total miles (all purposes) to compute business-use percentage. Note the odometer on Jan 1 and Dec 31 and enter the difference on the Total Miles line.', { view: 'capture' });
    if (C.vehicle.miles > 0 && C.vehicle.totalMiles > 0 && C.vehicle.miles > C.vehicle.totalMiles) add('warn', 'Business miles exceed total miles', 'Business miles cannot be more than the total miles the vehicle was driven. Check the Total Miles entry.');
    if (C.meals.paid > 0) add('info', `Business meals: ${money(C.meals.deductible)} of ${money(C.meals.paid)} counts`, `Meals are ${pct(C.meals.rate)} deductible. For each, note who you met and the business purpose — the receipt alone is not enough.`);
    if (C.hasActivity) add('info', `Schedule C expenses: ${money(C.total)}`, 'Business expenses reduce self-employment profit directly and never depend on itemizing. Keep business and personal spending on separate cards where you can.');

    // Substantiation & hygiene
    if (R.substantiation.missingReceipts.length) {
      const n = R.substantiation.missingReceipts.length;
      add('act', `${n} ${plural(n, 'expense')} of ${money(P.receiptThreshold)}+ ${plural(n, 'has', 'have')} no receipt`, 'Snap the receipt or mark "paper receipt filed". On audit, an unsupported deduction is simply disallowed — and a card statement alone does not show what was bought.', { view: 'ledger', filter: 'noreceipt' });
    }
    if (R.duplicates.length) add('warn', `${R.duplicates.length} possible duplicate ${plural(R.duplicates.length, 'entry', 'entries')}`, 'Same date, line, and amount entered more than once. Check the ledger and delete the copy if it is one.', { view: 'ledger', filter: 'dupes' });
    if (R.filingStatus === 'mfs') add('info', 'Married filing separately: itemize together or not at all', 'If your spouse itemizes, your standard deduction is $0 and you must itemize too, even when it is less.');
    if (inYear && month >= 11 && !V.itemize && R.entries.length > 0) add('info', 'Year-end checklist', 'Before Dec 31: pay any property-tax bill already issued, make charitable gifts you plan to make anyway, fill prescriptions, and schedule dental or vision work you have been putting off.');

    const order = { act: 0, warn: 1, good: 2, info: 3 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  return { FILING_STATUSES, LTC_BRACKETS, NO_INCOME_TAX_STATES, PARAMS, PARAM_FIELDS, CONDITIONAL_PARAM_FIELDS, KNOWN_YEARS, getParams, paramFields, compute, taxYearOf, money, moneyCents, moneyNear, cents, pct, perMile, perMileText, mileageRate, deepMerge, getPath, setPath };
});
