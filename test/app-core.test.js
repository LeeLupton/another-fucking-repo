const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// app.js is an IIFE over `document`, so the pieces under test are lifted out of the source and run against stubs.
const SRC = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
function fn(name) {
  const at = SRC.indexOf(`\n  function ${name}(`);
  assert.ok(at !== -1, `function ${name} not found in app.js`);
  let depth = 0, i = SRC.indexOf('{', at);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(at, i + 1);
}
function line(re) { const m = SRC.match(re); assert.ok(m, `no line in app.js matching ${re}`); return m[0]; }
function load(sources, ctx) { vm.createContext(ctx); vm.runInContext(sources.join('\n'), ctx); return ctx; }
const run = (ctx, expr) => vm.runInContext(expr, ctx); // const declarations live in the script scope, not on the context object
const classList = () => { const set = new Set(); return { set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c) => (set.has(c) ? (set.delete(c), false) : (set.add(c), true)) }; };

test('the tax year advances after New Year unless it was picked since the year turned', () => {
  const ctx = load([fn('shouldAdvanceTaxYear')], {});
  assert.equal(ctx.shouldAdvanceTaxYear(2026, '', '2027-01-02'), true);
  assert.equal(ctx.shouldAdvanceTaxYear(2026, '2026-11-02', '2027-01-02'), true);
  assert.equal(ctx.shouldAdvanceTaxYear(2026, '2027-01-05', '2027-03-01'), false);
  assert.equal(ctx.shouldAdvanceTaxYear(2026, '', '2026-12-31'), false);
  assert.equal(ctx.shouldAdvanceTaxYear(2027, '', '2026-12-31'), false);
});

test('an unknown ledger filter falls back to all', () => {
  const ctx = load([line(/^  const LEDGER_FILTERS = .*$/m), line(/^  const normalizeLedgerFilter = .*$/m)], {});
  assert.equal(run(ctx, 'normalizeLedgerFilter("receipts")'), 'all');
  assert.equal(run(ctx, 'normalizeLedgerFilter("samples")'), 'samples');
  assert.equal(run(ctx, 'normalizeLedgerFilter("noack")'), 'noack');
  assert.equal(run(ctx, 'normalizeLedgerFilter(undefined)'), 'all');
});

test('a business-use share keeps its decimal and is applied in whole cents', () => {
  const ctx = load([fn('parseShare'), fn('shareAmount')], { Number });
  assert.equal(ctx.parseShare('33.3').ok, true);
  assert.equal(ctx.parseShare('33.3').share, 33.3);
  assert.equal(ctx.parseShare('62.5').share, 62.5);
  assert.equal(ctx.parseShare('100').share, 100);
  assert.equal(ctx.parseShare('125').ok, false);
  assert.equal(ctx.parseShare('0').ok, false);
  assert.equal(ctx.parseShare('-5').ok, false);
  assert.equal(ctx.parseShare('abc').ok, false);
  assert.equal(ctx.parseShare('').ok, false);
  assert.equal(ctx.shareAmount(120, 33.3), 39.96);
  assert.equal(ctx.shareAmount(1200, 33.3), 399.6);
  assert.equal(ctx.shareAmount(100.46, 75), 75.35);
  assert.equal(ctx.shareAmount(120, 100), 120);
});

test('Tab stays inside the dialog when focus is on the panel itself', () => {
  const items = ['first', 'middle', 'last'].map((id) => ({ id, offsetParent: {}, focus() { ctx.document.activeElement = this; } }));
  const panel = { querySelectorAll: () => items, contains: (el) => el === panel || items.includes(el), focus() { ctx.document.activeElement = panel; } };
  const ctx = load([line(/^  const FOCUSABLE = .*$/m), fn('trapTab')], { document: { activeElement: panel }, $: (sel) => (sel === '#modalPanel' ? panel : null) });
  const press = (shiftKey) => { let prevented = false; ctx.trapTab({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } }); return prevented; };

  ctx.document.activeElement = panel;
  assert.equal(press(true), true);
  assert.equal(ctx.document.activeElement.id, 'last');
  ctx.document.activeElement = panel;
  assert.equal(press(false), true);
  assert.equal(ctx.document.activeElement.id, 'first');
  // the wrap-around from the ends is unchanged
  ctx.document.activeElement = items[0];
  assert.equal(press(true), true);
  assert.equal(ctx.document.activeElement.id, 'last');
  ctx.document.activeElement = items[2];
  assert.equal(press(false), true);
  assert.equal(ctx.document.activeElement.id, 'first');
});

