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
  const CADENCES = [
    { id: 'weekly', label: 'weekly', days: 7, tol: 2, min: 3, perYear: 52 },
    { id: 'biweekly', label: 'every two weeks', days: 14, tol: 3, min: 3, perYear: 26 },
    { id: 'monthly', label: 'monthly', days: 30.44, tol: 6, min: 3, perYear: 12 },
    { id: 'quarterly', label: 'quarterly', days: 91.3, tol: 14, min: 3, perYear: 4 },
    { id: 'semiannual', label: 'twice a year', days: 182.6, tol: 21, min: 2, perYear: 2 },
    { id: 'annual', label: 'yearly', days: 365.25, tol: 30, min: 2, perYear: 1 },
  ];
  const VISIT_LINES = ['med.doctor', 'med.dental', 'med.therapy', 'med.lab', 'med.hospital', 'med.operations', 'med.glasses', 'med.dentures', 'med.hearing'];
  const STATUS_ORDER = { overdue: 0, due: 1, upcoming: 2 };

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
  const cents = Rules.cents;
  function fmtDate(iso) { const d = toDate(iso); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  function fmtValue(lineId, n) { return Schema.isMiles(lineId) ? `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi` : money(n); }
  function keyOf(e) { const k = Classify.keyFor(e.description || ''); return (k || '-') + '|' + e.lineId; }
  function step(iso, cadence) {
    if (cadence.id === 'monthly') return addMonths(iso, 1);
    if (cadence.id === 'quarterly') return addMonths(iso, 3);
    if (cadence.id === 'semiannual') return addMonths(iso, 6);
    if (cadence.id === 'annual') return addMonths(iso, 12);
    return addDays(iso, cadence.days);
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
    for (const e of entries) {
      if (!e.date || !Schema.getLine(e.lineId)) continue;
      const k = keyOf(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const out = [];
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
      let cadence = null;
      for (const c of CADENCES) {
        if (occ.length < c.min || Math.abs(med - c.days) > c.tol) continue;
        const misses = intervals.filter((iv) => Math.abs(iv - c.days) > c.tol).length;
        if (misses <= (occ.length >= 5 ? 1 : 0)) { cadence = c; break; }
      }
      if (!cadence) continue;
      const line = Schema.getLine(list[0].lineId);
      const last = occ[occ.length - 1];
      const typicalAmount = cents(median(occ.map((o) => o.amount)));
      const next = step(last.date, cadence);
      const overdueBy = daysBetween(next, today);
      let status = 'upcoming';
      if (overdueBy > cadence.tol) status = 'overdue';
      else if (overdueBy >= -cadence.tol) status = 'due';
      // occurrences still expected inside the tax year (overdue ones included — they probably happened)
      const expected = [];
      let d = next, guard = 0;
      while (d <= yearEnd && guard++ < 60) { if (d >= yearStart) expected.push(d); d = step(d, cadence); }
      // occurrences in the first four months of next year: candidates for paying early
      const nextYearEarly = [];
      d = next; guard = 0;
      while (d <= `${taxYear + 1}-04-30` && guard++ < 80) { if (d > yearEnd) nextYearEarly.push(d); d = step(d, cadence); }
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
    for (const r of recurrences) for (const d of r.expected) out.push({ id: `proj:${r.key}:${d}`, date: d, taxYear, lineId: r.lineId, amount: r.typicalAmount, description: r.description, hasReceipt: true, projected: true });
    return out;
  }

  // ---- habits ------------------------------------------------------------------

  function computeHabits(yearEntries, allEntries, today) {
    const created = allEntries.filter((e) => e.createdAt && !e.sample && !e.projected).map((e) => e.createdAt.slice(0, 10)).sort();
    const distinct = [...new Set(created)];
    const gaps = [];
    for (let i = 1; i < distinct.length; i++) gaps.push(daysBetween(distinct[i - 1], distinct[i]));
    const typicalGapDays = gaps.length >= 4 ? median(gaps) : null;
    const daysSinceLast = distinct.length ? daysBetween(distinct[distinct.length - 1], today) : null;
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
    const weeks = dates.length ? Math.max(1, daysBetween(dates[0], today) / 7) : 1;
    return { typicalGapDays, daysSinceLast, receiptsBySection, busiestWeekday, weekdayCounts, entriesPerWeek: Math.round((yearEntries.length / weeks) * 10) / 10, loggingDays: distinct.length };
  }

  // ---- recommendations --------------------------------------------------------

  function buildRecommendations(ctx) {
    const { computed, projection, recurrences, yearEntries, entries, habits, today, taxYear } = ctx;
    const P = computed.params;
    const recs = [];
    const yearStart = `${taxYear}-01-01`, yearEnd = `${taxYear}-12-31`;

    // 1. Recurring payees that look due or overdue
    for (const r of recurrences) {
      if (r.status === 'upcoming' || r.nextDate < yearStart || r.nextDate > yearEnd) continue;
      const amountText = fmtValue(r.lineId, r.typicalAmount);
      recs.push({
        id: `recur:${r.key}:${r.nextDate}`, kind: 'log',
        priority: r.status === 'overdue' ? 80 + Math.min(15, Math.floor(r.overdueBy / 7)) : 60,
        title: r.status === 'overdue' ? `${r.description}: nothing logged since ${fmtDate(r.lastDate)}` : `${r.description} is due about now`,
        body: `Logged ${r.count} times, ${r.cadenceLabel}, usually ${amountText}; expected around ${fmtDate(r.nextDate)}. If it was paid, log it. If it stopped, dismiss this.`,
        because: `${r.count} ${r.cadenceLabel} entries on the ${r.label} line`,
        action: { type: 'prefill', entry: { description: r.description, lineId: r.lineId, amount: r.typicalAmount, date: r.nextDate <= today ? r.nextDate : today } },
      });
    }

    // 2. Medical visits without the drive
    const milesEntries = entries.filter((e) => e.lineId === 'med.miles');
    if (milesEntries.length) {
      const overall = median(milesEntries.map((e) => Number(e.amount) || 0));
      const byPayee = new Map();
      for (const v of entries.filter((e) => VISIT_LINES.includes(e.lineId))) {
        const same = milesEntries.filter((m) => Math.abs(daysBetween(v.date, m.date)) <= 1);
        if (!same.length) continue;
        const k = Classify.keyFor(v.description || '');
        if (!byPayee.has(k)) byPayee.set(k, []);
        byPayee.get(k).push(...same.map((m) => Number(m.amount) || 0));
      }
      const visits = yearEntries
        .filter((e) => VISIT_LINES.includes(e.lineId) && !milesEntries.some((m) => Math.abs(daysBetween(e.date, m.date)) <= 1))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
      for (const v of visits) {
        const known = byPayee.get(Classify.keyFor(v.description || ''));
        const typical = known && known.length ? median(known) : overall;
        if (!(typical > 0)) continue;
        const what = v.description || Schema.getLine(v.lineId).label;
        recs.push({
          id: `miles:${v.id}`, kind: 'log', priority: 50,
          title: `Add the drive to ${what} on ${fmtDate(v.date)}?`,
          body: `${known && known.length ? `You logged ${typical} miles for this trip before.` : `Your medical trips average ${typical} miles.`} At ${Rules.perMile(P.mileage.medical)} each one is small, but a year of visits adds up.`,
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
          const yTypical = median(entries.filter((z) => z.lineId === y).map((z) => Number(z.amount) || 0));
          recs.push({
            id: `pair:${e.id}:${y}`, kind: 'log', priority: 35,
            title: `${Schema.getLine(x).label} on ${fmtDate(e.date)} usually comes with ${yl.label}`,
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
    for (const e of yearEntries) {
      const amounts = amountsByKey.get(keyOf(e));
      if (!amounts || amounts.length < 4) continue;
      const med = median(amounts), amt = Number(e.amount) || 0;
      if (amt > 3 * med && amt - med > 50) recs.push({
        id: `anomaly:${e.id}`, kind: 'check', priority: 45,
        title: `${e.description || Schema.getLine(e.lineId).label} for ${fmtValue(e.lineId, amt)} is far above its usual ${fmtValue(e.lineId, med)}`,
        body: 'Worth a second look; a missing decimal point is the usual cause. If it is right, dismiss this.',
        because: `${amounts.length} entries for the same payee`,
        action: { type: 'edit', entryId: e.id },
      });
    }

    // 5. The plan for the year: bunch, or stop chasing Schedule A
    if (yearEntries.length) {
      const std = projection.standardDeduction;
      if (projection.itemize) {
        recs.push({ id: `plan:itemize:${taxYear}`, kind: 'good', priority: 30, title: `On pace to itemize: about ${money(projection.projectedTotal)} against ${money(std)}`, body: `${money(projection.actual)} counts so far, and recurring items should add about ${money(projection.expectedMore)} by Dec 31. Keep every Schedule A receipt this year.`, because: 'recurring entries projected to year end', action: null });
      } else {
        const gap = projection.gap;
        const candidates = [];
        for (const r of recurrences) {
          if (r.unit === 'miles') continue;
          const prepayable = ['taxes', 'charity', 'volunteer'].includes(r.sectionId) || r.lineId === 'med.insurance';
          if (!prepayable) continue;
          if (r.perYear >= 12) { if (r.sectionId === 'charity') candidates.push({ label: `make next year's ${r.description} gifts in December`, amount: Math.round(r.typicalAmount * r.perYear) }); continue; }
          if (r.nextYearEarly.length) candidates.push({ label: `pay the ${fmtDate(r.nextYearEarly[0])} ${r.description} before Dec 31`, amount: Math.round(r.typicalAmount) });
        }
        candidates.sort((a, b) => b.amount - a.amount);
        const sum = candidates.reduce((a, c) => a + c.amount, 0);
        if (candidates.length && sum >= gap) {
          const picked = []; let acc = 0;
          for (const c of candidates) { if (acc >= gap) break; picked.push(c); acc += c.amount; }
          recs.push({ id: `plan:bunch:${taxYear}`, kind: 'plan', priority: 70, title: `Bunching closes the ${money(gap)} gap this year`, body: `Projected ${money(projection.projectedTotal)} against a ${money(std)} standard deduction. To get over it: ${picked.map((c) => `${c.label} (+${money(c.amount)})`).join('; ')}. Then take the standard deduction next year. Two bunched years beat two years of just missing.`, because: 'deductible bills that usually fall early next year', action: null });
        } else if (gap > std * 0.3) {
          recs.push({ id: `plan:stop:${taxYear}`, kind: 'plan', priority: 40, title: 'You will not itemize this year, so stop chasing Schedule A receipts', body: `Projected ${money(projection.projectedTotal)} against ${money(std)}, ${money(gap)} short${candidates.length ? ` even after ${money(sum)} of bunching` : ''}. Keep logging business costs and student loan interest, which count regardless, and keep medical receipts only if a large expense is coming.`, because: 'projection to year end', action: null });
        } else {
          recs.push({ id: `plan:close:${taxYear}`, kind: 'plan', priority: 55, title: `${money(gap)} short of itemizing, which planning can close`, body: `${candidates.length ? `Bunching covers ${money(sum)}: ${candidates.map((c) => c.label).join('; ')}. ` : ''}Elective dental or vision work, a gift you planned for next year, or a state estimated payment made by Dec 31 could cover the rest.`, because: 'projection to year end', action: null });
        }
      }
    }

    // 6. Logging cadence
    if (habits.typicalGapDays != null && habits.daysSinceLast != null && habits.daysSinceLast > Math.max(7, 2 * habits.typicalGapDays)) {
      recs.push({ id: `habit:cadence:${today.slice(0, 7)}`, kind: 'habit', priority: 25, title: `${habits.daysSinceLast} days since your last entry`, body: `You usually log something every ${Math.round(habits.typicalGapDays)} days. Receipts fade and memories blur; a five-minute catch-up now beats reconstructing a quarter in April.`, because: 'the gaps between your logging days', action: { type: 'capture' } });
    }

    // 7. Receipt habits
    const weak = Object.entries(habits.receiptsBySection)
      .filter(([, s]) => s.count >= 3 && s.withReceipt / s.count < 0.5)
      .sort((a, b) => a[1].withReceipt / a[1].count - b[1].withReceipt / b[1].count)[0];
    if (weak) {
      recs.push({ id: `habit:receipts:${weak[0]}:${taxYear}`, kind: 'habit', priority: 30, title: `Receipts are thin for ${weak[1].title}: ${weak[1].withReceipt} of ${weak[1].count}`, body: weak[0] === 'selfemp' ? 'Business expenses are the first thing an examiner asks for. Snap the receipt as you log the expense.' : 'Attach a photo or tick "paper receipt filed" so the worksheet can vouch for the total.', because: 'receipt rate by section', action: { type: 'ledger', filter: 'noreceipt' } });
    }

    recs.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    return recs.slice(0, 12);
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
      standardDeduction: computed.standardDeduction.total,
      itemizes: computed.verdict.itemize,
      receiptRate: Math.round(computed.substantiation.coverage * 20) / 20,
      recurringItems: recurrences.length,
      cadences,
      entriesPerWeek: habits.entriesPerWeek,
      excluded: ['payees', 'descriptions', 'notes', 'dates', 'receipts', 'exact amounts', 'exact income'],
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
    const projectedEntries = syntheticEntries(recurrences, taxYear);
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
    const habits = computeHabits(yearEntries, entries, today);
    const all = buildRecommendations({ computed, projected, projection, recurrences, yearEntries, entries, habits, today, taxYear });
    const dismissedAt = settings.advisorDismissed || {};
    const recommendations = [], dismissed = [];
    for (const r of all) {
      const at = dismissedAt[r.id];
      if (at && daysBetween(String(at).slice(0, 10), today) < DISMISS_DAYS) dismissed.push(r); else recommendations.push(r);
    }
    return { recommendations, dismissed, recurrences, projection, habits, aggregate: aggregateProfile(computed, habits, recurrences, today) };
  }

  return { analyze, detectRecurrences, aggregateProfile, CADENCES, DISMISS_DAYS, VISIT_LINES };
});
