// Colour tokens: the contrast the stylesheet promises, computed from styles.css itself.
// Every ratio below is WCAG 2.1 relative luminance, so a token change that breaks a
// promise (AA text, a 3:1 boundary or focus ring) fails here rather than on a screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

/** The body of a rule, found by its exact selector text at the start of a line. */
function rule(selector) {
  const at = CSS.indexOf('\n' + selector + ' {');
  assert.notEqual(at, -1, 'no rule for ' + selector);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

/** The custom properties declared in a rule, as a plain map. */
function tokens(selector) {
  const map = {};
  for (const m of rule(selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}

const LIGHT = tokens(':root');
const DARK = { ...LIGHT, ...tokens(':root[data-theme="dark"]') };

/** A colour value, following one level of var() through the light tokens (--paper* are theme-independent). */
function color(value, theme) {
  const v = /^var\((--[\w-]+)\)$/.exec(String(value).trim());
  return v ? theme[v[1]] : String(value).trim();
}
function rgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  assert.match(full, /^[0-9a-f]{6}$/i, 'not a hex colour: ' + hex);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function luminance(hex) {
  const s = rgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
}
/** WCAG contrast ratio, rounded to two decimals so failures read like a contrast checker. */
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/** What a translucent foreground actually renders as over an opaque background. */
function blend(fg, bg, alpha) {
  const f = rgb(fg), b = rgb(bg);
  return '#' + f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}
const themes = [['light', LIGHT], ['dark', DARK]];

test('the tokens parse: both themes define every colour the tests below measure', () => {
  for (const [name, T] of themes) {
    for (const k of ['--bg', '--surface', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-ink', '--accent-soft', '--accent-proj', '--focus', '--paper']) {
      assert.match(T[k] || '', /^#[0-9a-f]{3,8}$/i, name + ' ' + k);
    }
  }
  assert.equal(ratio(LIGHT['--ink'], LIGHT['--surface']), 16.77);
  assert.equal(ratio(DARK['--ink'], DARK['--surface']), 15.14);
});

test('the section tail on a selected suggestion chip passes AA in both themes', () => {
  const opacity = Number(/opacity:\s*([\d.]+)/.exec(rule('.chip small'))[1]);
  assert.equal(opacity, 0.85);
  for (const [name, T] of themes) {
    const tail = blend(T['--accent-ink'], T['--accent'], opacity);
    assert.ok(ratio(tail, T['--accent']) >= 4.5, `${name}: pressed chip tail ${ratio(tail, T['--accent'])}:1`);
  }
  // At 0.75 the same tail was 4.41:1 light and 4.18:1 dark, both short of AA.
  assert.equal(ratio(blend(LIGHT['--accent-ink'], LIGHT['--accent'], 0.75), LIGHT['--accent']), 4.41);
  assert.equal(ratio(blend(DARK['--accent-ink'], DARK['--accent'], 0.75), DARK['--accent']), 4.18);
});

test('the toast draws its own focus ring, because the page ring is 2.17:1 on it in dark mode', () => {
  assert.match(rule('.toast :focus-visible'), /outline-color:\s*var\(--bg\)/);
  for (const [name, T] of themes) {
    assert.ok(ratio(T['--bg'], T['--ink']) >= 3, `${name}: ring on the toast ${ratio(T['--bg'], T['--ink'])}:1`);
  }
  assert.equal(ratio(DARK['--focus'], DARK['--ink']), 2.17);
  assert.equal(ratio(LIGHT['--bg'], LIGHT['--ink']), 15.3);
});

test('a chart value label carries its own backing, because --ink on the solid bar is 2.59:1', () => {
  assert.match(rule('.bar-value'), /background:\s*var\(--surface\)/);
  for (const [name, T] of themes) {
    assert.ok(ratio(T['--ink'], T['--surface']) >= 4.5, `${name}: label on its backing ${ratio(T['--ink'], T['--surface'])}:1`);
    assert.ok(ratio(T['--ink'], T['--accent']) < 4.5, `${name}: label on the solid bar should be the failing case`);
  }
  assert.equal(ratio(LIGHT['--ink'], LIGHT['--accent']), 2.59);
  assert.equal(ratio(DARK['--ink'], DARK['--accent']), 2.29);
});

test('the soft chart fills get an accent edge, because the fill itself is 1.31:1 on the card', () => {
  const edge = rule('.bar-gross, .month-bar, .meter-proj, .legend-dot');
  assert.match(edge, /box-shadow:\s*inset 0 0 0 1px var\(--accent\)/);
  for (const [name, T] of themes) {
    assert.ok(ratio(T['--accent'], T['--surface']) >= 3, `${name}: edge on the card ${ratio(T['--accent'], T['--surface'])}:1`);
    assert.ok(ratio(T['--accent'], T['--accent-soft']) >= 3, `${name}: edge on the track ${ratio(T['--accent'], T['--accent-soft'])}:1`);
    assert.ok(ratio(T['--accent-soft'], T['--surface']) < 3, `${name}: the fill alone should be the failing case`);
    assert.ok(ratio(T['--accent-proj'], T['--accent-soft']) < 3, `${name}: the projected segment alone should be the failing case`);
  }
  assert.equal(ratio(LIGHT['--accent-soft'], LIGHT['--surface']), 1.31);
  assert.equal(ratio(LIGHT['--accent-proj'], LIGHT['--accent-soft']), 1.5);
});

test('the paper sheet re-points the ink tokens, so its captions read the same in both themes and in print', () => {
  const sheet = tokens('.sheet');
  // --paper is declared once, on :root, so the sheet is the same white in both themes; checking it twice would prove nothing
  assert.equal(DARK['--paper'], LIGHT['--paper'], 'the sheet is paper in both themes');
  const paper = color(LIGHT['--paper'], LIGHT);
  for (const k of ['--ink', '--ink-2', '--ink-3']) {
    const ink = color(sheet[k], LIGHT); // the sheet's own values, not the theme's
    assert.ok(ratio(ink, paper) >= 4.5, `${k} on the sheet ${ratio(ink, paper)}:1`);
  }
  assert.equal(sheet['--ink-2'], '#444444');
  assert.equal(sheet['--ink-3'], '#555555');
  // Without the re-pointing, a sheet in dark mode drew .note and .muted in the theme's greys on paper white.
  assert.equal(ratio(DARK['--ink-2'], LIGHT['--paper']), 2.06);
  assert.equal(ratio(DARK['--ink-3'], LIGHT['--paper']), 2.99);
});
