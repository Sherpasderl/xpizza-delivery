// PLAN-avail-identity r1 — THE LIVE FORMS ARE UNTOUCHED BY body.avail_identity.
// Run: node avail-identity-forms-noop.test.mjs
//
// Same method as public-menu-display-noop.test.mjs: each REAL form page is served today's body and the new body (+ avail_identity),
// under the SAME marker (STOP 8 ruling (i): the marker is PLAN 4's, not this slice's — only the field differs), through the real chain, and everything the page holds afterwards is compared — the committed
// live-menu globals, the painted page, the createOrder / quoteOrder request bodies of the same cart, the quote fingerprint. A
// renamed dish (the sensitivity partner) must move the same comparisons. And neither form file differs from the slice's base.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadForm, closeAll, counter, settle, BRAND, serve, envelope } from './form-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { generateFormBundle, catalogSnapshot } = require('./catalog/generate-form-bundle');
const { applyIdentityToServedBody } = require('./catalog/identity-overlay');
const { fullRegistry } = require('./catalog/identity-fixture');
const { photosFor } = require('./catalog/public-photos');
const { availIdentityField } = require('./menu-pricing');
const { cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
const SITES = require('./platform/sites.json');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const BASE = '8a31e2a3';
const clone = (x) => JSON.parse(JSON.stringify(x));

// today's served body: the generator, the identity overlay, photos
async function todayBody(rid) {
  const { body } = await applyIdentityToServedBody(fullRegistry(rid), rid, generateFormBundle(rid, catalogSnapshot(rid)));
  return { ...body, photos: photosFor(rid, catalogSnapshot(rid), SITES) };
}
const plain = (v) => (v instanceof Set ? [...v].sort() : v);
const NAMES = { 'xpizza-orders': ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS'],
  'la-musa-orders': ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM'] };

async function run(dir, body, marker) {
  const rid = BRAND[dir].rid;
  const w = loadForm(dir); await settle();
  await serve(w, envelope(rid, body, marker));
  const globals = Object.fromEntries(NAMES[dir].map((k) => [k, clone(plain(w.liveMenuGlobalGet(k)))]));
  const dom = w.document.body.innerHTML;
  const sent = {};
  w.__respond = (url, init) => {
    const u = String(url);
    const b = init && init.body ? JSON.parse(init.body) : null;
    if (u.includes('createOrder')) sent.createOrder = b;
    if (u.includes('quoteOrder')) sent.quote = b;
    return new Promise(() => {});
  };
  const menu = w.liveMenuGlobalGet('MENU');
  const dish = menu.find((d) => d.price > 0);
  w.chg(dish.id, 2); await settle();
  w.toggleDetailExtra(w.liveMenuGlobalGet('EXTRAS')[0].id, dish.id, 0); await settle();
  const g = (id) => w.document.getElementById(id);
  for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432'], ['cemail', 'cliente@test.hn'], ['notes', '']]) if (g(id)) g(id).value = v;
  assert.strictEqual(w.buildOrder(), true, `${dir}: premise — the order composes`);
  const p = w.submitOrder('confirmed'); if (p && p.catch) p.catch(() => {});
  await settle(); await settle();
  assert.ok(sent.createOrder && sent.quote, `${dir}: premise — createOrder and the quote request were sent`);
  const fp = cartFingerprint(normalizeCartForFingerprint(sent.createOrder.items, rid), null);
  const VOLATILE = ['order_id', 'timestamp'];
  const fixed = (b) => { const o = clone(b); for (const k of VOLATILE) if (k in o) o[k] = '<volatile>'; return o; };
  return { globals, dom, createOrder: fixed(sent.createOrder), quote: fixed(sent.quote), fp };
}

(async () => {
  for (const dir of DIRS) {
    const rid = BRAND[dir].rid;
    const b0 = await todayBody(rid);
    const b1 = { ...clone(b0), avail_identity: { field: availIdentityField(rid) } };
    assert.notDeepStrictEqual(b1, b0, `${dir}: non-vacuity — the bodies differ`);
    const r0 = await run(dir, b0, '1d.2'); closeAll();
    const r1 = await run(dir, b1, '1d.2'); closeAll();
    assert.deepStrictEqual(r1.globals, r0.globals, `🔴 AVAIL-ID-FORMS-NOOP ${dir}: avail_identity changed a committed live-menu global`);
    assert.strictEqual(r1.dom, r0.dom, `🔴 AVAIL-ID-FORMS-NOOP ${dir}: avail_identity changed the painted page`);
    assert.deepStrictEqual(r1.createOrder, r0.createOrder, `🔴 AVAIL-ID-FORMS-NOOP ${dir}: avail_identity changed the createOrder body`);
    assert.deepStrictEqual(r1.quote, r0.quote, `🔴 AVAIL-ID-FORMS-NOOP ${dir}: avail_identity changed the quote request`);
    assert.strictEqual(r1.fp, r0.fp, `🔴 AVAIL-ID-FORMS-NOOP ${dir}: avail_identity changed the quote fingerprint`);
    const bs = clone(b0); const di = bs.dishes.findIndex((d) => d.price > 0); bs.dishes[di] = { ...bs.dishes[di], name: `${bs.dishes[di].name} Prueba` };
    const rs = await run(dir, bs, '1d.2'); closeAll();
    assert.notDeepStrictEqual(rs.globals, r0.globals, `${dir}: sensitivity — a renamed dish moves the globals`);
    assert.notStrictEqual(rs.dom, r0.dom, `${dir}: sensitivity — and the painted page`);
    assert.notDeepStrictEqual(rs.createOrder, r0.createOrder, `${dir}: sensitivity — and the createOrder body`);
    ok(`${dir}: + avail_identity (same marker) the REAL page commits the same globals, paints the same page, sends the same createOrder/quote and fingerprint; a renamed dish moves them`);
  }
  for (const dir of DIRS) {
    const was = execFileSync('git', ['show', `${BASE}:${dir}/index.html`], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.strictEqual(readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8'), was, `🔴 AVAIL-ID-FORMS-BYTE-IDENTICAL ${dir}/index.html differs from ${BASE}`);
  }
  ok(`both form files are byte-identical to ${BASE}`);
  console.log(`\navail-identity-forms-noop: OK (${count()})`);
})().catch((e) => { console.error(e); process.exit(1); });
