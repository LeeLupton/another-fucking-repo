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

test('recorded time is time at the wheel: a pause is not driving time', () => {
  const ctx = load([fn('elapsedText')], {});
  const start = 1700000000000;
  assert.equal(ctx.elapsedText(start, start + 70 * 60 * 1000, 50 * 60 * 1000), '20:00');
  assert.equal(ctx.elapsedText(start, start + 70 * 60 * 1000, 0), '1:10:00');
  assert.equal(ctx.elapsedText(start, start + 60 * 1000, 5 * 60 * 1000), '00:00');
  assert.equal(ctx.elapsedText(start, start + 3661000), '1:01:01');
  assert.equal(ctx.elapsedText(null), '00:00');
});

test('a drive is dated by the local calendar, not by UTC', () => {
  // the difference only shows west of UTC, where an evening drive is already tomorrow in UTC; CI runs in UTC
  const wasTZ = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ctx = load([fn('isoFromEpoch')], {});
    assert.equal(ctx.isoFromEpoch(Date.parse('2025-12-31T20:00:00-05:00')), '2025-12-31');
    assert.equal(ctx.isoFromEpoch(Date.parse('2026-11-03T08:00:00-05:00')), '2026-11-03');
  } finally {
    if (wasTZ === undefined) delete process.env.TZ; else process.env.TZ = wasTZ;
  }
});

test('the mileage log drops a trip whose entry was deleted and keeps one that was never linked', () => {
  const ctx = load([fn('liveTrips')], { state: { entries: [{ id: 'e1' }, { id: 'e2' }] } });
  const trips = [{ id: 't1', entryId: 'e1' }, { id: 't2', entryId: 'gone' }, { id: 't3', entryId: null }];
  assert.deepEqual(ctx.liveTrips(trips).map((t) => t.id), ['t1', 't3']);
  assert.deepEqual(ctx.liveTrips([]).map((t) => t.id), []);
});

test('a donated item is valued from the catalog only when it really is that item', () => {
  const VAL = require(path.join(__dirname, '../js/valuation.js'));
  const ctx = load([fn('catalogMatch')], { VAL });
  assert.equal(ctx.catalogMatch('Desk lamp'), null);
  assert.equal(ctx.catalogMatch('sofa cushion'), null);
  assert.equal(ctx.catalogMatch('TV stand'), null);
  assert.equal(ctx.catalogMatch(''), null);
  assert.equal(ctx.catalogMatch('Desk').name, 'Desk');
  assert.equal(ctx.catalogMatch('shirt').name, 'Shirt or blouse');
  assert.equal(ctx.catalogMatch('jeans').name, 'Pants or jeans');
  assert.equal(ctx.catalogMatch('dining chairs').name, 'Dining chair');
});
test('ledger search finds an amount as it is shown, and ignores accents', () => {
  const ctx = load([line(/^  const foldText = .*$/m), fn('searchMatch')], {});
  const taxes = ['County treasurer', '', 'Real estate taxes', 'Taxes You Paid', '1200', '$1,200.00'];
  for (const q of ['1200', '1,200', '$1,200', '1200.00', '1,200.00', '$1,200.00', 'treasurer']) assert.equal(ctx.searchMatch(taxes, q), true, q);
  assert.equal(ctx.searchMatch(taxes, 'walgreens'), false);
  assert.equal(ctx.searchMatch(taxes, ''), true);
  const pharmacy = ["José's Farmacia", '', 'Prescriptions', 'Medical and Dental Expenses', '42.1', '$42.10'];
  assert.equal(ctx.searchMatch(pharmacy, 'jose'), true);
  assert.equal(ctx.searchMatch(pharmacy, '42.10'), true);
  assert.equal(ctx.searchMatch(pharmacy, '43'), false);
});

test('the charity bars split what counts, so they never exceed the Schedule A row', () => {
  const Rules = require(path.join(__dirname, '../js/rules.js'));
  const E = (date, lineId, amount) => ({ id: `${lineId}-${date}`, date, lineId, amount, hasReceipt: true });
  const computed = Rules.compute([E('2025-03-01', 'ch.org', 40000), E('2025-03-02', 'vol.miles', 100)], { taxYear: 2025, filingStatus: 'single', agi: '50000', today: '2025-09-07' });
  const ctx = load([fn('countedFor')], { R: Rules, state: { computed } });
  assert.equal(ctx.countedFor('charity'), 29986);
  assert.equal(ctx.countedFor('volunteer'), 14);
  assert.equal(ctx.countedFor('charity') + ctx.countedFor('volunteer'), computed.scheduleA.charity.deductible);
});

