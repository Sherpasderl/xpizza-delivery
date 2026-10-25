// PLAN-public-menu-display r2 T3 — THE LIVE FORMS ARE UNTOUCHED BY THE NEW FIELDS.
// Run: node public-menu-display-noop.test.mjs
//
// The served body gains `photos` (top level) and x_pizza's categories gain `name`. Both forms stay byte-identical, and this
// proves they also BEHAVE identically: each REAL form page is served the body with and without the new fields through the
// real chain (fetch → coordinator → adapter → applier → commit), and everything the page holds afterwards is compared —
//   · every live-menu global it committed,
//   · the painted page (the whole body DOM),
//   · the createOrder and quoteOrder request bodies of the same cart — the wire format every fingerprint is computed from
//     (cart records, items_text, the redemption canonical, the quote fingerprint) — plus the quote fingerprint itself.
// A sensitivity partner (one dish renamed) must move the same comparisons, or "identical" proves nothing. And the two form
// files must be byte-identical to the base.
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
const { cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
const SITES = require('./platform/sites.json');

const { ok, count } = counter();
const DIRS = ['xpizza-orders', 'la-musa-orders'];
const BASE = 'acf32fc8';
const clone = (x) => JSON.parse(JSON.stringify(x));

// The producer's own pieces, as getPublicMenu assembles them: the generator over the catalog, then the identity overlay.
async function baseBody(rid) {
  const { body } = await applyIdentityToServedBody(fullRegistry(rid), rid, generateFormBundle(rid, catalogSnapshot(rid)));
  return body;
}
// + the new fields: photos from the real rule and manifest; x_pizza's categories named (la_musa's already are).
function withDisplay(rid, body) {
  const b = clone(body);
  b.photos = photosFor(rid, catalogSnapshot(rid), SITES);
  if (b.categories.some((c) => c.name === undefined)) b.categories = b.categories.map((c, i) => ({ ...c, name: `Seccion ${i + 1}` }));
  return b;
}
const plain = (v) => (v instanceof Set ? [...v].sort() : v);
const NAMES = { 'xpizza-orders': ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS'],
  'la-musa-orders': ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM'] };

// One page: serve this body through the real chain, then order 2× the first priced dish + its first option.
async function run(dir, body) {
  const rid = BRAND[dir].rid;
  const w = loadForm(dir); await settle();
  await serve(w, envelope(rid, body, '1d.2'));
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
  assert.ok(sent.createOrder, `${dir}: premise — createOrder was sent`);
  assert.ok(sent.quote, `${dir}: premise — the quote request was sent (so its comparison is not null vs null)`);
  const fp = cartFingerprint(normalizeCartForFingerprint(sent.createOrder.items, rid), null);
  // the two per-SUBMISSION values (a random order id, the wall clock) — named, so any other difference still fails
  const VOLATILE = ['order_id', 'timestamp'];
  const fixed = (b) => { if (!b) return null; const o = clone(b); for (const k of VOLATILE) if (k in o) o[k] = '<volatile>'; return o; };
  for (const k of VOLATILE) assert.ok(k in sent.createOrder, `${dir}: premise — createOrder carries ${k}`);
  return { globals, dom, createOrder: fixed(sent.createOrder), quote: fixed(sent.quote), fp };
}

(async () => {
  for (const dir of DIRS) {
    const rid = BRAND[dir].rid;
    const b0 = await baseBody(rid);
    const b1 = withDisplay(rid, b0);
    assert.ok(Object.keys(b1.photos).length > 0, `${dir}: non-vacuity — the display body carries photos`);
    assert.ok(b1.categories.every((c) => typeof c.name === 'string' && c.name), `${dir}: non-vacuity — every category is named`);
    assert.notDeepStrictEqual(b1, b0, `${dir}: non-vacuity — the two bodies differ`);

    const r0 = await run(dir, b0); closeAll();
    const r1 = await run(dir, b1); closeAll();
    assert.deepStrictEqual(r1.globals, r0.globals, `🔴 ${dir}: the new fields changed a committed live-menu global`);
    assert.strictEqual(r1.dom, r0.dom, `🔴 ${dir}: the new fields changed the painted page`);
    assert.deepStrictEqual(r1.createOrder, r0.createOrder, `🔴 ${dir}: the new fields changed the createOrder body (cart records / items_text / canonical)`);
    assert.deepStrictEqual(r1.quote, r0.quote, `🔴 ${dir}: the new fields changed the quote request`);
    assert.strictEqual(r1.fp, r0.fp, `🔴 ${dir}: the new fields changed the quote fingerprint`);

    // the sensitivity partner: one dish renamed in the body must move the same comparisons
    const bs = clone(b0); const di = bs.dishes.findIndex((d) => d.price > 0); bs.dishes[di] = { ...bs.dishes[di], name: `${bs.dishes[di].name} Prueba` };
    const rs = await run(dir, bs); closeAll();
    assert.notDeepStrictEqual(rs.globals, r0.globals, `${dir}: sensitivity — a renamed dish moves the globals`);
    assert.notStrictEqual(rs.dom, r0.dom, `${dir}: sensitivity — and the painted page`);
    assert.notDeepStrictEqual(rs.createOrder, r0.createOrder, `${dir}: sensitivity — and the createOrder body`);
    ok(`${dir}: with photos + named categories the REAL page commits the same globals, paints the same page and sends the same createOrder/quote bodies and fingerprint; a renamed dish moves all three`);
  }

  // the forms themselves: byte-identical to the base
  for (const dir of DIRS) {
    const now = readFileSync(new URL(`./${dir}/index.html`, import.meta.url), 'utf8');
    const was = execFileSync('git', ['show', `${BASE}:${dir}/index.html`], { cwd: new URL('.', import.meta.url).pathname, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.strictEqual(now, was, `🔴 ${dir}/index.html changed`);
  }
  ok(`both form files are byte-identical to ${BASE}`);
  console.log(`\npublic-menu-display-noop: OK (${count()})`);
})().catch((e) => { console.error(e); process.exit(1); });
