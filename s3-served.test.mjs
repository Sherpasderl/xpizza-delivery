// S3 (PLAN-structure-S3-r4 §5, advisor 11-12: the sticky marker DROPPED) — `variant_items` stays in the SERVED body once a restaurant
// has had a group, with no switch and no marker: the writer keeps an emptied map as {} (choice-transitions), today's
// assertSameAuthoredFields refuses a draft that drops it while the live version has it, Firestore keeps {}, and the public menu
// serves the field whenever the version has it (BODY_CONTRACT fromSource). Run: node s3-served.test.mjs
//   (a) D3 → publish → the ENDPOINT path (buildPublicMenu) serves `variant_items: {}`, with choiceEdit ON and OFF
//   (b) a draft that drops the field after a D3 is structure_changed (the handler's own check, bound to the live version)
//   (c) F1-FORMS: both REAL forms, served a body WITH a group and then the post-D3 body, apply it (the dish plain, no options);
//       the same body WITHOUT the field is the retained-map refusal (the field is load-bearing)
//   (d) publish / D3 / rollback / republish: every served body of a restaurant that has had a group carries the field
//   (e) no path feeding the SERVED menu (the endpoint, the form rebake) reads an RTDB copy (snapshot / mirror / last-good)
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { counter, settle, loadForm, serve, closeAll } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const STRUCT = { choiceEdit: false };
{ const p = require.resolve('./catalog/platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: false }) } }; }
const { makeDb } = require('./catalog/firestore-fake');
const { publishVersion, rollbackVersion } = require('./catalog/catalog-publish');
const { buildSourceCandidate } = require('./catalog/candidate-validate');
const { buildPublicMenu } = require('./catalog/public-menu');
const { buildSourceFromCode } = require('./tools/seed-source-store');
const AP = require('./catalog/add-product');
const CT = require('./catalog/choice-transitions');
const CC = require('./catalog/choice-compare');
const { ok } = counter();
const WATCHDOG = setTimeout(() => { console.error('s3-served: FAILED — watchdog'); process.exit(1); }, 240000);
const clone = (v) => JSON.parse(JSON.stringify(v));
const KNOWN = new Set(['x_pizza', 'la_musa']);
const MODE = { x_pizza: 'name', la_musa: 'id' };
const DIR = { x_pizza: 'xpizza-orders', la_musa: 'la-musa-orders' };
const quiet = async (fn) => { const l = console.log, wn = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = wn; } };
const apply = (src, op) => CT.apply(src, op).source;

// the save's allocation of the new options (the real allocator, the injected S3 preparer)
const allocate = (rid, src, live) => AP.allocateAdditions({ incoming: src, stored: live, activeItems: live.items, keyMode: MODE[rid], hwm: null, registryHasKey: () => false, prepareExisting: CC.prepareExistingGroups }).source;
async function publish(db, rid, source, expected) {
  const { inputs, built } = buildSourceCandidate(rid, source);
  return (await quiet(() => publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's3s',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: expected } }))).versionId;
}
const served = async (db, rid) => { const m = await quiet(() => buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true })); return { rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }; };
const hasField = (env) => Object.prototype.hasOwnProperty.call(env.menu, 'variant_items');

// the two restaurants' histories: La Musa ships Pad Thai's group; X Pizza gets one (D2 on a non-reward dish) and loses it (D3)
const LM = buildSourceFromCode('la_musa');
const PAD = 'noodle_01';
const padOpts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
const LM_D3 = apply(LM, { op: 'choice.remove', launcher: PAD, price_from: padOpts[1] });
const XP = buildSourceFromCode('x_pizza');
const nonReward = XP.structure.categories.map((c) => c.id).find((c) => !(XP.structure.redeem_eligible_cats || []).includes(c) && XP.items.some((i) => i.display.cat === c));
const XDISH = XP.items.find((i) => i.display.cat === nonReward && i.display.variantOf == null).key;
const XP_D2 = allocate('x_pizza', apply(XP, { op: 'choice.add', key: XDISH, label: 'Tamaño', options: [{ ref: 'tmp:s3s-a-xxxxxx', choice: 'Personal' }, { ref: 'tmp:s3s-b-xxxxxx', choice: 'Grande', price: 999 }] }), XP);
const xOpts = XP_D2.structure.variant_items[String(XP_D2.items.find((i) => i.key === XDISH).display.id)].variantIds.map((id) => XP_D2.items.find((i) => String(i.display.id) === String(id)).key);
const XP_D3 = apply(XP_D2, { op: 'choice.remove', launcher: XDISH, price_from: xOpts[0] });
const HIST = { la_musa: { withGroup: LM, d3: LM_D3, dish: PAD }, x_pizza: { withGroup: XP_D2, d3: XP_D3, dish: XDISH } };

