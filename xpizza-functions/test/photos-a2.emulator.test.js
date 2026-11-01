'use strict';
// DISH PHOTOS A2 step 14 (PLAN-dish-photos r2 §4.1) — the versioned photo lifecycle against the REAL Firestore emulator (transactions,
// the real publishVersion / flip / rollback) and the REAL Storage emulator (generations, create-only copies, generation-matched deletes),
// behind 2e's prod-wipe guard for BOTH buckets. Brand: the code-seeded x_pizza catalog (the publish pipeline is brand-keyed); every photo
// id and uid is synthetic. Run (HEAVY, in a granted slot):
//   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" node tools/emulator-run.js --only firestore,database,storage --project demo-xpizza "node test/photos-a2.emulator.test.js"
// Not here (stated): E-P4 through the REAL getBranchAvailabilityCore — it extends test/portal-ops.emulator.test.js (its auth fixtures).
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const EE = require('../lib/emulator-endpoint');
const PRIV = `${process.env.GCLOUD_PROJECT}.appspot.com`, PUB = 'demo-photos-public';
EE.assertStorageTestTarget(process.env, PRIV); EE.assertStorageTestTarget(process.env, PUB);   // 🔴 before any Storage client

const assert = require('assert');
require('../lib/admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { buildPublishCandidate } = require('../tools/publish-version');
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { makePublishPhotos } = require('../photos/publish-photos');
const { makeGcsCopy } = require('../photos/gcs-copy');
const { makePhotoEditIo } = require('../photos/edit-io');
const { withVersionPhotos, defaultReadVersionPhotos } = require('../photos/served-photos');
const { resetDraftToLiveCore } = require('../catalog/reset-draft');
const { previewVersion } = require('../catalog/catalog-publish');
const S = require('../photos/sweep-core');
const { makeGcsDeleter } = require('../photos/sweep-io');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('photos-a2(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const WATCHDOG = setTimeout(() => { console.error('photos-a2(emulator): FAILED — watchdog (600 s)'); process.exit(1); }, 600000);

const db = getFirestore();
const RID = 'x_pizza';
const P1 = '1'.repeat(32), P2 = '2'.repeat(32), P3 = '3'.repeat(32);
const reg = (pid) => db.collection('photo_registry').doc(RID).collection('pids').doc(pid);
const metaPhotos = (vid) => db.collection('restaurants').doc(RID).collection('versions').doc(vid).collection('meta').doc('photos');
const versionDoc = (vid) => db.collection('restaurants').doc(RID).collection('versions').doc(vid);
const priv = getStorage().bucket(PRIV), pub = getStorage().bucket(PUB);
async function seedDraftPid(pid) {
  const gens = {};
  for (const k of ['card', 'hero']) { const f = priv.file(`drafts/${RID}/${pid}-${k}.webp`); await f.save(Buffer.from(`${pid}-${k}`), { resumable: false, contentType: 'image/webp' }); gens[`draft_${k}`] = String((await f.getMetadata())[0].generation); }
  await reg(pid).set({ state: 'draft', last_ref_at: Date.now(), generations: gens, created_at: Date.now() });
}
const pp = makePublishPhotos({ fs: db, store: makeGcsCopy(getStorage(), PRIV), publicBucket: () => PUB });   // the private source bucket NAMED, as photos/publish-io.js wires it (codex r1 P1-1)
const edit = makePhotoEditIo({ fs: db, enabled: async () => true });

(async () => {
  // v1: a plain publish (no photos)
  const c1 = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'a2-emu-v1' });
  const r1 = await publishVersion(db, RID, c1.input, { expected: { activeVersionId: null } });
  const v1 = r1.versionId;
  const key = c1.input.items[0].key;

  // ── A2-E1 the versioned round trip ──
  await seedDraftPid(P1);
  const map = { [key]: { state: 'pid', pid: P1 } };
  const prep = await pp.prepare(RID, map);
  const c2 = buildPublishCandidate(RID, { activeVersionId: v1 }, { source_sha: 'a2-emu-v2' });
  const r2 = await publishVersion(db, RID, { ...c2.input, photos: pp.hook(prep) }, { expected: { activeVersionId: v1 } });
  const v2 = r2.versionId;
  await pp.markPublished(RID, prep.pids);
  assert.strictEqual(await getActiveVersionId(db, RID), v2, 'A2-E1-FLIPPED');
  const doc = (await metaPhotos(v2).get()).data();
  assert.deepStrictEqual(doc.entries[key].pid, P1, 'A2-E1-META-PHOTOS-ON-THE-VERSION');
  assert.strictEqual((await reg(P1).get()).data().state, 'published', 'A2-E1-REGISTRY-PUBLISHED');
  const [pubExists] = await pub.file(`photos/${RID}/${P1}-card.webp`).exists();
  assert.ok(pubExists, 'A2-E1-PUBLIC-COPY');
  const menuV2 = { identity: { version_id: v2 }, items: c2.input.items };
  const served = await withVersionPhotos(db, RID, menuV2, {}, defaultReadVersionPhotos);
  const id = String(c2.input.items[0].display.id);
  assert.ok(served && served[id] && served[id].card.endsWith(`photos/${RID}/${P1}-card.webp`), 'A2-E1-SERVED-BY-EXACT-VID');
  // reset rebuilds the draft map from the active version
  await db.collection('restaurants').doc(RID).collection('meta').doc('source').set({ ...require('../tools/seed-source-store').buildSourceFromCode(RID) });
  const snap = await db.collection('restaurants').doc(RID).collection('meta').doc('source').get();
  const rr = await resetDraftToLiveCore({ db, authorize: async () => ({ ok: true, uid: 'tb_owner', role: 'owner' }), readActiveVersionId: (f, r) => getActiveVersionId(f, r), previewVersion,
    readActivePhotos: (r, vid) => edit.readActive(r, vid),
    toPrecondition: (v) => { const [sec, nanos] = v.split('.'); return new (require('firebase-admin/firestore').Timestamp)(Number(sec), Number(nanos)); } },   // as portal/reset-draft.js decodeUpdateTime
    { restaurantId: RID, expectedRevision: require('../catalog/source-store').encodeUpdateTime(snap.updateTime) }, {});
  assert.strictEqual(rr.status, 200, `A2-E1-RESET ${JSON.stringify(rr.body).slice(0, 200)}`);
  assert.deepStrictEqual(rr.body.source.photos, { [key]: { state: 'pid', pid: P1 } }, 'A2-E1-RESET-MAP-FROM-ACTIVE');
  // rollback to v1 → its own (absent) photos: the served map is the legacy one again
  await rollbackVersion(db, RID, v1, { expected: { activeVersionId: v2 } });
  assert.strictEqual(await getActiveVersionId(db, RID), v1, 'A2-E1-ROLLED-BACK');
  const legacy = { [id]: { card: 'L', hero: 'L' } };
  assert.strictEqual(await withVersionPhotos(db, RID, { identity: { version_id: v1 }, items: c1.input.items }, legacy, defaultReadVersionPhotos), legacy, 'A2-E1-ROLLBACK-SERVES-ITS-OWN');
  ok('A2-E1 publish (meta/photos written before the flip, public copy, registry published) → served by the exact vid → reset rebuilds the map → rollback serves the old version\'s own photos');

  // ── A2-E2 a photo-only publish does not move content_hash ──
  const h1 = (await versionDoc(v1).get()).data().content_hash, h2 = (await versionDoc(v2).get()).data().content_hash;
  assert.strictEqual(h2, h1, 'A2-E2-CONTENT-HASH-UNCHANGED');
  ok('A2-E2 the photo-only publish left content_hash byte-identical (meta/photos is not part of it)');

  // ── A2-E3 concurrency: attach vs sweeper claim, publish hook vs sweeper claim — exactly one wins each ──
  for (const label of ['attach', 'publish-hook']) {
    await seedDraftPid(P2);
    const seen = (await reg(P2).get()).data().last_ref_at;
    const other = label === 'attach' ? edit.attach(RID, [P2]) : (async () => {
      // the claim can win BEFORE the hook commits: prepare's own registry transaction then fails closed with photo_unavailable — a loss
      // at that stage is the publish side losing the race (any other error still fails the cell loudly)
      let prep2;
      try { prep2 = await pp.prepare(RID, { [key]: { state: 'pid', pid: P2 } }); } catch (e) { if (e && e.code === 'photo_unavailable') return { ok: false, code: e.code, stage: 'prepare' }; throw e; }
      return pp.hook(prep2).commit(db, RID, `tb-vx-${Date.now()}`).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }));
    })();
    const [a, c] = await Promise.all([other, S.claim({ fs: db, now: Date.now, newClaimId: () => `emu${Date.now()}` }, RID, { pid: P2, last_ref_at: seen })]);
    const winners = [a && a.ok === true, !!c].filter(Boolean).length;
    assert.strictEqual(winners, 1, `A2-E3-EXACTLY-ONE-WINS ${label} (attach/hook ok=${a && a.ok}, claim=${!!c})`);
    await reg(P2).delete();
  }
  ok('A2-E3 under real transactions: an attach vs a sweeper claim, and a publish hook vs a claim — exactly one wins each time');

  // ── A2-E4 the live sweeper: generation-matched deletes; a re-created object survives ──
  await seedDraftPid(P3);
  await reg(P3).set({ ...(await reg(P3).get()).data(), last_ref_at: Date.now() - 8 * 86400e3 });
  await priv.file(`drafts/${RID}/${P3}-hero.webp`).save(Buffer.from('re-created'), { resumable: false });   // a new generation
  const sw = await S.sweepRid({ fs: db, priv: makeGcsDeleter(priv), pub: makeGcsDeleter(pub), now: Date.now, newClaimId: () => `sw${Date.now()}`, log: { info: () => {}, warn: () => {} }, mode: 'live', activeVersionId: (r) => getActiveVersionId(db, r) }, RID);
  assert.ok(sw.deleted.includes(P3), 'A2-E4-SWEPT');
  const [cardLeft] = await priv.file(`drafts/${RID}/${P3}-card.webp`).exists();
  assert.strictEqual(cardLeft, false, 'A2-E4-MATCHING-GENERATION-DELETED (the card, still at its recorded generation)');
  // NOT ON THE EMULATOR (advisor ruling, 2026-11-01): "a RE-CREATED object survives" — the emulator ignores ifGenerationMatch on
  // DELETE (probe xpizza-D4c-grill/dish-photos-heavy-dce03b96/e4-delete-probe/RESULT.md: the production deleter's delete pinned to
  // the old generation removed the new object), so the re-created hero is NOT asserted here. Where it IS proven:
  //   · the wire — photos/sweep-io.test.js SWEEP-GCS-GENERATION-MATCHED (delete carries ifGenerationMatch = the recorded generation;
  //     a 412 → 'other_generation', never deleted);
  //   · real GCS — the owner's deploy-time acceptance tools/photo-create-only-check.js (its delete-precondition step).
  assert.ok(!sw.deleted.includes(P1), 'A2-E4-RETAINED-VERSION-REFERENCE-PROTECTS (P1 is in v2, still retained)');
  ok('A2-E4 the live sweeper deletes the swept pid at its recorded generation and never touches a pid a retained version references (the re-created-object guarantee: real GCS + the wire pin)');

  // ── A2-E6 the public copy fails → photo_publish_failed, the pointer never moves ──
  const before = await getActiveVersionId(db, RID);
  const failing = makePublishPhotos({ fs: db, store: { copyIfAbsent: async () => { throw Object.assign(new Error('storage down'), { code: 503 }); } }, publicBucket: () => PUB });
  await seedDraftPid(P2);
  await assert.rejects(() => failing.prepare(RID, { [key]: { state: 'pid', pid: P2 } }), (e) => e.code === 'photo_publish_failed', 'A2-E6-COPY-FAILS-CLOSED');
  assert.strictEqual(await getActiveVersionId(db, RID), before, 'A2-E6-POINTER-UNMOVED');
  ok('A2-E6 Storage failing on a new pid → photo_publish_failed before any write; the pointer did not move');

  FINISHED = true; clearTimeout(WATCHDOG);
  console.log(`photos-a2(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('photos-a2(emulator): FAILED —', e && e.stack || e); process.exit(1); });
