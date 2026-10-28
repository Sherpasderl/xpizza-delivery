'use strict';
// FORM BUNDLE ⇄ PUBLISHED CATALOG — the pre-deploy check that a form's BAKED menu matches what its brand has published.
// Run: node tools/form-bundle-live-check.js        (from xpizza-functions/; needs the network; exit 1 = do not deploy the forms)
//      node ../xpizza-functions/tools/form-bundle-live-check.js --this-form   (a form's Netlify build: checks only the form whose
//      folder is the working directory, so one brand's drift never fails another brand's build; a failed build keeps the previous
//      deploy live — owner decision 2026-10-25, DECISIONS.md)
// Node built-ins only (fs, path, https): it runs inside a form's Netlify build, where xpizza-functions' dependencies are not
// installed and the Node version is the image default.
//
// Why this exists: the baked bundle (the <script id="form-menu-bundle"> block each form is served with) is generated from the
// in-repo bootstrap, while the merchant portal publishes to Firestore. Nothing compared the two, so a portal price edit left
// the baked menu stale and every customer who added that dish before the live menu applied hit «Algunos productos de tu
// carrito cambiaron» at checkout (la_musa, 2026-09-16 → 2026-10-25). The 1c gates prove bundle == bootstrap; this proves
// bundle == published.
//
// BRAND-AGNOSTIC: the forms come from the splice registry (tools/splice-form-bundle.js FORMS) — the list a brand must join to be
// baked at all — and every form folder carrying a bundle block must be in it, so a new brand cannot ship unchecked. The URL is
// the one each form itself fetches (its own PUBLICMENU_URL + '/menu/' + rid); no brand or URL literal lives here.
//
// FAIL (block-causing — the cart would refuse a line, or show a dish the server prices differently):
//   a dish / extra / variant group / category present in both whose any field differs, or one baked but absent from live.
// WARN (listed, not fatal): live-only additions — they appear when the live menu applies and cannot block a cart.
// Ignored: the platform identity keys getPublicMenu adds and the forms accept-and-ignore (identity_id, dish_id, extra_id).
const { readFileSync, readdirSync, existsSync } = require('fs');
const { join, resolve } = require('path');
const https = require('https');
const { FORMS } = require('./splice-form-bundle');
const { SCRIPT_OPEN, extractBundle } = require('../catalog/splice-form-bundle');

const REPO_ROOT = join(__dirname, '..', '..');

// The comparator lives in catalog/bundle-compare.js (PLAN 4: shared with the reconciler, no CLI in the functions closure).
// The identity keys stay HERE — this CLI is outside the deployed closure — and are passed in as the ignored set.
const { compareBundle: compareWith } = require('../catalog/bundle-compare');
const IDENTITY_KEYS = new Set(['identity_id', 'dish_id', 'extra_id']);
const compareBundle = (baked, published) => compareWith(baked, published, { ignore: IDENTITY_KEYS });

// Every top-level folder whose index.html carries a bundle block must be a registered form.
function unregisteredForms(forms = FORMS, root = REPO_ROOT) {
  const registered = new Set(Object.values(forms).map((p) => p.replace(/\\/g, '/')));
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.'))
    .map((d) => join(root, d.name, 'index.html'))
    .filter((p) => existsSync(p) && readFileSync(p, 'utf8').includes(SCRIPT_OPEN) && !registered.has(p.replace(/\\/g, '/')));
}

function publicMenuUrl(html, rid) {
  const m = html.match(/const PUBLICMENU_URL\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`no PUBLICMENU_URL in the ${rid} form`);
  return `${m[1]}/menu/${encodeURIComponent(rid)}`;
}

// The forms to check: every registered form, or with --this-form only the one whose folder is `cwd` (null = cwd is not a
// registered form folder, which the caller treats as a failure — an unregistered form must not build green).
function selectForms(argv, cwd, forms = FORMS) {
  if (!argv.includes('--this-form')) return Object.entries(forms);
  const here = resolve(cwd);
  const mine = Object.entries(forms).filter(([, file]) => resolve(file, '..') === here);
  return mine.length ? mine : null;
}

// GET a JSON body with the built-in https module (no global fetch: the build image's Node may predate it).
// 🔴 EVERY PATH SETTLES, AND NOTHING IS ALLOWED TO HANG (codex guard r1 P1/P2). A response that dies after its headers
// (EOF, 'aborted', a socket error) never reaches 'end'; a promise left pending lets the event loop drain and the build exit 0
// UNCHECKED. So: one settle path; 'aborted' / 'error' / a 'close' before 'end' reject; `timeoutMs` bounds inactivity and
// `totalMs` bounds the WHOLE request (a server dribbling a byte a second never ends), both cleared on settle.
// `get` is injectable for the loopback regression tests; production uses https.get.
// `headers` (PLAN 4 §3): the bake and this check ask for a FRESH read — Cache-Control: no-cache beside a build-unique query.
function getJson(url, opts = {}) { return getRaw(url, opts, true); }
// PLAN 4 r2 (Codex r1 #6): the same settle path for an HTML page — the DEPLOYED form, for --deployed.
function getText(url, opts = {}) { return getRaw(url, { headers: { accept: 'text/html' }, ...opts }, false); }
function getRaw(url, { timeoutMs = 20000, totalMs = 45000, get = https.get, headers = { accept: 'application/json' } } = {}, asJson = true) {
  return new Promise((done, fail) => {
    let settled = false, deadline = null, req = null;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    const reject = (msg) => { settle(fail, new Error(`${url} ${msg}`)); if (req) req.destroy(); };
    deadline = setTimeout(() => reject(`did not complete within ${totalMs} ms`), totalMs);
    req = get(url, { headers, timeout: timeoutMs }, (res) => {
      let raw = '', ended = false;
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('aborted', () => reject('response aborted before it ended'));
      res.on('error', (e) => reject(`response failed: ${e && e.message}`));
      res.on('close', () => { if (!ended) reject('connection closed before the response ended'); });
      res.on('end', () => {
        ended = true;
        if (res.statusCode !== 200) return reject(`answered ${res.statusCode}`);
        if (!asJson) return settle(done, raw);
        let body;
        try { body = JSON.parse(raw); } catch (e) { return reject('returned non-JSON'); }
        settle(done, body);
      });
    });
    req.on('timeout', () => reject(`was idle for ${timeoutMs} ms`));
    req.on('error', (e) => reject(`request failed: ${e && e.message}`));
  });
}

