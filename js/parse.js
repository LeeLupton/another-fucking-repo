/*
 * parse.js — quick-capture parser.
 *
 * Turns "42.13 CVS prescription 3/14" or "$300 tithe yesterday" or
 * "18 miles to physical therapy" into { amount, miles, date, description }.
 * Pure function, no dependencies; used by the Capture view and unit-tested
 * under node --test.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ItemizerParse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const FILLERS = new Set(['paid', 'spent', 'for', 'on', 'at', 'to', 'from', 'the', 'a', 'an', 'of', 'in', 'with', 'by', '-', '–', '—', ',', 'and', 'my', 'our', 'was', 'is', 'cost', 'costs', 'bill', 'bought', 'gave', 'donated', 'via']);
  // Words that, when they end the description, are worth keeping ("donated" tells the classifier a lot).
  const KEEP_IF_ALONE = new Set(['donated', 'gave']);
  // A bare integer followed by one of these is a quantity, not a dollar amount.
  const COUNT_NOUNS = new Set(['bag', 'bags', 'box', 'boxes', 'item', 'items', 'piece', 'pieces', 'session', 'sessions', 'visit', 'visits', 'trip', 'trips', 'night', 'nights', 'day', 'days', 'week', 'weeks', 'month', 'months', 'hour', 'hours', 'people', 'kids', 'ticket', 'tickets', 'pair', 'pairs', 'unit', 'units', 'dose', 'doses', 'pill', 'pills', 'round', 'rounds', 'times', 'x', 'shirts', 'coats', 'shoes', 'books', 'chairs', 'tables', 'toys', 'gallons', 'gal', 'lbs', 'pounds', 'oz', 'pct', 'percent', '%', 'copies', 'pages', 'stamps', 'rolls', 'cans', 'bottles', 'cases', 'packs', 'meals', 'lunches', 'dinners', 'appointments', 'appts', 'prescriptions', 'refills', 'loads', 'cartons']);

  const pad2 = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  const isoFromDate = (dt) => iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  function validYMD(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1)) return false;
    return d <= new Date(y, m, 0).getDate();
  }
  function normalizeYear(y) {
    if (y == null) return null;
    y = Number(y);
    return y < 100 ? 2000 + y : y;
  }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function toDate(isoStr) { return new Date(isoStr + 'T00:00:00'); }
  function toNumber(str) { return Number(String(str).replace(/,/g, '')); }

  /**
   * @param {string} text
   * @param {object} [opts]  { today: 'YYYY-MM-DD', defaultYear: number }
   */
  function parse(text, opts) {
    opts = opts || {};
    const today = opts.today ? toDate(opts.today) : new Date();
    today.setHours(0, 0, 0, 0);
    const currentYear = today.getFullYear();
    const defaultYear = Number(opts.defaultYear) || currentYear;

    const result = { amount: null, miles: null, date: null, dateSource: null, description: '', raw: text == null ? '' : String(text) };
    let s = ' ' + result.raw.replace(/\s+/g, ' ').trim() + ' ';

    // ---- dates -------------------------------------------------------------
    const setDate = (y, m, d, source, yearGiven) => {
      if (!validYMD(y, m, d)) return false;
      if (!yearGiven && defaultYear === currentYear) {
        // No year typed: a date more than a week in the future was probably last year.
        const cand = new Date(y, m - 1, d);
        if (daysBetween(today, cand) > 7) y -= 1;
      }
      result.date = iso(y, m, d);
      result.dateSource = source;
      return true;
    };
    const setRelative = (offsetDays, source) => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() + offsetDays);
      result.date = isoFromDate(dt);
      result.dateSource = source;
    };

    let m;
    if (!result.date && (m = /\bday before yesterday\b/i.exec(s))) { setRelative(-2, 'relative'); s = s.replace(m[0], ' '); }
    if (!result.date && (m = /\b(yesterday|yday)\b/i.exec(s))) { setRelative(-1, 'relative'); s = s.replace(m[0], ' '); }
    if (!result.date && (m = /\b(today|tonight|this morning|this afternoon|just now)\b/i.exec(s))) { setRelative(0, 'relative'); s = s.replace(m[0], ' '); }
    if (!result.date && (m = /\b(\d{1,2})\s+days?\s+ago\b/i.exec(s))) { setRelative(-Number(m[1]), 'relative'); s = s.replace(m[0], ' '); }
    if (!result.date && (m = /\b(?:last|this past|on)\s+(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:[a-z]*)\b/i.exec(s))) {
      const target = WEEKDAYS.findIndex((w) => w.startsWith(m[1].toLowerCase().slice(0, 3)));
      if (target >= 0) {
        let back = (today.getDay() - target + 7) % 7;
        if (back === 0) back = 7;
        setRelative(-back, 'relative');
        s = s.replace(m[0], ' ');
      }
    }
    // ISO 2026-03-14
    if (!result.date && (m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(s))) {
      if (setDate(Number(m[1]), Number(m[2]), Number(m[3]), 'iso', true)) s = s.replace(m[0], ' ');
    }
    // US numeric 3/14, 3/14/26, 3-14-2026, 03.14.2026 (dots only with a year, so 42.13 stays an amount)
    if (!result.date) {
      const re = /(^|\s)(\d{1,2})(?:([\/\-])(\d{1,2})(?:\3(\d{2}|\d{4}))?|\.(\d{1,2})\.(\d{2}|\d{4}))(?=[\s,;)]|$)/g;
      while ((m = re.exec(s))) {
        const dotted = m[6] != null;
        const mon = Number(m[2]);
        const day = Number(dotted ? m[6] : m[4]);
        const yr = dotted ? m[7] : m[5];
        const yearGiven = yr != null;
        if (setDate(yearGiven ? normalizeYear(yr) : defaultYear, mon, day, 'numeric', yearGiven)) { s = s.replace(m[0], ' '); break; }
      }
    }
    // "Mar 14", "March 14th, 2026", "mar. 14"
    if (!result.date && (m = new RegExp('\\b' + MONTH_RE + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b', 'i').exec(s))) {
      const mon = MONTHS[m[1].toLowerCase()];
      const yearGiven = m[3] != null;
      if (mon && setDate(yearGiven ? Number(m[3]) : defaultYear, mon, Number(m[2]), 'month-name', yearGiven)) s = s.replace(m[0], ' ');
    }
    // "14 Mar", "14th of March 2026"
    if (!result.date && (m = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?' + MONTH_RE + '\\.?(?:,?\\s+(20\\d{2}))?\\b', 'i').exec(s))) {
      const mon = MONTHS[m[2].toLowerCase()];
      const yearGiven = m[3] != null;
      if (mon && setDate(yearGiven ? Number(m[3]) : defaultYear, mon, Number(m[1]), 'month-name', yearGiven)) s = s.replace(m[0], ' ');
    }

    // ---- miles -------------------------------------------------------------
    if ((m = /(^|\s)(\d[\d,]*(?:\.\d+)?)\s*(?:mi|mile|miles|mls)\b\.?/i.exec(s))) {
      result.miles = toNumber(m[2]);
      s = s.replace(m[0], ' ');
    }

    // ---- amount ------------------------------------------------------------
    const amountPatterns = [
      /(^|\s)-?\$\s?(\d[\d,]*(?:\.\d{1,2})?)(?=[\s,.;)]|$)/, // $42.13 / $1,200
      /(^|\s)(\d[\d,]*\.\d{2})(?=[\s,;)]|$)/, // 42.13
      /(^|\s)(\d[\d,]*(?:\.\d+)?)\s*(?:dollars|bucks|usd)\b/i, // 40 dollars
      /(^|\s)(\d[\d,]*)(?=[\s,;)]|$)(?!\s*(?:st|nd|rd|th)\b)/g, // bare 40 (skipped when it is clearly a count: "4 bags")
    ];
    for (const re of amountPatterns) {
      re.lastIndex = 0;
      let found = null;
      while ((m = re.exec(s))) {
        const after = s.slice(m.index + m[0].length).trim().split(/\s+/)[0] || '';
        if (re.global && COUNT_NOUNS.has(after.toLowerCase().replace(/[.,;]+$/, ''))) continue;
        found = m; break;
      }
      if (found) {
        const n = toNumber(found[2]);
        if (!isNaN(n)) { result.amount = n; s = s.replace(found[0], ' '); break; }
      }
    }

    // ---- description -------------------------------------------------------
    let tokens = s.trim().split(/\s+/).filter(Boolean);
    // strip stray connector tokens at the ends and where two fillers meet
    const isFiller = (t) => FILLERS.has(t.toLowerCase().replace(/[.,;:!]+$/, ''));
    let changed = true;
    while (changed && tokens.length) {
      changed = false;
      if (tokens.length && isFiller(tokens[0]) && !KEEP_IF_ALONE.has(tokens[0].toLowerCase())) { tokens.shift(); changed = true; }
      if (tokens.length && isFiller(tokens[tokens.length - 1]) && !(tokens.length === 1 && KEEP_IF_ALONE.has(tokens[0].toLowerCase()))) { tokens.pop(); changed = true; }
      for (let i = 0; i < tokens.length - 1; i++) {
        if (isFiller(tokens[i]) && isFiller(tokens[i + 1])) { tokens.splice(i, 2); changed = true; break; }
      }
    }
    let desc = tokens.join(' ').replace(/\s+([,.;])/g, '$1').replace(/^[,;.\-–—\s]+|[,;\-–—\s]+$/g, '').trim();
    if (desc) desc = desc.charAt(0).toUpperCase() + desc.slice(1);
    result.description = desc;
    return result;
  }

  /** Human-readable date, e.g. "Mar 14, 2026". */
  function formatDate(isoStr, withYear) {
    if (!isoStr) return '';
    const [y, mo, d] = isoStr.split('-').map(Number);
    const dt = new Date(y, mo - 1, d);
    return dt.toLocaleDateString('en-US', withYear === false ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function todayISO() { return isoFromDate(new Date()); }

  return { parse, formatDate, todayISO, MONTHS, FILLERS };
});