(async () => {
  // (a)
  for (const on of [true, false]) {
    STRUCT.choiceEdit = on;
    for (const rid of ['la_musa', 'x_pizza']) {
      const db = makeDb(); const v1 = await publish(db, rid, HIST[rid].withGroup, null); await publish(db, rid, HIST[rid].d3, v1);
      const env = await served(db, rid);
      assert.ok(hasField(env), `(a) ${rid} choiceEdit=${on}: the served body keeps variant_items after D3`);
      assert.deepStrictEqual(env.menu.variant_items, {}, `(a) ${rid}: it is {}`);
    }
  }
  STRUCT.choiceEdit = false;
  ok('(a) D3 → publish → the endpoint serves variant_items: {} — both brands, choiceEdit ON and OFF (no switch on the served shape)');

  // (b)
  for (const rid of ['la_musa', 'x_pizza']) {
    const stored = HIST[rid].d3.structure; const dropped = clone(stored); delete dropped.variant_items;
    assert.throws(() => AP.assertSameAuthoredFields(dropped, stored, { activeHasVariantItems: true }), (e) => e.code === 'structure_changed', `(b) ${rid}`);
  }
  assert.doesNotThrow(() => AP.assertSameAuthoredFields({ ...XP.structure, variant_items: {} }, XP.structure, { activeHasVariantItems: false }), 'a brand with no groups may gain the field (today\'s exemption)');
  const handler = readFileSync(new URL('./xpizza-functions/catalog/edit-catalog-handler.js', import.meta.url), 'utf8');
  assert.ok(handler.includes("AP.assertSameAuthoredFields(next.structure, stored.structure, { activeHasVariantItems: live.structure && live.structure.variant_items !== undefined })"), '(b) the save binds the check to the LIVE version\'s field');
  ok('(b) a draft dropping variant_items while the live version has it is structure_changed (the save\'s own check, bound to the live version)');

  // (c)
  for (const rid of ['la_musa', 'x_pizza']) {
    const db = makeDb(); const v1 = await publish(db, rid, HIST[rid].withGroup, null);
    const before = await served(db, rid);
    await publish(db, rid, HIST[rid].d3, v1);
    const after = await served(db, rid);
    const w = loadForm(DIR[rid]); await settle();
    await serve(w, before); await settle();
    const lid = String(HIST[rid].withGroup.items.find((i) => i.key === HIST[rid].dish).display.id);
    assert.ok(Object.keys(w.liveMenuGlobalGet('VARIANT_ITEMS') || {}).includes(lid), `(c) ${rid}: premise — the group is live in the form`);
    await serve(w, after); await settle();
    assert.deepStrictEqual(w.liveMenuGlobalGet('VARIANT_ITEMS'), {}, `(c) ${rid}: the post-D3 body applied — no group left`);
    assert.ok(!w.liveMenuGlobalGet('MENU').some((d) => d.variantOf != null && String(d.variantOf) === lid), `(c) ${rid}: no option of the removed group`);
    // counterfactual: the same body WITHOUT the field — the retained map has orphans and the form refuses the apply
    const w2 = loadForm(DIR[rid]); await settle();
    await serve(w2, before); await settle();
    const seen = []; const orig = w2.console.warn; w2.console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
    const stripped = clone(after); delete stripped.menu.variant_items;
    await serve(w2, stripped); await settle();
    w2.console.warn = orig;
    assert.ok(Object.keys(w2.liveMenuGlobalGet('VARIANT_ITEMS') || {}).includes(lid), `(c) ${rid}: without the field the form keeps the old group (the F1 trap)`);
    assert.ok(seen.some((l) => /refus|orphan|apply_/.test(l)), `(c) ${rid}: …and refuses the apply loudly (${seen.slice(0, 2).join(' | ').slice(0, 160)})`);
    closeAll();
  }
  ok('(c) F1-FORMS: both real forms apply the post-D3 body (the group gone); the same body without the field is the retained-map refusal');

  // (d)
  for (const rid of ['la_musa', 'x_pizza']) {
    const db = makeDb();
    const v1 = await publish(db, rid, HIST[rid].withGroup, null);
    const v2 = await publish(db, rid, HIST[rid].d3, v1);
    assert.ok(hasField(await served(db, rid)), `(d) ${rid} after D3`);
    await quiet(() => rollbackVersion(db, rid, v1, { expected: { activeVersionId: v2 } }));
    const r = await served(db, rid);
    assert.ok(hasField(r) && Object.keys(r.menu.variant_items).length > 0, `(d) ${rid}: the rollback serves the restored group`);
    await publish(db, rid, HIST[rid].d3, v1);
    assert.deepStrictEqual((await served(db, rid)).menu.variant_items, {}, `(d) ${rid}: republished D3 serves {}`);
  }
  ok('(d) publish → D3 → rollback → republish: every served body of a restaurant that has had a group carries variant_items');

  // (e) static: the served menu's readers, by their own source
  const src = (f) => readFileSync(new URL(`./xpizza-functions/${f}`, import.meta.url), 'utf8');
  const reqs = (f) => [...src(f).matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const RTDB_COPIES = /mirror-rtdb|snapshot-fallback|pricing-tables|catalog\/catalog'|\.\/catalog$|mirror-keys|last-good/;
  for (const f of ['catalog/public-menu.js', 'catalog/catalog-menu.js', 'catalog/generate-form-bundle.js', 'catalog/form-rebake.js']) {
    const bad = reqs(f).filter((r) => RTDB_COPIES.test(r) || r === './catalog');
    assert.deepStrictEqual(bad, [], `(e) ${f} requires no RTDB copy reader`);
  }
  assert.ok(/getRestaurantMenu\(db, restaurantId\)/.test(src('catalog/public-menu.js')), '(e) buildPublicMenu reads the catalog through getRestaurantMenu');
  assert.ok(/const versionId = await coded\('active_version_unreadable', \(\) => getActiveVersionId\(db, restaurantId\)\);[\s\S]{0,900}return readVersionMenu\(db, restaurantId, versionId\);/.test(src('catalog/catalog-menu.js')), '(e) getRestaurantMenu = the Firestore pointer + the Firestore version, no fallback');
  assert.ok(/buildPublicMenu/.test(src('catalog/form-rebake.js')), '(e) the form rebake reads the menu through buildPublicMenu (the endpoint\'s own path)');
  ok('(e) the endpoint and the form rebake read the Firestore pointer + version only — no snapshot, mirror or last-good copy feeds the served menu');

  clearTimeout(WATCHDOG);
  console.log('s3-served: OK');
})().catch((e) => { console.error('s3-served FAILED:', e && e.message); process.exit(1); });
