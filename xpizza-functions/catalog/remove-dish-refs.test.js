'use strict';
// «Quitar del menú» (owner-approved; NOTE-remove-product-server §2c, advisor 11-12) — a dish named EXPLICITLY in exposure.item_overrides[key]
// or structure.redeem_eligible_items, removed through the REAL editCatalogCore with its declared deletion claim (D4-P1): its own entries leave
// WITH the removal, and nothing else may change. Real seed data: X Pizza «Nutella» (an override), La Musa «rice_03» (an override) and
// «soft_01» (an item-level reward entry). Codex r1 P2-1 (advisor RULED): removing the LAST extras_by_item entry publishes and SERVES
// `extras_by_item: {}` (an explicit clear, as variant_items) whenever the ACTIVE version has the map — the forms' liveMenuPrepare keeps the
// map in force when it is ABSENT, so an omitted map would leave `{ rice_03: [...] }` in an open La Musa form. Real save → real publish
// handler → real publishVersion → buildPublicMenu → the form's OWN liveMenuPrepare (lifted from la-musa-orders/index.html).
// Run: node catalog/remove-dish-refs.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
// these cells judge the removal path ON (P-R5 platform-removal.js; OFF = today's refusals, pinned by remove-product-server.test.js)
{ const p = require.resolve('./platform-removal'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { removalCapabilities: () => ({ productRemoval: true }) } }; }
const { editCatalogCore } = require('./edit-catalog-handler');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { publishEditedCore } = require('./publish-edited-handler');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublicMenu } = require('./public-menu');
const fs = require('fs'); const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('remove-dish-refs: FAILED — exited without completing'); process.exitCode = 1; } });
const T0 = '2026-10-24T10:00:00.000000Z'; const T1 = '2026-10-24T11:00:00.000000Z'; const ACTIVE = 'v-active-1';
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
const clone = (x) => JSON.parse(JSON.stringify(x));
// certified rows (identity stamps) in the live AND the stored draft, so a removal can be declared
const base = (rid) => { const s = clone(buildSourceFromCode(rid)); for (const it of s.items) it.display.identity_id = `id_${String(it.key).replace(/[^A-Za-z0-9]/g, '_')}`; return s; };
const builtOf = (src, rid) => { const i = sourceToBuildInputs(src); return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const liveRead = (rid, shape = (b) => b) => async () => { const src = base(rid); const i = sourceToBuildInputs(src); return { built: shape(builtOf(src, rid)), versionId: ACTIVE, generation: 0, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras }; };
function saveDb(rid) {
  const state = { source: { data: base(rid), updateTime: T0 } };
  const doc = (path) => ({
    get: async () => {
      if (path === `restaurants/${rid}/meta/source`) { const frozen = clone(state.source.data); return { exists: true, data: () => frozen, updateTime: state.source.updateTime }; }
      if (path === `restaurants/${rid}/meta/active_version`) return { exists: true, data: () => ({ version: ACTIVE, generation: 0 }) };
      return { exists: false, data: () => ({}) };
    },
    set: async (data) => { state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== state.source.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } state.source = { data, updateTime: T1 }; return { writeTime: T1 }; },
  });
  return { state, collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
}
const save = (rid, source, ids) => { const db = saveDb(rid); return editCatalogCore({ db, authorize: owner, readActiveBuilt: liveRead(rid) }, { restaurantId: rid, source: { ...source, deleted_ids: { ids } }, baseSourceUpdateTime: T0, deleted_ids_loaded_base: { version: ACTIVE, generation: 0 } }, {}).then((r) => ({ r, db })); };
const show = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
// the draft the portal writes for a removal: the dish leaves the items and item_order, and ITS OWN explicit entries go with it
function removed(src, key) {
  const s = clone(src);
  s.items = s.items.filter((i) => i.key !== key);
  s.structure.item_order = s.structure.item_order.filter((k) => k !== key);
  const ov = s.structure.exposure && s.structure.exposure.item_overrides; if (ov && ov[key]) delete ov[key];   // the map itself stays (the schema requires it)
  if (s.structure.extras_by_item && s.structure.extras_by_item[key]) delete s.structure.extras_by_item[key];   // its derived per-dish exposure map entry
  if (Array.isArray(s.structure.redeem_eligible_items)) s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== key);
  return s;
}
const stamp = (rid, key) => base(rid).items.find((i) => i.key === key).display.identity_id;

