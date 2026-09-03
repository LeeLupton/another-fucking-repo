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
  /** States with no tax on wages: the sales-tax election is the only state-tax deduction available. */
  const NO_INCOME_TAX_STATES = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);

  // ---- Tax-year parameters -------------------------------------------------
  // Sources: IRS Rev. Proc. 2023-34 / 2024-40 / 2025-32 (inflation adjustments),
  // IRS standard mileage notices, and P.L. 119-21 (2025) for the SALT cap,
  // standard deduction, charitable floor, and gambling-loss changes.
  const PARAMS = {
    2024: {
      standardDeduction: { single: 14600, mfj: 29200, mfs: 14600, hoh: 21900, qss: 29200 },
      additionalStdDed: { married: 1550, unmarried: 1950 },
      medicalFloorRate: 0.075,
      saltCap: { default: 10000, mfs: 5000 },
      saltPhaseout: null,
      mileage: { business: 0.67, medical: 0.21, charity: 0.14 },
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: { single: [80000, 95000], mfj: [165000, 195000] },
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 1.0,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0,
      nonItemizerCharity: null,
      casualtyPerEvent: 100,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
    },
    2025: {
      standardDeduction: { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625, qss: 31500 },
      additionalStdDed: { married: 1600, unmarried: 2000 },
      medicalFloorRate: 0.075,
      saltCap: { default: 40000, mfs: 20000 },
      saltPhaseout: { start: { default: 500000, mfs: 250000 }, rate: 0.3, floor: { default: 10000, mfs: 5000 } },
      mileage: { business: 0.70, medical: 0.21, charity: 0.14 },
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: { single: [85000, 100000], mfj: [170000, 200000] },
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 1.0,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0,
      nonItemizerCharity: null,
      casualtyPerEvent: 100,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
    },
    2026: {
      standardDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150, qss: 32200 },
      additionalStdDed: { married: 1650, unmarried: 2050 },
      medicalFloorRate: 0.075,
      saltCap: { default: 40400, mfs: 20200 },
      saltPhaseout: { start: { default: 505000, mfs: 252500 }, rate: 0.3, floor: { default: 10000, mfs: 5000 } },
      mileage: { business: 0.725, medical: 0.21, charity: 0.14 },
      studentLoanInterestCap: 2500,
      studentLoanPhaseout: null, // indexed annually — enter this year's range in Settings if you are near the limit
      mealsDeductibleRate: 0.5,
      gamblingLossRate: 0.9,
      charityCashAgiLimit: 0.6,
      charityFloorRate: 0.005,
      nonItemizerCharity: { single: 1000, mfj: 2000 },
      casualtyPerEvent: 100,
      casualtyAgiRate: 0.1,
      nonCashForm8283: 500,
      nonCashAppraisal: 5000,
      acknowledgmentThreshold: 250,
      receiptThreshold: 75,
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
    { path: 'medicalFloorRate', label: 'Medical floor (share of AGI)', kind: 'rate' },
    { path: 'saltCap.default', label: 'State & local tax cap', kind: 'usd' },
    { path: 'saltCap.mfs', label: 'State & local tax cap (married filing separately)', kind: 'usd' },
    { path: 'mileage.business', label: 'Business mileage rate ($/mile)', kind: 'permile' },
    { path: 'mileage.medical', label: 'Medical mileage rate ($/mile)', kind: 'permile' },
    { path: 'mileage.charity', label: 'Charitable mileage rate ($/mile)', kind: 'permile' },
    { path: 'studentLoanInterestCap', label: 'Student loan interest cap', kind: 'usd' },
    { path: 'mealsDeductibleRate', label: 'Business meals deductible share', kind: 'rate' },
    { path: 'gamblingLossRate', label: 'Share of gambling losses allowed', kind: 'rate' },
    { path: 'charityFloorRate', label: 'Charitable floor for itemizers (share of AGI)', kind: 'rate' },
    { path: 'acknowledgmentThreshold', label: 'Gift size needing written acknowledgment', kind: 'usd' },
    { path: 'receiptThreshold', label: 'Expense size flagged when no receipt', kind: 'usd' },
  ];

  // ---- helpers -------------------------------------------------------------

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n) { return usd.format(Math.round(n || 0)); }
  function moneyCents(n) { return usdCents.format(n || 0); }
  function cents(n) { return Math.round((Number(n) || 0) * 100) / 100; }
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
    const merged = deepMerge(PARAMS[baseYear], overrides && overrides[y]);
    return Object.assign({}, merged, { year: y, baseYear, isFallback: baseYear !== y, hasOverrides: !!(overrides && overrides[y] && Object.keys(overrides[y]).length) });
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
   *                              gamblingWinnings, casualtyFederalDisaster, paramOverrides, today }
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
    for (const line of Schema.LINES) lines[line.id] = { id: line.id, total: 0, count: 0, missingReceipts: 0, entries: [] };
    const months = new Array(12).fill(0);
    const monthsBySection = {};
    for (const sec of Schema.SECTIONS) monthsBySection[sec.id] = new Array(12).fill(0);

    for (const e of entries) {
      const line = Schema.getLine(e.lineId);
      const amt = Number(e.amount) || 0;
      const L = lines[line.id];
      L.total += amt; L.count += 1; L.entries.push(e);
      if (line.unit === 'usd' && amt >= P.receiptThreshold && !e.hasReceipt) L.missingReceipts += 1;
    }
    for (const id of Object.keys(lines)) lines[id].total = cents(lines[id].total);

    const T = (id) => lines[id].total;
    const rateFor = (line) => (line.rate ? P.mileage[line.rate] || 0 : 0);
    /** dollar value of a line: dollars, or miles × rate; info lines carry no value */
    const valueOf = (line) => {
      if (line.treatment === 'info') return 0;
      return line.unit === 'miles' ? cents(T(line.id) * rateFor(line)) : T(line.id);
    };

    // month buckets (in dollar value)
    for (const e of entries) {
      const line = Schema.getLine(e.lineId);
      if (line.treatment === 'info') continue;
      const m = Number(String(e.date || '').slice(5, 7)) - 1;
      if (m < 0 || m > 11) continue;
      const v = line.unit === 'miles' ? (Number(e.amount) || 0) * rateFor(line) : (Number(e.amount) || 0);
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
        if (l.unit === 'miles') { if (l.treatment !== 'info') { miles += T(l.id); milesValue += valueOf(l); } }
        else dollars += T(l.id);
      }
      sections[sec.id] = { id: sec.id, title: sec.title, dollars: cents(dollars), miles, milesValue: cents(milesValue), value: cents(dollars + milesValue), count, missingReceipts, months: monthsBySection[sec.id].map(cents) };
    }

    // ---- Schedule A ----
    const medicalLines = Schema.linesForSection('medical');
    const medGross = cents(medicalLines.reduce((a, l) => a + valueOf(l), 0));
    const medFloor = agi == null ? null : cents(agi * P.medicalFloorRate);
    const medical = {
      gross: medGross,
      milesValue: valueOf(Schema.getLine('med.miles')),
      floor: medFloor,
      deductible: medFloor == null ? null : cents(Math.max(0, medGross - medFloor)),
      pending: medFloor == null && medGross > 0,
      shortfall: medFloor == null ? null : cents(Math.max(0, medFloor - medGross)),
    };

    const taxGross = cents(sections.taxes.value);
    let saltCap = isMFS ? P.saltCap.mfs : P.saltCap.default;
    let saltPhasedOut = false;
    if (P.saltPhaseout && agi != null) {
      const start = isMFS ? P.saltPhaseout.start.mfs : P.saltPhaseout.start.default;
      const floor = isMFS ? P.saltPhaseout.floor.mfs : P.saltPhaseout.floor.default;
      if (agi > start) { saltCap = Math.max(floor, saltCap - P.saltPhaseout.rate * (agi - start)); saltPhasedOut = true; }
    }
    const taxes = { gross: taxGross, cap: cents(saltCap), deductible: cents(Math.min(taxGross, saltCap)), excess: cents(Math.max(0, taxGross - saltCap)), phasedOut: saltPhasedOut };

    const interest = { total: cents(sections.interest.value) };

    const cash = cents(['ch.worship', 'ch.college', 'ch.org', 'ch.cfc', 'ch.other'].reduce((a, id) => a + T(id), 0));
    const noncash = T('ch.noncash');
    const volunteer = cents(sections.volunteer.value);
    const charGross = cents(cash + noncash + volunteer);
    const charFloor = P.charityFloorRate > 0 ? (agi == null ? null : cents(agi * P.charityFloorRate)) : 0;
    const charity = {
      cash, noncash, volunteer, volunteerMilesValue: valueOf(Schema.getLine('vol.miles')),
      gross: charGross,
      floor: charFloor,
      floorPending: charFloor == null && charGross > 0,
      deductible: cents(Math.max(0, charGross - (charFloor || 0))),
      cashLimit: agi == null ? null : cents(agi * P.charityCashAgiLimit),
      nonCashNeedsForm8283: noncash > P.nonCashForm8283,
      nonCashNeedsAppraisal: noncash > P.nonCashAppraisal,
    };

    const winnings = Math.max(0, Number(s.gamblingWinnings) || 0);
    const losses = T('oth.gambling');
    const other = { gamblingLosses: losses, gamblingWinnings: winnings, allowedLosses: cents(losses * P.gamblingLossRate), deductible: cents(Math.min(losses * P.gamblingLossRate, winnings)) };

    const casGross = T('cas.loss');
    const casualty = {
      gross: casGross,
      federalDisaster: !!s.casualtyFederalDisaster,
      afterLimits: agi == null ? null : cents(Math.max(0, casGross - P.casualtyPerEvent - agi * P.casualtyAgiRate)),
      deductible: 0,
    };
    if (casualty.federalDisaster && casualty.afterLimits != null) casualty.deductible = casualty.afterLimits;

    const scheduleA = { medical, taxes, interest, charity, other, casualty };
    scheduleA.total = cents((medical.deductible || 0) + taxes.deductible + interest.total + charity.deductible + other.deductible + casualty.deductible);
    // What the worksheet adds up to before any floor or cap — the number people expect to see.
    scheduleA.grossEntered = cents(medGross + taxGross + interest.total + charGross + losses + casGross);

    // ---- standard deduction ----
    const conditions = [];
    if (s.age65) conditions.push('you are 65 or older');
    if (s.blind) conditions.push('you are blind');
    if (s.filingStatus === 'mfj' || s.filingStatus === 'qss') {
      if (s.spouseAge65) conditions.push('your spouse is 65 or older');
      if (s.spouseBlind) conditions.push('your spouse is blind');
    }
    const perCondition = married ? P.additionalStdDed.married : P.additionalStdDed.unmarried;
    const standardDeduction = {
      base: P.standardDeduction[s.filingStatus] || P.standardDeduction.single,
      additional: cents(conditions.length * perCondition),
      conditions,
      total: 0,
    };
    standardDeduction.total = cents(standardDeduction.base + standardDeduction.additional);

    const verdict = {
      itemize: scheduleA.total > standardDeduction.total,
      difference: cents(scheduleA.total - standardDeduction.total),
      progress: standardDeduction.total ? Math.min(1, scheduleA.total / standardDeduction.total) : 0,
      medicalPending: medical.pending,
    };

    // ---- above the line / credits ----
    const sliPaid = T('edu.loan_interest');
    let sliDeductible = cents(Math.min(sliPaid, P.studentLoanInterestCap));
    let sliPhase = 'n/a';
    if (P.studentLoanPhaseout && agi != null && sliPaid > 0) {
      const range = married ? P.studentLoanPhaseout.mfj : P.studentLoanPhaseout.single;
      if (isMFS) { sliDeductible = 0; sliPhase = 'mfs'; }
      else if (agi >= range[1]) { sliDeductible = 0; sliPhase = 'out'; }
      else if (agi > range[0]) { sliDeductible = cents(sliDeductible * (1 - (agi - range[0]) / (range[1] - range[0]))); sliPhase = 'partial'; }
      else sliPhase = 'full';
    } else if (isMFS && sliPaid > 0) { sliDeductible = 0; sliPhase = 'mfs'; }
    const adjustments = { studentLoanInterest: { paid: sliPaid, cap: P.studentLoanInterestCap, deductible: sliDeductible, phase: sliPhase } };

    const credits = {
      educationCosts: cents(['edu.expenses', 'edu.tuition', 'edu.books', 'edu.lab', 'edu.supplies'].reduce((a, id) => a + T(id), 0)),
      tuition: T('edu.tuition'),
    };

    // ---- Schedule C ----
    const seUsd = Schema.linesForSection('selfemp').filter((l) => l.unit === 'usd' && !['se.meals', 'se.car'].includes(l.id));
    const seOther = cents(seUsd.reduce((a, l) => a + T(l.id), 0));
    const mealsPaid = T('se.meals');
    const mealsDeductible = cents(mealsPaid * P.mealsDeductibleRate);
    const actualCar = T('se.car');
    const bizMiles = T('se.miles');
    const bizMilesValue = cents(bizMiles * P.mileage.business);
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
      state: String(s.state || '').toUpperCase() || null,
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
    const inYear = today.getFullYear() === R.taxYear;
    const month = today.getMonth() + 1;

    if (P.isFallback) add('warn', `No built-in figures for ${R.taxYear}`, `Using ${P.baseYear} standard deductions, caps, and mileage rates. Check Settings → Rates & thresholds and enter the ${R.taxYear} figures when the IRS publishes them.`, { view: 'settings' });

    // The verdict
    if (R.entries.length === 0) {
      add('info', `Nothing logged for ${R.taxYear} yet`, `Your standard deduction is ${money(SD.total)}. Log expenses as they happen and this page will tell you the moment itemizing starts to pay.`);
    } else if (V.itemize) {
      add('good', `Itemizing wins by ${money(V.difference)}`, `Schedule A deductions of ${money(A.total)} beat your ${money(SD.total)} standard deduction. Every additional dollar you log now lowers your taxable income — keep the receipts.`);
    } else {
      const need = money(-V.difference);
      let body = `Your itemized deductions come to ${money(A.total)} after floors and caps, against a ${money(SD.total)} standard deduction. You would need ${need} more for itemizing to help.`;
      if (V.medicalPending) body += ` Medical expenses are not counted yet — enter your AGI in Settings.`;
      add('info', 'Standard deduction still wins', body, { view: 'settings' });
      const closeEnough = -V.difference <= Math.max(3000, SD.total * 0.3);
      if (closeEnough && A.total > 0) {
        add('act', 'Close to the line — consider bunching', `Paying deductible bills before Dec 31 that you would otherwise pay in January (a property-tax installment, next year's charitable pledge, an elective medical procedure) can push ${R.taxYear} over the standard deduction. Then take the standard deduction the following year. Two years of bunched deductions beat two years of just missing.`);
      }
    }

    // Medical
    if (A.medical.gross > 0) {
      if (agi == null) add('act', 'Enter your estimated AGI', `Medical expenses only count above ${pct(P.medicalFloorRate)} of adjusted gross income. Without an AGI, ${money(A.medical.gross)} of medical costs cannot be evaluated and is left out of the itemized total.`, { view: 'settings' });
      else if (A.medical.deductible === 0) add('info', `Medical costs are under the ${pct(P.medicalFloorRate)} floor`, `${money(A.medical.gross)} logged; the first ${money(A.medical.floor)} (${pct(P.medicalFloorRate)} of ${money(agi)}) never counts. Another ${money(A.medical.shortfall)} of medical spending would start to count — dental work, glasses, and after-tax premiums add up faster than people expect.`);
      else add('good', `${money(A.medical.deductible)} of medical costs count`, `${money(A.medical.gross)} logged, less the ${money(A.medical.floor)} floor (${pct(P.medicalFloorRate)} of AGI).`);
    }
    if (A.medical.gross > 0 && T('med.insurance') === 0) add('info', 'Check for after-tax insurance premiums', 'Medicare Part B/D, marketplace premiums you paid yourself, and dental or vision plans paid after tax all count on the Medical/Dental Insurance line. Premiums withheld pre-tax from a paycheck do not.');
    if (T('med.miles') > 0) add('info', `Medical miles are worth ${money(A.medical.milesValue)}`, `${T('med.miles').toLocaleString()} miles at ${perMile(P.mileage.medical)}. Parking and tolls on those trips go under Other Medical Transportation.`);
    if (R.scheduleC.hasActivity && T('med.insurance') > 0) add('act', 'Self-employed? Move health premiums above the line', `With self-employment profit, health, dental, and long-term-care premiums (${money(T('med.insurance') + T('med.ltc'))}) can be deducted on Schedule 1 with no ${pct(P.medicalFloorRate)} floor — usually far better than Schedule A. Tell your preparer which it is.`);

    // Taxes
    if (A.taxes.excess > 0) add('warn', 'State and local taxes hit the cap', `${money(A.taxes.gross)} logged but only ${money(A.taxes.cap)} can be deducted${A.taxes.phasedOut ? ' (the cap is reduced at your income level)' : ''}. ${money(A.taxes.excess)} will not count — there is no reason to prepay more this year.`);
    if (T('tax.personal_property') > 0) add('info', 'Only the value-based part of vehicle fees counts', 'Personal property tax must be based on the item\'s value (ad valorem). Flat registration or plate fees are not deductible — check the registration notice for the breakdown.');
    if (T('int.mortgage') > 0 && T('tax.real_estate') === 0) add('act', 'Mortgage interest logged but no property tax', 'If your lender pays property tax from escrow, the amount disbursed is on Form 1098 box 10 or your annual escrow statement — it belongs on the Real Estate Tax line.', { view: 'capture' });
    const noIncomeTax = NO_INCOME_TAX_STATES.has(R.state || '');
    if (T('tax.state_income') > 0 && !noIncomeTax) add('info', 'State payments: timing matters', `Estimated payments and any prior-year state balance actually paid during ${R.taxYear} count for ${R.taxYear} — including a Q4 estimate paid by Dec 31. Withholding is already on your W-2.`);
    if (noIncomeTax) add('info', `${R.state} has no income tax: deduct sales tax instead`, 'Schedule A lets you deduct general sales taxes in place of state income tax. Your preparer uses the IRS table for your state, income, and household size, and can add the sales tax on a vehicle, boat, or home-building materials bought this year — keep those receipts.');

    // Interest
    if (T('int.individual') > 0) add('act', 'Record the private lender\'s name, address, and TIN', 'With no Form 1098, Schedule A requires the individual lender\'s name, address, and Social Security or employer ID number. Put them in the entry note.', { view: 'ledger' });
    if (T('int.second') > 0) add('info', 'Home equity interest has a use test', 'Interest on a HELOC or second mortgage counts only if the money was used to buy, build, or substantially improve the home securing it — not for cars, tuition, or paying off cards.');
    if (T('int.points') > 0) add('info', 'Points: purchase vs. refinance', 'Points paid to buy your main home are deductible in full this year. Points on a refinance are spread evenly over the life of the loan (any unamortized balance is deductible when that loan is paid off).');
    if (T('int.investment') > 0) add('info', 'Investment interest is limited to investment income', 'Margin and other investment interest is deductible only up to net investment income, on Form 4952; the excess carries forward.');

    // Charity
    if (R.substantiation.giftsNoAck.length) {
      const n = R.substantiation.giftsNoAck.length;
      add('act', `${n} ${plural(n, 'gift needs', 'gifts need')} a written acknowledgment`, `Any single gift of ${money(P.acknowledgmentThreshold)} or more requires a contemporaneous written acknowledgment from the charity stating the amount and whether you received anything in return. A cancelled check is not enough. Attach the letter or email to the entry.`, { view: 'ledger', filter: 'noack' });
    }
    if (A.charity.nonCashNeedsAppraisal) add('act', 'Non-cash gifts over $5,000 need a qualified appraisal', `${money(A.charity.noncash)} of donated goods. Items or groups of similar items over ${money(P.nonCashAppraisal)} require a qualified appraisal and Section B of Form 8283.`);
    else if (A.charity.nonCashNeedsForm8283) add('act', 'Non-cash gifts total over $500 — Form 8283', `${money(A.charity.noncash)} of donated goods requires Form 8283. For each drop-off keep the dated receipt plus your own list: item, condition, and thrift-shop value. Items must be in good used condition or better.`);
    if (T('ch.cfc') > 0) add('info', 'CFC: keep the pledge card and final pay statement', 'Payroll-deducted Combined Federal Campaign gifts are substantiated by your pledge confirmation together with the last pay statement of the year showing the total withheld.');
    if (A.charity.volunteer > 0) add('info', 'Volunteer costs count, your time does not', `${money(A.charity.volunteer)} of out-of-pocket volunteer costs${T('vol.miles') > 0 ? ` (including ${T('vol.miles').toLocaleString()} miles at ${perMile(P.mileage.charity)})` : ''} are treated as gifts to the organization. Keep a note of the event and the organization for each.`);
    if (A.charity.cashLimit != null && A.charity.cash > A.charity.cashLimit) add('warn', 'Cash gifts exceed the AGI limit', `Cash gifts are deductible up to ${pct(P.charityCashAgiLimit)} of AGI (${money(A.charity.cashLimit)}). The excess is not lost — it carries forward up to five years.`);
    if (P.charityFloorRate > 0 && A.charity.gross > 0 && V.itemize) {
      if (agi == null) add('info', `A ${pct(P.charityFloorRate)}-of-AGI floor applies to gifts`, `From ${R.taxYear}, itemizers lose the first ${pct(P.charityFloorRate)} of AGI of charitable gifts. Enter your AGI to see the effect.`, { view: 'settings' });
      else add('info', `First ${money(A.charity.floor)} of gifts does not count`, `Itemizers lose the first ${pct(P.charityFloorRate)} of AGI of charitable gifts starting ${R.taxYear}. ${money(A.charity.deductible)} of your ${money(A.charity.gross)} counts.`);
    }
    if (P.nonItemizerCharity && !V.itemize && A.charity.cash > 0) {
      const cap = R.married && R.filingStatus !== 'mfs' ? P.nonItemizerCharity.mfj : P.nonItemizerCharity.single;
      add('good', 'Cash gifts count even without itemizing', `Starting ${R.taxYear}, non-itemizers can deduct up to ${money(cap)} of cash gifts. You have logged ${money(A.charity.cash)} — ${money(Math.min(cap, A.charity.cash))} of it counts on top of the standard deduction.`);
    }

    // Other / casualty
    if (A.other.gamblingLosses > 0) {
      if (A.other.gamblingWinnings === 0) add('act', 'Gambling losses need winnings to offset', `${money(A.other.gamblingLosses)} of losses logged, but losses are deductible only up to the winnings you report as income. Enter your winnings (W-2G and otherwise) in Settings.`, { view: 'settings' });
      else add('info', `${money(A.other.deductible)} of gambling losses count`, `Limited to ${money(A.other.gamblingWinnings)} of winnings${P.gamblingLossRate < 1 ? `, and only ${pct(P.gamblingLossRate)} of losses are allowed from ${R.taxYear}` : ''}. Keep a diary: date, place, game, amounts won and lost, and any W-2G.`);
    }
    if (A.casualty.gross > 0) {
      if (!A.casualty.federalDisaster) add('warn', 'Casualty losses count only for declared disasters', `${money(A.casualty.gross)} logged. Personal casualty and theft losses are deductible only when attributable to a federally declared disaster. If yours was, turn that on in Settings and keep the FEMA declaration number.`, { view: 'settings' });
      else if (A.casualty.afterLimits == null) add('act', 'Enter AGI to size the casualty loss', 'Disaster losses are reduced by insurance reimbursement, $100 per event, and 10% of AGI (Form 4684).', { view: 'settings' });
      else add('info', `${money(A.casualty.deductible)} of the disaster loss counts`, `After the ${money(P.casualtyPerEvent)} per-event reduction and ${pct(P.casualtyAgiRate)} of AGI. Log only the unreimbursed loss (Form 4684).`);
    }

    // Above the line & credits
    const SLI = R.adjustments.studentLoanInterest;
    if (SLI.paid > 0) {
      if (SLI.phase === 'mfs') add('warn', 'Student loan interest is not allowed when filing separately', 'Married filing separately cannot take the student loan interest deduction.');
      else if (SLI.phase === 'out') add('warn', 'Income is above the student loan interest phase-out', `At ${money(agi)} of AGI the deduction is fully phased out this year.`);
      else if (SLI.phase === 'partial') add('info', 'Student loan interest is partly phased out', `${money(SLI.deductible)} of ${money(Math.min(SLI.paid, SLI.cap))} is allowed at your income.`);
      else add('good', `${money(SLI.deductible)} of student loan interest counts without itemizing`, `${SLI.paid > SLI.cap ? `Capped at ${money(SLI.cap)} of the ${money(SLI.paid)} paid. ` : ''}This is an adjustment to income, so it helps even if you take the standard deduction. Your servicer's Form 1098-E is the proof.${P.studentLoanPhaseout ? '' : ' It phases out at higher incomes — see IRS Publication 970 for this year\'s range.'}`);
    }
    if (R.credits.tuition > 0) add('good', 'Tuition may qualify for an education credit', `The American Opportunity Credit (up to $2,500 per student, first four years) or Lifetime Learning Credit (up to $2,000) is usually worth far more than a deduction. Bring Form 1098-T and receipts for required books and supplies (${money(R.credits.educationCosts)} logged).`);
    else if (R.credits.educationCosts > 0) add('info', 'Education costs: tell your preparer the purpose', `${money(R.credits.educationCosts)} logged. Costs for a degree program may support a credit; K-12 educators can deduct up to $300 of classroom expenses above the line; job-related training for employees is generally not deductible.`);

    // Schedule C
    const C = R.scheduleC;
    if (C.vehicle.methodConflict) add('warn', 'Pick one vehicle method', `You logged both actual car expenses (${money(C.vehicle.actual)}) and business miles (${C.vehicle.miles.toLocaleString()} mi = ${money(C.vehicle.milesValue)} at ${perMile(P.mileage.business)}). Only one method per vehicle is allowed; the ${C.vehicle.best === 'standard' ? 'standard mileage rate' : 'actual expense method'} is worth more so far.`);
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

  return { FILING_STATUSES, NO_INCOME_TAX_STATES, PARAMS, PARAM_FIELDS, KNOWN_YEARS, getParams, compute, taxYearOf, money, moneyCents, cents, pct, perMile, deepMerge, getPath, setPath };
});
