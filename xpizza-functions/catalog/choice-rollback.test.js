'use strict';
// S3 (PLAN-structure-S3-r3 §1c) — rollback is an activation like any publish: with choiceEdit ON, the REAL rollbackVersion judges the
// version it would restore (target) against the version its flip REPLACES (expected.activeVersionId — the pointer the CAS binds), with
// the same classifier (choice-activation). Real publishes into the Firestore fake; the versions built from the REAL sources and the
// REAL writer. Codex r2 P1-1: La Musa Pad Thai → D3 published (the dish is a plain, redeemable dish) → rollback to the version where
// it had its required choice → refused, the pointer unchanged. OFF: today's rollback.
// Run: node catalog/choice-rollback.test.js
const assert = require('assert');
const STRUCT = { choiceEdit: false };
{ const p = require.resolve('./platform-structure'); require.cache[p] = { id: p, filename: p, loaded: true, exports: { structureCapabilities: () => ({ extrasCatalog: false, choiceEdit: STRUCT.choiceEdit, sections: false }) } }; }
const { makeDb } = require('./firestore-fake');
const { publishVersion, rollbackVersion } = require('./catalog-publish');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const CT = require('./choice-transitions');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('choice-rollback: FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'la_musa';
const PAD = 'noodle_01';
const inputOf = (src, sha) => {
  const i = sourceToBuildInputs(src);
  const b = buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable });
  return { items: b.items, structure: b.structure, extras: i.extras, extraRecords: b.extras, key_mode: src.key_mode, source_sha: sha };
};
const pointerOf = async (db) => { const s = await db.collection('restaurants').doc(RID).collection('meta').doc('active_version').get(); return s.exists ? (s.data() || {}).version || null : null; };

