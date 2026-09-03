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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./classify.js'));
  else root.ItemizerImporter = factory(root.ItemizerClassify);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Classify) {
  'use strict';

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const pad2 = (n) => String(n).padStart(2, '0');

  /** RFC 4180-ish CSV parser: quotes, escaped quotes, CRLF, BOM. Returns rows of strings. */
  function parseCSV(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
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

  function parseDateCell(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
    if ((m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(s))) { const y = Number(m[3]); return valid(y < 100 ? 2000 + y : y, Number(m[1]), Number(m[2])); }
    if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s,]*(\d{4})/.exec(s))) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; return mo ? valid(Number(m[3]), mo, Number(m[1])) : null; }
    if ((m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s))) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; return mo ? valid(Number(m[3]), mo, Number(m[2])) : null; }
    return null;
  }
  function valid(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(y, mo, 0).getDate() && y >= 1990 && y <= 2100)) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  /** "$1,234.56", "(12.00)", "-12.00", "12.00 CR" → number (parentheses and CR mean negative). */
  function parseAmountCell(v) {
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\bCR\b/i.test(s)) { neg = true; s = s.replace(/\bCR\b/i, ''); }
    s = s.replace(/\bDR\b/i, '').replace(/[$,\s]/g, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (s.startsWith('+')) s = s.slice(1);
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return neg ? -n : n;
  }

  const HEADER_HINTS = {
    date: [/^(transaction |trans |posting |posted |post )?date$/i, /date/i],
    description: [/^(description|payee|merchant|name|details|memo\/description|transaction)$/i, /descr|payee|merchant|narrative|details|name/i],
    amount: [/^amount$/i, /amount|amt/i],
    debit: [/^(debit|withdrawal|withdrawals|money out|paid out|charge)/i],
    credit: [/^(credit|deposit|deposits|money in|paid in)/i],
    memo: [/^(memo|category|type|notes?)$/i],
  };

  /** Work out which column is which from the header row, falling back to sniffing the cells. */
  function detectColumns(rows) {
    const header = (rows[0] || []).map((h) => String(h).trim());
    const map = { date: -1, description: -1, amount: -1, debit: -1, credit: -1, memo: -1, headerRow: true };
    const claim = (key, pass) => {
      for (const re of HEADER_HINTS[key]) {
        if (pass === 'strict' && re !== HEADER_HINTS[key][0]) continue;
        const idx = header.findIndex((h, i) => re.test(h) && !Object.values(map).includes(i));
        if (idx >= 0) { map[key] = idx; return; }
      }
    };
    ['date', 'amount', 'debit', 'credit', 'description', 'memo'].forEach((k) => claim(k, 'strict'));
    ['date', 'debit', 'credit', 'amount', 'description', 'memo'].forEach((k) => { if (map[k] < 0) claim(k, 'loose'); });
    // No usable header: sniff the first data rows.
    const sample = rows.slice(map.date >= 0 || map.description >= 0 ? 1 : 0, 6);
    const headerLooksLikeData = header.some((h) => parseDateCell(h)) || header.every((h) => parseAmountCell(h) != null);
    if (headerLooksLikeData) { map.headerRow = false; Object.keys(map).forEach((k) => { if (k !== 'headerRow') map[k] = -1; }); }
    if (map.date < 0 || (map.amount < 0 && map.debit < 0)) {
      const width = Math.max(...rows.slice(0, 6).map((r) => r.length), 0);
      for (let c = 0; c < width; c++) {
        const cells = (map.headerRow ? rows.slice(1, 8) : rows.slice(0, 8)).map((r) => r[c]);
        if (map.date < 0 && cells.filter(Boolean).length && cells.every((v) => !v || parseDateCell(v))) { map.date = c; continue; }
        if (map.amount < 0 && map.debit < 0 && cells.filter(Boolean).length && cells.every((v) => !v || parseAmountCell(v) != null) && c !== map.date) { map.amount = c; continue; }
      }
      if (map.description < 0) {
        for (let c = 0; c < width; c++) {
          if (c === map.date || c === map.amount || c === map.debit || c === map.credit) continue;
          const cells = (map.headerRow ? rows.slice(1, 8) : rows.slice(0, 8)).map((r) => r[c] || '');
          if (cells.some((v) => /[A-Za-z]{3,}/.test(v) && parseAmountCell(v) == null && !parseDateCell(v))) { map.description = c; break; }
        }
      }
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
    const data = map.headerRow ? rows.slice(1) : rows;
    const out = [];
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const date = parseDateCell(r[map.date]);
      let amount = null;
      if (map.debit >= 0 || map.credit >= 0) {
        const d = map.debit >= 0 ? parseAmountCell(r[map.debit]) : null;
        const c = map.credit >= 0 ? parseAmountCell(r[map.credit]) : null;
        if (d != null && d !== 0) amount = Math.abs(d);
        else if (c != null && c !== 0) amount = -Math.abs(c);
      } else if (map.amount >= 0) amount = parseAmountCell(r[map.amount]);
      const description = String(map.description >= 0 ? r[map.description] || '' : '').replace(/\s+/g, ' ').trim();
      const memo = String(map.memo >= 0 ? r[map.memo] || '' : '').trim();
      if (!date || amount == null) continue;
      out.push({ index: i, date, description, amount, memo, raw: r });
    }
    let spendIsNegative = opts.spendIsNegative;
    if (spendIsNegative == null && map.debit < 0 && map.credit < 0) {
      const neg = out.filter((x) => x.amount < 0).length, pos = out.filter((x) => x.amount > 0).length;
      spendIsNegative = neg > pos;
    }
    if (spendIsNegative && map.debit < 0 && map.credit < 0) for (const x of out) x.amount = -x.amount;
    for (const x of out) x.amount = Math.round(x.amount * 100) / 100;
    return { rows: out, spendIsNegative: !!spendIsNegative };
  }

  /** A stable key for a statement layout, so a column mapping can be remembered per bank export. */
  function headerSignature(headerRow) {
    return (headerRow || []).map((h) => String(h || '').trim().toLowerCase()).join('|');
  }

  const dupKey = (date, amount) => `${date}|${Math.round(Math.abs(Number(amount)) * 100)}`;

  /** Attach line suggestions, duplicate flags, and non-deductible warnings. */
  function review(normRows, opts) {
    opts = opts || {};
    const existing = new Set((opts.existingEntries || []).map((e) => dupKey(e.date, e.amount)));
    const seenHere = new Set();
    return normRows.map((x) => {
      const key = dupKey(x.date, x.amount);
      const duplicate = existing.has(key) || seenHere.has(key);
      seenHere.add(key);
      const res = Classify.classify([x.description, x.memo].filter(Boolean).join(' '), { learned: opts.learned, weights: opts.weights, limit: 3 });
      const top = res.suggestions[0] || null;
      return Object.assign({}, x, {
        duplicate,
        refund: x.amount <= 0,
        lineId: top ? top.lineId : '',
        suggestions: res.suggestions,
        because: top ? top.because : [],
        nonDeductible: res.nonDeductible,
        selected: !!top && !duplicate && x.amount > 0 && !res.nonDeductible.length,
      });
    });
  }

  return { parseCSV, parseDateCell, parseAmountCell, detectColumns, normalize, review, dupKey, headerSignature };
});
