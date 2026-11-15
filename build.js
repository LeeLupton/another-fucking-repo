#!/usr/bin/env node
/*
 * build.js — produce a single-file Itemizer.
 *
 * The app needs no build to run (open index.html over http, or deploy the folder).
 * This script only inlines the stylesheet and scripts into one HTML file so the
 * whole app can be emailed, dropped on a phone, or published anywhere that
 * accepts a single page. Two outputs:
 *
 *   dist/itemizer.html           complete page: open it from disk or any host
 *   dist/itemizer.fragment.html  the same page without <html>/<head>/<body>
 *                                wrappers, for hosts that supply the skeleton
 *
 * It also writes the service worker's file list, file hashes and cache version into
 * sw.js (see the end of this file), so those are always made from the files as they are.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SCRIPTS = ['js/schema.js', 'js/rules.js', 'js/parse.js', 'js/classify.js', 'js/advisor.js', 'js/geo.js', 'js/importer.js', 'js/money.js', 'js/money-import.js', 'js/valuation.js', 'js/experiments.js', 'js/store.js', 'js/money-app.js', 'js/app.js'];
const ICONS = ['icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

let html = read('index.html');
const css = read('styles.css');
const js = SCRIPTS.map((p) => `/* ---- ${p} ---- */\n${read(p)}`).join('\n;\n').replace(/<\/script>/gi, '<\\/script>');
const iconURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(read('icons/icon.svg'));
// One inline <script> cannot be allowed by 'self', so the page's own policy names its hash instead.
const inlineJS = `\nwindow.ITEMIZER_SINGLE_FILE = true;\n${js}\n`;
const scriptHash = crypto.createHash('sha256').update(inlineJS).digest('base64');

html = html
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
  // The single file is meant to be opened from a disk or an inbox, where a blocking request to Google
  // would only ever be a delay; styles.css already names a full fallback stack for both faces.
  .replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.[^>]*>/g, '')
  .replace(/\s*<link rel="stylesheet"[^>]*fonts\.googleapis\.com[^>]*>/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${iconURI}" type="image/svg+xml">`)
  .replace(/<link rel="stylesheet" href="styles.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script src="js\/schema\.js"><\/script>[\s\S]*?<script src="js\/app\.js"><\/script>/, () => `<script>${inlineJS}</script>`)
  .replace("script-src 'self'", () => `script-src 'sha256-${scriptHash}'`)
  // With no request left to make, the policy stops naming the font hosts too.
  .replace(" https://fonts.googleapis.com;", ';')
  .replace(" font-src https://fonts.gstatic.com;", '');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/itemizer.html'), html);

const title = (html.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const body = (html.match(/<body>([\s\S]*?)<\/body>/) || ['', ''])[1];
fs.writeFileSync(path.join(root, 'dist/itemizer.fragment.html'), `${title}\n${style}\n${body.trim()}\n`);

// The service worker's file list and cache version are written here, from the files themselves, and are never
// edited by hand:
//   SHELL  every file the worker caches, with the SHA-256 of its bytes. The worker checks each file against
//          its hash before storing it, so the list can only name files that exist, as they are served.
//   STAMP  a hash of the worker once SHELL is in it. Every change to the app, down to one byte of an icon,
//          is therefore a new cache version, and a commit that touches only the README or a workflow is not.
const swPath = path.join(root, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
// Both are found at the start of a line, so the same words in a comment are never taken for the declaration.
const SHELL_BLOCK = /^const SHELL = \{[^}]*\};$/gm;
const STAMP_LINE = /^const STAMP = '[^']*';/gm;
// A build that could not find the lines it writes, or wrote them into the wrong place, would leave a stale or
// broken worker behind and still exit 0. So the worker is checked before it is rewritten and again before it is saved.
const mustDeclareOnce = (src, when) => {
  for (const [name, line] of [['SHELL', SHELL_BLOCK], ['STAMP', STAMP_LINE]]) {
    if ((src.match(line) || []).length !== 1) throw new Error(`sw.js ${when} must declare ${name} exactly once, on its own line, in the form build.js writes it`);
  }
};
mustDeclareOnce(sw, 'as it is');
const shellFiles = ['index.html', 'styles.css', 'manifest.webmanifest', ...SCRIPTS, ...ICONS];
for (const p of shellFiles) {
  if (/['\\{}\s]/.test(p)) throw new Error(`${p}: a shell file name cannot contain a quote, a backslash, a brace or a space`);
}
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
// The root is index.html under another name; everything else is cached under its own path.
const shell = [['./', 'index.html'], ...shellFiles.map((p) => ['./' + p, p])];
const listed = sw.replace(SHELL_BLOCK, () => `const SHELL = {\n${shell.map(([key, p]) => `  '${key}': '${sha256(p)}',`).join('\n')}\n};`);
// minus the line this stamp is about to rewrite, or the hash would chase itself
const stamp = crypto.createHash('sha256').update(listed.replace(STAMP_LINE, '')).digest('hex').slice(0, 12);
const stamped = listed.replace(STAMP_LINE, () => `const STAMP = '${stamp}';`);
mustDeclareOnce(stamped, 'as built');
new vm.Script(stamped, { filename: 'sw.js' }); // throws if what is about to be saved is not a script at all
if (stamped !== sw) fs.writeFileSync(swPath, stamped);
console.log(`sw.js cache version         ${stamp}`);

const kb = (p) => (fs.statSync(path.join(root, p)).size / 1024).toFixed(1) + ' KB';
console.log(`dist/itemizer.html           ${kb('dist/itemizer.html')}`);
console.log(`dist/itemizer.fragment.html  ${kb('dist/itemizer.fragment.html')}`);
