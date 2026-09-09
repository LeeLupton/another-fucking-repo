#!/usr/bin/env node
/*
 * build.js — produce a single-file Itemizer.
 *
 * The app needs no build to run (open index.html over http, or deploy the folder).
 * This script only inlines the stylesheet and scripts into one HTML file so the
 * whole tracker can be emailed, dropped on a phone, or published anywhere that
 * accepts a single page. Two outputs:
 *
 *   dist/itemizer.html           complete page: open it from disk or any host
 *   dist/itemizer.fragment.html  the same page without <html>/<head>/<body>
 *                                wrappers, for hosts that supply the skeleton
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SCRIPTS = ['js/schema.js', 'js/rules.js', 'js/parse.js', 'js/classify.js', 'js/advisor.js', 'js/geo.js', 'js/importer.js', 'js/valuation.js', 'js/experiments.js', 'js/store.js', 'js/app.js'];
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

// Stamp the service worker with a hash of everything it caches — the page, the styles, the manifest, the
// scripts, the icons and the worker itself — so every change to the app is a new cache version and a
// commit that touches only the README or a workflow is not.
const swPath = path.join(root, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const STAMP_LINE = /const STAMP = '[^']*';/;
const hash = crypto.createHash('sha256');
for (const p of ['index.html', 'styles.css', 'manifest.webmanifest', ...SCRIPTS]) hash.update(read(p)).update('\u0000');
for (const p of ICONS) hash.update(fs.readFileSync(path.join(root, p))).update('\u0000');
hash.update(sw.replace(STAMP_LINE, '')); // minus the line this stamp is about to rewrite, or the hash would chase itself
const stamp = hash.digest('hex').slice(0, 12);
const stamped = sw.replace(STAMP_LINE, `const STAMP = '${stamp}';`);
if (stamped !== sw) fs.writeFileSync(swPath, stamped);
console.log(`sw.js cache version         ${stamp}`);

const kb = (p) => (fs.statSync(path.join(root, p)).size / 1024).toFixed(1) + ' KB';
console.log(`dist/itemizer.html           ${kb('dist/itemizer.html')}`);
console.log(`dist/itemizer.fragment.html  ${kb('dist/itemizer.fragment.html')}`);
