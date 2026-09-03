/*
 * app.js — the Itemizer UI.
 *
 * Plain DOM, no framework, no build step. Six views (Capture, Ledger, Advisor,
 * Insights, Worksheet, Settings) render from one state object; the tax engine in
 * rules.js and the recommender in advisor.js recompute after every change so
 * every view agrees.
 */
(function () {
  'use strict';

  const S = globalThis.ItemizerSchema;
  const R = globalThis.ItemizerRules;
  const P = globalThis.ItemizerParse;
  const C = globalThis.ItemizerClassify;
  const DB = globalThis.ItemizerStore;
  const ADV = globalThis.ItemizerAdvisor;
  const G = globalThis.ItemizerGeo;
  const IMP = globalThis.ItemizerImporter;
  const VAL = globalThis.ItemizerValuation;

  const VIEWS = ['capture', 'ledger', 'advisor', 'insights', 'worksheet', 'settings'];
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = R.money, moneyCents = R.moneyCents;
  const fmtMiles = (n) => `${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi`;
  const fmtAmount = (entry) => (S.isMiles(entry.lineId) ? fmtMiles(entry.amount) : moneyCents(entry.amount));
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LEVEL_LABEL = { act: 'To do', warn: 'Heads up', good: 'Good news', info: 'Note' };

  const ICON = {
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="12" cy="13" r="3.5" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    paper: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v18H7z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M10 8h4M10 12h4M10 16h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l9 16H3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M12 10v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.1" fill="currentColor"/></svg>',
    print: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V4h10v4M5 8h14v8h-3v4H8v-4H5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/></svg>',
  };

  // ---- state ---------------------------------------------------------------
  const state = {
    settings: null,
    entries: [],
    computed: null,
    view: 'capture',
    ledger: { q: '', section: '', filter: 'all', from: '', to: '', selectMode: false, selected: new Set() },
    capture: null,
    receiptURLs: new Map(), // receiptId -> object URL
    pendingReceiptTarget: null, // 'capture' | entryId
    showMonthsTable: false,
    captureMode: 'expense', // 'expense' | 'trip' | 'import'
    places: [],
    trips: [],
    trip: null,
    recorder: null,
    recorderTimer: null,
    importer: null,
    donation: null,
    showReceiptSheet: false,
  };

  function freshCapture() {
    return { text: '', parsed: null, lineId: null, amount: '', miles: '', date: P.todayISO(), description: '', note: '', share: '', items: null, paper: false, receiptBlob: null, receiptURL: null, repeat: 1, suggestions: [], nonDeductible: [], pinned: new Set(), dirty: false };
  }
  function freshTrip() {
    const home = state.places.find((p) => p.category === 'home');
    return { fromId: home ? home.id : '', toId: '', date: todayInYear(), purpose: '', roundTrip: true, miles: '', lineId: 'med.miles', method: 'manual', result: '', points: null, fromLabel: '', toLabel: '', startedAt: null, endedAt: null };
  }

  function todayInYear() {
    // Default entry date: today if we're in the selected tax year, else Dec 31 of that year (or Jan 1 if the year is ahead).
    const t = P.todayISO();
    const y = Number(state.settings.taxYear);
    const ty = Number(t.slice(0, 4));
    if (y === ty) return t;
    return y < ty ? `${y}-12-31` : `${y}-01-01`;
  }

  function recompute() {
    const today = P.todayISO();
    state.computed = R.compute(state.entries, Object.assign({}, state.settings, { today }));
    state.advice = ADV.analyze({ entries: state.entries, settings: state.settings, computed: state.computed, today });
  }

  function yearEntries() { return state.computed ? state.computed.entries : []; }

  // ---- toast / modal ---------------------------------------------------------
  let toastTimer = null;
  function toast(msg, ms, action) {
    const el = $('#toast');
    el.textContent = msg;
    if (action && action.label) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
      b.onclick = () => { el.hidden = true; clearTimeout(toastTimer); action.onClick(); };
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || (action ? 7000 : 2600));
  }
  function openModal(html, onOpen) {
    const m = $('#modal');
    $('#modalPanel').innerHTML = html;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    if (onOpen) onOpen($('#modalPanel'));
    const first = $('#modalPanel').querySelector('input, select, textarea, button');
    if (first) first.focus();
  }
  function closeModal() {
    const m = $('#modal');
    m.hidden = true;
    $('#modalPanel').innerHTML = '';
    document.body.style.overflow = '';
  }
  function confirmDialog(title, body, confirmLabel, danger) {
    return new Promise((resolve) => {
      openModal(`<h2>${esc(title)}</h2><p class="note">${esc(body)}</p><div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><span class="spacer"></span><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmLabel || 'OK')}</button></div>`, (panel) => {
        panel.querySelector('[data-act="cancel"]').onclick = () => { closeModal(); resolve(false); };
        panel.querySelector('[data-act="ok"]').onclick = () => { closeModal(); resolve(true); };
      });
    });
  }

  // ---- receipts ------------------------------------------------------------
  async function shrinkImage(file, maxDim, quality) {
    maxDim = maxDim || 1600; quality = quality || 0.82;
    let source = null, w = 0, h = 0;
    try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = source.width; h = source.height; } catch (e) { source = null; }
    if (!source) {
      source = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = URL.createObjectURL(file); });
      w = source.naturalWidth; h = source.naturalHeight;
    }
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    return blob || file;
  }
  async function receiptURL(receiptId) {
    if (!receiptId) return null;
    if (state.receiptURLs.has(receiptId)) return state.receiptURLs.get(receiptId);
    const rec = await DB.getReceipt(receiptId);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    state.receiptURLs.set(receiptId, url);
    return url;
  }
  function viewReceipt(url, title) {
    openModal(`<div class="card-head"><h2>${esc(title || 'Receipt')}</h2><button class="btn btn-ghost btn-sm" data-close="1">Close</button></div><img class="receipt-full" src="${url}" alt="Receipt image">`, (panel) => { panel.querySelector('[data-close]').onclick = closeModal; });
  }

  // ---- routing --------------------------------------------------------------
  function parseHash() {
    const raw = (location.hash || '#capture').slice(1);
    const [view, query] = raw.split('?');
    const params = new URLSearchParams(query || '');
    return { view: VIEWS.includes(view) ? view : 'capture', params };
  }
  function go(view, params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    location.hash = view + q;
  }
  function route() {
    const { view, params } = parseHash();
    state.view = view;
    if (view === 'ledger' && params.get('filter')) state.ledger.filter = params.get('filter');
    render();
    $('#main').scrollTo && window.scrollTo({ top: 0 });
  }

  // ---- render ---------------------------------------------------------------
  function render() {
    recompute();
    for (const v of VIEWS) {
      const el = $('#view-' + v);
      const active = v === state.view;
      el.hidden = !active;
      const tab = $('#tab-' + v);
      if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    renderYearSelect();
    ({ capture: renderCapture, ledger: renderLedger, advisor: renderAdvisor, insights: renderInsights, worksheet: renderWorksheet, settings: renderSettings })[state.view]();
    document.title = state.view === 'capture' ? 'Itemizer' : `Itemizer · ${state.view[0].toUpperCase()}${state.view.slice(1)}`;
  }

  function renderYearSelect() {
    const sel = $('#yearSelect');
    const cur = Number(state.settings.taxYear);
    const years = new Set(R.KNOWN_YEARS.concat([new Date().getFullYear(), new Date().getFullYear() + 1, cur]));
    for (const e of state.entries) { const y = R.taxYearOf(e); if (y) years.add(y); }
    const list = Array.from(years).filter(Boolean).sort((a, b) => b - a);
    sel.innerHTML = list.map((y) => `<option value="${y}" ${y === cur ? 'selected' : ''}>${y}</option>`).join('');
  }

  // ---- shared bits ----------------------------------------------------------
  function receiptIcon(entry) {
    const line = S.getLine(entry.lineId);
    if (!line || line.unit === 'miles') return '<span class="row-receipt rc-none"></span>';
    if (entry.receiptId) return `<span class="row-receipt rc-attached" title="Receipt photo attached">${ICON.check}</span>`;
    if (entry.hasReceipt) return `<span class="row-receipt rc-paper" title="Paper receipt filed">${ICON.paper}</span>`;
    const threshold = state.computed.params.receiptThreshold;
    if ((Number(entry.amount) || 0) >= threshold) return `<span class="row-receipt rc-missing" title="No receipt">${ICON.alert}</span>`;
    return '<span class="row-receipt rc-none"></span>';
  }
  function entryRow(e, opts) {
    const line = S.getLine(e.lineId);
    const dupe = opts && opts.dupes && opts.dupes.has(e.id);
    if (opts && opts.select) {
      return `<label class="row row-select">
      <span class="row-check"><input type="checkbox" data-sel="${esc(e.id)}" ${opts.selected.has(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.description || line.label)}"></span>
      <span class="row-date">${esc(P.formatDate(e.date, false))}</span>
      <span class="row-main"><span class="row-desc">${esc(e.description || line.label)}${e.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}</span><span class="row-line">${esc(line.label)} · ${esc(line.sectionTitle)}</span></span>
      <span class="row-amt">${esc(fmtAmount(e))}</span>
      ${receiptIcon(e)}
    </label>`;
    }
    return `<button class="row" data-edit="${esc(e.id)}" type="button">
      <span class="row-date">${esc(P.formatDate(e.date, false))}</span>
      <span class="row-main"><span class="row-desc">${esc(e.description || line.label)}${e.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}${dupe ? ' <span class="dupe-mark" title="Possible duplicate">⧉</span>' : ''}</span><span class="row-line">${esc(line.label)} · ${esc(line.sectionTitle)}</span></span>
      <span class="row-amt">${esc(fmtAmount(e))}${line.unit === 'miles' && line.treatment !== 'info' ? `<small>${esc(money(Number(e.amount) * (state.computed.params.mileage[line.rate] || 0)))}</small>` : ''}</span>
      ${receiptIcon(e)}
    </button>`;
  }
  function lineSelectHTML(id, selected) {
    return `<select id="${id}" class="input"><option value="">Choose a line…</option>${S.SECTIONS.map((sec) => `<optgroup label="${esc(sec.title)}">${sec.lines.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${esc(l.label)}${l.unit === 'miles' ? ' (miles)' : ''}</option>`).join('')}</optgroup>`).join('')}</select>`;
  }
  function meterHTML(cls) {
    const R0 = state.computed;
    const A = R0.scheduleA.total, SD = R0.standardDeduction.total;
    const max = Math.max(A, SD) * 1.12 || 1;
    return `<div class="meter ${cls || ''}" role="img" aria-label="${esc(`${money(A)} counts toward itemizing against a ${money(SD)} standard deduction`)}">
      <div class="meter-track"><div class="meter-fill ${A > SD ? 'is-over' : ''}" style="width:${(A / max * 100).toFixed(2)}%"></div><div class="meter-marker" style="left:${(SD / max * 100).toFixed(2)}%"></div></div>
      ${cls === 'mini-meter' ? '' : `<div class="meter-labels"><span><span class="legend-dot" style="background:var(--accent)"></span>Counts toward itemizing <b>${money(A)}</b></span><span>Standard deduction <b>${money(SD)}</b></span></div>`}
    </div>`;
  }

  // =====================================================================
  // CAPTURE
  // =====================================================================
  function renderCapture() {
    if (!state.capture) { state.capture = freshCapture(); state.capture.date = todayInYear(); }
    const cap = state.capture;
    const R0 = state.computed;
    const ye = yearEntries();
    const recent = ye.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.date.localeCompare(a.date)).slice(0, 6);
    const verdict = R0.verdict.itemize ? `<span class="pill pill-good">Itemizing wins by ${money(R0.verdict.difference)}</span>` : `<span class="pill pill-info">${money(-R0.verdict.difference)} to itemizing</span>`;
    const filing = R.FILING_STATUSES.find((f) => f.id === state.settings.filingStatus);
    const strip = `<a class="year-strip" href="#insights" aria-label="Open insights">
        <div class="strip-top"><div class="strip-title">${R0.taxYear} · ${esc(filing ? filing.label : '')}</div><div class="strip-verdict">${verdict}</div></div>
        <div class="strip-sub">${money(R0.scheduleA.grossEntered)} on the worksheet · ${money(R0.scheduleA.total)} counts after floors and caps${R0.scheduleC.hasActivity ? ` · ${money(R0.scheduleC.total)} Schedule C` : ''}</div>
        ${meterHTML('mini-meter')}
      </a>`;
    const mode = state.captureMode || 'expense';
    if (mode !== 'expense') {
      if (!state.trip) state.trip = freshTrip();
      $('#view-capture').innerHTML = `${strip}${modeBarHTML(mode)}${mode === 'trip' ? tripModeHTML() : importModeHTML()}`;
      bindModeBar();
      if (mode === 'trip') bindTripMode(); else bindImportMode();
      return;
    }

    $('#view-capture').innerHTML = `
      ${strip}
      ${modeBarHTML(mode)}

      ${captureAdviceHTML()}

      <form class="card quick" id="quickForm" autocomplete="off">
        <label class="quick-label" for="quickInput">Log an expense</label>
        <div class="quick-row">
          <input class="input" id="quickInput" type="text" placeholder="$42.13 CVS prescription 3/14" enterkeyhint="done" autocapitalize="sentences" value="${esc(cap.text)}">
          <button class="btn" type="button" id="snapBtn" title="Snap a receipt" aria-label="Snap a receipt">${ICON.camera}</button>
        </div>
        <p class="quick-help">Type it the way you'd say it: amount, what, when. Miles work too — <code>18 miles to physical therapy</code>. Press Enter to save when it looks right.</p>
      </form>

      <div class="card understood" id="understood" ${cap.dirty || cap.text || cap.receiptBlob ? '' : 'hidden'}>
        <div class="card-head"><h2>Here's what I understood</h2><button class="btn btn-ghost btn-sm" type="button" id="clearBtn">Clear</button></div>
        <div class="understood-grid">
          <label class="field" id="amountField"><span id="amountLabel">${cap.lineId && S.isMiles(cap.lineId) ? 'Miles' : 'Amount ($)'}</span><input id="fAmount" inputmode="decimal" value="${esc(cap.lineId && S.isMiles(cap.lineId) ? cap.miles : cap.amount)}" placeholder="0.00"></label>
          <label class="field"><span>Date</span><input id="fDate" type="date" value="${esc(cap.date)}"></label>
          <label class="field span-2"><span>What / who</span><input id="fDesc" value="${esc(cap.description)}" placeholder="CVS pharmacy, Dr. Lee copay, tithe…"></label>
        </div>
        <div class="suggest">
          <div class="suggest-label">Where it goes on the worksheet</div>
          <div class="chips" id="chips">${chipsHTML(cap)}</div>
          ${lineSelectHTML('fLine', cap.lineId)}
          <div class="line-hint" id="lineHint">${lineHintHTML(cap.lineId)}</div>
        </div>
        <div class="nd-warn" id="ndWarn" ${cap.nonDeductible.length ? '' : 'hidden'}>${cap.nonDeductible.map((n) => `<div><b>Probably not deductible.</b> ${esc(n.reason)}</div>`).join('')}</div>
        <div class="receipt-row" id="receiptRow" ${cap.lineId && S.isMiles(cap.lineId) ? 'hidden' : ''}>
          ${cap.receiptURL ? `<img class="receipt-thumb" id="capThumb" src="${cap.receiptURL}" alt="Receipt preview"><button class="btn btn-ghost btn-sm" type="button" id="dropReceipt">Remove photo</button>` : `<button class="btn" type="button" id="attachBtn">${ICON.camera} Attach receipt</button>`}
          <label class="check"><input type="checkbox" id="fPaper" ${cap.paper ? 'checked' : ''}> Paper receipt filed</label>
        </div>
        <details class="more" ${cap.note || cap.repeat > 1 ? 'open' : ''}>
          <summary>Note &amp; repeat</summary>
          <div class="grid-2">
            <label class="field span-2"><span>Note</span><textarea id="fNote" rows="${cap.note && cap.note.includes('\n') ? Math.min(8, cap.note.split('\n').length) : 2}" placeholder="Who you met, what it was for, lender's name and TIN…">${esc(cap.note)}</textarea></label>
            <label class="field"><span>Repeat monthly</span><select id="fRepeat">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<option value="${n}" ${cap.repeat === n ? 'selected' : ''}>${n === 1 ? 'Just once' : `${n} months`}</option>`).join('')}</select></label>
            <label class="field"><span>Business-use share (%)</span><input id="fShare" inputmode="numeric" value="${esc(cap.share || '')}" placeholder="100"></label>
            <p class="note span-2">Repeat is for premiums or a monthly pledge: one entry per month from this date. The share is for bills that are partly business, like a phone or internet: only that share is logged, and the full amount goes in the note.</p>
          </div>
        </details>
        <div class="actions"><button class="btn btn-primary" type="button" id="saveBtn">Save</button><span class="muted small" id="saveHint"></span></div>
      </div>

      ${calculatorsHTML()}

      <section class="card">
        <div class="card-head"><h2>Recent</h2><a href="#ledger" class="small">Open ledger</a></div>
        ${recent.length ? `<div class="recent-list">${recent.map((e) => entryRow(e)).join('')}</div>` : emptyStateHTML()}
      </section>`;

    bindCapture();
  }

  function emptyStateHTML() {
    return `<div class="empty"><h3>Nothing logged for ${state.settings.taxYear} yet</h3><p>Type an expense above, or load a set of example entries to see how the tracker thinks.</p><button class="btn" type="button" id="loadSample">Load example entries</button></div>`;
  }

  function chipsHTML(cap) {
    const ids = cap.suggestions.map((s) => s.lineId);
    if (cap.lineId && !ids.includes(cap.lineId)) ids.unshift(cap.lineId);
    if (!ids.length) return `<span class="muted small">Start typing and I'll suggest a line — or pick one below.</span>`;
    return ids.slice(0, 4).map((id) => {
      const l = S.getLine(id);
      const s = cap.suggestions.find((x) => x.lineId === id);
      return `<button class="chip" type="button" data-line="${id}" aria-pressed="${id === cap.lineId}" title="${esc(s && s.because.length ? 'Because: ' + s.because.join(', ') : '')}">${esc(l.label)} <small>· ${esc(l.sectionTitle.replace(' Expenses', '').replace(' Contributions', ''))}</small>${s && s.learned ? ' <small>★</small>' : ''}</button>`;
    }).join('');
  }
  function lineHintHTML(lineId) {
    if (!lineId) return '';
    const l = S.getLine(lineId);
    const t = S.TREATMENTS[l.treatment];
    const s = state.capture && state.capture.suggestions.find((x) => x.lineId === lineId);
    return `<b>${esc(l.label)}</b> → ${esc(t.schedule)}: ${esc(t.label)}.${l.hint ? ' ' + esc(l.hint) : ''}${s && s.because.length ? `<div class="because">Suggested because: ${esc(s.because.join(', '))}</div>` : ''}`;
  }

  function bindCapture() {
    const cap = state.capture;
    const root = $('#view-capture');
    const quick = $('#quickInput');
    quick.addEventListener('input', () => { cap.text = quick.value; onQuickChange(); });
    $('#quickForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveCapture(); });
    $('#snapBtn').onclick = () => { state.pendingReceiptTarget = 'capture'; $('#receiptInput').click(); };
    const attach = $('#attachBtn'); if (attach) attach.onclick = () => { state.pendingReceiptTarget = 'capture'; $('#receiptInput').click(); };
    const drop = $('#dropReceipt'); if (drop) drop.onclick = () => { if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL); cap.receiptBlob = null; cap.receiptURL = null; renderCapture(); };
    const thumb = $('#capThumb'); if (thumb) thumb.onclick = () => viewReceipt(cap.receiptURL, 'Receipt preview');
    $('#clearBtn').onclick = () => { if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL); state.capture = freshCapture(); state.capture.date = todayInYear(); renderCapture(); $('#quickInput').focus(); };
    $('#saveBtn').onclick = saveCapture;
    $('#fAmount').addEventListener('input', (ev) => { cap.pinned.add('amount'); cap.dirty = true; if (cap.lineId && S.isMiles(cap.lineId)) cap.miles = ev.target.value; else cap.amount = ev.target.value; updateSaveHint(); });
    $('#fDate').addEventListener('change', (ev) => { cap.pinned.add('date'); cap.dirty = true; cap.date = ev.target.value; updateSaveHint(); });
    $('#fDesc').addEventListener('input', (ev) => { cap.pinned.add('description'); cap.dirty = true; cap.description = ev.target.value; reclassify(); refreshChips(); });
    $('#fLine').addEventListener('change', (ev) => { cap.pinned.add('line'); setCaptureLine(ev.target.value || null); });
    $('#chips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-line]'); if (!b) return; cap.pinned.add('line'); setCaptureLine(b.dataset.line); });
    const paper = $('#fPaper'); if (paper) paper.onchange = () => { cap.paper = paper.checked; cap.dirty = true; };
    $('#fNote').addEventListener('input', (ev) => { cap.note = ev.target.value; cap.dirty = true; });
    $('#fRepeat').addEventListener('change', (ev) => { cap.repeat = Number(ev.target.value) || 1; });
    $('#fShare').addEventListener('input', (ev) => { cap.share = ev.target.value.replace(/[^0-9]/g, ''); cap.dirty = true; });
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-edit]'); if (b) { openEdit(b.dataset.edit); return; }
      const r = ev.target.closest('[data-rec-act]'); if (r) handleRecAction(r);
    });
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
    bindModeBar();
    bindCalculators();
    updateSaveHint();
  }

  // ---- capture modes ----------------------------------------------------------
  function modeBarHTML(mode) {
    const tabs = [['expense', 'Expense'], ['trip', 'Trip'], ['import', 'Import statement']];
    return `<div class="mode-bar" role="tablist" aria-label="Ways to log">${tabs.map(([id, label]) => `<button class="mode-tab" role="tab" type="button" aria-selected="${mode === id}" data-mode="${id}">${label}</button>`).join('')}</div>`;
  }
  function bindModeBar() {
    $$('#view-capture [data-mode]').forEach((b) => { b.onclick = () => { state.captureMode = b.dataset.mode; renderCapture(); }; });
  }

  // ---- calculators ----------------------------------------------------------------
  function calculatorsHTML() {
    return `<details class="card calc"><summary><b>Calculators</b> <span class="muted small">home office</span></summary>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>Home office, simplified method (sq ft, up to 300)</span><input id="calcSqft" inputmode="numeric" placeholder="e.g. 120"></label>
        <div class="field"><span>Deduction at $5 per square foot</span><div class="calc-out" id="calcHomeOut">$0</div></div>
      </div>
      <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" type="button" id="calcHomeLog" disabled>Log it on Schedule C</button></div>
      <p class="note small" style="margin-top:8px">The space must be used regularly and exclusively for the business. The simplified rate is $5 per square foot, capped at 300 square feet ($1,500). For a share of a bill that is partly business, use "Business-use share" under Note &amp; repeat when you log the bill.</p>
    </details>
    ${donationToolHTML()}`;
  }
  function donationToolHTML() {
    const D = state.donation || (state.donation = { charity: '', date: todayInYear(), items: [] });
    const dnTotal = VAL.total(D.items);
    const th = VAL.thresholds(dnTotal, state.computed.params);
    return `<details class="card calc" ${D.items.length ? 'open' : ''}><summary><b>Donated goods</b> <span class="muted small">itemized value for the furniture/clothing line</span></summary>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>Charity</span><input id="dnCharity" value="${esc(D.charity)}" placeholder="Goodwill, Salvation Army, church rummage sale"></label>
        <label class="field"><span>Date</span><input id="dnDate" type="date" value="${esc(D.date)}"></label>
        <label class="field span-2"><span>Item</span><input id="dnItem" list="dnCatalog" placeholder="Start typing: shirt, jeans, sofa, lamp, books…" autocomplete="off"><datalist id="dnCatalog">${VAL.CATALOG.map((c) => `<option value="${esc(c.name)}">${esc(c.category)} · $${c.low} to $${c.high}</option>`).join('')}</datalist></label>
        <label class="field"><span>Quantity</span><input id="dnQty" inputmode="numeric" value="1"></label>
        <label class="field"><span>Condition</span><select id="dnCond" class="input">${VAL.CONDITIONS.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Value each ($)</span><input id="dnValue" inputmode="decimal" placeholder="suggested from the range"></label>
        <div class="field"><span>&nbsp;</span><button class="btn" type="button" id="dnAdd">Add item</button></div>
      </div>
      <p class="note small" id="dnHint" style="margin-top:8px">Pick an item to see its typical thrift-shop range.</p>
      ${D.items.length ? `<div class="table-wrap"><table class="table-twin donation"><thead><tr><th>Item</th><th class="num">Qty</th><th>Condition</th><th class="num">Each</th><th class="num">Total</th><th></th></tr></thead><tbody>${D.items.map((it, i) => `<tr><td>${esc(it.name)}</td><td class="num">${it.qty}</td><td>${esc((VAL.CONDITIONS.find((c) => c.id === it.condition) || {}).label || it.condition)}</td><td class="num">${esc(moneyCents(it.value))}</td><td class="num">${esc(moneyCents(VAL.lineTotal(it)))}</td><td><button class="btn btn-ghost btn-sm" type="button" data-dn-remove="${i}" aria-label="Remove item">✕</button></td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="actions"><span><b>Total ${esc(moneyCents(dnTotal))}</b> · ${VAL.count(D.items)} ${VAL.count(D.items) === 1 ? 'item' : 'items'}${th.appraisal ? ' · <span class="pill pill-warn">appraisal needed over $5,000</span>' : th.form8283 ? ' · <span class="pill pill-act">Form 8283 over $500</span>' : ''}</span><button class="btn btn-primary btn-sm" type="button" id="dnLog" ${D.items.length ? '' : 'disabled'}>Log donation</button></div>
      <p class="note small" style="margin-top:8px">Values are typical thrift-shop ranges, the kind Goodwill and The Salvation Army publish, for items in good used condition or better, which is the IRS minimum for clothing and household goods. You set each value; the itemized list is saved with the entry as your record. Keep the charity's receipt too.</p>
    </details>`;
  }
  function bindCalculators() {
    const sq = $('#calcSqft'), out = $('#calcHomeOut'), btn = $('#calcHomeLog');
    if (!sq) return;
    const calc = () => { const n = Math.min(300, Math.max(0, Math.floor(Number(sq.value) || 0))); const amt = n * 5; out.textContent = money(amt); btn.disabled = !(amt > 0); return { n, amt }; };
    sq.addEventListener('input', calc);
    btn.onclick = () => { const { n, amt } = calc(); if (!amt) return; prefillCapture({ lineId: 'se.other', amount: amt, description: `Home office, simplified method: ${n} sq ft × $5`, date: todayInYear() }); };
    bindDonationTool();
  }
  function bindDonationTool() {
    const D = state.donation; if (!D || !$('#dnItem')) return;
    const item = $('#dnItem'), qty = $('#dnQty'), cond = $('#dnCond'), val = $('#dnValue'), hint = $('#dnHint');
    const current = () => VAL.byName(item.value) || VAL.find(item.value, 1)[0] || null;
    const refreshHint = () => {
      const c = current();
      if (!c) { hint.textContent = item.value.trim() ? 'Not in the catalog; enter your own fair-market value.' : 'Pick an item to see its typical thrift-shop range.'; return; }
      const sug = VAL.suggestValue(c, cond.value);
      hint.textContent = `${c.name}: typically $${c.low} to $${c.high}. Suggested in ${cond.options[cond.selectedIndex].text.toLowerCase()} condition: ${moneyCents(sug)}.`;
      if (!val.dataset.touched) val.value = String(sug);
    };
    item.addEventListener('input', () => { val.dataset.touched = ''; refreshHint(); });
    cond.addEventListener('change', () => { val.dataset.touched = ''; refreshHint(); });
    val.addEventListener('input', () => { val.dataset.touched = '1'; });
    $('#dnCharity').addEventListener('input', (ev) => { D.charity = ev.target.value; });
    $('#dnDate').addEventListener('change', (ev) => { D.date = ev.target.value; });
    $('#dnAdd').onclick = () => {
      const typed = item.value.trim();
      const q = Math.max(1, Math.floor(Number(qty.value) || 1));
      const v = Number(val.value);
      if (!typed) { toast('Type the item first.'); return; }
      if (!(v > 0)) { toast('Enter a value for each item.'); return; }
      D.items.push({ name: (VAL.byName(typed) || {}).name || typed, qty: q, condition: cond.value, value: Math.round(v * 100) / 100 });
      renderCapture();
      const next = $('#dnItem'); if (next) next.focus();
    };
    $$('[data-dn-remove]').forEach((b) => { b.onclick = () => { D.items.splice(Number(b.dataset.dnRemove), 1); renderCapture(); }; });
    $('#dnLog').onclick = () => {
      if (!D.items.length) return;
      const items = D.items.slice(), charity = D.charity.trim(), date = D.date || todayInYear();
      state.donation = null;
      prefillCapture({ lineId: 'ch.noncash', amount: VAL.total(items), description: `${charity || 'Donated goods'} — ${VAL.summarize(items)}`, date, note: VAL.recordText(items, charity, date), items });
    };
  }

  // ---- trips: places, distances, the GPS recorder, the mileage log ---------------------
  const CAT_LABEL = (id) => { const c = G.PLACE_CATEGORIES.find((x) => x.id === id); return c ? c.label.replace(/\s*\(.*\)$/, '') : id; };
  const METHOD_LABEL = { road: 'road distance', estimate: 'straight line × road factor', gps: 'recorded by GPS', manual: 'entered by hand' };
  const METHOD_SHORT = { road: 'by road', estimate: 'estimated', gps: 'GPS', manual: 'by hand' };
  const MILES_LINES = ['med.miles', 'se.miles', 'vol.miles'];

  function placeOptions(selectedId, includeCurrent) {
    const sorted = state.places.slice().sort((a, b) => (a.category === 'home' ? -1 : b.category === 'home' ? 1 : a.name.localeCompare(b.name)));
    return `<option value="">Choose…</option>${includeCurrent ? `<option value="__current" ${selectedId === '__current' ? 'selected' : ''}>Current location</option>` : ''}${sorted.map((p) => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}${p.category === 'home' ? ' (home)' : ''}</option>`).join('')}`;
  }
  function elapsedText(startedAt, endedAt) {
    if (!startedAt) return '00:00';
    const s = Math.max(0, Math.floor(((endedAt || Date.now()) - startedAt) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function tripModeHTML() {
    const T = state.trip, rec = state.recorder;
    const year = Number(state.settings.taxYear);
    const trips = state.trips.filter((t) => Number(t.taxYear) === year).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    const recState = rec ? rec.state : 'idle';
    return `
      <section class="card">
        <div class="card-head"><h2>Log a trip</h2><span class="muted small">date, destination, purpose, miles</span></div>
        ${state.places.length ? '' : '<p class="note" style="margin-bottom:12px">Add your home and the places you drive to (below); after that a trip is two taps. "Current location" works without any saved places.</p>'}
        <div class="grid-2">
          <label class="field"><span>From</span><select id="tripFrom" class="input">${placeOptions(T.fromId, true)}</select></label>
          <label class="field"><span>To</span><select id="tripTo" class="input">${placeOptions(T.toId, true)}</select></label>
          <label class="field"><span>Date</span><input id="tripDate" type="date" value="${esc(T.date)}"></label>
          <label class="field"><span>Purpose</span><input id="tripPurpose" value="${esc(T.purpose)}" placeholder="Physical therapy, client meeting, food bank run"></label>
        </div>
        <div class="chips" style="margin-top:12px">
          <label class="check"><input type="checkbox" id="tripRound" ${T.roundTrip ? 'checked' : ''}> Round trip</label>
          <button class="btn btn-sm" type="button" id="tripMeasure">Measure distance</button>
        </div>
        <p class="note" id="tripResult" style="margin-top:8px">${esc(T.result || '')}</p>
        <div class="grid-2" style="margin-top:8px">
          <label class="field"><span>Miles, total</span><input id="tripMiles" inputmode="decimal" value="${esc(T.miles)}" placeholder="0.0"></label>
          <label class="field"><span>Worksheet line</span><select id="tripLine" class="input">${MILES_LINES.map((id) => `<option value="${id}" ${T.lineId === id ? 'selected' : ''}>${esc(S.getLine(id).label)} · ${esc(S.getLine(id).sectionTitle)}</option>`).join('')}</select></label>
        </div>
        <div class="actions"><button class="btn btn-primary" type="button" id="tripLog">Log trip</button><span class="muted small" id="tripHint"></span></div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Record with GPS</h2><span class="pill ${recState === 'recording' ? 'pill-good' : recState === 'paused' ? 'pill-act' : 'pill-info'}">${recState}</span></div>
        <p class="note">Start when you leave, stop when you arrive. Positions stay on this device with the trip they belong to, and the screen stays awake while recording.</p>
        <div class="rec-readout"><span class="rec-miles" id="recMiles">${rec ? rec.miles.toFixed(1) : '0.0'}</span><span class="rec-unit">mi</span><span class="rec-time" id="recTime">${rec ? elapsedText(rec.startedAt, rec.state === 'idle' ? rec.endedAt : null) : '00:00'}</span></div>
        <canvas id="trackCanvas" class="track" width="640" height="200" role="img" aria-label="Sketch of the recorded track"></canvas>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-primary" type="button" id="recStart" ${recState === 'recording' ? 'disabled' : ''}>${recState === 'paused' ? 'Resume' : 'Start'}</button>
          <button class="btn" type="button" id="recPause" ${recState === 'recording' ? '' : 'disabled'}>Pause</button>
          <button class="btn btn-danger" type="button" id="recStop" ${recState === 'idle' ? 'disabled' : ''}>Stop and use</button>
        </div>
        <p class="note small" id="recError" style="margin-top:8px">${esc(rec && rec.error ? rec.error : (G.hasGeolocation() ? '' : 'This device does not offer location; measure between saved places or enter miles by hand.'))}</p>
      </section>

      <section class="card">
        <div class="card-head"><h2>Your places</h2><button class="btn btn-sm" type="button" id="addPlace">Add place</button></div>
        ${state.places.length ? `<div class="place-list">${state.places.slice().sort((a, b) => (a.category === 'home' ? -1 : b.category === 'home' ? 1 : a.name.localeCompare(b.name))).map((p) => `<div class="place-row"><div class="place-main"><b>${esc(p.name)}${p.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}</b><span class="muted small">${esc(CAT_LABEL(p.category))}${p.address ? ' · ' + esc(p.address) : ''}</span></div><div class="btn-row"><a class="btn btn-sm btn-ghost" href="${esc(G.osmLink(p.lat, p.lon))}" target="_blank" rel="noopener">Map</a><button class="btn btn-sm btn-ghost" type="button" data-place-edit="${esc(p.id)}">Edit</button></div></div>`).join('')}</div>` : '<p class="note">No places yet. Add home first, then the places you drive to for medical care, business, or volunteering. A place\'s category picks the worksheet line for you.</p>'}
      </section>

      <section class="card">
        <div class="card-head"><h2>Mileage log ${year}</h2><button class="btn btn-sm" type="button" id="exportTrips" ${trips.length || yearEntries().some((e) => S.isMiles(e.lineId)) ? '' : 'disabled'}>Export log</button></div>
        ${trips.length ? `<div class="table-wrap"><table class="table-twin trips"><thead><tr><th>Date</th><th>Trip</th><th>Purpose</th><th class="num">Miles</th><th>Line</th></tr></thead><tbody>${trips.map((t) => `<tr><td>${esc(P.formatDate(t.date, false))}</td><td>${esc(t.fromLabel || '?')} → ${esc(t.toLabel || '?')}${t.roundTrip ? ' ↩' : ''}<br><span class="muted small">${esc(METHOD_SHORT[t.method] || t.method || '')}</span></td><td>${esc(t.purpose || '')}</td><td class="num">${esc(String(t.miles))}</td><td class="small">${esc(S.getLine(t.lineId) ? S.getLine(t.lineId).label : '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">Trips logged here become entries on the mileage lines and rows in this log, which exports the way the IRS expects it: date, destination, purpose, miles.</p>'}
      </section>`;
  }

  function bindTripMode() {
    const T = state.trip;
    const root = $('#view-capture');
    const autoLine = () => { const to = state.places.find((p) => p.id === T.toId); const l = to ? G.lineForCategory(to.category) : null; if (l) { T.lineId = l; $('#tripLine').value = l; } };
    $('#tripFrom').onchange = (ev) => { T.fromId = ev.target.value; };
    $('#tripTo').onchange = (ev) => { T.toId = ev.target.value; autoLine(); };
    $('#tripDate').onchange = (ev) => { T.date = ev.target.value; };
    $('#tripPurpose').oninput = (ev) => { T.purpose = ev.target.value; };
    $('#tripRound').onchange = (ev) => { T.roundTrip = ev.target.checked; if (T.oneWay) { T.miles = String(T.roundTrip ? G.roundMiles(T.oneWay * 2) : T.oneWay); $('#tripMiles').value = T.miles; } };
    $('#tripMiles').oninput = (ev) => { T.miles = ev.target.value; if (T.method !== 'gps') T.method = T.oneWay && Number(T.miles) === (T.roundTrip ? G.roundMiles(T.oneWay * 2) : T.oneWay) ? T.method : 'manual'; };
    $('#tripLine').onchange = (ev) => { T.lineId = ev.target.value; };
    $('#tripMeasure').onclick = measureTrip;
    $('#tripLog').onclick = logTrip;
    $('#recStart').onclick = startRecording;
    $('#recPause').onclick = () => { if (state.recorder) { state.recorder.pause(); renderCapture(); } };
    $('#recStop').onclick = stopRecording;
    $('#addPlace').onclick = () => openPlaceModal(null);
    $('#exportTrips').onclick = exportMileageLog;
    root.addEventListener('click', (ev) => { const b = ev.target.closest('[data-place-edit]'); if (b) openPlaceModal(state.places.find((p) => p.id === b.dataset.placeEdit)); });
    drawTrack();
  }

  async function resolvePoint(id) {
    if (!id) return null;
    if (id === '__current') { const p = await G.getPosition(); return { lat: p.lat, lon: p.lon, label: 'Current location' }; }
    const pl = state.places.find((p) => p.id === id);
    return pl ? { lat: pl.lat, lon: pl.lon, label: pl.name } : null;
  }
  async function measureTrip() {
    const T = state.trip;
    const btn = $('#tripMeasure'); btn.disabled = true; btn.textContent = 'Measuring…';
    try {
      const [from, to] = await Promise.all([resolvePoint(T.fromId), resolvePoint(T.toId)]);
      if (!from || !to) { toast('Pick both places, or use your current location.'); return; }
      const straight = G.roundMiles(G.haversineMiles(from, to));
      let miles, method, text;
      try {
        if (!G.isOnline()) throw new Error('offline');
        miles = await G.routeMiles(from, to); method = 'road';
        text = `${miles} mi by road (OpenStreetMap routing), ${straight} mi straight line.`;
      } catch (e) {
        miles = G.estimateRoadMiles(from, to); method = 'estimate';
        text = `${straight} mi straight line × ${G.ROAD_FACTOR} road factor ≈ ${miles} mi. Road routing needs a connection; adjust the miles if you know the real distance.`;
      }
      T.oneWay = miles; T.method = method; T.fromLabel = from.label; T.toLabel = to.label;
      T.miles = String(T.roundTrip ? G.roundMiles(miles * 2) : miles);
      T.result = text + (T.roundTrip ? ` Round trip: ${T.miles} mi.` : '');
      renderCapture();
    } catch (e) { toast(e.message || 'Could not measure.'); }
    finally { const b = $('#tripMeasure'); if (b) { b.disabled = false; b.textContent = 'Measure distance'; } }
  }
  async function logTrip() {
    const T = state.trip;
    const miles = Number(T.miles);
    if (!(miles > 0)) { toast('Enter or measure the miles first.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(T.date)) { toast('Pick a date.'); return; }
    if (!MILES_LINES.includes(T.lineId)) { toast('Pick a worksheet line.'); return; }
    const fromLabel = T.fromLabel || (state.places.find((p) => p.id === T.fromId) || {}).name || (T.fromId === '__current' ? 'Current location' : '');
    const toLabel = T.toLabel || (state.places.find((p) => p.id === T.toId) || {}).name || (T.toId === '__current' ? 'Current location' : '');
    const now = new Date().toISOString();
    const line = S.getLine(T.lineId);
    const route = [fromLabel, toLabel].filter(Boolean).join(' → ');
    const entry = {
      id: DB.uid(), date: T.date, taxYear: Number(T.date.slice(0, 4)), lineId: T.lineId, amount: G.roundMiles(miles),
      description: [T.purpose.trim(), route].filter(Boolean).join(' — ') || line.label,
      note: `${T.roundTrip ? 'Round trip, ' : ''}${METHOD_LABEL[T.method] || T.method}.`, hasReceipt: false, receiptId: null, createdAt: now, updatedAt: now, sample: false,
    };
    const trip = { id: DB.uid(), date: T.date, taxYear: entry.taxYear, fromId: T.fromId, toId: T.toId, fromLabel, toLabel, purpose: T.purpose.trim(), miles: G.roundMiles(miles), roundTrip: !!T.roundTrip, method: T.method, lineId: T.lineId, entryId: entry.id, points: T.points || null, startedAt: T.startedAt, endedAt: T.endedAt, createdAt: now };
    await DB.putEntry(entry); state.entries.push(entry);
    await DB.putTrip(trip); state.trips.push(trip);
    if (T.purpose.trim()) { C.learn(state.settings.learned, T.purpose, T.lineId); await DB.saveSettings(state.settings); }
    toast(`Logged ${fmtMiles(trip.miles)} → ${line.label}`);
    const keepFrom = T.fromId;
    state.trip = freshTrip(); state.trip.fromId = keepFrom || state.trip.fromId;
    state.recorder = null;
    renderCapture();
  }

  function trackColors() {
    const cs = getComputedStyle(document.documentElement);
    return { line: cs.getPropertyValue('--accent').trim() || '#0e6b52', start: cs.getPropertyValue('--accent').trim() || '#0e6b52', end: cs.getPropertyValue('--warn-fill').trim() || '#d03b3b', ink: cs.getPropertyValue('--ink-3').trim() || '#75817a' };
  }
  function drawTrack() {
    const canvas = $('#trackCanvas'); if (!canvas) return;
    const pts = state.recorder ? state.recorder.points : (state.trip && state.trip.points) || [];
    G.sketch(canvas, pts, trackColors());
  }
  function updateRecorderUI(rec) {
    const m = $('#recMiles'); if (m) m.textContent = rec.miles.toFixed(1);
    const t = $('#recTime'); if (t) t.textContent = elapsedText(rec.startedAt, rec.state === 'idle' ? rec.endedAt : null);
    const e = $('#recError'); if (e) e.textContent = rec.error || '';
    drawTrack();
  }
  function startRecording() {
    if (!state.recorder || state.recorder.state === 'idle') {
      state.recorder = G.createRecorder({ onUpdate: updateRecorderUI, onError: (msg, rec) => { updateRecorderUI(rec); toast(msg); } });
    }
    const ok = state.recorder.start();
    if (!ok) { toast(state.recorder.error || 'Location is not available.'); return; }
    clearInterval(state.recorderTimer);
    state.recorderTimer = setInterval(() => { const t = $('#recTime'); if (t && state.recorder && state.recorder.state === 'recording') t.textContent = elapsedText(state.recorder.startedAt); }, 1000);
    renderCapture();
  }
  function stopRecording() {
    const rec = state.recorder; if (!rec) return;
    clearInterval(state.recorderTimer);
    const result = rec.stop();
    const T = state.trip;
    T.points = result.points; T.miles = String(result.miles); T.method = 'gps'; T.roundTrip = false; T.oneWay = null;
    T.startedAt = result.startedAt; T.endedAt = result.endedAt;
    T.result = `Recorded ${result.miles} mi over ${elapsedText(result.startedAt, result.endedAt)} (${result.points.length} positions kept). Pick the places and purpose, then log it.`;
    if (!T.date) T.date = todayInYear();
    toast(result.miles > 0 ? `Recorded ${result.miles} mi.` : 'No movement was recorded.');
    renderCapture();
    window.scrollTo({ top: 0 });
  }

  function openPlaceModal(place) {
    const p = Object.assign({ id: null, name: '', category: state.places.some((x) => x.category === 'home') ? 'medical' : 'home', address: '', lat: '', lon: '', note: '' }, place || {});
    openModal(`
      <div class="card-head"><h2>${p.id ? 'Edit place' : 'Add place'}</h2></div>
      <div class="grid-2">
        <label class="field"><span>Name</span><input id="plName" value="${esc(p.name)}" placeholder="Dr. Patel, St. Andrew's, Rivera studio"></label>
        <label class="field"><span>Category</span><select id="plCat" class="input">${G.PLACE_CATEGORIES.map((c) => `<option value="${c.id}" ${p.category === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field span-2"><span>Address</span><input id="plAddr" value="${esc(p.address)}" placeholder="Street, city, state"></label>
        <div class="span-2 btn-row"><button class="btn btn-sm" type="button" id="plFind">Find address</button><button class="btn btn-sm" type="button" id="plHere">Use current location</button></div>
        <div class="span-2 geo-candidates" id="plCands"></div>
        <label class="field"><span>Latitude</span><input id="plLat" inputmode="decimal" value="${esc(p.lat)}"></label>
        <label class="field"><span>Longitude</span><input id="plLon" inputmode="decimal" value="${esc(p.lon)}"></label>
      </div>
      <p class="note small">Address lookup uses OpenStreetMap when online. Without a connection, "Use current location" still works, or type coordinates from any map app.</p>
      <div class="modal-actions">
        ${p.id ? '<button class="btn btn-danger" type="button" id="plDelete">Delete</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" type="button" data-close="1">Cancel</button>
        <button class="btn btn-primary" type="button" id="plSave">Save place</button>
      </div>`, (panel) => {
      panel.querySelector('[data-close]').onclick = closeModal;
      const set = (lat, lon, addr) => { panel.querySelector('#plLat').value = lat; panel.querySelector('#plLon').value = lon; if (addr) panel.querySelector('#plAddr').value = addr; };
      panel.querySelector('#plFind').onclick = async () => {
        const q = panel.querySelector('#plAddr').value.trim(); if (!q) { toast('Type an address to find.'); return; }
        const cands = panel.querySelector('#plCands'); cands.innerHTML = '<span class="muted small">Searching…</span>';
        try {
          const list = await G.geocode(q);
          if (!list.length) { cands.innerHTML = '<span class="muted small">No match. Try adding the city and state.</span>'; return; }
          cands.innerHTML = list.map((c, i) => `<button class="btn btn-sm" type="button" data-cand="${i}">${esc(c.name)}</button>`).join('');
          cands.querySelectorAll('[data-cand]').forEach((b) => { b.onclick = () => { const c = list[Number(b.dataset.cand)]; set(c.lat, c.lon, c.name); cands.innerHTML = ''; }; });
        } catch (e) { cands.innerHTML = `<span class="muted small">${esc(e.message)}</span>`; }
      };
      panel.querySelector('#plHere').onclick = async () => {
        try {
          const pos = await G.getPosition(); set(pos.lat.toFixed(5), pos.lon.toFixed(5), null);
          if (G.isOnline()) { try { const r = await G.reverse(pos.lat, pos.lon); panel.querySelector('#plAddr').value = r.name || ''; } catch (e) { /* address is optional */ } }
          toast(`Location captured (±${Math.round(pos.acc)} m).`);
        } catch (e) { toast(e.message); }
      };
      const del = panel.querySelector('#plDelete');
      if (del) del.onclick = async () => { closeModal(); if (!(await confirmDialog('Delete this place?', `${p.name} will be removed. Trips already logged keep their miles.`, 'Delete', true))) return; await DB.deletePlace(p.id); state.places = state.places.filter((x) => x.id !== p.id); toast('Place deleted.'); renderCapture(); };
      panel.querySelector('#plSave').onclick = async () => {
        const name = panel.querySelector('#plName').value.trim();
        const lat = Number(panel.querySelector('#plLat').value), lon = Number(panel.querySelector('#plLon').value);
        if (!name) { toast('Give the place a name.'); return; }
        if (!(isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && panel.querySelector('#plLat').value !== '')) { toast('Find the address or use your current location so the place has coordinates.'); return; }
        const saved = { id: p.id || DB.uid(), name, category: panel.querySelector('#plCat').value, address: panel.querySelector('#plAddr').value.trim(), lat, lon, note: p.note || '', sample: false, updatedAt: new Date().toISOString() };
        await DB.putPlace(saved);
        state.places = state.places.filter((x) => x.id !== saved.id).concat([saved]);
        closeModal(); toast('Place saved.'); renderCapture();
      };
    });
  }

  function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportMileageLog() {
    const year = Number(state.settings.taxYear);
    const P0 = state.computed.params;
    const rows = [['date', 'from', 'to', 'round_trip', 'purpose', 'miles', 'how_measured', 'worksheet_line', 'rate_per_mile', 'dollar_value'].join(',')];
    const covered = new Set();
    for (const t of state.trips.filter((x) => Number(x.taxYear) === year).sort((a, b) => a.date.localeCompare(b.date))) {
      const line = S.getLine(t.lineId); const rate = line && line.rate ? P0.mileage[line.rate] || 0 : 0;
      covered.add(t.entryId);
      rows.push([t.date, t.fromLabel, t.toLabel, t.roundTrip ? 'yes' : 'no', t.purpose, t.miles, METHOD_LABEL[t.method] || t.method, line ? line.label : '', rate, (t.miles * rate).toFixed(2)].map(csvCell).join(','));
    }
    for (const e of yearEntries().filter((x) => S.isMiles(x.lineId) && !covered.has(x.id)).sort((a, b) => a.date.localeCompare(b.date))) {
      const line = S.getLine(e.lineId); const rate = line.rate ? P0.mileage[line.rate] || 0 : 0;
      rows.push([e.date, '', '', '', e.description, e.amount, 'entered by hand', line.label, rate, (Number(e.amount) * rate).toFixed(2)].map(csvCell).join(','));
    }
    downloadText(`itemizer-mileage-log-${year}.csv`, rows.join('\r\n'), 'text/csv');
  }

  // ---- statement import ---------------------------------------------------------------
  function importModeHTML() {
    const I = state.importer;
    if (!I) return `<section class="card">
        <div class="card-head"><h2>Import a statement</h2></div>
        <p class="note">A CSV export from your bank or card. Each row gets a suggested worksheet line the same way typed entries do. Rows already in the ledger, payments and refunds, and things that are never deductible are shown but not ticked. Nothing is saved until you add the rows you choose.</p>
        <div class="btn-row" style="margin-top:12px"><button class="btn btn-primary" type="button" id="pickCsv">Choose a CSV file</button></div>
        <p class="note small" style="margin-top:10px">Export a date range inside the tax year. Most personal spending in a statement is not deductible; the point is to catch the rows that are.</p>
      </section>`;
    const cols = I.headers.map((h, i) => ({ i, h: String(h || '').trim() || `Column ${i + 1}` }));
    const colSelect = (id, sel, allowNone) => `<select id="${id}" class="input">${allowNone ? `<option value="-1" ${sel < 0 ? 'selected' : ''}>—</option>` : ''}${cols.map((c) => `<option value="${c.i}" ${c.i === sel ? 'selected' : ''}>${esc(c.h)}</option>`).join('')}</select>`;
    const selected = I.rows.filter((r) => r.selected).length;
    const twoCol = I.map.debit >= 0 || I.map.credit >= 0;
    return `
      <section class="card">
        <div class="card-head"><h2>${esc(I.fileName)}</h2><span class="muted small">${I.rows.length} rows read${I.remembered ? ' · <span class="pill pill-info">layout remembered</span>' : ''}</span></div>
        <div class="grid-3">
          <label class="field"><span>Date column</span>${colSelect('impDate', I.map.date)}</label>
          <label class="field"><span>Description column</span>${colSelect('impDesc', I.map.description)}</label>
          ${twoCol ? `<label class="field"><span>Debit column</span>${colSelect('impDebit', I.map.debit, true)}</label><label class="field"><span>Credit column</span>${colSelect('impCredit', I.map.credit, true)}</label>` : `<label class="field"><span>Amount column</span>${colSelect('impAmount', I.map.amount)}</label>`}
        </div>
        <div class="chips" style="margin-top:10px">
          ${twoCol ? '' : `<label class="check"><input type="checkbox" id="impNeg" ${I.spendIsNegative ? 'checked' : ''}> Spending is shown as negative</label>`}
          <label class="check"><input type="checkbox" id="impHeader" ${I.map.headerRow ? 'checked' : ''}> First row is a header</label>
          <button class="btn btn-sm btn-ghost" type="button" id="impReset">Choose another file</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Review</h2><div class="btn-row"><button class="btn btn-sm" type="button" id="impSelectSuggested">Tick all with a suggestion</button><button class="btn btn-sm btn-ghost" type="button" id="impClear">Untick all</button></div></div>
        ${I.rows.length ? `<div class="table-wrap"><table class="table-twin import"><thead><tr><th></th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Worksheet line</th></tr></thead><tbody>
          ${I.rows.map((r, i) => `<tr class="${r.duplicate || r.refund ? 'is-dupe' : ''}"><td><input type="checkbox" data-imp-sel="${i}" ${r.selected ? 'checked' : ''} ${r.refund ? 'disabled' : ''} aria-label="Add this row"></td><td class="small">${esc(P.formatDate(r.date, false))}</td><td><div class="imp-desc">${esc(r.description || '(no description)')}</div>${r.memo ? `<div class="muted small">${esc(r.memo)}</div>` : ''}${r.duplicate ? '<span class="pill pill-info">already logged</span> ' : ''}${r.refund ? '<span class="pill pill-info">payment or refund</span> ' : ''}${r.nonDeductible.length ? `<span class="pill pill-act" title="${esc(r.nonDeductible[0].reason)}">probably not deductible</span>` : ''}</td><td class="num">${esc(moneyCents(Math.abs(r.amount)))}</td><td>${r.refund ? '' : lineSelectHTML(`impLine${i}`, r.lineId).replace('<select ', `<select data-imp-line="${i}" `)}${r.because.length ? `<div class="because">${esc(r.because.join(', '))}</div>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="note">No rows with a date and an amount were found. Check the column mapping above.</p>'}
        <div class="actions"><button class="btn btn-primary" type="button" id="impAdd" ${selected ? '' : 'disabled'}>Add ${selected} ${selected === 1 ? 'entry' : 'entries'}</button><span class="muted small">Descriptions come from the statement; edit them later in the ledger.</span></div>
      </section>`;
  }
  function rebuildImport() {
    const I = state.importer; if (!I) return;
    const norm = IMP.normalize(I.raw, I.map, { spendIsNegative: I.spendIsNegative });
    I.spendIsNegative = norm.spendIsNegative;
    I.rows = IMP.review(norm.rows, { learned: state.settings.learned, existingEntries: state.entries });
    I.headers = I.map.headerRow ? I.raw[0] : I.raw[0].map((_, i) => `Column ${i + 1}`);
  }
  async function onCSVFile(file) {
    if (!file) return;
    let text;
    try { text = await file.text(); } catch (e) { toast('Could not read that file.'); return; }
    const raw = IMP.parseCSV(text);
    if (raw.length < 1) { toast('That file has no rows.'); return; }
    const map = IMP.detectColumns(raw);
    const signature = IMP.headerSignature(raw[0]);
    const remembered = map.headerRow ? (state.settings.importMappings || {})[signature] : null;
    if (remembered && remembered.map) Object.assign(map, remembered.map);
    state.importer = { fileName: file.name, raw, map, spendIsNegative: remembered ? remembered.spendIsNegative : undefined, headers: [], rows: [], signature, remembered: !!remembered };
    rebuildImport();
    state.captureMode = 'import';
    renderCapture();
    toast(`${state.importer.rows.length} rows read, ${state.importer.rows.filter((r) => r.selected).length} look deductible.${remembered ? ' Column layout remembered from last time.' : ''}`);
  }
  function bindImportMode() {
    const pick = $('#pickCsv'); if (pick) { pick.onclick = () => $('#csvInput').click(); return; }
    const I = state.importer;
    const remap = (key, val) => { I.map[key] = Number(val); I.spendIsNegative = undefined; rebuildImport(); renderCapture(); };
    const d = $('#impDate'); if (d) d.onchange = (ev) => remap('date', ev.target.value);
    const ds = $('#impDesc'); if (ds) ds.onchange = (ev) => remap('description', ev.target.value);
    const a = $('#impAmount'); if (a) a.onchange = (ev) => remap('amount', ev.target.value);
    const db = $('#impDebit'); if (db) db.onchange = (ev) => remap('debit', ev.target.value);
    const cr = $('#impCredit'); if (cr) cr.onchange = (ev) => remap('credit', ev.target.value);
    const neg = $('#impNeg'); if (neg) neg.onchange = (ev) => { I.spendIsNegative = ev.target.checked; rebuildImport(); renderCapture(); };
    $('#impHeader').onchange = (ev) => { I.map.headerRow = ev.target.checked; I.spendIsNegative = undefined; rebuildImport(); renderCapture(); };
    $('#impReset').onclick = () => { state.importer = null; renderCapture(); };
    $('#impSelectSuggested').onclick = () => { I.rows.forEach((r) => { r.selected = !!r.lineId && !r.refund; }); renderCapture(); };
    $('#impClear').onclick = () => { I.rows.forEach((r) => { r.selected = false; }); renderCapture(); };
    const root = $('#view-capture');
    root.addEventListener('change', (ev) => {
      const sel = ev.target.closest('[data-imp-sel]'); if (sel) { I.rows[Number(sel.dataset.impSel)].selected = sel.checked; const btn = $('#impAdd'); const n = I.rows.filter((r) => r.selected).length; btn.disabled = !n; btn.textContent = `Add ${n} ${n === 1 ? 'entry' : 'entries'}`; return; }
      const line = ev.target.closest('[data-imp-line]'); if (line) { const r = I.rows[Number(line.dataset.impLine)]; r.lineId = line.value; if (r.lineId && !r.selected) { r.selected = true; const cb = root.querySelector(`[data-imp-sel="${line.dataset.impLine}"]`); if (cb) cb.checked = true; const btn = $('#impAdd'); const n = I.rows.filter((x) => x.selected).length; btn.disabled = !n; btn.textContent = `Add ${n} ${n === 1 ? 'entry' : 'entries'}`; } }
    });
    $('#impAdd').onclick = async () => {
      const chosen = I.rows.filter((r) => r.selected && r.lineId && S.getLine(r.lineId) && r.amount > 0);
      if (!chosen.length) { toast('Tick at least one row with a worksheet line.'); return; }
      const now = new Date().toISOString();
      const entries = chosen.map((r) => ({ id: DB.uid(), date: r.date, taxYear: Number(r.date.slice(0, 4)), lineId: r.lineId, amount: Math.round(r.amount * 100) / 100, description: r.description, note: r.memo ? `Statement category: ${r.memo}` : 'Imported from a statement', hasReceipt: false, receiptId: null, createdAt: now, updatedAt: now, sample: false, source: 'import' }));
      await DB.putEntries(entries);
      state.entries.push(...entries);
      for (const r of chosen) if (r.description) C.learn(state.settings.learned, r.description, r.lineId);
      if (I.map.headerRow && I.signature) {
        state.settings.importMappings = state.settings.importMappings || {};
        state.settings.importMappings[I.signature] = { map: { date: I.map.date, description: I.map.description, amount: I.map.amount, debit: I.map.debit, credit: I.map.credit, memo: I.map.memo, headerRow: true }, spendIsNegative: I.spendIsNegative };
      }
      await DB.saveSettings(state.settings);
      state.importer = null; state.captureMode = 'expense';
      toast(`Added ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} from the statement.`);
      go('ledger');
    };
  }

  // ---- calendar export --------------------------------------------------------------
  function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function icsText() {
    const adv = state.advice, year = Number(state.settings.taxYear), today = P.todayISO();
    const events = [];
    for (const r of adv.recurrences) for (const d of r.expected) if (d >= today) events.push({ date: d, summary: `${r.description} (${r.unit === 'miles' ? r.typicalAmount + ' mi' : money(r.typicalAmount)})`, desc: `Usually ${r.cadenceLabel}. Log it in Itemizer when paid.` });
    events.push({ date: `${year}-12-31`, summary: 'Last day for deductible payments this tax year', desc: `Property tax, gifts, and medical bills paid by today count for ${year}.` });
    if (state.computed.scheduleC.hasActivity || state.computed.lines['tax.state_income'].count) {
      [[`${year}-04-15`, 'Q1'], [`${year}-06-15`, 'Q2'], [`${year}-09-15`, 'Q3'], [`${year + 1}-01-15`, 'Q4']].forEach(([d, q]) => events.push({ date: d, summary: `Estimated tax payment ${q} due`, desc: 'Federal, and usually state, estimated payment. A state payment made by Dec 31 counts this year.' }));
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Itemizer//EN', 'CALSCALE:GREGORIAN'];
    events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).forEach((e, i) => {
      const d = e.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:itemizer-${d}-${i}@itemizer.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:${icsEscape(e.summary)}`, `DESCRIPTION:${icsEscape(e.desc)}`, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /** Due or overdue recurring payees, right where they get logged. */
  function captureAdviceHTML() {
    const adv = state.advice;
    if (!adv) return '';
    const due = adv.recommendations.filter((r) => r.kind === 'log' && r.action && r.action.type === 'prefill' && r.id.startsWith('recur:')).slice(0, 2);
    if (!due.length) return '';
    return `<section class="card advice-strip">
      <div class="card-head"><h2>Looks due</h2><a href="#advisor" class="small">All recommendations</a></div>
      <div class="advice-list">${due.map((r) => `<div class="advice-row"><div class="advice-text"><b>${esc(r.title)}</b><span class="muted small">${esc(r.because)}</span></div><div class="btn-row"><button class="btn btn-sm btn-primary" type="button" data-rec-act="go" data-rec="${esc(r.id)}">Log it</button><button class="btn btn-sm btn-ghost" type="button" data-rec-act="dismiss" data-rec="${esc(r.id)}">Dismiss</button></div></div>`).join('')}</div>
    </section>`;
  }

  async function handleRecAction(el) {
    const id = el.dataset.rec, act = el.dataset.recAct;
    const rec = state.advice && state.advice.recommendations.find((r) => r.id === id);
    if (!rec) return;
    if (act === 'dismiss') {
      state.settings.advisorDismissed = state.settings.advisorDismissed || {};
      state.settings.advisorDismissed[id] = P.todayISO();
      await DB.saveSettings(state.settings);
      toast('Dismissed for 30 days.');
      render();
      return;
    }
    const a = rec.action || {};
    if (a.type === 'prefill') prefillCapture(a.entry);
    else if (a.type === 'edit') openEdit(a.entryId);
    else if (a.type === 'ledger') { state.ledger.filter = a.filter || 'all'; go('ledger', a.filter ? { filter: a.filter } : null); }
    else if (a.type === 'capture') { go('capture'); setTimeout(() => { const q = $('#quickInput'); if (q) q.focus(); }, 50); }
    else if (a.type === 'settings') go('settings');
  }

  /** Start a capture with the fields already filled; the user reviews and saves. */
  function prefillCapture(entry) {
    const cap = freshCapture();
    cap.lineId = entry.lineId || null;
    cap.description = entry.description || '';
    cap.note = entry.note || '';
    cap.items = entry.items || null;
    cap.date = entry.date || todayInYear();
    const val = entry.amount === '' || entry.amount == null ? '' : String(entry.amount);
    if (cap.lineId && S.isMiles(cap.lineId)) cap.miles = val; else cap.amount = val;
    cap.dirty = true;
    ['line', 'description', 'date', 'amount'].forEach((k) => cap.pinned.add(k));
    cap.parsed = { raw: '', description: cap.description, miles: cap.lineId && S.isMiles(cap.lineId) ? Number(cap.miles) || null : null, amount: null, date: cap.date };
    state.capture = cap;
    reclassify();
    if (state.view === 'capture') { renderCapture(); window.scrollTo({ top: 0 }); const a = $('#fAmount'); if (a) a.focus(); }
    else go('capture');
    toast('Prefilled. Check it, then save.');
  }

  function onQuickChange() {
    const cap = state.capture;
    const parsed = P.parse(cap.text, { today: P.todayISO(), defaultYear: Number(state.settings.taxYear) });
    cap.parsed = parsed;
    if (!cap.pinned.has('amount')) { cap.amount = parsed.amount == null ? '' : String(parsed.amount); cap.miles = parsed.miles == null ? '' : String(parsed.miles); }
    if (!cap.pinned.has('date')) cap.date = parsed.date || todayInYear();
    if (!cap.pinned.has('description')) cap.description = parsed.description;
    reclassify();
    if (!cap.pinned.has('line')) {
      const top = cap.suggestions[0];
      cap.lineId = top && top.score >= 0.9 ? top.lineId : (top && cap.suggestions.length === 1 ? top.lineId : null);
      if (!cap.lineId && parsed.miles != null && top) cap.lineId = top.lineId;
    }
    const wasHidden = $('#understood').hidden;
    if (cap.text.trim()) $('#understood').hidden = false;
    // Update fields in place (don't re-render the input we're typing in).
    const milesMode = cap.lineId && S.isMiles(cap.lineId);
    $('#amountLabel').textContent = milesMode ? 'Miles' : 'Amount ($)';
    $('#fAmount').value = milesMode ? cap.miles : cap.amount;
    $('#fDate').value = cap.date;
    $('#fDesc').value = cap.description;
    $('#fLine').value = cap.lineId || '';
    refreshChips();
    $('#receiptRow').hidden = !!milesMode;
    if (wasHidden && !$('#understood').hidden) { /* first reveal: nothing else */ }
    updateSaveHint();
  }
  function reclassify() {
    const cap = state.capture;
    const textForClass = [cap.description, cap.parsed && cap.parsed.raw !== cap.description ? cap.text : ''].filter(Boolean).join(' ');
    const res = C.classify(textForClass, { learned: state.settings.learned, miles: cap.parsed ? cap.parsed.miles != null : false, limit: 4 });
    cap.suggestions = res.suggestions;
    cap.nonDeductible = res.nonDeductible;
  }
  function refreshChips() {
    const cap = state.capture;
    $('#chips').innerHTML = chipsHTML(cap);
    $('#lineHint').innerHTML = lineHintHTML(cap.lineId);
    const nd = $('#ndWarn');
    nd.hidden = !cap.nonDeductible.length;
    nd.innerHTML = cap.nonDeductible.map((n) => `<div><b>Probably not deductible.</b> ${esc(n.reason)}</div>`).join('');
  }
  function setCaptureLine(lineId) {
    const cap = state.capture;
    const wasMiles = cap.lineId && S.isMiles(cap.lineId);
    cap.lineId = lineId;
    cap.dirty = true;
    const isMiles = lineId && S.isMiles(lineId);
    if (isMiles && !wasMiles && !cap.miles && cap.amount && cap.parsed && cap.parsed.miles == null) { cap.miles = cap.amount; }
    $('#amountLabel').textContent = isMiles ? 'Miles' : 'Amount ($)';
    $('#fAmount').value = isMiles ? cap.miles : cap.amount;
    $('#fLine').value = lineId || '';
    $('#receiptRow').hidden = !!isMiles;
    refreshChips();
    updateSaveHint();
  }
  function captureProblems() {
    const cap = state.capture;
    const problems = [];
    if (!cap.lineId) problems.push('pick a worksheet line');
    const isMiles = cap.lineId && S.isMiles(cap.lineId);
    const val = Number(isMiles ? cap.miles : cap.amount);
    if (!(val > 0)) problems.push(isMiles ? 'enter the miles' : 'enter an amount');
    if (!cap.date || !/^\d{4}-\d{2}-\d{2}$/.test(cap.date)) problems.push('pick a date');
    return problems;
  }
  function updateSaveHint() {
    const hint = $('#saveHint'); if (!hint) return;
    const problems = captureProblems();
    const btn = $('#saveBtn');
    btn.disabled = problems.length > 0;
    if (problems.length) hint.textContent = 'To save: ' + problems.join(', ') + '.';
    else {
      const cap = state.capture;
      const y = Number(cap.date.slice(0, 4));
      hint.textContent = y !== Number(state.settings.taxYear) ? `Dated ${y} — it will file under tax year ${y}.` : '';
    }
  }

  function addMonths(isoDate, n) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const target = new Date(y, m - 1 + n, 1);
    const dim = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const day = Math.min(d, dim);
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  async function saveCapture() {
    const cap = state.capture;
    const problems = captureProblems();
    if (problems.length) { toast('To save: ' + problems.join(', ') + '.'); return; }
    const isMiles = S.isMiles(cap.lineId);
    const value = Number(isMiles ? cap.miles : cap.amount);
    const shareIn = Number(cap.share);
    const share = !isMiles && cap.share !== '' && shareIn > 0 && shareIn < 100 ? Math.round(shareIn) : 100;
    const saved = share < 100 ? Math.round(value * share) / 100 : value;
    const noteText = ((share < 100 ? `${share}% business share of ${moneyCents(value)}. ` : '') + cap.note.trim()).trim();
    const now = new Date().toISOString();
    const line = S.getLine(cap.lineId);
    const entries = [];
    let receiptId = null;
    if (!isMiles && cap.receiptBlob) {
      receiptId = DB.uid();
      try { await DB.putReceipt({ id: receiptId, entryId: null, type: cap.receiptBlob.type || 'image/jpeg', createdAt: now, blob: cap.receiptBlob }); }
      catch (e) { receiptId = null; toast(e.message || 'Could not store the receipt photo.'); }
    }
    for (let i = 0; i < Math.max(1, cap.repeat); i++) {
      const date = addMonths(cap.date, i);
      entries.push({
        id: DB.uid(), date, taxYear: Number(date.slice(0, 4)), lineId: cap.lineId, amount: Math.round(saved * 100) / 100,
        description: cap.description.trim(), note: noteText, hasReceipt: !isMiles && (cap.paper || (i === 0 && !!receiptId)), receiptId: i === 0 ? receiptId : null,
        createdAt: now, updatedAt: now, sample: false,
        fullAmount: share < 100 ? Math.round(value * 100) / 100 : null, share: share < 100 ? share : null,
        items: i === 0 ? (cap.items || null) : null,
      });
    }
    if (receiptId) { await DB.putReceipt({ id: receiptId, entryId: entries[0].id, type: cap.receiptBlob.type || 'image/jpeg', createdAt: now, blob: cap.receiptBlob }); }
    await DB.putEntries(entries);
    state.entries.push(...entries);
    if (cap.description.trim()) { C.learn(state.settings.learned, cap.description, cap.lineId); await DB.saveSettings(state.settings); }
    const fileYear = entries[0].taxYear;
    const label = isMiles ? fmtMiles(value) : moneyCents(saved);
    toast(`Saved ${label} → ${line.label}${entries.length > 1 ? ` × ${entries.length} months` : ''}${fileYear !== Number(state.settings.taxYear) ? ` (tax year ${fileYear})` : ''}`);
    if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL);
    state.capture = freshCapture();
    state.capture.date = todayInYear();
    renderCapture();
    $('#quickInput').focus();
  }

  async function onReceiptFile(file) {
    if (!file) return;
    let blob;
    try { blob = await shrinkImage(file); } catch (e) { toast('Could not read that image.'); return; }
    if (state.pendingReceiptTarget === 'capture') {
      const cap = state.capture;
      if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL);
      cap.receiptBlob = blob; cap.receiptURL = URL.createObjectURL(blob); cap.dirty = true;
      renderCapture();
      $('#understood').hidden = false;
      toast('Receipt attached — finish the details and save.');
    } else if (state.pendingReceiptTarget) {
      const entry = state.entries.find((e) => e.id === state.pendingReceiptTarget);
      if (!entry) return;
      const id = entry.receiptId || DB.uid();
      try {
        await DB.putReceipt({ id, entryId: entry.id, type: blob.type || 'image/jpeg', createdAt: new Date().toISOString(), blob });
        if (state.receiptURLs.has(id)) { URL.revokeObjectURL(state.receiptURLs.get(id)); state.receiptURLs.delete(id); }
        entry.receiptId = id; entry.hasReceipt = true; entry.updatedAt = new Date().toISOString();
        await DB.putEntry(entry);
        toast('Receipt attached.');
        openEdit(entry.id);
      } catch (e) { toast(e.message || 'Could not store the receipt.'); }
    }
    state.pendingReceiptTarget = null;
  }

  // =====================================================================
  // LEDGER
  // =====================================================================
  function renderLedger() {
    const R0 = state.computed;
    const L = state.ledger;
    const dupeIds = new Set(); R0.duplicates.forEach(([a, b]) => { dupeIds.add(a.id); dupeIds.add(b.id); });
    const noAck = new Set(R0.substantiation.giftsNoAck.map((e) => e.id));
    const noReceipt = new Set(R0.substantiation.missingReceipts.map((e) => e.id));
    const samples = yearEntries().filter((e) => e.sample);

    let list = yearEntries().slice();
    if (L.filter === 'noreceipt') list = list.filter((e) => noReceipt.has(e.id));
    if (L.filter === 'noack') list = list.filter((e) => noAck.has(e.id));
    if (L.filter === 'dupes') list = list.filter((e) => dupeIds.has(e.id));
    if (L.filter === 'samples') list = list.filter((e) => e.sample);
    if (L.section) list = list.filter((e) => S.getLine(e.lineId).sectionId === L.section);
    if (L.from) list = list.filter((e) => e.date >= L.from);
    if (L.to) list = list.filter((e) => e.date <= L.to);
    if (L.q.trim()) {
      const q = L.q.trim().toLowerCase();
      list = list.filter((e) => { const l = S.getLine(e.lineId); return [e.description, e.note, l.label, l.sectionTitle, String(e.amount)].join(' ').toLowerCase().includes(q); });
    }
    list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

    const totalUsd = list.filter((e) => !S.isMiles(e.lineId)).reduce((a, e) => a + Number(e.amount || 0), 0);
    const totalMiles = list.filter((e) => S.isMiles(e.lineId) && S.getLine(e.lineId).treatment !== 'info').reduce((a, e) => a + Number(e.amount || 0), 0);

    const groups = [];
    for (const e of list) {
      const key = e.date.slice(0, 7);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) { g = { key, entries: [], usd: 0 }; groups.push(g); }
      g.entries.push(e);
      if (!S.isMiles(e.lineId)) g.usd += Number(e.amount || 0);
    }
    const chip = (id, label, count) => `<button class="chip" type="button" data-filter="${id}" aria-pressed="${L.filter === id}">${esc(label)}${count != null ? ` <span class="count">${count}</span>` : ''}</button>`;

    $('#view-ledger').innerHTML = `
      <div class="card filters">
        <div class="filters-row">
          <input class="input" type="search" id="ledgerQ" placeholder="Search what, note, line…" value="${esc(L.q)}" aria-label="Search entries">
          <select id="ledgerSection" class="input" aria-label="Filter by section"><option value="">All sections</option>${S.SECTIONS.map((s) => `<option value="${s.id}" ${L.section === s.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>
        </div>
        <div class="filters-row">
          <label class="field" style="flex:1 1 140px"><span>From</span><input type="date" id="ledgerFrom" value="${esc(L.from || '')}"></label>
          <label class="field" style="flex:1 1 140px"><span>To</span><input type="date" id="ledgerTo" value="${esc(L.to || '')}"></label>
          ${L.from || L.to ? '<button class="btn btn-ghost btn-sm" type="button" id="ledgerClearDates" style="align-self:end">Clear dates</button>' : ''}
        </div>
        <div class="chips" id="ledgerChips">
          ${chip('all', 'All', yearEntries().length)}
          ${chip('noreceipt', 'No receipt', noReceipt.size)}
          ${chip('noack', 'Needs acknowledgment', noAck.size)}
          ${chip('dupes', 'Possible duplicates', dupeIds.size)}
          ${samples.length ? chip('samples', 'Examples', samples.length) : ''}
          <button class="chip" type="button" id="ledgerSelectToggle" aria-pressed="${L.selectMode}">${L.selectMode ? 'Done selecting' : 'Select'}</button>
        </div>
      </div>
      ${L.selectMode ? `<div class="card bulk-bar"><span><b>${L.selected.size}</b> selected</span><div class="btn-row">${lineSelectHTML('bulkLine', '')}<button class="btn btn-sm" type="button" id="bulkMove" ${L.selected.size ? '' : 'disabled'}>Move to line</button><button class="btn btn-sm" type="button" id="bulkPaper" ${L.selected.size ? '' : 'disabled'}>Mark paper receipt</button><button class="btn btn-sm btn-danger" type="button" id="bulkDelete" ${L.selected.size ? '' : 'disabled'}>Delete</button><button class="btn btn-sm btn-ghost" type="button" id="bulkAll">Select all shown</button></div></div>` : ''}
      <div class="ledger-summary"><span>${list.length} ${list.length === 1 ? 'entry' : 'entries'}${totalMiles ? ` · ${fmtMiles(totalMiles)}` : ''}</span><span class="num"><b>${moneyCents(totalUsd)}</b></span></div>
      <div class="card">
        ${list.length ? groups.map((g) => `<div class="month-head"><span>${esc(monthLabel(g.key))}</span><span class="num">${moneyCents(g.usd)}</span></div><div class="ledger-list">${g.entries.map((e) => entryRow(e, { dupes: dupeIds, select: L.selectMode, selected: L.selected })).join('')}</div>`).join('') : (yearEntries().length ? '<div class="empty"><h3>No entries match</h3><p>Try a different filter or search.</p></div>' : emptyStateHTML())}
      </div>
      <div class="btn-row">
        <button class="btn" type="button" id="csvBtn" ${yearEntries().length ? '' : 'disabled'}>Export ${R0.taxYear} as CSV</button>
        ${samples.length ? `<button class="btn btn-ghost" type="button" id="removeSamples">Remove ${samples.length} example entries</button>` : ''}
      </div>`;

    const root = $('#view-ledger');
    $('#ledgerQ').addEventListener('input', (ev) => { L.q = ev.target.value; renderLedger(); const q = $('#ledgerQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
    $('#ledgerSection').onchange = (ev) => { L.section = ev.target.value; renderLedger(); };
    $('#ledgerFrom').onchange = (ev) => { L.from = ev.target.value; renderLedger(); };
    $('#ledgerTo').onchange = (ev) => { L.to = ev.target.value; renderLedger(); };
    const cd = $('#ledgerClearDates'); if (cd) cd.onclick = () => { L.from = ''; L.to = ''; renderLedger(); };
    $('#ledgerChips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-filter]'); if (!b) return; L.filter = b.dataset.filter; renderLedger(); });
    $('#ledgerSelectToggle').onclick = () => { L.selectMode = !L.selectMode; L.selected.clear(); renderLedger(); };
    root.onclick = (ev) => { const b = ev.target.closest('[data-edit]'); if (b) openEdit(b.dataset.edit); };
    const updateBulkBar = () => { const bar = $('.bulk-bar'); if (!bar) return; bar.querySelector('b').textContent = String(L.selected.size); ['bulkMove', 'bulkPaper', 'bulkDelete'].forEach((id) => { const b = $('#' + id); if (b) b.disabled = !L.selected.size; }); };
    root.onchange = (ev) => { const cb = ev.target.closest('[data-sel]'); if (!cb) return; if (cb.checked) L.selected.add(cb.dataset.sel); else L.selected.delete(cb.dataset.sel); updateBulkBar(); };
    if (L.selectMode) {
      const chosen = () => list.filter((e) => L.selected.has(e.id));
      $('#bulkAll').onclick = () => { list.forEach((e) => L.selected.add(e.id)); renderLedger(); };
      $('#bulkMove').onclick = async () => {
        const lineId = $('#bulkLine').value; if (!lineId) { toast('Pick the line to move them to.'); return; }
        const moved = [], skipped = [];
        for (const e of chosen()) { if (S.isMiles(lineId) !== S.isMiles(e.lineId)) { skipped.push(e); continue; } e.lineId = lineId; e.updatedAt = new Date().toISOString(); moved.push(e); }
        if (moved.length) await DB.putEntries(moved);
        toast(`Moved ${moved.length} to ${S.getLine(lineId).label}${skipped.length ? `; ${skipped.length} skipped (miles and dollars cannot swap)` : ''}.`);
        L.selected.clear(); render();
      };
      $('#bulkPaper').onclick = async () => {
        const changed = chosen().filter((e) => !S.isMiles(e.lineId) && !e.hasReceipt);
        for (const e of changed) { e.hasReceipt = true; e.updatedAt = new Date().toISOString(); }
        if (changed.length) await DB.putEntries(changed);
        toast(`Marked ${changed.length} as having a paper receipt.`);
        L.selected.clear(); render();
      };
      $('#bulkDelete').onclick = async () => {
        const items = chosen(); if (!items.length) return;
        if (!(await confirmDialog(`Delete ${items.length} ${items.length === 1 ? 'entry' : 'entries'}?`, 'You can undo from the message that appears for a few seconds afterwards.', 'Delete', true))) return;
        L.selected.clear(); L.selectMode = false;
        await deleteWithUndo(items);
      };
    }
    $('#csvBtn').onclick = () => downloadText(`itemizer-${R0.taxYear}.csv`, DB.toCSV(yearEntries(), S), 'text/csv');
    const rs = $('#removeSamples'); if (rs) rs.onclick = removeSampleData;
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
  }
  function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return `${MONTHS_SHORT[m - 1]} ${y}`; }

  // Saving files: inside a claude.ai artifact the page asks the viewer through the
  // `downloads` capability; in an ordinary browser it uses a download link; where
  // neither works the text is shown so it can be copied out.
  let downloadsCap; // undefined until resolved; then the namespace or null
  async function getDownloads() {
    if (downloadsCap !== undefined) return downloadsCap;
    try { downloadsCap = (globalThis.claude && typeof globalThis.claude.use === 'function') ? await globalThis.claude.use('downloads') : null; }
    catch (e) { downloadsCap = null; }
    return downloadsCap;
  }
  function showTextForCopy(filename, text) {
    openModal(`<div class="card-head"><h2>${esc(filename)}</h2><button class="btn btn-sm" type="button" id="copyText">Copy</button></div><p class="note">Saving files is not available here. Select all and copy, then paste into a file named <b>${esc(filename)}</b>.</p><textarea class="input" id="copyArea" style="min-height:45vh;font-family:var(--font-mono);font-size:.78rem" readonly>${esc(text)}</textarea><div class="modal-actions"><span class="spacer"></span><button class="btn" type="button" data-close="1">Close</button></div>`, (panel) => {
      panel.querySelector('[data-close]').onclick = closeModal;
      panel.querySelector('#copyArea').select();
      panel.querySelector('#copyText').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch (e) { panel.querySelector('#copyArea').select(); toast('Select the text and copy it.'); } };
    });
  }
  async function downloadText(filename, text, type) {
    const dl = await getDownloads();
    if (dl) {
      try { await dl.save({ filename, data: text }); toast(`Saved ${filename}`); }
      catch (e) {
        const code = e && e.code;
        if (code === 'declined') return;
        if (code === 'rate_limited') { toast('A save prompt is already open — answer it first.'); return; }
        showTextForCopy(filename, text);
      }
      return;
    }
    if (globalThis.claude) { showTextForCopy(filename, text); return; } // framed by a host that grants no saves
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloading ${filename}`);
  }

  /** Delete entries (and their receipt photos) with a few seconds to undo. */
  async function deleteWithUndo(entries) {
    const list = entries.slice();
    const receipts = [];
    for (const e of list) if (e.receiptId) { try { const r = await DB.getReceipt(e.receiptId); if (r) receipts.push(r); } catch (err) { /* photo unavailable */ } }
    await DB.deleteEntries(list.map((e) => e.id));
    const ids = new Set(list.map((e) => e.id));
    state.entries = state.entries.filter((x) => !ids.has(x.id));
    for (const e of list) if (e.receiptId && state.receiptURLs.has(e.receiptId)) { URL.revokeObjectURL(state.receiptURLs.get(e.receiptId)); state.receiptURLs.delete(e.receiptId); }
    render();
    const what = list.length === 1 ? (list[0].description || S.getLine(list[0].lineId).label) : `${list.length} entries`;
    toast(`Deleted ${what}.`, 8000, { label: 'Undo', onClick: async () => {
      for (const r of receipts) { try { await DB.putReceipt(r); } catch (err) { /* photo could not be restored */ } }
      await DB.putEntries(list);
      state.entries.push(...list);
      render();
      toast('Restored.');
    } });
  }

  // ---- edit sheet -----------------------------------------------------------
  async function openEdit(id) {
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    const line = S.getLine(e.lineId);
    const isMiles = S.isMiles(e.lineId);
    const url = await receiptURL(e.receiptId);
    openModal(`
      <div class="card-head"><h2>Edit entry</h2><span class="pill pill-accent">${esc(line.sectionTitle)}</span></div>
      <div class="grid-2">
        <label class="field"><span id="eAmountLabel">${isMiles ? 'Miles' : 'Amount ($)'}</span><input id="eAmount" inputmode="decimal" value="${esc(e.amount)}"></label>
        <label class="field"><span>Date</span><input id="eDate" type="date" value="${esc(e.date)}"></label>
        <label class="field span-2"><span>What / who</span><input id="eDesc" value="${esc(e.description)}"></label>
        <div class="field span-2"><span>Worksheet line</span>${lineSelectHTML('eLine', e.lineId)}<div class="line-hint" id="eHint">${lineHintHTML(e.lineId)}</div></div>
        <label class="field span-2"><span>Note</span><textarea id="eNote">${esc(e.note)}</textarea></label>
        ${e.items && e.items.length ? `<div class="field span-2"><span>Itemized donation record</span><div class="note small" style="white-space:pre-line">${esc(VAL.recordText(e.items, String(e.description || '').split(' — ')[0], e.date))}</div></div>` : ''}
      </div>
      <div class="receipt-row" id="eReceiptRow" ${isMiles ? 'hidden' : ''}>
        ${url ? `<img class="receipt-thumb" id="eThumb" src="${url}" alt="Receipt"><button class="btn btn-sm" type="button" id="eReplace">Replace photo</button><button class="btn btn-ghost btn-sm" type="button" id="eRemovePhoto">Remove photo</button>` : `<button class="btn" type="button" id="eAttach">${ICON.camera} Attach receipt</button>`}
        <label class="check"><input type="checkbox" id="ePaper" ${e.hasReceipt && !e.receiptId ? 'checked' : ''} ${e.receiptId ? 'disabled' : ''}> Paper receipt filed</label>
      </div>
      <div class="modal-actions">
        <button class="btn btn-danger" type="button" id="eDelete">Delete</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-close="1">Cancel</button>
        <button class="btn btn-primary" type="button" id="eSave">Save changes</button>
      </div>`, (panel) => {
      panel.querySelector('[data-close]').onclick = closeModal;
      const lineSel = panel.querySelector('#eLine');
      lineSel.onchange = () => { const m = S.isMiles(lineSel.value); panel.querySelector('#eAmountLabel').textContent = m ? 'Miles' : 'Amount ($)'; panel.querySelector('#eReceiptRow').hidden = m; panel.querySelector('#eHint').innerHTML = lineHintHTML(lineSel.value); };
      const thumb = panel.querySelector('#eThumb'); if (thumb) thumb.onclick = () => viewReceipt(url, e.description || line.label);
      const attach = panel.querySelector('#eAttach') || panel.querySelector('#eReplace');
      if (attach) attach.onclick = () => { state.pendingReceiptTarget = e.id; closeModal(); $('#receiptInput').click(); };
      const rm = panel.querySelector('#eRemovePhoto');
      if (rm) rm.onclick = async () => { await DB.deleteReceipt(e.receiptId); if (state.receiptURLs.has(e.receiptId)) { URL.revokeObjectURL(state.receiptURLs.get(e.receiptId)); state.receiptURLs.delete(e.receiptId); } e.receiptId = null; e.hasReceipt = false; e.updatedAt = new Date().toISOString(); await DB.putEntry(e); toast('Photo removed.'); openEdit(e.id); };
      panel.querySelector('#eDelete').onclick = async () => {
        closeModal();
        if (!(await confirmDialog('Delete this entry?', `${e.description || line.label} · ${fmtAmount(e)} on ${P.formatDate(e.date)}. This cannot be undone.`, 'Delete', true))) return;
        await deleteWithUndo([e]);
      };
      panel.querySelector('#eSave').onclick = async () => {
        const newLine = lineSel.value;
        const val = Number(panel.querySelector('#eAmount').value);
        const date = panel.querySelector('#eDate').value;
        if (!newLine || !(val > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Line, amount, and date are all required.'); return; }
        const desc = panel.querySelector('#eDesc').value.trim();
        e.lineId = newLine; e.amount = Math.round(val * 100) / 100; e.date = date; e.taxYear = Number(date.slice(0, 4));
        e.description = desc; e.note = panel.querySelector('#eNote').value.trim();
        if (!e.receiptId) e.hasReceipt = panel.querySelector('#ePaper').checked;
        if (S.isMiles(newLine)) { e.hasReceipt = false; }
        e.updatedAt = new Date().toISOString();
        await DB.putEntry(e);
        if (desc) { C.learn(state.settings.learned, desc, newLine); await DB.saveSettings(state.settings); }
        closeModal();
        toast('Saved.');
        render();
      };
    });
  }

  // =====================================================================
  // INSIGHTS
  // =====================================================================
  function renderInsights() {
    const R0 = state.computed;
    const A = R0.scheduleA, SD = R0.standardDeduction, V = R0.verdict, C0 = R0.scheduleC, SUB = R0.substantiation;
    const filing = R.FILING_STATUSES.find((f) => f.id === R0.filingStatus);
    const hero = V.itemize ? `${money(V.difference)} <small>above the standard deduction</small>` : `${money(-V.difference)} <small>more to make itemizing pay</small>`;
    const kicker = `<span class="pill pill-accent">Tax year ${R0.taxYear}</span><span class="pill pill-info">${esc(filing ? filing.label : '')}</span>${R0.agi == null ? '<span class="pill pill-act">AGI not set</span>' : `<span class="pill pill-info">AGI ${money(R0.agi)}</span>`}`;

    const sectionRows = S.SECTIONS.filter((s) => R0.sections[s.id].count > 0).map((s) => {
      const sec = R0.sections[s.id];
      const counts = countedFor(s.id);
      return { id: s.id, title: s.title, gross: sec.value, counts, note: countedNote(s.id) };
    });
    const maxGross = Math.max(1, ...sectionRows.map((r) => r.gross));

    const months = R0.months;
    const maxMonth = Math.max(...months, 0);
    const maxIdx = months.indexOf(maxMonth);
    const nowMonth = new Date().getFullYear() === R0.taxYear ? new Date().getMonth() : -1;

    $('#view-insights').innerHTML = `
      <section class="card verdict">
        <div class="verdict-kicker">${kicker}</div>
        <h2 class="verdict-title">${V.itemize ? 'Itemizing wins' : 'The standard deduction still wins'}</h2>
        <div class="hero">${hero}</div>
        <p class="verdict-note">${money(A.grossEntered)} entered on the worksheet · ${money(A.total)} counts after the medical floor, the state-and-local-tax cap, and gift limits · ${money(SD.total)} standard deduction${SD.conditions.length ? ` (includes ${money(SD.additional)} because ${esc(SD.conditions.join(' and '))})` : ''}.${V.medicalPending ? ' Medical expenses are waiting on your AGI.' : ''}</p>
        ${meterHTML('')}
      </section>

      <div class="kpis">
        ${kpi('Schedule A after limits', money(A.total), `${money(A.grossEntered)} entered`)}
        ${kpi('Schedule C business', money(C0.total), C0.hasActivity ? (C0.vehicle.miles ? `${fmtMiles(C0.vehicle.miles)} at ${R.perMile(R0.params.mileage.business)}` : 'meals counted at 50%') : 'no business entries')}
        ${kpi('Above the line', money(R0.adjustments.studentLoanInterest.deductible), 'student loan interest, no itemizing needed')}
        ${kpi('Receipts on file', `${Math.round(SUB.coverage * 100)}%`, `${SUB.withReceipt} of ${SUB.usdEntries} dollar entries`)}
      </div>

      <section>
        <div class="card-head"><h2>What to do about it</h2><span class="muted small">${R0.insights.length} notes</span></div>
        <div class="feed">${R0.insights.map(insightHTML).join('')}</div>
      </section>

      ${sectionRows.length ? `<section class="card">
        <div class="card-head"><h2>By section</h2><span class="muted small">entered vs. counts on the return</span></div>
        <div class="bars">${sectionRows.map((r) => `<div class="bar-row"><div class="bar-label">${esc(r.title)}<small>${esc(r.note)}</small></div><div class="bar-track" data-tip="${esc(`${money(r.gross)} entered · ${r.counts == null ? 'pending AGI' : money(r.counts) + ' counts'}`)}" tabindex="0"><div class="bar-gross" style="width:${(r.gross / maxGross * 100).toFixed(1)}%"></div>${r.counts != null ? `<div class="bar-counts" style="width:${(Math.min(r.counts, r.gross) / maxGross * 100).toFixed(1)}%"></div>` : ''}<div class="bar-value" style="left:${(r.gross / maxGross * 100).toFixed(1)}%">${money(r.gross)}</div></div></div>`).join('')}</div>
        <div class="bar-legend"><span><span class="legend-dot" style="background:var(--accent)"></span>Counts on the return</span><span><span class="legend-dot" style="background:var(--accent-soft)"></span>Entered on the worksheet</span></div>
      </section>` : ''}

      ${yoyHTML()}

      ${R0.entries.length ? `<section class="card">
        <div class="card-head"><h2>Month by month</h2><button class="btn btn-ghost btn-sm" type="button" id="toggleMonthsTable">${state.showMonthsTable ? 'Show chart' : 'Show as table'}</button></div>
        ${state.showMonthsTable ? `<table class="table-twin"><thead><tr><th>Month</th><th class="num">Logged (dollar value)</th></tr></thead><tbody>${months.map((v, i) => `<tr><td>${MONTHS_SHORT[i]} ${R0.taxYear}</td><td class="num">${moneyCents(v)}</td></tr>`).join('')}</tbody></table>` : `
        <div class="months" role="img" aria-label="Dollar value logged per month">${months.map((v, i) => `<button class="month-col ${i === nowMonth ? 'is-current' : ''} ${i === maxIdx && maxMonth > 0 ? 'is-max' : ''}" type="button" data-tip="${esc(`${MONTHS_SHORT[i]}: ${money(v)}`)}" aria-label="${esc(`${MONTHS_SHORT[i]}: ${money(v)}`)}">${i === maxIdx && maxMonth > 0 ? `<span class="month-value">${money(v)}</span>` : ''}<div class="month-bar" style="height:${maxMonth ? Math.max(2, v / maxMonth * 100) : 2}%"></div></button>`).join('')}</div>
        <div class="month-axis">${MONTHS_SHORT.map((m) => `<span>${m[0]}</span>`).join('')}</div>`}
        <p class="note" style="margin-top:10px">Miles are shown at their dollar value. ${nowMonth >= 0 ? 'The current month is highlighted.' : ''}</p>
      </section>` : ''}

      <div class="two-col">
        <section class="card">
          <div class="card-head"><h3>Schedule A detail</h3></div>
          <dl class="dl">
            <dt>Medical, after ${R.pct(R0.params.medicalFloorRate)} floor</dt><dd>${A.medical.deductible == null ? (A.medical.gross ? 'needs AGI' : money(0)) : money(A.medical.deductible)}</dd>
            <dt>State &amp; local taxes, capped</dt><dd>${money(A.taxes.deductible)}</dd>
            <dt>Interest</dt><dd>${money(A.interest.total)}</dd>
            <dt>Gifts to charity${A.charity.floor ? ' (after floor)' : ''}</dt><dd>${money(A.charity.deductible)}</dd>
            <dt>Gambling losses (to winnings)</dt><dd>${money(A.other.deductible)}</dd>
            <dt>Casualty (federal disaster)</dt><dd>${money(A.casualty.deductible)}</dd>
            <div class="total" style="display:contents"><dt>Itemized total</dt><dd>${money(A.total)}</dd></div>
            <dt>Standard deduction</dt><dd>${money(SD.total)}</dd>
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h3>Outside Schedule A</h3></div>
          <dl class="dl">
            <dt>Schedule C expenses</dt><dd>${money(C0.otherExpenses)}</dd>
            <dt>Business meals (${R.pct(C0.meals.rate)} of ${money(C0.meals.paid)})</dt><dd>${money(C0.meals.deductible)}</dd>
            <dt>Vehicle — standard mileage</dt><dd>${money(C0.vehicle.milesValue)}</dd>
            <dt>Vehicle — actual expenses</dt><dd>${money(C0.vehicle.actual)}</dd>
            ${C0.vehicle.businessUseShare != null ? `<dt>Business-use share</dt><dd>${Math.round(C0.vehicle.businessUseShare * 100)}%</dd>` : ''}
            <div class="total" style="display:contents"><dt>Schedule C total</dt><dd>${money(C0.total)}</dd></div>
            <dt>Student loan interest (adjustment)</dt><dd>${money(R0.adjustments.studentLoanInterest.deductible)}</dd>
            <dt>Education costs (for credits)</dt><dd>${money(R0.credits.educationCosts)}</dd>
          </dl>
        </section>
      </div>`;

    const tg = $('#toggleMonthsTable'); if (tg) tg.onclick = () => { state.showMonthsTable = !state.showMonthsTable; renderInsights(); };
    $('#view-insights').addEventListener('click', (ev) => {
      const go1 = ev.target.closest('[data-go]');
      if (go1) { ev.preventDefault(); const [view, filter] = go1.dataset.go.split(':'); if (filter) state.ledger.filter = filter; go(view, filter ? { filter } : null); }
    });
  }
  function yoyHTML() {
    const R0 = state.computed;
    const prevYear = R0.taxYear - 1;
    if (!state.entries.some((e) => R.taxYearOf(e) === prevYear)) return '';
    const prev = R.compute(state.entries, Object.assign({}, state.settings, { taxYear: prevYear, today: P.todayISO() }));
    const rows = S.SECTIONS.filter((s) => R0.sections[s.id].count || prev.sections[s.id].count).map((s) => ({ title: s.title, now: R0.sections[s.id].value, before: prev.sections[s.id].value }));
    const delta = (a, b) => { const d = Math.round((a - b) * 100) / 100; return `<span class="${d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : ''}">${d > 0 ? '+' : ''}${money(d)}</span>`; };
    return `<section class="card">
        <div class="card-head"><h2>Compared with ${prevYear}</h2><span class="muted small">dollar value by section</span></div>
        <div class="table-wrap"><table class="table-twin yoy"><thead><tr><th>Section</th><th class="num">${prevYear}</th><th class="num">${R0.taxYear}</th><th class="num">Change</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td>${esc(r.title)}</td><td class="num">${money(r.before)}</td><td class="num">${money(r.now)}</td><td class="num">${delta(r.now, r.before)}</td></tr>`).join('')}
          <tr class="total"><td><b>Schedule A after limits</b></td><td class="num">${money(prev.scheduleA.total)}</td><td class="num">${money(R0.scheduleA.total)}</td><td class="num">${delta(R0.scheduleA.total, prev.scheduleA.total)}</td></tr>
          ${R0.scheduleC.hasActivity || prev.scheduleC.hasActivity ? `<tr class="total"><td><b>Schedule C</b></td><td class="num">${money(prev.scheduleC.total)}</td><td class="num">${money(R0.scheduleC.total)}</td><td class="num">${delta(R0.scheduleC.total, prev.scheduleC.total)}</td></tr>` : ''}
        </tbody></table></div>
        ${new Date().getFullYear() === R0.taxYear ? `<p class="note" style="margin-top:8px">${R0.taxYear} is still in progress, so a lower figure may only mean the year is not over yet.</p>` : ''}
      </section>`;
  }
  function kpi(label, value, sub) { return `<div class="card kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-sub">${esc(sub)}</div></div>`; }
  function insightHTML(i) {
    const goLabel = { settings: 'Open settings', ledger: 'Open ledger', capture: 'Log it', insights: '' }[i.view] || '';
    return `<article class="insight insight-${i.level}"><div class="insight-stripe"></div><div class="insight-body"><div class="insight-top"><span class="pill pill-${i.level}">${LEVEL_LABEL[i.level]}</span><h3>${esc(i.title)}</h3></div><p>${esc(i.body)}</p>${goLabel ? `<a class="go" href="#${i.view}" data-go="${i.view}${i.filter ? ':' + i.filter : ''}">${goLabel} →</a>` : ''}</div></article>`;
  }
  function countedFor(sectionId) {
    const A = state.computed.scheduleA, R0 = state.computed;
    switch (sectionId) {
      case 'medical': return A.medical.deductible;
      case 'taxes': return A.taxes.deductible;
      case 'interest': return A.interest.total;
      case 'charity': return Math.max(0, A.charity.cash + A.charity.noncash - (A.charity.floor || 0));
      case 'volunteer': return A.charity.volunteer;
      case 'other': return A.other.deductible;
      case 'casualty': return A.casualty.deductible;
      case 'selfemp': return R0.scheduleC.total;
      case 'education': return R0.adjustments.studentLoanInterest.deductible;
      default: return 0;
    }
  }
  function countedNote(sectionId) {
    const A = state.computed.scheduleA;
    switch (sectionId) {
      case 'medical': return A.medical.deductible == null ? 'pending AGI' : `above ${money(A.medical.floor)} floor`;
      case 'taxes': return A.taxes.excess ? `${money(A.taxes.excess)} over the cap` : `cap ${money(A.taxes.cap)}`;
      case 'selfemp': return 'Schedule C, not itemized';
      case 'education': return 'loan interest counts; tuition → credits';
      case 'other': return A.other.gamblingWinnings ? `to ${money(A.other.gamblingWinnings)} winnings` : 'needs winnings';
      case 'casualty': return A.casualty.federalDisaster ? 'federal disaster' : 'not a federal disaster';
      case 'charity': return A.charity.floor ? `after ${money(A.charity.floor)} floor` : 'Schedule A';
      case 'volunteer': return 'counts as gifts';
      default: return 'Schedule A';
    }
  }

  // =====================================================================
  // WORKSHEET — a filled-in replica of the paper organizer
  // =====================================================================
  function renderWorksheet() {
    const R0 = state.computed;
    const P0 = R0.params;
    const filing = R.FILING_STATUSES.find((f) => f.id === R0.filingStatus);
    const prepared = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const lineRow = (l) => {
      const L = R0.lines[l.id];
      const has = L.count > 0;
      let amt = '$';
      if (has) {
        if (l.unit === 'miles') amt = `<span class="mi">${esc(fmtMiles(L.total))}</span>${l.treatment === 'info' ? '' : esc(moneyCents(L.total * (P0.mileage[l.rate] || 0)))}`;
        else amt = esc(moneyCents(L.total));
      }
      return `<div class="sheet-line ${has ? '' : 'is-zero'}"><div class="lbl"><span>${esc(l.label)}</span><span class="leader"></span></div><span class="amt ${has ? '' : 'blank'}">${amt}</span></div>`;
    };
    const sectionHTML = (sec) => {
      const lines = S.linesForSection(sec.id);
      let html = `<div class="sheet-section"><h3>${esc(sec.title)}</h3>`;
      let group = null;
      for (const l of lines) {
        if (l.group !== group) { group = l.group; if (group) html += `<div class="sheet-group">${esc(group)}</div>`; }
        html += lineRow(l);
        if (l.id === 'int.individual' && R0.lines[l.id].count) {
          for (const e of R0.lines[l.id].entries) html += `<div class="sheet-line"><div class="lbl"><span>Name / Address: ${esc(e.description || '—')}${e.note ? ' · ' + esc(e.note) : ''}</span></div><span></span></div>`;
        }
      }
      const secTotal = R0.sections[sec.id];
      if (secTotal.count) html += `<div class="sheet-line"><div class="lbl"><span><i>Section total</i></span><span class="leader"></span></div><span class="amt"><b>${esc(moneyCents(secTotal.value))}</b></span></div>`;
      html += '</div>';
      return html;
    };
    const left = S.SECTIONS.filter((s) => s.column === 'left').map(sectionHTML).join('');
    const right = S.SECTIONS.filter((s) => s.column === 'right').map(sectionHTML).join('');

    const notes = [];
    for (const i of R0.insights.filter((x) => x.level === 'act' || x.level === 'warn')) notes.push(`${i.title}. ${i.body.split(/(?<=\.)\s/)[0]}`);
    if (R0.scheduleA.other.gamblingLosses) notes.push(`Gambling winnings reported by taxpayer: ${money(R0.scheduleA.other.gamblingWinnings)}.`);
    if (R0.scheduleA.casualty.gross) notes.push(`Casualty loss ${R0.scheduleA.casualty.federalDisaster ? 'IS' : 'is NOT'} marked as a federally declared disaster${state.settings.disasterNumber ? ` (FEMA ${state.settings.disasterNumber})` : ''}.`);
    const tripCount = state.trips.filter((t) => Number(t.taxYear) === R0.taxYear).length;
    if (tripCount) notes.push(`Mileage log: ${tripCount} ${tripCount === 1 ? 'trip' : 'trips'} with date, destination, purpose, and miles (export from Capture → Trip).`);
    if (R0.scheduleC.hasActivity && R0.scheduleC.vehicle.totalMiles) notes.push(`Vehicle: ${fmtMiles(R0.scheduleC.vehicle.miles)} business of ${fmtMiles(R0.scheduleC.vehicle.totalMiles)} total (${Math.round((R0.scheduleC.vehicle.businessUseShare || 0) * 100)}% business use).`);
    const SUB = R0.substantiation;

    $('#view-worksheet').innerHTML = `
      <div class="sheet-tools">
        <p class="note">This is the organizer sheet, filled in from your ledger. Print it or save it as a PDF for your preparer.</p>
        <div class="btn-row"><button class="btn" type="button" id="copySummary">Copy as text</button><button class="btn" type="button" id="receiptsToggle" aria-pressed="${state.showReceiptSheet}">${state.showReceiptSheet ? 'Hide receipts' : 'Receipts sheet'}</button>${state.showReceiptSheet ? `<button class="btn" type="button" id="printReceipts">${ICON.print} Print receipts</button>` : ''}<button class="btn btn-primary" type="button" id="printBtn">${ICON.print} Print / Save PDF</button></div>
      </div>
      <article class="sheet" id="sheet">
        <div class="sheet-bar">Keep track of your expenses</div>
        <p class="sheet-sub">List amounts for items you have. Save receipts for your deductions.</p>
        <div class="sheet-meta">
          <span><b>Tax year</b> ${R0.taxYear}</span>
          <span><b>Filing status</b> ${esc(filing ? filing.label : '')}</span>
          <span><b>Est. AGI</b> ${R0.agi == null ? 'not provided' : money(R0.agi)}</span>
          ${state.settings.state ? `<span><b>State</b> ${esc(state.settings.state)}${state.settings.county ? ', ' + esc(state.settings.county) : ''}</span>` : ''}
          <span><b>Entries</b> ${R0.entries.length}</span>
          <span><b>Receipts</b> ${SUB.withReceipt} of ${SUB.usdEntries} dollar entries</span>
          <span><b>Prepared</b> ${esc(prepared)}</span>
        </div>
        <div class="sheet-cols"><div>${left}</div><div>${right}</div></div>
        <div class="sheet-totals">
          <span>Schedule A items entered</span><span class="num">${esc(moneyCents(R0.scheduleA.grossEntered))}</span>
          <span>Counts after medical floor, tax cap, and gift limits</span><span class="num">${esc(moneyCents(R0.scheduleA.total))}</span>
          <span>Standard deduction (${esc(filing ? filing.label : '')}${R0.standardDeduction.conditions.length ? ', with age/blind additions' : ''})</span><span class="num">${esc(moneyCents(R0.standardDeduction.total))}</span>
          <span class="big">${R0.verdict.itemize ? 'Itemizing appears to win by' : 'Standard deduction appears to win by'}</span><span class="num big">${esc(moneyCents(Math.abs(R0.verdict.difference)))}</span>
          ${R0.scheduleC.hasActivity ? `<span>Schedule C expenses (business, not itemized)</span><span class="num">${esc(moneyCents(R0.scheduleC.total))}</span>` : ''}
          ${R0.adjustments.studentLoanInterest.paid ? `<span>Student loan interest (adjustment to income)</span><span class="num">${esc(moneyCents(R0.adjustments.studentLoanInterest.deductible))}</span>` : ''}
        </div>
        ${notes.length ? `<div class="sheet-notes"><h3>Notes for the preparer</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
        <p class="sheet-foot">Prepared with Itemizer from the taxpayer's own records. Totals are planning figures using ${R0.params.baseYear} IRS thresholds${R0.params.isFallback ? ` (no ${R0.taxYear} figures loaded)` : ''}; the preparer should verify eligibility and limits against source documents.</p>
      </article>
      ${state.showReceiptSheet ? receiptSheetHTML() : ''}`;

    $('#printBtn').onclick = () => window.print();
    $('#receiptsToggle').onclick = () => { state.showReceiptSheet = !state.showReceiptSheet; renderWorksheet(); if (state.showReceiptSheet) { const el = $('#receiptSheet'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
    const pr = $('#printReceipts');
    if (pr) pr.onclick = () => { document.body.classList.add('print-receipts'); const done = () => { document.body.classList.remove('print-receipts'); window.removeEventListener('afterprint', done); }; window.addEventListener('afterprint', done); window.print(); };
    if (state.showReceiptSheet) fillReceiptImages();
    $('#copySummary').onclick = async () => {
      const text = worksheetText();
      try { await navigator.clipboard.writeText(text); toast('Worksheet copied as text.'); }
      catch (e) { openModal(`<h2>Worksheet as text</h2><textarea class="input" style="min-height:50vh;font-family:var(--font-mono);font-size:.8rem" readonly>${esc(text)}</textarea><div class="modal-actions"><span class="spacer"></span><button class="btn" data-close="1">Close</button></div>`, (p) => { p.querySelector('[data-close]').onclick = closeModal; p.querySelector('textarea').select(); }); }
    };
  }

  /** A printable contact sheet of every receipt photo, plus the paper receipts on file. */
  function receiptSheetHTML() {
    const R0 = state.computed;
    const withPhoto = yearEntries().filter((e) => e.receiptId).sort((a, b) => a.date.localeCompare(b.date));
    const paper = yearEntries().filter((e) => e.hasReceipt && !e.receiptId && !S.isMiles(e.lineId)).sort((a, b) => a.date.localeCompare(b.date));
    const groups = new Map();
    for (const e of withPhoto) { const l = S.getLine(e.lineId); if (!groups.has(l.sectionTitle)) groups.set(l.sectionTitle, []); groups.get(l.sectionTitle).push(e); }
    const prepared = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return `<article class="sheet receipt-sheet" id="receiptSheet">
      <div class="sheet-bar">Receipts — tax year ${R0.taxYear}</div>
      <p class="sheet-sub">${withPhoto.length} receipt ${withPhoto.length === 1 ? 'photo' : 'photos'} attached to entries and ${paper.length} paper ${paper.length === 1 ? 'receipt' : 'receipts'} on file. Prepared ${esc(prepared)}.</p>
      ${[...groups.entries()].map(([title, list]) => `<h3 class="receipt-group">${esc(title)}</h3><div class="receipt-grid">${list.map((e) => `<figure class="receipt-fig"><img data-receipt="${esc(e.receiptId)}" alt="Receipt for ${esc(e.description || S.getLine(e.lineId).label)}"><figcaption><b>${esc(P.formatDate(e.date))}</b> · ${esc(moneyCents(e.amount))}<br>${esc(e.description || '')}<br><span class="muted">${esc(S.getLine(e.lineId).label)}</span></figcaption></figure>`).join('')}</div>`).join('')}
      ${paper.length ? `<h3 class="receipt-group">Paper receipts on file</h3><table class="table-twin"><thead><tr><th>Date</th><th>Payee</th><th>Line</th><th class="num">Amount</th></tr></thead><tbody>${paper.map((e) => `<tr><td>${esc(P.formatDate(e.date, false))}</td><td>${esc(e.description || '')}</td><td>${esc(S.getLine(e.lineId).label)}</td><td class="num">${esc(moneyCents(e.amount))}</td></tr>`).join('')}</tbody></table>` : ''}
      ${!withPhoto.length && !paper.length ? '<p class="note">No receipts yet. Attach photos from Capture or the ledger, or tick "paper receipt filed" on an entry.</p>' : ''}
    </article>`;
  }
  async function fillReceiptImages() {
    for (const img of $$('#receiptSheet img[data-receipt]')) { const url = await receiptURL(img.dataset.receipt); if (url) img.src = url; }
  }

  function worksheetText() {
    const R0 = state.computed, P0 = R0.params;
    const filing = R.FILING_STATUSES.find((f) => f.id === R0.filingStatus);
    const pad = (a, b, w) => { const dots = Math.max(2, w - a.length - b.length); return a + ' ' + '.'.repeat(dots) + ' ' + b; };
    const out = [`KEEP TRACK OF YOUR EXPENSES — tax year ${R0.taxYear}`, `Filing: ${filing ? filing.label : ''} · Est. AGI: ${R0.agi == null ? 'n/a' : money(R0.agi)} · Prepared ${P.formatDate(P.todayISO())}`, ''];
    for (const sec of S.SECTIONS) {
      const lines = S.linesForSection(sec.id).filter((l) => R0.lines[l.id].count);
      if (!lines.length) continue;
      out.push(sec.title.toUpperCase());
      for (const l of lines) {
        const L = R0.lines[l.id];
        const v = l.unit === 'miles' ? `${fmtMiles(L.total)}${l.treatment === 'info' ? '' : ' = ' + moneyCents(L.total * (P0.mileage[l.rate] || 0))}` : moneyCents(L.total);
        out.push('  ' + pad(l.label, v, 58));
      }
      out.push('  ' + pad('Section total', moneyCents(R0.sections[sec.id].value), 58), '');
    }
    out.push(pad('Schedule A entered', moneyCents(R0.scheduleA.grossEntered), 60));
    out.push(pad('Counts after floors and caps', moneyCents(R0.scheduleA.total), 60));
    out.push(pad('Standard deduction', moneyCents(R0.standardDeduction.total), 60));
    out.push(pad(R0.verdict.itemize ? 'Itemizing wins by' : 'Standard deduction wins by', moneyCents(Math.abs(R0.verdict.difference)), 60));
    if (R0.scheduleC.hasActivity) out.push(pad('Schedule C expenses', moneyCents(R0.scheduleC.total), 60));
    if (R0.adjustments.studentLoanInterest.paid) out.push(pad('Student loan interest (adjustment)', moneyCents(R0.adjustments.studentLoanInterest.deductible), 60));
    const flags = R0.insights.filter((i) => i.level === 'act' || i.level === 'warn');
    if (flags.length) { out.push('', 'NOTES FOR THE PREPARER'); flags.forEach((i) => out.push('  • ' + i.title)); }
    return out.join('\n');
  }

  // =====================================================================
  // ADVISOR — recommendations from your own ledger
  // =====================================================================
  function renderAdvisor() {
    const adv = state.advice;
    const R0 = state.computed;
    const pr = adv.projection;
    const max = Math.max(pr.projectedTotal, pr.standardDeduction) * 1.12 || 1;
    const pct = (v) => (Math.max(0, v) / max * 100).toFixed(2) + '%';
    const KIND = { log: ['act', 'Log it'], check: ['warn', 'Check'], plan: ['info', 'Plan'], good: ['good', 'On track'], habit: ['info', 'Habit'] };
    const actionLabel = (r) => (!r.action ? '' : ({ prefill: 'Log it', edit: 'Open entry', ledger: 'Open ledger', capture: 'Log something', settings: 'Open settings' })[r.action.type] || 'Open');
    const recHTML = (r) => `<article class="insight insight-${KIND[r.kind][0]} rec"><div class="insight-stripe"></div><div class="insight-body"><div class="insight-top"><span class="pill pill-${KIND[r.kind][0]}">${KIND[r.kind][1]}</span><h3>${esc(r.title)}</h3></div><p>${esc(r.body)}</p><div class="because">Because: ${esc(r.because)}</div><div class="btn-row rec-actions">${r.action ? `<button class="btn btn-sm btn-primary" type="button" data-rec-act="go" data-rec="${esc(r.id)}">${esc(actionLabel(r))}</button>` : ''}<button class="btn btn-sm btn-ghost" type="button" data-rec-act="dismiss" data-rec="${esc(r.id)}">Dismiss</button></div></div></article>`;
    const statusPill = (s) => (s === 'overdue' ? '<span class="pill pill-act">Overdue</span>' : s === 'due' ? '<span class="pill pill-warn">Due</span>' : '<span class="pill pill-info">Upcoming</span>');
    const H = adv.habits;
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const receiptRows = Object.values(H.receiptsBySection).sort((a, b) => b.count - a.count);
    const ye = yearEntries();

    $('#view-advisor').innerHTML = `
      <section class="card verdict">
        <div class="verdict-kicker"><span class="pill pill-accent">Year-end forecast</span><span class="pill pill-info">${R0.taxYear}</span>${pr.projectedEntries ? `<span class="pill pill-info">${pr.projectedEntries} expected ${pr.projectedEntries === 1 ? 'entry' : 'entries'} still to come</span>` : ''}</div>
        <h2 class="verdict-title">${pr.itemize ? 'On pace to itemize' : 'On pace for the standard deduction'}</h2>
        <div class="hero">${pr.itemize ? `${money(pr.projectedTotal - pr.standardDeduction)} <small>projected above the standard deduction</small>` : `${money(pr.gap)} <small>projected short of itemizing</small>`}</div>
        <p class="verdict-note">${money(pr.actual)} counts so far. Recurring payees found in your entries should add about ${money(pr.expectedMore)} by Dec 31, for a projected ${money(pr.projectedTotal)} against a ${money(pr.standardDeduction)} standard deduction.${pr.medicalPending ? ' Medical costs are waiting on your AGI in Settings.' : ''}</p>
        <div class="meter" role="img" aria-label="${esc(`${money(pr.actual)} so far, ${money(pr.projectedTotal)} projected, ${money(pr.standardDeduction)} standard deduction`)}">
          <div class="meter-track"><div class="meter-proj" style="width:${pct(pr.projectedTotal)}"></div><div class="meter-fill ${pr.actual > pr.standardDeduction ? 'is-over' : ''}" style="width:${pct(pr.actual)}"></div><div class="meter-marker" style="left:${pct(pr.standardDeduction)}"></div></div>
          <div class="meter-labels"><span><span class="legend-dot" style="background:var(--accent)"></span>So far <b>${money(pr.actual)}</b></span><span><span class="legend-dot" style="background:var(--accent-proj)"></span>Projected <b>${money(pr.projectedTotal)}</b></span><span>Standard deduction <b>${money(pr.standardDeduction)}</b></span></div>
        </div>
      </section>

      <section>
        <div class="card-head"><h2>Recommendations</h2><span class="muted small">${adv.recommendations.length} open${adv.dismissed.length ? ` · ${adv.dismissed.length} dismissed` : ''}</span></div>
        ${adv.recommendations.length ? `<div class="feed">${adv.recommendations.map(recHTML).join('')}</div>` : `<div class="card empty"><h3>Nothing to recommend yet</h3><p>${ye.length ? 'The advisor needs a few repeats of the same payee before it can see a pattern. Keep logging.' : 'Log a few expenses, or load the example entries, and the advisor will start finding patterns.'}</p>${ye.length ? '' : '<button class="btn" type="button" id="loadSample">Load example entries</button>'}</div>`}
      </section>

      ${adv.recurrences.length ? `<section class="card">
        <div class="card-head"><h2>Recurring payees</h2><button class="btn btn-sm" type="button" id="icsBtn">Add due dates to calendar</button></div>
        <div class="table-wrap"><table class="table-twin recur"><thead><tr><th>Payee</th><th>Cadence</th><th class="num">Usually</th><th>Last</th><th>Next</th><th>Status</th></tr></thead><tbody>
          ${adv.recurrences.map((r) => `<tr><td><b>${esc(r.description)}</b><br><span class="muted small">${esc(r.label)}</span></td><td>${esc(r.cadenceLabel)}<br><span class="muted small">${r.count} times</span></td><td class="num">${esc(r.unit === 'miles' ? fmtMiles(r.typicalAmount) : moneyCents(r.typicalAmount))}</td><td>${esc(P.formatDate(r.lastDate, false))}</td><td>${esc(P.formatDate(r.nextDate, r.nextDate.slice(0, 4) !== String(R0.taxYear)))}</td><td>${statusPill(r.status)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>` : ''}

      <section class="card">
        <div class="card-head"><h2>How you use it</h2><span class="muted small">computed from your entries</span></div>
        <div class="kpis">
          ${kpi('Entries per week', String(H.entriesPerWeek), `${ye.length} this year`)}
          ${kpi('Typical gap', H.typicalGapDays == null ? '—' : `${Math.round(H.typicalGapDays)} d`, H.daysSinceLast == null ? 'between logging days' : `${H.daysSinceLast} days since the last`)}
          ${kpi('Logging day', H.busiestWeekday == null ? '—' : WEEKDAYS[H.busiestWeekday], 'when you log most')}
          ${kpi('Receipts', `${Math.round(R0.substantiation.coverage * 100)}%`, 'of dollar entries')}
        </div>
        ${receiptRows.length ? `<div class="bars" style="margin-top:14px">${receiptRows.map((s) => { const p = s.withReceipt / s.count * 100; return `<div class="bar-row"><div class="bar-label">${esc(s.title)}<small>${s.withReceipt} of ${s.count} with receipts</small></div><div class="bar-track" data-tip="${esc(`${Math.round(p)}% with receipts`)}" tabindex="0"><div class="bar-gross" style="width:100%"></div><div class="bar-counts" style="width:${p.toFixed(1)}%"></div><div class="bar-value" style="left:${p.toFixed(1)}%">${Math.round(p)}%</div></div></div>`; }).join('')}</div>` : ''}
      </section>

      <section class="card">
        <div class="card-head"><h2>Your data</h2><span class="pill pill-good">On this device only</span></div>
        <p class="note">Everything on this page is computed here, from the entries you typed. Nothing is collected in the background and nothing is sent anywhere. The one thing that could ever leave is the summary below, and only if you send it yourself: a coarse profile with no payees, notes, dates, receipts, exact amounts, or exact income. It is yours. Share it with a preparer, contribute it to a benchmark, or never use it.</p>
        <pre class="aggregate" id="aggregatePre">${esc(JSON.stringify(adv.aggregate, null, 2))}</pre>
        <div class="btn-row"><button class="btn" type="button" id="copyAggregate">Copy summary</button><button class="btn" type="button" id="downloadAggregate">Download summary</button>${adv.dismissed.length ? `<button class="btn btn-ghost" type="button" id="undismiss">Show ${adv.dismissed.length} dismissed</button>` : ''}</div>
      </section>`;

    const root = $('#view-advisor');
    root.addEventListener('click', (ev) => { const b = ev.target.closest('[data-rec-act]'); if (b) handleRecAction(b); });
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
    $('#copyAggregate').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(adv.aggregate, null, 2)); toast('Summary copied.'); } catch (e) { toast('Select the text and copy it.'); } };
    $('#downloadAggregate').onclick = () => downloadText(`itemizer-summary-${R0.taxYear}.json`, JSON.stringify(adv.aggregate, null, 2), 'application/json');
    const ud = $('#undismiss'); if (ud) ud.onclick = async () => { state.settings.advisorDismissed = {}; await DB.saveSettings(state.settings); render(); toast('All recommendations are visible again.'); };
    const ics = $('#icsBtn'); if (ics) ics.onclick = () => downloadText(`itemizer-due-dates-${R0.taxYear}.ics`, icsText(), 'text/calendar');
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  function renderSettings() {
    const s = state.settings;
    const R0 = state.computed;
    const P0 = R0.params;
    const marriedJoint = s.filingStatus === 'mfj' || s.filingStatus === 'qss';
    const overrides = (s.paramOverrides && s.paramOverrides[R0.taxYear]) || {};
    const defaults = R.getParams(R0.taxYear, {});
    const fmtParam = (kind, v) => (kind === 'usd' ? money(v) : kind === 'rate' ? R.pct(v) : R.perMile(v));
    const toInput = (kind, v) => (kind === 'usd' ? String(Math.round(v)) : String(Math.round(v * 1000) / 10));
    const learnedKeys = Object.keys(s.learned || {}).sort();
    const dismissedCount = Object.keys(s.advisorDismissed || {}).length;

    $('#view-settings').innerHTML = `
      <div class="settings-grid">
        <section class="card">
          <div class="card-head"><h2>About you</h2><span class="muted small">drives the standard deduction and floors</span></div>
          <div class="grid-2">
            <label class="field"><span>Filing status</span><select id="sFiling" class="input">${R.FILING_STATUSES.map((f) => `<option value="${f.id}" ${s.filingStatus === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
            <label class="field"><span>Estimated AGI for ${R0.taxYear} ($)</span><input id="sAgi" inputmode="numeric" value="${esc(s.agi)}" placeholder="e.g. 95000"></label>
            <div class="field"><span>Age &amp; vision</span><div class="chips"><label class="check"><input type="checkbox" id="sAge65" ${s.age65 ? 'checked' : ''}> I'm 65 or older</label><label class="check"><input type="checkbox" id="sBlind" ${s.blind ? 'checked' : ''}> I'm blind</label></div></div>
            <div class="field" ${marriedJoint ? '' : 'hidden'}><span>Spouse</span><div class="chips"><label class="check"><input type="checkbox" id="sSpouseAge65" ${s.spouseAge65 ? 'checked' : ''}> Spouse is 65 or older</label><label class="check"><input type="checkbox" id="sSpouseBlind" ${s.spouseBlind ? 'checked' : ''}> Spouse is blind</label></div></div>
            <label class="field"><span>Gambling winnings reported ($)</span><input id="sWinnings" inputmode="numeric" value="${esc(s.gamblingWinnings)}" placeholder="0"></label>
            <label class="field"><span>State</span><select id="sState" class="input"><option value="">Not set</option>${G.US_STATES.map((st) => `<option value="${st.code}" ${s.state === st.code ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select></label>
            <label class="field"><span>County</span><input id="sCounty" value="${esc(s.county || '')}" placeholder="for disaster lookups"></label>
            <div class="field span-2"><span>Location</span><div class="btn-row"><button class="btn btn-sm" type="button" id="sLocate">Use my location to fill in state and county</button></div></div>
            <div class="field span-2"><span>Casualty losses</span>
              <div class="chips"><label class="check"><input type="checkbox" id="sDisaster" ${s.casualtyFederalDisaster ? 'checked' : ''}> From a federally declared disaster</label><input id="sDisasterNumber" class="input" style="max-width:220px" value="${esc(s.disasterNumber || '')}" placeholder="FEMA declaration number"><button class="btn btn-sm" type="button" id="femaLookup">Look up declarations for ${esc(s.state || 'my state')}</button></div>
              <div id="femaPanel"></div>
            </div>
          </div>
          <p class="note" style="margin-top:12px">AGI is adjusted gross income — roughly wages plus other income, minus adjustments like retirement contributions and student loan interest. Last year's Form 1040 line 11 is a good estimate.</p>
        </section>

        <section class="card">
          <div class="card-head"><h2>Rates &amp; thresholds for ${R0.taxYear}</h2>${P0.isFallback ? `<span class="pill pill-act">using ${P0.baseYear} figures</span>` : `<span class="pill pill-info">built in</span>`}</div>
          <p class="note">Built-in figures come from IRS inflation-adjustment notices and the 2025 tax law. Override any value the IRS updates; blank restores the default. Percentages are entered as percent (7.5), mileage as cents per mile (72.5).</p>
          <div class="params-wrap"><table class="params"><thead><tr><th>Figure</th><th class="num">Default</th><th class="num">Your value</th></tr></thead><tbody>
            ${R.PARAM_FIELDS.map((f) => { const def = R.getPath(defaults, f.path); const ov = R.getPath(overrides, f.path); return `<tr><td>${esc(f.label)}</td><td class="num">${esc(fmtParam(f.kind, def))}</td><td class="num"><input data-param="${f.path}" data-kind="${f.kind}" class="${ov != null ? 'is-over' : ''}" inputmode="decimal" value="${ov != null ? esc(toInput(f.kind, ov)) : ''}" placeholder="${esc(toInput(f.kind, def))}"></td></tr>`; }).join('')}
          </tbody></table></div>
          <div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" id="resetParams" ${Object.keys(overrides).length ? '' : 'disabled'}>Reset ${R0.taxYear} to defaults</button></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="chips">${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip" type="button" data-theme-pick="${v}" aria-pressed="${(s.theme || 'system') === v}">${l}</button>`).join('')}</div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Your data</h2><span class="muted small">${state.entries.length} entries, all years · stored on this device</span></div>
          <p class="note">Nothing leaves this device unless you export it. Back up before switching phones or clearing browser data; a backup includes receipt photos.</p>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn" type="button" id="exportJson">Download backup</button>
            <button class="btn" type="button" id="importJson">Restore from backup</button>
            <button class="btn" type="button" id="exportAllCsv" ${state.entries.length ? '' : 'disabled'}>Export all years as CSV</button>
            ${state.entries.some((e) => e.sample) ? `<button class="btn btn-ghost" type="button" id="removeSamples2">Remove example entries</button>` : `<button class="btn btn-ghost" type="button" id="loadSample2">Load example entries</button>`}
          </div>
          <p class="note small" id="storageNote" style="margin-top:10px"></p>
        </section>

        <section class="card">
          <div class="card-head"><h2>Learned categories</h2><span class="muted small">${learnedKeys.length} remembered</span></div>
          <p class="note">When you file something, its description is remembered so the same payee lands on the same line next time. Remove one if it learned wrong.</p>
          ${learnedKeys.length ? `<div class="learned-list" style="margin-top:10px">${learnedKeys.map((k) => { const l = S.getLine(s.learned[k]); return `<div class="learned-item"><span><span class="k">${esc(k)}</span> <span class="v">→ ${esc(l ? l.label : s.learned[k])}</span></span><button class="btn btn-ghost btn-sm" type="button" data-forget="${esc(k)}">Forget</button></div>`; }).join('')}</div><div class="btn-row" style="margin-top:10px"><button class="btn btn-sm" type="button" id="forgetAll">Forget all</button></div>` : ''}
        </section>

        <section class="card">
          <div class="card-head"><h2>Advisor</h2><span class="muted small">${dismissedCount} dismissed</span></div>
          <p class="note">The advisor looks for patterns in your own entries, on this device: recurring payees, a year-end projection, drives that were not logged, unusual amounts, and whether bunching would pay. Dismissed recommendations stay hidden for 30 days.</p>
          <div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" id="resetDismissed" ${dismissedCount ? '' : 'disabled'}>Show dismissed recommendations again</button></div>
        </section>

        <section class="card danger-zone">
          <div class="card-head"><h2>Start over</h2></div>
          <p class="note">Deletes every entry, receipt, and setting on this device. Download a backup first if there is any chance you want it back.</p>
          <div class="btn-row" style="margin-top:12px"><button class="btn btn-danger" type="button" id="wipeAll">Delete all data</button></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>About Itemizer</h2><span class="muted small">v1.0</span></div>
          <p class="note">Itemizer is modelled on the “Keep track of your expenses” organizer sheet tax preparers hand out. Every line on that sheet is here, plus the arithmetic the sheet leaves to you: the 7.5%-of-AGI medical floor, the state-and-local-tax cap, gift substantiation rules, mileage rates, and the standard-deduction comparison that decides whether any of it matters.</p>
          <p class="note" style="margin-top:8px">It is a planning tool, not tax advice. Rates and thresholds change; verify against current IRS publications (Schedule A instructions, Pub. 502, 526, 529, 970) or your preparer before filing.</p>
        </section>
      </div>`;

    const save = async () => { await DB.saveSettings(state.settings); recompute(); };
    $('#sFiling').onchange = async (ev) => { s.filingStatus = ev.target.value; await save(); renderSettings(); };
    $('#sAgi').addEventListener('change', async (ev) => { s.agi = ev.target.value.replace(/[^0-9.]/g, ''); ev.target.value = s.agi; await save(); });
    for (const [id, key] of [['sAge65', 'age65'], ['sBlind', 'blind'], ['sSpouseAge65', 'spouseAge65'], ['sSpouseBlind', 'spouseBlind'], ['sDisaster', 'casualtyFederalDisaster']]) {
      const el = $('#' + id); if (el) el.onchange = async () => { s[key] = el.checked; await save(); };
    }
    $('#sWinnings').addEventListener('change', async (ev) => { s.gamblingWinnings = ev.target.value.replace(/[^0-9.]/g, ''); ev.target.value = s.gamblingWinnings; await save(); });
    $('#sState').onchange = async (ev) => { s.state = ev.target.value; await save(); renderSettings(); };
    $('#sCounty').addEventListener('change', async (ev) => { s.county = ev.target.value.trim(); await save(); });
    $('#sDisasterNumber').addEventListener('change', async (ev) => { s.disasterNumber = ev.target.value.trim(); await save(); });
    $('#sLocate').onclick = async () => {
      const btn = $('#sLocate'); btn.disabled = true;
      try {
        const pos = await G.getPosition();
        const r = await G.reverse(pos.lat, pos.lon);
        if (r.stateCode) s.state = r.stateCode;
        if (r.county) s.county = r.county.replace(/\s+County$/i, '');
        await save(); renderSettings();
        toast(r.stateCode ? `Set to ${r.stateCode}${s.county ? ', ' + s.county : ''}.` : 'Could not tell the state from that location.');
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    $('#femaLookup').onclick = async () => {
      const panel = $('#femaPanel');
      if (!s.state) { toast('Pick your state first.'); return; }
      panel.innerHTML = '<p class="note small">Looking up FEMA declarations…</p>';
      try {
        const list = await G.femaDeclarations({ state: s.state, county: s.county, since: `${R0.taxYear}-01-01` });
        if (!list.length) { panel.innerHTML = `<p class="note small">No federal declarations found for ${esc(s.state)}${s.county ? ', ' + esc(s.county) : ''} since Jan 1, ${R0.taxYear}. Personal casualty losses outside a declared disaster are not deductible.</p>`; return; }
        panel.innerHTML = `<div class="fema-list">${list.slice(0, 12).map((d) => `<div class="fema-item"><span><b>${esc(d.type)}-${esc(d.number)}</b> ${esc(d.title)}<br><span class="muted small">${esc(d.incident)} · declared ${esc(d.declared)} · ${esc(d.area)}</span></span><button class="btn btn-sm" type="button" data-fema="${esc(d.type)}-${esc(d.number)}">Use</button></div>`).join('')}</div>`;
        panel.querySelectorAll('[data-fema]').forEach((b) => { b.onclick = async () => { s.casualtyFederalDisaster = true; s.disasterNumber = b.dataset.fema; await save(); renderSettings(); toast(`Casualty losses marked as federal disaster ${b.dataset.fema}.`); }; });
      } catch (e) { panel.innerHTML = `<p class="note small">${esc(e.message)}</p>`; }
    };
    $$('[data-param]').forEach((inp) => inp.addEventListener('change', async () => {
      const path = inp.dataset.param, kind = inp.dataset.kind;
      const raw = inp.value.trim().replace(/[$,%¢]/g, '');
      if (!s.paramOverrides[R0.taxYear]) s.paramOverrides[R0.taxYear] = {};
      const ov = s.paramOverrides[R0.taxYear];
      if (raw === '' || isNaN(Number(raw))) { unsetPath(ov, path); }
      else { const n = Number(raw); R.setPath(ov, path, kind === 'usd' ? n : n / 100); }
      if (!Object.keys(ov).length) delete s.paramOverrides[R0.taxYear];
      await save(); renderSettings();
    }));
    $('#resetParams').onclick = async () => { delete s.paramOverrides[R0.taxYear]; await save(); renderSettings(); toast('Defaults restored.'); };
    $$('[data-theme-pick]').forEach((b) => b.onclick = async () => { s.theme = b.dataset.themePick; applyTheme(); await save(); renderSettings(); });
    $('#exportJson').onclick = async () => { const data = await DB.exportJSON(); downloadText(`itemizer-backup-${P.todayISO()}.json`, JSON.stringify(data), 'application/json'); };
    $('#importJson').onclick = () => $('#importInput').click();
    $('#exportAllCsv').onclick = () => downloadText('itemizer-all-years.csv', DB.toCSV(state.entries, S), 'text/csv');
    const ls = $('#loadSample2'); if (ls) ls.onclick = loadSampleData;
    const rs = $('#removeSamples2'); if (rs) rs.onclick = removeSampleData;
    $$('[data-forget]').forEach((b) => b.onclick = async () => { C.forget(s.learned, b.dataset.forget); await save(); renderSettings(); });
    const fa = $('#forgetAll'); if (fa) fa.onclick = async () => { s.learned = {}; await save(); renderSettings(); };
    $('#resetDismissed').onclick = async () => { s.advisorDismissed = {}; await save(); renderSettings(); toast('All recommendations are visible again.'); };
    $('#wipeAll').onclick = async () => {
      if (!(await confirmDialog('Delete everything?', 'All entries, receipts, learned categories, and settings on this device will be removed.', 'Delete all data', true))) return;
      await DB.clearAll();
      for (const u of state.receiptURLs.values()) URL.revokeObjectURL(u);
      state.receiptURLs.clear();
      state.entries = []; state.settings = await DB.getSettings(); state.capture = null;
      applyTheme(); render(); toast('All data deleted.');
    };
    DB.storageInfo().then((info) => {
      const el = $('#storageNote'); if (!el) return;
      const used = info.estimate && info.estimate.usage ? ` · ${(info.estimate.usage / 1048576).toFixed(1)} MB used` : '';
      el.textContent = info.mode === 'idb' ? `Stored in this browser's IndexedDB${used}.` : 'This browser has no IndexedDB, so entries are kept in localStorage and receipt photos cannot be stored.';
    });
  }
  function unsetPath(obj, path) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) { if (!o || typeof o[keys[i]] !== 'object') return; o = o[keys[i]]; }
    if (o) delete o[keys[keys.length - 1]];
    // prune empty parents
    let parent = obj;
    for (let i = 0; i < keys.length - 1; i++) { const child = parent[keys[i]]; if (child && typeof child === 'object' && !Object.keys(child).length) { delete parent[keys[i]]; return; } parent = child; }
  }
  function applyTheme() {
    const t = state.settings && state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }

  async function importBackup(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not readable JSON.'); return; }
    const ok = await confirmDialog('Restore this backup?', `${(data.entries || []).length} entries and ${(data.receipts || []).length} receipts will be merged with what is already here. Existing entries with the same id are replaced.`, 'Restore');
    if (!ok) return;
    try {
      const res = await DB.importJSON(data);
      state.entries = await DB.getEntries();
      state.settings = await DB.getSettings();
      applyTheme();
      toast(`Restored ${res.entries} entries and ${res.receipts} receipts.`);
      render();
    } catch (e) { toast(e.message || 'Import failed.'); }
  }

  // ---- example data ---------------------------------------------------------
  function sampleEntries(year) {
    const now = new Date().toISOString();
    const today = P.todayISO();
    const mkYear = (y) => (date, lineId, amount, description, extra) => Object.assign({ id: DB.uid(), date: `${y}-${date}`, taxYear: y, lineId, amount, description, note: '', hasReceipt: true, receiptId: null, createdAt: now, updatedAt: now, sample: true }, extra || {});
    const mk = mkYear(year), mkPrior = mkYear(year - 1);
    const list = [
      mk('01-15', 'tax.real_estate', 3120.44, 'County treasurer — property tax, 1st half'),
      mk('07-15', 'tax.real_estate', 3120.44, 'County treasurer — property tax, 2nd half', { hasReceipt: false }),
      mk('12-31', 'int.mortgage', 9840.12, 'Mortgage interest — Form 1098'),
      mk('03-02', 'tax.personal_property', 312, 'DMV vehicle tax, ad valorem portion'),
      mk('04-14', 'tax.state_income', 640, 'State balance due on last year\'s return'),
      mk('12-31', 'ch.cfc', 520, 'CFC payroll pledge, annual total', { note: 'Pledge confirmation + final pay statement' }),
      mk('11-20', 'ch.org', 300, 'Wounded Warrior Project', { hasReceipt: false }),
      mk('05-10', 'ch.noncash', 380, 'Goodwill drop-off — 4 bags of clothes, lamp, bookshelf', { note: 'Thrift-shop values listed per item' }),
      mk('09-12', 'vol.miles', 86, 'Scout troop campout driving'),
      mk('09-12', 'vol.expenses', 64.5, 'Troop 121 — camp supplies'),
      mk('02-11', 'med.doctor', 45, 'Dr. Patel copay'),
      mk('02-11', 'med.prescriptions', 42.13, 'CVS pharmacy'),
      mk('02-11', 'med.miles', 14, 'Round trip to Dr. Patel'),
      mk('06-03', 'med.dental', 210, 'Aspen Dental — crown copay'),
      mk('08-19', 'med.glasses', 289, 'LensCrafters — glasses', { hasReceipt: false }),
      mk('10-07', 'med.therapy', 60, 'Physical therapy copay'),
      mk('12-31', 'med.insurance', 1422, 'Dental + vision premiums, after tax, annual'),
      mk('12-31', 'edu.loan_interest', 1180.22, 'Aidvantage student loan interest — 1098-E'),
      mk('08-22', 'edu.tuition', 1850, 'Community college — fall tuition'),
      mk('08-22', 'edu.books', 212.4, 'Textbooks'),
      mk('03-08', 'se.advertising', 120, 'Facebook ads — spring photo sessions'),
      mk('04-02', 'se.supplies', 86.9, 'B&H — memory cards, batteries'),
      mk('05-16', 'se.miles', 210, 'Client shoots, Apr–May'),
      mk('05-16', 'se.meals', 54.2, 'Lunch with client — Rivera wedding planning', { note: 'Discussed shot list and timeline' }),
      mk('06-30', 'se.utilities', 480, 'Cell phone, business share'),
      mk('02-20', 'se.professional', 350, 'CPA — Schedule C prep'),
      mk('07-04', 'oth.gambling', 140, 'Casino trip — slots', { hasReceipt: false }),
    ];
    for (let m = 1; m <= 12; m++) list.push(mk(`${String(m).padStart(2, '0')}-05`, 'ch.worship', 200, 'Tithe — St. Andrew\'s'));
    // The tail of the prior year, so twice-a-year and monthly patterns are visible to the advisor.
    list.push(
      mkPrior('01-15', 'tax.real_estate', 3044.1, 'County treasurer — property tax, 1st half'),
      mkPrior('07-15', 'tax.real_estate', 3044.1, 'County treasurer — property tax, 2nd half'),
      mkPrior('12-31', 'int.mortgage', 10102.55, 'Mortgage interest — Form 1098'),
      mkPrior('12-31', 'ch.cfc', 520, 'CFC payroll pledge, annual total'),
      mkPrior('12-31', 'med.insurance', 1380, 'Dental + vision premiums, after tax, annual'),
    );
    for (let m = 9; m <= 12; m++) list.push(mkPrior(`${String(m).padStart(2, '0')}-05`, 'ch.worship', 200, 'Tithe — St. Andrew\'s'));
    // Examples stop at today when the year is the current one, so the advisor has real gaps to find.
    return list.filter((e) => e.date <= today || Number(e.date.slice(0, 4)) < Number(today.slice(0, 4)));
  }
  function samplePlaces() {
    const now = new Date().toISOString();
    const mk = (name, category, lat, lon, address) => ({ id: DB.uid(), name, category, lat, lon, address, note: '', sample: true, updatedAt: now });
    return [
      mk('Home', 'home', 35.7796, -78.6382, 'Raleigh, NC'),
      mk('Dr. Patel', 'medical', 35.8092, -78.6797, 'Duraleigh Rd, Raleigh, NC'),
      mk("St. Andrew's", 'charity', 35.7913, -78.6205, 'Raleigh, NC'),
      mk('Rivera studio', 'business', 35.7325, -78.8503, 'Cary, NC'),
    ];
  }
  async function loadSampleData() {
    const year = Number(state.settings.taxYear);
    const entries = sampleEntries(year);
    await DB.putEntries(entries);
    state.entries.push(...entries);
    let placesAdded = 0;
    if (!state.places.length) {
      const places = samplePlaces();
      for (const p of places) await DB.putPlace(p);
      state.places.push(...places); placesAdded = places.length;
      const patel = entries.find((e) => e.lineId === 'med.miles');
      if (patel) {
        const trip = { id: DB.uid(), date: patel.date, taxYear: patel.taxYear, fromId: places[0].id, toId: places[1].id, fromLabel: 'Home', toLabel: 'Dr. Patel', purpose: 'Doctor visit', miles: Number(patel.amount), roundTrip: true, method: 'road', lineId: 'med.miles', entryId: patel.id, points: null, createdAt: new Date().toISOString(), sample: true };
        await DB.putTrip(trip); state.trips.push(trip);
      }
    }
    toast(`Loaded ${entries.length} example entries${placesAdded ? ` and ${placesAdded} example places` : ''} for ${year}. Remove them any time from the ledger.`, 4000);
    render();
  }
  async function removeSampleData() {
    const ids = state.entries.filter((e) => e.sample).map((e) => e.id);
    await DB.deleteEntries(ids);
    state.entries = state.entries.filter((e) => !e.sample);
    for (const p of state.places.filter((x) => x.sample)) await DB.deletePlace(p.id);
    state.places = state.places.filter((x) => !x.sample);
    for (const t of state.trips.filter((x) => x.sample)) await DB.deleteTrip(t.id);
    state.trips = state.trips.filter((x) => !x.sample);
    state.trip = null;
    toast(`Removed ${ids.length} example entries.`);
    render();
  }

  // ---- bootstrap -------------------------------------------------------------
  function registerSW() {
    if (globalThis.ITEMIZER_SINGLE_FILE) return;
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install is a bonus, not a requirement */ });
  }

  async function init() {
    state.settings = await DB.getSettings();
    applyTheme();
    state.entries = await DB.getEntries();
    for (const e of state.entries) if (!e.taxYear && e.date) e.taxYear = Number(e.date.slice(0, 4));
    try { state.places = await DB.getPlaces(); state.trips = await DB.getTrips(); } catch (e) { state.places = []; state.trips = []; }
    $('#yearSelect').onchange = async (ev) => { state.settings.taxYear = Number(ev.target.value); await DB.saveSettings(state.settings); state.capture = null; state.trip = null; render(); };
    $('#receiptInput').onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onReceiptFile(f); };
    $('#importInput').onchange = importBackup;
    $('#csvInput').onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onCSVFile(f); };
    $('#modal').addEventListener('click', (ev) => { if (ev.target.classList.contains('modal-backdrop')) closeModal(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('#modal').hidden) closeModal(); });
    window.addEventListener('hashchange', route);
    route();
    registerSW();
  }

  // Expose a tiny surface for tests and power users.
  globalThis.Itemizer = { state, render, loadSampleData, removeSampleData, compute: recompute, advice: () => state.advice, prefillCapture, measureTrip, logTrip, startRecording, stopRecording, onCSVFile, icsText };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
