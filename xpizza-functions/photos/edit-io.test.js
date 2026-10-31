'use strict';
// DISH PHOTOS A2 step 8 — photos/edit-io.js, the editCatalog photos dependency over Firestore + the uploads flag:
//   readActive(rid, vid)  versions/{vid}/meta/photos → its entries; absent → null; a malformed doc → THROWS (fail closed)
//   attach(rid, pids)     ONE transaction: every pid's registry doc must exist in draft|published, then last_ref_at = now
//   enabled()             the PHOTOS_UPLOADS flag (photos/flag.js)
// Run: node photos/edit-io.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const { makePhotoEditIo } = require('./edit-io');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', T = Date.UTC(2026, 9, 31, 12);
const P1 = '1'.repeat(32), P2 = '2'.repeat(32), P3 = '3'.repeat(32);

(async () => {
  const fs = makeDb();
  const io = makePhotoEditIo({ fs, enabled: async () => true, now: () => T });
  const metaRef = (vid) => fs.collection('restaurants').doc(RID).collection('versions').doc(vid).collection('meta').doc('photos');
  const regRef = (pid) => fs.collection('photo_registry').doc(RID).collection('pids').doc(pid);

  // ── readActive ──
  assert.strictEqual(await io.readActive(RID, 'v1'), null, 'EDIT-IO-ACTIVE-ABSENT-NULL');
  const entries = { tb_k: { state: 'pid', pid: P1, card: 'c', hero: 'h' }, tb_j: { state: 'removed' } };
  await metaRef('v2').set({ schema: 1, entries });
  assert.deepStrictEqual(await io.readActive(RID, 'v2'), entries, 'EDIT-IO-ACTIVE-ENTRIES');
  for (const [label, doc] of [['schema 2', { schema: 2, entries }], ['no entries', { schema: 1 }], ['entries array', { schema: 1, entries: [] }]]) {
    await metaRef('vbad').set(doc);
    await assert.rejects(() => io.readActive(RID, 'vbad'), /photos_meta_malformed/, `EDIT-IO-ACTIVE-MALFORMED ${label}`);
  }
  await assert.rejects(() => io.readActive(RID, null), /photos_meta_malformed/, 'EDIT-IO-ACTIVE-NO-VID');
  ok('readActive: versions/{vid}/meta/photos entries; absent → null; schema ≠ 1 / no entries / a non-object / no version id → throws (fail closed)');

  // ── attach ──
  await regRef(P1).set({ state: 'draft', last_ref_at: 1 });
  await regRef(P2).set({ state: 'published', last_ref_at: 2 });
  await regRef(P3).set({ state: 'deleting', last_ref_at: 3 });
  assert.deepStrictEqual(await io.attach(RID, [P1, P2]), { ok: true }, 'EDIT-IO-ATTACH-OK');
  assert.deepStrictEqual([(await regRef(P1).get()).data(), (await regRef(P2).get()).data()], [{ state: 'draft', last_ref_at: T }, { state: 'published', last_ref_at: T }], 'EDIT-IO-ATTACH-BUMPS-LAST-REF');
  await regRef(P1).set({ state: 'draft', last_ref_at: 1 });
  assert.deepStrictEqual(await io.attach(RID, [P1, P3]), { ok: false, code: 'photo_unavailable', pid: P3 }, 'EDIT-IO-ATTACH-DELETING-REFUSED');
  assert.strictEqual((await regRef(P1).get()).data().last_ref_at, 1, 'EDIT-IO-ATTACH-ALL-OR-NOTHING (no bump when any pid is refused)');
  assert.deepStrictEqual(await io.attach(RID, ['9'.repeat(32)]), { ok: false, code: 'photo_unavailable', pid: '9'.repeat(32) }, 'EDIT-IO-ATTACH-UNKNOWN-REFUSED');
  assert.deepStrictEqual(await io.attach(RID, []), { ok: true }, 'EDIT-IO-ATTACH-NOTHING');
  ok('attach: ONE transaction — every pid draft|published → all last_ref_at = now; any deleting / deleted / unknown pid → photo_unavailable and NOTHING bumped');

  // ── enabled ──
  assert.strictEqual(await makePhotoEditIo({ fs, enabled: async () => false }).enabled(), false, 'EDIT-IO-ENABLED-PASSTHROUGH');
  ok('enabled: the injected PHOTOS_UPLOADS reader');

  console.log(`edit-io: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('edit-io: FAILED —', e && e.stack || e); process.exit(1); });