test('a count and its noun, so nothing on screen reads "1 entries"', () => {
  const ctx = load([line(/^  const plural = .*$/m)], { Number });
  assert.equal(run(ctx, 'plural(1, "note")'), 'note');
  assert.equal(run(ctx, 'plural(0, "note")'), 'notes');
  assert.equal(run(ctx, 'plural(2, "note")'), 'notes');
  assert.equal(run(ctx, 'plural(1, "entry", "entries")'), 'entry');
  assert.equal(run(ctx, 'plural(3, "entry", "entries")'), 'entries');
});

test('a dollar field takes "$95,000" and refuses "95k" rather than reading it as 95', () => {
  const ctx = load([fn('parseDollarField')], { Number, String });
  assert.equal(ctx.parseDollarField('$95,000'), '95000');
  assert.equal(ctx.parseDollarField(' 95000 '), '95000');
  assert.equal(ctx.parseDollarField('95.50'), '95.5');
  assert.equal(ctx.parseDollarField(''), '');
  assert.equal(ctx.parseDollarField('95k'), null);
  assert.equal(ctx.parseDollarField('9.5.3'), null);
  assert.equal(ctx.parseDollarField('-40'), null);
  assert.equal(ctx.parseDollarField('abc'), null);
});

test('example entries are not built for a tax year that has not started', () => {
  let n = 0;
  const ctx = load([fn('sampleEntries')], { DB: { uid: () => 'id' + (++n) }, P: { todayISO: () => '2026-09-08' }, Date, Number, String });
  assert.equal(ctx.sampleEntries(2027).length, 0);
  const now = ctx.sampleEntries(2026);
  assert.equal(now.length, 37);
  assert.equal(now.filter((e) => e.taxYear === 2026).length, 28);
  assert.equal(now.filter((e) => e.taxYear === 2025).length, 9);
  assert.equal(now.every((e) => e.date <= '2026-09-08'), true);
  assert.equal(ctx.sampleEntries(2025).length, 48);
});

test('the hint for an amount below nought says a refund is not an expense', () => {
  const ctx = load([line(/^  const MAX_AMOUNT = .*$/m), line(/^  const amountTyped = .*$/m), fn('amountProblem')], { Number, String });
  assert.equal(ctx.amountProblem('40', 'an amount', 'a refund is not a deductible expense, so enter a positive amount'), null);
  assert.equal(ctx.amountProblem('-20', 'an amount', 'a refund is not a deductible expense, so enter a positive amount'), 'a refund is not a deductible expense, so enter a positive amount');
  assert.equal(ctx.amountProblem('', 'an amount', 'a refund is not a deductible expense, so enter a positive amount'), 'enter an amount');
  assert.equal(ctx.amountProblem('0', 'an amount', 'a refund is not a deductible expense, so enter a positive amount'), 'enter an amount');
  // the miles field is given no sentence of its own, so a negative reads as nothing typed there
  assert.equal(ctx.amountProblem('-4', 'the miles'), 'enter the miles');
  assert.equal(ctx.amountProblem('1e400', 'an amount', 'never mind'), 'enter a figure below a billion');
});

test('a mileage line shows both rates in a year the IRS changed them, and cash gifts are named on the standard deduction', () => {
  const Rules = require(path.join(__dirname, '../js/rules.js'));
  const ctx = load([line(/^  const money = R\.money.*$/m), line(/^  const rateShort = .*$/m), line(/^  const rateShortFor = .*$/m), line(/^  const stdGiftClause = .*$/m)], { R: Rules });
  assert.equal(run(ctx, 'rateShortFor(R.getParams(2025, {}), "medical")'), '21¢/mi');
  assert.equal(run(ctx, 'rateShortFor(R.getParams(2024, {}), "business")'), '67¢/mi');
  assert.equal(run(ctx, 'rateShortFor(R.getParams(2026, {}), "business")'), '72.5¢/mi to Jun 30, 76¢/mi from Jul 1');
  assert.equal(run(ctx, 'rateShortFor(R.getParams(2026, {}), "charity")'), '14¢/mi'); // the charity rate is fixed by statute: it did not change in July
  assert.equal(run(ctx, 'stdGiftClause({ charity: 0 })'), '');
  assert.equal(run(ctx, 'stdGiftClause(null)'), '');
  assert.equal(run(ctx, 'stdGiftClause({ charity: 1000 })'), ', including $1,000.00 of cash gifts');
});
