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
const IDENTITY_KEYS = new Set(['identity_id', 'dish_id', 'extra_id']);

const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
  : Array.isArray(v) ? v.map(sorted) : v);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const strip = (r) => Object.fromEntries(Object.entries(r || {}).filter(([k]) => !IDENTITY_KEYS.has(k)));

// Keyed collections compared record by record. `entries` turns a collection into [key, record] pairs.
function compareKeyed(label, bakedEntries, liveEntries, out) {
  const live = new Map(liveEntries);
  const baked = new Map(bakedEntries);
  for (const [k, b] of baked) {
    if (!live.has(k)) { out.fail.push(`${label} ${k}: baked but absent from the published menu`); continue; }
    const l = strip(live.get(k)), bb = strip(b);
    for (const f of new Set([...Object.keys(bb), ...Object.keys(l)])) {
      if (!same(bb[f], l[f])) out.fail.push(`${label} ${k}${b && b.name ? ` (${b.name})` : ''} ${f}: baked ${JSON.stringify(bb[f])} | published ${JSON.stringify(l[f])}`);
    }
  }
  for (const [k, l] of live) if (!baked.has(k)) out.warn.push(`${label} ${k}${l && l.name ? ` (${l.name})` : ''}: published only (appears once the live menu applies)`);
}
const byId = (arr) => (Array.isArray(arr) ? arr.map((r) => [String(r && r.id), r]) : []);
const byKey = (obj) => (obj && typeof obj === 'object' ? Object.entries(obj) : []);
const asSet = (arr) => (Array.isArray(arr) ? arr.map((id) => [String(id), true]) : []);

// Pure: the baked bundle against the published menu body. Returns { fail: [...], warn: [...] }.
function compareBundle(baked, published) {
  const out = { fail: [], warn: [] };
  if (!published || !Array.isArray(published.dishes)) { out.fail.push('published menu has no dishes'); return out; }
  compareKeyed('dish', byId(baked.dishes), byId(published.dishes), out);
  compareKeyed('extra', byId(baked.extras), byId(published.extras), out);
  compareKeyed('variant_group', byKey(baked.variant_items), byKey(published.variant_items), out);
  compareKeyed('category', byId(baked.categories), byId(published.categories), out);
  compareKeyed('has_photo', asSet(baked.has_photo), asSet(published.has_photo), out);
  return out;
}

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

// GET a JSON body with the built-in https module (no global fetch: the build image's Node may predate it). Bounded.
function getJson(url, timeoutMs = 20000) {
  return new Promise((done, fail) => {
    const req = https.get(url, { headers: { accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return fail(new Error(`${url} answered ${res.statusCode}`));
        try { done(JSON.parse(raw)); } catch (e) { fail(new Error(`${url} returned non-JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out after ${timeoutMs} ms`)));
    req.on('error', fail);
  });
}

async function main() {
  let failed = false;
  for (const p of unregisteredForms()) { console.error(`FAIL ${p}: carries a baked menu but is not in tools/splice-form-bundle.js FORMS`); failed = true; }
  const selected = selectForms(process.argv.slice(2), process.cwd());
  if (!selected) { console.error(`FAIL ${process.cwd()}: --this-form, but this folder is not a registered form`); process.exit(1); }
  for (const [rid, file] of selected) {
    const html = readFileSync(file, 'utf8');
    const url = publicMenuUrl(html, rid);
    let body;
    try { body = await getJson(url); } catch (e) { console.error(`FAIL ${rid}: ${e.message}`); failed = true; continue; }
    const { fail, warn } = compareBundle(extractBundle(html), body && body.menu);
    for (const w of warn) console.log(`WARN ${rid} ${w}`);
    for (const f of fail) console.error(`FAIL ${rid} ${f}`);
    if (fail.length) failed = true;
    console.log(`${rid}: ${fail.length ? `${fail.length} block-causing difference(s)` : 'baked menu matches the published menu'}${warn.length ? `, ${warn.length} published-only addition(s)` : ''}`);
  }
  if (failed) { console.error('form-bundle-live-check: FAILED — regenerate the baked menu from the published catalog before deploying the forms'); process.exit(1); }
  console.log('form-bundle-live-check: OK');
}
if (require.main === module) main().catch((e) => { console.error('form-bundle-live-check: ERROR', e && e.message); process.exit(1); });
module.exports = { compareBundle, unregisteredForms, publicMenuUrl, selectForms, IDENTITY_KEYS };
