'use strict';
// form-bundle-live-check — the pure comparison, driven from each form's REAL committed bundle (no network).
// Run: node tools/form-bundle-live-check.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { FORMS } = require('./splice-form-bundle');
const { extractBundle } = require('../catalog/splice-form-bundle');
const { compareBundle, unregisteredForms, publicMenuUrl } = require('./form-bundle-live-check');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
// What getPublicMenu adds on top of the generated bundle: the platform identity keys, which the forms accept-and-ignore.
const served = (b) => {
  const m = clone(b);
  m.dishes.forEach((d, i) => { d.identity_id = `ID${i}`; d.dish_id = `ID${i}`; });
  m.extras.forEach((e, i) => { e.identity_id = `EX${i}`; e.extra_id = `EX${i}`; });
  return m;
};

const rids = Object.keys(FORMS);
assert.ok(rids.length >= 2, 'premise: the splice registry lists the forms');
for (const rid of rids) {
  const html = readFileSync(FORMS[rid], 'utf8');
  const baked = extractBundle(html);
  assert.ok(baked.dishes.length > 1 && baked.extras.length > 0, `${rid}: premise — a real bundle`);

  assert.deepStrictEqual(compareBundle(baked, served(baked)), { fail: [], warn: [] }, `${rid}: identical menus (+ identity keys) pass clean`);

  const repriced = served(baked); repriced.dishes[0].price += 26;
  const r1 = compareBundle(baked, repriced);
  assert.strictEqual(r1.fail.length, 1, `${rid}: a repriced dish fails`); assert.match(r1.fail[0], / price: baked \d+ \| published \d+/);

  const optionPrice = served(baked); optionPrice.extras[0].price += 5;
  assert.strictEqual(compareBundle(baked, optionPrice).fail.length, 1, `${rid}: a repriced option fails`);

  const renamed = served(baked); renamed.dishes[1].name += ' X';
  assert.strictEqual(compareBundle(baked, renamed).fail.length, 1, `${rid}: any other field change on a dish fails`);

  const removed = served(baked); removed.dishes.splice(1, 1);
  const r2 = compareBundle(baked, removed);
  assert.ok(r2.fail.some((f) => /baked but absent/.test(f)), `${rid}: a baked dish missing from the published menu fails`);

  const added = served(baked);
  added.dishes.push({ id: 'zz_new', cat: baked.dishes[0].cat, name: 'Nuevo', price: 100 });
  added.variant_items = { ...(added.variant_items || {}), zz_new: { label: 'Salsa', basePrice: 100, variantIds: [] } };
  const r3 = compareBundle(baked, added);
  assert.deepStrictEqual(r3.fail, [], `${rid}: a published-only dish does NOT fail`);
  assert.strictEqual(r3.warn.length, 2, `${rid}: …it is listed as a warning (dish + its variant group)`);

  assert.match(publicMenuUrl(html, rid), new RegExp(`/menu/${rid}$`), `${rid}: the URL is the form's own PUBLICMENU_URL`);
  ok(`${rid}: clean on equal menus; FAIL on a repriced dish, a repriced option, a changed field and a removed dish; WARN on a published-only addition`);
}
assert.deepStrictEqual(unregisteredForms(), [], 'every form that carries a baked menu is in the splice registry');
{ const [dropped, ...rest] = rids; const partial = Object.fromEntries(rest.map((r) => [r, FORMS[r]]));
  assert.deepStrictEqual(unregisteredForms(partial), [FORMS[dropped]], 'non-vacuity: a form missing from the registry is reported'); }
ok('every form folder with a baked menu is registered, so a new brand cannot ship unchecked');
console.log(`\nform-bundle-live-check: OK (${n})`);
