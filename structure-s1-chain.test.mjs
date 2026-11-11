// STRUCTURE S1 — the checklist is APP-ONLY, proven through the REAL chain (PLAN-portal-structure-S1-ui r3 §5; Codex plan r1 #3 and
// Codex build r1 #5). Run: node structure-s1-chain.test.mjs
//
//   the PORTAL writes (xpizza-portal editor.js + item-edit-logic.js: the drawer's working copy and «Guardar»)
//   → SAVE: the real editCatalogCore (validate, compare to the active version, the reviewed diff + token) — the extras switch ON
//   → PUBLISH: the real publishEditedCore with that token; the input it hands to publishVersion is published by the REAL
//     publishVersion into the functions' own Firestore fake (the version, its meta/extras_eligibility doc, the pointer flip)
//   → SERVE: the REAL buildPublicMenu (the 1A reader, the version-bound eligibility read, composeServedMenu), wrapped exactly as the
//     endpoint sends it ({ rid, representation_version, menu })
//   → the CUSTOMER APP's reader (customer-app/capp-menu.js adaptMenu(...).extrasFor) AND BOTH old forms' readers on the real pages:
//     x_pizza extrasOfferedFor (xpizza-orders/index.html:5884) and La Musa extrasGroupsForItem (la-musa-orders/index.html:2118).
// The extra is offered by the form; after the dish's exclusion it disappears ONLY from the app; cleared, the app offers it again.
// «Sin extras» is not app-only: the app AND both forms stop offering extras (both forms honour extras_policy 'none').
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { loadForm, settle, serve, closeAll, counter } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
// the platform extras-authoring switch ON for this flow (shipped OFF) — set before the handlers load it (category-rename-flow's pattern)
{ const p = require.resolve('./catalog/platform-extras'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { extrasCapabilities: () => ({ authoring: true }) } }; }
const { editCatalogCore } = require('./catalog/edit-catalog-handler');
const { publishEditedCore } = require('./catalog/publish-edited-handler');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { canonicalize, sourceToBuildInputs } = require('./catalog/source-store');
const { buildCatalogV2 } = require('./catalog/form-menu-source');
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildPublicMenu } = require('./catalog/public-menu');
runInThisContext(readFileSync(new URL('./xpizza-portal/extras-eligibility.js', import.meta.url), 'utf8'));   // the portal page's own copy
const { createDraft, draftSource } = await import('./xpizza-portal/editor.js');
const IE = await import('./xpizza-portal/item-edit-logic.js');
const { adaptMenu } = createRequire(new URL('./customer-app/x.js', import.meta.url))('./capp-menu.js');
const { ok } = counter();

const T0 = '2026-11-11T10:00:00.000000Z', T1 = '2026-11-11T11:00:00.000000Z';
const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }), extras: i.extras }; };
const liveRead = (rid, live) => async () => {
  const i = sourceToBuildInputs(live);
  return { built: builtOf(live, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }).extras };
};
// the save side: the stored draft doc with a faithful update-time precondition (category-rename-flow's stub)
function saveDb(rid, stored) {
  const state = { source: { data: clone(stored), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => {
      if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; }
      state.source = { data, updateTime: T1 }; return { writeTime: T1 };
    },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
// SAVE → PUBLISH → SERVE, every step the real one; returns the endpoint's envelope
async function flow(rid, live, incoming) {
  const db = saveDb(rid, live);
  const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead(rid, live) }, { restaurantId: rid, source: incoming, baseSourceUpdateTime: T0 }, {});
  assert.strictEqual(r.status, 200, `${rid}: save → 200 (got ${r.status} ${JSON.stringify(r.body).slice(0, 240)})`);
  const publishes = [];
  const deps = { db: {}, authorize: owner, readActiveBuilt: liveRead(rid, live), readDraft: async () => ({ source: db.state.source.data, updateTime: T1 }),
    publishVersion: async (_db, rr, input, opts) => { publishes.push({ rr, input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } };
  const pub = await publishEditedCore(deps, { restaurantId: rid, token: r.body.token, ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
  assert.strictEqual(pub.status, 200, `${rid}: publish → 200 (got ${pub.status} ${JSON.stringify(pub.body).slice(0, 240)})`);
  assert.strictEqual(publishes.length, 1, `${rid}: exactly one publish`);
  const store = makeDb();
  await publishVersion(store, rid, publishes[0].input, { expected: { activeVersionId: null } });
  const out = await buildPublicMenu(store, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true });
  return { rid: out.rid, representation_version: out.representation_version, menu: out.body };
}
const isDish = (x, key) => !!x && (x.item_key === key || x.name === key || String(x.id) === key || String(x.dish_id) === key);
const isExtra = (e, key) => !!e && (String(e.id) === key || e.name === key);
function appOffers(env, dk, xk) {
  const m = adaptMenu(env);
  const d = m.dishes.find((x) => isDish(x, dk));
  assert.ok(d, `premise: the app has ${dk}`);
  return m.extrasFor(d.key).some((e) => isExtra(e, xk));
}
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
// the portal's write: a fresh copy of the live source, the drawer's working copy, «Guardar»
function portalWrite(live, dish, apply) {
  const d = createDraft(clone(live));
  const s = IE.open(d, dish, null, { extrasAuthoring: true });
  apply(s, d);
  assert.ok(IE.save(d, s).ok, 'the drawer saved');
  return clone(draftSource(d));
}

const CASES = [
  { rid: 'x_pizza', dir: 'xpizza-orders', dish: 'Carnivora' },
  { rid: 'la_musa', dir: 'la-musa-orders', dish: 'dimsum_01' },
];
for (const { rid, dir, dish } of CASES) {
  const seed = canonicalize(buildSourceFromCode(rid));
  const probe = createDraft(clone(seed));
  const xk = IE.view(probe, IE.open(probe, dish, null, { extrasAuthoring: true })).extras.cards[0].rows[0].key;
  // 1. the portal excludes it on this dish → save → publish → serve
  const excluded = portalWrite(seed, dish, (s) => IE.set(s, 'extraOn', { key: xk, on: false }));
  let env = await flow(rid, seed, excluded);
  assert.strictEqual(appOffers(env, dish, xk), false, `${rid}: the app no longer offers ${xk} on ${dish}`);
  assert.strictEqual(await formOffers(dir, env, dish, xk), true, `${rid}: the old form STILL offers ${xk} (app-only, owner decision 5)`);
  ok(`${rid}: the exclusion, saved + published + served for real, hides ${xk} on ${dish} in the app ONLY; the old form still offers it`);
  // 2. cleared → the app offers it again (the published version moved under the save: live = the excluded one)
  const cleared = portalWrite(excluded, dish, (s) => IE.set(s, 'extraOn', { key: xk, on: true }));
  env = await flow(rid, excluded, cleared);
  assert.strictEqual(appOffers(env, dish, xk), true, `${rid}: cleared → the app offers ${xk} again`);
  ok(`${rid}: clearing it (through the same chain) brings ${xk} back in the app`);
  // 3. «Sin extras» reaches the app AND the form
  const none = portalWrite(cleared, dish, (s) => IE.set(s, 'extrasNone', true));
  env = await flow(rid, cleared, none);
  assert.strictEqual(appOffers(env, dish, xk), false, `${rid}: «Sin extras» — the app offers nothing`);
  assert.strictEqual(await formOffers(dir, env, dish, xk), false, `${rid}: «Sin extras» — the old form offers nothing either`);
  ok(`${rid}: «Sin extras» hides the extras in the app AND the old form (not app-only)`);
}
closeAll();
console.log('structure-s1-chain: all assertions passed');
