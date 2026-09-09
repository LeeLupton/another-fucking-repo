/*
 * advisor.js — recommendations computed from the ledger itself.
 *
 * A recommendation engine over your own entries, on your own device. It looks
 * for the patterns an ad-funded app would mine for someone else and turns
 * them into things you can act on with one tap:
 *
 *   - recurring payees and their cadence, so a missed month shows up as a gap
 *   - a year-end projection built from those recurrences, run through the
 *     same tax engine as everything else
 *   - lines that usually appear together (a doctor visit and the drive)
 *   - amounts far outside a payee's usual range
 *   - whether bunching deductible bills into December gets you over the
 *     standard deduction — or whether to stop collecting Schedule A receipts
 *   - habits: how often you log, where receipts are thin
 *
 * Every recommendation carries a `because` and a stable id so it can be
 * dismissed. The aggregate profile at the end is the only thing that could
 * ever leave the device, and only if you choose to send it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schema.js'), require('./rules.js'), require('./classify.js'));
  else root.ItemizerAdvisor = factory(root.ItemizerSchema, root.ItemizerRules, root.ItemizerClassify);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Schema, Rules, Classify) {
  'use strict';

  const DAY = 86400000;
  const DISMISS_DAYS = 30;
  // A payee logged from a monthly bank statement can be six weeks late without having stopped.
  const LAPSE_FLOOR_DAYS = 45;
  const CADENCES = [
    { id: 'weekly', label: 'weekly', days: 7, tol: 2, min: 3, perYear: 52 },
    { id: 'biweekly', label: 'every two weeks', days: 14, tol: 3, min: 3, perYear: 26 },
    { id: 'fourweekly', label: 'every four weeks', days: 28, tol: 2, min: 4, perYear: 13 },
    { id: 'monthly', label: 'monthly', days: 30.44, tol: 6, min: 3, perYear: 12 },
    { id: 'quarterly', label: 'quarterly', days: 91.3, tol: 14, min: 3, perYear: 4 },
    { id: 'semiannual', label: 'twice a year', days: 182.6, tol: 21, min: 2, perYear: 2 },
    { id: 'annual', label: 'yearly', days: 365.25, tol: 30, min: 2, perYear: 1 },
  ];
  // State estimated payments follow the IRS calendar, not a fixed interval.
  const ESTIMATED = { id: 'estimated', label: 'each estimated-tax deadline', days: 91.3, tol: 20, min: 3, perYear: 4 };
  const ESTIMATED_DEADLINES = ['01-15', '04-15', '06-15', '09-15'];
  /**
   * The day an estimated-tax payment is actually due. The IRS moves a due date that falls on a
   * Saturday, Sunday or legal holiday to the next business day, and only two holidays can meet
   * these dates: Martin Luther King Day (the third Monday in January) and Emancipation Day in
   * Washington DC (April 16, kept on the Friday before when it falls on a Saturday and the Monday
   * after when it falls on a Sunday). UTC throughout, so the answer never depends on the reader's
   * time zone.
   */
  function dueDate(year, monthDay) {
    const utcIso = (d) => d.toISOString().slice(0, 10);
    const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const holidays = new Set([`${year}-01-${String(1 + ((8 - jan1) % 7) + 14).padStart(2, '0')}`]);
    const apr16 = new Date(Date.UTC(year, 3, 16)).getUTCDay();
    holidays.add(apr16 === 6 ? `${year}-04-15` : apr16 === 0 ? `${year}-04-17` : `${year}-04-16`);
    let d = new Date(`${year}-${monthDay}T00:00:00Z`);
    for (let i = 0; i < 7; i++) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6 && !holidays.has(utcIso(d))) break;
      d = new Date(d.getTime() + DAY);
    }
    return utcIso(d);
  }
  const MONTHS_PER = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
  const VISIT_LINES = ['med.doctor', 'med.dental', 'med.therapy', 'med.lab', 'med.hospital', 'med.operations', 'med.glasses', 'med.dentures', 'med.hearing'];
  const STATUS_ORDER = { overdue: 0, due: 1, upcoming: 2, lapsed: 3 };

  const pad2 = (n) => String(n).padStart(2, '0');
  const toDate = (iso) => new Date(iso + 'T00:00:00');
  const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
  const addDays = (iso, n) => { const d = toDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
  function addMonths(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(y, m - 1 + n, 1);
    const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(Math.min(d, dim))}`;
  }
  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mode(arr) {
    const c = new Map(); let best = arr[0], n = 0;
    for (const v of arr) { const k = (c.get(v) || 0) + 1; c.set(v, k); if (k > n) { n = k; best = v; } }
    return best;
  }
  const money = Rules.money;
  const moneyNear = Rules.moneyNear; // a margin under a dollar is exactly where the itemize/standard call is decided
  const cents = Rules.cents;
  // ctxYear is the year the reader is looking at: a date outside it carries its year, so "Dec 10" is never mistaken for this year's
  function fmtDate(iso, ctxYear) {
    const d = toDate(iso);
    const withYear = ctxYear && iso.slice(0, 4) !== String(ctxYear);
    return d.toLocaleDateString('en-US', withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  }
  function fmtValue(lineId, n) { return Schema.isMiles(lineId) ? `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi` : money(n); }
  function keyOf(e) { const k = Classify.keyFor(e.description || ''); return (k || '-') + '|' + e.lineId; }
  /** The next estimated-tax deadline strictly after a date (Sep 15 rolls to Jan 15 of the next year). */
  function nextDeadline(iso) {
    const y = Number(iso.slice(0, 4));
    // compare against the calendar 15th, which is what a payment is measured from, but hand back the day it is actually due
    for (const md of ESTIMATED_DEADLINES) { const d = `${y}-${md}`; if (d > iso) return dueDate(y, md); }
    return dueDate(y + 1, ESTIMATED_DEADLINES[0]);
  }
  /** The estimated-tax deadline a payment on this date satisfies, or null: quarterly payments are often made early. */
  function nearestDeadline(iso) {
    const y = Number(iso.slice(0, 4));
    return [y - 1, y, y + 1].flatMap((yy) => ESTIMATED_DEADLINES.map((md) => `${yy}-${md}`)).find((d) => Math.abs(daysBetween(d, iso)) <= ESTIMATED.tol) || null;
  }
  /** The k-th occurrence after an anchor date, generated from the anchor so month-ends never drift. */
  function nth(anchorIso, cadence, k) {
    // snap to the deadline the anchor payment satisfied, so a payment made early does not re-expect its own deadline
    if (cadence.id === 'estimated') { let d = nearestDeadline(anchorIso) || anchorIso; for (let i = 0; i < k; i++) d = nextDeadline(d); return d; }
    if (MONTHS_PER[cadence.id]) return addMonths(anchorIso, k * MONTHS_PER[cadence.id]);
    return addDays(anchorIso, Math.round(k * cadence.days));
  }
  function step(iso, cadence) { return nth(iso, cadence, 1); }
  /** How far past due a payee has to be before we call it stopped. */
  function lapseDaysFor(cadence) { return Math.max(cadence.days + 2 * cadence.tol, LAPSE_FLOOR_DAYS); }
  /** True when every occurrence sits near an estimated-tax deadline and at least three distinct deadlines are hit. */
  function looksEstimated(occ) {
    if (occ.length < ESTIMATED.min) return false;
    const hit = new Set();
    for (const o of occ) {
      const near = nearestDeadline(o.date);
      if (!near) return false;
      hit.add(near);
    }
    return hit.size >= ESTIMATED.min;
  }

  // ---- recurrences -----------------------------------------------------------

  /**
   * Find payees that recur on a steady cadence.
   * @param {Array} entries  all entries, any year (prior years make annual patterns visible)
   * @param {{today: string, taxYear: number}} opts
   */
  function detectRecurrences(entries, opts) {
    const today = opts.today;
    const taxYear = Number(opts.taxYear);
    const yearStart = `${taxYear}-01-01`, yearEnd = `${taxYear}-12-31`;
    const groups = new Map();
    const byLine = new Map(); // lineId -> every real occurrence, whatever its key: a re-spelled payee still satisfies an expected date
    for (const e of entries) {
      if (!e.date || !Schema.getLine(e.lineId)) continue;
      const k = keyOf(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
      if (!byLine.has(e.lineId)) byLine.set(e.lineId, []);
      byLine.get(e.lineId).push({ date: e.date, amount: Number(e.amount) || 0, key: k });
    }
    const cands = [];
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date.localeCompare(b.date));
      // same-day entries for one payee are one occurrence (a receipt split in two)
      const occ = [];
      for (const e of list) {
        const last = occ[occ.length - 1];
        if (last && last.date === e.date) last.amount += Number(e.amount) || 0;
        else occ.push({ date: e.date, amount: Number(e.amount) || 0, description: e.description || '' });
      }
      if (occ.length < 2) continue;
      const intervals = [];
      for (let i = 1; i < occ.length; i++) intervals.push(daysBetween(occ[i - 1].date, occ[i].date));
      const med = median(intervals);
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const line = Schema.getLine(list[0].lineId);
      let cadence = null;
      // only the state income tax line follows the IRS calendar; property tax quarters that happen to land near a deadline do not
      if (line.id === 'tax.state_income' && looksEstimated(occ)) cadence = ESTIMATED;
      for (const c of CADENCES) {
        if (cadence) break;
        if (occ.length < c.min || Math.abs(med - c.days) > c.tol) continue;
        // "every four weeks" must be unambiguous, or a month-end payee (28, 28, 31 days) would be pinned to the wrong dates
        if (c.id === 'fourweekly' && Math.abs(mean - c.days) > c.tol) continue;
        const misses = intervals.filter((iv) => Math.abs(iv - c.days) > c.tol).length;
        if (misses <= (occ.length >= 5 ? 1 : 0)) { cadence = c; break; }
      }
      if (!cadence) continue;
      cands.push({ key, occ, cadence, line });
    }
    // A payee with a cadence of its own never stands in for another one, or a group that stopped would be
    // walked forward by its neighbour instead of lapsing, and both would project the same months.
    const recurringKeys = new Set(cands.map((c) => c.key));
    const out = [];
    for (const { key, occ, cadence, line } of cands) {
      const last = occ[occ.length - 1];
      const typicalAmount = cents(median(occ.map((o) => o.amount)));
      // An expected date already covered by a same-line entry filed under a different spelling counts as done.
      const others = (byLine.get(line.id) || []).filter((o) => o.key !== key && !recurringKeys.has(o.key));
      const satisfied = (d) => others.some((o) => Math.abs(daysBetween(o.date, d)) <= cadence.tol && Math.abs(o.amount - typicalAmount) <= 0.25 * Math.max(typicalAmount, 1));
      let k = 1;
      while (k < 60 && satisfied(nth(last.date, cadence, k))) k++;
      const next = nth(last.date, cadence, k);
      const overdueBy = daysBetween(next, today);
      let status = 'upcoming';
      // More than a full period past due: the payee probably stopped, so nothing is projected for it.
      // The 45-day floor keeps a weekly or biweekly payee alive when the user logs from a monthly statement.
      const lapseAfter = lapseDaysFor(cadence);
      if (overdueBy > lapseAfter) status = 'lapsed';
      else if (overdueBy > cadence.tol) status = 'overdue';
      else if (overdueBy >= -cadence.tol) status = 'due';
      // occurrences still expected inside the tax year (overdue ones included — they probably happened)
      const expected = [];
      const nextYearEarly = [];
      for (let j = k; j < k + 80; j++) {
        const d = nth(last.date, cadence, j);
        if (d > `${taxYear + 1}-04-30`) break;
        if (satisfied(d)) continue;
        if (d > yearEnd) nextYearEarly.push(d);
        else if (d >= yearStart) expected.push(d);
      }
      out.push({
        key, lineId: line.id, sectionId: line.sectionId, label: line.label, unit: line.unit,
        description: mode(occ.map((o) => o.description)) || line.label,
        cadence: cadence.id, cadenceLabel: cadence.label, perYear: cadence.perYear, count: occ.length,
        typicalAmount, lastDate: last.date, nextDate: next, status, overdueBy, expected, nextYearEarly,
      });
    }
    out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.nextDate.localeCompare(b.nextDate));
    return out;
  }

  function syntheticEntries(recurrences, taxYear) {
    const out = [];
    for (const r of recurrences) for (const d of (r.status === 'lapsed' || r.muted ? [] : r.expected)) out.push({ id: `proj:${r.key}:${d}`, date: d, taxYear, lineId: r.lineId, amount: r.typicalAmount, description: r.description, hasReceipt: true, projected: true });
    return out;
  }

  // ---- habits ------------------------------------------------------------------

  function computeHabits(yearEntries, allEntries, today, taxYear) {
    // createdAt is a UTC timestamp; compare calendar days in local time like `today`
    const created = allEntries.filter((e) => e.createdAt && !e.sample && !e.projected).map((e) => { const d = new Date(e.createdAt); return isNaN(d) ? null : isoOf(d); }).filter(Boolean).sort();
    const distinct = [...new Set(created)];
    const gaps = [];
    for (let i = 1; i < distinct.length; i++) gaps.push(daysBetween(distinct[i - 1], distinct[i]));
    const typicalGapDays = gaps.length >= 4 ? median(gaps) : null;
    const daysSinceLast = distinct.length ? Math.max(0, daysBetween(distinct[distinct.length - 1], today)) : null;
    const receiptsBySection = {};
    for (const e of yearEntries) {
      const l = Schema.getLine(e.lineId);
      if (!l || l.unit !== 'usd') continue;
      const s = receiptsBySection[l.sectionId] || (receiptsBySection[l.sectionId] = { count: 0, withReceipt: 0, title: l.sectionTitle });
      s.count++;
      if (e.hasReceipt) s.withReceipt++;
    }
    const weekdayCounts = new Array(7).fill(0);
    for (const c of created) weekdayCounts[toDate(c).getDay()]++;
    const busiestWeekday = created.length >= 5 ? weekdayCounts.indexOf(Math.max(...weekdayCounts)) : null;
    const dates = yearEntries.map((e) => e.date).sort();
    // a closed year is measured to Dec 31, or the rate would shrink every week the user looks back at it
    const yearEnd = `${taxYear}-12-31`;
    const end = taxYear && today > yearEnd ? yearEnd : today;
    const weeks = dates.length ? Math.max(1, daysBetween(dates[0], end) / 7) : 1;
    return { typicalGapDays, daysSinceLast, lastLoggedDay: distinct.length ? distinct[distinct.length - 1] : null, receiptsBySection, busiestWeekday, weekdayCounts, entriesPerWeek: Math.round((yearEntries.length / weeks) * 10) / 10, loggingDays: distinct.length };
  }

  // ---- recommendations --------------------------------------------------------

  function buildRecommendations(ctx) {
    const { computed, projected, projection, recurrences, yearEntries, entries, projectedEntries, settings, habits, today, taxYear } = ctx;
    const P = computed.params;
    const recs = [];
    const yearStart = `${taxYear}-01-01`, yearEnd = `${taxYear}-12-31`;
    const closed = today > yearEnd;

    // 1. Recurring payees that look due or overdue (a lapsed payee is shown in the table, not nagged about)
    for (const r of recurrences) {
      if (r.status === 'upcoming' || r.status === 'lapsed' || r.nextDate < yearStart || r.nextDate > yearEnd) continue; // a muted (dismissed) one is still built so it shows under "dismissed"
      const amountText = fmtValue(r.lineId, r.typicalAmount);
      recs.push({
        id: `recur:${r.key}:${r.nextDate}`, kind: 'log',
        priority: r.status === 'overdue' ? 80 + Math.min(15, Math.floor(r.overdueBy / 7)) : 60,
        title: r.status === 'overdue' ? `${r.description}: nothing logged since ${fmtDate(r.lastDate, taxYear)}` : `${r.description} is due about now`,
        body: `Logged ${r.count} times, ${r.cadenceLabel}, usually ${amountText}; expected around ${fmtDate(r.nextDate, taxYear)}. If it was paid, log it. If it stopped, dismiss this.`,
        because: `${r.count} ${r.cadenceLabel} entries on the ${r.label} line`,
        action: { type: 'prefill', entry: { description: r.description, lineId: r.lineId, amount: r.typicalAmount, date: r.nextDate <= today ? r.nextDate : today } },
      });
    }

    // 2. Medical visits without the drive
    const milesEntries = entries.filter((e) => e.lineId === 'med.miles');
    if (milesEntries.length) {
      const overall = median(milesEntries.map((e) => Number(e.amount) || 0));
      // mileage indexed by date, so each visit costs three lookups instead of a scan of every drive
      const milesByDate = new Map();
      for (const m of milesEntries) { if (!milesByDate.has(m.date)) milesByDate.set(m.date, []); milesByDate.get(m.date).push(Number(m.amount) || 0); }
      const drivesNear = (date) => [addDays(date, -1), date, addDays(date, 1)].flatMap((d) => milesByDate.get(d) || []);
      const byPayee = new Map();
      for (const v of entries.filter((e) => VISIT_LINES.includes(e.lineId))) {
        const same = drivesNear(v.date);
        if (!same.length) continue;
        const k = Classify.keyFor(v.description || '');
        if (!byPayee.has(k)) byPayee.set(k, []);
        byPayee.get(k).push(...same);
      }
      const visits = yearEntries
        .filter((e) => VISIT_LINES.includes(e.lineId) && !drivesNear(e.date).length)
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
      for (const v of visits) {
        const known = byPayee.get(Classify.keyFor(v.description || ''));
        // a tenth of a mile, like every other mileage figure in the app: a median of 12.3 and 12.6 was never logged
        const typical = Math.round((known && known.length ? median(known) : overall) * 10) / 10;
        if (!(typical > 0)) continue;
        const what = v.description || Schema.getLine(v.lineId).label;
        const sameEveryTime = known && known.length && known.every((n) => Math.round(n * 10) / 10 === typical);
        recs.push({
          id: `miles:${v.id}`, kind: 'log', priority: 50,
          title: `Add the drive to ${what} on ${fmtDate(v.date, taxYear)}?`,
          body: `${sameEveryTime ? `You logged ${fmtValue('med.miles', typical)} for this trip before.` : known && known.length ? `Your drives to ${what} are usually about ${fmtValue('med.miles', typical)}.` : `Your medical trips are usually about ${fmtValue('med.miles', typical)}.`} At ${Rules.perMile(Rules.mileageRate(P, 'medical', v.date))} each one is small, but a year of visits adds up.`,
          because: 'a medical visit with no mileage entry within a day of it',
          action: { type: 'prefill', entry: { description: `Round trip — ${what}`, lineId: 'med.miles', amount: typical, date: v.date } },
        });
      }
    }

    // 3. Lines that usually show up together
    const byDate = new Map();
    for (const e of entries) { if (!byDate.has(e.date)) byDate.set(e.date, new Set()); byDate.get(e.date).add(e.lineId); }
    const pairDates = new Map(), lineDates = new Map();
    for (const [date, lines] of byDate) {
      const arr = [...lines].sort();
      for (const l of arr) { if (!lineDates.has(l)) lineDates.set(l, new Set()); lineDates.get(l).add(date); }
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) { const k = arr[i] + '|' + arr[j]; if (!pairDates.has(k)) pairDates.set(k, new Set()); pairDates.get(k).add(date); }
    }
    let pairCount = 0;
    for (const [k, dates] of pairDates) {
      if (dates.size < 3) continue;
      const [a, b] = k.split('|');
      if (a === 'med.miles' || b === 'med.miles') continue;
      for (const [x, y] of [[a, b], [b, a]]) {
        const xDates = lineDates.get(x);
        if (!xDates || dates.size / xDates.size < 0.6) continue;
        const missing = yearEntries.filter((e) => e.lineId === x && !(byDate.get(e.date) || new Set()).has(y)).sort((p, q) => q.date.localeCompare(p.date));
        for (const e of missing.slice(0, 2)) {
          if (pairCount++ >= 3) break;
          const yl = Schema.getLine(y);
          const xl = Schema.getLine(x);
          // an old entry can carry a line the schema no longer has, and a pair with no label to show is no advice
          if (!yl || !xl) continue;
          const yTypical = median(entries.filter((z) => z.lineId === y).map((z) => Number(z.amount) || 0));
          recs.push({
            id: `pair:${e.id}:${y}`, kind: 'log', priority: 35,
            title: `${xl.label} on ${fmtDate(e.date, taxYear)} usually comes with ${yl.label}`,
            body: `On ${dates.size} dates you logged both lines together; that day has nothing on the ${yl.label} line.`,
            because: 'a pattern in your own entries',
            action: { type: 'prefill', entry: { description: '', lineId: y, amount: yTypical || '', date: e.date } },
          });
        }
      }
    }

    // 4. Amounts far outside a payee's usual range
    const amountsByKey = new Map();
    for (const e of entries) { const k = keyOf(e); if (!amountsByKey.has(k)) amountsByKey.set(k, []); amountsByKey.get(k).push(Number(e.amount) || 0); }
    // one median per payee, not one per entry: re-sorting the same list for every entry made this quadratic
    const medByKey = new Map();
    for (const [k, arr] of amountsByKey) if (arr.length >= 4) medByKey.set(k, median(arr));
    for (const e of yearEntries) {
      const el = Schema.getLine(e.lineId);
      if (!el) continue;
      const kk = keyOf(e);
      const amounts = amountsByKey.get(kk);
      if (!amounts || amounts.length < 4) continue;
      const med = medByKey.get(kk), amt = Number(e.amount) || 0;
      // entries with no description are one pool per line, not one payee: demand a much clearer outlier and say so
      const dk = Classify.keyFor(e.description || '');
      const undescribed = !dk || dk === Classify.keyFor(el.label);
      const outlier = undescribed ? (amounts.length >= 6 && amt > 5 * med && amt - med > 50) : (amt > 3 * med && amt - med > 50);
      if (outlier) recs.push({
        id: `anomaly:${e.id}`, kind: 'check', priority: 45,
        title: `${e.description || el.label} for ${fmtValue(e.lineId, amt)} is far above its usual ${fmtValue(e.lineId, med)}`,
        body: undescribed ? 'Worth a second look against the other entries on this line. If it is right, dismiss this.' : 'Worth a second look; a missing decimal point is the usual cause. If it is right, dismiss this.',
        because: undescribed ? `${amounts.length} undescribed entries on the ${el.label} line` : `${amounts.length} entries for the same payee`,
        action: { type: 'edit', entryId: e.id },
      });
    }

    // 5. The plan for the year: bunch, or stop chasing Schedule A
    if (yearEntries.length && closed) {
      // the year is over: report what happened instead of planning for a Dec 31 that has passed
      recs.push(projection.itemize
        ? { id: `plan:closed:${taxYear}`, kind: 'good', priority: 30, title: `${taxYear}: itemizing won by ${moneyNear(projection.projectedTotal - projection.standardDeduction)}`, body: `${money(projection.projectedTotal)} of Schedule A deductions against a ${money(projection.standardDeduction)} standard deduction. Give the preparer the worksheet and the receipts sheet.`, because: 'the year is closed', action: null }
        : { id: `plan:closed:${taxYear}`, kind: 'plan', priority: 30, title: `${taxYear} fell ${moneyNear(projection.gap)} short of itemizing`, body: `${money(projection.projectedTotal)} counted against a ${money(projection.standardDeduction)} standard deduction. Business costs, student loan interest, and any non-itemizer gift deduction still count.`, because: 'the year is closed', action: null });
    } else if (yearEntries.length && projection.medicalPending && projected.scheduleA.medical.gross > 0) {
      // never issue a definitive plan on a projection that leaves medical costs out
      recs.push({ id: `plan:agi:${taxYear}`, kind: 'check', priority: 55, title: 'Enter your AGI to finish the year-end projection', body: `${money(projected.scheduleA.medical.gross)} of medical costs is not counted until an estimated AGI is set, so the comparison with the ${money(projection.standardDeduction)} standard deduction is incomplete.`, because: 'medical expenses waiting on AGI', action: { type: 'settings' } });
    } else if (yearEntries.length) {
      const std = projection.standardDeduction;
      if (projection.itemize) {
        recs.push({ id: `plan:itemize:${taxYear}`, kind: 'good', priority: 30, title: `On pace to itemize: about ${money(projection.projectedTotal)} against ${money(std)}`, body: `${money(projection.actual)} counts so far${projection.expectedMore > 0 ? `, and recurring items should add about ${money(projection.expectedMore)} by Dec 31` : ''}. Keep every Schedule A receipt this year.`, because: 'recurring entries projected to year end', action: null });
      } else {
        const gap = projection.gap;
        // Telling someone to stop keeping receipts needs evidence: either most of the year is behind us, or
        // enough recurring payees are known that the projection stands for the months still to come.
        const monthsElapsed = today < yearStart ? 0 : Number(today.slice(5, 7));
        const founded = monthsElapsed >= 9 || (projection.projectedEntries > 0 && recurrences.filter((r) => r.status !== 'lapsed' && !r.muted).length >= 2);
        // What a prepayment is worth is what the engine deducts, not what it costs: the SALT cap, its
        // phase-down and the medical floor can each swallow a payment whole.
        const base = projected.scheduleA.total;
        const synth = (c) => [{ id: `bunch:${c.r.key}`, date: `${taxYear}-12-31`, taxYear, lineId: c.r.lineId, amount: c.gross, description: c.r.description, hasReceipt: true, projected: true }];
        const priceOf = (extra) => cents(Rules.compute(entries.concat(projectedEntries, extra), Object.assign({}, settings, { today })).scheduleA.total - base);
        const raw = [];
        for (const r of recurrences) {
          if (r.unit === 'miles' || r.status === 'lapsed' || r.muted) continue;
          const prepayable = ['taxes', 'charity', 'volunteer'].includes(r.sectionId) || r.lineId === 'med.insurance';
          if (!prepayable) continue;
          if (r.perYear >= 12) { if (r.sectionId === 'charity') raw.push({ label: `make next year's ${r.description} gifts in December`, gross: Math.round(r.typicalAmount * r.perYear), r }); continue; }
          if (r.nextYearEarly.length) raw.push({ label: `pay the ${fmtDate(r.nextYearEarly[0], taxYear)} ${r.description} before Dec 31`, gross: Math.round(r.typicalAmount), r });
        }
        raw.sort((a, b) => b.gross - a.gross);
        const candidates = [];
        for (const c of raw.slice(0, 6)) { c.amount = priceOf(synth(c)); if (c.amount > 0) candidates.push(c); } // the cap keeps the number of engine runs small
        candidates.sort((a, b) => b.amount - a.amount);
        const sum = candidates.length ? priceOf(candidates.flatMap(synth)) : 0;
        const picked = [];
        let acc = 0;
        // candidates interact (two SALT items share one cap), so the whole picked set is re-priced at each step
        if (sum >= gap) for (const c of candidates) { if (acc >= gap) break; picked.push(c); acc = priceOf(picked.flatMap(synth)); }
        const saltRoom = projected.scheduleA.taxes.deductible < projected.scheduleA.taxes.cap;
        const medicalCounts = projected.scheduleA.medical.deductible > 0;
        if (picked.length && acc >= gap) {
          recs.push({ id: `plan:bunch:${taxYear}`, kind: 'plan', priority: 70, title: `Bunching closes the ${money(gap)} gap this year`, body: `Projected ${money(projection.projectedTotal)} against a ${money(std)} standard deduction. To get over it: ${picked.map((c) => `${c.label} (+${money(c.amount)})`).join('; ')}. Then take the standard deduction next year. Two bunched years beat two years of just missing.`, because: 'deductible bills that usually fall early next year', action: null });
        } else if (gap > std * 0.3 && founded) {
          recs.push({ id: `plan:stop:${taxYear}`, kind: 'plan', priority: 40, title: 'On this pace you will not itemize, so you can stop chasing Schedule A receipts', body: `On what is logged and projected so far, ${money(projection.projectedTotal)} against ${money(std)}, ${money(gap)} short${sum > 0 ? ` even after ${money(sum)} of bunching` : ''}. Keep logging business costs and student loan interest, which count regardless, and keep medical receipts only if a large expense is coming.`, because: 'projection to year end', action: null });
        } else if (gap > std * 0.3) {
          recs.push({ id: `plan:early:${taxYear}`, kind: 'plan', priority: 30, title: `On what is logged so far, ${money(gap)} short of itemizing`, body: `So far ${money(projection.projectedTotal)} counts against a ${money(std)} standard deduction, and too little of the year is logged to project the rest. Keep logging; the plan firms up as recurring payees appear.`, because: 'too little of the year logged to call it', action: null });
        } else {
          // only offer the levers this return can still use: medical under the floor and SALT at the cap buy nothing
          const rest = [];
          if (medicalCounts) rest.push('elective dental or vision work');
          rest.push('a gift you planned for next year');
          if (saltRoom) rest.push('a state estimated payment made by Dec 31');
          const restText = rest.length > 1 ? `${rest.slice(0, -1).join(', ')} or ${rest[rest.length - 1]}` : rest[0];
          recs.push({ id: `plan:close:${taxYear}`, kind: 'plan', priority: 55, title: `${money(gap)} short of itemizing, which planning can close`, body: `${sum > 0 ? `Bunching covers ${money(sum)}: ${candidates.map((c) => c.label).join('; ')}. ` : ''}${restText[0].toUpperCase()}${restText.slice(1)} could cover the rest.`, because: 'projection to year end', action: null });
        }
      }
    }

    // 6. Logging cadence
    if (habits.typicalGapDays != null && habits.daysSinceLast != null && habits.daysSinceLast > Math.max(7, 2 * habits.typicalGapDays)) {
      recs.push({ id: `habit:cadence:${habits.lastLoggedDay || today.slice(0, 10)}`, kind: 'habit', priority: 25, title: `${habits.daysSinceLast} days since your last entry`, body: `You usually log something every ${Math.round(habits.typicalGapDays)} days. Receipts fade and memories blur; a five-minute catch-up now beats reconstructing a quarter in April.`, because: 'the gaps between your logging days', action: { type: 'capture' } });
    }

    // 7. Receipt habits
    const weak = Object.entries(habits.receiptsBySection)
      .filter(([, s]) => s.count >= 3 && s.withReceipt / s.count < 0.5)
      .sort((a, b) => a[1].withReceipt / a[1].count - b[1].withReceipt / b[1].count)[0];
    if (weak) {
      recs.push({ id: `habit:receipts:${weak[0]}:${taxYear}`, kind: 'habit', priority: 30, title: `Receipts are thin for ${weak[1].title}: ${weak[1].withReceipt} of ${weak[1].count}`, body: weak[0] === 'selfemp' ? 'Business expenses are the first thing an examiner asks for. Snap the receipt as you log the expense.' : 'Attach a photo or tick "paper receipt filed" so the worksheet can vouch for the total.', because: 'receipt rate by section', action: { type: 'ledger', filter: 'noreceipt' } });
    }

    recs.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    return recs; // the caller caps the list after removing dismissed items, so dismissing never hides the rest
  }

  // ---- the shareable aggregate ---------------------------------------------

  /** Coarse, anonymous summary: no payees, notes, dates, receipts, exact amounts, or exact income. */
  function aggregateProfile(computed, habits, recurrences, today) {
    const band = (n) => (n == null ? null : n < 50000 ? 'under-50k' : n < 100000 ? '50k-100k' : n < 200000 ? '100k-200k' : '200k-plus');
    const round100 = (n) => Math.round((n || 0) / 100) * 100;
    const sections = {};
    for (const [id, s] of Object.entries(computed.sections)) if (s.count) sections[id] = { total: round100(s.value), entries: s.count };
    const cadences = {};
    for (const r of recurrences) cadences[r.cadence] = (cadences[r.cadence] || 0) + 1;
    return {
      schema: 'itemizer-aggregate/1',
      generated: String(today).slice(0, 7),
      taxYear: computed.taxYear,
      filingStatus: computed.filingStatus,
      agiBand: band(computed.agi),
      sections,
      scheduleATotal: round100(computed.scheduleA.total),
      standardDeduction: computed.standardDeduction.base, // the base follows from filing status; the add-ons would reveal age or blindness
      itemizes: computed.verdict.itemize,
      receiptRate: Math.round(computed.substantiation.coverage * 20) / 20,
      recurringItems: recurrences.length,
      cadences,
      entriesPerWeek: habits.entriesPerWeek,
      excluded: ['payees', 'descriptions', 'notes', 'dates', 'receipts', 'exact amounts', 'exact income', 'age and disability flags'],
    };
  }

  // ---- entry point -----------------------------------------------------------

  /**
   * @param {{entries: Array, settings: Object, computed?: Object, today: string}} input
   */
  function analyze(input) {
    const entries = input.entries || [];
    const settings = input.settings || {};
    const today = input.today;
    const taxYear = Number(settings.taxYear);
    const computed = input.computed || Rules.compute(entries, Object.assign({}, settings, { today }));
    const yearEntries = computed.entries;
    const recurrences = detectRecurrences(entries, { today, taxYear });
    const dismissedAt = input.dismissed || settings.advisorDismissed || {}; // one row per dismissal in the store; the settings shape still works for older callers
    // "If it stopped, dismiss this" has to outlast the payee's own period, or a yearly one comes back after
    // thirty days and is nagged about and projected for the rest of the year. The window runs to the day the
    // payee would lapse by itself, so a dismissal is followed by "Stopped?", never by the same nudge again.
    const cadenceOf = (id) => CADENCES.find((c) => c.id === id) || (id === ESTIMATED.id ? ESTIMATED : null);
    const windows = {};
    for (const r of recurrences) {
      const c = cadenceOf(r.cadence);
      if (c) windows[`recur:${r.key}:${r.nextDate}`] = Math.max(DISMISS_DAYS, Math.ceil(lapseDaysFor(c) + c.tol));
    }
    const isDismissed = (id) => { const at = dismissedAt[id]; return !!at && daysBetween(String(at).slice(0, 10), today) < (windows[id] || DISMISS_DAYS); };
    // "If it stopped, dismiss this" also stops the projection for that payee
    for (const r of recurrences) if (isDismissed(`recur:${r.key}:${r.nextDate}`)) r.muted = true;
    const closed = today > `${taxYear}-12-31`;
    const projectedEntries = closed ? [] : syntheticEntries(recurrences, taxYear);
    const projected = Rules.compute(entries.concat(projectedEntries), Object.assign({}, settings, { today }));
    const projection = {
      actual: computed.scheduleA.total,
      expectedMore: cents(projected.scheduleA.total - computed.scheduleA.total),
      projectedTotal: projected.scheduleA.total,
      standardDeduction: projected.standardDeduction.total,
      itemize: projected.verdict.itemize,
      gap: cents(projected.standardDeduction.total - projected.scheduleA.total),
      projectedEntries: projectedEntries.length,
      scheduleC: { actual: computed.scheduleC.total, projected: projected.scheduleC.total },
      medicalPending: projected.verdict.medicalPending,
    };
    // Calibration learned from finished years scales the "expected to come" part (see experiments.js).
    const calib = input.calibration && isFinite(input.calibration.factor) && input.calibration.factor > 0 ? input.calibration : null;
    if (calib && calib.factor !== 1 && projection.expectedMore > 0) {
      projection.expectedMoreRaw = projection.expectedMore;
      projection.expectedMore = cents(projection.expectedMore * calib.factor);
      projection.projectedTotal = cents(projection.actual + projection.expectedMore);
      projection.itemize = projection.projectedTotal > projection.standardDeduction;
      projection.gap = cents(projection.standardDeduction - projection.projectedTotal);
    }
    projection.calibration = calib || { factor: 1, n: 0, basis: 'none' };
    const habits = computeHabits(yearEntries, entries, today, taxYear);
    projection.closed = closed;
    const all = buildRecommendations({ computed, projected, projection, recurrences, yearEntries, entries, projectedEntries, settings, habits, today, taxYear });
    const recommendations = [], dismissed = [];
    for (const r of all) { if (isDismissed(r.id)) dismissed.push(r); else recommendations.push(r); }
    return { recommendations: recommendations.slice(0, 12), dismissed, recurrences, projection, habits, aggregate: aggregateProfile(computed, habits, recurrences, today) };
  }

  return { analyze, detectRecurrences, aggregateProfile, addMonths, dueDate, CADENCES, DISMISS_DAYS, VISIT_LINES };
});
