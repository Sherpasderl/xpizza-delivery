'use strict';
// DISH PHOTOS A2 step 12 (PLAN-dish-photos r2 §2.2 E-P4 + amendment: PER BRANCH ENTRY) — photos/branch-photos.js: one branch's
// `photos: {[itemKey]: {card}}` from THAT branch's active version's meta/photos (pid entries only, published URLs only, never draft),
// omitted when empty; a read failure omits it (the availability read still answers). Run: node photos/branch-photos.test.js
const assert = require('assert');
const { branchPhotosOf, cardsFrom } = require('./branch-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const P = '1'.repeat(32);
const pub = 'https://storage.googleapis.com/tb-public/photos/tb_r1/' + P + '-card.webp';
(async () => {
  assert.deepStrictEqual(cardsFrom({ tb_a: { state: 'pid', pid: P, card: pub, hero: 'h' }, tb_b: { state: 'removed' }, tb_c: { state: 'pid', pid: P } }), { tb_a: { card: pub } }, 'BRANCH-CARDS-PID-ONLY');
  assert.strictEqual(cardsFrom({ tb_b: { state: 'removed' } }), null, 'BRANCH-CARDS-EMPTY-NULL');
  assert.deepStrictEqual(cardsFrom({ tb_a: { state: 'pid', pid: P, card: pub }, tb_b: { state: 'removed', card: 'https://x/stale.webp' }, tb_c: { state: 'legacy', card: 'https://x/l.webp' } }), { tb_a: { card: pub } }, 'BRANCH-CARDS-NON-PID-WITH-CARD-IGNORED');
  assert.strictEqual(cardsFrom(null), null, 'BRANCH-CARDS-NONE');
  ok('cardsFrom: pid entries with a published card URL → {key: {card}}; removed / URL-less / none → omitted (null when empty)');

  const seen = [];
  const read = async (fs, rid, vid) => { seen.push([rid, vid]); return vid === 'v2' ? { schema: 1, entries: { tb_a: { state: 'pid', pid: P, card: pub, hero: 'h' } } } : null; };
  assert.deepStrictEqual(await branchPhotosOf({}, 'tb_r1', 'v2', read), { tb_a: { card: pub } }, 'BRANCH-PHOTOS-FROM-ITS-VERSION');
  assert.deepStrictEqual(seen, [['tb_r1', 'v2']], 'BRANCH-PHOTOS-EXACT-VID');
  assert.strictEqual(await branchPhotosOf({}, 'tb_r1', 'v1', read), null, 'BRANCH-PHOTOS-NO-DOC-OMITTED');
  assert.strictEqual(await branchPhotosOf({}, 'tb_r1', null, read), null, 'BRANCH-PHOTOS-NO-VERSION');
  const w = []; const log = { warn: (x) => w.push(x) };
  assert.strictEqual(await branchPhotosOf({}, 'tb_r1', 'v2', async () => { throw new Error('down'); }, log), null, 'BRANCH-PHOTOS-READ-ERROR-OMITTED');
  assert.strictEqual(await branchPhotosOf({}, 'tb_r1', 'v2', async () => ({ schema: 9, entries: {} }), log), null, 'BRANCH-PHOTOS-MALFORMED-OMITTED');
  assert.ok(w.length === 2 && w.every((x) => /branch_photos_unavailable/.test(x)), 'BRANCH-PHOTOS-LOGGED');
  ok('branchPhotosOf: reads exactly the branch\'s active version; no doc / no version → omitted; read error / malformed → omitted + logged');
  console.log(`branch-photos: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('branch-photos: FAILED —', e && e.stack || e); process.exit(1); });
