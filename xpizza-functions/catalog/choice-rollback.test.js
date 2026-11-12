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
  STRUCT.choiceEdit = false;
  FINISHED = true;
  console.log(`choice-rollback: OK (${n})`);
})().catch((e) => { console.error('choice-rollback FAILED:', e && e.message); process.exit(1); });