// the form's OWN liveMenuPrepare lifted from the shipped page: each missing global is the form's own declaration when it has one, else
// the IN-FORCE value given (or an empty fallback) — the identity-public-contract.test.js lift
function formPrepare(rid, inForce) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', rid === 'la_musa' ? 'la-musa-orders' : 'xpizza-orders', 'index.html'), 'utf8');
  const declOf = (name) => { const i = html.indexOf(`function ${name}(`); if (i < 0) return null; let d = 0; let j = html.indexOf('{', i); for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return html.slice(i, j + 1); };
  const src = declOf('liveMenuPrepare'); assert.ok(src, 'premise: the form defines liveMenuPrepare');
  const mods = {}; for (const m of html.matchAll(/<script src="(form-[\w-]+\.js)"><\/script>/g)) { const f = path.join(__dirname, '..', '..', rid === 'la_musa' ? 'la-musa-orders' : 'xpizza-orders', m[1]); if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8'); for (const g of t.matchAll(/\bwindow\.(\w+)\s*=/g)) mods[g[1]] = f; } }
  const extras = []; const stubs = new Map(Object.entries(inForce));
  const probe = { dishes: [{}], extras: [], categories: [{}] };
  for (let a = 0; a < 24; a++) {
    const names = [...stubs.keys()];
    try { const fn = new Function(...names, `${extras.join('\n')}\n${src}\n; return liveMenuPrepare;`)(...names.map((k) => stubs.get(k))); try { fn(probe); } catch (e) { if (/is not defined$/.test(e.message)) throw e; } return fn; }
    catch (e) {
      const m = /^(\w[\w$]*) is not defined$/.exec(e.message); assert.ok(m, `premise: lifting liveMenuPrepare failed: ${e.message}`);
      const d = declOf(m[1]);
      if (d) extras.push(d); else if (mods[m[1]]) { const mod = require(mods[m[1]]); stubs.set(m[1], mod && mod[m[1]] !== undefined ? mod[m[1]] : mod); } else stubs.set(m[1], /_CATS$/.test(m[1]) ? [] : {});
    }
  }
  assert.fail('premise: could not lift liveMenuPrepare');
}

