'use strict';
// S1c D3 (owner 2026-11-09) — AT THE ACTIVATION, with item_text_edit ON, a RENAME may not take another item's reserved key (the
// last line of defence: a key reserved between the save and the flip, and a rollback to a version whose name a later key now
// reserves). 409 reserved_key_conflict; the pointer does not move. Additions are never judged. Switch OFF: nothing is judged and
// the active version is not even read. Run: npm run test:reserved-keys-rename-flip
require('./_emulator-required').harness(['firestore', 'database']);
const SWITCH = { enabled: false };
require.cache[require.resolve('../catalog/item-text-edit')] = { id: require.resolve('../catalog/item-text-edit'), filename: require.resolve('../catalog/item-text-edit'), loaded: true,
  exports: { textEditCapabilities: () => ({ enabled: SWITCH.enabled }) } };
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');
const fs = admin.firestore();
const rtdb = admin.database();
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getActivePointer } = require('../catalog/catalog-firestore');
const RK = require('../catalog/reserved-keys');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('reserved-keys-rename-flip(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'tb_merch_rk';
const KEY = 'Dish One';
const source = (dish1Name, frozen, extraDish) => ({ restaurant_id: RID, schema_version: 2, key_mode: 'name', ...(frozen ? { frozen_keys: frozen } : {}),
  items: [{ key: KEY, price: 100, display: { id: 2, name: dish1Name, cat: 'c1', price: 100 } },
    { key: 'Dish Two', price: 80, display: { id: 1, name: 'Dish Two', cat: 'c1', price: 80 } },
    ...(extraDish ? [{ key: extraDish, price: 90, display: { id: 3, name: extraDish, cat: 'c1', price: 90 } }] : [])],
  extras: [{ key: 'Extra X', price: 15, display: { id: 'e1', name: 'Extra X', cat: 'Adicionales', price: 15 } }],
  structure: { schema_version: 1, categories: [{ id: 'c1', name: 'Cat One' }], item_order: [KEY, 'Dish Two', ...(extraDish ? [extraDish] : [])], extra_categories: ['Adicionales'],
    exposure: { category_allow: { c1: ['Adicionales'] }, item_overrides: {} }, extras_by_category: { c1: ['Adicionales'] }, pickup_only_cats: [], weekend_only_cats: [] } });
const inputOf = (src, sha) => { const { inputs, built } = buildSourceCandidate(RID, src); return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, key_mode: built.key_mode, ...(built.frozen_keys ? { frozen_keys: built.frozen_keys } : {}) }; };
const MAP = { 2: KEY };
const reserve = async (keys) => { const ref = RK.reservedRefOf(fs, RID); const cur = (await ref.get()).data(); await ref.set(RK.unionReserved(cur, { dish: keys, extra: [] }, 'test').doc); };

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const mirror = () => makeRtdbMirror(rtdb);
  const pub = (src, sha, active) => publishVersion(fs, RID, inputOf(src, sha), { expected: { activeVersionId: active }, mirror: mirror() });

  const v1 = await pub(source('Dish One'), 'rk-v1', null);
  await reserve(['Plato Movido']);   // a key that once existed (its item since moved away)

  // switch ON: a rename onto the reserved key is refused at the flip; the pointer does not move
  SWITCH.enabled = true;
  await assert.rejects(pub(source('  plato MOVIDO', MAP), 'rk-bad', v1.versionId), /reserved_key_conflict/, 'RKRF-PUBLISH a rename onto a reserved key (folded) is refused at the activation');
  assert.strictEqual((await getActivePointer(fs, RID)).version, v1.versionId, 'RKRF-PUBLISH the pointer did not move');
  // an ADDITION named like the reserved key is not judged (owner): it activates
  const v2 = await pub(source('Dish One', null, 'Plato Movido'), 'rk-add', v1.versionId);
  assert.strictEqual((await getActivePointer(fs, RID)).version, v2.versionId, 'RKRF-ADDITION an addition named like a reserved key activates');
  // a free rename activates
  const v3 = await pub(source('Dish One Nuevo', MAP), 'rk-free', v2.versionId);
  assert.strictEqual((await getActivePointer(fs, RID)).version, v3.versionId, 'RKRF-FREE a rename onto an unreserved name activates');
  ok('switch ON: a rename onto a reserved key is refused at the activation; an addition and a free rename activate');

  // a rollback to a version whose renamed name a LATER key now reserves is refused
  await reserve(['Dish One Nuevo Dos']);
  const v4 = await pub(source('Dish One Nuevo Dos', MAP), 'rk-v4-ok-before-reserve', v3.versionId).catch((e) => e);
  assert.ok(v4 instanceof Error && /reserved_key_conflict/.test(v4.message), 'premise: that name is now reserved');
  SWITCH.enabled = false;
  const v5 = await pub(source('Dish One Nuevo Dos', MAP), 'rk-v5-off', v3.versionId);
  assert.strictEqual((await getActivePointer(fs, RID)).version, v5.versionId, 'RKRF-OFF switch OFF: nothing is judged at the activation (today)');
  const v6 = await pub(source('Dish One Nuevo', MAP), 'rk-v6', v5.versionId);
  SWITCH.enabled = true;
  await assert.rejects(rollbackVersion(fs, RID, v5.versionId, { mirror: mirror(), expected: { activeVersionId: v6.versionId } }), /reserved_key_conflict/, 'RKRF-ROLLBACK a rollback onto a reserved name is refused');
  assert.strictEqual((await getActivePointer(fs, RID)).version, v6.versionId, 'RKRF-ROLLBACK the pointer did not move');
  ok('a rollback whose renamed name is now reserved is refused (switch ON); switch OFF judges nothing');

  FINISHED = true;
  console.log(`\nreserved-keys-rename-flip(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
