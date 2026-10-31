'use strict';
// DISH PHOTOS A2 step 12b (amendment 2026-10-27; advisor ruling #4) — the LEGACY BACKFILL core: every legacy dish image the public
// menu serves today (public-photos.js's rule) → a re-encoded copy in the PUBLIC bucket photos/{rid}/legacy/<hash>-card.webp + the
// Firestore record photo_registry/{rid}/legacy/{hash} that getEditableCatalog resolves. DRY-RUN by default: nothing is uploaded or
// recorded; a before/after contact sheet is written for the owner to review. --apply (owner) is create-only and idempotent.
// Run: node tools/photos-legacy-backfill-core.test.js
const assert = require('assert');
const { backfillRid } = require('./photos-legacy-backfill-core');
const { legacyHashOf } = require('../photos/editable-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', BASE = 'https://order.tb.example/', PUB = 'tb-public', T = Date.UTC(2026, 9, 31, 12);
const items = [
  { key: 'tb_img', display: { id: 1, img: 'pics/a.jpg' } },
  { key: 'tb_has', has_photo: true, display: { id: 2 } },
  { key: 'tb_none', display: { id: 3 } },
  { key: 'tb_dup', display: { id: 4, img: 'pics/a.jpg' } },   // the same image twice → one copy
  { key: 'tb_404', display: { id: 5, img: 'pics/missing.jpg' } },
];
function deps(over = {}) {
  const st = { records: {}, uploads: [], sheet: null, fetched: [] };
  return { st, d: {
    readItems: async () => items, legacyBase: () => BASE, publicBucket: PUB, now: () => T,
    readRecord: async (rid, h) => st.records[h] || null,
    fetchImage: async (url) => { st.fetched.push(url); if (url.endsWith('missing.jpg')) throw new Error('HTTP 404'); return Buffer.from(`IMG:${url}`); },
    encode: async (buf) => Buffer.from(`WEBP(${buf})`),
    upload: async (rid, h, buf) => { st.uploads.push([rid, h, String(buf)]); return { generation: String(100 + st.uploads.length), created: true }; },
    writeRecord: async (rid, h, rec) => { st.records[h] = rec; },
    writeSheet: async (rid, rows) => { st.sheet = rows; },
    ...over } };
}
const hA = legacyHashOf(`${BASE}pics/a.jpg`), hH = legacyHashOf(`${BASE}images/tb_has-card.webp`), hM = legacyHashOf(`${BASE}pics/missing.jpg`);

(async () => {
  // ── 1. DRY RUN (default): fetch + encode for the contact sheet; NOTHING uploaded or recorded ──
  {
    const { st, d } = deps();
    const r = await backfillRid(RID, { apply: false }, d);
    assert.deepStrictEqual(st.uploads, [], 'LEGACY-DRY-NO-UPLOAD');
    assert.deepStrictEqual(st.records, {}, 'LEGACY-DRY-NO-RECORD');
    assert.deepStrictEqual(st.sheet.map((x) => [x.key, x.hash, x.status]), [['tb_img', hA, 'would_copy'], ['tb_has', hH, 'would_copy'], ['tb_dup', hA, 'same_image'], ['tb_404', hM, 'unresolvable']], 'LEGACY-DRY-SHEET');
    assert.ok(st.sheet[0].before && st.sheet[0].after, 'LEGACY-DRY-SHEET-HAS-BEFORE-AND-AFTER');
    assert.deepStrictEqual(r.counts, { would_copy: 2, already_present: 0, unresolvable: 1, same_image: 1 }, 'LEGACY-DRY-COUNTS');
    ok('dry run: every legacy image fetched + re-encoded into a before/after contact sheet; nothing uploaded, nothing recorded; a duplicate image once; a dead URL reported');
  }
  // ── 2. APPLY: upload create-only, then the record; a second run is a no-op ──
  {
    const { st, d } = deps();
    const r = await backfillRid(RID, { apply: true }, d);
    assert.deepStrictEqual(st.uploads.map((u) => u[1]).sort(), [hA, hH].sort(), 'LEGACY-APPLY-UPLOADS-ONCE-PER-IMAGE');
    assert.deepStrictEqual(st.records[hA], { card_url: `https://storage.googleapis.com/${PUB}/photos/${RID}/legacy/${hA}-card.webp`, source: `${BASE}pics/a.jpg`, generation: st.records[hA].generation, created_at: T }, 'LEGACY-APPLY-RECORD');
    assert.deepStrictEqual(r.counts, { copied: 2, already_present: 0, unresolvable: 1, same_image: 1 }, 'LEGACY-APPLY-COUNTS');
    const again = await backfillRid(RID, { apply: true }, d);
    assert.strictEqual(st.uploads.length, 2, 'LEGACY-APPLY-IDEMPOTENT-NO-REUPLOAD');
    assert.deepStrictEqual(again.counts, { copied: 0, already_present: 2, unresolvable: 1, same_image: 1 }, 'LEGACY-APPLY-IDEMPOTENT-COUNTS');
    ok('apply: one create-only upload per distinct image, THEN its Firestore record (card_url, source, generation); a rerun copies nothing (already_present)');
  }
  // ── 3. refusals ──
  {
    const { d } = deps({ legacyBase: () => null });
    await assert.rejects(() => backfillRid(RID, { apply: false }, d), /no_order_site_base/, 'LEGACY-NO-BASE-REFUSED');
    const { d: d2 } = deps({ publicBucket: '' });
    await assert.rejects(() => backfillRid(RID, { apply: true }, d2), /no_public_bucket/, 'LEGACY-APPLY-NEEDS-BUCKET');
    const { st: st3, d: d3 } = deps({ encode: async () => { throw new Error('bad_type'); } });
    const r3 = await backfillRid(RID, { apply: true }, d3);
    assert.deepStrictEqual([st3.uploads.length, r3.counts.unresolvable], [0, 3], 'LEGACY-UNDECODABLE-UNRESOLVABLE');
    ok('no order-site base → refused; --apply without a public bucket → refused; an undecodable image is unresolvable, never uploaded');
  }
  console.log(`photos-legacy-backfill-core: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('photos-legacy-backfill-core: FAILED —', e && e.stack || e); process.exit(1); });
