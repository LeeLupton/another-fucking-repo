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

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SCRIPTS = ['js/schema.js', 'js/rules.js', 'js/parse.js', 'js/classify.js', 'js/advisor.js', 'js/geo.js', 'js/importer.js', 'js/valuation.js', 'js/store.js', 'js/app.js'];

let html = read('index.html');
const css = read('styles.css');
const js = SCRIPTS.map((p) => `/* ---- ${p} ---- */\n${read(p)}`).join('\n;\n').replace(/<\/script>/gi, '<\\/script>');
const iconURI = 'data:image/svg+xml;utf8,' + encodeURIComponent(read('icons/icon.svg'));

html = html
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${iconURI}" type="image/svg+xml">`)
  .replace(/<link rel="stylesheet" href="styles.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script src="js\/schema\.js"><\/script>[\s\S]*?<script src="js\/app\.js"><\/script>/, () => `<script>\nwindow.ITEMIZER_SINGLE_FILE = true;\n${js}\n</script>`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/itemizer.html'), html);

const title = (html.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
const fonts = (html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/) || [''])[0];
const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const body = (html.match(/<body>([\s\S]*?)<\/body>/) || ['', ''])[1];
fs.writeFileSync(path.join(root, 'dist/itemizer.fragment.html'), `${title}\n${fonts}\n${style}\n${body.trim()}\n`);

const kb = (p) => (fs.statSync(path.join(root, p)).size / 1024).toFixed(1) + ' KB';
console.log(`dist/itemizer.html           ${kb('dist/itemizer.html')}`);
console.log(`dist/itemizer.fragment.html  ${kb('dist/itemizer.fragment.html')}`);
