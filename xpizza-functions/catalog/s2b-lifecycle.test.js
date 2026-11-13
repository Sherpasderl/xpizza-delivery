'use strict';
// S2b (PLAN-structure-S2b-r3 §3; Codex r2 P1-4) — frozen_extra_keys travels with the VERSION: the REAL publisher writes it on the version
// record, the ONE version reader returns it, the pre-publish and pre-flip candidate checks validate the minted / renamed extras under their
// kept keys, and a rollback to such a version (and away from it) flips. Both key modes, the Firestore fake. Run: node catalog/s2b-lifecycle.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { publishVersion, rollbackVersion } = require('./catalog-publish');
const { readVersionMenu } = require('./catalog-menu');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2b-lifecycle: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (o) => JSON.parse(JSON.stringify(o));
const quiet = async (f) => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
// a source with TWO recorded extras at different prices: one renamed (its key kept), one retired-and-reused under a minted key
function recorded(rid) {
  const s = clone(buildSourceFromCode(rid));
  const r = s.extras[0]; r.display.name = 'Renombrado S2b';
  const m = s.extras[1]; const oldKey = m.key; const mk = 'i_aaaaaaaaaabz';
  if (rid === 'la_musa') { m.display.id = mk; }
  for (const f of ['extra_order']) if (Array.isArray(s.structure[f])) s.structure[f] = s.structure[f].map((k) => (k === oldKey ? mk : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(oldKey); if (i >= 0) v[i] = mk; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === oldKey ? mk : k));
  m.key = mk; m.price += 3; m.display.price = m.price;
  s.frozen_extra_keys = { [r.key]: { display_id: String(r.display.id), field: 'name' }, [mk]: { display_id: String(m.display.id), minted: true, reuses: oldKey } };
  return { s, renamedKey: r.key, mintedKey: mk, mintedPrice: m.price };
}
const inputOf = (rid, src, sha) => { const { inputs, built } = buildSourceCandidate(rid, src);
  return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) }; };

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const { s, renamedKey, mintedKey, mintedPrice } = recorded(rid);
    const db = makeDb();
    const v1 = (await quiet(() => publishVersion(db, rid, inputOf(rid, buildSourceFromCode(rid), 'l1'), { expected: { activeVersionId: null } }))).versionId;
    let v2;
    try { v2 = (await quiet(() => publishVersion(db, rid, inputOf(rid, s, 'l2'), { expected: { activeVersionId: v1 } }))).versionId; } catch (e) { assert.fail(`S2BL-PUBLISH ${rid}: the version with recorded extras publishes (${String(e.message).slice(0, 160)})`); }
    const rec = (await db.collection('restaurants').doc(rid).collection('versions').doc(v2).get()).data();
    assert.deepStrictEqual(rec.frozen_extra_keys, s.frozen_extra_keys, `S2BL-RECORD ${rid}: the version record carries the map`);
    const served = await readVersionMenu(db, rid, v2);
    assert.deepStrictEqual(served.frozenExtraKeys, s.frozen_extra_keys, `S2BL-READ ${rid}: the version reader returns it`);
    assert.ok(served.extras.some((e) => e.key === renamedKey && e.display.name === 'Renombrado S2b'), `S2BL-READ ${rid}: the renamed extra under its kept key`);
    assert.ok(served.extras.some((e) => e.key === mintedKey && e.price === mintedPrice), `S2BL-READ ${rid}: the minted extra at its own price`);
    await quiet(() => rollbackVersion(db, rid, v1, { expected: { activeVersionId: v2 } }));
    try { await quiet(() => rollbackVersion(db, rid, v2, { expected: { activeVersionId: v1 } })); } catch (e) { assert.fail(`S2BL-ROLLBACK ${rid}: a rollback TO the recorded version flips (pre-flip check) (${String(e.message).slice(0, 160)})`); }
    // RESET takes the ACTIVE version's map (the draft goes back to live; an unpublished draft-only entry goes with it)
    {
      const { resetDraftToLiveCore } = require('./reset-draft'); const { previewVersion } = require('./catalog-publish');
      const { sourceRefOf, encodeUpdateTime } = require('./source-store');
      const ref = sourceRefOf(db, rid); const draft = clone(s); draft.frozen_extra_keys = { ...draft.frozen_extra_keys, draft_only: { display_id: 'zz', field: 'name' } };
      await ref.set(draft); const snap = await ref.get();
      const r = await quiet(() => resetDraftToLiveCore({ db, authorize: async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' }), readActiveVersionId: async () => v2, previewVersion, toPrecondition: () => snap.updateTime },
        { restaurantId: rid, expectedRevision: encodeUpdateTime(snap.updateTime) }, {}));
      assert.strictEqual(r.status, 200, `S2BL-RESET ${rid}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.deepStrictEqual((await ref.get()).data().frozen_extra_keys, s.frozen_extra_keys, `S2BL-RESET ${rid}: the draft takes the active version's map`);
    }
    ok(`${rid}: published with its recorded extras (record + reader + pre-publish), rolled back away and back (pre-flip), reset takes the active map`);
  }
  FINISHED = true;
  console.log(`s2b-lifecycle: OK (${n})`);
})().catch((e) => { console.error('s2b-lifecycle FAILED:', e && e.message); process.exit(1); });
