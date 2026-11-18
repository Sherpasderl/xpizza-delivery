// STRUCTURE S2 — the Extras page's edits through the REAL chain (PLAN-portal-structure-S2-ui r3 §6 «the REAL portal request through the
// real server chain»; Codex S2 UI r1 P2-11). Run: node structure-s2-chain.test.mjs
//
//   the PORTAL writes (xpizza-portal editor.js applyExposureOps / setExtraPrice / item-edit-logic.js — the page's own writers) and its
//   OWN request body (the draft source the page posts: keyless new extras carry their tmp: ref)
//   → SAVE: the real editCatalogCore, the S2 switch ON, the add-product I/O as 5f's own S2-core flow suite wires it (allocation)
//   → PUBLISH: the real publishEditedCore with that token; its input published by the REAL publishVersion into the Firestore fake
//   → SERVE: the REAL buildPublicMenu, wrapped as the endpoint sends it
//   → the CUSTOMER APP's reader (capp-menu.js adaptMenu(...).extrasFor) and, where the contract is global, BOTH old forms' readers.
// Plus §4's FOUR-PATH identity: one draft's «Estructura» rendered from the owner's save, the manager's save, a fresh reload of the
// stored draft (adopted keys) and the owner's publish re-read (which refuses unless its own diff is the token-bound one) — identical.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { loadForm, settle, serve, closeAll, counter } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
{ const p = require.resolve('./catalog/platform-extras'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { extrasCapabilities: () => ({ authoring: true }) } }; }
{ const p = require.resolve('./catalog/platform-structure'); const real = require('./catalog/platform-structure');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, structureCapabilities: () => ({ ...real.structureCapabilities(), extrasCatalog: true }) } }; }
const { editCatalogCore } = require('./catalog/edit-catalog-handler');
const { publishEditedCore } = require('./catalog/publish-edited-handler');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const { canonicalize, sourceToBuildInputs } = require('./catalog/source-store');
const { buildCatalogV2 } = require('./catalog/form-menu-source');
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion } = require('./catalog/catalog-publish');
const { buildPublicMenu } = require('./catalog/public-menu');
const { reservedKeySet } = require('./catalog/reserved-keys');
runInThisContext(readFileSync(new URL('./xpizza-portal/extras-eligibility.js', import.meta.url), 'utf8'));
runInThisContext(readFileSync(new URL('./xpizza-portal/exposure-transitions.js', import.meta.url), 'utf8'));
const { createDraft, draftSource, applyExposureOps, setExtraPrice } = await import('./xpizza-portal/editor.js');
const { reviewModel, renderReview, ackSetFrom } = await import('./xpizza-portal/review.js');
const { adaptMenu } = createRequire(new URL('./customer-app/x.js', import.meta.url))('./capp-menu.js');
const { JSDOM } = require('jsdom');
const { ok } = counter();

const T0 = '2026-11-12T10:00:00.000000Z', T1 = '2026-11-12T11:00:00.000000Z';
const ACTIVE = 'v-active-1';
const ON = { extrasCatalog: true };
const { capsFor } = require('./access/membership');
// the owner as today's cells authorize; a menu manager with the capabilities resolveAccess derives for a manager who may edit the menu
const role = (r) => async () => (r === 'manager'
  ? { ok: true, uid: 'u_manager', role: 'manager', actor: 'manager@x.hn', caps: capsFor({ manager: true, manager_menu: true }, 'member') }
  : { ok: true, uid: `u_${r}`, role: r, actor: `${r}@x.hn` });
