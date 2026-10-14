/*
 * money-app.js — the money views: Dashboard, Accounts, Transactions, Cash flow, Budget, Recurring, Goals, Investments,
 * the statement import, and the money part of Settings.
 *
 * Plain DOM, like app.js. app.js owns the shell (routing, the modal, the toast, the tax side) and hands this module
 * the helpers it needs; this module owns the money rows and renders its eight views from them. The figures all come
 * from money.js, so every number on screen is one the tests can check.
 */
(function (root) {
  'use strict';

  root.ItemizerMoneyApp = function (ui) {
    const M = root.ItemizerMoney, MI = root.ItemizerMoneyImport, IMP = root.ItemizerImporter, DB = root.ItemizerStore;
    const S = root.ItemizerSchema, C = root.ItemizerClassify;
    const { $, $$, esc, listen, toast, openModal, closeModal, confirmDialog, focusKeyOf, restoreFocus, go, plural } = ui;

    const VIEWS = ['dashboard', 'accounts', 'transactions', 'cashflow', 'budget', 'recurring', 'goals', 'investments'];
    const TITLES = { dashboard: 'Dashboard', accounts: 'Accounts', transactions: 'Transactions', cashflow: 'Cash flow', budget: 'Budget', recurring: 'Recurring', goals: 'Goals', investments: 'Investments' };
    const TX_FILTERS = ['all', 'review', 'uncategorized', 'deductible', 'hidden'];
    const TX_PAGE = 150;
    const money = (n) => M.money(n);
    const moneyC = (n) => M.money(n, { cents: true });

    // ---- state -------------------------------------------------------------------------------------------
    const ms = {
      accounts: [], transactions: [], balances: [], holdings: [], goals: [], budgets: [], categories: [], rules: [], recurring: [],
      d: null, dirty: true,
      ui: {
        tx: freshTxUI(),
        budgetMonth: null,
        cash: { period: 'month', anchor: null, by: 'category' },
        nwRange: 12,
        recurringMonth: null,
        showAllBudget: false,
        showHiddenAccounts: false,
        importer: null,
      },
    };
    function freshTxUI() { return { q: '', filter: 'all', accountId: '', categoryId: '', month: '', tag: '', selectMode: false, selected: new Set(), shown: TX_PAGE }; }

    async function load() {
      const m = await DB.getMoney();
      for (const k of DB.MONEY_STORES) ms[k] = m[k] || [];
      ms.dirty = true;
      ms.ui.tx.selected.clear(); ms.ui.tx.selectMode = false;
    }

    const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

    /** Everything the views read, worked out once per change rather than once per view. */
    function derive() {
      if (!ms.dirty && ms.d && ms.d.today === M.todayISO()) return ms.d;
      const today = M.todayISO();
      const categories = M.effectiveCategories(ms.categories);
      const index = M.categoryIndex(categories);
      const txByAccount = groupBy(ms.transactions, 'accountId');
      const snapsByAccount = groupBy(ms.balances, 'accountId');
      const portfolio = M.portfolio(ms.holdings);
      const ledgers = {};
      for (const a of ms.accounts) {
        const fromHoldings = portfolio.byAccount.has(a.id) ? portfolio.byAccount.get(a.id) : null;
        ledgers[a.id] = M.makeLedger(a, txByAccount.get(a.id) || [], snapsByAccount.get(a.id) || [], { today, current: fromHoldings });
      }
      const accountsById = new Map(ms.accounts.map((a) => [a.id, a]));
      const overrides = new Map(ms.recurring.map((r) => [r.id, r]));
      const streams = M.detectRecurring(ms.transactions, { today, overrides, index });
      const reviewCount = ms.transactions.filter((t) => !t.reviewed && !t.hidden).length;
      ms.d = { today, categories, index, txByAccount, snapsByAccount, ledgers, accountsById, streams, portfolio, reviewCount, history: null };
      ms.dirty = false;
      return ms.d;
    }
    const history = () => { const d = derive(); if (!d.history) d.history = M.buildHistory(ms.transactions); return d.history; };
    const balanceOf = (id) => { const d = derive(); return d.ledgers[id] ? d.ledgers[id].current : 0; };
    const balanceOn = (id, date) => { const d = derive(); return d.ledgers[id] ? d.ledgers[id].at(date) : 0; };
    const liveAccounts = () => ms.accounts.filter((a) => !a.closed);
    const hasMoney = () => ms.accounts.length > 0 || ms.transactions.length > 0;
    const hasSamples = () => DB.MONEY_DATA.some((k) => ms[k].some((r) => r.sample));

    // ---- writing ----------------------------------------------------------------------------------------
    /** Write a batch and mirror it in memory; throws on failure with nothing changed. */
    async function commit(batch) {
      const put = await DB.writeMoney(batch);
      for (const [store, rows] of Object.entries(put)) {
        const key = DB.STORES[store].key;
        const map = new Map(ms[store].map((r) => [r[key], r]));
        for (const r of rows) map.set(r[key], r);
        ms[store] = Array.from(map.values());
      }
      for (const [store, keys] of Object.entries((batch && batch.delete) || {})) {
        const key = DB.STORES[store].key, gone = new Set(keys);
        ms[store] = ms[store].filter((r) => !gone.has(r[key]));
      }
      ms.dirty = true;
      return put;
    }
    async function save(batch, okMsg, opts) {
      try { await commit(batch); }
      catch (e) { toast(`Could not save: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000); return false; }
      if (okMsg) toast(okMsg, opts && opts.ms, opts && opts.action);
      return true;
    }
    const now = () => new Date().toISOString();
    const rerender = () => ui.render();

    // ---- small pieces of markup ----------------------------------------------------------------------------
    const ICON = {
      plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
      upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M12 10v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.1" fill="currentColor"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      tax: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M10 12h6M10 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
      dot: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>',
    };
    const slotOf = (groupId) => (M.GROUP_BY_ID[groupId] ? M.GROUP_BY_ID[groupId].slot : 0);
    function catDot(categoryId) { const d = derive(); const g = d.index.groupOf(categoryId); return `<span class="cat-dot ${g.kind === 'income' ? 's-in' : g.kind === 'transfer' ? 's-xfer' : `s-${slotOf(g.id)}`}" aria-hidden="true"></span>`; }
    const catName = (id) => derive().index.get(id).name;
    const accountName = (id) => { const a = derive().accountsById.get(id); return a ? a.name : 'Removed account'; };
    const accountSub = (a) => [a.institution, a.mask ? `••${a.mask}` : '', M.accountType(a.type).label].filter(Boolean).join(' · ');
    /** A transaction amount: money in carries a plus sign and the money-in colour; money out is plain. */
    function amountHTML(n) { const v = Number(n) || 0; return v > 0 ? `<span class="amt-in">+${esc(moneyC(v))}</span>` : `<span class="amt-out">${esc(moneyC(-v))}</span>`; }
    /** An account balance as people read it: what an asset is worth, or what a debt still owes. */
    function balanceHTML(a, b) { return M.isLiability(a) ? `${esc(money(Math.max(0, -b)))}${b > 0 ? ' <small>credit</small>' : ''}` : esc(money(b)); }
    function deltaHTML(n, opts) {
      const v = Number(n) || 0;
      if (Math.abs(v) < 0.5) return '<span class="delta">no change</span>';
      const good = opts && opts.downIsGood ? v < 0 : v > 0;
      return `<span class="delta ${good ? 'delta-good' : 'delta-bad'}"><span aria-hidden="true">${v > 0 ? '▲' : '▼'}</span> ${esc(money(Math.abs(v)))}${opts && opts.suffix ? ` ${esc(opts.suffix)}` : ''}</span>`;
    }
    function categoryOptions(selected, opts) {
      const d = derive();
      const kinds = opts && opts.kinds;
      return M.GROUPS.filter((g) => !kinds || kinds.includes(g.kind)).map((g) => {
        const cats = (d.index.byGroup.get(g.id) || []).filter((c) => !c.hidden || c.id === selected);
        if (!cats.length) return '';
        return `<optgroup label="${esc(g.name)}">${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
      }).join('');
    }
    function accountOptions(selected, filter) {
      return ms.accounts.filter((a) => (!filter || filter(a)) && (!a.closed || a.id === selected)).map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ''}</option>`).join('');
    }
    function monthSwitcher(id, ym, label) {
      return `<div class="month-switch" role="group" aria-label="${esc(label || 'Month')}">
        <button class="btn btn-ghost btn-icon" type="button" data-month-step="-1" data-month-for="${id}" aria-label="Previous month">${ICON.left}</button>
        <span class="month-switch-label">${esc(M.monthLabel(ym, { long: true }))}</span>
        <button class="btn btn-ghost btn-icon" type="button" data-month-step="1" data-month-for="${id}" aria-label="Next month">${ICON.right}</button>
      </div>`;
    }
    function statTile(label, value, sub, cls) { return `<div class="stat ${cls || ''}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`; }
    /** A meter for spent against available: the fill carries the state, the words say it too. */
    function progressHTML(spent, available, opts) {
      opts = opts || {};
      const over = available > 0 ? spent > available + 0.004 : spent > 0.004 && !opts.noBudgetOk;
      const pctUsed = available > 0 ? Math.min(1, Math.max(0, spent / available)) : spent > 0 ? 1 : 0;
      const marker = opts.pace != null && available > 0 ? `<span class="prog-pace" style="left:${(opts.pace * 100).toFixed(1)}%" aria-hidden="true"></span>` : '';
      return `<div class="prog ${over ? 'is-over' : ''} ${opts.cls || ''}" aria-hidden="true"><div class="prog-fill" style="width:${(pctUsed * 100).toFixed(1)}%"></div>${marker}</div>`;
    }
    function leftText(remaining, available) {
      if (available <= 0 && remaining >= 0) return '<span class="muted">No budget</span>';
      return remaining >= 0 ? `<span class="left-ok">${esc(money(remaining))} left</span>` : `<span class="left-over">${ICON.alert}${esc(money(-remaining))} over</span>`;
    }
    const pctText = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

    // ---- charts ----------------------------------------------------------------------------------------------
    function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw || 1))); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
    function ticksFor(lo, hi, count) {
      if (!(hi > lo)) { hi = lo + 1; }
      const step = niceStep((hi - lo) / (count || 3));
      const out = [];
      for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
      return out;
    }
    /**
     * A line chart drawn as SVG under an HTML layer: the SVG stretches to the width it is given while its lines keep
     * 2px (non-scaling strokes), and the labels, end dots, and hover targets are HTML so nothing distorts. Every point
     * has a hover tip; the caller adds a table for anyone who wants the numbers.
     */
    function lineChart(o) {
      const series = o.series.filter((s) => s.values.some((v) => v != null));
      const n = Math.max(1, ...o.series.map((s) => s.values.length));
      const all = series.flatMap((s) => s.values.filter((v) => v != null));
      if (!all.length) return '<p class="muted small">Nothing to chart yet.</p>';
      let lo = Math.min(...all), hi = Math.max(...all);
      if (o.zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
      if (hi === lo) { hi += Math.max(1, Math.abs(hi) * 0.1); lo -= Math.max(1, Math.abs(lo) * 0.1); }
      const ticks = ticksFor(lo, hi, 3);
      const y0 = ticks[0], y1 = ticks[ticks.length - 1];
      const H = o.height || 170, W = 1000;
      const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
      const y = (v) => H - ((v - y0) / (y1 - y0 || 1)) * H;
      const xp = (i) => (x(i) / W) * 100, yp = (v) => (y(v) / H) * 100;
      const pathOf = (vals) => { let d = '', pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; pen = true; }); return d.trim(); };
      const grid = ticks.map((t) => `<line class="lc-grid ${t === 0 ? 'is-zero' : ''}" x1="0" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>`).join('');
      const lines = series.map((s, si) => {
        let area = '';
        if (o.area && si === 0) {
          const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
          if (pts.length > 1) { const base = y(Math.max(y0, Math.min(0, y1))); area = `<path class="lc-area ${s.cls}" d="M${pts[0][0]} ${base} ${pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} L${pts[pts.length - 1][0]} ${base} Z"/>`; }
        }
        return `${area}<path class="lc-line ${s.cls} ${s.dashed ? 'is-dashed' : ''}" d="${pathOf(s.values)}"/>`;
      }).join('');
      const dots = series.map((s) => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return i < 0 || s.dashed ? '' : `<span class="lc-dot ${s.cls}" style="left:${xp(i).toFixed(2)}%;top:${yp(s.values[i]).toFixed(2)}%"></span>`; }).join('');
      const stepPct = n > 1 ? 100 / (n - 1) : 100;
      const hits = Array.from({ length: n }, (_, i) => {
        const tip = o.tip(i);
        if (!tip) return '';
        const left = Math.max(0, xp(i) - stepPct / 2), right = Math.min(100, xp(i) + stepPct / 2);
        return `<span class="lc-hit" style="left:${left.toFixed(2)}%;width:${(right - left).toFixed(2)}%;--hx:${(((xp(i) - left) / (right - left || 1)) * 100).toFixed(1)}%" data-tip="${esc(tip)}"></span>`;
      }).join('');
      const yLabels = ticks.map((t) => `<span style="top:${yp(t).toFixed(2)}%">${esc((o.fmtAxis || M.moneyCompact)(t))}</span>`).join('');
      const every = Math.max(1, Math.ceil(n / (o.maxLabels || 6)));
      // every nth label and the last one, dropping the one before the last when the two would touch
      const lastRegular = Math.floor((n - 1) / every) * every;
      const showLabel = (i) => i === n - 1 || (i % every === 0 && !(i === lastRegular && n - 1 - i < every * 0.75));
      const xLabels = (o.labels || []).map((l, i) => (l && showLabel(i) ? `<span style="left:${xp(i).toFixed(2)}%">${esc(l)}</span>` : '')).join('');
      return `<figure class="lc" role="img" aria-label="${esc(o.aria || 'Chart')}">
        <div class="lc-body" style="height:${H}px"><div class="lc-y" aria-hidden="true">${yLabels}</div>
          <div class="lc-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${grid}${lines}</svg>${dots}<div class="lc-hits">${hits}</div></div></div>
        <div class="lc-x" aria-hidden="true">${xLabels}</div>
        ${o.legend ? `<figcaption class="legend">${o.legend.map((l) => `<span><span class="key ${l.cls} ${l.dashed ? 'is-dashed' : ''}"></span>${esc(l.label)}</span>`).join('')}</figcaption>` : ''}
      </figure>`;
    }
    /** Columns side by side per period (income beside spending), each with a hover tip. */
    function columnsChart(o) {
      const max = Math.max(1, ...o.groups.flatMap((g) => g.bars.map((b) => Math.abs(b.value))));
      const ticks = ticksFor(0, max, 3);
      const top = ticks[ticks.length - 1];
      return `<figure class="cc" role="img" aria-label="${esc(o.aria)}">
        <div class="cc-body" style="height:${o.height || 160}px">
          <div class="cc-y" aria-hidden="true">${ticks.map((t) => `<span style="bottom:${((t / top) * 100).toFixed(2)}%">${esc(M.moneyCompact(t))}</span>`).join('')}</div>
          <div class="cc-plot">${ticks.map((t) => `<span class="cc-grid" style="bottom:${((t / top) * 100).toFixed(2)}%"></span>`).join('')}
            <div class="cc-cols" style="grid-template-columns:repeat(${o.groups.length},1fr)">${o.groups.map((g) => `<div class="cc-col ${g.current ? 'is-current' : ''}">${g.bars.map((b) => `<span class="cc-bar ${b.cls}" style="height:${((Math.abs(b.value) / top) * 100).toFixed(2)}%" data-tip="${esc(b.tip)}"></span>`).join('')}</div>`).join('')}</div>
          </div>
        </div>
        <div class="cc-x" aria-hidden="true" style="grid-template-columns:repeat(${o.groups.length},1fr)">${o.groups.map((g) => `<span>${esc(g.label)}</span>`).join('')}</div>
        ${o.legend ? `<figcaption class="legend">${o.legend.map((l) => `<span><span class="key key-box ${l.cls}"></span>${esc(l.label)}</span>`).join('')}</figcaption>` : ''}
      </figure>`;
    }
    /** One bar split by share, with a 2px gap between parts, and the labelled list underneath that carries the numbers. */
    function compositionHTML(items, opts) {
      const total = items.reduce((a, b) => a + Math.max(0, b.value), 0);
      if (total <= 0) return '<p class="muted small">Nothing here yet.</p>';
      const bar = `<div class="comp" role="img" aria-label="${esc(items.map((i) => `${i.label} ${money(i.value)}`).join(', '))}">${items.filter((i) => i.value > 0).map((i) => `<span class="comp-seg ${i.cls}" style="flex-grow:${i.value.toFixed(2)}" data-tip="${esc(`${i.label}: ${money(i.value)} (${pctText(i.value / total)})`)}"></span>`).join('')}</div>`;
      const list = `<ul class="comp-list">${items.map((i) => `<li>${i.href ? `<a href="${i.href}">` : '<span>'}<span class="key key-box ${i.cls}"></span><span class="comp-name">${esc(i.label)}</span><span class="comp-val num">${esc(money(i.value))}</span><span class="comp-pct num muted">${esc(pctText(i.value / total))}</span>${i.href ? '</a>' : '</span>'}</li>`).join('')}</ul>`;
      return (opts && opts.listOnly ? '' : bar) + list;
    }
    /** Spending by group, the eight with a palette slot in their own colour and the rest folded into Other. */
    function groupItems(byGroup, limit, period) {
      const items = [];
      let other = 0;
      for (const [gid, o] of byGroup) {
        const g = M.GROUP_BY_ID[gid];
        if (!g || g.kind !== 'expense' || o.spend <= 0) continue;
        if (slotOf(gid)) items.push({ label: g.name, value: o.spend, cls: `s-${slotOf(gid)}`, href: period ? `#transactions?group=${gid}&from=${period.from}&to=${period.to}` : null });
        else other += o.spend;
      }
      items.sort((a, b) => b.value - a.value);
      const shown = items.slice(0, limit || 8);
      other += items.slice(limit || 8).reduce((a, b) => a + b.value, 0);
      if (other > 0) shown.push({ label: 'Everything else', value: M.cents(other), cls: 's-0', href: null });
      return shown;
    }

    /**
     * Where the money went: income on the left, all of it gathered in the middle, spending by group and what was kept
     * on the right. HTML labels either side of a stretched SVG, so the text stays legible at a phone's width.
     */
    function sankeyHTML(flow) {
      const d = derive();
      const left = [];
      for (const [id, o] of flow.byCategory) if (d.index.kindOf(id) === 'income' && o.income > 0) left.push({ label: d.index.get(id).name, value: o.income, cls: 's-in' });
      left.sort((a, b) => b.value - a.value);
      // groups under 4% of spending fold into the last node, so every node left has room for its label
      const right = (() => {
        const items = groupItems(flow.byGroup, 6);
        const all = items.reduce((a, b) => a + b.value, 0);
        const keep = items.filter((i) => i.cls !== 's-0' && i.value >= all * 0.04);
        const rest = items.filter((i) => !keep.includes(i)).reduce((a, b) => a + b.value, 0);
        if (rest > 0) keep.push({ label: 'Everything else', value: M.cents(rest), cls: 's-0' });
        return keep;
      })();
      const spent = right.reduce((a, b) => a + b.value, 0);
      const inc = left.reduce((a, b) => a + b.value, 0);
      if (inc - spent > 0.5) right.push({ label: 'Kept', value: M.cents(inc - spent), cls: 's-kept' });
      else if (spent - inc > 0.5) left.push({ label: 'Beyond income', value: M.cents(spent - inc), cls: 's-0' });
      if (!left.length || !right.length) return '<p class="muted small">Income and spending both need to be there for this picture.</p>';
      const total = Math.max(left.reduce((a, b) => a + b.value, 0), right.reduce((a, b) => a + b.value, 0));
      const rowH = 34, gap = 6;
      const H = Math.max(200, Math.max(left.length, right.length) * (rowH + gap));
      const place = (nodes) => {
        const avail = H - gap * (nodes.length - 1);
        const min = 4;
        let raw = nodes.map((nd) => Math.max(min, (nd.value / total) * avail));
        const scale = avail / raw.reduce((a, b) => a + b, 0);
        raw = raw.map((h) => h * scale);
        let yy = 0;
        return nodes.map((nd, i) => { const out = Object.assign({}, nd, { y: yy, h: raw[i] }); yy += raw[i] + gap; return out; });
      };
      const L = place(left), R = place(right);
      const ribbons = [];
      let cy = 0;
      const midH = H, midScale = midH / total;
      for (const nd of L) { const h = nd.value * midScale; ribbons.push(ribbon(4, nd.y, nd.h, 47, cy, h, nd.cls)); cy += h; }
      cy = 0;
      for (const nd of R) { const h = nd.value * midScale; ribbons.push(ribbon(53, cy, h, 96, nd.y, nd.h, nd.cls)); cy += h; }
      function ribbon(x1, y1, h1, x2, y2, h2, cls) {
        const mx = (x1 + x2) / 2;
        return `<path class="sk-ribbon ${cls}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2} L${x2} ${y2 + h2} C${mx} ${y2 + h2} ${mx} ${y1 + h1} ${x1} ${y1 + h1} Z"/>`;
      }
      const nodes = L.map((nd) => `<rect class="sk-node ${nd.cls}" x="0" y="${nd.y}" width="4" height="${nd.h}"/>`).join('')
        + `<rect class="sk-node s-mid" x="47" y="0" width="6" height="${H}"/>`
        + R.map((nd) => `<rect class="sk-node ${nd.cls}" x="96" y="${nd.y}" width="4" height="${nd.h}"/>`).join('');
      // labels sit beside their nodes, nudged apart just enough not to overlap when neighbouring nodes are thin
      const spread = (nodes2) => {
        const minGap = 32, ys = nodes2.map((nd) => nd.y + nd.h / 2);
        for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + minGap);
        if (ys.length && ys[ys.length - 1] > H - minGap / 2) { ys[ys.length - 1] = H - minGap / 2; for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - minGap); }
        return nodes2.map((nd, i) => Object.assign({}, nd, { ly: Math.max(minGap / 2, ys[i]) }));
      };
      const labels = (nodes2, side) => spread(nodes2).map((nd) => `<span class="sk-label sk-${side}" style="top:${nd.ly.toFixed(1)}px" data-tip="${esc(`${nd.label}: ${money(nd.value)} (${pctText(nd.value / total)})`)}"><b>${esc(nd.label)}</b><span class="num">${esc(money(nd.value))}</span></span>`).join('');
      return `<figure class="sk" role="img" aria-label="${esc(`Income ${money(inc)} flowing to spending ${money(spent)}${inc > spent ? ` and ${money(inc - spent)} kept` : ''}`)}">
        <div class="sk-body" style="height:${H}px">
          <div class="sk-col">${labels(L, 'l')}</div>
          <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">${ribbons.join('')}${nodes}</svg>
          <div class="sk-col">${labels(R, 'r')}</div>
        </div>
      </figure>`;
    }
    function sparkline(values, cls) {
      const vals = values.filter((v) => v != null);
      if (vals.length < 2) return '';
      const lo = Math.min(...vals), hi = Math.max(...vals), H = 40, W = 200;
      const y = (v) => (hi === lo ? H / 2 : H - 3 - ((v - lo) / (hi - lo)) * (H - 6));
      const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * W).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
      return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="lc-line ${cls || 's-acc'}" d="${d}"/></svg>`;
    }
    const tableDetails = (summary, head, rows) => `<details class="chart-table"><summary>${esc(summary)}</summary><div class="table-wrap"><table class="table-twin"><thead><tr>${head.map((h, i) => `<th ${i ? 'class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td ${i ? 'class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;

    // ---- shared figures -------------------------------------------------------------------------------------
    function netWorthNow() {
      const d = derive();
      let assets = 0, liabilities = 0;
      for (const a of ms.accounts) { if (a.excludeFromNetWorth || a.closed) continue; const b = d.ledgers[a.id] ? d.ledgers[a.id].current : 0; if (b >= 0) assets += b; else liabilities -= b; }
      return { assets: M.cents(assets), liabilities: M.cents(liabilities), net: M.cents(assets - liabilities) };
    }
    function netWorthHistory(months) {
      const d = derive();
      const dates = M.monthEndDates(d.today, months);
      return M.netWorthSeries(ms.accounts.filter((a) => !a.closed), d.ledgers, dates);
    }
    function budgetFor(ym) {
      const d = derive();
      return M.budgetMonth({ month: ym, index: d.index, budgets: ms.budgets, transactions: ms.transactions, mode: ui.state.settings.budgetMode });
    }
    function moneyInsights() {
      const d = derive();
      const goals = ms.goals.map((g) => ({ goal: g, progress: M.goalProgress(g, { balanceOn }, d.today) }));
      const cash = ms.accounts.filter((a) => !a.closed && ['checking', 'savings', 'cash'].includes(a.type)).map((a) => ({ account: a, balance: balanceOf(a.id) }));
      const list = M.insights({ today: d.today, transactions: ms.transactions, index: d.index, budget: budgetFor(M.monthOf(d.today)), streams: d.streams, goals, cashAccounts: cash, reviewCount: d.reviewCount });
      const dismissed = ui.state.dismissed || {};
      return list.filter((i) => !dismissed['money:' + i.id]);
    }
    /** Transactions the tax ledger probably wants: spending in a category with a worksheet line, not yet sent over. */
    function taxLinked(t) { return !!(t.entryId && ui.state.entries.some((e) => e.id === t.entryId)); }
    function possiblyDeductible(t, year) {
      if (t.hidden || Number(t.amount) >= 0) return false;
      if (year && Number(t.date.slice(0, 4)) !== Number(year)) return false;
      if (t.splits && t.splits.length) return t.splits.some((s) => derive().index.get(s.categoryId).tax);
      return !!derive().index.get(t.categoryId).tax;
    }
    /** The worksheet line a transaction most likely belongs on: the classifier when it is sure, else the category's line. */
    function suggestLine(t) {
      const cat = derive().index.get(t.categoryId);
      let best = null;
      try {
        const res = C.classify(`${t.merchant || ''} ${t.original || ''}`.trim(), { learned: ui.state.learned, weights: ui.state.weights, limit: 3 });
        const top = res.suggestions[0];
        if (top && (top.learned || top.score >= 0.9) && !S.isMiles(top.lineId)) best = top.lineId;
        if (res.nonDeductible && res.nonDeductible.length && !best) return { lineId: cat.tax || '', warning: res.nonDeductible[0].text || res.nonDeductible[0] };
      } catch (e) { /* the classifier is a help, not a requirement */ }
      return { lineId: best || cat.tax || '', warning: '' };
    }

    // =====================================================================================================
    // DASHBOARD
    // =====================================================================================================
    function renderDashboard() {
      const el = $('#view-dashboard');
      const d = derive();
      if (!hasMoney()) { el.innerHTML = onboardingHTML() + taxCardHTML(); bindView(el); return; }
      const ym = M.monthOf(d.today), lastYm = M.addMonthsYM(ym, -1);
      const nw = netWorthNow();
      const hist = netWorthHistory(12);
      const monthAgo = M.netWorthSeries(ms.accounts.filter((a) => !a.closed), d.ledgers, [M.addDays(d.today, -30)])[0];
      const day = Number(d.today.slice(8, 10));
      const thisSpend = M.cumulativeSpend(ms.transactions, d.index, ym, d.today);
      const lastSpend = M.cumulativeSpend(ms.transactions, d.index, lastYm);
      const spentNow = thisSpend[day - 1] || 0;
      const spentThen = lastSpend[Math.min(day, lastSpend.length) - 1] || 0;
      const b = budgetFor(ym);
      const flow = M.cashFlow(ms.transactions, d.index, M.monthStart(ym), d.today);
      const soon = M.upcoming(d.streams.filter((s) => s.sign === 'out'), d.today, M.addDays(d.today, 14));
      const recent = ms.transactions.filter((t) => t.date <= d.today).sort((a, c) => c.date.localeCompare(a.date) || (c.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 6);
      const insights = moneyInsights().slice(0, 4);
      // the day-to-day categories with the most budget: the ones a month is won or lost on, rather than bills already paid
      const budgetRows = b.expense.groups.flatMap((g) => g.rows).filter((r) => r.available > 0 && r.category.budget !== 'fixed').sort((a, c) => c.available - a.available).slice(0, 4);
      const days = M.daysInMonth(ym);
      el.innerHTML = `
        <div class="dash">
          <section class="card dash-nw">
            <div class="card-head"><h2><a href="#accounts">Net worth</a></h2>${deltaHTML(nw.net - monthAgo.net, { suffix: 'in 30 days' })}</div>
            <div class="hero-figure">${esc(money(nw.net))}</div>
            ${lineChart({ series: [{ values: hist.map((p) => p.net), cls: 's-acc' }], labels: hist.map((p) => M.monthLabel(M.monthOf(p.date), { noYear: true })), height: 120, area: true, aria: `Net worth over the last 12 months, now ${money(nw.net)}`, tip: (i) => `${M.monthLabel(M.monthOf(hist[i].date))}: ${money(hist[i].net)}`, maxLabels: 4 })}
            <div class="split-figs"><span>Assets <b class="num">${esc(money(nw.assets))}</b></span><span>Liabilities <b class="num">${esc(money(nw.liabilities))}</b></span></div>
          </section>
          <section class="card dash-spend">
            <div class="card-head"><h2><a href="#cashflow">Spending</a></h2>${deltaHTML(spentNow - spentThen, { downIsGood: true, suffix: `vs ${M.monthLabel(lastYm, { noYear: true })}` })}</div>
            <div class="hero-figure">${esc(money(spentNow))} <small>so far in ${esc(M.monthLabel(ym, { long: true, noYear: true }))}</small></div>
            ${lineChart({ series: [{ values: thisSpend, cls: 's-acc', label: 'This month' }, { values: lastSpend.slice(0, days).concat(new Array(Math.max(0, days - lastSpend.length)).fill(null)), cls: 's-prev', dashed: true, label: 'Last month' }], labels: Array.from({ length: days }, (_, i) => (i === 0 || (i + 1) % 7 === 0 ? String(i + 1) : '')), height: 130, area: true, zero: true, aria: `Spending this month ${money(spentNow)} against ${money(spentThen)} by the same day last month`, tip: (i) => `Day ${i + 1}: ${thisSpend[i] != null ? money(thisSpend[i]) : '—'} this month · ${lastSpend[i] != null ? money(lastSpend[i]) : '—'} last month`, legend: [{ label: M.monthLabel(ym, { noYear: true }), cls: 's-acc' }, { label: M.monthLabel(lastYm, { noYear: true }), cls: 's-prev', dashed: true }], maxLabels: 31 })}
          </section>
          <section class="card dash-budget">
            <div class="card-head"><h2><a href="#budget">Budget</a></h2><span class="muted small">${esc(M.monthLabel(ym, { long: true, noYear: true }))}</span></div>
            ${b.hasBudget ? `
              <div class="budget-sum"><span class="hero-sm">${esc(money(Math.abs(b.remaining)))}</span> <span>${b.remaining >= 0 ? 'left' : 'over'} of ${esc(money(b.expense.planned))} budgeted</span></div>
              ${progressHTML(b.expense.actual, b.expense.planned, { pace: day / days })}
              <ul class="mini-bud">${budgetRows.map((r) => `<li><span class="mb-name">${catDot(r.category.id)}${esc(r.category.name)}</span>${progressHTML(r.actual, r.available, { pace: day / days })}<span class="mb-left">${leftText(r.remaining, r.available)}</span></li>`).join('')}</ul>`
              : `<p class="note">No budget yet. Set one from what you actually spend: the Budget page can fill every category from your last three months.</p><div class="btn-row"><a class="btn btn-sm" href="#budget">Set up a budget</a></div>`}
          </section>
          <section class="card dash-tx">
            <div class="card-head"><h2><a href="#transactions">Transactions</a></h2>${d.reviewCount ? `<a class="pill pill-act" href="#transactions?filter=review">${d.reviewCount} to review</a>` : '<span class="pill pill-good">All reviewed</span>'}</div>
            <div class="tx-mini">${recent.map(txRowHTML).join('') || '<p class="muted small">No transactions yet.</p>'}</div>
          </section>
          <section class="card dash-upcoming">
            <div class="card-head"><h2><a href="#recurring">Upcoming bills</a></h2><span class="muted small">next 14 days</span></div>
            ${soon.length ? `<ul class="up-list">${soon.slice(0, 6).map((u) => `<li><span class="up-date ${u.overdue ? 'is-overdue' : ''}">${u.overdue ? 'Overdue' : esc(M.dayLabel(u.date))}</span><span class="up-name">${catDot(u.stream.categoryId)}${esc(u.stream.merchant)}</span><span class="num">${esc(moneyC(u.amount))}</span></li>`).join('')}</ul><div class="up-total">Total <b class="num">${esc(money(soon.reduce((a, u) => a + u.amount, 0)))}</b></div>` : '<p class="muted small">Nothing recurring is due in the next two weeks.</p>'}
          </section>
          <section class="card dash-flow">
            <div class="card-head"><h2><a href="#cashflow">${esc(M.monthLabel(ym, { long: true, noYear: true }))} so far</a></h2>${flow.savingsRate != null && flow.savingsRate >= 0 ? `<span class="pill pill-info">${esc(pctText(flow.savingsRate))} saved</span>` : ''}</div>
            <div class="stat-row">${statTile('Income', `<span class="num">${esc(money(flow.income))}</span>`)}${statTile('Spending', `<span class="num">${esc(money(flow.expenses))}</span>`)}${statTile(flow.net >= 0 ? 'Kept' : 'Short', `<span class="num">${esc(money(Math.abs(flow.net)))}</span>`)}</div>
            ${compositionHTML(groupItems(flow.byGroup, 5, { from: M.monthStart(ym), to: d.today }))}
          </section>
          ${ms.goals.length ? `<section class="card dash-goals"><div class="card-head"><h2><a href="#goals">Goals</a></h2></div><ul class="goal-mini">${ms.goals.slice(0, 4).map((g) => { const p = M.goalProgress(g, { balanceOn }, d.today); return `<li><span class="gm-name">${esc(g.name)}</span>${progressHTML(p.saved, p.target, { noBudgetOk: true, cls: 'prog-goal' })}<span class="gm-fig num">${esc(money(p.saved))} <span class="muted">of ${esc(money(p.target))}</span></span></li>`; }).join('')}</ul></section>` : ''}
          ${insights.length ? `<section class="card dash-insights"><div class="card-head"><h2>Worth a look</h2></div><div class="feed">${insights.map(insightHTML).join('')}</div></section>` : ''}
          ${taxCardHTML()}
        </div>`;
      bindView(el);
    }
    function onboardingHTML() {
      return `<section class="card onboard">
        <h2>Your money, on this device</h2>
        <p class="note">Bring in a statement from your bank or card (the OFX, QFX, or QBO file most banks offer as "Download for Quicken", or a CSV), add accounts by hand, or look around the example household first. An export from another budgeting app keeps its categories and tags.</p>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-act="import">${ICON.upload}Import a statement</button>
          <button class="btn" type="button" data-act="add-account">${ICON.plus}Add an account</button>
          <button class="btn btn-ghost" type="button" data-act="load-sample">Load the example household</button>
        </div>
        <p class="muted small">Nothing leaves this device. There is no bank login: the file you download from your bank is the connection.</p>
      </section>`;
    }
    function taxCardHTML() {
      const R0 = ui.state.computed;
      if (!R0) return '';
      const A = R0.scheduleA.total, SD = R0.standardDeduction.total;
      const year = R0.taxYear;
      const pending = ms.transactions.filter((t) => possiblyDeductible(t, year) && !taxLinked(t)).length;
      const max = Math.max(A, SD) * 1.12 || 1;
      return `<section class="card dash-tax">
        <div class="card-head"><h2><a href="#insights">Taxes ${esc(year)}</a></h2><span class="pill ${A > SD ? 'pill-accent' : 'pill-info'}">${A > SD ? 'Itemizing wins' : 'Standard deduction'}</span></div>
        <div class="meter mini-meter" role="img" aria-label="${esc(`${money(A)} counts toward itemizing against a ${money(SD)} standard deduction`)}"><div class="meter-track"><div class="meter-fill ${A > SD ? 'is-over' : ''}" style="width:${(A / max * 100).toFixed(2)}%"></div><div class="meter-marker" style="left:${(SD / max * 100).toFixed(2)}%"></div></div></div>
        <p class="note small">${esc(money(A))} counts toward itemizing against a ${esc(money(SD))} standard deduction.${pending ? ` <a href="#transactions?filter=deductible">${pending} ${plural(pending, 'transaction')} this year ${pending === 1 ? 'looks' : 'look'} deductible</a> and ${pending === 1 ? 'is' : 'are'} not on the tax ledger yet.` : ''}</p>
      </section>`;
    }
    function insightHTML(i) {
      const LEVEL = { act: 'To do', warn: 'Heads up', good: 'Good news', info: 'Note' };
      const href = `#${i.view}${i.params ? '?' + new URLSearchParams(i.params).toString() : ''}`;
      return `<article class="insight insight-${i.level}"><div class="insight-stripe" aria-hidden="true"></div><div class="insight-body"><div class="insight-top"><span class="pill pill-${i.level === 'info' ? 'info' : i.level}">${LEVEL[i.level]}</span><h3>${esc(i.title)}</h3></div><p>${esc(i.body)}</p><div class="btn-row rec-actions"><a class="go" href="${href}">Open</a><button class="btn btn-ghost btn-sm" type="button" data-dismiss="${esc(i.id)}">Dismiss</button></div></div></article>`;
    }

    // =====================================================================================================
    // ACCOUNTS
    // =====================================================================================================
    function renderAccounts() {
      const el = $('#view-accounts');
      const fk = focusKeyOf();
      const d = derive();
      if (!ms.accounts.length) { el.innerHTML = onboardingHTML(); bindView(el); return; }
      const range = ms.ui.nwRange;
      const nw = netWorthNow();
      const hist = range === 1 ? M.netWorthSeries(liveAccounts(), d.ledgers, Array.from({ length: 31 }, (_, i) => M.addDays(d.today, i - 30))) : netWorthHistory(range);
      const label = (p) => (range === 1 ? M.dayLabel(p.date) : M.monthLabel(M.monthOf(p.date), { noYear: range <= 12 }));
      const change = hist.length ? nw.net - hist[0].net : 0;
      const shown = ms.accounts.filter((a) => ms.ui.showHiddenAccounts || (!a.hidden && !a.closed));
      const hiddenCount = ms.accounts.length - ms.accounts.filter((a) => !a.hidden && !a.closed).length;
      const groups = M.ACCOUNT_GROUPS.map((g) => ({ g, list: shown.filter((a) => M.accountType(a.type).group === g.id) })).filter((x) => x.list.length);
      el.innerHTML = `
        <section class="card nw-card">
          <div class="card-head"><h2>Net worth</h2>
            <div class="chips" role="group" aria-label="Range">${[[1, '1M'], [3, '3M'], [6, '6M'], [12, '1Y'], [36, '3Y']].map(([n, l]) => `<button class="chip" type="button" data-nw-range="${n}" aria-pressed="${range === n}">${l}</button>`).join('')}</div>
          </div>
          <div class="hero-figure">${esc(money(nw.net))} ${deltaHTML(change, { suffix: range === 1 ? 'this month' : `over ${range === 12 ? 'the year' : `${range} months`}` })}</div>
          ${lineChart({ series: [{ values: hist.map((p) => p.net), cls: 's-acc' }], labels: hist.map(label), height: 180, area: true, aria: `Net worth, now ${money(nw.net)}`, tip: (i) => `${label(hist[i])}: ${money(hist[i].net)} (assets ${money(hist[i].assets)}, liabilities ${money(hist[i].liabilities)})`, maxLabels: 6 })}
          <div class="split-figs"><span>Assets <b class="num">${esc(money(nw.assets))}</b></span><span>Liabilities <b class="num">${esc(money(nw.liabilities))}</b></span></div>
          ${tableDetails('Net worth as a table', ['Date', 'Assets', 'Liabilities', 'Net worth'], hist.map((p) => [label(p), money(p.assets), money(p.liabilities), money(p.net)]))}
        </section>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-act="add-account">${ICON.plus}Add account</button>
          <button class="btn" type="button" data-act="import">${ICON.upload}Import statement</button>
          ${hiddenCount ? `<button class="btn btn-ghost" type="button" data-act="toggle-hidden-accounts">${ms.ui.showHiddenAccounts ? 'Hide' : 'Show'} ${hiddenCount} hidden or closed</button>` : ''}
        </div>
        ${groups.map(({ g, list }) => {
          const total = list.reduce((a, x) => a + (x.closed ? 0 : balanceOf(x.id)), 0);
          const liab = list.some((a) => M.isLiability(a));
          return `<section class="card acct-group">
            <div class="card-head"><h2>${esc(g.label)}</h2><span class="num acct-total">${liab ? esc(money(Math.max(0, -total))) : esc(money(total))}</span></div>
            <div class="acct-list">${list.map((a) => {
              const L = d.ledgers[a.id];
              const spark = L ? sparkline(M.monthEndDates(d.today, 6).map((dt) => L.at(dt)), 's-acc') : '';
              return `<button class="acct-row" type="button" data-account="${esc(a.id)}"><span class="acct-main"><span class="acct-name">${esc(a.name)}${a.closed ? ' <span class="pill pill-info">Closed</span>' : a.hidden ? ' <span class="pill pill-info">Hidden</span>' : ''}</span><span class="acct-sub">${esc(accountSub(a))}</span></span><span class="acct-spark">${spark}</span><span class="acct-bal num">${balanceHTML(a, balanceOf(a.id))}</span></button>`;
            }).join('')}</div>
          </section>`;
        }).join('')}`;
      bindView(el);
      restoreFocus(fk);
    }

    function openAccount(id) {
      const d = derive();
      const a = d.accountsById.get(id);
      if (!a) return;
      const L = d.ledgers[a.id];
      const dates = M.monthEndDates(d.today, 7);
      const vals = dates.map((dt) => (M.isLiability(a) ? -L.at(dt) : L.at(dt)));
      const recent = (d.txByAccount.get(a.id) || []).slice().sort((x, y) => y.date.localeCompare(x.date)).slice(0, 8);
      const holdings = ms.holdings.filter((h) => h.accountId === a.id);
      const mode = M.balanceModeOf(a);
      openModal(`
        <div class="card-head"><h2>${esc(a.name)}</h2><button class="btn btn-ghost btn-sm" type="button" data-close-modal>Close</button></div>
        <p class="muted small">${esc(accountSub(a))}</p>
        <div class="hero-figure">${balanceHTML(a, L.current)}${M.isLiability(a) ? ' <small>owed</small>' : ''}</div>
        ${lineChart({ series: [{ values: vals, cls: 's-acc' }], labels: dates.map((dt) => M.monthLabel(M.monthOf(dt), { noYear: true })), height: 110, area: true, aria: `${a.name} over seven months`, tip: (i) => `${M.dayLabel(dates[i], true)}: ${money(vals[i])}` })}
        <div class="btn-row"><button class="btn btn-sm" type="button" id="aUpdate">Update balance</button>${mode === 'transactions' ? `<a class="btn btn-sm" href="#transactions?account=${esc(a.id)}" data-close-modal>All transactions</a>` : ''}${['brokerage', 'retirement'].includes(a.type) ? `<a class="btn btn-sm" href="#investments" data-close-modal>Holdings (${holdings.length})</a>` : ''}</div>
        ${recent.length ? `<div class="tx-mini">${recent.map(txRowHTML).join('')}</div>` : ''}
        <details class="more"><summary>Account settings</summary>
          <div class="grid-2" style="margin-top:10px">
            <label class="field"><span>Name</span><input id="aName" value="${esc(a.name)}" maxlength="80"></label>
            <label class="field"><span>Type</span><select id="aType" class="input">${M.ACCOUNT_TYPES.map((t) => `<option value="${t.id}" ${t.id === a.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
            <label class="field"><span>Institution</span><input id="aInst" value="${esc(a.institution)}" maxlength="80"></label>
            <label class="field"><span>Last four digits</span><input id="aMask" value="${esc(a.mask)}" inputmode="numeric" maxlength="4"></label>
            <label class="field span-2"><span>Balance comes from</span><select id="aMode" class="input"><option value="transactions" ${mode === 'transactions' ? 'selected' : ''}>Transactions, from the last balance you entered or imported</option><option value="manual" ${mode === 'manual' ? 'selected' : ''}>The balance you enter or the holdings add up to</option></select></label>
            <div class="field span-2"><div class="chips"><label class="check"><input type="checkbox" id="aHidden" ${a.hidden ? 'checked' : ''}> Hide from lists</label><label class="check"><input type="checkbox" id="aClosed" ${a.closed ? 'checked' : ''}> Closed</label><label class="check"><input type="checkbox" id="aExclude" ${a.excludeFromNetWorth ? 'checked' : ''}> Leave out of net worth</label></div></div>
          </div>
          <div class="modal-actions" style="margin-top:12px"><button class="btn btn-danger" type="button" id="aDelete">Delete account</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="aSave">Save</button></div>
        </details>`, (panel) => {
        panel.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => closeModal()));
        panel.querySelectorAll('[data-tx]').forEach((b) => b.addEventListener('click', () => { closeModal(); openTx(b.dataset.tx); }));
        $('#aUpdate', panel).onclick = () => openBalance(a);
        $('#aSave', panel).onclick = async () => {
          const next = Object.assign({}, a, { name: $('#aName', panel).value.trim(), type: $('#aType', panel).value, institution: $('#aInst', panel).value.trim(), mask: $('#aMask', panel).value.trim(), balanceMode: $('#aMode', panel).value, hidden: $('#aHidden', panel).checked, closed: $('#aClosed', panel).checked, excludeFromNetWorth: $('#aExclude', panel).checked, updatedAt: now() });
          if (!next.name) { toast('An account needs a name.'); return; }
          if (await save({ put: { accounts: [next] } }, 'Account saved.')) { closeModal(); rerender(); }
        };
        $('#aDelete', panel).onclick = async () => {
          const n = (d.txByAccount.get(a.id) || []).length;
          if (!(await confirmDialog(`Delete ${a.name}?`, `The account${n ? `, its ${n} ${plural(n, 'transaction')},` : ''} its balance history, and its holdings will be removed from this device. Tax entries sent from its transactions stay on the tax ledger.`, 'Delete account', true))) return;
          try { await DB.deleteAccount(a.id); await load(); } catch (e) { toast(`Could not delete it: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
          closeModal(); rerender(); toast(`${a.name} deleted.`);
        };
      });
    }
    function openBalance(a) {
      const d = derive();
      const liab = M.isLiability(a);
      openModal(`<h2>Update ${esc(a.name)}</h2>
        <div class="grid-2">
          <label class="field"><span>${liab ? 'Amount owed ($)' : 'Balance ($)'}</span><input id="bAmt" inputmode="decimal" value="${esc(String(Math.abs(balanceOf(a.id)).toFixed(2)))}"></label>
          <label class="field"><span>As of</span><input id="bDate" type="date" value="${esc(d.today)}" max="${esc(d.today)}"></label>
        </div>
        <p class="note small">${M.balanceModeOf(a) === 'transactions' ? 'The balance is worked forward and back from this figure through the transactions, so enter it from a statement or your bank on the day it is for.' : 'The account is worth this from that day until the next figure you enter.'}</p>
        <div class="modal-actions"><button class="btn" type="button" data-close-modal>Cancel</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="bSave">Save</button></div>`, (panel) => {
        panel.querySelector('[data-close-modal]').onclick = () => closeModal();
        $('#bSave', panel).onclick = async () => {
          const v = IMP.parseAmountCell($('#bAmt', panel).value);
          const date = $('#bDate', panel).value;
          if (v == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Enter an amount and a date.'); return; }
          const balance = liab ? -Math.abs(v) : v;
          if (await save({ put: { balances: [{ accountId: a.id, date, balance, source: 'manual' }] } }, 'Balance updated.')) { closeModal(); rerender(); }
        };
      });
    }
    function openAddAccount(after) {
      const d = derive();
      openModal(`<h2>Add an account</h2>
        <div class="grid-2">
          <label class="field span-2"><span>Name</span><input id="nName" maxlength="80" placeholder="e.g. Everyday Checking"></label>
          <label class="field"><span>Type</span><select id="nType" class="input">${M.ACCOUNT_TYPES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Institution</span><input id="nInst" maxlength="80" placeholder="optional"></label>
          <label class="field"><span id="nBalLabel">Current balance ($)</span><input id="nBal" inputmode="decimal" placeholder="0.00"></label>
          <label class="field"><span>Last four digits</span><input id="nMask" inputmode="numeric" maxlength="4" placeholder="optional"></label>
        </div>
        <p class="note small" id="nHint">Transactions you import or add will move the balance from here.</p>
        <div class="modal-actions"><button class="btn" type="button" data-close-modal>Cancel</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="nSave">Add account</button></div>`, (panel) => {
        panel.querySelector('[data-close-modal]').onclick = () => closeModal();
        const sync = () => {
          const t = M.accountType($('#nType', panel).value);
          $('#nBalLabel', panel).textContent = t.liability ? 'Amount owed ($)' : t.group === 'property' || t.group === 'vehicle' ? 'What it is worth ($)' : 'Current balance ($)';
          $('#nHint', panel).textContent = t.mode === 'transactions' ? 'Transactions you import or add will move the balance from here.' : 'Update the value now and then; the net worth chart keeps each figure.';
        };
        $('#nType', panel).onchange = sync;
        $('#nName', panel).oninput = () => { const g = M.guessAccountType($('#nName', panel).value); if (!$('#nType', panel).dataset.touched) { $('#nType', panel).value = g; sync(); } };
        $('#nType', panel).addEventListener('change', () => { $('#nType', panel).dataset.touched = '1'; });
        $('#nSave', panel).onclick = async () => {
          const name = $('#nName', panel).value.trim();
          if (!name) { toast('An account needs a name.'); return; }
          const type = $('#nType', panel).value;
          const raw = $('#nBal', panel).value.trim();
          const v = raw ? IMP.parseAmountCell(raw) : 0;
          if (v == null) { toast('That balance is not a number.'); return; }
          const id = DB.uid();
          const acct = { id, name, type, institution: $('#nInst', panel).value.trim(), mask: $('#nMask', panel).value.trim(), balanceMode: M.accountType(type).mode, createdAt: now(), updatedAt: now() };
          const balances = raw ? [{ accountId: id, date: d.today, balance: M.accountType(type).liability ? -Math.abs(v) : v, source: 'manual' }] : [];
          if (await save({ put: { accounts: [acct], balances } }, `${name} added.`)) { closeModal(); if (after) after(id); else rerender(); }
        };
      });
    }

    // =====================================================================================================
    // TRANSACTIONS
    // =====================================================================================================
    function txRowHTML(t, opts) {
      const sel = opts && opts.select;
      const linked = taxLinked(t);
      const cat = t.splits && t.splits.length ? `Split · ${t.splits.length} categories` : catName(t.categoryId);
      const inner = `
        ${sel ? `<span class="row-check"><input type="checkbox" data-tx-sel="${esc(t.id)}" ${opts.selected.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(t.merchant || 'transaction')}"></span>` : ''}
        <span class="tx-main"><span class="tx-merchant">${!t.reviewed ? '<span class="review-dot" title="Needs review"><span class="sr-only">Needs review: </span></span>' : ''}${esc(t.merchant || t.original || 'Transaction')}${t.hidden ? ' <span class="pill pill-info">Hidden</span>' : ''}</span>
          <span class="tx-sub">${catDot(t.splits && t.splits.length ? t.splits[0].categoryId : t.categoryId)}<span class="tx-cat">${esc(cat)}</span><span class="tx-acct">${esc(accountName(t.accountId))}</span>${linked ? `<span class="tax-badge" title="On the tax ledger">${ICON.tax}<span class="sr-only">On the tax ledger</span></span>` : ''}</span></span>
        <span class="tx-amt num">${amountHTML(t.amount)}</span>`;
      return sel ? `<label class="txrow txrow-sel">${inner}</label>` : `<button class="txrow" type="button" data-tx="${esc(t.id)}">${inner}</button>`;
    }
    function filteredTx() {
      const U = ms.ui.tx;
      const d = derive();
      const q = U.q.trim().toLowerCase();
      const year = ui.state.settings.taxYear;
      const amt = /^[$\s]*-?\d+(\.\d{1,2})?$/.test(q) ? Math.abs(Number(q.replace(/[$\s]/g, ''))) : null;
      return ms.transactions.filter((t) => {
        if (U.filter === 'hidden' ? !t.hidden : t.hidden && U.filter !== 'all') return false;
        if (U.filter === 'review' && t.reviewed) return false;
        if (U.filter === 'uncategorized' && t.categoryId !== M.UNCATEGORIZED) return false;
        if (U.filter === 'deductible' && !(possiblyDeductible(t, year) && !taxLinked(t))) return false;
        if (U.accountId && t.accountId !== U.accountId) return false;
        if (U.categoryId && !(t.categoryId === U.categoryId || (t.splits || []).some((s) => s.categoryId === U.categoryId))) return false;
        if (U.group && d.index.get(t.categoryId).groupId !== U.group) return false;
        if (U.month && M.monthOf(t.date) !== U.month) return false;
        if (U.from && t.date < U.from) return false;
        if (U.to && t.date > U.to) return false;
        if (U.tag && !(t.tags || []).includes(U.tag)) return false;
        if (q) {
          if (amt != null && Math.abs(Math.abs(Number(t.amount)) - amt) < 0.005) return true;
          const hay = `${t.merchant} ${t.original} ${t.notes} ${(t.tags || []).join(' ')} ${catName(t.categoryId)} ${accountName(t.accountId)}`.toLowerCase();
          if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
        }
        return true;
      }).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    }
    function renderTransactions() {
      const el = $('#view-transactions');
      const fk = focusKeyOf();
      const U = ms.ui.tx;
      const d = derive();
      const year = ui.state.settings.taxYear;
      const counts = {
        review: d.reviewCount,
        uncategorized: ms.transactions.filter((t) => !t.hidden && t.categoryId === M.UNCATEGORIZED).length,
        deductible: ms.transactions.filter((t) => possiblyDeductible(t, year) && !taxLinked(t)).length,
        hidden: ms.transactions.filter((t) => t.hidden).length,
      };
      const months = Array.from(new Set(ms.transactions.map((t) => M.monthOf(t.date)))).sort().reverse();
      const labels = { all: 'All', review: 'To review', uncategorized: 'Uncategorized', deductible: 'Deductible?', hidden: 'Hidden' };
      const scoped = [U.group ? `group: ${M.GROUP_BY_ID[U.group] ? M.GROUP_BY_ID[U.group].name : U.group}` : '', U.from || U.to ? `${U.from ? M.dayLabel(U.from, true) : '…'} to ${U.to ? M.dayLabel(U.to, true) : '…'}` : '', U.tag ? `tag: ${U.tag}` : ''].filter(Boolean);
      el.innerHTML = `
        <section class="card tx-tools">
          <div class="filters-row">
            <input id="txSearch" class="input" type="search" placeholder="Search merchants, notes, amounts" value="${esc(U.q)}" aria-label="Search transactions">
            <button class="btn" type="button" data-act="add-tx">${ICON.plus}<span class="btn-label">Add</span></button>
            <button class="btn" type="button" data-act="import">${ICON.upload}<span class="btn-label">Import</span></button>
          </div>
          <div class="chips" role="group" aria-label="Show">${TX_FILTERS.map((f) => `<button class="chip" type="button" data-tx-filter="${f}" aria-pressed="${U.filter === f}">${esc(labels[f])}${f !== 'all' ? ` <span class="count">${counts[f]}</span>` : ''}</button>`).join('')}</div>
          <div class="filters-row">
            <select id="txAccount" class="input" aria-label="Account"><option value="">All accounts</option>${accountOptions(U.accountId)}</select>
            <select id="txCategory" class="input" aria-label="Category"><option value="">All categories</option>${categoryOptions(U.categoryId)}</select>
            <select id="txMonth" class="input" aria-label="Month"><option value="">All months</option>${months.map((m) => `<option value="${m}" ${m === U.month ? 'selected' : ''}>${esc(M.monthLabel(m, { long: true }))}</option>`).join('')}</select>
          </div>
          ${scoped.length ? `<div class="scope-note">Showing ${esc(scoped.join(', '))} <button class="btn btn-ghost btn-sm" type="button" data-act="clear-scope">Clear</button></div>` : ''}
        </section>
        <div id="txBody"></div>`;
      renderTxBody();
      const search = $('#txSearch');
      search.oninput = () => { U.q = search.value; U.shown = TX_PAGE; renderTxBody(); };
      $('#txAccount').onchange = (ev) => { U.accountId = ev.target.value; U.shown = TX_PAGE; renderTransactions(); };
      $('#txCategory').onchange = (ev) => { U.categoryId = ev.target.value; U.shown = TX_PAGE; renderTransactions(); };
      $('#txMonth').onchange = (ev) => { U.month = ev.target.value; U.shown = TX_PAGE; renderTransactions(); };
      bindView(el);
      restoreFocus(fk);
    }
    function renderTxBody() {
      const U = ms.ui.tx;
      const list = filteredTx();
      const shown = list.slice(0, U.shown);
      const days = [];
      for (const t of shown) { const last = days[days.length - 1]; if (last && last.date === t.date) last.items.push(t); else days.push({ date: t.date, items: [t] }); }
      const inSum = list.filter((t) => t.amount > 0 && !t.hidden).reduce((a, t) => a + t.amount, 0);
      const outSum = list.filter((t) => t.amount < 0 && !t.hidden).reduce((a, t) => a - t.amount, 0);
      const weekday = (iso) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(...iso.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))).getUTCDay()];
      const body = $('#txBody');
      if (!body) return;
      body.innerHTML = `
        ${U.selectMode ? `<div class="card bulk-bar"><span><b>${U.selected.size}</b> selected</span><span class="btn-row"><select id="bulkCat" class="input" aria-label="Move the selected transactions to a category"><option value="">Move to category…</option>${categoryOptions('')}</select><button class="btn btn-sm" type="button" data-bulk="review">Mark reviewed</button><button class="btn btn-sm" type="button" data-bulk="hide">Hide</button><button class="btn btn-sm" type="button" data-bulk="unhide">Unhide</button><button class="btn btn-sm btn-danger" type="button" data-bulk="delete">Delete</button><button class="btn btn-sm btn-ghost" type="button" data-bulk="done">Done</button></span></div>` : ''}
        <div class="ledger-summary"><span>${list.length} ${plural(list.length, 'transaction')}${list.length ? ` · <span class="amt-in">+${esc(money(inSum))}</span> in · ${esc(money(outSum))} out` : ''}</span>
          <span class="btn-row">${U.filter === 'review' && list.length ? '<button class="btn btn-sm" type="button" data-act="review-all">Mark all reviewed</button>' : ''}${list.length ? `<button class="btn btn-sm btn-ghost" type="button" data-act="select-mode">${U.selectMode ? 'Cancel select' : 'Select'}</button><button class="btn btn-sm btn-ghost" type="button" data-act="export-tx">Export CSV</button>` : ''}</span></div>
        <section class="card tx-list">
          ${days.map((g) => `<div class="day-head"><span>${esc(weekday(g.date))}, ${esc(M.dayLabel(g.date, g.date.slice(0, 4) !== derive().today.slice(0, 4)))}</span></div>${g.items.map((t) => txRowHTML(t, U.selectMode ? { select: true, selected: U.selected } : null)).join('')}`).join('')
            || `<div class="empty"><h3>${ms.transactions.length ? 'Nothing matches' : 'No transactions yet'}</h3><p>${ms.transactions.length ? 'Try a different filter or search.' : 'Import a statement from your bank, or add one by hand.'}</p></div>`}
          ${list.length > shown.length ? `<div class="btn-row" style="justify-content:center;padding:12px"><button class="btn" type="button" data-act="more-tx">Show ${Math.min(TX_PAGE, list.length - shown.length)} more of ${list.length - shown.length}</button></div>` : ''}
        </section>`;
      const bulkCat = $('#bulkCat');
      if (bulkCat) bulkCat.onchange = () => { if (bulkCat.value) bulk('category', bulkCat.value); };
    }
    async function bulk(action, value) {
      const U = ms.ui.tx;
      const ids = Array.from(U.selected);
      if (!ids.length) { if (action === 'done') { U.selectMode = false; renderTransactions(); } else toast('Select some transactions first.'); return; }
      const rows = ms.transactions.filter((t) => U.selected.has(t.id));
      const stamp = now();
      if (action === 'done') { U.selectMode = false; U.selected.clear(); renderTransactions(); return; }
      if (action === 'delete') {
        if (!(await confirmDialog(`Delete ${rows.length} ${plural(rows.length, 'transaction')}?`, 'They will be removed from this device. A balance worked out from transactions will move with them.', 'Delete', true))) return;
        if (await save({ delete: { transactions: ids } }, `${rows.length} deleted.`)) { U.selected.clear(); U.selectMode = false; rerender(); }
        return;
      }
      const patch = action === 'review' ? { reviewed: true } : action === 'hide' ? { hidden: true } : action === 'unhide' ? { hidden: false } : action === 'category' ? { categoryId: value, splits: undefined, reviewed: true } : null;
      if (!patch) return;
      const next = rows.map((t) => { const o = Object.assign({}, t, patch, { updatedAt: stamp }); if (action === 'category') delete o.splits; return o; });
      if (await save({ put: { transactions: next } }, `${rows.length} ${plural(rows.length, 'transaction')} updated.`)) { U.selected.clear(); U.selectMode = false; rerender(); }
    }

    /** The edit sheet for one transaction, or a blank one for a new transaction. */
    function openTx(id, preset) {
      const d = derive();
      const existing = id ? ms.transactions.find((t) => t.id === id) : null;
      if (id && !existing) return;
      if (!ms.accounts.length) { toast('Add an account first; every transaction belongs to one.'); openAddAccount(() => openTx(null)); return; }
      const t = existing ? Object.assign({}, existing) : Object.assign({ id: DB.uid(), accountId: ms.ui.tx.accountId || liveAccounts()[0].id, date: d.today, amount: 0, merchant: '', original: '', categoryId: M.UNCATEGORIZED, notes: '', tags: [], reviewed: true, hidden: false, source: 'manual', createdAt: now() }, preset || {});
      const isNew = !existing;
      let splits = t.splits && t.splits.length ? t.splits.map((s) => Object.assign({}, s)) : null;
      const linkedEntry = t.entryId ? ui.state.entries.find((e) => e.id === t.entryId) : null;
      const out = Number(t.amount) <= 0;
      const tax = suggestLine(t);
      openModal(`
        <div class="card-head"><h2>${isNew ? 'Add a transaction' : esc(t.merchant || 'Transaction')}</h2>${!isNew && !t.reviewed ? '<span class="pill pill-act">Needs review</span>' : ''}</div>
        ${t.original && t.original !== t.merchant ? `<p class="muted small">On the statement: <span class="mono">${esc(t.original)}</span></p>` : ''}
        <div class="grid-2">
          <label class="field span-2"><span>Merchant</span><input id="tMerchant" value="${esc(t.merchant)}" maxlength="80" autocomplete="off"></label>
          <div class="field"><span>Amount ($)</span><div class="amt-pair"><select id="tDir" class="input" aria-label="Money in or out"><option value="out" ${out ? 'selected' : ''}>Out</option><option value="in" ${!out ? 'selected' : ''}>In</option></select><input id="tAmt" inputmode="decimal" value="${t.amount ? esc(Math.abs(t.amount).toFixed(2)) : ''}" aria-label="Amount"></div></div>
          <label class="field"><span>Date</span><input id="tDate" type="date" value="${esc(t.date)}"></label>
          <label class="field"><span>Account</span><select id="tAcct" class="input">${accountOptions(t.accountId)}</select></label>
          <label class="field"><span>Category</span><select id="tCat" class="input" ${splits ? 'disabled' : ''}>${categoryOptions(t.categoryId)}</select></label>
          <div class="field span-2" id="splitBox"></div>
          <label class="field span-2"><span>Notes</span><textarea id="tNotes" maxlength="1000">${esc(t.notes)}</textarea></label>
          <label class="field span-2"><span>Tags</span><input id="tTags" value="${esc((t.tags || []).join(', '))}" placeholder="comma-separated, e.g. vacation, reimbursable"></label>
          <div class="field span-2"><div class="chips"><label class="check"><input type="checkbox" id="tReviewed" ${t.reviewed ? 'checked' : ''}> Reviewed</label><label class="check"><input type="checkbox" id="tHidden" ${t.hidden ? 'checked' : ''}> Hide from budgets and reports</label></div></div>
        </div>
        ${!isNew ? `<section class="tax-box">
          <h3>${ICON.tax} Tax ledger</h3>
          ${linkedEntry ? `<p class="note small">On the ${esc(linkedEntry.taxYear)} worksheet as <b>${esc((S.getLine(linkedEntry.lineId) || { label: linkedEntry.lineId }).label)}</b>, ${esc(moneyC(linkedEntry.amount))}.</p><div class="btn-row"><button class="btn btn-sm" type="button" id="tOpenEntry">Open the entry</button><button class="btn btn-sm btn-ghost" type="button" id="tUnlink">Take it off the tax ledger</button></div>`
            : Number(t.amount) < 0 ? `<p class="note small">${tax.warning ? `${esc(tax.warning)} ` : ''}Send this to the tax ledger if it is deductible; it lands on the worksheet line you choose, in the ${esc(t.date.slice(0, 4))} tax year.</p><div class="tax-send">${ui.lineSelectHTML('tLine', tax.lineId, 'Worksheet line')}<button class="btn btn-sm" type="button" id="tSend">Add to tax ledger</button></div>` : '<p class="note small">Money in never goes on the deductions worksheet.</p>'}
        </section>` : ''}
        <div class="modal-actions">
          ${!isNew ? '<button class="btn btn-danger" type="button" id="tDelete">Delete</button>' : '<button class="btn" type="button" data-close-modal>Cancel</button>'}
          ${!isNew ? '<button class="btn btn-ghost" type="button" id="tRule">Make a rule</button>' : ''}
          ${!isNew && !splits ? '<button class="btn btn-ghost" type="button" id="tSplitBtn">Split</button>' : ''}
          <span class="spacer"></span><button class="btn btn-primary" type="button" id="tSave">${isNew ? 'Add' : 'Save'}</button>
        </div>`, (panel) => {
        const q = (sel) => panel.querySelector(sel);
        const closeBtn = q('[data-close-modal]'); if (closeBtn) closeBtn.onclick = () => closeModal();
        const totalNow = () => { const v = IMP.parseAmountCell(q('#tAmt').value); return v == null ? null : (q('#tDir').value === 'in' ? Math.abs(v) : -Math.abs(v)); };
        function drawSplits() {
          const box = q('#splitBox');
          if (!splits) { box.innerHTML = ''; box.hidden = true; q('#tCat').disabled = false; return; }
          box.hidden = false; q('#tCat').disabled = true;
          const total = totalNow() || 0;
          const used = splits.reduce((a, s) => a + Math.abs(Number(s.amount) || 0), 0);
          const left = M.cents(Math.abs(total) - used);
          box.innerHTML = `<span>Split between categories</span>${splits.map((s, i) => `<div class="split-row"><select class="input" data-split-cat="${i}" aria-label="Category for part ${i + 1}">${categoryOptions(s.categoryId)}</select><input class="input" data-split-amt="${i}" inputmode="decimal" value="${s.amount ? esc(Math.abs(s.amount).toFixed(2)) : ''}" aria-label="Amount for part ${i + 1}"><button class="btn btn-ghost btn-sm" type="button" data-split-del="${i}" aria-label="Remove part ${i + 1}">✕</button></div>`).join('')}
            <div class="split-foot"><button class="btn btn-sm" type="button" id="splitAdd">Add a part</button><span class="${Math.abs(left) < 0.005 ? 'left-ok' : 'left-over'}">${Math.abs(left) < 0.005 ? 'Adds up' : `${esc(moneyC(Math.abs(left)))} ${left > 0 ? 'left to assign' : 'too much'}`}</span><button class="btn btn-ghost btn-sm" type="button" id="splitOff">Remove split</button></div>`;
          box.querySelectorAll('[data-split-cat]').forEach((s) => { s.onchange = () => { splits[Number(s.dataset.splitCat)].categoryId = s.value; }; });
          box.querySelectorAll('[data-split-amt]').forEach((s) => { s.onchange = () => { const v = IMP.parseAmountCell(s.value); splits[Number(s.dataset.splitAmt)].amount = v == null ? 0 : Math.abs(v); drawSplits(); }; });
          box.querySelectorAll('[data-split-del]').forEach((b) => { b.onclick = () => { splits.splice(Number(b.dataset.splitDel), 1); if (splits.length < 2) splits = null; drawSplits(); }; });
          q('#splitAdd').onclick = () => { splits.push({ categoryId: M.UNCATEGORIZED, amount: Math.max(0, left) }); drawSplits(); };
          q('#splitOff').onclick = () => { splits = null; drawSplits(); };
        }
        drawSplits();
        const sb = q('#tSplitBtn'); if (sb) sb.onclick = () => { const total = Math.abs(totalNow() || 0); splits = [{ categoryId: q('#tCat').value, amount: M.cents(total) }, { categoryId: M.UNCATEGORIZED, amount: 0 }]; sb.remove(); drawSplits(); };
        q('#tSave').onclick = async () => {
          const amount = totalNow();
          const merchant = q('#tMerchant').value.trim();
          const date = q('#tDate').value;
          if (amount == null || amount === 0) { toast('Enter an amount.'); return; }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Enter a date.'); return; }
          const next = Object.assign({}, t, { merchant, amount, date, accountId: q('#tAcct').value, categoryId: q('#tCat').value, notes: q('#tNotes').value, tags: q('#tTags').value.split(',').map((s) => s.trim()).filter(Boolean), reviewed: q('#tReviewed').checked, hidden: q('#tHidden').checked, updatedAt: now() });
          if (splits) {
            const sign = amount < 0 ? -1 : 1;
            const parts = splits.filter((s) => Number(s.amount) > 0).map((s) => ({ categoryId: s.categoryId, amount: M.cents(sign * Math.abs(Number(s.amount))), notes: s.notes || '' }));
            if (parts.length < 2 || !M.splitsBalance(next, parts)) { toast('The parts of a split have to add up to the whole amount.'); return; }
            next.splits = parts; next.categoryId = parts[0].categoryId;
          } else delete next.splits;
          if (isNew && !merchant) { toast('Enter a merchant or a description.'); return; }
          const changedCat = existing && !splits && existing.categoryId !== next.categoryId;
          if (!(await save({ put: { transactions: [next] } }))) return;
          closeModal();
          rerender();
          if (changedCat) offerRule(next);
          else toast(isNew ? 'Transaction added.' : 'Saved.');
        };
        const del = q('#tDelete'); if (del) del.onclick = async () => {
          if (!(await confirmDialog('Delete this transaction?', `${t.merchant || 'It'} (${moneyC(Math.abs(t.amount))} on ${M.dayLabel(t.date, true)}) will be removed from this device.${linkedEntry ? ' Its tax entry stays on the tax ledger.' : ''}`, 'Delete', true))) return;
          if (await save({ delete: { transactions: [t.id] } }, 'Transaction deleted.', { action: { label: 'Undo', onClick: async () => { if (await save({ put: { transactions: [existing] } }, 'Restored.')) rerender(); } } })) { closeModal(); rerender(); }
        };
        const rb = q('#tRule'); if (rb) rb.onclick = () => { closeModal(); openRule(null, { when: { field: 'merchant', op: 'is', text: q('#tMerchant').value.trim() || t.merchant }, then: { categoryId: q('#tCat').value } }); };
        const send = q('#tSend'); if (send) send.onclick = async () => {
          const lineId = q('#tLine').value;
          if (!lineId) { toast('Choose the worksheet line first.'); return; }
          await sendToTax(t, lineId);
          closeModal(); rerender();
        };
        const oe = q('#tOpenEntry'); if (oe) oe.onclick = () => { closeModal(); ui.openTaxEntry(linkedEntry.id); };
        const ul = q('#tUnlink'); if (ul) ul.onclick = async () => {
          if (!(await confirmDialog('Take it off the tax ledger?', 'The entry made from this transaction will be deleted from the tax ledger. The transaction itself stays.', 'Remove entry', true))) return;
          try { await ui.deleteTaxEntries([linkedEntry.id]); } catch (e) { toast(`Could not remove it: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
          const next = Object.assign({}, t); delete next.entryId; next.updatedAt = now();
          await save({ put: { transactions: [next] } }, 'Taken off the tax ledger.');
          closeModal(); rerender();
        };
      });
    }
    /** After a category change, offer to file the merchant's other transactions the same way and to remember it. */
    function offerRule(t) {
      const key = M.merchantKey(t.merchant);
      const others = ms.transactions.filter((x) => x.id !== t.id && M.merchantKey(x.merchant) === key && x.categoryId !== t.categoryId && !(x.splits && x.splits.length) && Math.sign(x.amount) === Math.sign(t.amount));
      const exists = ms.rules.some((r) => r.when.op === 'is' && r.when.text.toLowerCase() === String(t.merchant).toLowerCase());
      if (!key || exists) { toast('Saved.'); return; }
      const label = others.length ? `Apply to ${others.length} more` : 'Always file it here';
      toast(`${t.merchant} → ${catName(t.categoryId)}.`, 9000, { label, onClick: async () => {
        const rule = { id: DB.uid(), order: ms.rules.length, when: { field: 'merchant', op: 'is', text: t.merchant, sign: t.amount < 0 ? 'out' : 'in' }, then: { categoryId: t.categoryId }, createdAt: now(), updatedAt: now() };
        const moved = others.map((x) => Object.assign({}, x, { categoryId: t.categoryId, updatedAt: now() }));
        if (await save({ put: { rules: [rule], transactions: moved } }, `${moved.length ? `${moved.length} more filed under ${catName(t.categoryId)}, and n` : 'N'}ew ${t.merchant} transactions will be too.`)) rerender();
      } });
    }
    async function sendToTax(t, lineId) {
      const amount = t.splits && t.splits.length ? Math.abs(t.splits.filter((s) => derive().index.get(s.categoryId).tax).reduce((a, s) => a + s.amount, 0)) || Math.abs(t.amount) : Math.abs(t.amount);
      const stamp = now();
      const entry = { id: DB.uid(), date: t.date, taxYear: Number(t.date.slice(0, 4)), lineId, amount: M.cents(amount), description: t.merchant || t.original || '', note: t.notes || '', hasReceipt: false, receiptId: null, createdAt: stamp, updatedAt: stamp, sample: false, source: 'transaction', txId: t.id };
      try { await ui.addTaxEntries([entry]); } catch (e) { toast(`Could not add it: ${e && e.message ? e.message : 'storage error'}.`, 6000); return false; }
      const next = Object.assign({}, t, { entryId: entry.id, updatedAt: stamp });
      if (!(await save({ put: { transactions: [next] } }))) { await ui.deleteTaxEntries([entry.id]).catch(() => {}); return false; }
      const line = S.getLine(lineId);
      toast(`${moneyC(amount)} → ${line ? line.label : lineId} on the ${entry.taxYear} worksheet.`);
      return true;
    }

    // =====================================================================================================
    // CASH FLOW
    // =====================================================================================================
    function periodRange() {
      const C0 = ms.ui.cash;
      const d = derive();
      const ym = C0.anchor || M.monthOf(d.today);
      if (C0.period === 'month') return { from: M.monthStart(ym), to: M.monthEnd(ym), label: M.monthLabel(ym, { long: true }), months: [ym] };
      if (C0.period === 'quarter') { const [y, m] = ym.split('-').map(Number); const q0 = Math.floor((m - 1) / 3) * 3 + 1; const start = `${y}-${String(q0).padStart(2, '0')}`; const end = M.addMonthsYM(start, 2); return { from: M.monthStart(start), to: M.monthEnd(end), label: `Q${(q0 + 2) / 3} ${y}`, months: M.monthRange(start, end) }; }
      if (C0.period === 'year') { const y = ym.slice(0, 4); return { from: `${y}-01-01`, to: `${y}-12-31`, label: y, months: M.monthRange(`${y}-01`, `${y}-12`) }; }
      const start = M.addMonthsYM(ym, -11);
      return { from: M.monthStart(start), to: M.monthEnd(ym), label: `${M.monthLabel(start)} – ${M.monthLabel(ym)}`, months: M.monthRange(start, ym) };
    }
    function renderCashflow() {
      const el = $('#view-cashflow');
      const fk = focusKeyOf();
      const d = derive();
      if (!ms.transactions.length) { el.innerHTML = onboardingHTML(); bindView(el); return; }
      const C0 = ms.ui.cash;
      const P0 = periodRange();
      const to = P0.to > d.today ? d.today : P0.to;
      const flow = M.cashFlow(ms.transactions, d.index, P0.from, P0.to);
      const chartMonths = C0.period === 'month' ? M.monthRange(M.addMonthsYM(P0.months[0], -11), P0.months[0]) : P0.months;
      const monthly = M.monthlyFlow(ms.transactions, d.index, chartMonths);
      const by = C0.by;
      const rows = (map, field) => Array.from(map.entries()).map(([k, o]) => ({ key: k, v: o[field] })).filter((r) => r.v > 0.004).sort((a, b) => b.v - a.v);
      const label = (k) => (by === 'category' ? catName(k) : by === 'group' ? (M.GROUP_BY_ID[k] ? M.GROUP_BY_ID[k].name : k) : k);
      const keyOf = (k) => (by === 'category' ? `category=${encodeURIComponent(k)}` : by === 'group' ? `group=${encodeURIComponent(k)}` : by === 'tag' ? `tag=${encodeURIComponent(k)}` : `q=${encodeURIComponent(k)}`);
      const map = by === 'category' ? flow.byCategory : by === 'group' ? flow.byGroup : by === 'tag' ? flow.byTag : flow.byMerchant;
      const spendRows = rows(map, 'spend');
      const incomeRows = rows(by === 'tag' ? flow.byTag : by === 'merchant' ? flow.byMerchant : flow.byCategory, 'income');
      const maxSpend = spendRows.length ? spendRows[0].v : 1;
      const maxIncome = incomeRows.length ? incomeRows[0].v : 1;
      // a bar takes its category group's colour where there is one, so the breakdown and the charts agree
      const barCls = (key, field) => (field === 'income' ? 's-in' : by === 'category' ? `s-${slotOf(d.index.get(key).groupId)}` : by === 'group' ? `s-${slotOf(key)}` : 's-out');
      const barList = (list, max, field, total) => `<ul class="bar-list">${list.slice(0, 25).map((r) => `<li><a href="#transactions?${field === 'income' && by === 'group' ? `category=${encodeURIComponent(r.key)}` : keyOf(r.key)}&from=${P0.from}&to=${P0.to}"><span class="bl-name">${by === 'category' || (field === 'income' && by === 'group') ? catDot(r.key) : by === 'group' ? `<span class="cat-dot s-${slotOf(r.key)}" aria-hidden="true"></span>` : ''}${esc(field === 'income' && by === 'group' ? catName(r.key) : label(r.key))}</span><span class="bl-val num">${esc(money(r.v))} <span class="muted">${esc(pctText(r.v / (total || 1)))}</span></span><span class="bl-bar"><span style="width:${((r.v / max) * 100).toFixed(1)}%" class="${barCls(r.key, field)}"></span></span></a></li>`).join('')}</ul>${list.length > 25 ? `<p class="muted small">and ${list.length - 25} more</p>` : ''}`;
      el.innerHTML = `
        <section class="card cf-head">
          <div class="cf-controls">
            <div class="chips" role="group" aria-label="Period">${[['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['12m', '12 months']].map(([k, l]) => `<button class="chip" type="button" data-cf-period="${k}" aria-pressed="${C0.period === k}">${l}</button>`).join('')}</div>
            <div class="month-switch"><button class="btn btn-ghost btn-icon" type="button" data-cf-step="-1" aria-label="Earlier">${ICON.left}</button><span class="month-switch-label">${esc(P0.label)}</span><button class="btn btn-ghost btn-icon" type="button" data-cf-step="1" aria-label="Later">${ICON.right}</button></div>
          </div>
          <div class="stat-row stat-row-4">
            ${statTile('Income', `<span class="num">${esc(money(flow.income))}</span>`)}
            ${statTile('Spending', `<span class="num">${esc(money(flow.expenses))}</span>`)}
            ${statTile(flow.net >= 0 ? 'Kept' : 'Spent beyond income', `<span class="num">${esc(money(Math.abs(flow.net)))}</span>`)}
            ${statTile('Savings rate', flow.savingsRate == null ? '—' : esc(pctText(flow.savingsRate)), P0.to > d.today ? `through ${esc(M.dayLabel(to))}` : '')}
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Income and spending by month</h2></div>
          ${columnsChart({ aria: 'Income and spending by month', groups: monthly.map((m) => ({ label: M.monthLabel(m.month, { noYear: true }).slice(0, 3), current: P0.months.includes(m.month), bars: [{ value: m.income, cls: 's-in', tip: `${M.monthLabel(m.month)} income: ${money(m.income)}` }, { value: m.expenses, cls: 's-out', tip: `${M.monthLabel(m.month)} spending: ${money(m.expenses)}` }] })), legend: [{ label: 'Income', cls: 's-in' }, { label: 'Spending', cls: 's-out' }] })}
          ${tableDetails('By month as a table', ['Month', 'Income', 'Spending', 'Kept', 'Savings rate'], monthly.map((m) => [M.monthLabel(m.month), money(m.income), money(m.expenses), money(m.net), m.savingsRate == null ? '—' : pctText(m.savingsRate)]))}
        </section>
        <section class="card">
          <div class="card-head"><h2>Where it went</h2><span class="muted small">${esc(P0.label)}</span></div>
          ${sankeyHTML(flow)}
        </section>
        <section class="card">
          <div class="card-head"><h2>Breakdown</h2><div class="chips" role="group" aria-label="Group by">${[['category', 'Category'], ['group', 'Group'], ['merchant', 'Merchant'], ['tag', 'Tag']].map(([k, l]) => `<button class="chip" type="button" data-cf-by="${k}" aria-pressed="${by === k}">${l}</button>`).join('')}</div></div>
          <div class="two-col">
            <div><h3 class="bl-head">Spending <span class="num">${esc(money(flow.expenses))}</span></h3>${spendRows.length ? barList(spendRows, maxSpend, 'spend', flow.expenses) : '<p class="muted small">No spending in this period.</p>'}</div>
            <div><h3 class="bl-head">Income <span class="num">${esc(money(flow.income))}</span></h3>${incomeRows.length ? barList(incomeRows, maxIncome, 'income', flow.income) : '<p class="muted small">No income in this period.</p>'}</div>
          </div>
        </section>`;
      bindView(el);
      restoreFocus(fk);
    }

    // =====================================================================================================
    // BUDGET
    // =====================================================================================================
    function renderBudget() {
      const el = $('#view-budget');
      const fk = focusKeyOf();
      const d = derive();
      const ym = ms.ui.budgetMonth || M.monthOf(d.today);
      const b = budgetFor(ym);
      const flex = b.mode === 'flex';
      const isNow = ym === M.monthOf(d.today);
      const pace = isNow ? Number(d.today.slice(8, 10)) / M.daysInMonth(ym) : ym < M.monthOf(d.today) ? 1 : 0;
      const showAll = ms.ui.showAllBudget;
      const keep = (r) => showAll || r.planned > 0 || r.actual !== 0 || r.rollover !== 0;
      const input = (cid, value, source, label) => `<input class="bud-in num ${source === 'carried' ? 'is-carried' : ''}" data-bud="${esc(cid)}" inputmode="decimal" value="${value ? esc(String(Math.round(value * 100) / 100)) : ''}" placeholder="0" aria-label="Budget for ${esc(label)}"${source === 'carried' ? ' title="Carried forward from an earlier month"' : ''}>`;
      const row = (r) => `<li class="bud-row">
          <button class="bud-name" type="button" data-cat-edit="${esc(r.category.id)}">${catDot(r.category.id)}<span>${esc(r.category.name)}</span>${r.rollover ? `<span class="pill pill-info" title="Rolled over from earlier months">${r.rollover > 0 ? '+' : '−'}${esc(money(Math.abs(r.rollover)))}</span>` : ''}</button>
          <span class="bud-plan">${flex && r.bucket === 'flexible' ? '<span class="muted small">in the pool</span>' : input(r.category.id, r.planned, r.source, r.category.name)}</span>
          <a class="bud-act num" href="#transactions?category=${esc(r.category.id)}&month=${ym}">${esc(money(r.actual))}</a>
          <span class="bud-left">${flex && r.bucket === 'flexible' ? '' : leftText(r.remaining, r.available)}</span>
          ${flex && r.bucket === 'flexible' ? '' : progressHTML(r.actual, r.available, { pace })}
        </li>`;
      const groupCard = (g, rows) => {
        const shown = rows.filter(keep);
        if (!shown.length) return '';
        const planned = shown.reduce((a, r) => a + (flex && r.bucket === 'flexible' ? 0 : r.available), 0), actual = shown.reduce((a, r) => a + r.actual, 0);
        return `<section class="card bud-group"><div class="card-head"><h2><span class="cat-dot s-${slotOf(g.id)}" aria-hidden="true"></span>${esc(g.name)}</h2><span class="muted small num">${esc(money(actual))} of ${esc(money(planned))}</span></div><div class="bud-cols" aria-hidden="true"><span>Category</span><span>Budget</span><span>Spent</span><span>Left</span></div><ul class="bud-list">${shown.map(row).join('')}</ul></section>`;
      };
      const allRows = b.expense.groups.flatMap((g) => g.rows.map((r) => Object.assign({ group: g.group }, r)));
      const hiddenCount = allRows.filter((r) => !keep(r)).length + b.income.rows.filter((r) => !(showAll || r.planned > 0 || r.actual !== 0)).length;
      const incomeRows = b.income.rows.filter((r) => showAll || r.planned > 0 || r.actual !== 0);
      const F = b.flex;
      el.innerHTML = `
        <section class="card bud-head">
          <div class="cf-controls">
            ${monthSwitcher('budget', ym, 'Budget month')}
            <div class="chips" role="group" aria-label="Budget style"><button class="chip" type="button" data-bud-mode="category" aria-pressed="${!flex}">By category</button><button class="chip" type="button" data-bud-mode="flex" aria-pressed="${flex}">Flex</button></div>
          </div>
          <div class="stat-row stat-row-4">
            ${statTile('Income', `<span class="num">${esc(money(b.income.actual))}</span>`, `of ${esc(money(b.income.planned))} planned`)}
            ${statTile('Spending', `<span class="num">${esc(money(b.expense.actual))}</span>`, `of ${esc(money(b.expense.planned))} budgeted`)}
            ${statTile(b.remaining >= 0 ? 'Left to spend' : 'Over budget', `<span class="num">${esc(money(Math.abs(b.remaining)))}</span>`, isNow ? `${M.daysInMonth(ym) - Number(d.today.slice(8, 10))} days to go` : '')}
            ${statTile('Left to budget', `<span class="num">${esc(money(b.leftToBudget))}</span>`, 'planned income less budgets')}
          </div>
          ${b.expense.planned > 0 ? progressHTML(b.expense.actual, b.expense.planned, { pace }) : ''}
          <div class="btn-row" style="margin-top:12px">
            <button class="btn btn-sm" type="button" data-act="bud-fill">Fill from 3-month averages</button>
            <button class="btn btn-sm btn-ghost" type="button" data-act="bud-copy">Copy last month</button>
            ${hiddenCount || showAll ? `<button class="btn btn-sm btn-ghost" type="button" data-act="bud-all">${showAll ? 'Only budgeted and active' : `Show all categories (${hiddenCount} more)`}</button>` : ''}
          </div>
          <p class="note small">A budget carries into the months after it until you change it; figures in grey are carried. Clear a box to go back to the earlier figure, or type 0 to stop it.</p>
        </section>
        ${flex ? `
        <section class="card flex-pool">
          <div class="card-head"><h2>Flexible spending</h2><span class="muted small">one pool for day-to-day categories</span></div>
          <div class="flex-pool-row"><label class="field"><span>Pool for ${esc(M.monthLabel(ym, { long: true, noYear: true }))} ($)</span>${input('__flexible', F.flexible.planned, F.flexible.source, 'flexible spending')}</label><div class="flex-pool-fig"><span class="hero-sm">${esc(money(F.flexible.actual))}</span> spent · ${leftText(F.flexible.remaining, F.flexible.planned)}</div></div>
          ${progressHTML(F.flexible.actual, F.flexible.planned, { pace })}
          <ul class="comp-list flex-list">${allRows.filter((r) => r.bucket === 'flexible' && (showAll || r.actual !== 0)).sort((a, c) => c.actual - a.actual).map((r) => `<li><a href="#transactions?category=${esc(r.category.id)}&month=${ym}">${catDot(r.category.id)}<span class="comp-name">${esc(r.category.name)}</span><span class="comp-val num">${esc(money(r.actual))}</span></a></li>`).join('')}</ul>
        </section>
        <section class="card bud-group"><div class="card-head"><h2>Fixed</h2><span class="muted small num">${esc(money(F.fixed.actual))} of ${esc(money(F.fixed.planned))}</span></div><ul class="bud-list">${allRows.filter((r) => r.bucket === 'fixed' && keep(r)).map(row).join('') || '<li class="muted small">No fixed categories have a budget.</li>'}</ul></section>
        <section class="card bud-group"><div class="card-head"><h2>Non-monthly</h2><span class="muted small">set aside monthly, rolls over</span></div><ul class="bud-list">${allRows.filter((r) => r.bucket === 'nonmonthly' && keep(r)).map(row).join('') || '<li class="muted small">No non-monthly categories have a budget.</li>'}</ul></section>`
        : b.expense.groups.map((g) => groupCard(g.group, g.rows)).join('')}
        <section class="card bud-group"><div class="card-head"><h2>Income</h2><span class="muted small num">${esc(money(b.income.actual))} of ${esc(money(b.income.planned))}</span></div><ul class="bud-list">${incomeRows.map((r) => `<li class="bud-row"><button class="bud-name" type="button" data-cat-edit="${esc(r.category.id)}">${catDot(r.category.id)}<span>${esc(r.category.name)}</span></button><span class="bud-plan">${input(r.category.id, r.planned, r.source, r.category.name)}</span><a class="bud-act num" href="#transactions?category=${esc(r.category.id)}&month=${ym}">${esc(money(r.actual))}</a><span class="bud-left">${r.planned > 0 ? (r.actual >= r.planned ? `<span class="left-ok">${ICON.check}received</span>` : `<span class="muted">${esc(money(r.planned - r.actual))} to come</span>`) : ''}</span></li>`).join('') || '<li class="muted small">No income this month yet.</li>'}</ul></section>`;
      $$('.bud-in', el).forEach((inp) => {
        inp.onchange = () => setBudget(ym, inp.dataset.bud, inp.value);
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') inp.blur(); };
      });
      bindView(el);
      restoreFocus(fk);
    }
    async function setBudget(ym, categoryId, text) {
      const raw = String(text || '').trim();
      const id = `${ym}:${categoryId}`;
      if (!raw) { if (await save({ delete: { budgets: [id] } })) rerender(); return; }
      const v = IMP.parseAmountCell(raw);
      if (v == null || v < 0) { toast('A budget is an amount of $0 or more.'); rerender(); return; }
      if (await save({ put: { budgets: [{ month: ym, categoryId, amount: v }] } })) rerender();
    }
    async function fillBudgets(ym) {
      const d = derive();
      const flex = ui.state.settings.budgetMode === 'flex';
      const rows = [];
      let pool = 0;
      for (const c of d.categories) {
        if (c.hidden || c.kind === 'transfer') continue;
        const v = M.suggestBudget(ms.transactions, d.index, c.id, ym, 3);
        if (!v) continue;
        if (flex && c.kind === 'expense' && c.budget === 'flexible') { pool += v; continue; }
        rows.push({ month: ym, categoryId: c.id, amount: v });
      }
      if (flex && pool) rows.push({ month: ym, categoryId: '__flexible', amount: Math.round(pool / 50) * 50 || pool });
      if (!rows.length) { toast('There is not enough history yet: the averages need spending in the three months before this one.', 6000); return; }
      if (await save({ put: { budgets: rows } }, `${rows.length} budgets set from what you spent in the three months before ${M.monthLabel(ym, { long: true, noYear: true })}.`)) rerender();
    }
    async function copyBudgets(ym) {
      const prev = M.addMonthsYM(ym, -1);
      const idx = M.budgetIndex(ms.budgets);
      const rows = [];
      for (const [cid] of idx) { const b = M.budgetFor(idx, cid, prev); if (b.source !== 'none') rows.push({ month: ym, categoryId: cid, amount: b.amount }); }
      if (!rows.length) { toast(`${M.monthLabel(prev, { long: true })} has no budget to copy.`); return; }
      if (await save({ put: { budgets: rows } }, `${M.monthLabel(prev, { long: true, noYear: true })}'s budget copied.`)) rerender();
    }

    // ---- categories and rules (shared by Budget and Settings) -----------------------------------------------
    function openCategory(id) {
      const d = derive();
      const c = id ? d.index.get(id) : null;
      const isNew = !c;
      const groupOpts = (sel, kind) => M.GROUPS.filter((g) => !kind || g.kind === kind).map((g) => `<option value="${g.id}" ${g.id === sel ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
      openModal(`<h2>${isNew ? 'New category' : esc(c.name)}</h2>
        <div class="grid-2">
          <label class="field span-2"><span>Name</span><input id="cName" value="${esc(c ? c.name : '')}" maxlength="60"></label>
          <label class="field"><span>Group</span><select id="cGroup" class="input">${groupOpts(c ? c.groupId : 'other', c ? c.kind : null)}</select></label>
          <label class="field"><span>Budget style</span><select id="cBudget" class="input">${M.BUDGET_TYPES.map((t) => `<option value="${t.id}" ${(c ? c.budget : 'flexible') === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
          <div class="field span-2"><div class="chips"><label class="check"><input type="checkbox" id="cRoll" ${c && c.rollover ? 'checked' : ''}> Roll what is left over into next month</label>${c && c.id !== M.UNCATEGORIZED ? `<label class="check"><input type="checkbox" id="cHidden" ${c.hidden ? 'checked' : ''}> Hide this category</label>` : ''}</div></div>
        </div>
        ${c && c.tax ? `<p class="note small">Spending here can be sent to the tax ledger; it suggests the ${esc((S.getLine(c.tax) || { label: c.tax }).label)} line.</p>` : ''}
        <div class="modal-actions">${c && c.custom ? '<button class="btn btn-danger" type="button" id="cDelete">Delete</button>' : c && !isNew ? '<button class="btn btn-ghost" type="button" id="cReset">Restore built-in</button>' : '<button class="btn" type="button" data-close-modal>Cancel</button>'}<span class="spacer"></span><button class="btn btn-primary" type="button" id="cSave">Save</button></div>`, (panel) => {
        const q = (s) => panel.querySelector(s);
        const cl = q('[data-close-modal]'); if (cl) cl.onclick = () => closeModal();
        q('#cSave').onclick = async () => {
          const name = q('#cName').value.trim();
          if (!name) { toast('A category needs a name.'); return; }
          const row = { id: c ? c.id : `c-${DB.uid().slice(0, 12)}`, name, groupId: q('#cGroup').value, budget: q('#cBudget').value, rollover: q('#cRoll').checked, hidden: q('#cHidden') ? q('#cHidden').checked : false, custom: c ? c.custom : true, updatedAt: now() };
          if (row.rollover && !(c && c.rollover)) row.rolloverStart = ms.ui.budgetMonth || M.monthOf(d.today);
          else if (c && c.rolloverStart) row.rolloverStart = c.rolloverStart;
          if (await save({ put: { categories: [row] } }, 'Category saved.')) { closeModal(); rerender(); }
        };
        const rs = q('#cReset'); if (rs) rs.onclick = async () => { if (await save({ delete: { categories: [c.id] } }, 'Built-in name and settings restored.')) { closeModal(); rerender(); } };
        const del = q('#cDelete'); if (del) del.onclick = async () => {
          const used = ms.transactions.filter((t) => t.categoryId === c.id || (t.splits || []).some((s) => s.categoryId === c.id));
          if (!(await confirmDialog(`Delete ${c.name}?`, used.length ? `${used.length} ${plural(used.length, 'transaction')} filed here will move to Uncategorized.` : 'Nothing is filed here.', 'Delete', true))) return;
          const moved = used.map((t) => { const o = Object.assign({}, t, { updatedAt: now() }); if (o.categoryId === c.id) o.categoryId = M.UNCATEGORIZED; if (o.splits) o.splits = o.splits.map((s) => (s.categoryId === c.id ? Object.assign({}, s, { categoryId: M.UNCATEGORIZED }) : s)); return o; });
          const budgets = ms.budgets.filter((b) => b.categoryId === c.id).map((b) => b.id);
          if (await save({ put: { transactions: moved }, delete: { categories: [c.id], budgets } }, `${c.name} deleted.`)) { closeModal(); rerender(); }
        };
      });
    }
    function ruleText(r) {
      const w = r.when, t = r.then;
      const field = w.field === 'merchant' ? 'merchant' : w.field === 'original' ? 'statement text' : 'merchant or statement';
      const op = w.op === 'is' ? 'is' : w.op === 'starts' ? 'starts with' : 'contains';
      const conds = [`${field} ${op} "${w.text}"`];
      if (w.sign) conds.push(w.sign === 'in' ? 'money in' : 'money out');
      if (w.min != null) conds.push(`at least ${moneyC(w.min)}`);
      if (w.max != null) conds.push(`at most ${moneyC(w.max)}`);
      if (w.accountId) conds.push(`in ${accountName(w.accountId)}`);
      const acts = [];
      if (t.categoryId) acts.push(`file under ${catName(t.categoryId)}`);
      if (t.merchant) acts.push(`rename to ${t.merchant}`);
      if (t.addTags && t.addTags.length) acts.push(`tag ${t.addTags.join(', ')}`);
      if (t.hide) acts.push('hide it');
      if (t.review) acts.push('mark it reviewed');
      return `When ${conds.join(', ')}: ${acts.join(', ')}.`;
    }
    function openRule(id, preset) {
      const r = id ? ms.rules.find((x) => x.id === id) : Object.assign({ id: null, when: { field: 'merchant', op: 'contains', text: '' }, then: {} }, preset || {});
      const w = Object.assign({ field: 'merchant', op: 'contains', text: '', sign: '', min: null, max: null, accountId: '' }, r.when), t = Object.assign({ categoryId: '', merchant: '', addTags: [], hide: false, review: false }, r.then);
      openModal(`<h2>${id ? 'Edit rule' : 'New rule'}</h2>
        <p class="note small">Rules run on every import and when you apply them. The first rule that sets a field wins.</p>
        <div class="grid-2">
          <label class="field"><span>When the</span><select id="rField" class="input">${[['merchant', 'merchant'], ['original', 'statement text'], ['any', 'merchant or statement']].map(([k, l]) => `<option value="${k}" ${w.field === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>&nbsp;</span><select id="rOp" class="input">${[['contains', 'contains'], ['is', 'is exactly'], ['starts', 'starts with']].map(([k, l]) => `<option value="${k}" ${w.op === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field span-2"><span>Text</span><input id="rText" value="${esc(w.text)}" maxlength="120"></label>
          <label class="field"><span>Direction</span><select id="rSign" class="input"><option value="">Either</option><option value="out" ${w.sign === 'out' ? 'selected' : ''}>Money out</option><option value="in" ${w.sign === 'in' ? 'selected' : ''}>Money in</option></select></label>
          <label class="field"><span>Account</span><select id="rAcct" class="input"><option value="">Any account</option>${accountOptions(w.accountId)}</select></label>
          <label class="field"><span>At least ($)</span><input id="rMin" inputmode="decimal" value="${w.min != null ? esc(w.min) : ''}"></label>
          <label class="field"><span>At most ($)</span><input id="rMax" inputmode="decimal" value="${w.max != null ? esc(w.max) : ''}"></label>
          <label class="field"><span>File under</span><select id="rCat" class="input"><option value="">Leave the category</option>${categoryOptions(t.categoryId)}</select></label>
          <label class="field"><span>Rename merchant to</span><input id="rMerchant" value="${esc(t.merchant)}" maxlength="80"></label>
          <label class="field span-2"><span>Add tags</span><input id="rTags" value="${esc((t.addTags || []).join(', '))}" placeholder="comma-separated"></label>
          <div class="field span-2"><div class="chips"><label class="check"><input type="checkbox" id="rHide" ${t.hide ? 'checked' : ''}> Hide it</label><label class="check"><input type="checkbox" id="rReview" ${t.review ? 'checked' : ''}> Mark it reviewed</label><label class="check"><input type="checkbox" id="rApply" checked> Apply to existing transactions now</label></div></div>
        </div>
        <div class="modal-actions">${id ? '<button class="btn btn-danger" type="button" id="rDelete">Delete</button>' : '<button class="btn" type="button" data-close-modal>Cancel</button>'}<span class="spacer"></span><button class="btn btn-primary" type="button" id="rSave">Save rule</button></div>`, (panel) => {
        const q = (s) => panel.querySelector(s);
        const cl = q('[data-close-modal]'); if (cl) cl.onclick = () => closeModal();
        q('#rSave').onclick = async () => {
          const num = (s) => { const v = q(s).value.trim(); if (!v) return null; const n = IMP.parseAmountCell(v); return n == null ? null : Math.abs(n); };
          const row = { id: id || DB.uid(), order: id ? r.order : ms.rules.length, when: { field: q('#rField').value, op: q('#rOp').value, text: q('#rText').value.trim(), sign: q('#rSign').value, min: num('#rMin'), max: num('#rMax'), accountId: q('#rAcct').value }, then: { categoryId: q('#rCat').value, merchant: q('#rMerchant').value.trim(), addTags: q('#rTags').value.split(',').map((s) => s.trim()).filter(Boolean), hide: q('#rHide').checked, review: q('#rReview').checked }, createdAt: r.createdAt || now(), updatedAt: now() };
          if (!row.when.text) { toast('A rule needs text to match.'); return; }
          if (!DB.sanitizeRow('rules', row)) { toast('Choose at least one thing the rule does.'); return; }
          const batch = { put: { rules: [row] } };
          let n = 0;
          if (q('#rApply').checked) {
            const rules = ms.rules.filter((x) => x.id !== row.id).concat([row]);
            batch.put.transactions = ms.transactions.filter((tx) => M.ruleMatches(row, tx)).map((tx) => {
              const { patch } = M.applyRules(tx, rules);
              const next = Object.assign({}, tx, patch, { updatedAt: now() });
              if (patch.categoryId && next.splits) delete next.splits;
              return next;
            });
            n = batch.put.transactions.length;
          }
          if (await save(batch, `Rule saved${n ? `; ${n} ${plural(n, 'transaction')} updated` : ''}.`)) { closeModal(); rerender(); }
        };
        const del = q('#rDelete'); if (del) del.onclick = async () => { if (await save({ delete: { rules: [id] } }, 'Rule deleted.')) { closeModal(); rerender(); } };
      });
    }

    // =====================================================================================================
    // RECURRING
    // =====================================================================================================
    function renderRecurring() {
      const el = $('#view-recurring');
      const fk = focusKeyOf();
      const d = derive();
      const ym = ms.ui.recurringMonth || M.monthOf(d.today);
      const live = d.streams.filter((s) => !s.ignored && s.status !== 'lapsed');
      const items = [];
      for (const s of live) {
        for (const o of s.occurrences) if (M.monthOf(o.date) === ym) items.push({ date: o.date, s, amount: o.amount, paid: true });
        const c = M.cadenceById(s.cadence);
        for (let k = 1; k < 60; k++) {
          const dt = M.nthDate(s.lastDate, c, k);
          if (dt > M.monthEnd(ym)) break;
          if (dt < M.monthStart(ym)) continue;
          items.push({ date: dt, s, amount: s.amount, paid: false, overdue: dt < d.today });
        }
      }
      items.sort((a, b) => a.date.localeCompare(b.date));
      const bills = items.filter((i) => i.s.sign === 'out');
      const income = items.filter((i) => i.s.sign === 'in');
      const sumOf = (l) => l.reduce((a, i) => a + i.amount, 0);
      const monthly = M.recurringMonthly(d.streams);
      const first = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1)).getUTCDay();
      const dim = M.daysInMonth(ym);
      const byDay = new Map();
      for (const i of items) { const k = Number(i.date.slice(8, 10)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(i); }
      const cells = [];
      for (let i = 0; i < first; i++) cells.push('<span class="cal-cell is-blank" aria-hidden="true"></span>');
      for (let day = 1; day <= dim; day++) {
        const list = byDay.get(day) || [];
        const iso = `${ym}-${String(day).padStart(2, '0')}`;
        const tip = list.map((i) => `${i.s.merchant} ${moneyC(i.amount)}${i.paid ? ' (paid)' : i.overdue ? ' (overdue)' : ''}`).join(' · ');
        cells.push(`<span class="cal-cell ${iso === d.today ? 'is-today' : ''}" ${tip ? `data-tip="${esc(tip)}" tabindex="0"` : ''}><span class="cal-day">${day}</span><span class="cal-dots">${list.slice(0, 4).map((i) => `<span class="cal-dot ${i.paid ? 'is-paid' : i.overdue ? 'is-overdue' : i.s.sign === 'in' ? 'is-in' : ''}"></span>`).join('')}</span>${tip ? `<span class="sr-only">${esc(tip)}</span>` : ''}</span>`);
      }
      const statusPill = (i) => (i.paid ? `<span class="pill pill-good">${ICON.check}Paid</span>` : i.overdue ? `<span class="pill pill-warn">${ICON.alert}Overdue</span>` : i.date === d.today ? '<span class="pill pill-act">Today</span>' : `<span class="pill pill-info">In ${M.daysBetween(d.today, i.date)} ${M.daysBetween(d.today, i.date) === 1 ? 'day' : 'days'}</span>`);
      const listHTML = (list) => `<ul class="rec-list">${list.map((i) => `<li><span class="rec-date">${esc(M.dayLabel(i.date))}</span><span class="rec-name">${catDot(i.s.categoryId)}${esc(i.s.merchant)}</span><span class="rec-amt num">${i.s.sign === 'in' ? '+' : ''}${esc(moneyC(i.amount))}</span><span class="rec-status">${i.date < d.today || i.paid || ym <= M.monthOf(d.today) ? statusPill(i) : ''}</span></li>`).join('')}</ul>`;
      el.innerHTML = `
        <section class="card">
          <div class="cf-controls">${monthSwitcher('recurring', ym, 'Recurring month')}</div>
          <div class="stat-row stat-row-4">
            ${statTile('Bills this month', `<span class="num">${esc(money(sumOf(bills)))}</span>`, `${bills.length} ${plural(bills.length, 'charge')}`)}
            ${statTile('Paid', `<span class="num">${esc(money(sumOf(bills.filter((i) => i.paid))))}</span>`)}
            ${statTile('Still to pay', `<span class="num">${esc(money(sumOf(bills.filter((i) => !i.paid))))}</span>`)}
            ${statTile('Recurring income', `<span class="num">${esc(money(monthly.in))}</span>`, 'in a typical month')}
          </div>
        </section>
        <section class="card">
          <div class="cal" role="group" aria-label="${esc(M.monthLabel(ym, { long: true }))} calendar">
            ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<span class="cal-head" aria-hidden="true">${w}</span>`).join('')}${cells.join('')}
          </div>
          <div class="legend"><span><span class="cal-dot is-paid"></span>Paid</span><span><span class="cal-dot"></span>Expected</span><span><span class="cal-dot is-overdue"></span>Overdue</span><span><span class="cal-dot is-in"></span>Income</span></div>
        </section>
        <section class="card"><div class="card-head"><h2>Bills</h2><span class="muted small num">${esc(money(monthly.out))} in a typical month</span></div>${bills.length ? listHTML(bills) : '<p class="muted small">Nothing recurring this month.</p>'}</section>
        ${income.length ? `<section class="card"><div class="card-head"><h2>Income</h2></div>${listHTML(income)}</section>` : ''}
        <section class="card">
          <div class="card-head"><h2>Everything recurring</h2><span class="muted small">found from steady charges</span></div>
          ${d.streams.length ? `<div class="table-wrap"><table class="table-twin recur-all"><thead><tr><th>Merchant</th><th>How often</th><th class="num">Amount</th><th>Next</th><th></th></tr></thead><tbody>${d.streams.map((s) => `<tr class="${s.ignored || s.status === 'lapsed' ? 'is-off' : ''}"><td>${catDot(s.categoryId)}${esc(s.merchant)}${s.varies ? ' <span class="muted small">varies</span>' : ''}</td><td>${esc(s.cadenceLabel)}</td><td class="num">${s.sign === 'in' ? '+' : ''}${esc(moneyC(s.amount))}</td><td>${s.ignored ? 'Not recurring' : s.status === 'lapsed' ? `Stopped after ${esc(M.dayLabel(s.lastDate, true))}` : esc(M.dayLabel(s.nextDate, s.nextDate.slice(0, 4) !== d.today.slice(0, 4)))}</td><td><button class="btn btn-ghost btn-sm" type="button" data-stream="${esc(s.key)}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="note">Recurring bills show up here once a merchant has charged the same amount on a steady schedule: two identical monthly charges, or three of anything else.</p>'}
        </section>`;
      bindView(el);
      restoreFocus(fk);
    }
    function openStream(key) {
      const s = derive().streams.find((x) => x.key === key);
      if (!s) return;
      const row = ms.recurring.find((r) => r.id === key) || { id: key };
      openModal(`<h2>${esc(s.merchant)}</h2>
        <p class="note small">${s.count} charges, the last ${esc(moneyC(s.lastAmount))} on ${esc(M.dayLabel(s.lastDate, true))}.</p>
        <div class="grid-2">
          <label class="field"><span>Name</span><input id="sName" value="${esc(row.name || '')}" placeholder="${esc(s.merchant)}" maxlength="80"></label>
          <label class="field"><span>Expected amount ($)</span><input id="sAmt" inputmode="decimal" value="${row.amount != null ? esc(row.amount) : ''}" placeholder="${esc(s.amount.toFixed(2))}"></label>
          <label class="field span-2"><span>How often</span><select id="sCad" class="input"><option value="">As detected (${esc(s.cadenceLabel.toLowerCase())})</option>${M.CADENCES.map((c) => `<option value="${c.id}" ${row.cadence === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        </div>
        <div class="modal-actions"><button class="btn ${s.ignored ? '' : 'btn-danger'}" type="button" id="sIgnore">${s.ignored ? 'It is recurring' : 'Not recurring'}</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="sSave">Save</button></div>`, (panel) => {
        const q = (x) => panel.querySelector(x);
        q('#sSave').onclick = async () => {
          const amt = q('#sAmt').value.trim();
          const next = { id: key, status: row.status || '', name: q('#sName').value.trim(), amount: amt ? IMP.parseAmountCell(amt) : null, cadence: q('#sCad').value, updatedAt: now() };
          if (await save({ put: { recurring: [next] } }, 'Saved.')) { closeModal(); rerender(); }
        };
        q('#sIgnore').onclick = async () => {
          const next = Object.assign({ name: '', amount: null, cadence: '' }, row, { id: key, status: s.ignored ? '' : 'ignored', updatedAt: now() });
          if (await save({ put: { recurring: [next] } }, s.ignored ? 'Back on the recurring list.' : `${s.merchant} is off the recurring list.`)) { closeModal(); rerender(); }
        };
      });
    }

    // =====================================================================================================
    // GOALS
    // =====================================================================================================
    function renderGoals() {
      const el = $('#view-goals');
      const fk = focusKeyOf();
      const d = derive();
      const statusPill = (p) => ({ done: `<span class="pill pill-good">${ICON.check}Funded</span>`, on_track: '<span class="pill pill-good">On track</span>', behind: `<span class="pill pill-warn">${ICON.alert}Behind</span>`, no_date: '<span class="pill pill-info">No date</span>' }[p.status]);
      el.innerHTML = `
        <div class="btn-row"><button class="btn btn-primary" type="button" data-act="add-goal">${ICON.plus}New goal</button></div>
        ${ms.goals.length ? `<div class="goal-grid">${ms.goals.map((g) => {
          const p = M.goalProgress(g, { balanceOn }, d.today);
          const accts = (g.accountIds || []).map(accountName);
          return `<section class="card goal-card">
            <div class="card-head"><h2>${esc(g.name)}</h2>${statusPill(p)}</div>
            <div class="goal-fig"><span class="hero-sm">${esc(money(p.saved))}</span> <span class="muted">${g.kind === 'debt' ? 'paid off' : 'saved'} of ${esc(money(p.target))}</span></div>
            ${progressHTML(p.saved, p.target, { noBudgetOk: true, cls: 'prog-goal' })}
            <dl class="dl goal-dl">
              <dt>${g.kind === 'debt' ? 'Still owed' : 'To go'}</dt><dd>${esc(money(p.remaining))}</dd>
              ${g.targetDate ? `<dt>Target date</dt><dd>${esc(M.dayLabel(g.targetDate, true))}</dd>` : ''}
              ${p.monthlyNeeded != null && p.status !== 'done' ? `<dt>Needed each month</dt><dd>${esc(money(p.monthlyNeeded))}</dd>` : ''}
              <dt>Recent pace</dt><dd>${p.pace > 0 ? `${esc(money(p.pace))} a month` : 'none in 3 months'}</dd>
              ${p.projected && p.status !== 'done' ? `<dt>At that pace</dt><dd>${esc(M.monthLabel(M.monthOf(p.projected), { long: true }))}</dd>` : ''}
            </dl>
            <p class="muted small">${accts.length ? `Counts ${esc(accts.join(', '))}.` : 'Counts the money you log against it.'}</p>
            <div class="btn-row">${!accts.length ? `<button class="btn btn-sm" type="button" data-goal-add="${esc(g.id)}">Add money</button>` : ''}<button class="btn btn-sm btn-ghost" type="button" data-goal="${esc(g.id)}">Edit</button></div>
          </section>`;
        }).join('')}</div>` : '<section class="card empty"><h3>No goals yet</h3><p>Save toward something, like an emergency fund or a trip, or pay a debt down. Tie a goal to an account and it fills in on its own.</p></section>'}`;
      bindView(el);
      restoreFocus(fk);
    }
    function openGoal(id) {
      const g = id ? ms.goals.find((x) => x.id === id) : { kind: 'save', name: '', target: '', targetDate: '', accountIds: [], startAmount: 0, contributions: [] };
      const accountChecks = (kind) => ms.accounts.filter((a) => !a.closed && (kind === 'debt' ? M.isLiability(a) : !M.isLiability(a))).map((a) => `<label class="check"><input type="checkbox" data-goal-acct="${esc(a.id)}" ${(g.accountIds || []).includes(a.id) ? 'checked' : ''}> ${esc(a.name)} <span class="muted small">${balanceHTML(a, balanceOf(a.id))}</span></label>`).join('') || '<span class="muted small">No accounts of that kind yet.</span>';
      openModal(`<h2>${id ? 'Edit goal' : 'New goal'}</h2>
        <div class="grid-2">
          <label class="field span-2"><span>Name</span><input id="gName" value="${esc(g.name)}" maxlength="80" placeholder="e.g. Emergency fund"></label>
          <label class="field"><span>Kind</span><select id="gKind" class="input"><option value="save" ${g.kind !== 'debt' ? 'selected' : ''}>Save up</option><option value="debt" ${g.kind === 'debt' ? 'selected' : ''}>Pay off a debt</option></select></label>
          <label class="field"><span>Target date</span><input id="gDate" type="date" value="${esc(g.targetDate || '')}"></label>
          <label class="field"><span id="gTargetLabel">${g.kind === 'debt' ? 'Debt when you started ($)' : 'Target ($)'}</span><input id="gTarget" inputmode="decimal" value="${g.kind === 'debt' ? esc(g.startAmount || '') : esc(g.target || '')}"></label>
          <label class="field" id="gStartWrap" ${g.kind === 'debt' ? 'hidden' : ''}><span>Already saved ($)</span><input id="gStart" inputmode="decimal" value="${g.kind !== 'debt' && g.startAmount ? esc(g.startAmount) : ''}" placeholder="0"></label>
          <div class="field span-2"><span>Accounts that count toward it</span><div class="chips" id="gAccts">${accountChecks(g.kind)}</div><small class="muted">Leave these empty to log money against the goal by hand.</small></div>
        </div>
        <div class="modal-actions">${id ? '<button class="btn btn-danger" type="button" id="gDelete">Delete</button>' : '<button class="btn" type="button" data-close-modal>Cancel</button>'}<span class="spacer"></span><button class="btn btn-primary" type="button" id="gSave">Save goal</button></div>`, (panel) => {
        const q = (s) => panel.querySelector(s);
        const cl = q('[data-close-modal]'); if (cl) cl.onclick = () => closeModal();
        q('#gKind').onchange = () => {
          const debt = q('#gKind').value === 'debt';
          q('#gTargetLabel').textContent = debt ? 'Debt when you started ($)' : 'Target ($)';
          q('#gStartWrap').hidden = debt;
          q('#gAccts').innerHTML = accountChecks(q('#gKind').value);
        };
        q('#gSave').onclick = async () => {
          const name = q('#gName').value.trim();
          const debt = q('#gKind').value === 'debt';
          const tv = IMP.parseAmountCell(q('#gTarget').value);
          const accountIds = $$('[data-goal-acct]', panel).filter((c) => c.checked).map((c) => c.dataset.goalAcct);
          if (!name) { toast('A goal needs a name.'); return; }
          let target = tv == null ? 0 : Math.abs(tv);
          let startAmount = debt ? target : Math.abs(IMP.parseAmountCell(q('#gStart').value) || 0);
          if (debt && !target && accountIds.length) { startAmount = target = M.cents(accountIds.reduce((a, x) => a + Math.max(0, -balanceOf(x)), 0)); }
          if (!target) { toast(debt ? 'Enter what was owed when you started, or tie the goal to the debt.' : 'Enter a target amount.'); return; }
          const row = Object.assign({}, g, { id: id || DB.uid(), name, kind: debt ? 'debt' : 'save', target, targetDate: q('#gDate').value, accountIds, startAmount, contributions: g.contributions || [], createdAt: g.createdAt || now(), updatedAt: now() });
          if (await save({ put: { goals: [row] } }, 'Goal saved.')) { closeModal(); rerender(); }
        };
        const del = q('#gDelete'); if (del) del.onclick = async () => { if (!(await confirmDialog(`Delete ${g.name}?`, 'The goal and the money logged against it are removed. Accounts are not touched.', 'Delete', true))) return; if (await save({ delete: { goals: [id] } }, 'Goal deleted.')) { closeModal(); rerender(); } };
      });
    }
    function openContribution(id) {
      const g = ms.goals.find((x) => x.id === id);
      if (!g) return;
      openModal(`<h2>Add to ${esc(g.name)}</h2><div class="grid-2"><label class="field"><span>Amount ($)</span><input id="kAmt" inputmode="decimal"></label><label class="field"><span>Date</span><input id="kDate" type="date" value="${esc(derive().today)}"></label></div><p class="note small">A negative amount takes money back out.</p><div class="modal-actions"><button class="btn" type="button" data-close-modal>Cancel</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="kSave">Add</button></div>`, (panel) => {
        panel.querySelector('[data-close-modal]').onclick = () => closeModal();
        panel.querySelector('#kSave').onclick = async () => {
          const v = IMP.parseAmountCell(panel.querySelector('#kAmt').value);
          const date = panel.querySelector('#kDate').value;
          if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Enter an amount and a date.'); return; }
          const row = Object.assign({}, g, { contributions: (g.contributions || []).concat([{ date, amount: v }]), updatedAt: now() });
          if (await save({ put: { goals: [row] } }, `${moneyC(v)} added to ${g.name}.`)) { closeModal(); rerender(); }
        };
      });
    }

    // =====================================================================================================
    // INVESTMENTS
    // =====================================================================================================
    function renderInvestments() {
      const el = $('#view-investments');
      const fk = focusKeyOf();
      const d = derive();
      const invAccounts = ms.accounts.filter((a) => ['brokerage', 'retirement'].includes(a.type) && !a.closed);
      const p = d.portfolio;
      const withoutHoldings = invAccounts.filter((a) => !p.byAccount.has(a.id));
      el.innerHTML = `
        <section class="card">
          <div class="card-head"><h2>Portfolio</h2>${p.gainPct != null ? `<span class="pill ${p.gain >= 0 ? 'pill-good' : 'pill-warn'}">${p.gain >= 0 ? '▲' : '▼'} ${esc(pctText(Math.abs(p.gainPct)))} on cost</span>` : ''}</div>
          ${p.count ? `<div class="hero-figure">${esc(money(p.value))}</div>
            <div class="split-figs"><span>Cost basis <b class="num">${esc(money(p.cost))}</b></span><span>${p.gain >= 0 ? 'Gain' : 'Loss'} <b class="num">${esc(money(Math.abs(p.gain)))}</b></span>${p.costCovered < 0.999 ? `<span class="muted small">gain covers the ${esc(pctText(p.costCovered))} of value with a cost basis</span>` : ''}</div>
            <h3 class="bl-head">Mix</h3>${compositionHTML(p.classes.map((c) => ({ label: c.label, value: c.value, cls: `s-${c.slot}` })))}`
            : `<p class="note">Add the holdings in a brokerage or retirement account to see the mix and the gain. A brokerage's OFX download brings them in with the prices on the statement date.</p>`}
          ${withoutHoldings.length ? `<p class="muted small">${esc(withoutHoldings.map((a) => a.name).join(', '))} ${withoutHoldings.length === 1 ? 'is' : 'are'} counted at the balance you entered (${esc(money(withoutHoldings.reduce((a, x) => a + balanceOf(x.id), 0)))}).</p>` : ''}
          <div class="btn-row"><button class="btn btn-primary" type="button" data-act="add-holding" ${invAccounts.length ? '' : 'disabled'}>${ICON.plus}Add holding</button><button class="btn" type="button" data-act="import">${ICON.upload}Import statement</button>${invAccounts.length ? '' : '<button class="btn btn-ghost" type="button" data-act="add-account">Add an investment account</button>'}</div>
        </section>
        ${invAccounts.filter((a) => p.byAccount.has(a.id)).map((a) => {
          const hs = ms.holdings.filter((h) => h.accountId === a.id).sort((x, y) => M.holdingValue(y) - M.holdingValue(x));
          return `<section class="card"><div class="card-head"><h2>${esc(a.name)}</h2><span class="num">${esc(money(p.byAccount.get(a.id)))}</span></div>
            <div class="table-wrap"><table class="table-twin holdings"><thead><tr><th>Holding</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain</th></tr></thead><tbody>${hs.map((h) => { const v = M.holdingValue(h); const gain = h.costBasis != null ? v - h.costBasis : null; return `<tr data-holding="${esc(h.id)}" tabindex="0" class="is-clickable"><td><b>${esc(h.symbol || '—')}</b><br><span class="muted small">${esc(h.name)}</span></td><td class="num">${esc(Number(h.shares).toLocaleString('en-US', { maximumFractionDigits: 4 }))}</td><td class="num">${esc(moneyC(h.price))}${h.priceDate ? `<br><span class="muted small">${esc(M.dayLabel(h.priceDate))}</span>` : ''}</td><td class="num">${esc(money(v))}</td><td class="num">${gain == null ? '—' : `<span class="${gain >= 0 ? 'delta-good' : 'delta-bad'}">${gain >= 0 ? '+' : '−'}${esc(money(Math.abs(gain)))}</span>`}</td></tr>`; }).join('')}</tbody></table></div></section>`;
        }).join('')}`;
      $$('[data-holding]', el).forEach((r) => { r.onclick = () => openHolding(r.dataset.holding); r.onkeydown = (ev) => { if (ev.key === 'Enter') openHolding(r.dataset.holding); }; });
      bindView(el);
      restoreFocus(fk);
    }
    function openHolding(id) {
      const d = derive();
      const h = id ? ms.holdings.find((x) => x.id === id) : { accountId: (ms.accounts.find((a) => ['brokerage', 'retirement'].includes(a.type)) || {}).id, symbol: '', name: '', assetClass: '', shares: '', price: '', priceDate: d.today, costBasis: null };
      openModal(`<h2>${id ? esc(h.symbol || h.name) : 'Add a holding'}</h2>
        <div class="grid-2">
          <label class="field span-2"><span>Account</span><select id="hAcct" class="input">${accountOptions(h.accountId, (a) => ['brokerage', 'retirement'].includes(a.type))}</select></label>
          <label class="field"><span>Symbol</span><input id="hSym" value="${esc(h.symbol)}" maxlength="16" autocapitalize="characters"></label>
          <label class="field"><span>Asset class</span><select id="hClass" class="input">${M.ASSET_CLASSES.map((c) => `<option value="${c.id}" ${(h.assetClass || M.guessAssetClass(h.symbol, h.name)) === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          <label class="field span-2"><span>Name</span><input id="hName" value="${esc(h.name)}" maxlength="120"></label>
          <label class="field"><span>Shares</span><input id="hShares" inputmode="decimal" value="${esc(h.shares)}"></label>
          <label class="field"><span>Price ($)</span><input id="hPrice" inputmode="decimal" value="${esc(h.price)}"></label>
          <label class="field"><span>Price as of</span><input id="hDate" type="date" value="${esc(h.priceDate || d.today)}"></label>
          <label class="field"><span>Cost basis ($, total)</span><input id="hCost" inputmode="decimal" value="${h.costBasis != null ? esc(h.costBasis) : ''}" placeholder="optional"></label>
        </div>
        <p class="note small">There is no price feed: update the price from your statement or a quote when you want the value current.</p>
        <div class="modal-actions">${id ? '<button class="btn btn-danger" type="button" id="hDelete">Delete</button>' : '<button class="btn" type="button" data-close-modal>Cancel</button>'}<span class="spacer"></span><button class="btn btn-primary" type="button" id="hSave">Save</button></div>`, (panel) => {
        const q = (s) => panel.querySelector(s);
        const cl = q('[data-close-modal]'); if (cl) cl.onclick = () => closeModal();
        q('#hSym').onchange = () => { q('#hClass').value = M.guessAssetClass(q('#hSym').value, q('#hName').value); };
        q('#hSave').onclick = async () => {
          const shares = Number(String(q('#hShares').value).replace(/,/g, '')), price = IMP.parseAmountCell(q('#hPrice').value);
          const cost = q('#hCost').value.trim() ? IMP.parseAmountCell(q('#hCost').value) : null;
          const row = { id: id || DB.uid(), accountId: q('#hAcct').value, symbol: q('#hSym').value.trim().toUpperCase(), name: q('#hName').value.trim(), assetClass: q('#hClass').value, shares, price: price == null ? NaN : price, priceDate: q('#hDate').value, costBasis: cost, updatedAt: now() };
          if (!row.accountId || !(row.symbol || row.name) || !Number.isFinite(shares) || !Number.isFinite(row.price)) { toast('A holding needs an account, a symbol or name, shares, and a price.'); return; }
          if (await save(holdingsBatch([row], [], row.accountId), 'Holding saved.')) { closeModal(); rerender(); }
        };
        const del = q('#hDelete'); if (del) del.onclick = async () => { if (await save(holdingsBatch([], [id], h.accountId), 'Holding deleted.')) { closeModal(); rerender(); } };
      });
    }
    /** Holdings written with the account's value for today, so the net worth history keeps each change. */
    function holdingsBatch(put, del, accountId) {
      const after = ms.holdings.filter((h) => h.accountId === accountId && !del.includes(h.id) && !put.some((p) => p.id === h.id)).concat(put.filter((p) => p.accountId === accountId));
      const value = after.reduce((a, h) => a + (Number(h.shares) || 0) * (Number(h.price) || 0), 0);
      const batch = { put: { holdings: put, balances: [{ accountId, date: derive().today, balance: M.cents(value), source: 'holdings' }] }, delete: { holdings: del } };
      return batch;
    }

    // =====================================================================================================
    // IMPORT
    // =====================================================================================================
    function pickFile() { const inp = $('#moneyFileInput'); if (inp) inp.click(); }
    async function onFile(file) {
      if (!file) return;
      let text;
      try { text = ui.decodeStatement(new Uint8Array(await file.arrayBuffer())); } catch (e) { toast('Could not read that file.'); return; }
      if (MI.isOFX(text)) {
        let parsed;
        try { parsed = MI.parseOFX(text); } catch (e) { toast(e.message, 6000); return; }
        ms.ui.importer = { kind: 'ofx', fileName: file.name, statements: parsed.statements.map((st) => {
          const match = ms.accounts.find((a) => a.importKey === st.key) || ms.accounts.find((a) => st.mask && a.mask === st.mask && M.accountType(a.type).group === M.accountType(MI.ofxAccountType(st)).group);
          return { st, target: match ? match.id : 'new', newName: `${M.accountType(MI.ofxAccountType(st)).label}${st.mask ? ` ••${st.mask}` : ''}`, newType: MI.ofxAccountType(st) };
        }) };
      } else {
        const rows = IMP.parseCSV(text);
        if (!rows.length) { toast('That file has no rows.'); return; }
        const map = MI.detectColumns(rows);
        const norm = MI.normalize(rows, map);
        if (!norm.rows.length) { toast('No rows had both a date and an amount. If this is a bank export, try the OFX or QFX download instead.', 8000); return; }
        const names = map.account >= 0 ? Array.from(new Set(norm.rows.map((r) => r.account).filter(Boolean))) : [];
        const byName = (n) => ms.accounts.find((a) => a.name.toLowerCase() === n.toLowerCase());
        ms.ui.importer = {
          kind: 'csv', fileName: file.name, rows, map, norm, spendIsNegative: norm.spendIsNegative,
          target: ms.ui.tx.accountId || (liveAccounts().find((a) => a.type !== 'property') || {}).id || 'new',
          newName: file.name.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 60) || 'Imported account', newType: M.guessAccountType(file.name),
          accounts: names.map((n) => ({ name: n, target: byName(n) ? byName(n).id : 'new', newType: M.guessAccountType(n) })),
          createCategories: true,
        };
      }
      openImport();
    }
    /** The import rows for the current choices, reviewed against what is already here. */
    function importRows() {
      const I = ms.ui.importer;
      const d = derive();
      const ctx = { transactions: ms.transactions, categories: d.categories, rules: ms.rules, history: history(), accountsById: d.accountsById };
      if (I.kind === 'ofx') {
        return I.statements.flatMap((s, si) => MI.review(s.st.transactions.map((t) => ({ date: t.date, amount: t.amount, description: t.name || t.memo, original: [t.name, t.memo].filter(Boolean).join(' ').trim(), fitid: t.fitid, accountId: s.target === 'new' ? `__new${si}` : s.target, statement: si })), ctx));
      }
      const norm = I.spendIsNegative === I.norm.spendIsNegative ? I.norm : (I.norm = MI.normalize(I.rows, I.map, { spendIsNegative: I.spendIsNegative }));
      return MI.review(norm.rows.map((r) => {
        let accountId = I.target === 'new' ? '__new' : I.target;
        if (I.accounts.length) { const a = I.accounts.find((x) => x.name === r.account); accountId = a ? (a.target === 'new' ? `__new:${a.name}` : a.target) : accountId; }
        return Object.assign({}, r, { accountId });
      }), ctx);
    }
    function openImport() {
      const I = ms.ui.importer;
      if (!I) return;
      const rows = importRows();
      const fresh = rows.filter((r) => !r.duplicate);
      const dupes = rows.length - fresh.length;
      const newCats = Array.from(new Set(fresh.map((r) => r.newCategory).filter(Boolean)));
      const acctSelect = (id, sel, label) => `<select class="input" data-imp-acct="${id}" aria-label="${esc(label)}"><option value="new" ${sel === 'new' ? 'selected' : ''}>New account</option>${accountOptions(sel)}</select>`;
      const typeSelect = (id, sel) => `<select class="input" data-imp-type="${id}" aria-label="Type for the new account">${M.ACCOUNT_TYPES.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
      let accountsHTML = '';
      if (I.kind === 'ofx') {
        accountsHTML = I.statements.map((s, i) => `<div class="imp-acct"><div><b>${esc(M.accountType(s.newType).label)}${s.st.mask ? ` ••${esc(s.st.mask)}` : ''}</b><span class="muted small"> · ${s.st.transactions.length} ${plural(s.st.transactions.length, 'transaction')}${s.st.balance != null ? ` · balance ${esc(moneyC(s.st.balance))}${s.st.balanceDate ? ` on ${esc(M.dayLabel(s.st.balanceDate, true))}` : ''}` : ''}${s.st.positions.length ? ` · ${s.st.positions.length} holdings` : ''}</span></div>
          <div class="imp-acct-pick">${acctSelect(`s${i}`, s.target, 'Import into')}${s.target === 'new' ? `<input class="input" data-imp-name="s${i}" value="${esc(s.newName)}" aria-label="Name for the new account">${typeSelect(`s${i}`, s.newType)}` : ''}</div></div>`).join('');
      } else if (I.accounts.length) {
        accountsHTML = I.accounts.map((a, i) => `<div class="imp-acct"><div><b>${esc(a.name)}</b><span class="muted small"> · from the file's account column</span></div><div class="imp-acct-pick">${acctSelect(`a${i}`, a.target, `Import ${a.name} into`)}${a.target === 'new' ? typeSelect(`a${i}`, a.newType) : ''}</div></div>`).join('');
      } else {
        accountsHTML = `<div class="imp-acct"><div><b>Import into</b></div><div class="imp-acct-pick">${acctSelect('one', I.target, 'Import into')}${I.target === 'new' ? `<input class="input" data-imp-name="one" value="${esc(I.newName)}" aria-label="Name for the new account">${typeSelect('one', I.newType)}` : ''}</div></div>`;
      }
      const preview = fresh.slice(0, 40);
      openModal(`
        <div class="card-head"><h2>Import ${esc(I.fileName)}</h2><button class="btn btn-ghost btn-sm" type="button" data-imp-cancel>Cancel</button></div>
        <div class="imp-accts">${accountsHTML}</div>
        ${I.kind === 'csv' ? `<label class="check"><input type="checkbox" id="impFlip" ${I.spendIsNegative ? 'checked' : ''}> Money out is written as a negative number in this file</label>` : ''}
        <p class="note">${fresh.length} new ${plural(fresh.length, 'transaction')}${dupes ? `; ${dupes} already here and left out` : ''}.${I.kind === 'csv' && I.map.balance >= 0 ? ' The running balance sets the account balance.' : ''}${I.kind === 'ofx' && I.statements.some((s) => s.st.balance != null) ? ' The statement balance sets the account balance.' : ''}</p>
        ${newCats.length ? `<label class="check"><input type="checkbox" id="impNewCats" ${I.createCategories ? 'checked' : ''}> Add ${newCats.length} ${plural(newCats.length, 'category', 'categories')} from the file: ${esc(newCats.slice(0, 6).join(', '))}${newCats.length > 6 ? '…' : ''}</label>` : ''}
        ${preview.length ? `<div class="imp-preview">${preview.map((r) => `<div class="imp-row"><span class="row-date">${esc(M.dayLabel(r.date))}</span><span class="imp-main"><span class="tx-merchant">${esc(r.merchant)}</span><span class="tx-sub">${catDot(r.categoryId)}${esc(r.newCategory && I.createCategories ? r.newCategory : catName(r.categoryId))}${r.because ? ` <span class="muted">· ${esc(r.because)}</span>` : ''}</span></span><span class="num">${amountHTML(r.amount)}</span></div>`).join('')}${fresh.length > preview.length ? `<p class="muted small" style="padding:8px 0">and ${fresh.length - preview.length} more</p>` : ''}</div>` : ''}
        <p class="muted small">New transactions are marked to review, unless the file carries its own categories. Categories come from your rules first, then from how you filed the same merchant before.</p>
        <div class="modal-actions"><button class="btn" type="button" data-imp-cancel>Cancel</button><span class="spacer"></span><button class="btn btn-primary" type="button" id="impGo" ${fresh.length || (I.kind === 'ofx' && I.statements.some((s) => s.st.positions.length || s.st.balance != null)) ? '' : 'disabled'}>Import ${fresh.length} ${plural(fresh.length, 'transaction')}</button></div>`, (panel) => {
        panel.querySelectorAll('[data-imp-cancel]').forEach((b) => { b.onclick = () => { ms.ui.importer = null; closeModal(); }; });
        panel.querySelectorAll('[data-imp-acct]').forEach((s) => { s.onchange = () => { const k = s.dataset.impAcct; if (k === 'one') I.target = s.value; else if (k[0] === 's') I.statements[Number(k.slice(1))].target = s.value; else I.accounts[Number(k.slice(1))].target = s.value; openImport(); }; });
        panel.querySelectorAll('[data-imp-type]').forEach((s) => { s.onchange = () => { const k = s.dataset.impType; if (k === 'one') I.newType = s.value; else if (k[0] === 's') I.statements[Number(k.slice(1))].newType = s.value; else I.accounts[Number(k.slice(1))].newType = s.value; }; });
        panel.querySelectorAll('[data-imp-name]').forEach((s) => { s.onchange = () => { const k = s.dataset.impName; if (k === 'one') I.newName = s.value; else I.statements[Number(k.slice(1))].newName = s.value; }; });
        const flip = panel.querySelector('#impFlip'); if (flip) flip.onchange = () => { I.spendIsNegative = flip.checked; openImport(); };
        const nc = panel.querySelector('#impNewCats'); if (nc) nc.onchange = () => { I.createCategories = nc.checked; openImport(); };
        panel.querySelector('#impGo').onclick = () => runImport(panel);
      }, () => { ms.ui.importer = null; });
    }
    async function runImport(panel) {
      const I = ms.ui.importer;
      const d = derive();
      const stamp = now();
      const newAccounts = [];
      const idFor = new Map(); // placeholder → real account id
      const mkAccount = (placeholder, name, type, extra) => { const id = DB.uid(); newAccounts.push(Object.assign({ id, name: (name || 'Imported account').trim().slice(0, 80) || 'Imported account', type, balanceMode: M.accountType(type).mode, createdAt: stamp, updatedAt: stamp }, extra || {})); idFor.set(placeholder, id); return id; };
      // pick up names typed but not yet committed by a change event
      if (panel) panel.querySelectorAll('[data-imp-name]').forEach((s) => { const k = s.dataset.impName; if (k === 'one') I.newName = s.value; else I.statements[Number(k.slice(1))].newName = s.value; });
      const balances = [], holdings = [];
      if (I.kind === 'ofx') {
        I.statements.forEach((s, i) => {
          const acctId = s.target === 'new' ? mkAccount(`__new${i}`, s.newName, s.newType, { importKey: s.st.key, mask: s.st.mask }) : s.target;
          if (s.target !== 'new') { const a = d.accountsById.get(acctId); if (a && !a.importKey) newAccounts.push(Object.assign({}, a, { importKey: s.st.key, mask: a.mask || s.st.mask, updatedAt: stamp })); }
          if (s.st.balance != null && s.st.balanceDate && !s.st.positions.length) balances.push({ accountId: acctId, date: s.st.balanceDate > d.today ? d.today : s.st.balanceDate, balance: s.st.balance, source: 'ofx' });
          if (s.st.positions.length) {
            const existing = ms.holdings.filter((h) => h.accountId === acctId);
            for (const p of s.st.positions) {
              const match = existing.find((h) => h.symbol && h.symbol === p.symbol.toUpperCase());
              holdings.push({ id: match ? match.id : DB.uid(), accountId: acctId, symbol: p.symbol.toUpperCase(), name: p.name, assetClass: match ? match.assetClass : M.guessAssetClass(p.symbol, p.name), shares: p.shares, price: p.price, priceDate: p.priceDate || s.st.balanceDate || d.today, costBasis: match ? match.costBasis : null, updatedAt: stamp });
            }
            if (s.st.cash) holdings.push({ id: (existing.find((h) => h.symbol === 'CASH') || {}).id || DB.uid(), accountId: acctId, symbol: 'CASH', name: 'Cash', assetClass: 'cash', shares: s.st.cash, price: 1, priceDate: s.st.balanceDate || d.today, costBasis: s.st.cash, updatedAt: stamp });
            balances.push({ accountId: acctId, date: s.st.balanceDate && s.st.balanceDate <= d.today ? s.st.balanceDate : d.today, balance: s.st.balance, source: 'holdings' });
          }
        });
      } else if (I.accounts.length) {
        I.accounts.forEach((a) => { if (a.target === 'new') mkAccount(`__new:${a.name}`, a.name, a.newType); });
        if (I.target === 'new' && I.norm.rows.some((r) => !r.account)) mkAccount('__new', I.newName, I.newType);
      } else if (I.target === 'new') mkAccount('__new', I.newName, I.newType);
      const resolve = (id) => (idFor.has(id) ? idFor.get(id) : id);
      // categories named in the file that are not here yet
      const rows = importRows().filter((r) => !r.duplicate);
      const newCats = [];
      const catFor = new Map();
      if (I.createCategories) {
        for (const name of Array.from(new Set(rows.map((r) => r.newCategory).filter(Boolean)))) {
          const sample = rows.filter((r) => r.newCategory === name);
          const incoming = sample.filter((r) => r.amount > 0).length > sample.length / 2;
          const id = `c-${DB.uid().slice(0, 12)}`;
          newCats.push({ id, name, groupId: incoming ? 'income' : 'other', budget: 'flexible', custom: true, updatedAt: stamp });
          catFor.set(name, id);
        }
      }
      const carriesCategories = I.kind === 'csv' && I.map.category >= 0;
      const txs = rows.map((r) => ({
        id: DB.uid(), accountId: resolve(r.accountId), date: r.date, amount: r.amount, merchant: r.merchant, original: r.original, categoryId: (r.newCategory && catFor.get(r.newCategory)) || r.categoryId,
        notes: r.notes || '', tags: r.tags || [], reviewed: r.reviewed || carriesCategories, hidden: !!r.hidden, fitid: r.fitid || undefined, source: I.kind, createdAt: stamp, updatedAt: stamp,
      }));
      // a transfer seen from both ends: the same money leaving one account and arriving in another
      const accountsAfter = new Map(ms.accounts.concat(newAccounts).map((a) => [a.id, a]));
      const window0 = txs.reduce((a, t) => (t.date < a ? t.date : a), '9999');
      const pool = ms.transactions.filter((t) => t.date >= M.addDays(window0, -5)).concat(txs);
      const loose = new Set([M.UNCATEGORIZED, M.OTHER_INCOME, M.TRANSFER, M.CC_PAYMENT]);
      const touched = new Map();
      for (const [outId, inId] of M.findTransferPairs(pool)) {
        const a = pool.find((t) => t.id === outId), b = pool.find((t) => t.id === inId);
        if (!txs.includes(a) && !txs.includes(b)) continue;
        if (!loose.has(a.categoryId) || !loose.has(b.categoryId)) continue;
        const toCard = (accountsAfter.get(b.accountId) || {}).type === 'credit';
        for (const [t, other] of [[a, b], [b, a]]) {
          const next = txs.includes(t) ? t : Object.assign({}, t, { updatedAt: stamp });
          next.categoryId = toCard ? M.CC_PAYMENT : M.TRANSFER; next.pair = other.id;
          if (!txs.includes(t)) touched.set(t.id, next);
        }
      }
      if (I.kind === 'csv') {
        // each account's closing balance, from the running-balance column when the file has one
        const byAcct = new Map();
        I.norm.rows.forEach((r) => {
          let id = I.target === 'new' ? idFor.get('__new') : I.target;
          if (I.accounts.length) { const a = I.accounts.find((x) => x.name === r.account); if (a) id = a.target === 'new' ? idFor.get(`__new:${a.name}`) : a.target; }
          if (!id) return;
          if (!byAcct.has(id)) byAcct.set(id, []);
          byAcct.get(id).push(r);
        });
        for (const [id, list] of byAcct) { const cb = MI.closingBalance(list); if (cb) balances.push({ accountId: id, date: cb.date > d.today ? d.today : cb.date, balance: cb.balance, source: 'csv' }); }
      }
      const batch = { put: { accounts: newAccounts, categories: newCats, transactions: txs.concat(Array.from(touched.values())), balances, holdings } };
      const btn = panel && panel.querySelector('#impGo'); if (btn) btn.disabled = true;
      try { await commit(batch); }
      catch (e) { if (btn) btn.disabled = false; toast(`Could not import: ${e && e.message ? e.message : 'storage error'}. Nothing was saved.`, 7000); return; }
      DB.requestPersistence();
      ms.ui.importer = null;
      closeModal();
      const review = txs.filter((t) => !t.reviewed).length;
      toast(`${txs.length} ${plural(txs.length, 'transaction')} imported${review ? `; ${review} to review` : ''}.`, 6000);
      if (review) { ms.ui.tx = Object.assign(freshTxUI(), { filter: 'review' }); go('transactions'); } else if (ui.state.view === 'transactions') rerender(); else go('transactions');
    }

    // =====================================================================================================
    // EXAMPLE DATA, EXPORT, SETTINGS
    // =====================================================================================================
    async function loadSample() {
      if (hasSamples()) { toast('The example household is already here.'); return; }
      const data = M.sampleData(M.todayISO());
      if (await save({ put: { accounts: data.accounts, transactions: data.transactions, balances: data.balances, holdings: data.holdings, goals: data.goals, budgets: data.budgets } }, 'Example household loaded. Every example row is marked, and Settings takes them all away again.', { ms: 7000 })) { if (ui.state.view === 'dashboard') rerender(); else go('dashboard'); }
    }
    async function removeSample() {
      const del = {};
      for (const k of DB.MONEY_DATA) { const key = DB.STORES[k].key; const ids = ms[k].filter((r) => r.sample).map((r) => r[key]); if (ids.length) del[k] = ids; }
      // a transaction the user added to an example account would be stranded, so it goes with the account
      const sampleAccts = new Set(ms.accounts.filter((a) => a.sample).map((a) => a.id));
      const stranded = ms.transactions.filter((t) => sampleAccts.has(t.accountId) && !t.sample).map((t) => t.id);
      if (stranded.length) del.transactions = (del.transactions || []).concat(stranded);
      if (!Object.keys(del).length) { toast('There is no example data to remove.'); return; }
      if (await save({ delete: del }, 'Example household removed.')) rerender();
    }
    function exportCSV() {
      const list = filteredTx();
      const head = ['date', 'merchant', 'category', 'group', 'account', 'amount', 'notes', 'tags', 'original_statement', 'reviewed', 'hidden', 'id'];
      const lines = [head.join(',')];
      for (const t of list.slice().reverse()) {
        for (const l of M.linesOf(t)) lines.push([t.date, DB.csvText(t.merchant), DB.csvText(catName(l.categoryId)), DB.csvText(derive().index.groupOf(l.categoryId).name), DB.csvText(accountName(t.accountId)), l.amount.toFixed(2), DB.csvText(t.notes), DB.csvText((t.tags || []).join(', ')), DB.csvText(t.original), t.reviewed ? 'yes' : 'no', t.hidden ? 'yes' : 'no', DB.csvText(t.id)].join(','));
      }
      ui.downloadText(`transactions-${M.todayISO()}.csv`, lines.join('\r\n'), 'text/csv');
    }
    function settingsHTML() {
      const d = derive();
      const custom = d.categories.filter((c) => c.custom).length, hidden = d.categories.filter((c) => c.hidden).length, edited = ms.categories.filter((r) => !r.custom).length;
      return `<section class="card" id="moneySettings">
        <div class="card-head"><h2>Money</h2><span class="muted small">${ms.accounts.length} ${plural(ms.accounts.length, 'account')} · ${ms.transactions.length} ${plural(ms.transactions.length, 'transaction')}</span></div>
        <div class="field"><span>Budget style</span><div class="chips"><button class="chip" type="button" data-bud-mode="category" aria-pressed="${ui.state.settings.budgetMode !== 'flex'}">By category</button><button class="chip" type="button" data-bud-mode="flex" aria-pressed="${ui.state.settings.budgetMode === 'flex'}">Flex: fixed, one flexible pool, non-monthly</button></div></div>
        <h3 style="margin-top:16px">Categories</h3>
        <p class="note small">${d.categories.length} categories in ${M.GROUPS.length} groups${custom ? `, ${custom} of your own` : ''}${edited ? `, ${edited} built-in ${plural(edited, 'one')} changed` : ''}${hidden ? `, ${hidden} hidden` : ''}.</p>
        <details class="more"><summary>Edit categories</summary><div class="cat-admin">${M.GROUPS.map((g) => `<div class="cat-admin-group"><h4><span class="cat-dot ${g.kind === 'income' ? 's-in' : g.kind === 'transfer' ? 's-xfer' : `s-${g.slot}`}" aria-hidden="true"></span>${esc(g.name)}</h4><div class="chips">${(d.index.byGroup.get(g.id) || []).map((c) => `<button class="chip ${c.hidden ? 'is-muted' : ''}" type="button" data-cat-edit="${esc(c.id)}">${esc(c.name)}${c.rollover ? ' ↻' : ''}</button>`).join('')}</div></div>`).join('')}</div>
          <div class="btn-row" style="margin-top:10px"><button class="btn btn-sm" type="button" data-act="add-category">${ICON.plus}New category</button></div></details>
        <h3 style="margin-top:16px">Rules</h3>
        ${ms.rules.length ? `<ul class="rule-list">${ms.rules.slice().sort((a, b) => a.order - b.order).map((r) => `<li><span>${esc(ruleText(r))}</span><button class="btn btn-ghost btn-sm" type="button" data-rule="${esc(r.id)}">Edit</button></li>`).join('')}</ul>` : '<p class="note small">No rules yet. Change a transaction\'s category and you will be offered one, or write one here.</p>'}
        <div class="btn-row"><button class="btn btn-sm" type="button" data-act="add-rule">${ICON.plus}New rule</button></div>
        <h3 style="margin-top:16px">Data</h3>
        <div class="btn-row">
          <button class="btn btn-sm" type="button" data-act="import">${ICON.upload}Import a statement</button>
          <button class="btn btn-sm" type="button" data-act="export-tx" ${ms.transactions.length ? '' : 'disabled'}>Export transactions (CSV)</button>
          ${hasSamples() ? '<button class="btn btn-sm btn-ghost" type="button" data-act="remove-sample">Remove the example household</button>' : '<button class="btn btn-sm btn-ghost" type="button" data-act="load-sample">Load the example household</button>'}
        </div>
        <p class="note small">Statements come in as files: most banks offer an OFX, QFX, or QBO download ("for Quicken" or "for QuickBooks"), and every one offers CSV. There is no bank login and no connection to a bank or an aggregator; a backup from the Data section below carries the money side too.</p>
      </section>`;
    }

    // ---- one delegated handler per view -------------------------------------------------------------------
    function bindView(el) {
      listen(el, 'click', async (ev) => {
        const t = ev.target.closest('button, [data-tx], [data-account], a');
        if (!t || !el.contains(t)) return;
        const ds = t.dataset;
        if (ds.tx && !ms.ui.tx.selectMode) { openTx(ds.tx); return; }
        if (ds.account) { openAccount(ds.account); return; }
        if (ds.txFilter) { ms.ui.tx.filter = ds.txFilter; ms.ui.tx.shown = TX_PAGE; renderTransactions(); return; }
        if (ds.nwRange) { ms.ui.nwRange = Number(ds.nwRange); renderAccounts(); return; }
        if (ds.monthStep) {
          const step = Number(ds.monthStep), d = derive();
          if (ds.monthFor === 'budget') { ms.ui.budgetMonth = M.addMonthsYM(ms.ui.budgetMonth || M.monthOf(d.today), step); renderBudget(); }
          else if (ds.monthFor === 'recurring') { ms.ui.recurringMonth = M.addMonthsYM(ms.ui.recurringMonth || M.monthOf(d.today), step); renderRecurring(); }
          return;
        }
        if (ds.cfPeriod) { ms.ui.cash.period = ds.cfPeriod; renderCashflow(); return; }
        if (ds.cfStep) { const C0 = ms.ui.cash; const n = { month: 1, quarter: 3, year: 12, '12m': 12 }[C0.period]; C0.anchor = M.addMonthsYM(C0.anchor || M.monthOf(derive().today), Number(ds.cfStep) * n); renderCashflow(); return; }
        if (ds.cfBy) { ms.ui.cash.by = ds.cfBy; renderCashflow(); return; }
        if (ds.budMode) { await setBudgetMode(ds.budMode); return; }
        if (ds.catEdit) { openCategory(ds.catEdit); return; }
        if (ds.rule) { openRule(ds.rule); return; }
        if (ds.stream) { openStream(ds.stream); return; }
        if (ds.goal) { openGoal(ds.goal); return; }
        if (ds.goalAdd) { openContribution(ds.goalAdd); return; }
        if (ds.bulk) { bulk(ds.bulk); return; }
        if (ds.dismiss) { await ui.dismiss('money:' + ds.dismiss); rerender(); return; }
        switch (ds.act) {
          case 'import': pickFile(); break;
          case 'add-account': openAddAccount(); break;
          case 'add-tx': openTx(null); break;
          case 'load-sample': loadSample(); break;
          case 'remove-sample': removeSample(); break;
          case 'toggle-hidden-accounts': ms.ui.showHiddenAccounts = !ms.ui.showHiddenAccounts; renderAccounts(); break;
          case 'select-mode': ms.ui.tx.selectMode = !ms.ui.tx.selectMode; ms.ui.tx.selected.clear(); renderTxBody(); break;
          case 'more-tx': ms.ui.tx.shown += TX_PAGE; renderTxBody(); break;
          case 'review-all': {
            const list = filteredTx().filter((x) => !x.reviewed);
            if (await save({ put: { transactions: list.map((x) => Object.assign({}, x, { reviewed: true, updatedAt: now() })) } }, `${list.length} marked reviewed.`)) rerender();
            break;
          }
          case 'export-tx': exportCSV(); break;
          case 'clear-scope': Object.assign(ms.ui.tx, { group: '', from: '', to: '', tag: '' }); renderTransactions(); break;
          case 'bud-fill': fillBudgets(ms.ui.budgetMonth || M.monthOf(derive().today)); break;
          case 'bud-copy': copyBudgets(ms.ui.budgetMonth || M.monthOf(derive().today)); break;
          case 'bud-all': ms.ui.showAllBudget = !ms.ui.showAllBudget; renderBudget(); break;
          case 'add-goal': openGoal(null); break;
          case 'add-holding': openHolding(null); break;
          case 'add-category': openCategory(null); break;
          case 'add-rule': openRule(null); break;
          default: break;
        }
      });
      listen(el, 'change', (ev) => {
        const cb = ev.target.closest('[data-tx-sel]');
        if (cb) { const set = ms.ui.tx.selected; if (cb.checked) set.add(cb.dataset.txSel); else set.delete(cb.dataset.txSel); const b = $('.bulk-bar b'); if (b) b.textContent = String(set.size); }
      });
    }
    async function setBudgetMode(mode) {
      try { await ui.updateSettings({ budgetMode: mode === 'flex' ? 'flex' : 'category' }); }
      catch (e) { toast(`Could not save: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      ms.dirty = true;
      rerender();
    }

    /** A view opened from a link may carry filters: `#transactions?filter=review`, `?category=coffee&month=2026-10`. */
    function route(view, params) {
      if (view !== 'transactions' || !params) return;
      const keys = ['filter', 'q', 'account', 'category', 'month', 'group', 'from', 'to', 'tag'];
      if (!keys.some((k) => params.has(k))) return;
      const U = freshTxUI();
      U.filter = TX_FILTERS.includes(params.get('filter')) ? params.get('filter') : 'all';
      U.q = params.get('q') || '';
      U.accountId = params.get('account') || '';
      U.categoryId = params.get('category') || '';
      U.month = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : '';
      U.group = params.get('group') || '';
      U.from = /^\d{4}-\d{2}-\d{2}$/.test(params.get('from') || '') ? params.get('from') : '';
      U.to = /^\d{4}-\d{2}-\d{2}$/.test(params.get('to') || '') ? params.get('to') : '';
      U.tag = params.get('tag') || '';
      ms.ui.tx = U;
    }
    function render(view) {
      ({ dashboard: renderDashboard, accounts: renderAccounts, transactions: renderTransactions, cashflow: renderCashflow, budget: renderBudget, recurring: renderRecurring, goals: renderGoals, investments: renderInvestments })[view]();
    }
    function bindSettings(container) { if (container) bindView(container); }

    return {
      VIEWS, TITLES, load, render, route, onFile, settingsHTML, bindSettings, loadSample, removeSample, hasSamples,
      invalidate: () => { ms.dirty = true; },
      state: ms, derive,
      // for tests and power users
      openTx, openImport, runImport, importRows,
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
