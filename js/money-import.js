/*
 * money-import.js — bring transactions in from the files banks hand out.
 *
 *   OFX, QFX, and QBO (the "Download to Quicken / QuickBooks / Money" files): both the SGML dialect of OFX 1.x,
 *   where most tags are never closed, and the XML of OFX 2.x. Bank and card statements give transactions with the
 *   bank's own id for each (FITID) and the closing balance; brokerage statements give positions and securities.
 *   CSV: any bank or card export the tax importer can read, plus the columns an export from another budgeting app
 *   carries (account, category, tags, notes, the original statement line, a running balance).
 *
 * Account numbers never reach storage: an account found in a file is matched by a hash of its number and shown by
 * the last four digits. Nothing is saved here; the UI shows the review and the user decides.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./importer.js'), require('./money.js'));
  else root.ItemizerMoneyImport = factory(root.ItemizerImporter, root.ItemizerMoney);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (IMP, M) {
  'use strict';

  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

  /** A short, stable, non-reversible tag for an account number (FNV-1a, 32 bits, twice with different seeds). */
  function hashId(s) {
    const str = String(s || '');
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    return a.toString(36) + b.toString(36);
  }
  const lastFour = (acctId) => { const d = String(acctId || '').replace(/\D/g, ''); return d.length >= 4 ? d.slice(-4) : d; };

  // ---- OFX ---------------------------------------------------------------------------------------------

  /** True when the text is an OFX file of either dialect. */
  const isOFX = (text) => /<OFX>/i.test(String(text || '')) || /OFXHEADER/i.test(String(text || '').slice(0, 400));

  /** The inner text of every <TAG>…</TAG> aggregate (aggregates are closed in both dialects). */
  function blocks(text, tag) {
    const out = [];
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
    let m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }
  /** The value of a leaf element: everything after <TAG> up to the next tag or line end, entities decoded. */
  function field(text, tag) {
    const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(text || '');
    if (!m) return '';
    return m[1].replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&nbsp;/gi, ' ').trim();
  }
  /** OFX dates: YYYYMMDD with an optional time and zone after it. The calendar day is what the bank meant. */
  function ofxDate(v) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || '').trim());
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate())) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  /** OFX amounts are plain signed decimals, though some banks write a comma for the point. */
  function ofxAmount(v) {
    const s = String(v || '').trim().replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, '');
    if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
    return Number(s);
  }

  function ofxTransactions(text) {
    return blocks(text, 'STMTTRN').map((b) => {
      const date = ofxDate(field(b, 'DTPOSTED')) || ofxDate(field(b, 'DTUSER'));
      const amount = ofxAmount(field(b, 'TRNAMT'));
      const name = field(b, 'NAME') || field(b, 'PAYEE') || '';
      const memo = field(b, 'MEMO');
      return { fitid: field(b, 'FITID').slice(0, 120), date, amount: amount == null ? null : M.cents(amount), name, memo, type: field(b, 'TRNTYPE').toUpperCase(), checkNum: field(b, 'CHECKNUM') };
    }).filter((t) => t.date && t.amount != null);
  }

  /**
   * Every statement in an OFX file, as
   *   { kind: 'bank'|'credit'|'investment', key, mask, acctType, currency, balance, balanceDate, transactions, positions, cash }
   * `key` is the hash an account is matched by; the number itself is not returned.
   */
  function parseOFX(text) {
    const src = String(text || '');
    if (!isOFX(src)) throw new Error('That file is not an OFX, QFX, or QBO statement.');
    const body = src.slice(Math.max(0, src.search(/<OFX>/i)));
    const statements = [];
    const balanceOf = (b) => { const lb = blocks(b, 'LEDGERBAL')[0]; if (!lb) return { balance: null, balanceDate: null }; const v = ofxAmount(field(lb, 'BALAMT')); return { balance: v == null ? null : M.cents(v), balanceDate: ofxDate(field(lb, 'DTASOF')) }; };
    for (const b of blocks(body, 'STMTRS')) {
      const from = blocks(b, 'BANKACCTFROM')[0] || '';
      const acctId = field(from, 'ACCTID'), bankId = field(from, 'BANKID');
      const acctType = field(from, 'ACCTTYPE').toUpperCase();
      statements.push(Object.assign({ kind: 'bank', key: 'ofx-' + hashId(`${bankId}:${acctId}`), mask: lastFour(acctId), acctType, currency: field(b, 'CURDEF') || 'USD', transactions: ofxTransactions(b), positions: [] }, balanceOf(b)));
    }
    for (const b of blocks(body, 'CCSTMTRS')) {
      const from = blocks(b, 'CCACCTFROM')[0] || '';
      const acctId = field(from, 'ACCTID');
      statements.push(Object.assign({ kind: 'credit', key: 'ofx-' + hashId(`cc:${acctId}`), mask: lastFour(acctId), acctType: 'CREDITLINE', currency: field(b, 'CURDEF') || 'USD', transactions: ofxTransactions(b), positions: [] }, balanceOf(b)));
    }
    // securities are listed once, outside the statements, and positions refer to them by id
    const secs = new Map();
    for (const info of blocks(body, 'SECINFO')) {
      const id = field(blocks(info, 'SECID')[0] || info, 'UNIQUEID');
      if (id) secs.set(id, { ticker: field(info, 'TICKER'), name: field(info, 'SECNAME') });
    }
    for (const b of blocks(body, 'INVSTMTRS')) {
      const from = blocks(b, 'INVACCTFROM')[0] || '';
      const acctId = field(from, 'ACCTID'), brokerId = field(from, 'BROKERID');
      const positions = [];
      for (const kind of ['POSSTOCK', 'POSMF', 'POSDEBT', 'POSOPT', 'POSOTHER']) {
        for (const p of blocks(b, kind)) {
          const inv = blocks(p, 'INVPOS')[0] || p;
          const secId = field(blocks(inv, 'SECID')[0] || inv, 'UNIQUEID');
          const sec = secs.get(secId) || {};
          const units = ofxAmount(field(inv, 'UNITS')), price = ofxAmount(field(inv, 'UNITPRICE')), value = ofxAmount(field(inv, 'MKTVAL'));
          if (units == null) continue;
          positions.push({ secId: secId.slice(0, 40), symbol: (sec.ticker || secId || '').slice(0, 16), name: (sec.name || '').slice(0, 120), shares: units, price: price != null ? price : value != null && units ? value / units : 0, value: value != null ? M.cents(value) : null, priceDate: ofxDate(field(inv, 'DTPRICEASOF')), kind: kind.slice(3).toLowerCase() });
        }
      }
      const bal = blocks(b, 'INVBAL')[0] || '';
      const cash = ofxAmount(field(bal, 'AVAILCASH'));
      const asOf = ofxDate(field(b, 'DTASOF'));
      // the cash side of a brokerage statement: deposits, withdrawals, dividends paid in cash
      const transactions = blocks(b, 'INVBANKTRAN').flatMap((t) => ofxTransactions(t));
      const total = positions.reduce((a, p) => a + (p.value != null ? p.value : p.shares * p.price), 0) + (cash || 0);
      statements.push({ kind: 'investment', key: 'ofx-' + hashId(`${brokerId}:${acctId}`), mask: lastFour(acctId), acctType: 'INVESTMENT', currency: field(b, 'CURDEF') || 'USD', transactions, positions, cash: cash == null ? null : M.cents(cash), balance: M.cents(total), balanceDate: asOf });
    }
    if (!statements.length) throw new Error('No bank, card, or investment statement was found in that file.');
    return { statements };
  }
  /** The account type an OFX statement describes. */
  function ofxAccountType(st) {
    if (st.kind === 'credit') return 'credit';
    if (st.kind === 'investment') return 'brokerage';
    if (/SAVINGS|MONEYMRKT|CD/.test(st.acctType)) return 'savings';
    if (/CREDITLINE/.test(st.acctType)) return 'credit';
    return 'checking';
  }

  // ---- CSV -------------------------------------------------------------------------------------------------

  // the columns a budgeting-app export carries beyond date, description, and amount
  const EXTRA_HINTS = {
    account: /^(account|account name|account title)$/i,
    category: /^(category|category name|categories)$/i,
    tags: /^(tags?|labels?)$/i,
    notes: /^(notes?|memo|comments?)$/i,
    original: /^(original statement|original description|statement description|full description|bank description)$/i,
    balance: /^((running|ledger|available|current) )?balance( \(?[a-z$]{1,3}\)?)?$/i,
  };

  /**
   * The tax importer's column detection, plus the columns above. Returns the importer's map with `account`,
   * `category`, `tags`, `notes`, `original`, and `balance` added (-1 when absent).
   */
  function detectColumns(rows) {
    const map = IMP.detectColumns(rows);
    const header = map.headerRow ? (rows[map.headerIndex] || []).map((h) => String(h || '').trim()) : [];
    const claimed = new Set(['date', 'description', 'amount', 'debit', 'credit', 'type'].map((k) => map[k]).filter((i) => i >= 0));
    for (const [k, re] of Object.entries(EXTRA_HINTS)) {
      const i = header.findIndex((h, j) => re.test(h) && !claimed.has(j));
      map[k] = i;
      if (i >= 0) claimed.add(i);
    }
    // the importer may have taken a Category or Notes column as its memo; here they are their own columns
    if (map.memo >= 0 && (map.memo === map.category || map.memo === map.notes)) map.memo = -1;
    return map;
  }

  /**
   * Rows of a CSV as transactions in the money convention (money in positive), with the extra columns read out.
   * `opts.spendIsNegative` forces the file's sign convention, as the tax importer allows.
   * Returns { rows: [{ index, date, amount, description, original, account, category, tags, notes, balance }], spendIsNegative, skipped }.
   */
  function normalize(rows, map, opts) {
    const res = IMP.normalize(rows, map, opts);
    const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).replace(/\s+/g, ' ').trim() : '');
    const out = res.rows.map((x) => {
      const bal = map.balance >= 0 ? IMP.parseAmountCell(x.raw[map.balance]) : null;
      const tags = cell(x.raw, map.tags).split(/[,;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 12);
      const memo = map.memo >= 0 ? cell(x.raw, map.memo) : '';
      return {
        index: x.index, date: x.date,
        amount: M.cents(-x.amount), // the tax importer counts spending as positive; money out is negative here
        description: x.description, original: cell(x.raw, map.original) || x.description,
        account: cell(x.raw, map.account), category: cell(x.raw, map.category), tags,
        notes: [cell(x.raw, map.notes), memo].filter(Boolean).join(' · ').slice(0, 1000),
        balance: bal == null ? null : M.cents(bal),
      };
    });
    return { rows: out, spendIsNegative: res.spendIsNegative, skipped: res.skipped };
  }

  /**
   * The closing balance a CSV states for an account, from its running-balance column: the row on the latest date,
   * and of several on that day, the one the file lists last in time (files run newest-first or oldest-first; the
   * order of the dates says which). Null when the file has no balance column.
   */
  function closingBalance(rows) {
    const withBal = rows.filter((r) => r.balance != null && ISO_DAY.test(r.date));
    if (!withBal.length) return null;
    const newestFirst = withBal.length > 1 && withBal[0].date > withBal[withBal.length - 1].date;
    const latest = withBal.reduce((a, r) => (r.date > a ? r.date : a), withBal[0].date);
    const onDay = withBal.filter((r) => r.date === latest);
    const row = newestFirst ? onDay[0] : onDay[onDay.length - 1];
    return { date: row.date, balance: row.balance };
  }

  // ---- review -----------------------------------------------------------------------------------------------

  /**
   * Ready incoming rows for the review screen. Each row gets a cleaned merchant, a suggested category (rules, then
   * history, then keywords), the account it belongs to, and a duplicate flag: a row matches an existing transaction
   * by the bank's own id when both have one, or else by account, date, amount, and merchant, counted, so a file with
   * two identical coffees on one day still brings in the one the ledger lacks.
   *
   * `rows`: [{ date, amount, description, original?, fitid?, accountId, category?, tags?, notes? }]
   * `ctx`: { transactions, categories, rules, history, accountsById, categoryNames? }
   */
  function review(rows, ctx) {
    const existing = ctx.transactions || [];
    const byFitid = new Set(existing.filter((t) => t.fitid).map((t) => `${t.accountId}|${t.fitid}`));
    const keyCount = new Map();
    for (const t of existing) { const k = M.importKey(t.accountId, t.date, t.amount, t.merchant); keyCount.set(k, (keyCount.get(k) || 0) + 1); }
    const origCount = new Map();
    for (const t of existing) if (t.original) { const k = M.importKey(t.accountId, t.date, t.amount, t.original); origCount.set(k, (origCount.get(k) || 0) + 1); }
    const take = (map, k) => { const n = map.get(k) || 0; if (n > 0) { map.set(k, n - 1); return true; } return false; };
    const cats = ctx.categories || M.DEFAULT_CATEGORIES;
    return rows.map((r) => {
      const original = (r.original || r.description || '').slice(0, 300);
      const merchant = M.cleanMerchant(r.description || original) || original.slice(0, 80);
      let duplicate = false;
      if (r.fitid && byFitid.has(`${r.accountId}|${r.fitid}`)) duplicate = true;
      else if (take(keyCount, M.importKey(r.accountId, r.date, r.amount, merchant))) duplicate = true;
      else if (take(origCount, M.importKey(r.accountId, r.date, r.amount, original))) duplicate = true;
      const tx = { accountId: r.accountId, date: r.date, amount: r.amount, merchant, original };
      const account = ctx.accountsById ? ctx.accountsById.get(r.accountId) : null;
      // a category named in the file wins when it means one of ours; otherwise the usual suggestion
      let categoryId = null, because = '', newCategory = '';
      if (r.category) {
        categoryId = M.categoryByName(r.category, cats);
        if (categoryId) because = `"${r.category}" in the file`;
        else if (!/^uncategori[sz]ed$/i.test(r.category.trim())) newCategory = r.category.trim().slice(0, 60);
      }
      if (!categoryId) { const s = M.suggestCategory(tx, { categories: cats, rules: ctx.rules, history: ctx.history, account }); categoryId = s.categoryId; because = s.because; }
      const { patch } = M.applyRules(tx, ctx.rules);
      return Object.assign({}, r, {
        merchant: patch.merchant || merchant, original, categoryId, because, newCategory,
        tags: Array.from(new Set((r.tags || []).concat(patch.tags || []))), hidden: !!patch.hidden, reviewed: !!patch.reviewed,
        duplicate, selected: !duplicate,
      });
    });
  }

  return { parseOFX, isOFX, ofxAccountType, ofxDate, ofxAmount, hashId, lastFour, detectColumns, normalize, closingBalance, review, EXTRA_HINTS };
});