test('the toast hide timer is armed when the toast is shown, not when it is queued', () => {
  const timers = [];
  const el = { hidden: true, textContent: '', children: [], classList: classList(), appendChild(c) { this.children.push(c); } };
  let frame = null;
  const ctx = load([line(/^  let toastTimer = .*$/m), fn('cancelToastFrame'), fn('hideToast'), fn('toast')], {
    $: (sel) => (sel === '#toast' ? el : null),
    document: { createElement: () => ({ classList: classList(), textContent: '' }) },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: () => {},
    requestAnimationFrame: (f) => { frame = f; return 1; },
    cancelAnimationFrame: () => { frame = null; },
  });

  ctx.toast('Deleted.', 0, { label: 'Undo', onClick() {} });
  assert.equal(timers.length, 0, 'nothing is timed while the toast is still waiting for a frame');
  assert.equal(el.textContent, '');
  frame();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 7000);
  assert.equal(el.textContent, 'Deleted.');
  assert.equal(el.children[0].textContent, 'Undo');
  assert.equal(el.classList.contains('is-on'), true);
});

test('a dialog opened over another keeps the first one opener and scroll position', () => {
  const scrolls = [];
  const opener = { id: 'row', isConnected: true, focus() { ctx.document.activeElement = this; } };
  const main = { id: 'main', focus() { ctx.document.activeElement = this; } };
  const panel = {
    id: 'panel', isConnected: true, innerHTML: '', tabIndex: 0,
    querySelector: () => null, setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    focus() { ctx.document.activeElement = panel; },
  };
  const modal = { hidden: true };
  const body = { style: {} };
  const behind = ['.topbar', '#main', '.tabbar'].map((sel) => ({ sel, setAttribute() {}, removeAttribute() {} }));
  const ctx = load([line(/^  let modalOpener = .*$/m), line(/^  const behindModal = .*$/m), fn('trapTab'), fn('openModal'), fn('closeModal')], {
    $: (sel) => ({ '#modal': modal, '#modalPanel': panel, '#main': main }[sel] || null),
    document: { body, activeElement: opener, querySelector: (sel) => behind.find((el) => el.sel === sel) || null },
    window: { get scrollY() { return body.style.position === 'fixed' ? 0 : 800; }, scrollTo: (x, y) => scrolls.push([x, y]) },
  });

  ctx.openModal('<h2>Edit entry</h2>');
  ctx.openModal('<h2>Receipt</h2>'); // the receipt opened over the edit sheet
  ctx.closeModal();
  assert.deepEqual(scrolls, [[0, 800]]);
  assert.equal(ctx.document.activeElement, opener);
  assert.equal(body.style.position, '');
});

test('the advisor gets the parameter overrides, and a year is graded only once its records are in', () => {
  const computes = [];
  let analyzed = null, finals = null;
  const state = {
    entries: [], settings: { taxYear: 2027, experimentSnapshots: true }, dismissed: {},
    snapshots: [{ taxYear: 2026 }, { taxYear: 2025 }], overrides: { 2026: { mileage: { medical: 0.5 } } },
  };
  const ctx = load([fn('recompute')], {
    state,
    P: { todayISO: () => '2027-02-01' },
    R: { compute: (entries, opts) => { computes.push(opts); return { scheduleA: { total: 100 }, entries: [] }; } },
    EXP: { validate: (snaps, f) => { finals = f; return []; }, calibration: () => ({ factor: 1, n: 0 }) },
    ADV: { analyze: (input) => { analyzed = input; return {}; } },
    maybeSnapshot: () => {},
  });

  ctx.recompute();
  assert.equal(analyzed.settings.paramOverrides, state.overrides);
  assert.equal(analyzed.settings.taxYear, 2027);
  // 2025 is closed and past 15 April; 2026 is still collecting December's receipts
  assert.deepEqual(Object.keys(finals), ['2025']);
});
