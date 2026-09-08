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
  const EXP = globalThis.ItemizerExperiments;

  const VIEWS = ['capture', 'ledger', 'advisor', 'insights', 'worksheet', 'settings'];
  const LEDGER_FILTERS = ['all', 'noreceipt', 'noack', 'dupes', 'samples'];
  const LEDGER_PAGE = 400; // rows drawn at once; the rest wait behind a button
  /** A filter the ledger cannot apply would leave every entry listed with no chip pressed, so anything else is "all". */
  const normalizeLedgerFilter = (f) => (LEDGER_FILTERS.includes(f) ? f : 'all');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  /** Attach one delegated handler per event type to a long-lived element; a re-render replaces it instead of stacking another. */
  function listen(el, type, fn) {
    if (!el) return;
    el.__handlers = el.__handlers || {};
    if (el.__handlers[type]) el.removeEventListener(type, el.__handlers[type]);
    el.__handlers[type] = fn;
    el.addEventListener(type, fn);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = R.money, moneyCents = R.moneyCents;
  const fmtMiles = (n) => `${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })} mi`;
  const fmtAmount = (entry) => (S.isMiles(entry.lineId) ? fmtMiles(entry.amount) : moneyCents(entry.amount));
  /** From 2026 a non-itemizer's cash gifts sit on the standard-deduction side (§170(p)), so the figure is no longer only the standard deduction. */
  const stdGiftClause = (SD) => (SD && SD.charity > 0 ? `, including ${moneyCents(SD.charity)} of cash gifts` : '');
  /** A count and its noun, so nothing on screen reads "1 entries". Same shape as the helper in rules.js. */
  const plural = (n, one, many) => (Number(n) === 1 ? one : many || one + 's');
  /** styles.css turns off transitions for "reduce motion"; a scroll asked for in script has to check the setting itself. */
  const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rateShort = (r) => R.perMile(r || 0).replace('/mile', '/mi'); // "70¢/mi" beside converted miles on the worksheet, so the preparer can check the figure
  /** The same label for a whole line, which in a year like 2026 was driven under two rates. */
  const rateShortFor = (P, key) => (P.mileageJul ? `${rateShort(P.mileage[key])} to Jun 30, ${rateShort(P.mileageJul[key])} from Jul 1` : rateShort(P.mileage[key]));
  const mixedTreatments = (lines) => new Set(lines.filter((l) => l.treatment !== 'info').map((l) => l.treatment)).size > 1; // Education mixes a credit with an adjustment: no single total lands anywhere on the return
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
    settings: null, // the scalar settings row
    learned: {}, // payee key -> lineId (store: learned)
    weights: {}, // keyword -> multiplier (store: weights)
    dismissed: {}, // recommendation id -> date (store: dismissals)
    layouts: {}, // statement signature -> column layout (store: layouts)
    snapshots: [], // forecast snapshots (store: snapshots)
    overrides: {}, // taxYear -> nested parameter overrides (store: overrides)
    entries: [],
    computed: null,
    view: 'capture',
    ledger: { q: '', section: '', filter: 'all', from: '', to: '', selectMode: false, selected: new Set(), shown: LEDGER_PAGE },
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
    calc: { sqft: '' }, // the home-office figure, so a re-render does not empty the box
    showReceiptSheet: false,
    validation: [],
    session: { nudged: new Set() },
  };

  function freshCapture() {
    return { text: '', parsed: null, lineId: null, amount: '', miles: '', date: P.todayISO(), description: '', note: '', share: '', items: null, paper: false, receiptBlob: null, receiptURL: null, repeat: 1, suggestions: [], nonDeductible: [], pinned: new Set(), dirty: false };
  }
  function freshTrip() {
    const home = state.places.find((p) => p.category === 'home');
    return { fromId: home ? home.id : '', toId: '', date: todayInYear(), dateTouched: false, purpose: '', roundTrip: true, miles: '', lineId: 'med.miles', method: 'manual', result: '', points: null, fromLabel: '', toLabel: '', startedAt: null, endedAt: null, oneWay: null, recordedMiles: null };
  }

  /** Throw away a capture in progress, releasing the object URL of a photo that was never saved. */
  function discardCapture() {
    if (state.capture && state.capture.receiptURL) URL.revokeObjectURL(state.capture.receiptURL);
    state.capture = null;
  }

  /** The local calendar date of an epoch time. toISOString would file an evening drive on the next day. */
  function isoFromEpoch(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function todayInYear() {
    // Default entry date: today if we're in the selected tax year, else Dec 31 of that year (or Jan 1 if the year is ahead).
    const t = P.todayISO();
    const y = Number(state.settings.taxYear);
    const ty = Number(t.slice(0, 4));
    if (y === ty) return t;
    return y < ty ? `${y}-12-31` : `${y}-01-01`;
  }
  /** True when the stored tax year is behind the calendar and the user has not chosen it since the year turned. */
  function shouldAdvanceTaxYear(storedYear, pickedAt, today) {
    const now = Number(String(today).slice(0, 4));
    if (!(Number(storedYear) < now)) return false;
    const picked = Number(String(pickedAt || '').slice(0, 4));
    return !(picked >= now);
  }
  /** On the first launch of a new year, move to it: otherwise today's receipt is filed on Dec 31 of the year before. */
  async function maybeRollYear() {
    if (!shouldAdvanceTaxYear(state.settings.taxYear, state.settings.taxYearPickedAt, P.todayISO())) return;
    const was = Number(state.settings.taxYear);
    const now = Number(P.todayISO().slice(0, 4));
    state.settings.taxYear = now;
    // only the year is written: this tab's copy of every other setting may be an hour old, and another tab may have saved since
    try { Object.assign(state.settings, await DB.updateSettings({ taxYear: now })); } catch (e) { /* the year still moves for this session */ }
    toast(`Tax year is now ${state.settings.taxYear}. Pick ${was} from the year menu to keep working on it.`, 12000, { label: `Back to ${was}`, onClick: () => setTaxYear(was) });
  }
  /** Switch the year the app is working on. A choice made here survives the New Year roll-over. */
  async function setTaxYear(year) {
    // switching years throws away the capture form and any live recording, neither of which is stored anywhere else
    if (!(await confirmDiscardWork(`Tax year ${Number(year)} will be shown instead.`))) { const sel = $('#yearSelect'); if (sel) sel.value = String(state.settings.taxYear); return; }
    const prev = { taxYear: state.settings.taxYear, taxYearPickedAt: state.settings.taxYearPickedAt };
    // the two keys this changes, not the whole row: another tab may have saved an AGI or a filing status since this one loaded
    try { Object.assign(state.settings, await DB.updateSettings({ taxYear: Number(year), taxYearPickedAt: P.todayISO() })); }
    catch (e) {
      // the year the views work on is the stored one: a year that could not be written must not stay on screen
      Object.assign(state.settings, prev);
      const sel = $('#yearSelect'); if (sel) sel.value = String(prev.taxYear);
      toast(`Could not switch the year: ${e && e.message ? e.message : 'storage error'}.`, 6000);
      return;
    }
    discardCapture();
    discardRecorder();
    state.trip = null;
    clearLedgerSelection(); // ticks on last year's rows would count towards actions that cannot reach them
    render();
  }

  /** Forget the ledger selection: used wherever the list under it is replaced wholesale. */
  function clearLedgerSelection() { state.ledger.selected.clear(); state.ledger.selectMode = false; }

  function recompute() {
    const today = P.todayISO();
    state.computed = R.compute(state.entries, Object.assign({}, state.settings, { today, paramOverrides: state.overrides }));
    const snaps = state.snapshots;
    // Finished years with snapshots get their final figure, so past forecasts can be checked.
    const thisYear = Number(today.slice(0, 4));
    const finals = {};
    // December receipts are typed in January to April, so a year is only graded once its records are in.
    for (const y of new Set(snaps.map((x) => x.taxYear))) if (y < thisYear && today >= `${y + 1}-04-15`) finals[y] = R.compute(state.entries, Object.assign({}, state.settings, { taxYear: y, today, paramOverrides: state.overrides })).scheduleA.total;
    state.validation = EXP.validate(snaps, finals);
    const calibration = state.settings.experimentSnapshots === false ? { factor: 1, n: 0, basis: 'snapshots are off' } : EXP.calibration(state.validation);
    // the advisor recomputes the projection itself, so it needs the same overridden parameters the live figures were built with
    state.advice = ADV.analyze({ entries: state.entries, settings: Object.assign({}, state.settings, { paramOverrides: state.overrides }), dismissed: state.dismissed, computed: state.computed, today, calibration });
    maybeSnapshot(today);
  }
  /** Once a month, write down the live year's forecast so it can be checked when the year closes. */
  function maybeSnapshot(today) {
    if (state.settings.experimentSnapshots === false) return;
    if (state.entries.some((e) => e.sample)) return; // a forecast built from example figures would be graded later as if it were real
    const pr = state.advice && state.advice.projection;
    if (!pr || Number(state.settings.taxYear) !== Number(today.slice(0, 4)) || !state.computed.entries.length) return;
    const s = { today, taxYear: state.computed.taxYear, actual: pr.actual, expectedMore: pr.expectedMoreRaw != null ? pr.expectedMoreRaw : pr.expectedMore, projectedTotal: pr.actual + (pr.expectedMoreRaw != null ? pr.expectedMoreRaw : pr.expectedMore), standardDeduction: pr.standardDeduction, itemize: pr.actual + (pr.expectedMoreRaw != null ? pr.expectedMoreRaw : pr.expectedMore) > pr.standardDeduction };
    if (!EXP.changed(state.snapshots, s)) return;
    const known = state.snapshots; // only the rows this tab started from may be deleted: another tab's month must survive
    state.snapshots = EXP.snapshot(state.snapshots, s);
    DB.syncSnapshots(state.snapshots, known).catch(() => {}); // one row per month per year; only the changed month is written
  }
  const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  /** The keyword weights in force. With the experiment off the stored ones are kept but not applied, so the switch really does turn the effect off. */
  const activeWeights = () => (state.settings.experimentCorrections === false ? {} : state.weights);
  /** Learn from which line was chosen versus which was suggested (experiments.js). */
  function learnFromChoice(suggestions, chosenLineId) {
    if (state.settings.experimentCorrections === false || !suggestions || !suggestions.length || !chosenLineId) return;
    const top = suggestions[0];
    const chosen = suggestions.find((x) => x.lineId === chosenLineId);
    const known = state.weights; // a keyword another tab has just learned is not this tab's to delete
    state.weights = EXP.applyCorrection(state.weights, top.lineId, (top.because || []).filter(EXP.isKeyword), chosenLineId, chosen ? (chosen.because || []).filter(EXP.isKeyword) : []);
    DB.syncWeights(state.weights, known).catch(() => {}); // only the keywords whose weight changed are written
  }
  /** Remember which line a payee was filed on: one row per payee key. */
  function rememberLine(text, lineId) {
    const key = C.keyFor(text || '');
    C.learn(state.learned, text, lineId);
    if (key && state.learned[key] === lineId) DB.putLearned(key, lineId).catch(() => {});
  }
  /** One follow-up right after a save, based only on what was just logged. Nothing is stored. */
  function sessionNudge(entry) {
    if (state.settings.experimentNudges === false || !entry) return;
    const line = S.getLine(entry.lineId); if (!line) return;
    const once = (k) => { if (state.session.nudged.has(k)) return false; state.session.nudged.add(k); return true; };
    const dayMs = 86400000;
    if (ADV.VISIT_LINES.includes(entry.lineId)) {
      // rounded to whole days: the day daylight saving ends is 25 hours long, and a raw comparison misses the drive
      const hasDrive = state.entries.some((e) => e.lineId === 'med.miles' && Math.abs(Math.round((new Date(e.date + 'T00:00:00') - new Date(entry.date + 'T00:00:00')) / dayMs)) <= 1);
      const history = state.entries.filter((e) => e.lineId === 'med.miles').map((e) => Number(e.amount) || 0);
      if (!hasDrive && (history.length || state.places.some((p) => p.category === 'medical')) && once('drive:' + entry.id)) {
        const typical = history.length ? G.roundMiles(median(history)) : '';
        setTimeout(() => toast(`Saved. Add the drive to ${entry.description || line.label}?`, 9000, { label: 'Add drive', onClick: () => prefillCapture({ lineId: 'med.miles', amount: typical, description: `Round trip — ${entry.description || line.label}`, date: entry.date }) }), 60);
      }
    } else if (entry.lineId === 'se.miles' && !state.entries.some((e) => e.lineId === 'se.total_miles' && Number(e.taxYear) === Number(entry.taxYear)) && once('totalmiles:' + entry.taxYear)) {
      setTimeout(() => toast("Saved. Schedule C also needs the year's total miles.", 9000, { label: 'Log total miles', onClick: () => prefillCapture({ lineId: 'se.total_miles', amount: '', description: 'Odometer, all miles this year', date: `${entry.taxYear}-12-31` }) }), 60);
    } else if (['ch.worship', 'ch.college', 'ch.org', 'ch.cfc', 'ch.other'].includes(entry.lineId) && Number(entry.amount) >= state.computed.params.acknowledgmentThreshold && !entry.hasReceipt && once('ack:' + entry.id)) {
      setTimeout(() => toast(`Saved. Gifts of ${money(state.computed.params.acknowledgmentThreshold)} or more need the charity's written acknowledgment; attach it when it arrives.`, 6000), 60);
    }
  }

  function yearEntries() { return state.computed ? state.computed.entries : []; }

  // ---- toast / modal ---------------------------------------------------------
  let toastTimer = null, toastFrame = null, toastAction = null, toastEndsAt = 0;
  let pendingUndo = null; // the rows behind the Undo button on screen: further deletes join this batch rather than replacing it
  function cancelToastFrame() { if (toastFrame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(toastFrame); toastFrame = null; }
  function hideToast() { cancelToastFrame(); toastAction = null; pendingUndo = null; const el = $('#toast'); if (!el) return; el.classList.remove('is-on'); el.textContent = ''; }
  function toast(msg, ms, action) {
    const el = $('#toast');
    // A passing message must not sweep away a button the user could still press: the action rides along with the new
    // text, under a label that names what it acts on, and keeps at least the time it had left.
    const left = toastAction ? toastEndsAt - Date.now() : 0;
    if (!action && left > 0) { action = Object.assign({}, toastAction, { label: toastAction.altLabel || toastAction.label }); ms = Math.max(ms || 2600, left); }
    toastAction = action && action.label ? action : null;
    toastEndsAt = Date.now() + (ms || (action ? 7000 : 2600));
    el.hidden = false; // the live region is always in the accessibility tree; showing and hiding is a class
    clearTimeout(toastTimer);
    cancelToastFrame();
    // cleared first, filled a frame later: a repeated message is a fresh change that screen readers announce
    el.textContent = ''; el.classList.remove('is-on');
    const show = () => {
      toastFrame = null;
      el.textContent = msg;
      if (action && action.label) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
        b.onclick = () => { clearTimeout(toastTimer); hideToast(); action.onClick(); };
        el.appendChild(b);
      }
      el.classList.add('is-on');
      // the countdown starts here: a frame in a background tab can be minutes late, and a toast must not outlive its action
      toastTimer = setTimeout(hideToast, ms || (action ? 7000 : 2600));
    };
    if (typeof requestAnimationFrame === 'function') toastFrame = requestAnimationFrame(show); else show();
  }
  // The modal is a real dialog: the page behind it is inert, Tab stays inside, and focus returns to the opener on close.
  let modalOpener = null, modalOnCancel = null, modalScrollY = 0;
  const behindModal = () => ['.topbar', '#main', '.tabbar'].map((sel) => document.querySelector(sel)).filter(Boolean);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function trapTab(ev) {
    if (ev.key !== 'Tab') return;
    const panel = $('#modalPanel');
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) { ev.preventDefault(); panel.focus(); return; }
    // the panel itself counts as outside: focus starts there on touch devices, and Shift+Tab from it must not leave the dialog
    const first = items[0], last = items[items.length - 1], inside = panel.contains(document.activeElement) && document.activeElement !== panel;
    if (ev.shiftKey && (document.activeElement === first || !inside)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && (document.activeElement === last || !inside)) { ev.preventDefault(); first.focus(); }
  }
  function openModal(html, onOpen, onCancel) {
    const m = $('#modal'), panel = $('#modalPanel');
    // a dialog opened over an open one keeps the first one's opener and scroll position: recording them again would lose both
    const wasOpen = !m.hidden;
    if (!wasOpen) modalOpener = document.activeElement;
    modalOnCancel = onCancel || null;
    panel.innerHTML = html;
    const heading = panel.querySelector('h2, h3');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.tabIndex = -1;
    if (heading) { if (!heading.id) heading.id = 'modalTitle'; panel.setAttribute('aria-labelledby', heading.id); panel.removeAttribute('aria-label'); }
    else { panel.removeAttribute('aria-labelledby'); panel.setAttribute('aria-label', 'Dialog'); }
    m.hidden = false;
    if (!wasOpen) {
      // iOS ignores overflow:hidden for touch scrolling, so the page is pinned in place and put back on close
      modalScrollY = window.scrollY || 0;
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed'; document.body.style.top = `-${modalScrollY}px`; document.body.style.width = '100%';
    }
    for (const el of behindModal()) { el.inert = true; el.setAttribute('aria-hidden', 'true'); }
    panel.addEventListener('keydown', trapTab);
    if (onOpen) onOpen(panel);
    // a keyboard opening over the lower half of the sheet helps nobody on a phone: focus the sheet itself there
    const finePointer = typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;
    const first = panel.querySelector('input, select, textarea, button');
    if (first && finePointer) first.focus(); else panel.focus();
  }
  function closeModal() {
    const m = $('#modal'), panel = $('#modalPanel');
    if (m.hidden) return;
    m.hidden = true;
    panel.removeEventListener('keydown', trapTab);
    panel.innerHTML = '';
    document.body.style.overflow = '';
    document.body.style.position = ''; document.body.style.top = ''; document.body.style.width = '';
    window.scrollTo(0, modalScrollY);
    for (const el of behindModal()) { el.inert = false; el.removeAttribute('aria-hidden'); }
    const opener = modalOpener; modalOpener = null; modalOnCancel = null;
    if (opener && opener.isConnected && typeof opener.focus === 'function' && opener !== document.body) opener.focus({ preventScroll: true });
    else { const main = $('#main'); if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }); } }
  }
  /** Escape or the backdrop: close, and let a pending confirm resolve as "no" instead of hanging. */
  function cancelModal() { const cb = modalOnCancel; closeModal(); if (cb) cb(); }
  function confirmDialog(title, body, confirmLabel, danger) {
    return new Promise((resolve) => {
      openModal(`<h2>${esc(title)}</h2><p class="note">${esc(body)}</p><div class="modal-actions"><button class="btn" data-act="cancel">Cancel</button><span class="spacer"></span><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmLabel || 'OK')}</button></div>`, (panel) => {
        panel.querySelector('[data-act="cancel"]').onclick = () => { closeModal(); resolve(false); };
        panel.querySelector('[data-act="ok"]').onclick = () => { closeModal(); resolve(true); };
      }, () => resolve(false));
    });
  }
  /** Re-rendering a view replaces the focused control; remember which one it was and put focus back on its replacement. */
  function focusKeyOf() {
    const a = document.activeElement;
    if (!a || a === document.body) return null;
    if (a.id) return '#' + a.id;
    const d = a.dataset || {};
    if (d.rec != null && d.recAct != null) return `[data-rec="${d.rec}"][data-rec-act="${d.recAct}"]`; // the two buttons on a card share one data-rec
    for (const k of ['filter', 'themePick', 'mode', 'param', 'sel', 'edit', 'impSel', 'impLine']) if (d[k] != null) return `[data-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${d[k]}"]`;
    return null;
  }
  function restoreFocus(key) {
    if (!key) return;
    let el = null;
    try { el = document.querySelector(key); } catch (e) { el = null; }
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }

  // ---- receipts ------------------------------------------------------------
  async function shrinkImage(file, maxDim, quality) {
    maxDim = maxDim || 1600; quality = quality || 0.82;
    let source = null, w = 0, h = 0;
    try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = source.width; h = source.height; } catch (e) { source = null; }
    if (!source) {
      const tmpURL = URL.createObjectURL(file);
      try {
        source = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = tmpURL; });
        w = source.naturalWidth; h = source.naturalHeight;
      } finally { URL.revokeObjectURL(tmpURL); }
    }
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
    if (typeof source.close === 'function') source.close(); // a phone photo decodes to tens of megabytes; free it now rather than at the next collection
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
  /** Forget a receipt's object URL (and release it) when the photo or its entry goes away. */
  function dropReceiptURL(receiptId) {
    if (!receiptId || !state.receiptURLs.has(receiptId)) return;
    URL.revokeObjectURL(state.receiptURLs.get(receiptId));
    state.receiptURLs.delete(receiptId);
  }
  // The receipts sheet holds every photo in the year at once, so what it opened is released as soon as it is
  // closed or the user leaves the worksheet; anything still on screen re-reads it from the store on the next draw.
  const sheetReceiptIds = new Set();
  function releaseSheetReceipts() {
    if (!sheetReceiptIds.size) return;
    if (!$('#modal').hidden) return; // the edit sheet on top may be showing one of these photos
    for (const id of sheetReceiptIds) dropReceiptURL(id);
    sheetReceiptIds.clear();
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
  let hashPutBack = false; // set while a hash the Back gesture changed is being restored
  function route() {
    const { view, params } = parseHash();
    // Back with a sheet open should dismiss the sheet, not swap the view underneath it: close it and put the hash back.
    if (!$('#modal').hidden) {
      cancelModal();
      if (view !== state.view) { hashPutBack = true; location.hash = state.view; }
      return;
    }
    if (hashPutBack) { hashPutBack = false; return; }
    state.view = view;
    const filter = params.get('filter');
    if (view === 'ledger' && filter) state.ledger.filter = normalizeLedgerFilter(filter);
    render();
    $('#main').scrollTo && window.scrollTo({ top: 0 });
  }

  // ---- render ---------------------------------------------------------------
  function render() {
    // One bad row must not blank the whole app: on a failure the view already on screen stays, and the user can still reach Settings.
    try {
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
      if (state.view !== 'worksheet') releaseSheetReceipts();
      document.title = state.view === 'capture' ? 'Itemizer' : `Itemizer · ${state.view[0].toUpperCase()}${state.view.slice(1)}`;
    } catch (err) {
      console.error(err);
      toast('Something went wrong drawing this view. Your entries are safe; try another tab or reload the page.', 8000);
    }
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
    if (entry.receiptId) return `<span class="row-receipt rc-attached" title="Receipt photo attached">${ICON.check}<span class="sr-only">Receipt photo attached</span></span>`;
    if (entry.hasReceipt) return `<span class="row-receipt rc-paper" title="Paper receipt filed">${ICON.paper}<span class="sr-only">Paper receipt filed</span></span>`;
    const threshold = state.computed.params.receiptThreshold;
    if ((Number(entry.amount) || 0) >= threshold) return `<span class="row-receipt rc-missing" title="No receipt">${ICON.alert}<span class="sr-only">No receipt</span></span>`;
    return '<span class="row-receipt rc-none"></span>';
  }
  function entryRow(e, opts) {
    // a row whose line a later schema no longer has is still listed and editable, rather than taking the view down with it
    const line = S.getLine(e.lineId) || { label: e.lineId, sectionId: '', sectionTitle: 'Unrecognised line', unit: 'usd', treatment: 'info' };
    const dupe = opts && opts.dupes && opts.dupes.has(e.id);
    if (opts && opts.select) {
      return `<label class="row row-select">
      <span class="row-check"><input type="checkbox" data-sel="${esc(e.id)}" ${opts.selected.has(e.id) ? 'checked' : ''} aria-label="Select ${esc(e.description || line.label)}"></span>
      <span class="row-date">${esc(P.formatDate(e.date, false))}</span>
      <span class="row-main"><span class="row-desc"><span class="row-text">${esc(e.description || line.label)}</span>${e.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}</span><span class="row-line">${esc(line.label)} · ${esc(line.sectionTitle)}</span></span>
      <span class="row-amt">${esc(fmtAmount(e))}</span>
      ${receiptIcon(e)}
    </label>`;
    }
    return `<button class="row" data-edit="${esc(e.id)}" type="button">
      <span class="row-date">${esc(P.formatDate(e.date, false))}</span>
      <span class="row-main"><span class="row-desc"><span class="row-text">${esc(e.description || line.label)}</span>${e.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}${dupe ? ' <span class="dupe-mark" title="Possible duplicate"><span aria-hidden="true">⧉</span><span class="sr-only">Possible duplicate</span></span>' : ''}</span><span class="row-line">${esc(line.label)} · ${esc(line.sectionTitle)}</span></span>
      <span class="row-amt">${esc(fmtAmount(e))}${line.unit === 'miles' && line.treatment !== 'info' ? `<small>${esc(money(R.cents(Number(e.amount) * R.mileageRate(state.computed.params, line.rate, e.date))))}</small>` : ''}</span>
      ${receiptIcon(e)}
    </button>`;
  }
  function lineSelectHTML(id, selected, label) {
    return `<select id="${id}" class="input" aria-label="${esc(label || 'Worksheet line')}"><option value="">Choose a line…</option>${S.SECTIONS.map((sec) => `<optgroup label="${esc(sec.title)}">${sec.lines.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${esc(l.label)}${l.unit === 'miles' ? ' (miles)' : ''}</option>`).join('')}</optgroup>`).join('')}</select>`;
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
    const fk = focusKeyOf(); // the sheet returns focus to a row this render is about to replace
    if (!state.capture) { state.capture = freshCapture(); state.capture.date = todayInYear(); }
    const cap = state.capture;
    const R0 = state.computed;
    const ye = yearEntries();
    const recent = ye.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.date.localeCompare(a.date)).slice(0, 6);
    const verdict = R0.verdict.itemize ? `<span class="pill pill-good">Itemizing wins by ${R.moneyNear(R0.verdict.difference)}</span>` : `<span class="pill pill-info">${R.moneyNear(-R0.verdict.difference)} to itemizing</span>`;
    const filing = R.FILING_STATUSES.find((f) => f.id === state.settings.filingStatus);
    const strip = `<a class="year-strip" href="#insights"><span class="sr-only">Open insights: </span>
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
      restoreFocus(fk);
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
          <label class="suggest-label" for="fLine">Where it goes on the worksheet</label>
          <div class="chips" id="chips">${chipsHTML(cap)}</div>
          ${lineSelectHTML('fLine', cap.lineId)}
          <div class="line-hint" id="lineHint">${lineHintHTML(cap.lineId)}</div>
        </div>
        <div class="nd-warn" id="ndWarn" ${cap.nonDeductible.length ? '' : 'hidden'}>${cap.nonDeductible.map((n) => `<div><b>Probably not deductible.</b> ${esc(n.reason)}</div>`).join('')}</div>
        <div class="receipt-row" id="receiptRow" ${cap.lineId && S.isMiles(cap.lineId) ? 'hidden' : ''}>
          ${cap.receiptURL ? `<button type="button" class="thumb-btn" id="capThumb" aria-label="View the receipt full size"><img class="receipt-thumb" src="${cap.receiptURL}" alt=""></button><button class="btn btn-ghost btn-sm" type="button" id="dropReceipt">Remove photo</button>` : `<button class="btn" type="button" id="attachBtn">${ICON.camera} Attach receipt</button>`}
          <label class="check"><input type="checkbox" id="fPaper" ${cap.paper ? 'checked' : ''}> Paper receipt filed</label>
        </div>
        <details class="more" ${cap.note || cap.repeat > 1 ? 'open' : ''}>
          <summary>Note &amp; repeat</summary>
          <div class="grid-2">
            <label class="field span-2"><span>Note</span><textarea id="fNote" rows="${cap.note && cap.note.includes('\n') ? Math.min(8, cap.note.split('\n').length) : 2}" placeholder="Who you met, what it was for, lender's name and TIN…">${esc(cap.note)}</textarea></label>
            <label class="field"><span>Repeat monthly</span><select id="fRepeat">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `<option value="${n}" ${cap.repeat === n ? 'selected' : ''}>${n === 1 ? 'Just once' : `${n} months`}</option>`).join('')}</select></label>
            <label class="field"><span>Business-use share (%)</span><input id="fShare" inputmode="decimal" value="${esc(cap.share || '')}" placeholder="100"></label>
            <p class="note span-2">Repeat is for premiums or a monthly pledge: one entry per month from this date. The share is for bills that are partly business, like a phone or internet: only that share is logged, and the full amount goes in the note.</p>
          </div>
        </details>
        <div class="actions"><button class="btn btn-primary" type="button" id="saveBtn" aria-describedby="saveHint">Save</button><span class="muted small" id="saveHint" role="status" aria-live="polite"></span></div>
      </div>

      ${calculatorsHTML()}

      <section class="card">
        <div class="card-head"><h2>Recent</h2><a href="#ledger" class="small">Open ledger</a></div>
        ${recent.length ? `<div class="recent-list">${recent.map((e) => entryRow(e)).join('')}</div>` : emptyStateHTML()}
      </section>`;

    bindCapture();
    restoreFocus(fk);
  }

  function emptyStateHTML() {
    const year = Number(state.settings.taxYear);
    const others = new Map();
    for (const e of state.entries) if (Number(e.taxYear) !== year) others.set(Number(e.taxYear), (others.get(Number(e.taxYear)) || 0) + 1);
    if (others.size) {
      // an imported statement files each row under its own year, so the usual reason this year looks empty is that the entries are in another one
      const total = [...others.values()].reduce((a, b) => a + b, 0);
      const list = [...others.keys()].sort((a, b) => a - b);
      const where = list.length === 1 ? `in ${list[0]}` : `in ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
      const best = [...others.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
      return `<div class="empty"><h3>Nothing logged for ${esc(year)} yet</h3><p>You have ${total} ${total === 1 ? 'entry' : 'entries'} ${esc(where)}. Pick a year from the menu at the top, or use the button below.</p><button class="btn" type="button" data-year-jump="${best}">Show ${best}</button></div>`;
    }
    return `<div class="empty"><h3>Nothing logged for ${esc(year)} yet</h3><p>Type an expense above, or load a set of example entries to see how the tracker thinks.</p><button class="btn" type="button" id="loadSample">Load example entries</button></div>`;
  }

  /** The empty state offers the year the entries are actually in; switching there is the same move as the year menu. */
  function bindJumpYear() {
    // a data attribute, not an id: the capture and ledger views can both be holding an empty state
    $$('[data-year-jump]').forEach((b) => { b.onclick = () => { setTaxYear(Number(b.dataset.yearJump)).catch(() => toast('Could not switch the year. Use the menu at the top.')); }; });
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
  /** Where a line lands on the return. The medical floor is editable in Settings, so the rate in force is quoted, not a fixed figure. */
  function treatmentLabel(treatment) {
    const t = S.TREATMENTS[treatment];
    if (treatment === 'A-medical' && state.computed) return `Medical (above ${R.pct(state.computed.params.medicalFloorRate)} of AGI)`;
    return t.label;
  }
  function lineHintHTML(lineId) {
    if (!lineId) return '';
    const l = S.getLine(lineId);
    const t = S.TREATMENTS[l.treatment];
    const s = state.capture && state.capture.suggestions.find((x) => x.lineId === lineId);
    return `<b>${esc(l.label)}</b> → ${esc(t.schedule)}: ${esc(treatmentLabel(l.treatment))}.${l.hint ? ' ' + esc(l.hint) : ''}${s && s.because.length ? `<div class="because">Suggested because: ${esc(s.because.join(', '))}</div>` : ''}`;
  }

  function bindCapture() {
    const cap = state.capture;
    const root = $('#view-capture');
    const quick = $('#quickInput');
    quick.addEventListener('input', () => { cap.text = quick.value; onQuickChange(); });
    $('#quickForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveCapture(); });
    $('#snapBtn').onclick = () => { state.pendingReceiptTarget = 'capture'; $('#receiptInput').click(); };
    const attach = $('#attachBtn'); if (attach) attach.onclick = () => { state.pendingReceiptTarget = 'capture'; $('#receiptPick').click(); };
    const drop = $('#dropReceipt'); if (drop) drop.onclick = () => { if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL); cap.receiptBlob = null; cap.receiptURL = null; renderCapture(); };
    const thumb = $('#capThumb'); if (thumb) thumb.onclick = () => viewReceipt(cap.receiptURL, 'Receipt preview');
    $('#clearBtn').onclick = () => { if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL); state.capture = freshCapture(); state.capture.date = todayInYear(); renderCapture(); $('#quickInput').focus(); };
    $('#saveBtn').onclick = saveCapture;
    $('#fAmount').addEventListener('input', (ev) => { cap.pinned.add('amount'); cap.dirty = true; if (cap.lineId && S.isMiles(cap.lineId)) cap.miles = ev.target.value; else cap.amount = ev.target.value; updateSaveHint(); });
    $('#fDate').addEventListener('change', (ev) => { cap.pinned.add('date'); cap.dirty = true; cap.date = ev.target.value; updateSaveHint(); });
    $('#fDesc').addEventListener('input', (ev) => {
      cap.pinned.add('description'); cap.dirty = true; cap.description = ev.target.value;
      reclassify();
      // a retyped payee re-picks the line the same way the quick box does, until the user picks one themselves
      const next = cap.pinned.has('line') ? cap.lineId : pickDefaultLine(cap.suggestions, !!(cap.parsed && cap.parsed.miles != null));
      if (next !== cap.lineId) setCaptureLine(next); else { refreshChips(); updateSaveHint(); }
    });
    $('#fLine').addEventListener('change', (ev) => { cap.pinned.add('line'); setCaptureLine(ev.target.value || null); });
    $('#chips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-line]'); if (!b) return; cap.pinned.add('line'); setCaptureLine(b.dataset.line); });
    const paper = $('#fPaper'); if (paper) paper.onchange = () => { cap.paper = paper.checked; cap.dirty = true; };
    $('#fNote').addEventListener('input', (ev) => { cap.note = ev.target.value; cap.dirty = true; });
    $('#fRepeat').addEventListener('change', (ev) => { cap.repeat = Number(ev.target.value) || 1; });
    $('#fShare').addEventListener('input', (ev) => { cap.share = ev.target.value.replace(/[^0-9.]/g, ''); cap.dirty = true; updateSaveHint(); }); // a phone or internet split is often 33.3 or 62.5, so the decimal point stays
    listen(root, 'click', (ev) => {
      const b = ev.target.closest('[data-edit]'); if (b) { openEdit(b.dataset.edit); return; }
      const r = ev.target.closest('[data-rec-act]'); if (r) handleRecAction(r).catch(() => toast('Something went wrong. Nothing was changed.'));
    });
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
    bindJumpYear();
    bindModeBar();
    bindCalculators();
    updateSaveHint();
  }

  // ---- capture modes ----------------------------------------------------------
  function modeBarHTML(mode) {
    const tabs = [['expense', 'Expense'], ['trip', 'Trip'], ['import', 'Import']];
    return `<div class="mode-bar" role="group" aria-label="Ways to log">${tabs.map(([id, label]) => `<button class="mode-tab" type="button" aria-pressed="${mode === id}" data-mode="${id}">${label}</button>`).join('')}</div>`;
  }
  function bindModeBar() {
    $$('#view-capture [data-mode]').forEach((b) => { b.onclick = () => { state.captureMode = b.dataset.mode; renderCapture(); const nb = $(`#view-capture [data-mode="${state.captureMode}"]`); if (nb) nb.focus({ preventScroll: true }); }; });
  }

  // ---- calculators ----------------------------------------------------------------
  /** Square feet the simplified method allows: whole feet, never more than 300. */
  const homeOfficeSqft = (v) => Math.min(300, Math.max(0, Math.floor(Number(v) || 0)));
  function calculatorsHTML() {
    // the figure is held in state, so adding a donated item below (which re-renders) does not empty the box
    const sqft = state.calc.sqft;
    const amt = homeOfficeSqft(sqft) * 5;
    return `<details class="card calc" ${sqft === '' ? '' : 'open'}><summary><b>Calculators</b> <span class="muted small">home office</span></summary>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>Home office, simplified method (sq ft, up to 300)</span><input id="calcSqft" inputmode="numeric" placeholder="e.g. 120" value="${esc(sqft)}"></label>
        <div class="field"><span>Deduction at $5 per square foot</span><div class="calc-out" id="calcHomeOut" role="status" aria-live="polite">${esc(money(amt))}</div></div>
      </div>
      <div class="btn-row" style="margin-top:8px"><button class="btn btn-sm" type="button" id="calcHomeLog" ${amt > 0 ? '' : 'disabled'}>Log it on Schedule C</button></div>
      <p class="note small" style="margin-top:8px">The space must be used regularly and exclusively for the business. The simplified rate is $5 per square foot, capped at 300 square feet ($1,500). For a share of a bill that is partly business, use "Business-use share" under Note &amp; repeat when you log the bill.</p>
    </details>
    ${donationToolHTML()}`;
  }
  /** Catalog lows are decimals like 2.5, so both ends are written as money: a range reading "$2.5" looks like a typo on a record kept for the IRS. */
  const catalogRange = (c) => `${moneyCents(c.low)} to ${moneyCents(c.high)}`;
  /**
   * The catalog row a typed item really is, or null. VAL.find scores any shared word, which
   * makes "Desk lamp" a Desk at $25; a value is only suggested when every word of the item
   * appears in the catalog name, so an item we do not carry is left for the donor to value.
   */
  function catalogMatch(query) {
    const exact = VAL.byName(query);
    if (exact) return exact;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const stems = (s) => norm(s).split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)); // "chairs" is a chair
    const q = norm(query), asked = stems(query);
    if (!asked.length) return null;
    const starts = (c) => (norm(c.name).startsWith(q) ? 0 : 1); // "shirt" is a Shirt or blouse before it is a T-shirt
    const hits = VAL.CATALOG.filter((c) => { const has = stems(c.name); return asked.every((w) => has.includes(w)); }).sort((a, b) => starts(a) - starts(b) || a.name.length - b.name.length);
    return hits[0] || null;
  }
  function donationToolHTML() {
    const D = state.donation || (state.donation = { charity: '', date: todayInYear(), items: [] });
    const dnTotal = VAL.total(D.items);
    const th = VAL.thresholds(dnTotal, state.computed.params);
    return `<details class="card calc" ${D.items.length ? 'open' : ''}><summary><b>Donated goods</b> <span class="muted small">itemized value for the furniture/clothing line</span></summary>
      <div class="grid-2" style="margin-top:12px">
        <label class="field"><span>Charity</span><input id="dnCharity" value="${esc(D.charity)}" placeholder="Goodwill, Salvation Army, church rummage sale"></label>
        <label class="field"><span>Date</span><input id="dnDate" type="date" value="${esc(D.date)}"></label>
        <label class="field span-2"><span>Item</span><input id="dnItem" list="dnCatalog" placeholder="Start typing: shirt, jeans, sofa, lamp, books…" autocomplete="off"><datalist id="dnCatalog">${VAL.CATALOG.map((c) => `<option value="${esc(c.name)}">${esc(c.category)} · ${esc(catalogRange(c))}</option>`).join('')}</datalist></label>
        <label class="field"><span>Quantity</span><input id="dnQty" inputmode="numeric" value="1"></label>
        <label class="field"><span>Condition</span><select id="dnCond" class="input">${VAL.CONDITIONS.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Value each ($)</span><input id="dnValue" inputmode="decimal" placeholder="suggested from the range"></label>
        <div class="field"><span>&nbsp;</span><button class="btn" type="button" id="dnAdd">Add item</button></div>
      </div>
      <p class="note small" id="dnHint" style="margin-top:8px">Pick an item to see its typical thrift-shop range.</p>
      ${D.items.length ? `<div class="table-wrap"><table class="table-twin donation"><thead><tr><th>Item</th><th class="num">Qty</th><th>Condition</th><th class="num">Each</th><th class="num">Total</th><th></th></tr></thead><tbody>${D.items.map((it, i) => `<tr><td>${esc(it.name)}</td><td class="num">${it.qty}</td><td>${esc((VAL.CONDITIONS.find((c) => c.id === it.condition) || {}).label || it.condition)}</td><td class="num">${esc(moneyCents(it.value))}</td><td class="num">${esc(moneyCents(VAL.lineTotal(it)))}</td><td><button class="btn btn-ghost btn-sm" type="button" data-dn-remove="${i}" aria-label="Remove item">✕</button></td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="actions"><span><b>Total ${esc(moneyCents(dnTotal))}</b> · ${VAL.count(D.items)} ${VAL.count(D.items) === 1 ? 'item' : 'items'}${th.appraisal ? ' · <span class="pill pill-warn">check the appraisal rule over $5,000</span>' : th.form8283 ? ' · <span class="pill pill-act">Form 8283 over $500</span>' : ''}</span><button class="btn btn-primary btn-sm" type="button" id="dnLog" ${D.items.length ? '' : 'disabled'}>Log donation</button></div>
      <p class="note small" style="margin-top:8px">Values are typical thrift-shop ranges, the kind Goodwill and The Salvation Army publish, for items in good used condition or better, which is the IRS minimum for clothing and household goods. You set each value; the itemized list is saved with the entry as your record. Keep the charity's receipt too.</p>
    </details>`;
  }
  function bindCalculators() {
    const sq = $('#calcSqft'), out = $('#calcHomeOut'), btn = $('#calcHomeLog');
    if (!sq) return;
    const calc = () => { const n = homeOfficeSqft(state.calc.sqft); const amt = n * 5; out.textContent = money(amt); btn.disabled = !(amt > 0); return { n, amt }; };
    sq.addEventListener('input', () => { state.calc.sqft = sq.value; calc(); });
    btn.onclick = () => { const { n, amt } = calc(); if (!amt) return; state.calc.sqft = ''; prefillCapture({ lineId: 'se.other', amount: amt, description: `Home office, simplified method: ${n} sq ft × $5`, date: todayInYear() }); };
    bindDonationTool();
  }
  function bindDonationTool() {
    const D = state.donation; if (!D || !$('#dnItem')) return;
    const item = $('#dnItem'), qty = $('#dnQty'), cond = $('#dnCond'), val = $('#dnValue'), hint = $('#dnHint');
    const current = () => catalogMatch(item.value);
    const refreshHint = () => {
      const c = current();
      // no match: the suggestion left over from the last item must not stay in the box and be saved for this one
      if (!c) { hint.textContent = item.value.trim() ? 'Not in the catalog; enter your own fair-market value.' : 'Pick an item to see its typical thrift-shop range.'; if (!val.dataset.touched) val.value = ''; return; }
      const sug = VAL.suggestValue(c, cond.value);
      hint.textContent = `${c.name}: typically ${catalogRange(c)}. Suggested in ${cond.options[cond.selectedIndex].text.toLowerCase()} condition: ${moneyCents(sug)}.`;
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
      const v = amountTyped(val.value);
      if (!typed) { toast('Type the item first.'); return; }
      if (amountProblem(v, 'a value')) { toast('Enter a value for each item, below a billion.'); return; }
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
  /**
   * The trips a log may show. A trip whose ledger entry has been deleted is not on the return any
   * more, and a mileage log that keeps it claims miles the worksheet does not; a trip that was
   * never linked to an entry is kept, so a hand-made or imported row is never hidden.
   */
  function liveTrips(trips) {
    const live = new Set(state.entries.map((e) => e.id));
    return (trips || []).filter((t) => !t.entryId || live.has(t.entryId));
  }

  function placeOptions(selectedId, includeCurrent) {
    const sorted = state.places.slice().sort((a, b) => (a.category === 'home' ? -1 : b.category === 'home' ? 1 : a.name.localeCompare(b.name)));
    return `<option value="">Choose…</option>${includeCurrent ? `<option value="__current" ${selectedId === '__current' ? 'selected' : ''}>Current location</option>` : ''}${sorted.map((p) => `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}${p.category === 'home' ? ' (home)' : ''}</option>`).join('')}`;
  }
  /** Time at the wheel: a pause for an appointment is not driving time, so it comes off the clock. */
  function elapsedText(startedAt, endedAt, pausedMs) {
    if (!startedAt) return '00:00';
    const s = Math.max(0, Math.floor(((endedAt || Date.now()) - startedAt - Math.max(0, Number(pausedMs) || 0)) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  /** Everything the recorder has spent paused, including a pause still running. */
  const pausedSoFar = (rec) => (rec ? (Number(rec.pausedMs) || 0) + (rec.pausedAt ? Date.now() - rec.pausedAt : 0) : 0);

  function tripModeHTML() {
    const T = state.trip, rec = state.recorder;
    const year = Number(state.settings.taxYear);
    const trips = liveTrips(state.trips).filter((t) => Number(t.taxYear) === year).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
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
        <p class="note small" style="margin-top:8px">Round trip doubles a distance the app measured for you. When you type or record the miles yourself, enter the total you drove; the box then only labels the trip.</p>
        <p class="note" id="tripResult" role="status" aria-live="polite" style="margin-top:8px">${esc(T.result || '')}</p>
        <div class="grid-2" style="margin-top:8px">
          <label class="field"><span>Miles, total</span><input id="tripMiles" inputmode="decimal" value="${esc(T.miles)}" placeholder="0.0"></label>
          <label class="field"><span>Worksheet line</span><select id="tripLine" class="input">${MILES_LINES.map((id) => `<option value="${id}" ${T.lineId === id ? 'selected' : ''}>${esc(S.getLine(id).label)} · ${esc(S.getLine(id).sectionTitle)}</option>`).join('')}</select></label>
        </div>
        <div class="actions"><button class="btn btn-primary" type="button" id="tripLog" ${recState !== 'idle' ? 'disabled' : ''}>Log trip</button><span class="muted small" id="tripHint">${recState !== 'idle' ? 'Stop the GPS recording first.' : ''}</span></div>
      </section>

      <section class="card">
        <div class="card-head"><h2>Record with GPS</h2><span class="pill ${recState === 'recording' ? 'pill-good' : recState === 'paused' ? 'pill-act' : 'pill-info'}">${recState}</span></div>
        <p class="note">Start when you leave, stop when you arrive. Positions stay on this device with the trip they belong to, and the screen stays awake while recording.</p>
        <div class="rec-readout"><span class="rec-miles" id="recMiles">${rec ? rec.miles.toFixed(1) : '0.0'}</span><span class="rec-unit">mi</span><span class="rec-time" id="recTime">${rec ? elapsedText(rec.startedAt, rec.state === 'idle' ? rec.endedAt : null, pausedSoFar(rec)) : '00:00'}</span></div>
        <canvas id="trackCanvas" class="track" width="640" height="200" role="img" aria-label="Sketch of the recorded track"></canvas>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-primary" type="button" id="recStart" ${recState === 'recording' ? 'disabled' : ''}>${recState === 'paused' ? 'Resume' : 'Start'}</button>
          <button class="btn" type="button" id="recPause" ${recState === 'recording' ? '' : 'disabled'}>Pause</button>
          <button class="btn btn-danger" type="button" id="recStop" ${recState === 'idle' ? 'disabled' : ''}>Stop and use</button>
        </div>
        <p class="note small" id="recError" role="status" aria-live="polite" style="margin-top:8px">${esc(rec && rec.error ? rec.error : (G.hasGeolocation() ? '' : 'This device does not offer location; measure between saved places or enter miles by hand.'))}</p>
      </section>

      <section class="card">
        <div class="card-head"><h2>Your places</h2><button class="btn btn-sm" type="button" id="addPlace">Add place</button></div>
        ${state.places.length ? `<div class="place-list">${state.places.slice().sort((a, b) => (a.category === 'home' ? -1 : b.category === 'home' ? 1 : a.name.localeCompare(b.name))).map((p) => `<div class="place-row"><div class="place-main"><b>${esc(p.name)}${p.sample ? '<span class="sample-tag">EXAMPLE</span>' : ''}</b><span class="muted small">${esc(CAT_LABEL(p.category))}${p.address ? ' · ' + esc(p.address) : ''}</span></div><div class="btn-row"><a class="btn btn-sm btn-ghost" href="${esc(G.osmLink(p.lat, p.lon))}" target="_blank" rel="noopener">Map</a><button class="btn btn-sm btn-ghost" type="button" data-place-edit="${esc(p.id)}">Edit</button></div></div>`).join('')}</div>` : '<p class="note">No places yet. Add home first, then the places you drive to for medical care, business, or volunteering. A place\'s category picks the worksheet line for you.</p>'}
      </section>

      <section class="card">
        <div class="card-head"><h2>Mileage log ${year}</h2><button class="btn btn-sm" type="button" id="exportTrips" ${trips.length || yearEntries().some((e) => S.isMiles(e.lineId)) ? '' : 'disabled'}>Export log</button></div>
        ${trips.length ? `<div class="table-wrap"><table class="table-twin trips"><thead><tr><th>Date</th><th>Trip</th><th>Purpose</th><th class="num">Miles</th><th>Line</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody>${trips.map((t) => `<tr><td>${esc(P.formatDate(t.date, false))}</td><td>${esc(t.fromLabel || '?')} → ${esc(t.toLabel || '?')}${t.roundTrip ? ' ↩' : ''}<br><span class="muted small">${esc(METHOD_SHORT[t.method] || t.method || '')}</span></td><td>${esc(t.purpose || '')}</td><td class="num">${esc(String(t.miles))}</td><td class="small">${esc(S.getLine(t.lineId) ? S.getLine(t.lineId).label : '')}</td><td><button class="btn btn-ghost btn-sm" type="button" data-trip-del="${esc(t.id)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="note">Trips logged here become entries on the mileage lines and rows in this log, which exports the way the IRS expects it: date, destination, purpose, miles.</p>'}
      </section>`;
  }

  function bindTripMode() {
    const T = state.trip;
    const root = $('#view-capture');
    const autoLine = () => { const to = state.places.find((p) => p.id === T.toId); const l = to ? G.lineForCategory(to.category) : null; if (l) { T.lineId = l; $('#tripLine').value = l; } };
    // A place changed after "Measure distance": the measured miles, the labels and the method all describe the old pair of places.
    const invalidateMeasure = () => {
      if (!T.oneWay && !T.fromLabel && !T.toLabel) return;
      T.oneWay = null; T.fromLabel = ''; T.toLabel = ''; T.result = '';
      if (T.method === 'road' || T.method === 'estimate') T.method = 'manual';
      const res = $('#tripResult'); if (res) res.textContent = '';
    };
    $('#tripFrom').onchange = (ev) => { T.fromId = ev.target.value; invalidateMeasure(); };
    $('#tripTo').onchange = (ev) => { T.toId = ev.target.value; autoLine(); invalidateMeasure(); };
    $('#tripDate').onchange = (ev) => { T.date = ev.target.value; T.dateTouched = true; };
    $('#tripPurpose').oninput = (ev) => { T.purpose = ev.target.value; };
    $('#tripRound').onchange = (ev) => { T.roundTrip = ev.target.checked; if (T.oneWay) { T.miles = String(T.roundTrip ? G.roundMiles(T.oneWay * 2) : T.oneWay); $('#tripMiles').value = T.miles; } };
    $('#tripMiles').oninput = (ev) => {
      T.miles = ev.target.value;
      // Miles typed over the ones that were measured or recorded are the user's own figure: the log must not still call them a road or GPS distance.
      const produced = T.method === 'gps' ? T.recordedMiles : (T.oneWay ? (T.roundTrip ? G.roundMiles(T.oneWay * 2) : T.oneWay) : null);
      if (produced == null || Number(T.miles) !== Number(produced)) {
        if (T.method === 'gps') { T.points = null; T.startedAt = null; T.endedAt = null; T.recordedMiles = null; }
        T.method = 'manual'; T.oneWay = null; T.result = '';
        const res = $('#tripResult'); if (res) res.textContent = '';
      }
    };
    $('#tripLine').onchange = (ev) => { T.lineId = ev.target.value; };
    $('#tripMeasure').onclick = measureTrip;
    $('#tripLog').onclick = logTrip;
    $('#recStart').onclick = () => startRecording();
    $('#recPause').onclick = () => { if (state.recorder) { state.recorder.pause(); renderCapture(); } };
    $('#recStop').onclick = stopRecording;
    $('#addPlace').onclick = () => openPlaceModal(null);
    $('#exportTrips').onclick = exportMileageLog;
    listen(root, 'click', async (ev) => {
      const b = ev.target.closest('[data-place-edit]');
      if (b) { openPlaceModal(state.places.find((p) => p.id === b.dataset.placeEdit)); return; }
      const d = ev.target.closest('[data-trip-del]');
      if (!d) return;
      // the drive is one thing in two rows: the log row goes with the entry it made, and comes back with it
      const t = state.trips.find((x) => x.id === d.dataset.tripDel); if (!t) return;
      const entry = t.entryId ? state.entries.find((x) => x.id === t.entryId) : null;
      if (!(await confirmDialog('Remove this trip?', `${fmtMiles(t.miles)} on ${P.formatDate(t.date)}${entry ? ' and the entry it made' : ''}. ${entry ? UNDO_HINT : 'The mileage log row is removed for good.'}`, 'Remove', true))) return;
      if (entry) { await deleteWithUndo([entry]); return; }
      try { await DB.deleteTrip(t.id); } catch (err) { toast(`Could not remove it: ${err && err.message ? err.message : 'storage error'}.`, 6000); return; }
      state.trips = state.trips.filter((x) => x.id !== t.id);
      toast('Trip removed.');
      render();
    });
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
        // Say which way the lookup failed: a busy or refused routing service is not the same as no connection, and either way this is an estimate rather than a road distance.
        miles = G.estimateRoadMiles(from, to); method = 'estimate';
        const why = e && e.message === 'offline' ? 'Road routing needs a connection.' : `Road routing was unavailable. ${(e && e.message) || 'The lookup failed.'}`;
        text = `${straight} mi straight line × ${G.ROAD_FACTOR} road factor ≈ ${miles} mi. ${why} This is an estimate, not a road distance; adjust the miles if you know the real one.`;
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
    if (state.recorder && state.recorder.state !== 'idle') { toast('Stop the GPS recording first.'); return; }
    const miles = Number(T.miles);
    if (!(miles > 0)) { toast('Enter or measure the miles first.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(T.date)) { toast('Pick a date.'); return; }
    if (!MILES_LINES.includes(T.lineId)) { toast('Pick a worksheet line.'); return; }
    // The place chosen now names the trip; a label stored by an earlier measurement is only a fallback, for "Current location" and for a place deleted since.
    const nameFor = (id, stored) => {
      if (id === '__current') return stored || 'Current location';
      const p = state.places.find((x) => x.id === id);
      return p ? p.name : (stored || '');
    };
    const fromLabel = nameFor(T.fromId, T.fromLabel);
    const toLabel = nameFor(T.toId, T.toLabel);
    const now = new Date().toISOString();
    const line = S.getLine(T.lineId);
    const route = [fromLabel, toLabel].filter(Boolean).join(' → ');
    const entry = {
      id: DB.uid(), date: T.date, taxYear: Number(T.date.slice(0, 4)), lineId: T.lineId, amount: G.roundMiles(miles),
      description: [T.purpose.trim(), route].filter(Boolean).join(' — ') || line.label,
      note: `${T.roundTrip ? 'Round trip, ' : ''}${METHOD_LABEL[T.method] || T.method}.`, hasReceipt: false, receiptId: null, createdAt: now, updatedAt: now, sample: false,
    };
    const trip = { id: DB.uid(), date: T.date, taxYear: entry.taxYear, fromId: T.fromId, toId: T.toId, fromLabel, toLabel, purpose: T.purpose.trim(), miles: G.roundMiles(miles), roundTrip: !!T.roundTrip, method: T.method, lineId: T.lineId, entryId: entry.id, points: T.points || null, startedAt: T.startedAt, endedAt: T.endedAt, createdAt: now };
    entry.tripId = trip.id; // the edit path finds the drive from the entry, without scanning the whole log
    if (T.saving) return;
    T.saving = true;
    try {
      DB.requestPersistence();
      await DB.putEntry(entry);
      await DB.putTrip(trip);
    } catch (e) {
      await DB.deleteEntry(entry.id).catch(() => {});
      T.saving = false;
      toast(`Could not log the trip: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000);
      return;
    }
    state.entries.push(entry); state.trips.push(trip);
    if (T.purpose.trim()) rememberLine(T.purpose, T.lineId);
    toast(`Logged ${fmtMiles(trip.miles)} → ${line.label}`);
    const keepFrom = T.fromId;
    state.trip = freshTrip(); state.trip.fromId = keepFrom || state.trip.fromId;
    clearInterval(state.recorderTimer); state.recorderTimer = null;
    state.recorder = null;
    clearRecordingCheckpoint();
    render(); // the miles have to reach Recent and the meter, which read the recomputed figures
  }

  function trackColors() {
    const cs = getComputedStyle(document.documentElement);
    return { line: cs.getPropertyValue('--accent').trim() || '#0e6b52', start: cs.getPropertyValue('--accent').trim() || '#0e6b52', end: cs.getPropertyValue('--warn-fill').trim() || '#d03b3b', ink: cs.getPropertyValue('--ink-3').trim() || '#75817a' };
  }
  // A recording lives in memory until the trip is logged, so a reload, a pull-to-refresh or a
  // discarded tab would lose the drive. The recorder hands us the track every few fixes; it is
  // written here and offered back at the next start.
  const RECORDING_KEY = 'itemizer:recording';
  function saveRecordingCheckpoint(cp) {
    try { localStorage.setItem(RECORDING_KEY, JSON.stringify(cp)); } catch (e) { /* no room, or no localStorage: the recording still runs */ }
  }
  function readRecordingCheckpoint() {
    try { const raw = localStorage.getItem(RECORDING_KEY); const cp = raw ? JSON.parse(raw) : null; return cp && Array.isArray(cp.points) ? cp : null; } catch (e) { return null; }
  }
  function clearRecordingCheckpoint() {
    try { localStorage.removeItem(RECORDING_KEY); } catch (e) { /* nothing to clear */ }
  }
  /** Only while a drive is being recorded: the track is in memory, so leaving the page would lose it. Listening no longer than that keeps the page eligible for the back-forward cache. */
  function warnBeforeLeaving(ev) {
    if (!(state.recorder && state.recorder.state !== 'idle')) return;
    ev.preventDefault();
    ev.returnValue = '';
  }
  /** Stop a live recorder (GPS watch, wake lock, timer) and forget it; used wherever the trip form is thrown away. */
  function discardRecorder() {
    if (state.recorder && state.recorder.state !== 'idle') { try { state.recorder.stop(); } catch (e) { /* nothing to release */ } }
    clearInterval(state.recorderTimer); state.recorderTimer = null; state.recorder = null;
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    clearRecordingCheckpoint(); // the drive was thrown away on purpose: it must not come back at the next start
  }
  /** Work that exists only in memory: a live recording, a recorded drive not yet logged, or a capture form with typing or a photo in it. */
  function hasUnsavedWork() {
    const cap = state.capture;
    return !!(state.recorder && state.recorder.state !== 'idle')
      || !!(state.trip && state.trip.points && state.trip.points.length)
      || !!(cap && (cap.dirty || cap.receiptBlob || (cap.text && cap.text.trim()))); // the same three things the "understood" card is shown for
  }
  /** Ask before throwing that work away. `what` is the sentence saying what happens instead. */
  async function confirmDiscardWork(what) {
    if (!hasUnsavedWork()) return true;
    const recording = !!(state.recorder && state.recorder.state !== 'idle');
    const drive = !recording && !!(state.trip && state.trip.points && state.trip.points.length);
    const photo = !!(state.capture && state.capture.receiptBlob);
    const subject = recording ? 'The drive being recorded' : drive ? 'The recorded drive you have not logged yet' : 'The details you have typed';
    return confirmDialog(recording ? 'Stop the recording?' : 'Throw away what you have entered?',
      `${subject}${photo ? ', including the receipt photo you just took,' : ''} will be lost. ${what}`,
      recording ? 'Stop and discard' : 'Discard', true);
  }
  /** Offer back a drive the app was closed on: one still being recorded is resumed, one already stopped goes into the trip form. */
  function offerUnfinishedRecording(cp) {
    if (!cp || !cp.points.length) return;
    const miles = G.roundMiles(G.trackMiles(cp.points));
    const started = cp.startedAt ? new Date(cp.startedAt) : null;
    const when = started ? started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'earlier';
    const openTripForm = () => {
      state.captureMode = 'trip';
      if (!state.trip) state.trip = freshTrip();
      if (cp.startedAt && !state.trip.dateTouched) state.trip.date = isoFromEpoch(cp.startedAt);
    };
    if (cp.state === 'idle') {
      // stopped with "Stop and use", then closed before the trip was logged: the track is nowhere but in the checkpoint
      toast(`A drive of ${fmtMiles(miles)} recorded from ${when} was never logged.`, 60000, { label: 'Use it', onClick: () => {
        clearRecordingCheckpoint();
        openTripForm();
        const T = state.trip;
        T.points = cp.points; T.miles = String(miles); T.recordedMiles = miles; T.method = 'gps'; T.roundTrip = false; T.oneWay = null;
        T.startedAt = cp.startedAt || null; T.endedAt = null;
        T.result = `Recovered ${miles} mi from a drive that was recorded but never logged. Check the miles against what you drove before you log it.`;
        if (state.view === 'capture') renderCapture(); else go('capture');
      } });
      return;
    }
    toast(`The drive from ${when} was interrupted: ${fmtMiles(miles)} so far.`, 60000, { label: 'Resume', altLabel: 'Resume the drive', onClick: () => {
      openTripForm();
      if (state.view !== 'capture') go('capture');
      startRecording(cp); // the miles so far are kept; the stretch the app was closed for is marked as a gap, not driven
    } });
  }
  function drawTrack() {
    const canvas = $('#trackCanvas'); if (!canvas) return;
    // size the buffer from the layout so the sketch is drawn with square pixels at the device's resolution
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 640, h = Math.round(w * 200 / 640) || 200;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const pts = state.recorder ? state.recorder.points : (state.trip && state.trip.points) || [];
    G.sketch(canvas, pts, Object.assign({ dpr }, trackColors()));
  }
  function updateRecorderUI(rec) {
    const m = $('#recMiles'); if (m) m.textContent = rec.miles.toFixed(1);
    const t = $('#recTime'); if (t) t.textContent = elapsedText(rec.startedAt, rec.state === 'idle' ? rec.endedAt : null, pausedSoFar(rec));
    const e = $('#recError'); if (e) e.textContent = rec.error || (rec.waiting && rec.state === 'recording' ? 'Waiting for a GPS fix…' : '');
    drawTrack();
  }
  const recorderHandlers = () => ({ onUpdate: updateRecorderUI, onCheckpoint: saveRecordingCheckpoint, onError: (msg, rec) => { updateRecorderUI(rec); toast(msg); if (rec.state === 'idle') { clearInterval(state.recorderTimer); renderCapture(); } } });
  /** `resumeFrom` is a checkpoint of a drive the app was closed on: the recorder carries that same trip on rather than starting a new one. */
  function startRecording(resumeFrom) {
    if (resumeFrom) state.recorder = G.createRecorder(recorderHandlers(), resumeFrom);
    else if (!state.recorder || state.recorder.state === 'idle') {
      state.recorder = G.createRecorder(recorderHandlers());
    }
    const ok = state.recorder.start();
    if (!ok) { toast(state.recorder.error || 'Location is not available.'); return; }
    window.addEventListener('beforeunload', warnBeforeLeaving);
    clearInterval(state.recorderTimer);
    state.recorderTimer = setInterval(() => { const t = $('#recTime'); if (t && state.recorder && state.recorder.state === 'recording') t.textContent = elapsedText(state.recorder.startedAt, null, pausedSoFar(state.recorder)); }, 1000);
    renderCapture();
  }
  function stopRecording() {
    const rec = state.recorder; if (!rec) return;
    clearInterval(state.recorderTimer);
    const result = rec.stop();
    const T = state.trip;
    T.points = result.points; T.miles = String(result.miles); T.method = 'gps'; T.roundTrip = false; T.oneWay = null;
    T.recordedMiles = result.miles; // what the recorder produced, so a hand-edit of the miles can be told apart from it
    T.startedAt = result.startedAt; T.endedAt = result.endedAt;
    T.result = `Recorded ${result.miles} mi over ${elapsedText(result.startedAt, result.endedAt, result.pausedMs)} (${result.points.length} positions kept). Pick the places and purpose, then log it.`;
    // The drive dates the trip, not whatever the form was showing: the app may have been left open since yesterday.
    const drivenOn = result.startedAt ? isoFromEpoch(result.startedAt) : '';
    if (drivenOn && !T.dateTouched) T.date = drivenOn;
    if (T.date && Number(T.date.slice(0, 4)) !== Number(state.settings.taxYear)) T.result += ` This trip is dated ${P.formatDate(T.date)}, which is not in tax year ${state.settings.taxYear}; change the year in the header to deduct it.`;
    // The checkpoint stays: between "Stop and use" and "Log trip" the track is still only in this tab's memory, and
    // stop() has just written it back with state 'idle' so a reload can offer it again. logTrip and discardRecorder clear it.
    window.removeEventListener('beforeunload', warnBeforeLeaving);
    toast(result.miles > 0 ? `Recorded ${result.miles} mi.` : 'No movement was recorded.');
    renderCapture();
    window.scrollTo({ top: 0 });
    if (offerWaitingUpdate) offerWaitingUpdate(); // a new version that arrived mid-drive can be offered now
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
        <div class="span-2 geo-candidates" id="plCands" role="status" aria-live="polite"></div>
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
      if (del) del.onclick = async () => {
        closeModal();
        if (!(await confirmDialog('Delete this place?', `${p.name} will be removed. Trips already logged keep their miles.`, 'Delete', true))) return;
        try { await DB.deletePlace(p.id); } catch (e) { toast(`Could not delete the place: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000); render(); return; }
        state.places = state.places.filter((x) => x.id !== p.id); toast('Place deleted.'); renderCapture();
      };
      panel.querySelector('#plSave').onclick = async () => {
        const name = panel.querySelector('#plName').value.trim();
        // both boxes are read as text first: Number('') is 0, which would file a place in the Gulf of Guinea
        const latText = panel.querySelector('#plLat').value.trim(), lonText = panel.querySelector('#plLon').value.trim();
        const lat = Number(latText), lon = Number(lonText);
        if (!name) { toast('Give the place a name.'); return; }
        if (latText === '' || lonText === '' || !(isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Find the address or use your current location so the place has coordinates.'); return; }
        const saved = { id: p.id || DB.uid(), name, category: panel.querySelector('#plCat').value, address: panel.querySelector('#plAddr').value.trim(), lat, lon, note: p.note || '', sample: false, updatedAt: new Date().toISOString() };
        try { await DB.putPlace(saved); } catch (e) { toast(`Could not save the place: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000); return; }
        state.places = state.places.filter((x) => x.id !== saved.id).concat([saved]);
        closeModal(); toast('Place saved.'); renderCapture();
      };
    });
  }

  function exportMileageLog() {
    const year = Number(state.settings.taxYear);
    const P0 = state.computed.params;
    const rows = [['date', 'from', 'to', 'round_trip', 'purpose', 'miles', 'how_measured', 'worksheet_line', 'rate_per_mile', 'dollar_value'].join(',')];
    const covered = new Set();
    for (const t of liveTrips(state.trips).filter((x) => Number(x.taxYear) === year).sort((a, b) => a.date.localeCompare(b.date))) {
      // the rate is the one in force on the day of the drive: 2026 changed its rates on July 1
      const line = S.getLine(t.lineId); const rate = R.mileageRate(P0, line && line.rate, t.date);
      covered.add(t.entryId);
      rows.push([DB.csvEscape(t.date), DB.csvText(t.fromLabel), DB.csvText(t.toLabel), t.roundTrip ? 'yes' : 'no', DB.csvText(t.purpose), Number(t.miles) || 0, DB.csvText(METHOD_LABEL[t.method] || t.method), DB.csvEscape(line ? line.label : ''), rate, R.cents((Number(t.miles) || 0) * rate).toFixed(2)].join(','));
    }
    for (const e of yearEntries().filter((x) => S.isMiles(x.lineId) && !covered.has(x.id)).sort((a, b) => a.date.localeCompare(b.date))) {
      const line = S.getLine(e.lineId); const rate = R.mileageRate(P0, line.rate, e.date);
      rows.push([DB.csvEscape(e.date), '', '', '', DB.csvText(e.description), Number(e.amount) || 0, 'entered by hand', DB.csvEscape(line.label), rate, R.cents((Number(e.amount) || 0) * rate).toFixed(2)].join(','));
    }
    downloadText(`itemizer-mileage-log-${year}.csv`, rows.join('\r\n'), 'text/csv');
  }

  // ---- statement import ---------------------------------------------------------------
  const IMPORT_PAGE = 150; // a year of card rows is well over a thousand; a select per row for all of them is megabytes of markup on a phone
  /** The worksheet line as a button. It becomes a real select when pressed, so only the rows the user touches carry 61 options. */
  function impLineButtonHTML(r, i) {
    const line = r.lineId && S.getLine(r.lineId);
    return `<button class="btn btn-sm" type="button" data-imp-line-open="${i}" aria-label="${esc(`Worksheet line for ${r.description || 'this row'}`)}">${esc(line ? line.label : 'Choose a line')}</button>`;
  }
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
    const shown = Math.min(I.rows.length, I.shown || IMPORT_PAGE);
    const twoCol = I.map.debit >= 0 || I.map.credit >= 0;
    return `
      <section class="card">
        <div class="card-head"><h2>${esc(I.fileName)}</h2><span class="muted small">${I.rows.length} ${plural(I.rows.length, 'row')} read${I.skipped ? ` · <span class="pill pill-warn" title="Rows with no readable date or amount">${I.skipped} skipped</span>` : ''}${I.remembered ? ' · <span class="pill pill-info">layout remembered</span>' : ''}</span></div>
        <div class="grid-3">
          <label class="field"><span>Date column</span>${colSelect('impDate', I.map.date)}</label>
          <label class="field"><span>Description column</span>${colSelect('impDesc', I.map.description)}</label>
          ${twoCol ? `<label class="field"><span>Debit column</span>${colSelect('impDebit', I.map.debit, true)}</label><label class="field"><span>Credit column</span>${colSelect('impCredit', I.map.credit, true)}</label>` : `<label class="field"><span>Amount column</span>${colSelect('impAmount', I.map.amount)}</label><label class="field"><span>Debit/credit indicator column</span>${colSelect('impType', I.map.type, true)}</label>`}
        </div>
        <div class="chips" style="margin-top:10px">
          ${twoCol || I.map.type >= 0 ? '' : `<label class="check"><input type="checkbox" id="impNeg" ${I.spendIsNegative ? 'checked' : ''}> Spending is shown as negative</label>`}
          <label class="check"><input type="checkbox" id="impHeader" ${I.map.headerRow ? 'checked' : ''}> ${I.map.headerIndex ? `Row ${I.map.headerIndex + 1} is the header` : 'First row is a header'}</label>
          <label class="check"><input type="checkbox" id="impDayFirst" ${I.map.dayFirst ? 'checked' : ''}> Day comes before month</label>
          <button class="btn btn-sm btn-ghost" type="button" id="impReset">Choose another file</button>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Review</h2><div class="btn-row"><button class="btn btn-sm" type="button" id="impSelectSuggested">Tick all with a suggestion</button><button class="btn btn-sm btn-ghost" type="button" id="impClear">Untick all</button></div></div>
        ${I.rows.length ? `<div class="table-wrap"><table class="table-twin import"><thead><tr><th></th><th>Date</th><th>Description</th><th class="num">Amount</th><th>Worksheet line</th></tr></thead><tbody>
          ${I.rows.slice(0, shown).map((r, i) => `<tr class="${r.duplicate || r.refund ? 'is-dupe' : ''}"><td><input type="checkbox" data-imp-sel="${i}" ${r.selected ? 'checked' : ''} ${r.refund ? 'disabled' : ''} aria-label="${esc(`Add ${P.formatDate(r.date, false)} ${r.description || 'row'}`)}"></td><td class="small">${esc(P.formatDate(r.date, false))}</td><td><div class="imp-desc">${esc(r.description || '(no description)')}</div>${r.memo ? `<div class="muted small">${esc(r.memo)}</div>` : ''}${r.duplicate ? '<span class="pill pill-info">already logged</span> ' : ''}${r.possibleDuplicate ? '<span class="pill pill-info" title="An entry with this date and amount exists but has no description">same amount logged that day</span> ' : ''}${r.refund ? '<span class="pill pill-info">payment or refund</span> ' : ''}${r.nonDeductible.length ? `<span class="pill pill-act" title="${esc(r.nonDeductible[0].reason)}">probably not deductible</span>` : ''}${r.lineId && !r.strong && !r.refund ? '<span class="pill pill-info" title="The match is weak, so the row is not ticked for you">weak match</span>' : ''}</td><td class="num">${esc(moneyCents(Math.abs(r.amount)))}</td><td>${r.refund ? '' : impLineButtonHTML(r, i)}${r.because.length ? `<div class="because">${esc(r.because.join(', '))}</div>` : ''}</td></tr>`).join('')}
        </tbody></table></div>${I.rows.length > shown ? `<div class="btn-row" style="margin-top:10px"><button class="btn btn-sm" type="button" id="impMore">Show ${Math.min(IMPORT_PAGE, I.rows.length - shown)} more</button><span class="muted small">Showing the first ${shown} of ${I.rows.length} rows. Rows further down are still counted and still added.</span></div>` : ''}` : '<p class="note">No rows with a date and an amount were found. Check the column mapping above.</p>'}
        <div class="actions"><button class="btn btn-primary" type="button" id="impAdd" ${selected ? '' : 'disabled'}>Add ${selected} ${selected === 1 ? 'entry' : 'entries'}</button><span class="muted small">Descriptions come from the statement; edit them later in the ledger.</span></div>
      </section>`;
  }
  function rebuildImport() {
    const I = state.importer; if (!I) return;
    I.shown = IMPORT_PAGE;
    const norm = IMP.normalize(I.raw, I.map, { spendIsNegative: I.spendIsNegative });
    I.spendIsNegative = norm.spendIsNegative;
    I.skipped = norm.skipped;
    // Schedule C lines are pre-ticked only when the ledger already shows self-employment; a coffee is not a business meal by default
    const hasBusiness = !!(state.computed && state.computed.scheduleC && state.computed.scheduleC.hasActivity);
    I.rows = IMP.review(norm.rows, { learned: state.learned, weights: activeWeights(), existingEntries: state.entries, hasBusiness });
    const headerRow = I.raw[I.map.headerIndex || 0] || I.raw[0] || [];
    I.headers = I.map.headerRow ? headerRow : headerRow.map((_, i) => `Column ${i + 1}`);
  }
  /**
   * Statement exports are not all UTF-8: Excel's "Unicode Text" is UTF-16 and older bank
   * exports are Windows-1252. Read as UTF-8 the first gives no usable columns at all and the
   * second turns an accented payee into replacement characters, which then go into the ledger.
   */
  function decodeStatement(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    // No mark: ASCII written as UTF-16 leaves a zero byte beside every character, on the odd side for little-endian and the even side for big.
    const head = bytes.subarray(0, 1024);
    let odd = 0, even = 0;
    for (let i = 0; i < head.length; i++) if (head[i] === 0) { if (i % 2) odd++; else even++; }
    if (odd > head.length / 8 && odd > even * 4) return new TextDecoder('utf-16le').decode(bytes);
    if (even > head.length / 8 && even > odd * 4) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }
  async function onCSVFile(file) {
    if (!file) return;
    let text;
    try { text = decodeStatement(new Uint8Array(await file.arrayBuffer())); } catch (e) { toast('Could not read that file.'); return; }
    const raw = IMP.parseCSV(text);
    if (raw.length < 1) { toast('That file has no rows.'); return; }
    const map = IMP.detectColumns(raw);
    const signature = IMP.headerSignature(raw[map.headerIndex || 0]);
    const remembered = map.headerRow ? state.layouts[signature] : null;
    if (remembered && remembered.map) Object.assign(map, remembered.map);
    state.importer = { fileName: file.name, raw, map, spendIsNegative: remembered ? remembered.spendIsNegative : undefined, headers: [], rows: [], shown: IMPORT_PAGE, signature, remembered: !!remembered };
    rebuildImport();
    state.captureMode = 'import';
    renderCapture();
    const I = state.importer;
    // nothing readable at all is usually the columns or the character set, and the mapping controls cannot fix the second
    if (!I.rows.length && I.skipped) toast('No rows had both a date and an amount. Check the column choices below; if they look right, the file may be saved in a character set Itemizer could not read — export it again as CSV.', 10000);
    else toast(`${I.rows.length} ${plural(I.rows.length, 'row')} read, ${I.rows.filter((r) => r.selected).length} ${plural(I.rows.filter((r) => r.selected).length, 'has', 'have')} a strong match.${remembered ? ' Column layout remembered from last time.' : ''}`);
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
    const ty = $('#impType'); if (ty) ty.onchange = (ev) => remap('type', ev.target.value);
    $('#impDayFirst').onchange = (ev) => { I.map.dayFirst = ev.target.checked; rebuildImport(); renderCapture(); };
    const neg = $('#impNeg'); if (neg) neg.onchange = (ev) => { I.spendIsNegative = ev.target.checked; rebuildImport(); renderCapture(); };
    $('#impHeader').onchange = (ev) => { I.map.headerRow = ev.target.checked; I.spendIsNegative = undefined; rebuildImport(); renderCapture(); };
    $('#impReset').onclick = () => { state.importer = null; renderCapture(); };
    const root = $('#view-capture');
    const updateImpAdd = () => { const btn = $('#impAdd'); if (!btn) return; const n = I.rows.filter((r) => r.selected).length; btn.disabled = !n; btn.textContent = `Add ${n} ${n === 1 ? 'entry' : 'entries'}`; };
    // ticking every row is a change to the checkboxes, not to the table: rebuilding it would re-create the whole review for nothing
    const syncImpChecks = () => { $$('[data-imp-sel]', root).forEach((cb) => { cb.checked = !!I.rows[Number(cb.dataset.impSel)].selected; }); updateImpAdd(); };
    $('#impSelectSuggested').onclick = () => { I.rows.forEach((r) => { r.selected = !!r.lineId && !r.refund && !r.duplicate; }); syncImpChecks(); };
    $('#impClear').onclick = () => { I.rows.forEach((r) => { r.selected = false; }); syncImpChecks(); };
    const more = $('#impMore'); if (more) more.onclick = () => { I.shown = (I.shown || IMPORT_PAGE) + IMPORT_PAGE; renderCapture(); };
    listen(root, 'click', (ev) => {
      // the line cell is a button until it is pressed; pressing it puts the real select in its place, with the same accessible name
      const open = ev.target.closest('[data-imp-line-open]'); if (!open) return;
      const i = open.dataset.impLineOpen, cell = open.parentNode, label = open.getAttribute('aria-label') || '';
      open.outerHTML = lineSelectHTML(`impLine${i}`, I.rows[Number(i)].lineId, label).replace('<select ', `<select data-imp-line="${i}" `);
      const sel = cell.querySelector(`[data-imp-line="${i}"]`); if (sel) sel.focus();
    });
    listen(root, 'change', (ev) => {
      const sel = ev.target.closest('[data-imp-sel]'); if (sel) { I.rows[Number(sel.dataset.impSel)].selected = sel.checked; updateImpAdd(); return; }
      const line = ev.target.closest('[data-imp-line]'); if (line) { const r = I.rows[Number(line.dataset.impLine)]; r.lineId = line.value; if (r.lineId && !r.selected) { r.selected = true; const cb = root.querySelector(`[data-imp-sel="${line.dataset.impLine}"]`); if (cb) cb.checked = true; } updateImpAdd(); }
    });
    $('#impAdd').onclick = async () => {
      const chosen = I.rows.filter((r) => r.selected && r.lineId && S.getLine(r.lineId) && r.amount > 0);
      if (!chosen.length) { toast('Tick at least one row with a worksheet line.'); return; }
      if (I.adding) return;
      I.adding = true;
      const now = new Date().toISOString();
      const entries = chosen.map((r) => ({ id: DB.uid(), date: r.date, taxYear: Number(r.date.slice(0, 4)), lineId: r.lineId, amount: Math.round(r.amount * 100) / 100, description: r.description, note: r.memo ? `Statement category: ${r.memo}` : 'Imported from a statement', hasReceipt: false, receiptId: null, createdAt: now, updatedAt: now, sample: false, source: 'import' }));
      try { await DB.putEntries(entries); } catch (e) { I.adding = false; toast(`Could not save the rows: ${e && e.message ? e.message : 'storage error'}. Nothing was added.`, 6000); return; }
      state.entries.push(...entries);
      for (const r of chosen) if (r.description) rememberLine(r.description, r.lineId);
      for (const r of chosen) learnFromChoice(r.suggestions, r.lineId);
      if (I.map.headerRow && I.signature) {
        // the layout chosen for this statement header: one row per header
        const layout = { signature: I.signature, map: { date: I.map.date, description: I.map.description, amount: I.map.amount, debit: I.map.debit, credit: I.map.credit, type: I.map.type, memo: I.map.memo, headerRow: true, headerIndex: I.map.headerIndex || 0, dayFirst: !!I.map.dayFirst } };
        if (typeof I.spendIsNegative === 'boolean') layout.spendIsNegative = I.spendIsNegative;
        state.layouts[I.signature] = layout;
        try { await DB.putLayout(layout); } catch (e) { /* the rows are saved; remembering the layout is a convenience */ }
      }
      state.importer = null; state.captureMode = 'expense';
      const noun = entries.length === 1 ? 'entry' : 'entries';
      const years = [...new Set(entries.map((e) => e.taxYear))].sort();
      const cur = Number(state.settings.taxYear);
      if (years.length === 1 && years[0] !== cur) {
        // otherwise the ledger opens on the selected year and says nothing is logged, right after a successful import
        toast(`Added ${entries.length} ${noun} from the statement, all dated ${years[0]}. The tax year is now ${years[0]}.`, 10000);
        await setTaxYear(years[0]).catch(() => {});
      } else if (years.some((y) => y !== cur)) {
        const other = entries.filter((e) => e.taxYear !== cur).length;
        toast(`Added ${entries.length} ${noun} from the statement. ${other} of them are dated outside ${cur}; use the tax year menu at the top to see those.`, 10000);
      } else toast(`Added ${entries.length} ${noun} from the statement.`);
      go('ledger');
    };
  }

  // ---- calendar export --------------------------------------------------------------
  /** A lone carriage return would end the content line early, and the other control characters mean nothing in a calendar text value. */
  function icsEscape(s) { return String(s || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n'); }
  /** Calendar lines are folded at 75 octets, continuing with a leading space, and never split inside a character. */
  function icsFold(line) {
    const width = (ch) => { const c = ch.codePointAt(0); return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; };
    const out = [];
    let cur = '', n = 0;
    for (const ch of line) {
      const w = width(ch);
      if (n + w > 75) { out.push(cur); cur = ' '; n = 1; }
      cur += ch; n += w;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  /** A calendar client keeps events by their UID, so the same reminder has to carry the same one every time it is exported. */
  const uidToken = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'payee';
  /**
   * The estimated-tax due date for a quarter. The IRS moves a due date that falls on a Saturday,
   * Sunday or legal holiday to the next business day. Only two holidays can meet these dates:
   * Martin Luther King Day (the third Monday in January) and Emancipation Day in Washington DC
   * (April 16, kept on the Friday before when it falls on a Saturday and the Monday after when it falls on a Sunday).
   */
  function estimatedDueDate(year, monthDay) {
    const iso = (d) => d.toISOString().slice(0, 10);
    const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const holidays = new Set([`${year}-01-${String(1 + ((8 - jan1) % 7) + 14).padStart(2, '0')}`]);
    const apr16 = new Date(Date.UTC(year, 3, 16)).getUTCDay();
    holidays.add(apr16 === 6 ? `${year}-04-15` : apr16 === 0 ? `${year}-04-17` : `${year}-04-16`);
    let d = new Date(`${year}-${monthDay}T00:00:00Z`);
    for (let i = 0; i < 7; i++) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6 && !holidays.has(iso(d))) break;
      d = new Date(d.getTime() + 86400000);
    }
    return iso(d);
  }
  /** The calendar file, or null when nothing is due: a calendar with no events in it is not a file any client will take. */
  function icsText() {
    const adv = state.advice, year = Number(state.settings.taxYear), today = P.todayISO();
    const events = [];
    for (const r of adv.recurrences) {
      // the advisor has already stopped expecting a lapsed or dismissed payee, and a reminder would contradict it
      if (r.status === 'lapsed' || r.muted) continue;
      for (const d of r.expected) if (d >= today) events.push({ uid: `itemizer-${uidToken(r.lineId + '-' + r.key)}-${d.replace(/-/g, '')}`, date: d, summary: `${r.description} (${r.unit === 'miles' ? r.typicalAmount + ' mi' : money(r.typicalAmount)})`, desc: `Usually ${r.cadenceLabel}. Log it in Itemizer when paid.` });
    }
    events.push({ uid: `itemizer-yearend-${year}`, date: `${year}-12-31`, summary: 'Last day for deductible payments this tax year', desc: `Property tax, gifts, and medical bills paid by today count for ${year}.` });
    if (state.computed.scheduleC.hasActivity || state.computed.lines['tax.state_income'].count) {
      [[estimatedDueDate(year, '04-15'), 'Q1'], [estimatedDueDate(year, '06-15'), 'Q2'], [estimatedDueDate(year, '09-15'), 'Q3'], [estimatedDueDate(year + 1, '01-15'), 'Q4']]
        .forEach(([d, q]) => events.push({ uid: `itemizer-est-${year}-${q.toLowerCase()}`, date: d, summary: `Estimated tax payment ${q} due`, desc: 'Federal, and usually state, estimated payment. A state payment made by Dec 31 counts this year.' }));
    }
    const due = events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
    if (!due.length) return null;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Itemizer//EN', 'CALSCALE:GREGORIAN'];
    due.forEach((e) => {
      const d = e.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:${e.uid}@itemizer.local`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:${icsEscape(e.summary)}`, `DESCRIPTION:${icsEscape(e.desc)}`, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(icsFold).join('\r\n');
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
      const at = P.todayISO();
      // the row is written before the card is treated as dismissed: otherwise a failed write leaves the screen and the store disagreeing, silently
      try { await DB.putDismissal(id, at); } catch (e) { toast(`Could not dismiss that: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      state.dismissed[id] = at; // one row per dismissed recommendation
      // a recurrence is muted for its own period, which for a quarterly or annual payee is far longer than thirty days
      toast(id.startsWith('recur:') ? 'Dismissed. It stays out of the forecast until it is logged again.' : 'Dismissed for 30 days.');
      render();
      // the card that had focus is gone; move to the next recommendation rather than dropping focus to the top of the page
      const next = $(`#view-${state.view} [data-rec-act]`);
      if (next) next.focus({ preventScroll: true });
      else { const h = $(`#view-${state.view} h2`); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
      return;
    }
    const a = rec.action || {};
    if (a.type === 'prefill') prefillCapture(a.entry);
    else if (a.type === 'edit') openEdit(a.entryId);
    else if (a.type === 'ledger') { state.ledger.filter = normalizeLedgerFilter(a.filter || 'all'); go('ledger', a.filter ? { filter: a.filter } : null); }
    else if (a.type === 'capture') { state.captureMode = 'expense'; go('capture'); if (state.view === 'capture') renderCapture(); setTimeout(() => { const q = $('#quickInput'); if (q) q.focus(); }, 50); }
    else if (a.type === 'settings') go('settings');
  }

  /** Start a capture with the fields already filled; the user reviews and saves. */
  function prefillCapture(entry) {
    state.captureMode = 'expense'; // the prefilled form lives in expense mode, wherever the user was
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
    if (!cap.pinned.has('line')) cap.lineId = pickDefaultLine(cap.suggestions, parsed.miles != null);
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
    updateSaveHint();
  }
  const AUTO_PICK_SCORE = 0.9; // below this the classifier is guessing at the section, not the line
  /**
   * The line to fill in from a set of suggestions, or null. A lone candidate used to be taken
   * whatever it scored, so "hair appointment" and "grocery store" — which match only a context
   * word, at 0.4 — were filed on a deductible line by a single press of Enter.
   */
  function pickDefaultLine(suggestions, isMiles) {
    const top = suggestions && suggestions[0];
    if (!top) return null;
    if (top.score >= AUTO_PICK_SCORE) return top.lineId;
    return isMiles ? top.lineId : null; // typed miles score 0.5 by construction and every candidate is a mileage line
  }
  function reclassify() {
    const cap = state.capture;
    // Once "What / who" has been retyped the quick text names the payee that was replaced; classifying both would keep filing against the old one.
    const textForClass = cap.pinned.has('description') ? cap.description : [cap.description, cap.parsed && cap.parsed.raw !== cap.description ? cap.text : ''].filter(Boolean).join(' ');
    const res = C.classify(textForClass, { learned: state.learned, description: cap.description, weights: activeWeights(), miles: cap.parsed ? cap.parsed.miles != null : false, limit: 4 });
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
  const MAX_AMOUNT = 1e9; // "1e400" and "Infinity" both read as a number and turn every total on the worksheet into infinity
  /** An amount as people write it: "1,200", "$40", " 40 ". The quick box already accepts all three, so the fields have to as well. */
  const amountTyped = (v) => Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  /** The problem with a typed figure, or null: used wherever an amount, a mileage or a value is read from a box. */
  function amountProblem(v, noun, negativeHint) {
    const n = amountTyped(v);
    // a figure that was typed but came out below nought needs its own words: "enter an amount" reads as though nothing was typed
    if (n < 0 && negativeHint) return negativeHint;
    if (!(n > 0)) return `enter ${noun}`; // empty, nought, negative, or not a number at all
    if (!(n <= MAX_AMOUNT)) return 'enter a figure below a billion'; // "1e400" and "Infinity" land here rather than on the worksheet
    return null;
  }
  /** A dollar figure from a settings box: "$95,000" reads as "95000"; "95k" and "9.5.3" read as nothing at all (null), and an empty box as "". */
  function parseDollarField(text) {
    const raw = String(text == null ? '' : text).replace(/[$,\s]/g, '');
    if (raw === '') return '';
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null; // letters are refused, not deleted: "95k" stripped to "95" would put the medical floor at $7
    return String(Number(raw));
  }
  /** The business-use share as typed. "33.3" is a real split; "125", "0" and "abc" are not a share at all. */
  function parseShare(text) {
    const n = Number(String(text == null ? '' : text).trim());
    if (!(Number.isFinite(n) && n > 0 && n <= 100)) return { ok: false, share: 0 };
    return { ok: true, share: Math.round(n * 10) / 10 };
  }
  /** That share of an amount, worked in whole cents: 75% of $100.46 is $75.35, not $75.34. */
  function shareAmount(value, share) { return Math.round(Math.round(value * 100) * share / 100) / 100; }

  function captureProblems() {
    const cap = state.capture;
    const problems = [];
    if (!cap.lineId) problems.push('pick a worksheet line');
    const isMiles = cap.lineId && S.isMiles(cap.lineId);
    const amountIssue = amountProblem(isMiles ? cap.miles : cap.amount, isMiles ? 'the miles' : 'an amount', isMiles ? null : 'a refund is not a deductible expense, so enter a positive amount');
    if (amountIssue) problems.push(amountIssue);
    if (!cap.date || !/^\d{4}-\d{2}-\d{2}$/.test(cap.date)) problems.push('pick a date');
    // a share that cannot be read would otherwise file the whole bill at 100% without saying so
    if (!isMiles && cap.share !== '' && !parseShare(cap.share).ok) problems.push('give the business-use share as a percentage between 0 and 100');
    return problems;
  }
  function updateSaveHint() {
    const hint = $('#saveHint'); if (!hint) return;
    const problems = captureProblems();
    const btn = $('#saveBtn');
    // aria-disabled keeps the button reachable by keyboard; pressing it explains what is missing (saveCapture toasts the problems)
    btn.setAttribute('aria-disabled', String(problems.length > 0));
    btn.classList.toggle('is-disabled', problems.length > 0);
    if (problems.length) hint.textContent = 'To save: ' + problems.join(', ') + '.';
    else {
      const cap = state.capture;
      const y = Number(cap.date.slice(0, 4));
      // each repeat is filed by its own date, so months past December land in the next tax year and nothing else on screen says so
      const split = cap.repeat > 1 ? repeatYears(cap.date, cap.repeat) : [];
      const later = split.length > 1 ? split.slice(1).reduce((n, x) => n + x.count, 0) : 0;
      const spill = later ? ` Repeating monthly to ${P.formatDate(addMonths(cap.date, cap.repeat - 1))} means ${later} of the ${cap.repeat} will file under tax year ${split[split.length - 1].year}.` : '';
      // a date that is not today is worth saying out loud: the default is Dec 31 whenever a past year is selected
      if (y !== Number(state.settings.taxYear)) hint.textContent = `Dated ${P.formatDate(cap.date)} — it will file under tax year ${y}.` + spill;
      else if (cap.date !== P.todayISO() && !cap.pinned.has('date')) hint.textContent = `Dated ${P.formatDate(cap.date)} (not today) — it will file under tax year ${y}.` + spill;
      else hint.textContent = spill.trim();
    }
  }

  const addMonths = ADV.addMonths; // the same end-of-month clamping the advisor uses for expected dates
  /** How a monthly repeat falls across tax years, in order: [{ year, count }]. Twelve months from September are four this year and eight the next. */
  function repeatYears(startISO, count) {
    const out = [];
    for (let i = 0; i < Math.max(1, count); i++) {
      const y = Number(addMonths(startISO, i).slice(0, 4));
      const last = out[out.length - 1];
      if (last && last.year === y) last.count++; else out.push({ year: y, count: 1 });
    }
    return out;
  }

  async function saveCapture() {
    const cap = state.capture;
    const problems = captureProblems();
    if (problems.length) { toast('To save: ' + problems.join(', ') + '.'); return; }
    if (cap.saving) return; // Enter plus a tap, or a double tap, must not file the entry twice
    cap.saving = true;
    const saveBtn = $('#saveBtn'); if (saveBtn) saveBtn.disabled = true;
    const isMiles = S.isMiles(cap.lineId);
    const value = amountTyped(isMiles ? cap.miles : cap.amount);
    const typedShare = isMiles ? { ok: false, share: 0 } : parseShare(cap.share);
    const share = typedShare.ok ? typedShare.share : 100; // 100% is the same as no share: the whole bill is logged
    const saved = share < 100 ? shareAmount(value, share) : value;
    const noteText = ((share < 100 ? `${share}% business share of ${moneyCents(value)}. ` : '') + cap.note.trim()).trim();
    const now = new Date().toISOString();
    const line = S.getLine(cap.lineId);
    const entries = [];
    const receiptId = !isMiles && cap.receiptBlob ? DB.uid() : null;
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
    // Everything is written before anything is shown as saved; a failure leaves the form filled in and the store untouched.
    try {
      DB.requestPersistence(); // the first save carries the user gesture some browsers require to protect the data from eviction
      if (receiptId) await DB.putReceipt({ id: receiptId, entryId: entries[0].id, type: cap.receiptBlob.type || 'image/jpeg', createdAt: now, blob: cap.receiptBlob });
      await DB.putEntries(entries);
    } catch (e) {
      if (receiptId) await DB.deleteReceipt(receiptId).catch(() => {});
      cap.saving = false; if (saveBtn) saveBtn.disabled = false;
      toast(`Could not save: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000);
      return;
    }
    state.entries.push(...entries);
    learnFromChoice(cap.suggestions, cap.lineId);
    if (cap.description.trim()) rememberLine(cap.description, cap.lineId);
    const fileYear = entries[0].taxYear;
    const label = isMiles ? fmtMiles(value) : moneyCents(saved);
    // the year is named whenever the entry lands outside the selected year or outside the year we are living in
    const noteYear = fileYear !== Number(state.settings.taxYear) || fileYear !== Number(P.todayISO().slice(0, 4));
    const split = repeatYears(cap.date, entries.length);
    // a repeat that crosses New Year files each month under its own year, so the count per year is named rather than only the first
    const years = split.length > 1 ? ` (${split.map((x) => `${x.count} in ${x.year}`).join(', ')})` : (noteYear ? ` (tax year ${fileYear})` : '');
    toast(`Saved ${label} → ${line.label}${entries.length > 1 ? ` × ${entries.length} months` : ''}${years}`);
    if (cap.receiptURL) URL.revokeObjectURL(cap.receiptURL);
    state.capture = freshCapture();
    state.capture.date = todayInYear();
    render(); // recompute first: Recent, the year strip, the meter and the "looks due" row all have to include what was just saved
    $('#quickInput').focus();
    sessionNudge(entries[0]);
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
      state.pendingReceiptTarget = null;
      if (!entry) return;
      const id = entry.receiptId || DB.uid();
      const isNewPhoto = !entry.receiptId;
      try {
        await DB.putReceipt({ id, entryId: entry.id, type: blob.type || 'image/jpeg', createdAt: new Date().toISOString(), blob });
      } catch (e) { toast(e.message || 'Could not store the receipt.'); return; }
      // The photo and the entry are two writes. The entry is told about it only after both are through, so a failure
      // cannot leave the ledger showing an attachment that is not there, or a photo no entry will ever name.
      const at = new Date().toISOString();
      try {
        await DB.putEntry(Object.assign({}, entry, { receiptId: id, hasReceipt: true, sample: false, updatedAt: at }));
      } catch (e) {
        if (isNewPhoto) await DB.deleteReceipt(id).catch(() => {}); // otherwise it rides along in every backup with nothing pointing at it
        toast(`Could not attach the receipt: ${e && e.message ? e.message : 'storage error'}. Nothing was changed.`, 6000);
        return;
      }
      dropReceiptURL(id);
      entry.receiptId = id; entry.hasReceipt = true; entry.updatedAt = at;
      entry.sample = false; // a photo of a real receipt is not an example any more, and must survive "remove the examples"
      toast('Receipt attached.');
      // the sheet the picker was opened from is still up: refresh only its receipt row, or an amount typed but not yet saved would be lost
      const panel = $('#modalPanel');
      const row = $('#modal').hidden ? null : panel && panel.querySelector('#eReceiptRow');
      if (row) { row.innerHTML = receiptRowHTML(entry, await receiptURL(entry.receiptId)); bindReceiptRow(panel, entry); }
      else openEdit(entry.id);
    }
    state.pendingReceiptTarget = null;
  }

  // =====================================================================
  // LEDGER
  // =====================================================================
  function ledgerFacts() {
    const R0 = state.computed;
    const dupeIds = new Set(); R0.duplicates.forEach(([a, b]) => { dupeIds.add(a.id); dupeIds.add(b.id); });
    return { R0, dupeIds, noAck: new Set(R0.substantiation.giftsNoAck.map((e) => e.id)), noReceipt: new Set(R0.substantiation.missingReceipts.map((e) => e.id)), samples: yearEntries().filter((e) => e.sample) };
  }
  /** Accents and the punctuation in a displayed amount are not part of what the user is looking for. */
  const foldText = (s) => String(s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  /** "cafe" finds "Café"; "$1,200.00", "1,200" and "1200.00" all find an amount of 1200. */
  function searchMatch(fields, query) {
    const q = foldText(query).trim();
    if (!q) return true;
    const hay = foldText(fields.join(' '));
    if (hay.includes(q)) return true;
    const num = q.replace(/[$,\s]/g, '');
    return /^\d*\.?\d+$/.test(num) && hay.replace(/[$,]/g, '').includes(num);
  }
  function ledgerList(F) {
    const L = state.ledger;
    let list = yearEntries().slice();
    if (L.filter === 'noreceipt') list = list.filter((e) => F.noReceipt.has(e.id));
    if (L.filter === 'noack') list = list.filter((e) => F.noAck.has(e.id));
    if (L.filter === 'dupes') list = list.filter((e) => F.dupeIds.has(e.id));
    if (L.filter === 'samples') list = list.filter((e) => e.sample);
    if (L.section) list = list.filter((e) => S.getLine(e.lineId).sectionId === L.section);
    if (L.from) list = list.filter((e) => e.date >= L.from);
    if (L.to) list = list.filter((e) => e.date <= L.to);
    if (L.q.trim()) {
      // the amount is searched as it is shown as well as as it is stored: "$1,200.00" is the only form the ledger ever displays
      list = list.filter((e) => { const l = S.getLine(e.lineId); return searchMatch([e.description, e.note, l.label, l.sectionTitle, String(e.amount), fmtAmount(e)], L.q); });
    }
    list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    return list;
  }
  let ledgerSearchTimer = null;
  function renderLedger() {
    const fk = focusKeyOf();
    const L = state.ledger;
    L.shown = LEDGER_PAGE;
    const F = ledgerFacts();
    if (L.filter === 'samples' && !F.samples.length) L.filter = 'all'; // the Examples chip goes when the examples do
    const chip = (id, label, count) => `<button class="chip" type="button" data-filter="${id}" aria-pressed="${L.filter === id}">${esc(label)}${count != null ? ` <span class="count">${count}</span>` : ''}</button>`;

    $('#view-ledger').innerHTML = `
      <div class="card filters">
        <div class="filters-row">
          <input class="input" type="search" id="ledgerQ" placeholder="Search what, note, line, amount…" value="${esc(L.q)}" aria-label="Search entries">
          <select id="ledgerSection" class="input" aria-label="Filter by section"><option value="">All sections</option>${S.SECTIONS.map((sec) => `<option value="${sec.id}" ${L.section === sec.id ? 'selected' : ''}>${esc(sec.title)}</option>`).join('')}</select>
        </div>
        <div class="filters-row">
          <label class="field" style="flex:1 1 140px"><span>From</span><input type="date" id="ledgerFrom" value="${esc(L.from || '')}"></label>
          <label class="field" style="flex:1 1 140px"><span>To</span><input type="date" id="ledgerTo" value="${esc(L.to || '')}"></label>
          ${L.from || L.to ? '<button class="btn btn-ghost btn-sm" type="button" id="ledgerClearDates" style="align-self:end">Clear dates</button>' : ''}
        </div>
        <div class="chips" id="ledgerChips">
          ${chip('all', 'All', yearEntries().length)}
          ${chip('noreceipt', 'No receipt', F.noReceipt.size)}
          ${chip('noack', 'Needs acknowledgment', F.noAck.size)}
          ${chip('dupes', 'Possible duplicates', F.dupeIds.size)}
          ${F.samples.length ? chip('samples', 'Examples', F.samples.length) : ''}
          <button class="chip" type="button" id="ledgerSelectToggle" aria-pressed="${L.selectMode}">${L.selectMode ? 'Done selecting' : 'Select'}</button>
        </div>
        <p class="icon-legend muted small"><span>${ICON.check} photo attached</span><span>${ICON.paper} paper receipt</span><span>${ICON.alert} no receipt</span><span><span class="dupe-mark" aria-hidden="true">⧉</span> possible duplicate</span></p>
      </div>
      <p class="sr-only" id="ledgerStatus" role="status" aria-live="polite"></p>
      <div id="ledgerBody"></div>`;

    const root = $('#view-ledger');
    // typing only refreshes the list below, so the search box keeps its focus and caret
    const q = $('#ledgerQ');
    // a changed filter is a new list, so it starts at the first page again
    const refreshList = () => { L.shown = LEDGER_PAGE; renderLedgerBody(); };
    q.addEventListener('input', (ev) => { L.q = ev.target.value; if (ev.isComposing) return; clearTimeout(ledgerSearchTimer); ledgerSearchTimer = setTimeout(refreshList, 250); });
    q.addEventListener('compositionend', () => { L.q = q.value; clearTimeout(ledgerSearchTimer); refreshList(); });
    $('#ledgerSection').onchange = (ev) => { L.section = ev.target.value; refreshList(); };
    $('#ledgerFrom').onchange = (ev) => { L.from = ev.target.value; renderLedger(); };
    $('#ledgerTo').onchange = (ev) => { L.to = ev.target.value; renderLedger(); };
    const cd = $('#ledgerClearDates'); if (cd) cd.onclick = () => { L.from = ''; L.to = ''; renderLedger(); };
    $('#ledgerChips').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-filter]'); if (!b) return;
      L.filter = b.dataset.filter;
      $$('#ledgerChips [data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.filter === L.filter)));
      refreshList();
    });
    $('#ledgerSelectToggle').onclick = () => { L.selectMode = !L.selectMode; L.selected.clear(); renderLedger(); };
    root.onclick = (ev) => { const b = ev.target.closest('[data-edit]'); if (b) openEdit(b.dataset.edit); };
    const updateBulkBar = () => { const bar = $('.bulk-bar'); if (!bar) return; bar.querySelector('b').textContent = String(L.selected.size); ['bulkMove', 'bulkPaper', 'bulkDelete'].forEach((id) => { const b = $('#' + id); if (b) b.disabled = !L.selected.size; }); };
    root.onchange = (ev) => { const cb = ev.target.closest('[data-sel]'); if (!cb) return; if (cb.checked) L.selected.add(cb.dataset.sel); else L.selected.delete(cb.dataset.sel); updateBulkBar(); };
    renderLedgerBody();
    restoreFocus(fk);
  }
  function renderLedgerBody() {
    const body = $('#ledgerBody'); if (!body) return;
    const L = state.ledger;
    const F = ledgerFacts();
    const R0 = F.R0;
    const list = ledgerList(F);
    const totalUsd = list.filter((e) => !S.isMiles(e.lineId)).reduce((a, e) => a + Number(e.amount || 0), 0);
    const totalMiles = list.filter((e) => S.isMiles(e.lineId) && S.getLine(e.lineId).treatment !== 'info').reduce((a, e) => a + Number(e.amount || 0), 0);
    const allSamples = state.entries.filter((e) => e.sample).length; // the button below removes the examples of every year, so it has to count them all
    // Each month head shows that whole month's total, so the totals are summed over the filtered list before the rows are cut to a page.
    const monthUsd = new Map();
    for (const e of list) if (!S.isMiles(e.lineId)) { const k = e.date.slice(0, 7); monthUsd.set(k, (monthUsd.get(k) || 0) + Number(e.amount || 0)); }
    // only a page of rows is built: a year of several thousand entries would otherwise be rebuilt in full on every keystroke
    const drawn = list.slice(0, L.shown);
    const remaining = list.length - drawn.length;
    const groups = [];
    for (const e of drawn) {
      const key = e.date.slice(0, 7);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) { g = { key, entries: [], usd: monthUsd.get(key) || 0 }; groups.push(g); }
      g.entries.push(e);
    }
    body.innerHTML = `
      ${L.selectMode ? `<div class="card bulk-bar"><span><b>${L.selected.size}</b> selected</span><div class="btn-row">${lineSelectHTML('bulkLine', '', 'Line to move the selected entries to')}<button class="btn btn-sm" type="button" id="bulkMove" ${L.selected.size ? '' : 'disabled'}>Move to line</button><button class="btn btn-sm" type="button" id="bulkPaper" ${L.selected.size ? '' : 'disabled'}>Mark paper receipt</button><button class="btn btn-sm btn-danger" type="button" id="bulkDelete" ${L.selected.size ? '' : 'disabled'}>Delete</button><button class="btn btn-sm btn-ghost" type="button" id="bulkAll">Select all matching</button></div></div>` : ''}
      <div class="ledger-summary"><span>${list.length} ${list.length === 1 ? 'entry' : 'entries'}${totalMiles ? ` · ${fmtMiles(totalMiles)}` : ''}</span><span class="num"><b>${moneyCents(totalUsd)}</b></span></div>
      <div class="card">
        ${list.length ? groups.map((g) => `<div class="month-head"><span>${esc(monthLabel(g.key))}</span><span class="num">${moneyCents(g.usd)}</span></div><div class="ledger-list">${g.entries.map((e) => entryRow(e, { dupes: F.dupeIds, select: L.selectMode, selected: L.selected })).join('')}</div>`).join('') : (yearEntries().length ? '<div class="empty"><h3>No entries match</h3><p>Try a different filter or search.</p></div>' : emptyStateHTML())}
      </div>
      ${remaining > 0 ? `<div class="btn-row"><button class="btn btn-ghost" type="button" id="ledgerMore">Show the remaining ${remaining} ${remaining === 1 ? 'entry' : 'entries'}</button></div>` : ''}
      <div class="btn-row">
        <button class="btn" type="button" id="csvBtn" ${yearEntries().length ? '' : 'disabled'}>Export ${R0.taxYear} as CSV</button>
        ${allSamples ? `<button class="btn btn-ghost" type="button" id="removeSamples">Remove ${allSamples} example ${allSamples === 1 ? 'entry' : 'entries'}${allSamples !== F.samples.length ? ' (all years)' : ''}</button>` : ''}
      </div>`;
    if (L.selectMode) {
      // a tick survives a change of filter, so the bulk actions work on everything counted in the bar, not only on what is on screen
      const chosen = () => yearEntries().filter((e) => L.selected.has(e.id));
      $('#bulkAll').onclick = () => { list.forEach((e) => L.selected.add(e.id)); renderLedger(); };
      $('#bulkMove').onclick = async () => {
        const lineId = $('#bulkLine').value; if (!lineId) { toast('Pick the line to move them to.'); return; }
        const at = new Date().toISOString();
        const moved = [], skipped = [];
        // the copies are written first and only then adopted, so a failed write cannot leave the ledger showing a move the store never took
        for (const e of chosen()) { if (S.isMiles(lineId) !== S.isMiles(e.lineId)) { skipped.push(e); continue; } moved.push([e, Object.assign({}, e, { lineId, updatedAt: at })]); }
        try { if (moved.length) await DB.putEntries(moved.map(([, next]) => next)); } catch (e) { toast(`Could not move them: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
        for (const [e, next] of moved) Object.assign(e, next);
        for (const [e] of moved) await syncTripToEntry(e); // the mileage log files the miles on the same line as the ledger
        // a move is a correction: without it the learned key keeps suggesting the line the user has just moved away from
        const payees = new Map();
        for (const [e] of moved) { const d = String(e.description || '').trim(); if (d) payees.set(C.keyFor(d), d); }
        for (const d of payees.values()) rememberLine(d, lineId);
        toast(`Moved ${moved.length} to ${S.getLine(lineId).label}${skipped.length ? `; ${skipped.length} skipped (miles and dollars cannot swap)` : ''}.`);
        L.selected.clear(); render();
      };
      $('#bulkPaper').onclick = async () => {
        const at = new Date().toISOString();
        const changed = chosen().filter((e) => !S.isMiles(e.lineId) && !e.hasReceipt);
        try { if (changed.length) await DB.putEntries(changed.map((e) => Object.assign({}, e, { hasReceipt: true, updatedAt: at }))); } catch (e) { toast(`Could not save: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
        for (const e of changed) { e.hasReceipt = true; e.updatedAt = at; }
        toast(`Marked ${changed.length} as having a paper receipt.`);
        L.selected.clear(); render();
      };
      $('#bulkDelete').onclick = async () => {
        const items = chosen(); if (!items.length) return;
        if (!(await confirmDialog(`Delete ${items.length} ${items.length === 1 ? 'entry' : 'entries'}?`, UNDO_HINT, 'Delete', true))) return;
        L.selected.clear(); L.selectMode = false;
        await deleteWithUndo(items);
      };
    }
    const more = $('#ledgerMore'); if (more) more.onclick = () => { L.shown += LEDGER_PAGE; renderLedgerBody(); const next = $('#ledgerMore'); if (next) next.focus(); };
    // the count is announced on its own; the list itself is not a live region, or every row would be read out on every keystroke
    const st = $('#ledgerStatus');
    if (st) st.textContent = `${list.length} ${list.length === 1 ? 'entry' : 'entries'}${totalMiles ? ` · ${fmtMiles(totalMiles)}` : ''} · ${moneyCents(totalUsd)}`;
    $('#csvBtn').onclick = () => downloadText(`itemizer-${R0.taxYear}.csv`, DB.toCSV(yearEntries(), S), 'text/csv');
    const rs = $('#removeSamples'); if (rs) rs.onclick = removeSampleData;
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
    bindJumpYear();
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
  /** Save a Blob without turning it into one string first (backups with many photos). */
  async function downloadBlob(filename, blob, type) {
    const dl = await getDownloads();
    if (dl || globalThis.claude) { await downloadText(filename, await blob.text(), type); return; }
    // a phone that saves nothing from a link can still hand the file to Files, Mail or a cloud folder through the share sheet
    try {
      const file = new File([blob], filename, { type: type || blob.type || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; /* refused or unsupported: the link below is still worth trying */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    // a link click reports nothing, and some in-app browsers ignore it, so the way out by copying stays one tap away
    toast(`Downloading ${filename}`, 7000, blob.size < 1e6 ? { label: 'Not saved? Copy instead', onClick: async () => showTextForCopy(filename, await blob.text()) } : null);
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
    // an in-app browser can ignore the download and say nothing, so the text stays one tap away
    toast(`Downloading ${filename}`, 7000, { label: 'Not saved? Copy instead', onClick: () => showTextForCopy(filename, text) });
  }

  const UNDO_HINT = 'You can undo from the message that appears for a few seconds afterwards.';
  /** Put back everything a batch of deletes took: the entries, their receipt photos and their rows in the mileage log. */
  async function restoreDeleted(batch) {
    let lostPhotos = 0;
    for (const r of batch.receipts) { try { await DB.putReceipt(r); } catch (err) { lostPhotos++; } }
    try { await DB.putEntries(batch.entries); }
    catch (err) { toast(`Could not restore: ${err && err.message ? err.message : 'storage error'}. Restore from a backup in Settings.`, 8000); return; }
    state.entries.push(...batch.entries);
    for (const t of batch.trips) { try { await DB.putTrip(t); state.trips.push(t); } catch (err) { /* the entry is back; its log row could not be */ } }
    render();
    toast(`Restored.${lostPhotos ? ` ${lostPhotos} photo${lostPhotos === 1 ? '' : 's'} could not be restored.` : ''}`);
  }
  /** Delete entries (and their receipt photos) with a few seconds to undo. */
  async function deleteWithUndo(entries) {
    const list = entries.slice();
    const receipts = [];
    for (const e of list) if (e.receiptId) { try { const r = await DB.getReceipt(e.receiptId); if (r) receipts.push(r); } catch (err) { /* photo unavailable */ } }
    const ids = new Set(list.map((e) => e.id));
    // the store takes each entry's trip with it and hands the rows back, so the mileage log drops them here too and Undo can put them back
    let trips;
    try { trips = (await DB.deleteEntries(list.map((e) => e.id))) || []; }
    catch (err) {
      toast(`Could not delete: ${err && err.message ? err.message : 'storage error'}.`, 6000);
      try { state.entries = await DB.getEntries(); state.trips = await DB.getTrips(); } catch (e2) { /* the reload will settle it */ }
      render();
      return;
    }
    state.trips = state.trips.filter((t) => !ids.has(t.entryId));
    state.entries = state.entries.filter((x) => !ids.has(x.id));
    for (const e of list) dropReceiptURL(e.receiptId);
    render();
    // a second delete inside the undo window joins the first: replacing the toast would otherwise drop the only copy of those rows
    const batch = pendingUndo
      ? { entries: pendingUndo.entries.concat(list), receipts: pendingUndo.receipts.concat(receipts), trips: pendingUndo.trips.concat(trips) }
      : { entries: list, receipts, trips };
    pendingUndo = batch;
    const what = batch.entries.length === 1 ? (batch.entries[0].description || S.getLine(batch.entries[0].lineId).label) : `${batch.entries.length} entries`;
    toast(`Deleted ${what}.`, 8000, { label: 'Undo', altLabel: 'Undo delete', onClick: () => restoreDeleted(batch) });
  }

  /**
   * Keep an entry's row in the mileage log in step with the entry itself: the log and the
   * worksheet are read against each other. An entry moved off a mileage line has no trip left,
   * and miles corrected by hand can no longer be exported as a GPS or road measurement.
   */
  async function syncTripToEntry(e) {
    const t = state.trips.find((x) => x.entryId === e.id);
    if (!t) return;
    try {
      if (!S.isMiles(e.lineId)) { await DB.deleteTrip(t.id); state.trips = state.trips.filter((x) => x.id !== t.id); return; }
      if (Number(e.amount) !== Number(t.miles)) t.method = 'manual';
      Object.assign(t, { date: e.date, taxYear: e.taxYear, miles: Number(e.amount), lineId: e.lineId });
      await DB.putTrip(t);
    } catch (err) { toast('The entry was saved, but its row in the mileage log could not be updated.', 6000); }
  }

  // ---- edit sheet -----------------------------------------------------------
  /** The receipt controls of the edit sheet. Kept apart so attaching or removing a photo refreshes only this row and leaves typed edits alone. */
  function receiptRowHTML(entry, url) {
    return `${url ? `<button type="button" class="thumb-btn" id="eThumb" aria-label="View the receipt full size"><img class="receipt-thumb" src="${url}" alt=""></button><button class="btn btn-sm" type="button" id="eReplace">Replace photo</button><button class="btn btn-ghost btn-sm" type="button" id="eRemovePhoto">Remove photo</button>` : `<button class="btn" type="button" id="eAttach">${ICON.camera} Attach receipt</button>`}
        <label class="check"><input type="checkbox" id="ePaper" ${entry.hasReceipt && !entry.receiptId ? 'checked' : ''} ${entry.receiptId ? 'disabled' : ''}> Paper receipt filed</label>`;
  }
  function bindReceiptRow(panel, entry) {
    // the photo grows inside the sheet: opening it as its own dialog would replace this form and lose whatever is typed in it
    const thumb = panel.querySelector('#eThumb');
    if (thumb) thumb.onclick = () => {
      const img = thumb.querySelector('img');
      const big = img.className !== 'receipt-full';
      img.className = big ? 'receipt-full' : 'receipt-thumb';
      thumb.style.flexBasis = big ? '100%' : ''; // the row wraps, so the opened photo gets a line of its own
      thumb.setAttribute('aria-label', big ? 'Hide the receipt' : 'View the receipt full size');
    };
    // the sheet stays open behind the picker: closing it would throw away an amount or a note typed but not yet saved,
    // and a cancelled picker would leave nothing on screen. The hidden input is outside the inert part of the page.
    const attach = panel.querySelector('#eAttach') || panel.querySelector('#eReplace');
    if (attach) attach.onclick = () => { state.pendingReceiptTarget = entry.id; $('#receiptPick').click(); };
    const rm = panel.querySelector('#eRemovePhoto');
    if (rm) rm.onclick = async () => {
      const gone = entry.receiptId, at = new Date().toISOString();
      try { await DB.putEntry(Object.assign({}, entry, { receiptId: null, hasReceipt: false, updatedAt: at })); }
      catch (err) { toast(`Could not remove the photo: ${err && err.message ? err.message : 'storage error'}.`, 6000); return; }
      await DB.deleteReceipt(gone).catch(() => {}); // the entry no longer names it, so a photo left behind would only ride along in backups
      dropReceiptURL(gone);
      entry.receiptId = null; entry.hasReceipt = false; entry.updatedAt = at;
      const row = panel.querySelector('#eReceiptRow');
      row.innerHTML = receiptRowHTML(entry, null);
      bindReceiptRow(panel, entry);
      toast('Photo removed.');
    };
  }
  let openingEdit = false;
  async function openEdit(id) {
    // a second tap, or a dialog already on screen: another sheet over this one would throw away the edits in it
    if (openingEdit || !$('#modal').hidden) return;
    const e = state.entries.find((x) => x.id === id);
    if (!e) return;
    const line = S.getLine(e.lineId);
    const isMiles = S.isMiles(e.lineId);
    openingEdit = true;
    let url = null;
    try { url = await receiptURL(e.receiptId); } finally { openingEdit = false; }
    openModal(`
      <div class="card-head"><h2>Edit entry</h2><span class="pill-row"><span class="pill pill-accent">${esc(line.sectionTitle)}</span>${!isMiles && !e.hasReceipt && !e.receiptId && (Number(e.amount) || 0) >= state.computed.params.receiptThreshold ? '<span class="pill pill-act">No receipt</span>' : ''}${state.computed.duplicates.some(([a, b]) => a.id === e.id || b.id === e.id) ? '<span class="pill pill-warn">Possible duplicate</span>' : ''}</span></div>
      <div class="grid-2">
        <label class="field"><span id="eAmountLabel">${isMiles ? 'Miles' : 'Amount ($)'}</span><input id="eAmount" inputmode="decimal" value="${esc(e.amount)}"></label>
        <label class="field"><span>Date</span><input id="eDate" type="date" value="${esc(e.date)}"></label>
        <label class="field span-2"><span>What / who</span><input id="eDesc" value="${esc(e.description)}"></label>
        <div class="field span-2"><span><label for="eLine">Worksheet line</label></span>${lineSelectHTML('eLine', e.lineId, 'Worksheet line')}<div class="line-hint" id="eHint">${lineHintHTML(e.lineId)}</div></div>
        <label class="field span-2"><span>Note</span><textarea id="eNote">${esc(e.note)}</textarea></label>
        ${e.items && e.items.length ? `<div class="field span-2"><span>Itemized donation record</span><div class="note small" style="white-space:pre-line">${esc(VAL.recordText(e.items, String(e.description || '').split(' — ')[0], e.date))}</div></div>` : ''}
      </div>
      <div class="receipt-row" id="eReceiptRow" ${isMiles ? 'hidden' : ''}>
        ${receiptRowHTML(e, url)}
      </div>
      <div class="modal-actions">
        <button class="btn btn-danger" type="button" id="eDelete">Delete</button>
        <span class="spacer"></span>
        <button class="btn" type="button" data-close="1">Cancel</button>
        <button class="btn btn-primary" type="button" id="eSave">Save changes</button>
      </div>`, (panel) => {
      panel.querySelector('[data-close]').onclick = closeModal;
      const lineSel = panel.querySelector('#eLine');
      // the receipt row stays up on a mileage line while a photo is attached, so "Remove photo" is still there to press
      lineSel.onchange = () => { const m = S.isMiles(lineSel.value); panel.querySelector('#eAmountLabel').textContent = m ? 'Miles' : 'Amount ($)'; panel.querySelector('#eReceiptRow').hidden = m && !e.receiptId; panel.querySelector('#eHint').innerHTML = lineHintHTML(lineSel.value); };
      bindReceiptRow(panel, e);
      panel.querySelector('#eDelete').onclick = async () => {
        closeModal();
        if (!(await confirmDialog('Delete this entry?', `${e.description || line.label} · ${fmtAmount(e)} on ${P.formatDate(e.date)}. ${UNDO_HINT}`, 'Delete', true))) return;
        await deleteWithUndo([e]);
      };
      panel.querySelector('#eSave').onclick = async () => {
        const newLine = lineSel.value;
        const val = amountTyped(panel.querySelector('#eAmount').value);
        const date = panel.querySelector('#eDate').value;
        if (!newLine || amountProblem(val, 'an amount') || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('A line, an amount below a billion, and a date are all required.'); return; }
        // a mileage line has nowhere to show a receipt photo, and dropping the photo here would destroy it without asking
        if (S.isMiles(newLine) && e.receiptId) { toast('Remove the receipt photo before moving this to a mileage line.', 6000); return; }
        const desc = panel.querySelector('#eDesc').value.trim();
        const amount = Math.round(val * 100) / 100;
        const next = Object.assign({}, e, {
          lineId: newLine, amount, date, taxYear: Number(date.slice(0, 4)),
          description: desc, note: panel.querySelector('#eNote').value.trim(),
          sample: false, // an example entry edited by hand is the user's own record, and must survive "remove the examples"
          updatedAt: new Date().toISOString(),
        });
        if (!e.receiptId) next.hasReceipt = panel.querySelector('#ePaper').checked;
        if (S.isMiles(newLine)) next.hasReceipt = false;
        // the business-use share described the old amount: once that changes, neither the figures nor the sentence about them still hold
        if (e.share != null && (amount !== Number(e.amount) || S.isMiles(newLine))) {
          const stamp = `${e.share}% business share of ${moneyCents(e.fullAmount)}.`;
          if (next.note.startsWith(stamp)) next.note = next.note.slice(stamp.length).trim(); // only the sentence the app wrote; anything the user typed stays
          next.fullAmount = null; next.share = null;
        }
        // written first and adopted after: a failed save must not leave the ledger, the worksheet and the verdict showing figures the store does not have
        try { await DB.putEntry(next); } catch (err) { toast(`Could not save: ${err && err.message ? err.message : 'storage error'}.`, 6000); return; }
        Object.assign(e, next);
        await syncTripToEntry(e);
        if (desc) rememberLine(desc, newLine);
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
    // the Schedule C sub-label says what is actually in the figure: the meals share is a settable rate, and a business can have no meals at all
    const seCount = R0.sections.selfemp.count;
    const cSub = !C0.hasActivity ? 'no business entries'
      : C0.vehicle.miles ? `${fmtMiles(C0.vehicle.miles)} at ${R.perMileText(R0.params, 'business')}`
      : C0.meals.paid > 0 ? `meals counted at ${R.pct(C0.meals.rate)}`
      : `${seCount} business ${plural(seCount, 'entry', 'entries')}`;
    // what has been added to the standard deduction, so the figure beside "standard deduction" is not taken for the plain one
    const stdParts = [];
    if (SD.conditions.length) stdParts.push(`${money(SD.additional)} because ${esc(SD.conditions.join(' and '))}`);
    if (SD.charity > 0) stdParts.push(`${money(SD.charity)} of cash gifts, which count without itemizing up to ${money(SD.charityCap)}`);
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
        <p class="verdict-note">${money(A.grossEntered)} entered on the worksheet · ${money(A.total)} counts after the medical floor, the state-and-local-tax cap, and gift limits · ${money(SD.total)} standard deduction${stdParts.length ? ` (includes ${stdParts.join(' and ')})` : ''}.${V.medicalPending ? ' Medical expenses are waiting on your AGI.' : ''}</p>
        ${meterHTML('')}
      </section>

      <div class="kpis">
        ${kpi('Schedule A after limits', money(A.total), `${money(A.grossEntered)} entered`)}
        ${kpi('Schedule C business', money(C0.total), cSub)}
        ${kpi('Above the line', money(R0.adjustments.studentLoanInterest.deductible), 'student loan interest, no itemizing needed')}
        ${kpi('Receipts on file', `${Math.round(SUB.coverage * 100)}%`, `${SUB.withReceipt} of ${SUB.usdEntries} dollar entries`)}
      </div>

      <section>
        <div class="card-head"><h2>What to do about it</h2><span class="muted small">${R0.insights.length} ${plural(R0.insights.length, 'note')}</span></div>
        <div class="feed">${R0.insights.map(insightHTML).join('')}</div>
      </section>

      ${sectionRows.length ? `<section class="card">
        <div class="card-head"><h2>By section</h2><span class="muted small">entered vs. counts on the return</span></div>
        <div class="bars">${sectionRows.map((r) => `<div class="bar-row"><div class="bar-label">${esc(r.title)}<small>${r.counts != null ? money(r.counts) + ' counts · ' : ''}${esc(r.note)}</small></div><div class="bar-track" data-tip="${esc(`${money(r.gross)} entered · ${r.counts == null ? 'pending AGI' : money(r.counts) + ' counts'}`)}" role="img" aria-label="${esc(`${money(r.gross)} entered · ${r.counts == null ? 'pending AGI' : money(r.counts) + ' counts'}`)}" tabindex="0"><div class="bar-gross" style="width:${(r.gross / maxGross * 100).toFixed(1)}%"></div>${r.counts != null ? `<div class="bar-counts" style="width:${(Math.min(r.counts, r.gross) / maxGross * 100).toFixed(1)}%"></div>` : ''}<div class="bar-value" style="left:min(${(r.gross / maxGross * 100).toFixed(1)}%, calc(100% - 90px))">${money(r.gross)}</div></div></div>`).join('')}</div>
        <div class="bar-legend"><span><span class="legend-dot" style="background:var(--accent)"></span>Counts on the return</span><span><span class="legend-dot" style="background:var(--accent-soft)"></span>Entered on the worksheet</span></div>
      </section>` : ''}

      ${yoyHTML()}

      ${R0.entries.length ? `<section class="card">
        <div class="card-head"><h2>Month by month</h2><button class="btn btn-ghost btn-sm" type="button" id="toggleMonthsTable">${state.showMonthsTable ? 'Show chart' : 'Show as table'}</button></div>
        ${state.showMonthsTable ? `<table class="table-twin"><thead><tr><th>Month</th><th class="num">Logged (dollar value)</th></tr></thead><tbody>${months.map((v, i) => `<tr><td>${MONTHS_SHORT[i]} ${R0.taxYear}</td><td class="num">${moneyCents(v)}</td></tr>`).join('')}</tbody></table>` : `
        <div class="months" role="group" aria-label="Dollar value logged per month">${months.map((v, i) => `<div class="month-col ${i === nowMonth ? 'is-current' : ''} ${i === maxIdx && maxMonth > 0 ? 'is-max' : ''}" role="img" tabindex="0" data-tip="${esc(`${MONTHS_SHORT[i]}: ${money(v)}`)}" aria-label="${esc(`${MONTHS_SHORT[i]}: ${money(v)}`)}">${i === maxIdx && maxMonth > 0 ? `<span class="month-value">${money(v)}</span>` : ''}<div class="month-bar" style="height:${maxMonth ? Math.max(2, v / maxMonth * 100) : 2}%"></div></div>`).join('')}</div>
        <div class="month-axis">${MONTHS_SHORT.map((m) => `<span>${m[0]}</span>`).join('')}</div>`}
        <p class="note" style="margin-top:10px">Miles are shown at their dollar value. ${nowMonth >= 0 ? 'The current month is highlighted.' : ''}</p>
      </section>` : ''}

      <div class="two-col">
        <section class="card">
          <div class="card-head"><h3>Schedule A detail</h3></div>
          <dl class="dl">
            <dt>Medical, after ${R.pct(R0.params.medicalFloorRate)} floor</dt><dd>${A.medical.deductible == null ? (A.medical.gross ? 'needs AGI' : moneyCents(0)) : moneyCents(A.medical.deductible)}</dd>
            <dt>State &amp; local taxes, capped</dt><dd>${moneyCents(A.taxes.deductible)}</dd>
            <dt>Interest</dt><dd>${moneyCents(A.interest.total)}</dd>
            <dt>Gifts to charity${A.charity.floor ? ' (after floor)' : ''}</dt><dd>${moneyCents(A.charity.deductible)}</dd>
            <dt>Gambling losses (to winnings)</dt><dd>${moneyCents(A.other.deductible)}</dd>
            <dt>Casualty (${A.casualty.qualified ? 'qualified disaster loss' : 'declared disaster'})</dt><dd>${moneyCents(A.casualty.deductible)}</dd>
            <div class="total" style="display:contents"><dt>Itemized total</dt><dd>${moneyCents(A.total)}</dd></div>
            <dt>Standard deduction${stdGiftClause(SD)}</dt><dd>${moneyCents(SD.total)}</dd>
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h3>Outside Schedule A</h3></div>
          <dl class="dl">
            <dt>Schedule C expenses</dt><dd>${moneyCents(C0.otherExpenses)}</dd>
            <dt>Business meals (${R.pct(C0.meals.rate)} of ${moneyCents(C0.meals.paid)})</dt><dd>${moneyCents(C0.meals.deductible)}</dd>
            <dt>Vehicle — standard mileage</dt><dd>${moneyCents(C0.vehicle.milesValue)}</dd>
            <dt>Vehicle — actual expenses</dt><dd>${moneyCents(C0.vehicle.actual)}</dd>
            ${C0.vehicle.businessUseShare != null ? `<dt>Business-use share</dt><dd>${Math.round(C0.vehicle.businessUseShare * 100)}%</dd>` : ''}
            <div class="total" style="display:contents"><dt>Schedule C total</dt><dd>${moneyCents(C0.total)}</dd></div>
            <dt>Student loan interest (adjustment)</dt><dd>${moneyCents(R0.adjustments.studentLoanInterest.deductible)}</dd>
            <dt>Education costs (for credits)</dt><dd>${moneyCents(R0.credits.educationCosts)}</dd>
          </dl>
        </section>
      </div>`;

    const tg = $('#toggleMonthsTable'); if (tg) tg.onclick = () => { state.showMonthsTable = !state.showMonthsTable; renderInsights(); };
    listen($('#view-insights'), 'click', (ev) => {
      const go1 = ev.target.closest('[data-go]');
      if (go1) { ev.preventDefault(); const [view, filter] = go1.dataset.go.split(':'); if (filter) state.ledger.filter = normalizeLedgerFilter(filter); go(view, filter ? { filter } : null); }
    });
  }
  function yoyHTML() {
    const R0 = state.computed;
    const prevYear = R0.taxYear - 1;
    if (!state.entries.some((e) => R.taxYearOf(e) === prevYear)) return '';
    const prev = R.compute(state.entries, Object.assign({}, state.settings, { taxYear: prevYear, today: P.todayISO(), paramOverrides: state.overrides }));
    const rows = S.SECTIONS.filter((s) => R0.sections[s.id].count || prev.sections[s.id].count).map((s) => ({ title: s.title, now: R0.sections[s.id].value, before: prev.sections[s.id].value }));
    // money() rounds to the dollar, so a 30-cent fall would otherwise print "$0" in red
    const delta = (a, b) => { const d = Math.round((a - b) * 100) / 100; const shown = Math.abs(d) < 0.5 ? 0 : d; return `<span class="${shown > 0 ? 'delta-up' : shown < 0 ? 'delta-down' : ''}">${shown > 0 ? '+' : ''}${money(shown)}</span>`; };
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
      // The floor and the AGI limit apply to gifts and volunteer costs together, so the two bars split the one
      // deductible figure rather than each showing its own gross; together they equal "Gifts to charity" below.
      case 'charity':
      case 'volunteer': {
        if (A.charity.floorPending || A.charity.limitPending) return null;
        const vol = R.cents(Math.min(A.charity.volunteer, A.charity.deductible));
        return sectionId === 'volunteer' ? vol : R.cents(A.charity.deductible - vol);
      }
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
      case 'charity': return A.charity.floorPending || A.charity.limitPending ? 'pending AGI' : A.charity.carryforward ? `${money(A.charity.carryforward)} carries forward` : A.charity.floor ? `after ${money(A.charity.floor)} floor` : 'Schedule A';
      case 'volunteer': return A.charity.floorPending || A.charity.limitPending ? 'pending AGI' : 'counts as gifts';
      default: return 'Schedule A';
    }
  }

  // =====================================================================
  // WORKSHEET — a filled-in replica of the paper organizer
  // =====================================================================
  /** The notes under the sheet, shared by the printed sheet and the text copy so the preparer gets the same information either way. */
  function preparerNotes(R0) {
    const notes = [];
    for (const i of R0.insights.filter((x) => x.level === 'act' || x.level === 'warn')) notes.push(`${i.title}. ${i.body.split(/(?<=\.)\s/)[0]}`);
    if (R0.scheduleA.other.gamblingLosses) notes.push(`Gambling winnings reported by taxpayer: ${money(R0.scheduleA.other.gamblingWinnings)}.`);
    if (R0.scheduleA.casualty.gross) notes.push(`Casualty loss ${R0.scheduleA.casualty.federalDisaster ? 'IS' : 'is NOT'} marked as a declared disaster${state.settings.disasterNumber ? ` (FEMA ${state.settings.disasterNumber})` : ''}${R0.scheduleA.casualty.qualified ? '; taxpayer marked it a qualified disaster loss ($500 floor, no AGI reduction)' : ''}.`);
    if (R0.scheduleA.taxes.withheld) notes.push(`State and local income tax withheld per W-2 (boxes 17 and 19), as entered by taxpayer: ${money(R0.scheduleA.taxes.withheld)} — included in the state-and-local total above the cap.`);
    if (R0.scheduleA.charity.carryforward) notes.push(`Charitable gifts exceed the AGI limit by ${money(R0.scheduleA.charity.carryforward)}; carry the excess forward.`);
    // an above-the-line figure the insights only ever report as good news, so the act/warn sweep above never picks it up
    const senior = R0.adjustments.seniorDeduction;
    if (senior && senior.amount > 0) notes.push(`Senior deduction: ${money(senior.amount)} for ${senior.people} ${plural(senior.people, 'person', 'people')} aged 65 or older${senior.phase === 'partial' ? ', already reduced for income' : senior.phase === 'unchecked' ? ', before any reduction for income (no AGI entered)' : ''}. It is claimed whether or not the return itemizes.`);
    const tripCount = liveTrips(state.trips).filter((t) => Number(t.taxYear) === R0.taxYear).length;
    if (tripCount) notes.push(`Mileage log: ${tripCount} ${tripCount === 1 ? 'trip' : 'trips'} with date, destination, purpose, and miles (export from Capture → Trip).`);
    if (R0.scheduleC.hasActivity && R0.scheduleC.vehicle.totalMiles) notes.push(`Vehicle: ${fmtMiles(R0.scheduleC.vehicle.miles)} business of ${fmtMiles(R0.scheduleC.vehicle.totalMiles)} total (${Math.round((R0.scheduleC.vehicle.businessUseShare || 0) * 100)}% business use).`);
    return notes;
  }
  /** The lender's name and address under Home Mortgage to Individual: Schedule A line 8b needs both, so the paper always prints the two lines. */
  function lenderDetails(R0) {
    const L = R0.lines['int.individual'];
    const uniq = (f) => [...new Set(L.entries.map((e) => String(f(e) || '').trim()).filter(Boolean))];
    return { names: uniq((e) => e.description), addresses: uniq((e) => e.note) };
  }
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
        if (l.unit === 'miles') amt = `<span class="mi">${esc(fmtMiles(L.total))}${l.treatment === 'info' ? '' : ' @ ' + esc(rateShortFor(P0, l.rate))}</span>${l.treatment === 'info' ? '' : esc(moneyCents(L.milesValue))}`;
        else amt = esc(moneyCents(L.total));
      }
      return `<div class="sheet-line ${has ? '' : 'is-zero'}"><div class="lbl"><span>${esc(l.label)}</span><span class="leader"></span></div><span class="amt ${has ? '' : 'blank'}"${has ? '' : ' aria-hidden="true"'}>${amt}</span></div>`;
    };
    const lenderRows = () => {
      const D = lenderDetails(R0);
      const row = (label, vals) => `<div class="sheet-line sheet-line-full ${vals.length ? '' : 'is-zero'}"><div class="lbl"><span>${label}${vals.length ? ': ' + esc(vals.join('; ')) : ''}</span><span class="leader"></span></div></div>`;
      return row('Name', D.names) + row('Address', D.addresses);
    };
    // a section renders the lines that sit in the given column; the paper carries Self-Employed over to the foot of the right column
    const sectionHTML = (sec, col) => {
      const all = S.linesForSection(sec.id);
      const lines = all.filter((l) => l.column === col);
      if (!lines.length) return '';
      const continued = lines[0] !== all[0];
      let html = `<div class="sheet-section"><h3>${esc(sec.title)}${continued ? ' <span class="sheet-cont">(continued)</span>' : ''}</h3>`;
      let group = null;
      for (const l of lines) {
        if (l.group !== group) { group = l.group; if (group) html += `<div class="sheet-group">${esc(group)}</div>`; }
        html += lineRow(l);
        if (l.id === 'int.individual') html += lenderRows();
      }
      const secTotal = R0.sections[sec.id];
      if (secTotal.count && lines.includes(all[all.length - 1]) && !mixedTreatments(all)) html += `<div class="sheet-line"><div class="lbl"><span><i>Section total</i></span><span class="leader"></span></div><span class="amt"><b>${esc(moneyCents(secTotal.value))}</b></span></div>`;
      html += '</div>';
      return html;
    };
    const columnHTML = (col) => S.SECTIONS.filter((x) => x.column === col).concat(S.SECTIONS.filter((x) => x.column !== col)).map((x) => sectionHTML(x, col)).join('');
    const left = columnHTML('left');
    const right = columnHTML('right');
    const name = (state.settings.taxpayerName || '').trim();

    const notes = preparerNotes(R0);
    const SUB = R0.substantiation;

    $('#view-worksheet').innerHTML = `
      <div class="sheet-tools">
        <p class="note">This is the organizer sheet, filled in from your ledger. Print it or save it as a PDF for your preparer.${name ? '' : ' Add the name on your return under Settings → About you so the preparer knows whose sheet this is.'}</p>
        <div class="btn-row"><button class="btn" type="button" id="copySummary">Copy as text</button><button class="btn" type="button" id="receiptsToggle" aria-pressed="${state.showReceiptSheet}">${state.showReceiptSheet ? 'Hide receipts' : 'Receipts sheet'}</button>${state.showReceiptSheet ? `<button class="btn" type="button" id="printReceipts">${ICON.print} Print receipts</button>` : ''}<button class="btn btn-primary" type="button" id="printBtn">${ICON.print} Print / Save PDF</button></div>
      </div>
      <article class="sheet" id="sheet">
        <div class="sheet-bar">Keep track of your expenses</div>
        <p class="sheet-sub">List amounts for items you have. Save receipts for your deductions.</p>
        <div class="sheet-meta">
          <span><b>Taxpayer</b> ${name ? esc(name) : '<span class="fill-blank"><span class="sr-only">not entered</span></span>'}</span>
          <span><b>Tax year</b> ${R0.taxYear}</span>
          <span><b>Filing status</b> ${esc(filing ? filing.label : '')}</span>
          <span><b>Est. AGI</b> ${R0.agi == null ? 'not provided' : money(R0.agi) + ' (current setting)'}</span>
          ${state.settings.state ? `<span><b>State</b> ${esc(state.settings.state)}${state.settings.county ? ', ' + esc(state.settings.county) : ''}</span>` : ''}
          <span><b>Entries</b> ${R0.entries.length}</span>
          <span><b>Receipts</b> ${SUB.withReceipt} of ${SUB.usdEntries} dollar entries</span>
          <span><b>Prepared</b> ${esc(prepared)}</span>
        </div>
        <div class="sheet-cols"><div>${left}</div><div>${right}</div></div>
        <div class="sheet-totals">
          ${R0.scheduleA.taxes.withheld ? `<span>State and local income tax withheld per W-2 (from Settings)</span><span class="num">${esc(moneyCents(R0.scheduleA.taxes.withheld))}</span>` : ''}
          <span>Schedule A items entered${R0.scheduleA.taxes.withheld ? ', including that withholding' : ''}</span><span class="num">${esc(moneyCents(R0.scheduleA.grossEntered))}</span>
          <span>Counts after medical floor, tax cap, and gift limits</span><span class="num">${esc(moneyCents(R0.scheduleA.total))}</span>
          <span>Standard deduction (${esc(filing ? filing.label : '')}${R0.standardDeduction.conditions.length ? ', with age/blind additions' : ''}${esc(stdGiftClause(R0.standardDeduction))})</span><span class="num">${esc(moneyCents(R0.standardDeduction.total))}</span>
          <span class="big">${R0.verdict.itemize ? 'Itemizing appears to win by' : 'Standard deduction appears to win by'}</span><span class="num big">${esc(moneyCents(Math.abs(R0.verdict.difference)))}</span>
          ${R0.scheduleC.hasActivity ? `<span>Schedule C expenses (business, not itemized)</span><span class="num">${esc(moneyCents(R0.scheduleC.total))}</span>` : ''}
          ${R0.adjustments.studentLoanInterest.paid ? `<span>Student loan interest (adjustment to income)</span><span class="num">${esc(moneyCents(R0.adjustments.studentLoanInterest.deductible))}</span>` : ''}
        </div>
        ${notes.length ? `<div class="sheet-notes"><h3>Notes for the preparer</h3><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
        <p class="sheet-foot">Prepared with Itemizer from the taxpayer's own records. Totals are planning figures using ${R0.params.baseYear} IRS thresholds${R0.params.isFallback ? ` (no ${R0.taxYear} figures loaded)` : ''}; the preparer should verify eligibility and limits against source documents.</p>
      </article>
      ${state.showReceiptSheet ? receiptSheetHTML() : ''}`;

    $('#printBtn').onclick = () => window.print();
    $('#receiptsToggle').onclick = () => { state.showReceiptSheet = !state.showReceiptSheet; renderWorksheet(); if (state.showReceiptSheet) { const el = $('#receiptSheet'); if (el) el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); } };
    const pr = $('#printReceipts');
    if (pr) pr.onclick = () => { document.body.classList.add('print-receipts'); const done = () => { document.body.classList.remove('print-receipts'); window.removeEventListener('afterprint', done); }; window.addEventListener('afterprint', done); window.print(); };
    if (state.showReceiptSheet) fillReceiptImages().catch(() => toast('Some receipt photos could not be loaded. Try opening the sheet again.', 6000));
    else releaseSheetReceipts();
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
      <p class="sheet-sub">${state.settings.taxpayerName ? esc(state.settings.taxpayerName.trim()) + ' · ' : ''}${withPhoto.length} receipt ${withPhoto.length === 1 ? 'photo' : 'photos'} attached to entries and ${paper.length} paper ${paper.length === 1 ? 'receipt' : 'receipts'} on file. Prepared ${esc(prepared)}.</p>
      ${[...groups.entries()].map(([title, list]) => `<h3 class="receipt-group">${esc(title)}</h3><div class="receipt-grid">${list.map((e) => `<figure class="receipt-fig"><img data-receipt="${esc(e.receiptId)}" decoding="async" alt="Receipt for ${esc(e.description || S.getLine(e.lineId).label)}"><figcaption><b>${esc(P.formatDate(e.date))}</b> · ${esc(fmtAmount(e))}<br>${esc(e.description || '')}<br><span class="muted">${esc(S.getLine(e.lineId).label)}</span></figcaption></figure>`).join('')}</div>`).join('')}
      ${paper.length ? `<h3 class="receipt-group">Paper receipts on file</h3><table class="table-twin"><thead><tr><th>Date</th><th>Payee</th><th>Line</th><th class="num">Amount</th></tr></thead><tbody>${paper.map((e) => `<tr><td>${esc(P.formatDate(e.date, false))}</td><td>${esc(e.description || '')}</td><td>${esc(S.getLine(e.lineId).label)}</td><td class="num">${esc(moneyCents(e.amount))}</td></tr>`).join('')}</tbody></table>` : ''}
      ${!withPhoto.length && !paper.length ? '<p class="note">No receipts yet. Attach photos from Capture or the ledger, or tick "paper receipt filed" on an entry.</p>' : ''}
    </article>`;
  }
  async function fillReceiptImages() {
    await Promise.all($$('#receiptSheet img[data-receipt]').map(async (img) => {
      const url = await receiptURL(img.dataset.receipt);
      if (url) { sheetReceiptIds.add(img.dataset.receipt); img.src = url; }
    }));
  }

  function worksheetText() {
    const R0 = state.computed, P0 = R0.params;
    const filing = R.FILING_STATUSES.find((f) => f.id === R0.filingStatus);
    const pad = (a, b, w) => { const dots = Math.max(2, w - a.length - b.length); return a + ' ' + '.'.repeat(dots) + ' ' + b; };
    const name = (state.settings.taxpayerName || '').trim();
    const out = [`KEEP TRACK OF YOUR EXPENSES — tax year ${R0.taxYear}`, `Taxpayer: ${name || '________________'} · Filing: ${filing ? filing.label : ''} · Est. AGI (current setting): ${R0.agi == null ? 'n/a' : money(R0.agi)} · Prepared ${P.formatDate(P.todayISO())}`, ''];
    for (const sec of S.SECTIONS) {
      const all = S.linesForSection(sec.id);
      const lines = all.filter((l) => R0.lines[l.id].count);
      if (!lines.length) continue;
      out.push(sec.title.toUpperCase());
      for (const l of lines) {
        const L = R0.lines[l.id];
        const v = l.unit === 'miles' ? `${fmtMiles(L.total)}${l.treatment === 'info' ? '' : ` @ ${rateShortFor(P0, l.rate)} = ` + moneyCents(L.milesValue)}` : moneyCents(L.total);
        out.push('  ' + pad(l.label, v, 58));
        if (l.id === 'int.individual') {
          const D = lenderDetails(R0);
          out.push(`    Name: ${D.names.join('; ') || '(not recorded)'}`, `    Address: ${D.addresses.join('; ') || "(not recorded — Schedule A needs the lender's address and SSN or EIN)"}`);
        }
      }
      if (!mixedTreatments(all)) out.push('  ' + pad('Section total', moneyCents(R0.sections[sec.id].value), 58));
      out.push('');
    }
    if (R0.scheduleA.taxes.withheld) out.push(pad('State and local income tax withheld per W-2', moneyCents(R0.scheduleA.taxes.withheld), 60));
    out.push(pad(R0.scheduleA.taxes.withheld ? 'Schedule A entered, including that withholding' : 'Schedule A entered', moneyCents(R0.scheduleA.grossEntered), 60));
    out.push(pad('Counts after floors and caps', moneyCents(R0.scheduleA.total), 60));
    out.push(pad(`Standard deduction${stdGiftClause(R0.standardDeduction)}`, moneyCents(R0.standardDeduction.total), 60));
    out.push(pad(R0.verdict.itemize ? 'Itemizing wins by' : 'Standard deduction wins by', moneyCents(Math.abs(R0.verdict.difference)), 60));
    if (R0.scheduleC.hasActivity) out.push(pad('Schedule C expenses', moneyCents(R0.scheduleC.total), 60));
    if (R0.adjustments.studentLoanInterest.paid) out.push(pad('Student loan interest (adjustment)', moneyCents(R0.adjustments.studentLoanInterest.deductible), 60));
    const notes = preparerNotes(R0);
    if (notes.length) { out.push('', 'NOTES FOR THE PREPARER'); notes.forEach((n) => out.push('  • ' + n)); }
    return out.join('\n');
  }

  // =====================================================================
  // ADVISOR — recommendations from your own ledger
  // =====================================================================
  function renderAdvisor() {
    const fk = focusKeyOf(); // a dismissal or a sheet returns focus to a card this render is about to replace
    const adv = state.advice;
    const R0 = state.computed;
    const pr = adv.projection;
    const max = Math.max(pr.projectedTotal, pr.standardDeduction) * 1.12 || 1;
    const pct = (v) => (Math.max(0, v) / max * 100).toFixed(2) + '%';
    const KIND = { log: ['act', 'Log it'], check: ['warn', 'Check'], plan: ['info', 'Plan'], good: ['good', 'On track'], habit: ['info', 'Habit'] };
    const actionLabel = (r) => (!r.action ? '' : ({ prefill: 'Log it', edit: 'Open entry', ledger: 'Open ledger', capture: 'Log something', settings: 'Open settings' })[r.action.type] || 'Open');
    const recHTML = (r) => `<article class="insight insight-${KIND[r.kind][0]} rec"><div class="insight-stripe"></div><div class="insight-body"><div class="insight-top"><span class="pill pill-${KIND[r.kind][0]}">${KIND[r.kind][1]}</span><h3>${esc(r.title)}</h3></div><p>${esc(r.body)}</p><div class="because">Because: ${esc(r.because)}</div><div class="btn-row rec-actions">${r.action ? `<button class="btn btn-sm btn-primary" type="button" data-rec-act="go" data-rec="${esc(r.id)}">${esc(actionLabel(r))}</button>` : ''}<button class="btn btn-sm btn-ghost" type="button" data-rec-act="dismiss" data-rec="${esc(r.id)}">Dismiss</button></div></div></article>`;
    const statusPill = (s) => (s === 'overdue' ? '<span class="pill pill-act">Overdue</span>' : s === 'due' ? '<span class="pill pill-warn">Due</span>' : s === 'lapsed' ? '<span class="pill pill-info" title="Long enough past due that it looks stopped; nothing is projected for it">Stopped?</span>' : '<span class="pill pill-info">Upcoming</span>');
    const closed = !!pr.closed;
    const H = adv.habits;
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const receiptRows = Object.values(H.receiptsBySection).sort((a, b) => b.count - a.count);
    const ye = yearEntries();

    $('#view-advisor').innerHTML = `
      <section class="card verdict">
        <div class="verdict-kicker"><span class="pill pill-accent">${closed ? 'Year in review' : 'Year-end forecast'}</span><span class="pill pill-info">${R0.taxYear}</span>${pr.projectedEntries ? `<span class="pill pill-info">${pr.projectedEntries} expected ${pr.projectedEntries === 1 ? 'entry' : 'entries'} still to come</span>` : ''}</div>
        <h2 class="verdict-title">${closed ? (pr.itemize ? 'Itemizing won' : 'The standard deduction won') : (pr.itemize ? 'On pace to itemize' : 'On pace for the standard deduction')}</h2>
        <div class="hero">${pr.itemize ? `${money(pr.projectedTotal - pr.standardDeduction)} <small>${closed ? 'above' : 'projected above'} the standard deduction</small>` : `${money(pr.gap)} <small>${closed ? 'short' : 'projected short'} of itemizing</small>`}</div>
        <p class="verdict-note">${closed ? `${money(pr.actual)} counted for ${R0.taxYear} against a ${money(pr.standardDeduction)} standard deduction.` : `${money(pr.actual)} counts so far.${pr.expectedMore > 0 ? ` Recurring payees found in your entries should add about ${money(pr.expectedMore)} by Dec 31, for a projected ${money(pr.projectedTotal)}` : ` Nothing more is expected from recurring payees, so the projection stays at ${money(pr.projectedTotal)}`} against a ${money(pr.standardDeduction)} standard deduction.`}${pr.calibration && pr.calibration.factor !== 1 ? ` The expected part is calibrated ×${pr.calibration.factor} from ${pr.calibration.n} past forecasts.` : ''}${pr.medicalPending ? ' Medical costs are waiting on your AGI in Settings.' : ''}</p>
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
          ${adv.recurrences.map((r) => `<tr><td><b>${esc(r.description)}</b><br><span class="muted small">${esc(r.label)}</span></td><td>${esc(r.cadenceLabel)}<br><span class="muted small">${r.count} times</span></td><td class="num">${esc(r.unit === 'miles' ? fmtMiles(r.typicalAmount) : moneyCents(r.typicalAmount))}</td><td>${esc(P.formatDate(r.lastDate, r.lastDate.slice(0, 4) !== String(R0.taxYear)))}</td><td>${esc(P.formatDate(r.nextDate, r.nextDate.slice(0, 4) !== String(R0.taxYear)))}</td><td>${statusPill(r.status)}</td></tr>`).join('')}
        </tbody></table></div>
      </section>` : ''}

      ${forecastCardHTML()}

      <section class="card">
        <div class="card-head"><h2>How you use it</h2><span class="muted small">computed from your entries</span></div>
        <div class="kpis">
          ${kpi('Entries per week', String(H.entriesPerWeek), `${ye.length} this year`)}
          ${kpi('Typical gap', H.typicalGapDays == null ? '—' : `${Math.round(H.typicalGapDays)} d`, H.daysSinceLast == null ? 'between logging days' : H.daysSinceLast === 0 ? 'you logged today' : `${H.daysSinceLast} ${plural(H.daysSinceLast, 'day')} since your last entry`)}
          ${kpi('Logging day', H.busiestWeekday == null ? '—' : WEEKDAYS[H.busiestWeekday], 'when you log most')}
          ${kpi('Receipts', `${Math.round(R0.substantiation.coverage * 100)}%`, 'of dollar entries')}
        </div>
        ${receiptRows.length ? `<div class="bars" style="margin-top:14px">${receiptRows.map((s) => { const p = s.withReceipt / s.count * 100; return `<div class="bar-row"><div class="bar-label">${esc(s.title)}<small>${s.withReceipt} of ${s.count} with receipts</small></div><div class="bar-track" data-tip="${esc(`${Math.round(p)}% with receipts`)}" role="img" aria-label="${esc(`${Math.round(p)}% with receipts`)}" tabindex="0"><div class="bar-gross" style="width:100%"></div><div class="bar-counts" style="width:${p.toFixed(1)}%"></div><div class="bar-value" style="left:min(${p.toFixed(1)}%, calc(100% - 54px))">${Math.round(p)}%</div></div></div>`; }).join('')}</div>` : ''}
      </section>

      <section class="card">
        <div class="card-head"><h2>Your data</h2><span class="pill pill-good">On this device only</span></div>
        <p class="note">Everything on this page is computed here, from the entries you typed. Nothing is collected in the background and nothing is sent anywhere. The one thing that could ever leave is the summary below, and only if you send it yourself: a coarse profile with no payees, notes, dates, receipts, exact amounts, or exact income. It is yours. Share it with a preparer, contribute it to a benchmark, or never use it.</p>
        <pre class="aggregate" id="aggregatePre">${esc(JSON.stringify(adv.aggregate, null, 2))}</pre>
        <div class="btn-row"><button class="btn" type="button" id="copyAggregate">Copy summary</button><button class="btn" type="button" id="downloadAggregate">Download summary</button>${adv.dismissed.length ? `<button class="btn btn-ghost" type="button" id="undismiss">Show ${adv.dismissed.length} dismissed</button>` : ''}</div>
      </section>`;

    const root = $('#view-advisor');
    listen(root, 'click', (ev) => { const b = ev.target.closest('[data-rec-act]'); if (b) handleRecAction(b).catch(() => toast('Something went wrong. Nothing was changed.')); });
    const ls = $('#loadSample'); if (ls) ls.onclick = loadSampleData;
    $('#copyAggregate').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(adv.aggregate, null, 2)); toast('Summary copied.'); } catch (e) { toast('Select the text and copy it.'); } };
    $('#downloadAggregate').onclick = () => downloadText(`itemizer-summary-${R0.taxYear}.json`, JSON.stringify(adv.aggregate, null, 2), 'application/json');
    const ud = $('#undismiss'); if (ud) ud.onclick = async () => {
      try { await DB.clearDismissals(); } catch (e) { toast(`Could not bring them back: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      state.dismissed = {}; recompute(); render(); toast('All recommendations are visible again.');
    };
    const ics = $('#icsBtn'); if (ics) ics.onclick = () => { const text = icsText(); if (!text) { toast(`Nothing is due for the rest of ${R0.taxYear}, so there is nothing to add to a calendar.`, 6000); return; } downloadText(`itemizer-due-dates-${R0.taxYear}.ics`, text, 'text/calendar'); };
    restoreFocus(fk);
  }

  function forecastCardHTML() {
    const snaps = state.snapshots;
    const rows = state.validation || [];
    const calib = (state.advice.projection && state.advice.projection.calibration) || { factor: 1, n: 0 };
    const live = snaps.filter((s) => s.taxYear === state.computed.taxYear);
    const sum = EXP.summary(rows);
    return `<section class="card">
      <div class="card-head"><h2>Forecast check</h2><span class="muted small">${state.settings.experimentSnapshots === false ? 'snapshots are off' : `${snaps.length} monthly ${snaps.length === 1 ? 'snapshot' : 'snapshots'} on this device`}</span></div>
      ${rows.length ? `<p class="note">Past forecasts against the finished year${sum ? `: off by ${Math.round(sum.maePct * 100)}% on average, running ${sum.biasPct >= 0 ? 'high' : 'low'} by ${Math.abs(Math.round(sum.biasPct * 100))}%; the itemize call was right ${sum.verdictRight} of ${sum.verdictTotal} times` : ''}.</p>
      <div class="table-wrap"><table class="table-twin"><thead><tr><th>Forecast made</th><th class="num">Projected</th><th class="num">Final</th><th class="num">Off by</th><th>Call</th></tr></thead><tbody>${rows.slice(-12).map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${money(r.projectedTotal)}</td><td class="num">${money(r.final)}</td><td class="num">${r.error > 0 ? '+' : ''}${money(r.error)}</td><td>${r.verdictRight ? '<span class="pill pill-good">right</span>' : '<span class="pill pill-warn">wrong</span>'}</td></tr>`).join('')}</tbody></table></div>
      <p class="note small" style="margin-top:8px">Calibration in use: ${calib.factor === 1 ? 'none' : `×${calib.factor} on the expected-to-come part`} (${esc(calib.basis || '')}).</p>` : `<p class="note">Each month the advisor's year-end forecast is written down here (kept ${EXP.KEEP_MONTHS} months, then dropped). When the year closes, every forecast is checked against the final figure and the advisor calibrates itself. ${live.length ? `${live.length} ${live.length === 1 ? 'snapshot' : 'snapshots'} taken for ${state.computed.taxYear} so far.` : 'Nothing to check yet.'}</p>`}
      ${live.length ? `<div class="table-wrap"><table class="table-twin"><thead><tr><th>Month</th><th class="num">Counted so far</th><th class="num">Projected year end</th><th>Call</th></tr></thead><tbody>${live.map((s) => `<tr><td>${esc(s.month)}</td><td class="num">${money(s.actual)}</td><td class="num">${money(s.projectedTotal)}</td><td>${s.itemize ? 'itemize' : 'standard'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>`;
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  function renderSettings() {
    const fk = focusKeyOf();
    const s = state.settings;
    const R0 = state.computed;
    const P0 = R0.params;
    const marriedJoint = s.filingStatus === 'mfj'; // a qualifying surviving spouse files alone: no spouse add-on
    const overrides = state.overrides[R0.taxYear] || {};
    const defaults = R.getParams(R0.taxYear, {});
    const fmtParam = (kind, v) => (kind === 'usd' ? money(v) : kind === 'rate' ? R.pct(v) : R.perMile(v));
    const toInput = (kind, v) => (kind === 'usd' ? String(Math.round(v)) : String(Math.round(v * 1000) / 10));
    const learnedKeys = Object.keys(state.learned).sort();
    const dismissedCount = Object.keys(state.dismissed).length;

    $('#view-settings').innerHTML = `
      <div class="settings-grid">
        <section class="card">
          <div class="card-head"><h2>About you</h2><span class="muted small">drives the standard deduction and floors</span></div>
          <div class="grid-2">
            <label class="field"><span>Name on the return</span><input id="sName" value="${esc(s.taxpayerName || '')}" placeholder="printed on the worksheet" autocomplete="name" maxlength="120"></label>
            <label class="field"><span>Filing status</span><select id="sFiling" class="input">${R.FILING_STATUSES.map((f) => `<option value="${f.id}" ${s.filingStatus === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
            <label class="field"><span>Estimated AGI ($)</span><input id="sAgi" inputmode="numeric" value="${esc(s.agi)}" placeholder="e.g. 95000"></label>
            <div class="field"><span>Age &amp; vision</span><div class="chips"><label class="check"><input type="checkbox" id="sAge65" ${s.age65 ? 'checked' : ''}> I'm 65 or older</label><label class="check"><input type="checkbox" id="sBlind" ${s.blind ? 'checked' : ''}> I'm blind</label></div></div>
            <div class="field" ${marriedJoint ? '' : 'hidden'}><span>Spouse</span><div class="chips"><label class="check"><input type="checkbox" id="sSpouseAge65" ${s.spouseAge65 ? 'checked' : ''}> Spouse is 65 or older</label><label class="check"><input type="checkbox" id="sSpouseBlind" ${s.spouseBlind ? 'checked' : ''}> Spouse is blind</label></div></div>
            <label class="field"><span>Gambling winnings reported ($)</span><input id="sWinnings" inputmode="numeric" value="${esc(s.gamblingWinnings)}" placeholder="0"></label>
            <label class="field"><span>State &amp; local income tax withheld ($)</span><input id="sWithheld" inputmode="numeric" value="${esc(s.stateWithholding || '')}" placeholder="W-2 boxes 17 and 19"><small class="muted">Tax withheld for another state counts here too.</small></label>
            <label class="field"><span>State</span><select id="sState" class="input"><option value="">Not set</option>${G.US_STATES.map((st) => `<option value="${st.code}" ${s.state === st.code ? 'selected' : ''}>${esc(st.name)}</option>`).join('')}</select></label>
            <label class="field"><span>County</span><input id="sCounty" value="${esc(s.county || '')}" placeholder="for disaster lookups"></label>
            <div class="field span-2"><span>Location</span><div class="btn-row"><button class="btn btn-sm" type="button" id="sLocate">Use my location to fill in state and county</button></div></div>
            <div class="field span-2"><span>Casualty losses</span>
              <div class="chips"><label class="check"><input type="checkbox" id="sDisaster" ${s.casualtyFederalDisaster ? 'checked' : ''}> From a ${R0.taxYear >= 2026 ? 'federally or state-declared' : 'federally declared'} disaster</label><label class="check" ${s.casualtyFederalDisaster ? '' : 'hidden'}><input type="checkbox" id="sQualifiedDisaster" ${s.casualtyQualifiedDisaster ? 'checked' : ''}> Qualified disaster loss, for a federal disaster declared between January 2020 and September 2025 ($500 floor, no AGI reduction, counts without itemizing)</label><input id="sDisasterNumber" class="input" style="max-width:220px" value="${esc(s.disasterNumber || '')}" placeholder="FEMA declaration number" aria-label="FEMA declaration number"><button class="btn btn-sm" type="button" id="femaLookup">Look up declarations for ${esc(s.state || 'my state')}</button></div>
              <div id="femaPanel" role="status" aria-live="polite"></div>
              ${R0.taxYear >= 2026 && s.casualtyFederalDisaster ? `<p class="note small">A disaster declared in 2026 cannot be a qualified disaster loss: that treatment covers federal declarations made between January 2020 and September 2025. A 2026 loss from a state-declared disaster still belongs on Schedule A, after the $100 floor and 10 percent of your AGI.</p>` : ''}
            </div>
          </div>
          <p class="note" style="margin-top:12px">AGI is adjusted gross income — roughly wages plus other income, minus adjustments like retirement contributions and student loan interest. Last year's Form 1040 line 11 is a good estimate. This figure, your filing status, the gambling winnings and the state tax withheld apply to every tax year until you change them.</p>
        </section>

        <section class="card">
          <div class="card-head"><h2>Rates &amp; thresholds for ${R0.taxYear}</h2>${P0.isFallback ? `<span class="pill pill-act">using ${P0.baseYear} figures</span>` : `<span class="pill pill-info">built in</span>`}</div>
          <p class="note">Built-in figures come from IRS inflation-adjustment notices and the 2025 tax law. Override any value the IRS updates; blank restores the default. Percentages are entered as percent (7.5), mileage as cents per mile (72.5).</p>
          <div class="params-wrap"><table class="params"><caption class="sr-only">Rates and thresholds for ${R0.taxYear}: the built-in default and your override for each figure.</caption><thead><tr><th>Figure</th><th class="num">Default</th><th class="num">Your value</th></tr></thead><tbody>
            ${R.paramFields(R0.taxYear, overrides).map((f) => { const def = R.getPath(defaults, f.path); const ov = R.getPath(overrides, f.path); return `<tr><td>${esc(f.label)}</td><td class="num">${esc(fmtParam(f.kind, def))}</td><td class="num"><input data-param="${f.path}" data-kind="${f.kind}" class="${ov != null ? 'is-over' : ''}" inputmode="decimal" value="${ov != null ? esc(toInput(f.kind, ov)) : ''}" placeholder="${esc(toInput(f.kind, def))}" aria-label="${esc(f.label)}"></td></tr>`; }).join('')}
          </tbody></table></div>
          <div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" id="resetParams" ${Object.keys(overrides).length ? '' : 'disabled'}>Reset ${R0.taxYear} to defaults</button></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Appearance</h2></div>
          <div class="chips">${[['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<button class="chip" type="button" data-theme-pick="${v}" aria-pressed="${(s.theme || 'system') === v}">${l}</button>`).join('')}</div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Your data</h2><span class="muted small">${state.entries.length} ${plural(state.entries.length, 'entry', 'entries')}, all years · stored on this device</span></div>
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
          <div class="card-head"><h2>Experiments</h2><span class="muted small">on this device, switchable, expiring</span></div>
          <p class="note">Three ways the app studies its own judgement and checks it later. Nothing here leaves the device.</p>
          <div class="chips" style="margin-top:10px">
            <label class="check"><input type="checkbox" id="xSnapshots" ${s.experimentSnapshots === false ? '' : 'checked'}> Monthly forecast snapshots, checked when the year closes</label>
            <label class="check"><input type="checkbox" id="xCorrections" ${s.experimentCorrections === false ? '' : 'checked'}> Learn from corrected suggestions</label>
            <label class="check"><input type="checkbox" id="xNudges" ${s.experimentNudges === false ? '' : 'checked'}> A follow-up right after a save</label>
          </div>
          <p class="note small" style="margin-top:8px">With "Learn from corrected suggestions" off, the weights already stored are kept but no longer applied; "Reset keyword weights" deletes them.</p>
          ${Object.keys(state.weights).length ? `<div class="learned-list" style="margin-top:10px">${Object.entries(state.weights).sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1)).slice(0, 12).map(([k, v]) => `<div class="learned-item"><span><span class="k">${esc(k)}</span> <span class="v">${v < 1 ? 'demoted' : 'boosted'} to ×${v}</span></span></div>`).join('')}</div>${Object.keys(state.weights).length > 12 ? `<p class="note small">The twelve furthest from normal are shown; ${Object.keys(state.weights).length - 12} other ${plural(Object.keys(state.weights).length - 12, 'keyword')} also ${Object.keys(state.weights).length - 12 === 1 ? 'carries' : 'carry'} a weight.</p>` : ''}` : ''}
          <div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" id="xClearSnapshots" ${state.snapshots.length ? '' : 'disabled'}>Clear ${state.snapshots.length} ${state.snapshots.length === 1 ? 'snapshot' : 'snapshots'}</button><button class="btn btn-sm" type="button" id="xResetWeights" ${Object.keys(state.weights).length ? '' : 'disabled'}>Reset keyword weights</button></div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Learned categories</h2><span class="muted small">${learnedKeys.length} remembered</span></div>
          <p class="note">When you file something, its description is remembered so the same payee lands on the same line next time. Remove one if it learned wrong.</p>
          ${learnedKeys.length ? `<div class="learned-list" style="margin-top:10px">${learnedKeys.map((k) => { const l = S.getLine(state.learned[k]); return `<div class="learned-item"><span><span class="k">${esc(k)}</span> <span class="v">→ ${esc(l ? l.label : state.learned[k])}</span></span><button class="btn btn-ghost btn-sm" type="button" data-forget="${esc(k)}">Forget</button></div>`; }).join('')}</div><div class="btn-row" style="margin-top:10px"><button class="btn btn-sm" type="button" id="forgetAll">Forget all</button></div>` : ''}
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
          <p class="note">Itemizer is modelled on the “Keep track of your expenses” organizer sheet tax preparers hand out. Every line on that sheet is here, plus the arithmetic the sheet leaves to you: the medical floor as a share of AGI, the state-and-local-tax cap, gift substantiation rules, mileage rates, and the standard-deduction comparison that decides whether any of it matters.</p>
          <p class="note" style="margin-top:8px">It is a planning tool, not tax advice. Rates and thresholds change; verify against current IRS publications (Schedule A instructions, Pub. 502, 526, 529, 970) or your preparer before filing.</p>
        </section>
      </div>`;

    // the store is the record: a field that could not be written goes back to what is stored rather than staying on screen and in the figures
    let stored = Object.assign({}, s);
    /** Write only what this control changed: a whole-row write from a tab open since this morning would undo what another tab saved. */
    const save = async (patch) => {
      try { Object.assign(state.settings, await DB.updateSettings(patch)); } // the same object throughout: these handlers hold a reference to it
      catch (err) {
        Object.assign(s, stored);
        toast(`Could not save: ${err && err.message ? err.message : 'storage error'}.`, 6000);
        renderSettings();
        return false;
      }
      stored = Object.assign({}, s);
      recompute();
      return true;
    };
    $('#sFiling').onchange = async (ev) => { s.filingStatus = ev.target.value; await save({ filingStatus: s.filingStatus }); renderSettings(); };
    $('#sName').addEventListener('change', async (ev) => { s.taxpayerName = ev.target.value.trim().slice(0, 120); ev.target.value = s.taxpayerName; await save({ taxpayerName: s.taxpayerName }); });
    // a figure that cannot be read goes back to what is stored: a stripped one would change the floors and the verdict without saying so
    const moneyField = (id, key, help) => {
      const el = $('#' + id); if (!el) return;
      el.addEventListener('change', async (ev) => {
        const v = parseDollarField(ev.target.value);
        if (v === null) { ev.target.value = s[key] || ''; toast(help, 5000); return; }
        s[key] = v; ev.target.value = v; await save({ [key]: v });
      });
    };
    moneyField('sAgi', 'agi', 'Enter the AGI as a plain number, for example 95000.');
    for (const [id, key] of [['sAge65', 'age65'], ['sBlind', 'blind'], ['sSpouseAge65', 'spouseAge65'], ['sSpouseBlind', 'spouseBlind'], ['sDisaster', 'casualtyFederalDisaster'], ['sQualifiedDisaster', 'casualtyQualifiedDisaster']]) {
      const el = $('#' + id); if (el) el.onchange = async () => {
        s[key] = el.checked;
        if (key === 'casualtyFederalDisaster' && !el.checked) s.casualtyQualifiedDisaster = false; // hidden and still set, it would go on changing the figures
        await save(key === 'casualtyFederalDisaster' ? { casualtyFederalDisaster: s.casualtyFederalDisaster, casualtyQualifiedDisaster: s.casualtyQualifiedDisaster } : { [key]: s[key] });
        if (key === 'casualtyFederalDisaster') renderSettings();
      };
    }
    moneyField('sWinnings', 'gamblingWinnings', 'Enter the winnings as a plain number, for example 1200.');
    moneyField('sWithheld', 'stateWithholding', 'Enter the tax withheld as a plain number, for example 4200.');
    $('#sState').onchange = async (ev) => { s.state = ev.target.value; await save({ state: s.state }); renderSettings(); };
    $('#sCounty').addEventListener('change', async (ev) => { s.county = ev.target.value.trim(); await save({ county: s.county }); });
    $('#sDisasterNumber').addEventListener('change', async (ev) => { s.disasterNumber = ev.target.value.trim(); await save({ disasterNumber: s.disasterNumber }); });
    $('#sLocate').onclick = async () => {
      const btn = $('#sLocate'); btn.disabled = true;
      try {
        const pos = await G.getPosition();
        const r = await G.reverse(pos.lat, pos.lon);
        if (r.stateCode) s.state = r.stateCode;
        if (r.county) s.county = r.county.replace(/\s+County$/i, '');
        await save({ state: s.state, county: s.county }); renderSettings();
        toast(r.stateCode ? `Set to ${r.stateCode}${s.county ? ', ' + s.county : ''}.` : 'Could not tell the state from that location.');
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    $('#femaLookup').onclick = async () => {
      const panel = $('#femaPanel');
      if (!s.state) { toast('Pick your state first.'); return; }
      panel.innerHTML = '<p class="note small">Looking up FEMA declarations…</p>';
      try {
        const list = await G.femaDeclarations({ state: s.state, county: s.county, since: `${R0.taxYear}-01-01`, until: `${R0.taxYear + 1}-01-01` });
        if (!list.length) { panel.innerHTML = `<p class="note small">The lookup returned no federal declarations for ${esc(s.state)}${s.county ? ', ' + esc(s.county) : ''} for tax year ${R0.taxYear}. The list may be incomplete or lag the event; check FEMA.gov or your state's emergency management site, and enter the declaration number by hand if you find one.</p>`; return; }
        panel.innerHTML = `<div class="fema-list">${list.slice(0, 12).map((d) => `<div class="fema-item"><span><b>${esc(d.type)}-${esc(d.number)}</b> ${esc(d.title)}<br><span class="muted small">${esc(d.incident)} · declared ${esc(d.declared)} · ${esc(d.area)}</span></span><button class="btn btn-sm" type="button" data-fema="${esc(d.type)}-${esc(d.number)}">Use</button></div>`).join('')}</div>`;
        panel.querySelectorAll('[data-fema]').forEach((b) => { b.onclick = async () => { s.casualtyFederalDisaster = true; s.disasterNumber = b.dataset.fema; await save({ casualtyFederalDisaster: true, disasterNumber: s.disasterNumber }); renderSettings(); toast(`Casualty losses marked as federal disaster ${b.dataset.fema}.`); }; });
      } catch (e) { panel.innerHTML = `<p class="note small">${esc(e.message)}</p>`; }
    };
    $$('[data-param]').forEach((inp) => inp.addEventListener('change', async () => {
      const path = inp.dataset.param, kind = inp.dataset.kind;
      const raw = inp.value.trim().replace(/[$,%¢]/g, '');
      const n = Number(raw);
      // the boxes take cents and percent, not dollars and shares: "0.70" in a mileage box would value a drive at less than a cent a mile
      const problem = raw === '' ? null
        : !Number.isFinite(n) || n < 0 ? 'Enter a number, or leave the box empty to use the default.'
        : kind === 'permile' && (n < 1 || n > 200) ? 'Enter the mileage rate in cents per mile, for example 72.5.'
        : kind === 'rate' && n > 100 ? 'Enter the percentage as a percent, for example 7.5.'
        : null;
      if (problem) { const was = R.getPath(state.overrides[R0.taxYear] || {}, path); inp.value = was != null ? toInput(kind, was) : ''; toast(problem, 6000); return; }
      const before = state.overrides[R0.taxYear] ? JSON.parse(JSON.stringify(state.overrides[R0.taxYear])) : null;
      if (!state.overrides[R0.taxYear]) state.overrides[R0.taxYear] = {};
      const ov = state.overrides[R0.taxYear];
      if (raw === '') unsetPath(ov, path);
      else R.setPath(ov, path, kind === 'usd' ? n : n / 100);
      if (!Object.keys(ov).length) delete state.overrides[R0.taxYear];
      try { await DB.syncOverrides(R0.taxYear, ov); } // one row per overridden parameter
      catch (e) {
        // the figures on screen are worked from these overrides: one that was not written must not stay in them
        if (before) state.overrides[R0.taxYear] = before; else delete state.overrides[R0.taxYear];
        toast(`Could not save that figure: ${e && e.message ? e.message : 'storage error'}.`, 6000);
      }
      recompute(); renderSettings();
    }));
    $('#resetParams').onclick = async () => {
      const before = state.overrides[R0.taxYear];
      delete state.overrides[R0.taxYear];
      try { await DB.syncOverrides(R0.taxYear, {}); }
      catch (e) { if (before) state.overrides[R0.taxYear] = before; recompute(); renderSettings(); toast(`Could not restore the defaults: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      recompute(); renderSettings(); toast('Defaults restored.');
    };
    // save() puts a setting that could not be written back, so the theme is applied again from whatever is now stored
    $$('[data-theme-pick]').forEach((b) => b.onclick = async () => { s.theme = b.dataset.themePick; applyTheme(); await save({ theme: s.theme }); applyTheme(); renderSettings(); });
    $('#exportJson').onclick = async () => {
      const btn = $('#exportJson'); btn.disabled = true;
      try {
        const out = await DB.exportBackup();
        await downloadBlob(`itemizer-backup-${P.todayISO()}.json`, out.blob, 'application/json');
        if (out.failed) toast(`Backup saved; ${out.failed} receipt ${out.failed === 1 ? 'photo' : 'photos'} could not be read and ${out.failed === 1 ? 'was' : 'were'} left out.`, 7000);
      } catch (e) { toast(`Could not build the backup: ${e && e.message ? e.message : 'unknown error'}.`, 6000); }
      finally { btn.disabled = false; }
    };
    $('#importJson').onclick = () => $('#importInput').click();
    $('#exportAllCsv').onclick = () => downloadText('itemizer-all-years.csv', DB.toCSV(state.entries, S), 'text/csv');
    const ls = $('#loadSample2'); if (ls) ls.onclick = loadSampleData;
    const rs = $('#removeSamples2'); if (rs) rs.onclick = removeSampleData;
    $$('[data-forget]').forEach((b) => b.onclick = async () => {
      const key = b.dataset.forget, was = state.learned[key];
      C.forget(state.learned, key);
      try { await DB.deleteLearned(key); } catch (e) { if (was) state.learned[key] = was; toast(`Could not forget that payee: ${e && e.message ? e.message : 'storage error'}.`, 6000); }
      renderSettings();
    });
    const fa = $('#forgetAll'); if (fa) fa.onclick = async () => {
      const was = state.learned;
      state.learned = {};
      try { await DB.clearLearned(); } catch (e) { state.learned = was; toast(`Could not forget them: ${e && e.message ? e.message : 'storage error'}.`, 6000); }
      renderSettings();
    };
    for (const [id, key] of [['xSnapshots', 'experimentSnapshots'], ['xCorrections', 'experimentCorrections'], ['xNudges', 'experimentNudges']]) {
      const el = $('#' + id); if (el) el.onchange = async () => { s[key] = el.checked; await save({ [key]: s[key] }); };
    }
    $('#xClearSnapshots').onclick = async () => {
      const was = state.snapshots;
      state.snapshots = [];
      try { await DB.clearSnapshots(); } catch (e) { state.snapshots = was; recompute(); renderSettings(); toast(`Could not clear them: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      recompute(); renderSettings(); toast("Forecast snapshots cleared. This month's forecast for the live year is written down again.");
    };
    $('#xResetWeights').onclick = async () => {
      const was = state.weights;
      state.weights = {};
      try { await DB.clearWeights(); } catch (e) { state.weights = was; renderSettings(); toast(`Could not reset them: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      renderSettings(); toast('Keyword weights reset.');
    };
    $('#resetDismissed').onclick = async () => {
      try { await DB.clearDismissals(); } catch (e) { toast(`Could not bring them back: ${e && e.message ? e.message : 'storage error'}.`, 6000); return; }
      state.dismissed = {}; recompute(); renderSettings(); toast('All recommendations are visible again.');
    };
    $('#wipeAll').onclick = async () => {
      if (!(await confirmDialog('Delete everything?', 'All entries, receipts, learned categories, and settings on this device will be removed.', 'Delete all data', true))) return;
      let failure = null;
      try { await DB.clearAll(); } catch (e) { failure = e; }
      // clearAll clears one store at a time, so whatever survived is what the views have to show: the state is re-read either way
      try { await reloadState(); } catch (e) { if (!failure) failure = e; }
      applyTheme(); render();
      if (failure) toast(`Could not delete everything: ${failure.message ? failure.message : 'storage error'}. Some records may still be on this device.`, 8000);
      else toast('All data deleted.');
    };
    DB.storageInfo().then((info) => {
      const el = $('#storageNote'); if (!el) return;
      const used = info.estimate && info.estimate.usage ? ` · ${(info.estimate.usage / 1048576).toFixed(1)} MB used` : '';
      let text = info.mode === 'idb' ? `Stored in this browser's IndexedDB, one table per kind of record${used}.`
        : info.mode === 'local' ? 'This browser has no IndexedDB, so the same tables are kept in localStorage and receipt photos cannot be stored.'
        // the store could not be opened at all, so every write is failing: saying where the data is kept would be untrue
        : info.mode === 'unavailable' ? 'Local storage could not be opened, so nothing is being saved. Close other Itemizer tabs and reload.'
        : 'This browser offers neither IndexedDB nor localStorage; nothing is saved between sessions.';
      if (info.counts) text += ` Rows: ${Object.entries(info.counts).map(([k, n]) => `${k} ${n == null ? '?' : n}`).join(' · ')}.`;
      if (info.persisted === true) text += ' The browser has agreed not to evict this data.';
      else if (info.persisted === false) text += ' The browser may delete this data when disk space runs low (Safari: after 7 days without a visit). Install the app to your home screen and download a backup now and then.';
      if (info.notice) text += ` ${info.notice}`;
      el.textContent = text;
    });
    restoreFocus(fk);
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
  let themeColors = null; // the pair index.html ships, read once so the colours are not written down twice
  function applyTheme() {
    const t = state.settings && state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    // the metas are media-gated on the device setting, so a forced theme would otherwise leave the status bar the other colour
    const metas = $$('meta[name="theme-color"]');
    if (!metas.length) return;
    if (!themeColors) {
      const forMedia = (want) => (metas.find((m) => (m.media || '').includes(want)) || metas[0]).content;
      themeColors = { light: forMedia('light'), dark: forMedia('dark'), device: metas.map((m) => m.content) };
    }
    metas.forEach((m, i) => { m.content = t === 'dark' ? themeColors.dark : t === 'light' ? themeColors.light : themeColors.device[i]; });
  }

  async function importBackup(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not readable JSON.'); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'itemizer' || !Array.isArray(data.entries)) { toast('That file is not an Itemizer backup.'); return; }
    const nReceipts = Array.isArray(data.receipts) ? data.receipts.length : 0;
    const ok = await confirmDialog('Restore this backup?', `${data.entries.length} ${plural(data.entries.length, 'entry', 'entries')} and ${nReceipts} ${plural(nReceipts, 'receipt')} will be merged with what is already here. Existing entries with the same id are replaced.`, 'Restore');
    if (!ok) return;
    if (!(await confirmDiscardWork('The backup will be restored.'))) return;
    let res = null, failure = null;
    try { res = await DB.importJSON(data, { schema: S }); } catch (e) { failure = e; }
    // the backup is written store by store, so some rows can land before a failure: the views are re-read from what is actually there
    try { await reloadState(); } catch (e) { if (!failure) failure = e; }
    applyTheme();
    render();
    if (failure) toast(`${failure.message || 'The backup could not be restored.'} The ledger now shows what is actually stored.`, 8000);
    // a backup can be missing a photo an entry names, or carry a photo whose entry is gone: both are worth saying, since the ledger will look different from the file
    else toast(`Restored ${res.entries} entries and ${res.receipts} receipts.${res.skipped ? ` ${res.skipped} ${res.skipped === 1 ? 'row was' : 'rows were'} not valid and skipped.` : ''}${res.badReceipts ? ` ${res.badReceipts} receipt ${res.badReceipts === 1 ? 'image' : 'images'} could not be read.` : ''}${res.dangling ? ` ${res.dangling} ${plural(res.dangling, 'entry', 'entries')} referenced a photo that was not in the file; the photo mark was cleared.` : ''}${res.orphanReceipts ? ` ${res.orphanReceipts} ${plural(res.orphanReceipts, 'photo')} had no entry and ${res.orphanReceipts === 1 ? 'was' : 'were'} left out.` : ''}`, 9000);
  }

  // ---- example data ---------------------------------------------------------
  function sampleEntries(year) {
    const now = new Date().toISOString();
    const today = P.todayISO();
    if (year > Number(today.slice(0, 4))) return []; // every row would be dated in the future, and the prior-year tail would land in a year the user is not looking at
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
  let loadingSample = false;
  async function loadSampleData() {
    if (loadingSample) return; // three buttons lead here; a double tap must not load the set twice
    loadingSample = true;
    try { await loadSampleDataNow(); }
    catch (e) { toast(`Could not load the examples: ${e && e.message ? e.message : 'storage error'}. Nothing was added.`, 6000); }
    finally { loadingSample = false; }
  }
  async function loadSampleDataNow() {
    const year = Number(state.settings.taxYear);
    const entries = sampleEntries(year);
    if (!entries.length) { toast(`The examples only cover a tax year that has already started, so nothing was added for ${year}.`, 6000); return; }
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
    const older = entries.filter((e) => Number(e.taxYear) !== year).length;
    toast(`Loaded ${entries.length} example entries${placesAdded ? ` and ${placesAdded} example places` : ''} for ${year}${older ? `, ${older} of them dated ${year - 1} so the advisor can see last year's pattern` : ''}. Remove them any time from the ledger.`, 6000);
    render();
  }
  async function removeSampleData() {
    const samples = state.entries.filter((e) => e.sample);
    // the button removes the examples of every tax year, including any the user has attached a photo to since
    if (samples.length && !(await confirmDialog(`Remove ${samples.length} example ${plural(samples.length, 'entry', 'entries')}?`, `The examples of every tax year go, with the example places and the example trip. ${UNDO_HINT}`, 'Remove', true))) return;
    try {
      const samplePlaceIds = new Set(state.places.filter((x) => x.sample).map((p) => p.id));
      for (const id of samplePlaceIds) await DB.deletePlace(id);
      state.places = state.places.filter((x) => !x.sample);
      // only the log rows left without an entry are removed here; the rest go with their entries below, and come back with them
      const sampleIds = new Set(samples.map((e) => e.id));
      for (const t of state.trips.filter((x) => x.sample && !sampleIds.has(x.entryId))) await DB.deleteTrip(t.id);
      state.trips = state.trips.filter((x) => !x.sample || sampleIds.has(x.entryId));
      // a recording of a real drive has nothing to do with the examples: only the places it points at have gone
      if (state.trip) { if (samplePlaceIds.has(state.trip.fromId)) state.trip.fromId = ''; if (samplePlaceIds.has(state.trip.toId)) state.trip.toId = ''; }
      // a forecast an earlier version wrote down while the examples were loaded would be graded later as if it were real
      const key = EXP.monthKey(P.todayISO()), year = Number(state.settings.taxYear);
      const emptied = new Set([...new Set(samples.map((e) => Number(e.taxYear)))].filter((y) => !state.entries.some((e) => !e.sample && Number(e.taxYear) === y)));
      const kept = state.snapshots.filter((sn) => !(sn.month === key && sn.taxYear === year) && !emptied.has(Number(sn.taxYear)));
      if (kept.length !== state.snapshots.length) { state.snapshots = kept; await DB.syncSnapshots(state.snapshots).catch(() => {}); }
      // the same path as any other delete, so an example the user has since made their own can be brought back
      if (samples.length) await deleteWithUndo(samples); else render();
    } catch (e) {
      toast(`Could not remove the examples: ${e && e.message ? e.message : 'storage error'}.`, 6000);
      // the rows go one at a time, so what is left is read back rather than guessed at; a live recording is left alone
      try { state.entries = await DB.getEntries(); state.places = await DB.getPlaces(); state.trips = await DB.getTrips(); } catch (err) { /* the next start will settle it */ }
      render();
    }
  }

  // ---- bootstrap -------------------------------------------------------------
  let offerWaitingUpdate = null; // set by registerSW: re-offers a version that arrived while a drive was being recorded
  function registerSW() {
    if (globalThis.ITEMIZER_SINGLE_FILE) return;
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    let askedToReload = false, waiting = null;
    // A new version waits until the user chooses to reload, so the cache is never swapped under a half-typed form.
    const offerUpdate = (worker) => {
      if (!worker || !navigator.serviceWorker.controller) return; // first install: nothing is running on the old version
      // Never a Reload button in front of a driver: the recording is in memory and a reload would lose it. It waits for the Stop.
      if (state.recorder && state.recorder.state !== 'idle') { waiting = worker; return; }
      // Navigations are served from the cache, so a fix reaches the user only when this offer is taken: it gets its own
      // banner rather than a toast, which the next passing message would wipe for the rest of the session.
      let el = $('#updateBanner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'updateBanner';
        el.className = 'toast is-on'; // the toast styling, and with it the rule that keeps it off the printed page
        el.setAttribute('role', 'status');
        el.style.bottom = 'calc(var(--tabbar-h) + 72px + env(safe-area-inset-bottom))'; // clear of the toast below it
        document.body.appendChild(el);
      }
      el.textContent = 'A new version of Itemizer is ready.';
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-action'; b.textContent = 'Reload';
      // rebuilt on every offer: a worker replaced while the banner was up would no longer answer the message
      b.onclick = () => { askedToReload = true; worker.postMessage({ type: 'SKIP_WAITING' }); };
      el.appendChild(b);
    };
    offerWaitingUpdate = () => { const w = waiting; waiting = null; if (w) offerUpdate(w); };
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (askedToReload) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg.waiting) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'installed') offerUpdate(reg.waiting || w); });
      });
      // an installed app that lives in the app switcher for weeks checks for a new version whenever it comes back
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        // a version that installed while the app was away fires updatefound only once, so a waiting worker is offered again here
        reg.update().catch(() => {}).then(() => { if (reg.waiting) offerUpdate(reg.waiting); });
      });
    }).catch(() => { /* offline install is a bonus, not a requirement */ });
  }

  /** Load (or reload) everything from storage; used at start, after "Delete all data", and after a restore. */
  async function reloadState() {
    for (const u of state.receiptURLs.values()) URL.revokeObjectURL(u);
    state.receiptURLs.clear();
    sheetReceiptIds.clear();
    discardRecorder();
    state.settings = await DB.getSettings();
    // the six stores the app reads as maps and lists; every write goes back to its own row
    [state.learned, state.weights, state.dismissed, state.layouts, state.snapshots, state.overrides] = await Promise.all([DB.getLearned(), DB.getWeights(), DB.getDismissals(), DB.getLayouts(), DB.getSnapshots(), DB.getOverrides()]);
    state.entries = await DB.getEntries();
    for (const e of state.entries) { try { if (!e.taxYear && typeof e.date === 'string') e.taxYear = Number(e.date.slice(0, 4)); } catch (err) { /* a bad row never blocks start-up */ } }
    try { state.places = await DB.getPlaces(); state.trips = await DB.getTrips(); } catch (e) { state.places = []; state.trips = []; }
    discardCapture();
    state.trip = null; state.importer = null; state.captureMode = 'expense';
    clearLedgerSelection(); // the entries behind a selection may not have survived a restore or a wipe
  }
  async function init() {
    const unfinished = readRecordingCheckpoint(); // read first: reloadState throws away any recorder, and with it the checkpoint
    // Every view is hidden until the first render, and an upgrade blocked by another tab never resolves: say where the app has got to.
    const first = $('#view-capture');
    if (first) { first.hidden = false; first.innerHTML = '<div class="empty"><h3>Opening your ledger…</h3><p class="note" id="bootNote"></p></div>'; }
    // store.js works out the sentence ("close other Itemizer tabs"); until the views exist there is nowhere else to show it
    const bootNotice = setInterval(() => { const p = $('#bootNote'); if (p && DB.notice) p.textContent = DB.notice; }, 800);
    try { await reloadState(); }
    catch (e) {
      state.settings = state.settings || Object.assign({}, DB.DEFAULT_SETTINGS);
      state.entries = state.entries || []; state.places = state.places || []; state.trips = state.trips || [];
      toast(`Local storage could not be opened: ${e && e.message ? e.message : 'unknown error'}. Close other Itemizer tabs and reload; nothing will be saved until then.`, 30000);
    }
    finally { clearInterval(bootNotice); }
    applyTheme();
    await maybeRollYear();
    $('#yearSelect').onchange = (ev) => setTaxYear(ev.target.value);
    $('#receiptInput').onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onReceiptFile(f); };
    $('#receiptPick').onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onReceiptFile(f); };
    $('#importInput').onchange = importBackup;
    $('#csvInput').onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; onCSVFile(f); };
    $('#modal').addEventListener('click', (ev) => { if (ev.target.classList.contains('modal-backdrop')) cancelModal(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('#modal').hidden) cancelModal(); });
    // Escape hides a chart tip without moving the pointer; the next pointer move or Tab brings tips back.
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') document.body.classList.add('tips-off'); });
    document.addEventListener('pointermove', () => document.body.classList.remove('tips-off'));
    document.addEventListener('focusin', () => document.body.classList.remove('tips-off'));
    // The print stylesheet keeps only #view-worksheet, which render() leaves hidden and empty on every other view.
    let printedOffView = false;
    window.addEventListener('beforeprint', () => {
      if (state.view === 'worksheet') return;
      renderWorksheet();
      $('#view-worksheet').hidden = false;
      printedOffView = true;
    });
    window.addEventListener('afterprint', () => {
      if (!printedOffView) return;
      printedOffView = false;
      $('#view-worksheet').hidden = true;
    });
    window.addEventListener('resize', () => { if ($('#trackCanvas')) drawTrack(); });
    window.addEventListener('hashchange', route);
    route();
    registerSW();
    offerUnfinishedRecording(unfinished);
  }

  // Expose a tiny surface for tests and power users.
  globalThis.Itemizer = { state, render, loadSampleData, removeSampleData, compute: recompute, advice: () => state.advice, prefillCapture, measureTrip, logTrip, startRecording, stopRecording, onCSVFile, icsText };

  const start = () => init().catch((e) => {
    try { toast(`Itemizer could not start: ${e && e.message ? e.message : 'unexpected error'}. Reload the page; your entries are still on the device.`, 30000); } catch (err) { /* nothing left to report with */ }
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