(async () => {
  const LM = buildSourceFromCode(RID);
  const opts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
  const D3 = CT.apply(LM, { op: 'choice.remove', launcher: PAD, price_from: opts[1] }).source;
  const setup = async () => {
    const db = makeDb();
    const v1 = (await publishVersion(db, RID, inputOf(LM, 's3rb1'), { expected: { activeVersionId: null } })).versionId;
    const v2 = (await publishVersion(db, RID, inputOf(D3, 's3rb2'), { expected: { activeVersionId: v1 } })).versionId;
    return { db, v1, v2 };
  };

  {   // OFF: today's rollback
    const { db, v1, v2 } = await setup();
    await rollbackVersion(db, RID, v1, { expected: { activeVersionId: v2 } });
    assert.strictEqual(await pointerOf(db), v1, 'S3RB-OFF: the rollback flips');
    ok('OFF: a rollback across a removed choice is today\'s rollback');
  }
  STRUCT.choiceEdit = true;
  {   // ON: the rollback would give a now-redeemable dish its required choice back
    const { db, v1, v2 } = await setup();
    await assert.rejects(() => rollbackVersion(db, RID, v1, { expected: { activeVersionId: v2 } }), (e) => e && e.code === 'choice_on_reward_dish' && e.key === PAD, 'S3RB-ON: refused');
    assert.strictEqual(await pointerOf(db), v2, 'S3RB-ON: the pointer did not move');
    ok('ON: rolling back to the version where the reward dish had a required choice is choice_on_reward_dish; the pointer stays');
  }
  {   // ON: the reverse direction (rollback that REMOVES a group) is judged like a D3 publish — allowed
    const db = makeDb();
    const v1 = (await publishVersion(db, RID, inputOf(D3, 's3rb3'), { expected: { activeVersionId: null } })).versionId;
    const v2 = (await publishVersion(db, RID, inputOf(LM, 's3rb4'), { expected: { activeVersionId: v1 } })).versionId;
    await rollbackVersion(db, RID, v1, { expected: { activeVersionId: v2 } });
    assert.strictEqual(await pointerOf(db), v1);
    ok('ON: a rollback that removes a group (the dish keeps an option\'s price) is allowed');
  }
  {   // ON: the baseline is the version the flip REPLACES (expected.activeVersionId) — a stale expectation still fails the CAS
    const { db, v1, v2 } = await setup();
    await assert.rejects(() => rollbackVersion(db, RID, v2, { expected: { activeVersionId: v1 } }), (e) => e && e.code !== 'choice_on_reward_dish', 'S3RB-CAS: a stale expectation is the CAS refusal, never an activation judged against the wrong baseline');
    assert.strictEqual(await pointerOf(db), v2);
    ok('ON: the judgment is bound to expected.activeVersionId; a stale expectation fails the flip CAS');
  }
  // ── Codex build r1 P1-1: publishVersion ITSELF (every publishing path, tools included) is an activation — the check sits at the flip
  {
    for (const [rid, src, key] of [['x_pizza', buildSourceFromCode('x_pizza'), 'Carnivora'], ['la_musa', buildSourceFromCode('la_musa'), 'dimsum_01']]) {
      const AP = require('./add-product'); const CC = require('./choice-compare');
      const conv = AP.allocateAdditions({ incoming: CT.apply(src, { op: 'choice.add', key, label: 'Tamaño', options: [{ ref: 'tmp:pv-a-xxxxxxx', choice: 'Chica' }, { ref: 'tmp:pv-b-xxxxxxx', choice: 'Grande', price: 999 }] }).source,
        stored: src, activeItems: src.items, keyMode: src.key_mode === 'id' ? 'id' : 'name', hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source;
      const inp = (s, sha) => { const i = sourceToBuildInputs(s); const b = buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }); return { items: b.items, structure: b.structure, extras: i.extras, extraRecords: b.extras, key_mode: s.key_mode, source_sha: sha }; };
      const db = makeDb(); const p0 = async () => { const x = await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get(); return x.exists ? x.data().version : null; };
      const v1 = (await publishVersion(db, rid, inp(src, 'pv1'), { expected: { activeVersionId: null } })).versionId;
      await assert.rejects(() => publishVersion(db, rid, inp(conv, 'pv2'), { expected: { activeVersionId: v1 } }), (e) => e && e.code === 'choice_on_reward_dish' && e.key === key, `S3PV-PUBLISH ${rid}: refused at the flip`);
      assert.strictEqual(await p0(), v1, `S3PV-PUBLISH ${rid}: the pointer did not move`);
    }
    ok('ON: publishVersion itself refuses a reward dish gaining a group (both brands) — every publishing path, by construction');
  }
  // ── Codex build r1 P1-2 (ruled: refuse): an activation never installs a version WITHOUT variant_items over one that HAS it
  {
    const XP = buildSourceFromCode('x_pizza');
    const nonReward = XP.structure.categories.map((c) => c.id).find((c) => !(XP.structure.redeem_eligible_cats || []).includes(c) && XP.items.some((i) => i.display.cat === c));
    const plain = XP.items.find((i) => i.display.cat === nonReward && i.display.variantOf == null).key;
    const AP = require('./add-product'); const CC = require('./choice-compare');
    const grouped = AP.allocateAdditions({ incoming: CT.apply(XP, { op: 'choice.add', key: plain, label: 'Tamaño', options: [{ ref: 'tmp:fg-a-xxxxxxx', choice: 'Chica' }, { ref: 'tmp:fg-b-xxxxxxx', choice: 'Grande', price: 999 }] }).source,
      stored: XP, activeItems: XP.items, keyMode: 'name', hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source;
    const inp = (s, sha) => { const i = sourceToBuildInputs(s); const b = buildCatalogV2('x_pizza', { formData: i.formData, priceTable: i.priceTable }); return { items: b.items, structure: b.structure, extras: i.extras, extraRecords: b.extras, key_mode: s.key_mode, source_sha: sha }; };
    assert.ok(!('variant_items' in XP.structure), 'premise: the original X Pizza has no variant_items');
    const db = makeDb();
    const v1 = (await publishVersion(db, 'x_pizza', inp(XP, 'fg1'), { expected: { activeVersionId: null } })).versionId;
    const v2 = (await publishVersion(db, 'x_pizza', inp(grouped, 'fg2'), { expected: { activeVersionId: v1 } })).versionId;
    await assert.rejects(() => rollbackVersion(db, 'x_pizza', v1, { expected: { activeVersionId: v2 } }), (e) => e && e.code === 'choice_groups_would_vanish', 'S3RB-SHAPE: the rollback to the pre-group version is refused');
    const ptr = await db.collection('restaurants').doc('x_pizza').collection('meta').doc('active_version').get();
    assert.strictEqual(ptr.data().version, v2, 'S3RB-SHAPE: the pointer stays');
    await assert.rejects(() => publishVersion(db, 'x_pizza', inp(XP, 'fg3'), { expected: { activeVersionId: v2 } }), (e) => e && e.code === 'choice_groups_would_vanish', 'S3RB-SHAPE: a publish of a field-less version over a grouped one is refused too');
    ok('ON: original → first group → rollback to the original (and a publish of it) is choice_groups_would_vanish; the pointer stays');
  }
  STRUCT.choiceEdit = false;
  FINISHED = true;
  console.log(`choice-rollback: OK (${n})`);
})().catch((e) => { console.error('choice-rollback FAILED:', e && e.message); process.exit(1); });
