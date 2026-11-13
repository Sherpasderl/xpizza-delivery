'use strict';
// DISH PHOTOS A2 step 9 — photos/editable-io.js: getEditableCatalog's photo READS over Firestore (never Storage, except signing a draft
// preview URL — a local signBlob, not an object read). Run: node photos/editable-io.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const { makeEditableIo } = require('./editable-io');
const { legacyHashOf } = require('./editable-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', T = Date.UTC(2026, 9, 31, 12);
const P1 = '1'.repeat(32), P2 = '2'.repeat(32);
const BASE = 'https://order.tb.example/';

(async () => {
  const fs = makeDb();
  const reads = [];
  const spy = { collection: (c) => { reads.push(c); return fs.collection(c); }, runTransaction: (f) => fs.runTransaction(f) };
  const mk = (over = {}) => makeEditableIo({ fs: spy, enabled: async () => true, publicBucket: () => 'tb-public', legacyBase: () => BASE,
    signRead: async (p, e) => `https://storage.googleapis.com/tb-default/${p}?e=${e}`, now: () => T, ...over });
  const src = (photos) => ({ items: [{ key: 'tb_img', display: { id: 1, img: 'p/m.jpg' } }, { key: 'tb_x', display: { id: 2 } }], ...(photos ? { photos } : {}) });
  await fs.collection('restaurants').doc(RID).collection('versions').doc('v1').collection('meta').doc('photos').set({ schema: 1, entries: { tb_img: { state: 'pid', pid: P1, card: 'c', hero: 'h' } } });
  await fs.collection('photo_registry').doc(RID).collection('pids').doc(P1).set({ state: 'published' });
  await fs.collection('photo_registry').doc(RID).collection('pids').doc(P2).set({ state: 'draft' });
  const h = legacyHashOf(`${BASE}p/m.jpg`);
  await fs.collection('photo_registry').doc(RID).collection('legacy').doc(h).set({ card_url: `https://storage.googleapis.com/tb-public/photos/${RID}/legacy/${h}-card.webp` });

  // ── 1. full read ──
  const f = await mk().fieldsFor({ rid: RID, source: src({ tb_x: { state: 'pid', pid: P2 } }), activeVersionId: 'v1' });
  assert.deepStrictEqual(Object.keys(f).sort(), ['legacyPreviews', 'photoPreviews', 'photos', 'photosEnabled', 'photosPending'], 'EIO-FIELDS');
  assert.deepStrictEqual(Object.keys(f.photoPreviews).sort(), [P1, P2].sort(), 'EIO-PREVIEWS-DRAFT-AND-ACTIVE');
  assert.strictEqual(f.photoPreviews[P1].expiresAt, undefined, 'EIO-PUBLISHED-NO-EXPIRY');
  assert.strictEqual(f.photoPreviews[P2].expiresAt, T + 3600000, 'EIO-DRAFT-EXPIRES-1H');
  assert.strictEqual(f.legacyPreviews.tb_img.card, `https://storage.googleapis.com/tb-public/photos/${RID}/legacy/${h}-card.webp`, 'EIO-LEGACY-FROM-FIRESTORE-RECORD');
  ok('fields from Firestore: active meta/photos + registry states + the legacy record; draft previews signed, published public');

  // ── 2. dark + no data: no registry / legacy reads at all ──
  reads.length = 0;
  const dark = await mk({ enabled: async () => false }).fieldsFor({ rid: RID, source: src(null), activeVersionId: 'v-none' });
  assert.deepStrictEqual(dark, {}, 'EIO-DARK-NOTHING');
  assert.ok(!reads.includes('photo_registry'), `EIO-DARK-NO-REGISTRY-OR-LEGACY-READS ${JSON.stringify(reads)}`);
  ok('dark (flag off, no photo data) → {} and NO registry / legacy reads (only the active meta/photos probe)');

  // ── 3. no active version → no active read; unset bucket param → null ──
  const noActive = await mk({ publicBucket: () => '' }).fieldsFor({ rid: RID, source: src({ tb_x: { state: 'pid', pid: P2 } }), activeVersionId: null });
  assert.deepStrictEqual(Object.keys(noActive.photoPreviews), [P2], 'EIO-NO-ACTIVE-VERSION');
  assert.deepStrictEqual(noActive.legacyPreviews, { tb_img: {} }, 'EIO-EMPTY-BUCKET-PARAM-IS-UNSET');
  ok('no active version → the draft map alone; an empty public bucket is "unset" (no public URL)');

  console.log(`editable-io: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('editable-io: FAILED —', e && e.stack || e); process.exit(1); });