const clone = (x) => JSON.parse(JSON.stringify(x));
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }), extras: i.extras }; };
const liveRead = (rid, live) => async () => {
  const i = sourceToBuildInputs(live);
  return { built: builtOf(live, rid), versionId: ACTIVE, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras }).extras };
};
// the add-product I/O exactly as 5f's own S2-core flow suite wires it (catalog/s2core-flow.test.js addProductOf): each brand's key mode
const addProductOf = (rid) => ({ readKeyMode: async () => (rid === 'la_musa' ? 'id' : 'name'), hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
  registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => reservedKeySet(undefined) });
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
async function save(rid, live, incoming, who = 'owner', storedDoc = live) {   // storedDoc: the draft doc the save writes over (a reload: the saved draft)
  const db = saveDb(rid, storedDoc);
  const r = await editCatalogCore({ db, addProduct: addProductOf(rid), authorize: role(who), readActiveBuilt: liveRead(rid, live) }, { restaurantId: rid, source: clone(incoming), baseSourceUpdateTime: T0 }, {});
  assert.strictEqual(r.status, 200, `${rid}: save (${who}) → 200 (got ${r.status} ${JSON.stringify(r.body).slice(0, 240)})`);
  return { r, db };
}
// SAVE → PUBLISH → SERVE, every step the real one; returns the endpoint's envelope and the stored (adopted) draft
async function flow(rid, live, incoming) {
  const { r, db } = await save(rid, live, incoming);
  const publishes = [];
  const deps = { db: {}, addProduct: addProductOf(rid), authorize: role('owner'), readActiveBuilt: liveRead(rid, live), readDraft: async () => ({ source: db.state.source.data, updateTime: T1 }),
    publishVersion: async (_db, rr, input, opts) => { publishes.push({ rr, input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } };
  const pub = await publishEditedCore(deps, { restaurantId: rid, token: r.body.token, acknowledgedChanges: ackSetFrom(r.body.diff), ...(rid === 'x_pizza' ? { fiscalAck: true } : {}) }, {});
  assert.strictEqual(pub.status, 200, `${rid}: publish → 200 (got ${pub.status} ${JSON.stringify(pub.body).slice(0, 240)})`);
  assert.strictEqual(publishes.length, 1, `${rid}: exactly one publish`);
  const store = makeDb();
  await publishVersion(store, rid, publishes[0].input, { expected: { activeVersionId: null } });
  const out = await buildPublicMenu(store, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true });
  return { env: { rid: out.rid, representation_version: out.representation_version, menu: out.body }, stored: clone(db.state.source.data), diff: r.body.diff };
}
const isDish = (x, key) => !!x && (x.item_key === key || x.name === key || String(x.id) === key || String(x.dish_id) === key);
const appExtras = (env, dk) => {
  const m = adaptMenu(env);
  const d = m.dishes.find((x) => isDish(x, dk));
  assert.ok(d, `premise: the app has ${dk}`);
  return m.extrasFor(d.key);
};
const appHas = (env, dk, name) => appExtras(env, dk).some((e) => e.name === name);
const READER = { 'xpizza-orders': 'extrasOfferedFor', 'la-musa-orders': 'extrasGroupsForItem' };
async function formExtras(dir, env, dk) {
  const w = loadForm(dir); await settle();
  await serve(w, env);
  const st = w.__liveMenu && w.__liveMenu.feed && w.__liveMenu.feed.state();
  assert.ok(st && st.source === 'live', `premise: ${dir} applied the served menu (${st && st.lastError})`);
  const d = w.liveMenuGlobalGet('MENU').find((x) => isDish(x, dk));
  assert.ok(d, `premise: ${dir} has ${dk}`);
  return JSON.parse(JSON.stringify(w.eval(READER[dir])(d) || [])).flatMap((g) => g.extras || []);
}
const nameOfExtra = (src, key) => (src.extras.find((e) => e.key === key) || {}).display.name;
// the portal's write: a fresh copy of the live source, the page's own writers, the posted body
function portalWrite(live, apply) {
  const d = createDraft(clone(live));
  apply(d);
  return clone(draftSource(d));
}
const exposure = (d, ops) => assert.strictEqual(applyExposureOps(d, ops, ON).ok, true, `the page's writer applies ${ops.map((o) => o.op).join(', ')}`);

// ── la_musa (id keys): a new group on a chosen dish · reprice · reorder · detach · remove (uncertified: no claim) ───────────────────
{
  const rid = 'la_musa', dir = 'la-musa-orders', dish = 'dimsum_01';
  const seed = canonicalize(buildSourceFromCode(rid));
  // 1. a new group with a new extra on the chosen dish → the app offers it on that dish (allocated by the save, published, served)
  const g1 = portalWrite(seed, (d) => exposure(d, [{ op: 'group.create', group: 'Toppings', extras: [{ ref: 'tmp:chain-new-0001', name: 'Miel', price: 17 }], attach: { mode: 'items', items: [dish] } }]));
  let f = await flow(rid, seed, g1);
  assert.strictEqual(appHas(f.env, dish, 'Miel'), true, `${rid}: the app offers the new extra on ${dish}`);
  assert.strictEqual(appHas(f.env, 'dimsum_02', 'Miel'), false, `${rid}: and only on the chosen dish`);
  assert.ok(f.stored.extras.some((e) => e.display.name === 'Miel' && typeof e.key === 'string'), `${rid}: the stored draft carries the allocated key (adopted on reload)`);
  ok(`${rid}: a new group on a chosen dish — allocated, published, served; the app offers it on that dish only`);
  // 2. reprice an existing extra → the app AND the form charge the new price
  let live = f.stored;
  const xk = live.extras.find((e) => e.display.cat === 'Salsas').key; const xn = nameOfExtra(live, xk); const xp = live.extras.find((e) => e.key === xk).price;
  const g2 = portalWrite(live, (d) => setExtraPrice(d, { key: xk }, String(xp + 5)));
  f = await flow(rid, live, g2);
  assert.strictEqual(appExtras(f.env, dish).find((e) => e.name === xn).price, xp + 5, `${rid}: the app charges L ${xp + 5} for ${xn}`);
  assert.strictEqual((await formExtras(dir, f.env, dish)).find((e) => e.name === xn).price, xp + 5, `${rid}: the old form charges it too`);
  ok(`${rid}: a reprice reaches the app and the old form`);
  // 3. reorder: Salsas first everywhere
  live = f.stored;
  const order = live.structure.extra_categories.slice(); const next = ['Salsas', ...order.filter((g) => g !== 'Salsas')];
  const g3 = portalWrite(live, (d) => exposure(d, [{ op: 'group.order', order: next }]));
  f = await flow(rid, live, g3);
  const firstGroup = (xs) => { const s = live.extras.find((e) => e.display.name === xs[0].name); return s ? s.display.cat : null; };
  assert.strictEqual(firstGroup(appExtras(f.env, dish)), 'Salsas', `${rid}: the app lists Salsas first`);
  assert.strictEqual(firstGroup(await formExtras(dir, f.env, dish)), 'Salsas', `${rid}: the old form lists Salsas first`);
  ok(`${rid}: the ONE group order reaches the app and the old form`);
  // 4. detach EVERY group from the dish → the app offers it nothing (an empty entry the live refresh replaces)
  live = f.stored;
  const on = [...new Set(appExtras(f.env, dish).map((e) => live.extras.find((x) => x.display.name === e.name).display.cat))];
  assert.ok(on.length >= 2, `premise: ${dish} offers several groups (${on})`);
  const g4 = portalWrite(live, (d) => exposure(d, on.map((g) => ({ op: 'detach.item', item: dish, group: g }))));
  f = await flow(rid, live, g4);
  assert.deepStrictEqual(appExtras(f.env, dish), [], `${rid}: after the last detach the app offers ${dish} no extra`);
  assert.ok(appExtras(f.env, 'dimsum_02').length > 0, `${rid}: another dish keeps its extras`);
  ok(`${rid}: detaching every group empties the dish's extras in the app; other dishes keep theirs`);
}

// ── x_pizza (name keys, the platform-factura brand; Codex S2 UI r2 P2-11): a new extra in a group the dish offers · a reprice · the
// group order — through the save, the owner's publish (fiscal ack), the served menu, the app AND the X Pizza form's own reader ─────
{
  const rid = 'x_pizza', dir = 'xpizza-orders', dish = 'Carnivora';
  const seed = canonicalize(buildSourceFromCode(rid));
  const grp = seed.extras.find((e) => e.key === 'Pepperoni').display.cat;
  // 1. a new extra in the dish's group + a reprice of a published one, in ONE save
  const xp = seed.extras.find((e) => e.key === 'Pepperoni').price;
  const g1 = portalWrite(seed, (d) => { exposure(d, [{ op: 'extra.add', group: grp, ref: 'tmp:chain-xp-new-0001', name: 'Anchoas', price: 45 }]); setExtraPrice(d, { key: 'Pepperoni' }, String(xp + 5)); });
  let f = await flow(rid, seed, g1);
  assert.strictEqual(appExtras(f.env, dish).find((e) => e.name === 'Anchoas').price, 45, `${rid}: the app offers the new extra on ${dish} at its price`);
  assert.strictEqual(appExtras(f.env, dish).find((e) => e.name === 'Pepperoni').price, xp + 5, `${rid}: the app charges the new price`);
  const fx = await formExtras(dir, f.env, dish);
  assert.strictEqual((fx.find((e) => e.name === 'Anchoas') || {}).price, 45, `${rid}: the X Pizza form offers the new extra at its price`);
  assert.strictEqual((fx.find((e) => e.name === 'Pepperoni') || {}).price, xp + 5, `${rid}: the X Pizza form charges the new price`);
  assert.ok(f.stored.extras.some((e) => e.display.name === 'Anchoas' && typeof e.key === 'string'), `${rid}: the stored draft carries the allocated key`);
  ok(`${rid}: a new extra + a reprice reach the app and the X Pizza form (name keys, fiscal publish)`);
  // 2. the ONE group order: the last group first, everywhere
  const live = f.stored;
  const order = live.structure.extra_categories.slice(); const lastG = order[order.length - 1];
  const g2 = portalWrite(live, (d) => exposure(d, [{ op: 'group.order', order: [lastG, ...order.filter((g) => g !== lastG)] }]));
  f = await flow(rid, live, g2);
  const firstGroup = (xs) => { const s = live.extras.find((e) => e.display.name === xs[0].name); return s ? s.display.cat : null; };
  assert.strictEqual(firstGroup(appExtras(f.env, dish)), lastG, `${rid}: the app lists ${lastG} first`);
  assert.strictEqual(firstGroup(await formExtras(dir, f.env, dish)), lastG, `${rid}: the X Pizza form lists ${lastG} first`);
  ok(`${rid}: the ONE group order reaches the app and the X Pizza form`);
}

// ── §4 the FOUR-PATH identity on a REAL store (Codex S2 UI r2 P2-11) — 5f's firestore double (updateTime CAS), the caller resolved by the
// REAL authorizeCatalogEdit from a membership double, 5f's real add-product I/O; the manager's path is the manager's save AND the REAL
// requestPublishCore, which re-derives the draft's diff and refuses the token unless it IS the rendered one (on a brand that publishes
// without the owner the real handler says so) ──────────────────────────────────────────────────────────────────────────────────────
const { Timestamp } = require('firebase-admin/firestore');
const { createFakeDb } = require('./merchant/_fake-db');
const { authorizeCatalogEdit } = require('./catalog/catalog-edit-auth');
const { addProductIo } = require('./catalog/add-product-io');
const { usesPlatformFactura } = require('./factura/eligibility');
const PR = require('./catalog/publish-request');
const { encodeUpdateTime } = require('./catalog/source-store');
const UID = { owner: 'uOwner01', manager: 'uMgr01' };
function realStore(rid, live, draftDoc = live) {
  const fs = makeDb();
  const rtdb = createFakeDb({
    brands: { [rid]: { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } } },
    restaurants: { [rid]: { identity: { name: rid } } },
    brand_members: { [rid]: { owners: { [UID.owner]: { granted_at: 1 } }, managers: { [rid]: { [UID.manager]: { granted_at: 1 } } },
      manager_perms: { [UID.manager]: { can_edit_menu: true } }, profiles: { [UID.manager]: { name: 'Dania Reyes', email: 'dania@m.hn' } } } },
  });
  const meta = (id) => fs.collection('restaurants').doc(rid).collection('meta').doc(id);
  meta('source').set(clone(draftDoc));
  meta('active_version').set({ version: ACTIVE, generation: 1 });
  fs.collection('restaurants').doc(rid).set({ pricing_key_mode: live.key_mode });   // the seeded profile's mode = the seeded source's key_mode
  const addProduct = addProductIo({ fs, rtdb });
  const readActiveBuilt = liveRead(rid, live);
  // portal/functions.js decodeUpdateTimeForEdit (not exported): the inverse of encodeUpdateTime, nanoseconds kept
  const toPrecondition = (v) => { const [a, b] = String(v).split('.'); return /^\d+$/.test(a || '') && /^\d+$/.test(b || '') ? new Timestamp(Number(a), Number(b)) : v; };
  const rq = { get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer t' : undefined) };
  const authorize = (who) => (r) => authorizeCatalogEdit({ db: rtdb, verifyIdToken: async () => ({ uid: UID[who] }) }, rq, r);
  return {
    save: async (who, incoming) => {
      const base = encodeUpdateTime((await meta('source').get()).updateTime);
      const r = await editCatalogCore({ db: fs, authorize: authorize(who), readActiveBuilt, toPrecondition, addProduct }, { restaurantId: rid, source: clone(incoming), baseSourceUpdateTime: base }, rq);
      assert.strictEqual(r.status, 200, `${rid}: the real save (${who}) → 200 (got ${r.status} ${JSON.stringify(r.body).slice(0, 240)})`);
      return r;
    },
    request: (who, token) => PR.requestPublishCore({ fs, db: rtdb, now: () => 5000, readActiveBuilt, readDraft: (x) => PR.readDraftFrom(fs, x), addProduct }, { uid: UID[who], token: {} }, { restaurantId: rid, token }),
    publish: (token, diff) => publishEditedCore({ db: {}, addProduct, authorize: authorize('owner'), readActiveBuilt, readDraft: (x) => PR.readDraftFrom(fs, x),
      publishVersion: async () => ({ versionId: 'v-new-2', item_count: 0, extra_count: 0 }) },
    { restaurantId: rid, token, acknowledgedChanges: ackSetFrom(diff), ...(usesPlatformFactura(rid) ? { fiscalAck: true } : {}) }, rq),
    stored: async () => clone((await meta('source').get()).data()),
  };
}
const ctxOf = (src) => {
  const items = src.items.filter((r) => r && r.display && typeof r.key === 'string'); const cats = src.structure.categories || [];
  return { extraName: (k) => { const x = src.extras.find((e) => e.key === k); return x ? x.display.name : null; },
    extraGroup: (k) => { const x = src.extras.find((e) => e.key === k); return x ? x.display.cat : null; },
    structure: { nameOf: (k) => { const r = items.find((x) => x.key === k); return r ? r.display.name : k; },
      categoryName: (id) => { const c = cats.find((x) => String(x.id) === String(id)); return c && c.name ? c.name : String(id); },
      sectionOf: (k) => { const r = items.find((x) => x.key === k); return r ? { cat: String(r.display.cat), subcat: r.display.subcat || null } : { cat: null, subcat: null }; } } };
};
const w4 = new JSDOM('<!doctype html><div id="r"></div>').window;
const rendered = (diff, src) => {
  const saved = globalThis.document; globalThis.document = w4.document;
  try {
    const root = w4.document.getElementById('r'); root.replaceChildren();
    renderReview(root, reviewModel(diff, ctxOf(src)), {});
    const g = [...root.querySelectorAll('.mgroup')].find((x) => x.querySelector('.mglabel span').textContent === 'Estructura');
    assert.ok(g, 'premise: an «Estructura» group');
    return g.textContent;
  } finally { globalThis.document = saved; }
};
// each brand's dish and groups are read from its own seed (data), the edit is the same shape on both
for (const [rid, dish] of [['la_musa', 'dimsum_01'], ['x_pizza', 'Carnivora']]) {
  const seed = canonicalize(buildSourceFromCode(rid));
  const draft = portalWrite(seed, (d) => {
    const offered = globalThis.ExposureTransitions.effectiveGroups(globalThis.ExtrasEligibility.projectEligibility(draftSource(d)))[dish];
    assert.ok(offered && offered.length >= 2, `premise: ${rid} ${dish} offers several groups`);
    exposure(d, [{ op: 'group.create', group: 'Toppings', extras: [{ ref: 'tmp:four-path-0001', name: 'Miel', price: 17 }], attach: { mode: 'items', items: [dish] } },
      { op: 'detach.item', item: dish, group: offered[0] }]);
    const cur = draftSource(d).structure.extra_categories; const last = cur[cur.length - 1]; exposure(d, [{ op: 'group.order', order: [last, ...cur.filter((g) => g !== last)] }]);
    const rx = draftSource(d).extras.find((e) => typeof e.key === 'string' && e.display.cat === offered[1]); setExtraPrice(d, { key: rx.key }, String(rx.price + 5));
  });
  const S1 = realStore(rid, seed), S2 = realStore(rid, seed);
  const owner = await S1.save('owner', draft);
  const manager = await S2.save('manager', draft);
  const A = rendered(owner.body.diff, draft), B = rendered(manager.body.diff, draft);
  assert.strictEqual(B, A, `${rid}: the four review paths render the same Estructura — the manager’s save`);
  // the manager's REAL request: the handler re-derives the stored draft's diff and verifies the token bound to the one rendered above
  const reqd = await S2.request('manager', manager.body.token);
  if (usesPlatformFactura(rid)) assert.strictEqual(reqd.status, 200, `${rid}: the four review paths render the same Estructura — the REAL request handler accepts the manager's rendered diff (${reqd.status} ${JSON.stringify(reqd.body).slice(0, 160)})`);
  else assert.deepStrictEqual([reqd.status, reqd.body.error], [409, 'not_applicable'], `${rid}: the REAL request handler: this brand's manager publishes without the owner`);
  // the owner's publish re-read: publishEditedCore re-derives the diff and refuses the token unless it IS the one rendered above
  const pub = await S1.publish(owner.body.token, owner.body.diff);
  assert.strictEqual(pub.status, 200, `${rid}: the four review paths render the same Estructura — the publish re-read accepts the rendered diff (${pub.status} ${JSON.stringify(pub.body).slice(0, 160)})`);
  // a fresh reload: the page serves the STORED draft (adopted keys) and re-saves it over itself
  const stored = await S1.stored();
  assert.ok(stored.extras.some((e) => e.display.name === 'Miel' && typeof e.key === 'string'), `premise: ${rid}: the reload carries the allocated key`);
  const reload = await realStore(rid, seed, stored).save('owner', stored);
  assert.strictEqual(rendered(reload.body.diff, stored), A, `${rid}: the four review paths render the same Estructura — a fresh reload (adopted keys)`);
  ok(`§4 four paths (${rid}): the owner’s save, the manager’s save + the REAL request handler, the publish re-read and a fresh reload render / bind the same «Estructura»`);
}
closeAll();
console.log('structure-s2-chain: all assertions passed');