// PLAN 4 r2 (Codex r1 #6) — the DEPLOYED-ORIGIN comparison an operator repairs with: the bundle the LIVE site serves (its orders
// origin from the platform manifest, fetched fresh) against the published menu (fresh). The checkout's own index.html supplies
// only the menu endpoint; it is never the thing compared. → { origin, fail, warn }
async function deployedCheck(rid, html, { sites = require('../../platform/sites.json'), fetchText = getText, fetchJson = getJson, now = Date.now } = {}) {
  const { assetBaseFor } = require('../catalog/public-photos');
  const origin = assetBaseFor(rid, sites);
  if (!origin) throw new Error(`no single orders origin for ${rid} in platform/sites.json`);
  const t = now();
  const deployedHtml = await fetchText(`${origin}?_deployed=${t}`, { headers: { accept: 'text/html', 'cache-control': 'no-cache' } });
  const body = await fetchJson(`${publicMenuUrl(html, rid)}?_check=${t}`, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  return { origin, ...withPremigration(rid, compareBundle(extractBundle(deployedHtml), body && body.menu), body && body.menu) };
}

// PLAN 4 GATED (Codex r3 #3, r4): BOTH modes refuse a pre-migration published body — the GATED runtime has no literal fallback.
function withPremigration(rid, res, menu) {
  const gaps = require('../catalog/menu-structure-rows').premigrationGaps(rid, menu);
  return { ...res, fail: res.fail.concat(gaps.map((g) => `premigration_body: ${g} is missing from the published menu (run the menu-structure migration + publish)`)) };
}
// The default (--this-form / every form) mode: the checkout's baked bundle against the published menu (fresh). → { fail, warn }
async function thisFormCheck(rid, html, { fetchJson = getJson, now = Date.now } = {}) {
  // a FRESH read, like the bake's: a cached older body would fail a build whose bake read the newer one
  const body = await fetchJson(`${publicMenuUrl(html, rid)}?_check=${now()}`, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  return withPremigration(rid, compareBundle(extractBundle(html), body && body.menu), body && body.menu);
}

async function main() {
  // Belt for the class P1 belongs to: the exit code is a FAILURE until the very end proves otherwise, so any path that leaves
  // the event loop without finishing (a promise that never settles) fails the build rather than passing it.
  process.exitCode = 1;
  let failed = false;
  for (const p of unregisteredForms()) { console.error(`FAIL ${p}: carries a baked menu but is not in tools/splice-form-bundle.js FORMS`); failed = true; }
  const selected = selectForms(process.argv.slice(2), process.cwd());
  if (!selected) { console.error(`FAIL ${process.cwd()}: --this-form, but this folder is not a registered form`); process.exit(1); }
  const deployed = process.argv.includes('--deployed');
  for (const [rid, file] of selected) {
    const html = readFileSync(file, 'utf8');
    if (deployed) {
      let res;
      try { res = await deployedCheck(rid, html); } catch (e) { console.error(`FAIL ${rid} (deployed): ${e.message}`); failed = true; continue; }
      for (const w of res.warn) console.log(`WARN ${rid} (deployed ${res.origin}) ${w}`);
      for (const f of res.fail) console.error(`FAIL ${rid} (deployed ${res.origin}) ${f}`);
      if (res.fail.length || res.warn.length) failed = true;   // the deployed form must EQUAL published (a published-only addition = a stale deploy)
      console.log(`${rid}: the DEPLOYED form at ${res.origin} ${res.fail.length || res.warn.length ? `differs from the published menu (${res.fail.length} fail, ${res.warn.length} published-only)` : 'carries the published menu'}`);
      continue;
    }
    let res;
    try { res = await thisFormCheck(rid, html); } catch (e) { console.error(`FAIL ${rid}: ${e.message}`); failed = true; continue; }
    const { fail, warn } = res;
    for (const w of warn) console.log(`WARN ${rid} ${w}`);
    for (const f of fail) console.error(`FAIL ${rid} ${f}`);
    if (fail.length) failed = true;
    console.log(`${rid}: ${fail.length ? `${fail.length} block-causing difference(s)` : 'baked menu matches the published menu'}${warn.length ? `, ${warn.length} published-only addition(s)` : ''}`);
  }
  if (failed) { console.error('form-bundle-live-check: FAILED — regenerate the baked menu from the published catalog before deploying the forms'); process.exit(1); }
  console.log('form-bundle-live-check: OK');
  process.exitCode = 0;
}
if (require.main === module) main().catch((e) => { console.error('form-bundle-live-check: ERROR', e && e.message); process.exit(1); });
module.exports = { compareBundle, unregisteredForms, publicMenuUrl, selectForms, getJson, getText, deployedCheck, thisFormCheck, IDENTITY_KEYS };
