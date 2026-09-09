/*
 * importer.js — bring in a bank or card statement.
 *
 * Reads a CSV export, works out which columns are the date, description, and
 * amount, normalises dates and amounts, flags rows that are already in the
 * ledger, and suggests a worksheet line for each row with the same
 * categorizer used for typed entries. Nothing is saved here; the UI shows the
 * rows for review and the user decides.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./classify.js'), require('./schema.js'));
  else root.ItemizerImporter = factory(root.ItemizerClassify, root.ItemizerSchema);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Classify, Schema) {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad2 = (n) => String(n).padStart(2, '0');
  /** A suggestion this strong is pre-ticked; weaker ones are offered in the dropdown only. Single short generic words stay below it. */
  const STRONG_SCORE = 1.15;
  const TYPE_WORDS = new Set(['debit', 'credit', 'd', 'c', 'dr', 'cr', 'sale', 'purchase', 'payment', 'return', 'refund', 'deposit', 'withdrawal', 'fee', 'adjustment', 'interest']);
  const CREDIT_WORDS = /^(credit|c|cr|payment|return|refund|deposit|reversal)$/i;

  /** The most common separator on the first non-empty line, counted outside quotes: comma, semicolon, tab, or pipe. */
  function sniffDelimiter(s) {
    const line = s.split(/\r?\n/).find((l) => l.trim() !== '') || '';
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let q = false;
    for (const c of line) { if (c === '"') q = !q; else if (!q && c in counts) counts[c]++; }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
  }

  /** RFC 4180-ish CSV parser: quotes, escaped quotes, CRLF, BOM, and semicolon/tab/pipe delimited exports. Returns rows of strings. */
  function parseCSV(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const delim = sniffDelimiter(s);
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"' && field === '') inQuotes = true; // a quote opens a field; an inch mark mid-field is just a character
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  /**
   * @param {*} v            cell text
   * @param {{dayFirst?: boolean}} [opts]  day-first exports (25/01/2025); otherwise month-first, swapping only when month-first is impossible
   */
  function parseDateCell(v, opts) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const dayFirst = !!(opts && opts.dayFirst);
    let m;
    if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
    if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(s))) {
      const y0 = Number(m[3]), y = y0 < 100 ? 2000 + y0 : y0, a = Number(m[1]), b = Number(m[2]);
      return dayFirst ? (valid(y, b, a) || valid(y, a, b)) : (valid(y, a, b) || valid(y, b, a));
    }
    if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s,]*(\d{4})/.exec(s))) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; return mo ? valid(Number(m[3]), mo, Number(m[1])) : null; }
    if ((m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? valid(Number(m[3]), mo, Number(m[2])) : null; }
    return null;
  }
  function valid(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(y, mo, 0).getDate() && y >= 1990 && y <= 2100)) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  /** "$1,234.56", "(12.00)", "-12.00", "12.00 CR", "1.234,56" → number (parentheses and CR mean negative). */
  function parseAmountCell(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\bCR\b/i.test(s)) { neg = true; s = s.replace(/\bCR\b/i, ''); }
    s = s.replace(/\bDR\b/i, '').replace(/[$€£\s]/g, '');
    // European exports: 1.234,56 or 1234,56 — a comma with one or two digits after it is the decimal
    // mark, since a US thousands comma is always followed by exactly three digits
    if (/^[-+]?\d+(\.\d{3})*,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (s.startsWith('+')) s = s.slice(1);
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return neg ? -n : n;
  }

  // Anchored hints win; loose hints run afterwards. `reject` keeps a hint away from headers that only look right ("Debit/Credit Indicator", "Account Name").
  const SIDE_REJECT = /debit.*credit|credit.*debit|\bdr\s*\/\s*cr\b|\bcr\s*\/\s*dr\b|indicator|card\s*(number|no\b|#)|\btype\b/i;
  const HEADER_HINTS = {
    date: { strict: [/^(transaction|trans\.?|purchase|sale) date$/i, /^date$/i, /^(post|posted|posting) date$/i], loose: [/date/i] },
    description: { strict: [/^(description|payee|merchant|details|memo\/description|transaction|narrative|particulars|vendor|counterparty|original description)$/i, /^(payee|merchant|vendor) name$/i], loose: [/descr|payee|merchant|narrative|particulars|vendor|counterparty/i, /name/i], reject: /account|card|bank|file/i },
    amount: { strict: [/^amount$/i, /^amount \(?[a-z]{3}\)?$/i], loose: [/amount|amt/i] },
    debit: { strict: [/^(debit|withdrawal|withdrawals|money out|paid out|charge|charges)\b/i], loose: [/\b(debits?|withdrawals?|money out|paid out)\b/i], reject: SIDE_REJECT },
    credit: { strict: [/^(credit|deposit|deposits|money in|paid in)\b(?!\s*card)/i], loose: [/\b(credits?|deposits?|money in|paid in)\b(?!\s*card)/i], reject: SIDE_REJECT },
    type: { strict: [/^(transaction |trans )?type$/i, /^(dr\/cr|debit\/credit|credit\/debit|cr\/dr|indicator|debit\/credit indicator|transaction type)$/i], loose: [] },
    memo: { strict: [/^(memo|category|notes?|memo\/notes)$/i], loose: [] },
  };
  const ALL_HINTS = Object.values(HEADER_HINTS).flatMap((h) => h.strict.concat(h.loose));
  const REF_HEADER = /check|ref|card|no\.?$|number|\bid\b|bal(ance)?\.?$/i;
  const COLS = ['date', 'description', 'amount', 'debit', 'credit', 'type', 'memo'];

  /** Work out which column is which from the header row, falling back to sniffing the cells. */
  function detectColumns(rows) {
    // The header is not always the first line: bank exports often start with account details.
    let headerIndex = 0;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const cells = (rows[i] || []).map((h) => String(h).trim());
      const hits = cells.filter((h) => h && ALL_HINTS.some((re) => re.test(h))).length;
      if (cells.length >= 3 && hits >= 2) { headerIndex = i; break; }
    }
    const header = (rows[headerIndex] || []).map((h) => String(h).trim());
    const map = { date: -1, description: -1, amount: -1, debit: -1, credit: -1, type: -1, memo: -1, headerRow: true, headerIndex, dayFirst: false };
    const used = () => new Set(COLS.map((k) => map[k]).filter((i) => i >= 0));
    const claim = (key, pass) => {
      const hint = HEADER_HINTS[key];
      for (const re of hint[pass]) {
        const taken = used();
        const idx = header.findIndex((h, i) => re.test(h) && !(hint.reject && hint.reject.test(h)) && !taken.has(i));
        if (idx >= 0) { map[key] = idx; return; }
      }
    };
    ['date', 'amount', 'debit', 'credit', 'type', 'description', 'memo'].forEach((k) => claim(k, 'strict'));
    ['date', 'debit', 'credit', 'amount', 'description', 'memo'].forEach((k) => { if (map[k] < 0) claim(k, 'loose'); });
    // No usable header: sniff the first data rows.
    const headerLooksLikeData = header.some((h) => parseDateCell(h)) || (header.length > 0 && header.every((h) => parseAmountCell(h) != null));
    if (headerLooksLikeData) { map.headerRow = false; map.headerIndex = 0; headerIndex = 0; COLS.forEach((k) => { map[k] = -1; }); }
    const dataRows = rows.slice(headerIndex + (map.headerRow ? 1 : 0), headerIndex + 9);
    const width = Math.max(...rows.slice(headerIndex, headerIndex + 6).map((r) => r.length), 0);
    const column = (c) => dataRows.map((r) => (r[c] == null ? '' : String(r[c])));
    const filled = (cells) => cells.filter((v) => v.trim() !== '');
    if (map.date < 0) {
      for (let c = 0; c < width; c++) {
        const cells = filled(column(c));
        if (cells.length && cells.every((v) => parseDateCell(v))) { map.date = c; break; }
      }
    }
    if (map.amount < 0 && map.debit < 0 && map.credit < 0) {
      // Score numeric columns: an amount column carries decimals, signs, or currency marks; a check number or balance mostly does not.
      const candidates = [];
      for (let c = 0; c < width; c++) {
        if (c === map.date || c === map.type || (map.headerRow && REF_HEADER.test(header[c] || ''))) continue;
        const cells = filled(column(c));
        if (!cells.length || !cells.every((v) => parseAmountCell(v) != null)) continue;
        const score = cells.filter((v) => /[.,$()€£+-]/.test(v)).length;
        const negatives = cells.filter((v) => /^\(|^-|\bCR\b/i.test(v.trim())).length;
        candidates.push({ c, score, negatives });
      }
      candidates.sort((a, b) => b.score - a.score || b.negatives - a.negatives || a.c - b.c);
      if (candidates.length) map.amount = candidates[0].c;
    }
    if (map.type < 0) {
      for (let c = 0; c < width; c++) {
        if ([map.date, map.amount, map.debit, map.credit, map.description, map.memo].includes(c)) continue;
        const cells = filled(column(c));
        if (cells.length && cells.every((v) => TYPE_WORDS.has(v.trim().toLowerCase()))) { map.type = c; break; }
      }
    }
    if (map.description < 0) {
      for (let c = 0; c < width; c++) {
        if ([map.date, map.amount, map.debit, map.credit, map.type].includes(c)) continue;
        const cells = column(c);
        if (cells.some((v) => /[A-Za-z]{3,}/.test(v) && parseAmountCell(v) == null && !parseDateCell(v))) { map.description = c; break; }
      }
    }
    // Day-first dates: some first field is above 12 while no second field is.
    if (map.date >= 0) {
      let firstOver = false, secondOver = false;
      for (const v of filled(column(map.date))) {
        const m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(v.trim());
        if (!m) continue;
        if (Number(m[1]) > 12) firstOver = true;
        if (Number(m[2]) > 12) secondOver = true;
      }
      map.dayFirst = firstOver && !secondOver;
    }
    return map;
  }

  /**
   * Turn raw rows into {date, description, amount, memo} with spending positive.
   * When a single amount column is used and most values are negative (card exports),
   * the sign is flipped so spending is positive; refunds and deposits end up negative.
   */
  function normalize(rows, map, opts) {
    opts = opts || {};
    const data = rows.slice((map.headerIndex || 0) + (map.headerRow ? 1 : 0));
    const out = [];
    let skipped = 0;
    const twoCol = map.debit >= 0 || map.credit >= 0;
    const typed = !twoCol && map.type >= 0 && map.amount >= 0; // a debit/credit indicator column settles each row's sign
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const date = parseDateCell(r[map.date], { dayFirst: map.dayFirst });
      let amount = null;
      if (twoCol) {
        const d = map.debit >= 0 ? parseAmountCell(r[map.debit]) : null;
        const c = map.credit >= 0 ? parseAmountCell(r[map.credit]) : null;
        if (d != null && d !== 0) amount = Math.abs(d);
        else if (c != null && c !== 0) amount = -Math.abs(c);
        else if (d == null && c == null && map.amount >= 0) amount = parseAmountCell(r[map.amount]); // a row that only fills the amount column
      } else if (map.amount >= 0) {
        amount = parseAmountCell(r[map.amount]);
        if (typed && amount != null) amount = CREDIT_WORDS.test(String(r[map.type] || '').trim()) ? -Math.abs(amount) : Math.abs(amount);
      }
      const description = String(map.description >= 0 ? r[map.description] || '' : '').replace(/\s+/g, ' ').trim();
      const memo = String(map.memo >= 0 ? r[map.memo] || '' : '').trim();
      if (!date || amount == null) { if (r.some((f) => String(f || '').trim() !== '')) skipped++; continue; }
      out.push({ index: i, date, description, amount, memo, raw: r });
    }
    let spendIsNegative = opts.spendIsNegative;
    if (spendIsNegative == null && !twoCol) {
      // the file's own convention, from the raw signs; with an indicator column it is reported but the signs come from the indicator
      const raw = typed ? out.map((x) => parseAmountCell(x.raw[map.amount])) : out.map((x) => x.amount);
      const neg = raw.filter((v) => v < 0).length, pos = raw.filter((v) => v > 0).length;
      spendIsNegative = neg > 0 && neg >= pos; // card exports are the common signed format, so a tie goes to "spending is negative"
    }
    if (spendIsNegative && !twoCol && !typed) for (const x of out) x.amount = -x.amount;
    for (const x of out) x.amount = Math.round(x.amount * 100) / 100;
    return { rows: out, spendIsNegative: !!spendIsNegative, skipped };
  }

  /** A stable key for a statement layout, so a column mapping can be remembered per bank export. */
  function headerSignature(headerRow) {
    return (headerRow || []).map((h) => String(h || '').trim().toLowerCase()).join('|');
  }

  const payeeToken = (desc) => String(desc || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 24);
  /** date + signed cents + payee. A refund never matches its charge; two same-day charges at different shops never match each other. */
  const dupKey = (date, amount, description) => `${date}|${Math.round(Number(amount) * 100)}|${payeeToken(description)}`;
  const REFUND_WORDS = /\b(refund|return|reversal|credit adj(?:ustment)?|chargeback)\b/i;

  /**
   * Attach line suggestions, duplicate flags, and non-deductible warnings.
   * @param {Array} normRows
   * @param {{learned?: Object, weights?: Object, existingEntries?: Array, hasBusiness?: boolean}} [opts]
   *   hasBusiness: pre-tick Schedule C lines only when the ledger already shows self-employment
   */
  function review(normRows, opts) {
    opts = opts || {};
    const ledger = (opts.existingEntries || []).filter((e) => !(Schema && Schema.isMiles && Schema.isMiles(e.lineId)));
    const existing = new Set(ledger.filter((e) => payeeToken(e.description)).map((e) => dupKey(e.date, e.amount, e.description)));
    const existingLoose = new Set(ledger.filter((e) => !payeeToken(e.description)).map((e) => dupKey(e.date, e.amount, '')));
    const seenHere = new Set();
    return normRows.map((x) => {
      const key = dupKey(x.date, x.amount, x.description);
      const duplicate = existing.has(key) || seenHere.has(key);
      const possibleDuplicate = !duplicate && existingLoose.has(dupKey(x.date, x.amount, ''));
      seenHere.add(key);
      const res = Classify.classify([x.description, x.memo].filter(Boolean).join(' '), { learned: opts.learned, weights: opts.weights, limit: 3 });
      const top = res.suggestions[0] || null;
      const refund = x.amount <= 0 || REFUND_WORDS.test(x.description);
      const strong = !!top && (!!top.learned || (top.score >= STRONG_SCORE && !(top.lineId.startsWith('se.') && !opts.hasBusiness)));
      return Object.assign({}, x, {
        duplicate,
        possibleDuplicate,
        refund,
        lineId: top ? top.lineId : '',
        suggestions: res.suggestions,
        because: top ? top.because : [],
        nonDeductible: res.nonDeductible,
        strong,
        selected: strong && !duplicate && !refund && x.amount > 0 && !res.nonDeductible.length,
      });
    });
  }

  return { parseCSV, sniffDelimiter, parseDateCell, parseAmountCell, detectColumns, normalize, review, dupKey, headerSignature, STRONG_SCORE };
});
