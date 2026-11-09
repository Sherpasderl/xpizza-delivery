'use strict';
// S1c (PLAN-portal-item-edit r6 §2.2; design D4c-grill/item-s1/S1c-DESIGN.md D1/D2) — EVERY ACTIVATION RESERVES ITS KEYS.
// The activation transaction (publish AND rollback, certified AND uncertified) reads restaurants/{rid}/meta/reserved_keys
// before any write and adds every item and extra key of the version it activates. Nothing ever leaves the set: a key removed
// by a later version, or by a rollback, stays reserved. A malformed stored set refuses the activation (nothing moves), and so
// does a set past the doc limit. Run: npm run test:reserved-keys-flip
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');
const db = admin.firestore();
const rtdb = admin.database();
const { fixture } = require('./_c2b-fixture');
const { sourceRefOf } = require('../catalog/source-store');
const { getActivePointer } = require('../catalog/catalog-firestore');
const RK = require('../catalog/reserved-keys');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('reserved-keys-flip(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const F = fixture({ db, rtdb, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const reservedRef = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('reserved_keys');
const reserved = async (rid) => RK.reservedKeySet((await reservedRef(rid).get()).data());
const certifiedOf = async (rid, v) => ((await db.collection('restaurants').doc(rid).collection('versions').doc(v).get()).data() || {}).identity_certified === true;
const keysOf = async (rid) => ((await sourceRefOf(db, rid).get()).data().items || []).map((i) => i.key);
const dropDish = async (rid, key) => {
  const src = (await sourceRefOf(db, rid).get()).data();
  await sourceRefOf(db, rid).update({ items: src.items.filter((i) => i.key !== key), structure: { ...src.structure, item_order: src.structure.item_order.filter((k) => k !== key) } });
};

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();

  for (const certify of [false, true]) {
    const rid = certify ? 'tb_rk_cert' : 'tb_rk_plain';
    const tag = certify ? 'CERT' : 'PLAIN';
    const v1 = await F.merchant(rid, { dishes: 3, certify });
    // the merchant helper publishes before it certifies; re-publish so the version activated below carries the stamps
    const v1b = certify ? await F.publish(rid, `${rid}-v1b`) : v1;
    assert.strictEqual(await certifiedOf(rid, v1b), certify, `premise ${tag}: the version is ${certify ? '' : 'un'}certified`);
    const k1 = await keysOf(rid);
    const r1 = await reserved(rid);
    for (const k of k1) assert.deepStrictEqual(r1.get(k), ['dish'], `RKF-PUBLISH-${tag} ${k} is reserved by the publish`);

    // v2: one dish removed, one added — the removed key stays, the added one joins
    const gone = k1[0];
    await dropDish(rid, gone); await F.addDish(rid, 'Plato Nuevo');
    const v2 = await F.publish(rid, `${rid}-v2`);
    const r2 = await reserved(rid);
    assert.ok(r2.has(gone), `RKF-ADDONLY-${tag} a key the new version dropped stays reserved`);
    assert.ok(r2.has('Plato Nuevo'), `RKF-PUBLISH-${tag} the added key is reserved`);

    // rollback: the set is written by the rollback too (deleted first, as for a restaurant whose history predates S1c)
    await reservedRef(rid).delete();
    await F.rollback(rid, v1b);
    assert.strictEqual((await getActivePointer(db, rid)).version, v1b, 'premise: rolled back');
    const r3 = await reserved(rid);
    for (const k of k1) assert.ok(r3.has(k), `RKF-ROLLBACK-${tag} ${k} is reserved by the rollback's activation`);
    assert.ok(!r3.has('Plato Nuevo'), `RKF-ROLLBACK-${tag} only the activated version's keys are added (the set was wiped above)`);
    // and forward again: nothing the rollback reserved is lost
    await F.rollback(rid, v2);
    const r4 = await reserved(rid);
    for (const k of [...k1, 'Plato Nuevo']) assert.ok(r4.has(k), `RKF-ADDONLY-${tag} ${k} survives the round trip`);
    ok(`${tag}: publish and rollback each reserve every key of the version they activate; nothing is ever removed`);
  }

  // a malformed stored set refuses the activation — nothing moves
  {
    const rid = 'tb_rk_cert';
    const before = await getActivePointer(db, rid);
    await reservedRef(rid).set({ v: 1, keys: { '***': { dish: 'x' } } });
    await F.addDish(rid, 'Plato Malformado');
    let err = null; try { await F.publish(rid, `${rid}-bad`); } catch (e) { err = e; }
    assert.ok(err && /reserved_keys_malformed/.test(String(err.message)), 'RKF-MALFORMED a malformed set refuses the publish');
    assert.deepStrictEqual(await getActivePointer(db, rid), before, 'RKF-MALFORMED the pointer did not move');
    ok('a malformed stored set refuses the activation; the pointer does not move');
  }

  FINISHED = true;
  console.log(`\nreserved-keys-flip(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
