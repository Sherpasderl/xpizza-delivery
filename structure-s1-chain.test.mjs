// STRUCTURE S1 — the checklist is APP-ONLY, proven through the real chain (PLAN-portal-structure-S1-ui r3 §5, Codex plan r1 #3).
// Run: node structure-s1-chain.test.mjs
//
//   the PORTAL writes (xpizza-portal editor.js + item-edit-logic.js, the drawer's working copy and «Guardar»)
//   → publication: publish's own builder (sourceToBuildInputs → buildCatalogV2) and its eligibility document (buildEligibilityDoc:
//     the projection + public_deny)
//   → the served body exactly as getPublicMenu assembles it: composeServedMenu (the generator + the CARRIED_FROM_STRUCTURE fields,
//     extras_by_category among them) + extras_eligibility { version, deny: public_deny } (catalog/public-menu.js:217, :229-230)
//   → the CUSTOMER APP's reader (customer-app/capp-menu.js adaptMenu(...).extrasFor) AND BOTH old forms' readers, the real pages:
//     x_pizza extrasOfferedFor (xpizza-orders/index.html:5884) and La Musa extrasGroupsForItem (la-musa-orders/index.html:2118).
// The extra is offered everywhere first; after the dish's exclusion it disappears ONLY from the app; cleared, it returns.
// «Sin extras» is not app-only: the app AND both forms stop offering extras (both forms honour extras_policy 'none').
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { loadForm, settle, serve, envelope, closeAll, counter } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
runInThisContext(readFileSync(new URL('./xpizza-portal/extras-eligibility.js', import.meta.url), 'utf8'));   // the portal page's own copy
const { createDraft, draftSource } = await import('./xpizza-portal/editor.js');
const IE = await import('./xpizza-portal/item-edit-logic.js');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { canonicalize, sourceToBuildInputs } = require('./catalog/source-store');
const { buildCatalogV2 } = require('./catalog/form-menu-source');
const { composeServedMenu } = require('./catalog/public-menu');
const { buildEligibilityDoc } = require('./catalog/extras-eligibility-store');
const { adaptMenu } = createRequire(new URL('./customer-app/x.js', import.meta.url))('./capp-menu.js');
const { ok } = counter();

// publication → the served body, as getPublicMenu builds it
function served(rid, source) {
  const inputs = sourceToBuildInputs(source);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, extrasTable: inputs.extras });
  const body = composeServedMenu(rid, { items: built.items, extras: built.extras, structure: built.structure });
  const doc = buildEligibilityDoc({ items: built.items, extras: built.extras, structure: built.structure });
  body.extras_eligibility = { version: doc.version, deny: doc.public_deny };
  return envelope(rid, body);
}
const isDish = (x, key) => !!x && (x.item_key === key || x.name === key || String(x.id) === key || String(x.dish_id) === key);
const isExtra = (e, key) => !!e && (String(e.id) === key || e.name === key);
// the customer app: does it offer extra `xk` on dish `dk`?
function appOffers(env, dk, xk) {
  const m = adaptMenu(env);
  const d = m.dishes.find((x) => isDish(x, dk));
  assert.ok(d, `premise: the app has ${dk}`);
  return m.extrasFor(d.key).some((e) => isExtra(e, xk));
}
// an old form (the real page, served that body): does its picker reader offer `xk` on `dk`? (null/empty groups = nothing)
const READER = { 'xpizza-orders': 'extrasOfferedFor', 'la-musa-orders': 'extrasGroupsForItem' };
async function formOffers(dir, env, dk, xk) {
  const w = loadForm(dir); await settle();
  await serve(w, env);
  const st = w.__liveMenu && w.__liveMenu.feed && w.__liveMenu.feed.state();
  assert.ok(st && st.source === 'live', `premise: ${dir} applied the served menu (${st && st.lastError})`);
  const d = w.liveMenuGlobalGet('MENU').find((x) => isDish(x, dk));
  assert.ok(d, `premise: ${dir} has ${dk}`);
  const groups = JSON.parse(JSON.stringify(w.eval(READER[dir])(d) || []));   // out of the page's realm
  return groups.some((g) => (g.extras || []).some((e) => isExtra(e, xk)));
}

const CASES = [
  { rid: 'x_pizza', dir: 'xpizza-orders', dish: 'Carnivora' },
  { rid: 'la_musa', dir: 'la-musa-orders', dish: 'dimsum_01' },
];
for (const { rid, dir, dish } of CASES) {
  const d = createDraft(canonicalize(buildSourceFromCode(rid)));
  const s0 = IE.open(d, dish, null, { extrasAuthoring: true });
  const xk = IE.view(d, s0).extras.cards[0].rows[0].key;
  IE.cancel(s0);
  // 1. before: offered by the app and the form
  let env = served(rid, draftSource(d));
  assert.strictEqual(appOffers(env, dish, xk), true, `${rid}: premise — the app offers ${xk} on ${dish}`);
  assert.strictEqual(await formOffers(dir, env, dish, xk), true, `${rid}: premise — the form offers ${xk} on ${dish}`);
  // 2. the portal excludes it on this dish (the drawer's copy → «Guardar»)
  const s1 = IE.open(d, dish, null, { extrasAuthoring: true });
  IE.set(s1, 'extraOn', { key: xk, on: false });
  assert.ok(IE.save(d, s1).ok);
  env = served(rid, draftSource(d));
  assert.strictEqual(appOffers(env, dish, xk), false, `${rid}: the app no longer offers ${xk} on ${dish}`);
  assert.strictEqual(await formOffers(dir, env, dish, xk), true, `${rid}: the old form STILL offers ${xk} (app-only, owner decision 5)`);
  ok(`${rid}: an exclusion hides ${xk} on ${dish} in the app ONLY; the old form still offers it`);
  // 3. cleared → offered again
  const s2 = IE.open(d, dish, null, { extrasAuthoring: true });
  IE.set(s2, 'extraOn', { key: xk, on: true });
  assert.ok(IE.save(d, s2).ok);
  env = served(rid, draftSource(d));
  assert.strictEqual(appOffers(env, dish, xk), true, `${rid}: cleared → the app offers ${xk} again`);
  ok(`${rid}: clearing the exclusion brings ${xk} back in the app`);
  // 4. «Sin extras» reaches the app AND the form
  const s3 = IE.open(d, dish, null, { extrasAuthoring: true });
  IE.set(s3, 'extrasNone', true);
  assert.ok(IE.save(d, s3).ok);
  env = served(rid, draftSource(d));
  assert.strictEqual(appOffers(env, dish, xk), false, `${rid}: «Sin extras» — the app offers nothing`);
  assert.strictEqual(await formOffers(dir, env, dish, xk), false, `${rid}: «Sin extras» — the old form offers nothing either`);
  ok(`${rid}: «Sin extras» hides the extras in the app AND the old form (not app-only)`);
}
closeAll();
console.log('structure-s1-chain: all assertions passed');
