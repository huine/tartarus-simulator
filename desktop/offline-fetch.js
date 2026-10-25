#!/usr/bin/env node
/* Tartarus Overlay: fills offline/ with what the site's pages load from the
 * internet, for --offline. Run once, online, and again after the site
 * changes its fonts or its Tesseract version:
 *
 *   npm run offline-fetch [-- --site-dir=DIR]
 *
 *  - Google Fonts: each css2 link in the site's pages and lib/*.html, asked
 *    as Chrome asks (woff2), and each font file it names;
 *  - Tesseract.js (js/analyze.js's text reader): its script and worker, the
 *    LSTM cores and the English data, at the URLs Tesseract itself builds.
 *
 * Each file is kept under its URL in offline/index.json, which main.js
 * answers those requests from. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const SITE_DIR = path.resolve(arg('site-dir') || path.join(__dirname, '..'));
const OUT = path.join(__dirname, 'offline');
// Google Fonts answers by browser: this one gets woff2, as Electron does.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const index = {};

async function keep(url) {
  if (index[url]) return null;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
  const file = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16) + (path.extname(new URL(url).pathname) || '.bin');
  fs.writeFileSync(path.join(OUT, file), body);
  index[url] = { file, type: /^text\/|javascript|json/.test(type) ? `${type}; charset=utf-8` : type };
  console.log(`${(body.length / 1024).toFixed(0).padStart(6)} KB  ${url}`);
  return body;
}

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return '';
  }
};
const htmlIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => read(path.join(dir, f)));

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Fonts.
  const pages = [...htmlIn(SITE_DIR), ...htmlIn(path.join(__dirname, 'lib'))].join('\n');
  const sheets = new Set([...pages.matchAll(/https:\/\/fonts\.googleapis\.com\/css2\?[^"'\s>]+/g)].map((m) => m[0].replace(/&amp;/g, '&')));
  for (const url of sheets) {
    const css = (await keep(url)).toString('utf8');
    for (const m of css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) await keep(m[1]);
  }

  // Tesseract, as js/analyze.js loads it and as Tesseract builds its own
  // URLs (src/worker/browser/defaultOptions.js, getCore.js, worker-script).
  const m = /https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@([\d.]+)\/dist\/tesseract\.min\.js/.exec(read(path.join(SITE_DIR, 'js', 'analyze.js')));
  if (!m) throw new Error('js/analyze.js no longer loads Tesseract from jsDelivr: update this script');
  const v = m[1];
  const npm = 'https://cdn.jsdelivr.net/npm';
  await keep(m[0]);
  await keep(`${npm}/tesseract.js@v${v}/dist/worker.min.js`);
  const pkg = await (await fetch(`${npm}/tesseract.js@${v}/package.json`)).json();
  const core = pkg.dependencies['tesseract.js-core'].substring(1);
  for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) await keep(`${npm}/tesseract.js-core@v${core}/${f}`);
  await keep(`${npm}/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`);

  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${Object.keys(index).length} files in ${OUT}`);
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
