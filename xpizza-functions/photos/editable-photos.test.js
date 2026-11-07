'use strict';
// DISH PHOTOS A2 step 9 (PLAN-dish-photos r2 §2.2 E-P3 + amendment 2026-10-27; advisor rulings 2026-10-27 #2/#3) —
// photos/editable-photos.js: the fields getEditableCatalog ADDS, each omitted when empty/off (byte-identical otherwise).
// Run: node photos/editable-photos.test.js
const assert = require('assert');
const E = require('./editable-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', T = Date.UTC(2026, 9, 31, 12), BUCKET = 'tb-public-photos';
const P_PUB = 'a'.repeat(32), P_DRAFT = 'b'.repeat(32), P_DEL = 'c'.repeat(32), P_ACTIVE_ONLY = 'e'.repeat(32), P_MISSING = 'f'.repeat(32);
const BASE = 'https://order.tb.example/';
const items = [
  { key: 'tb_img', display: { id: 1, img: 'pics/margherita.jpg' } },
  { key: 'tb_has', has_photo: true, display: { id: 2 } },
  { key: 'tb_none', display: { id: 3 } },
  { key: 'tb_bad', display: { id: 4, img: 'https://evil.example/x.jpg' } },
];
const signRead = async (path, exp) => `https://storage.googleapis.com/tb-default/${path}?X-Goog-Expires=${exp}`;
const input = (over = {}) => ({
  rid: RID, now: T, enabled: true, publicBucket: BUCKET, legacyBase: BASE, items, signRead,
  draftMap: { tb_img: { state: 'pid', pid: P_PUB }, tb_has: { state: 'pid', pid: P_DRAFT }, tb_none: { state: 'pid', pid: P_DEL }, tb_bad: { state: 'removed' } },
  activeEntries: { tb_img: { state: 'pid', pid: P_ACTIVE_ONLY, card: 'x', hero: 'y' } },
  registry: { [P_PUB]: 'published', [P_DRAFT]: 'draft', [P_DEL]: 'deleting', [P_ACTIVE_ONLY]: 'published' },
  legacyRecords: {},
  ...over,
});

(async () => {
  // ── 1. the canonical legacy URL + its record id (the backfill tool computes the SAME) ──
  assert.strictEqual(E.legacyUrlFor(items[0], BASE), `${BASE}pics/margherita.jpg`, 'EP3-LEGACY-IMG');
  assert.strictEqual(E.legacyUrlFor(items[1], BASE), `${BASE}images/tb_has-card.webp`, 'EP3-LEGACY-HAS-PHOTO');
  assert.strictEqual(E.legacyUrlFor(items[2], BASE), null, 'EP3-LEGACY-NONE');
  assert.strictEqual(E.legacyUrlFor(items[3], BASE), null, 'EP3-LEGACY-NON-RELATIVE-IMG-NEVER (public-photos rule)');
  assert.strictEqual(E.legacyUrlFor(items[0], null), null, 'EP3-LEGACY-NO-BASE');
  assert.match(E.legacyHashOf(`${BASE}pics/margherita.jpg`), /^[0-9a-f]{32}$/, 'EP3-LEGACY-HASH-32-HEX');
  assert.notStrictEqual(E.legacyHashOf('a'), E.legacyHashOf('b'));
  ok('legacyUrlFor = the public menu\'s own rule (relative img, else has_photo images/<key>-card.webp, never a foreign URL); legacyHashOf = sha256 first 32 hex');

  // ── 2. the full field set ──
  const h1 = E.legacyHashOf(`${BASE}pics/margherita.jpg`);
  const f = await E.editablePhotoFields(input({ legacyRecords: { [h1]: { card_url: `https://storage.googleapis.com/${BUCKET}/photos/${RID}/legacy/${h1}-card.webp` } } }));
  assert.deepStrictEqual(f.photos, input().draftMap, 'EP3-PHOTOS-IS-THE-DRAFT-MAP');
  const pub = (p, k) => `https://storage.googleapis.com/${BUCKET}/photos/${RID}/${p}-${k}.webp`;
  assert.deepStrictEqual(f.photoPreviews[P_PUB], { card: pub(P_PUB, 'card'), hero: pub(P_PUB, 'hero') }, 'EP3-PUBLISHED-PUBLIC-NO-EXPIRY');
  assert.deepStrictEqual(f.photoPreviews[P_ACTIVE_ONLY], { card: pub(P_ACTIVE_ONLY, 'card'), hero: pub(P_ACTIVE_ONLY, 'hero') }, 'EP3-ACTIVE-PIDS-COVERED (amendment)');
  const exp = T + 3600000;
  assert.deepStrictEqual(f.photoPreviews[P_DRAFT], { card: await signRead(`drafts/${RID}/${P_DRAFT}-card.webp`, exp), hero: await signRead(`drafts/${RID}/${P_DRAFT}-hero.webp`, exp), expiresAt: exp }, 'EP3-DRAFT-SIGNED-1H');
  assert.ok(!(P_DEL in f.photoPreviews), 'EP3-DELETING-NO-PREVIEW (portal shows P5)');
  assert.deepStrictEqual(Object.keys(f.photoPreviews).sort(), [P_PUB, P_DRAFT, P_ACTIVE_ONLY].sort(), 'EP3-PREVIEW-SET');
  assert.deepStrictEqual(f.legacyPreviews, { tb_img: { card: `https://storage.googleapis.com/${BUCKET}/photos/${RID}/legacy/${h1}-card.webp` }, tb_has: {} }, 'EP3-LEGACY-PREVIEWS (copy present → URL; absent → key without URL; no legacy image → no key)');
  assert.strictEqual(f.photosEnabled, true, 'EP3-PHOTOS-ENABLED');
  assert.strictEqual(f.photosPending, true, 'EP3-PHOTOS-PENDING (the draft map differs from the active one)');
  ok('photos = the draft map; photoPreviews: published → public URLs (no expiry), draft → 1 h signed GET, active-version pids covered, deleting omitted; legacyPreviews; photosEnabled; photosPending');

  // ── 3. everything omitted when empty / off → the response is byte-identical ──
  const none = await E.editablePhotoFields(input({ draftMap: null, activeEntries: null, enabled: false, items: [items[2]] }));
  assert.deepStrictEqual(none, {}, 'EP3-NOTHING-ADDED');
  const darkWithLegacy = await E.editablePhotoFields(input({ draftMap: null, activeEntries: null, enabled: false }));
  assert.deepStrictEqual(darkWithLegacy, {}, 'EP3-DARK-LEGACY-OMITTED (legacy images exist but photos are dark and unused → nothing added)');
  const onNoData = await E.editablePhotoFields(input({ draftMap: null, activeEntries: null, enabled: true }));
  assert.deepStrictEqual(Object.keys(onNoData).sort(), ['legacyPreviews', 'photosEnabled'], 'EP3-ON-LEGACY-SHOWN (the uploader needs the current image)');
  const flagOff = await E.editablePhotoFields(input({ enabled: false }));
  assert.ok(!('photosEnabled' in flagOff), 'EP3-FLAG-OFF-OMITS-PHOTOS-ENABLED');
  ok('dark (flag off, no photo data) → {} even with legacy images; flag on → legacyPreviews + photosEnabled; flag off → no photosEnabled');

  // ── 4. no public bucket (A0 not done) → no public URL is emitted; draft previews still sign ──
  const noBucket = await E.editablePhotoFields(input({ publicBucket: null }));
  assert.deepStrictEqual(Object.keys(noBucket.photoPreviews), [P_DRAFT], 'EP3-NO-BUCKET-NO-PUBLIC-URL');
  assert.deepStrictEqual(noBucket.legacyPreviews, { tb_img: {}, tb_has: {} }, 'EP3-NO-BUCKET-LEGACY-WITHOUT-URL');
  ok('PHOTOS_PUBLIC_BUCKET unset → no public URL anywhere (published / legacy present without URL); draft previews still signed');

  // ── 5. a signing failure omits only that preview (the editor still loads) ──
  const sf = await E.editablePhotoFields(input({ signRead: async () => { throw new Error('signBlob denied'); } }));
  assert.ok(!(P_DRAFT in sf.photoPreviews) && P_PUB in sf.photoPreviews, 'EP3-SIGN-FAILURE-OMITS-ONLY-THAT-PREVIEW');
  const unknown = await E.editablePhotoFields(input({ draftMap: { tb_img: { state: 'pid', pid: P_MISSING } }, activeEntries: null }));
  assert.deepStrictEqual(unknown.photoPreviews || {}, {}, 'EP3-UNKNOWN-PID-NO-PREVIEW');
  ok('a signing failure omits just that preview; a pid with no registry doc gets none');

  // ── 6. URL shape: path-style (§3 CSP) ──
  for (const v of Object.values(f.photoPreviews)) for (const u of [v.card, v.hero]) assert.match(u, /^https:\/\/storage\.googleapis\.com\/[a-z0-9._-]+\/(photos|drafts)\//, `EP3-PATH-STYLE ${u}`);
  ok('every preview URL is path-style https://storage.googleapis.com/<bucket>/(photos|drafts)/… (the portal CSP prefixes)');

  console.log(`editable-photos: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('editable-photos: FAILED —', e && e.stack || e); process.exit(1); });