(async () => {
  for (const [rid, key, what] of [['x_pizza', 'Nutella', 'an item override'], ['la_musa', 'rice_03', 'an item override'], ['la_musa', 'soft_01', 'an item-level reward entry']]) {
    const { r, db } = await save(rid, removed(base(rid), key), [stamp(rid, key)]);
    assert.strictEqual(r.status, 200, `RDR-${key}: a declared removal of a dish with ${what} saves (${show(r)})`);
    const saved = db.state.source.data;
    assert.ok(!saved.items.some((i) => i.key === key), `RDR-${key}: the dish left the draft`);
    assert.ok(!((saved.structure.exposure || {}).item_overrides || {})[key] && !(saved.structure.redeem_eligible_items || []).includes(key), `RDR-${key}: its own entries left with it`);
    assert.ok(!(saved.structure.extras_by_item || {})[key], `RDR-${key}: its extras_by_item entry left with it`);
    ok(`${rid}: removing «${key}» (${what}) with its declared claim saves; its own entries leave with it`);
  }
  {   // nothing ELSE may change: dropping ANOTHER dish's override / reward entry beside the removal is still refused
    const s = removed(base('la_musa'), 'soft_01'); s.structure.redeem_eligible_items = s.structure.redeem_eligible_items.filter((k) => k !== 'soft_02');
    const { r } = await save('la_musa', s, [stamp('la_musa', 'soft_01')]);
    assert.ok(r.status >= 400 && r.body.error === 'structure_changed', `RDR-OTHER: another dish's entry cannot leave with a removal (${show(r)})`);
    const t = removed(base('la_musa'), 'soft_01'); delete t.structure.exposure.item_overrides.rice_03;
    const { r: r2 } = await save('la_musa', t, [stamp('la_musa', 'soft_01')]);
    assert.ok(r2.status >= 400 && r2.body.error === 'structure_changed', `RDR-OTHER: another dish's override cannot leave with a removal (${show(r2)})`);
    ok('nothing else may change: another dish\'s override or reward entry leaving beside a removal is still structure_changed');
  }
  {   // an UNDECLARED removal keeps today's refusal
    const { r } = await save('x_pizza', removed(base('x_pizza'), 'Nutella'), []);
    assert.deepStrictEqual([r.status, r.body.error], [400, 'existing_item_removed'], `RDR-UNDECLARED: ${show(r)}`);
    ok('an undeclared removal is today\'s existing_item_removed');
  }
  {   // P2-1: the LAST extras_by_item entry leaves → the published + served map is {} (an explicit clear), and the open form clears it
    const rid = 'la_musa'; const key = 'rice_03';
    assert.deepStrictEqual(Object.keys(builtOf(base(rid), rid).structure.extras_by_item || {}), [key], 'premise: rice_03 is the map\'s only entry');
    const { r, db } = await save(rid, removed(base(rid), key), [stamp(rid, key)]);
    assert.strictEqual(r.status, 200, `RDR-CLEAR save: ${show(r)}`);
    const publishes = [];
    const pub = await publishEditedCore({ db, authorize: owner, readActiveBuilt: liveRead(rid), readDraft: async () => ({ source: db.state.source.data, updateTime: T1 }),
      publishVersion: async (_db, rr, input, opts) => { publishes.push({ input, opts }); return { versionId: 'v-new-2', item_count: input.items.length, extra_count: Object.keys(input.extras).length }; } },
      { restaurantId: rid, token: r.body.token }, {});
    assert.strictEqual(pub.status, 200, `RDR-CLEAR publish: ${show(pub)}`);
    assert.deepStrictEqual(publishes[0].input.structure.extras_by_item, {}, 'RDR-CLEAR: the published version carries extras_by_item: {} (an explicit clear)');
    const sdb = makeDb(); const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
    const fresh = clone(publishes[0].input); for (const it of fresh.items) delete it.display.identity_id;   // a fresh store certifies nothing: the stamps are the harness's
    await quiet(() => publishVersion(sdb, rid, fresh, { expected: { activeVersionId: null } }));
    const body = (await quiet(() => buildPublicMenu(sdb, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true }))).body;
    assert.deepStrictEqual(body.extras_by_item, {}, 'RDR-CLEAR: the served body carries extras_by_item: {}');
    // the form's OWN liveMenuPrepare, with the map it held before the removal in force
    const prepared = formPrepare(rid, { EXTRAS_BY_ITEM: { [key]: ['Proteínas'] } })(body);
    assert.deepStrictEqual(prepared.EXTRAS_BY_ITEM, {}, `RDR-CLEAR: the open form drops the removed dish's map (got ${JSON.stringify(prepared.EXTRAS_BY_ITEM)})`);
    ok('the last extras_by_item entry leaving publishes and serves extras_by_item: {}, and the open La Musa form clears it');
  }
  {   // the cleared map stays {} — a later unrelated edit over an active {} is not structure_changed
    const rid = 'la_musa'; const src = removed(base(rid), 'rice_03');
    const db = saveDb(rid); db.state.source.data = clone(src);
    const ed = clone(src); ed.items.find((i) => i.key === 'noodle_02').display.desc = 'Otra';
    const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt: async () => { const i = sourceToBuildInputs(src); const b = builtOf(src, rid); b.structure.extras_by_item = {}; return { built: b, versionId: ACTIVE, generation: 0, extraRecords: buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }).extras }; } },
      { restaurantId: rid, source: ed, baseSourceUpdateTime: T0 }, {});
    assert.strictEqual(r.status, 200, `RDR-CLEAR-NEXT: an edit over an active {} saves (${show(r)})`);
    ok('an edit over a version whose extras_by_item is {} saves (the clear is sticky, never structure_changed)');
  }
  FINISHED = true;
  console.log(`remove-dish-refs: OK (${n})`);
})().catch((e) => { console.error('remove-dish-refs FAILED:', e && e.message); process.exit(1); });
