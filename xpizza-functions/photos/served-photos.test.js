'use strict';
// DISH PHOTOS A2 step 11 (PLAN-dish-photos r2 §2.1 "readers use the exact version id"; P1-1) — photos/served-photos.js: the public menu's
// `photos` (keyed by String(dish.id), PLAN-public-menu-display T2) overlaid with the SERVED version's meta/photos. Run:
// node photos/served-photos.test.js
const assert = require('assert');
const { withVersionPhotos, overlay } = require('./served-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', P1 = '1'.repeat(32);
const menu = { identity: { version_id: 'v7' }, items: [{ key: 'tb_a', display: { id: 1 } }, { key: 'tb_b', display: { id: 2 } }, { key: 'tb_c', display: { id: 3 } }, { key: 'tb_noid', display: {} }] };
const legacy = { 1: { card: 'https://o/a.jpg', hero: 'https://o/a.jpg' }, 2: { card: 'https://o/images/tb_b-card.webp', hero: 'https://o/images/tb_b-hero.webp' } };
const pub = (k) => `https://storage.googleapis.com/tb-public/photos/${RID}/${P1}-${k}.webp`;

(async () => {
  // ── 1. overlay: pid replaces / adds, removed drops (no legacy fallback), absent keeps legacy; never mutates its input ──
  const entries = { tb_a: { state: 'pid', pid: P1, card: pub('card'), hero: pub('hero') }, tb_b: { state: 'removed' }, tb_c: { state: 'pid', pid: P1, card: pub('card'), hero: pub('hero') }, tb_noid: { state: 'pid', pid: P1, card: pub('card'), hero: pub('hero') }, tb_gone: { state: 'pid', pid: P1, card: pub('card'), hero: pub('hero') } };
  const before = JSON.stringify(legacy);
  assert.deepStrictEqual(overlay(legacy, menu, entries), { 1: { card: pub('card'), hero: pub('hero') }, 3: { card: pub('card'), hero: pub('hero') } }, 'SERVED-OVERLAY');
  assert.strictEqual(JSON.stringify(legacy), before, 'SERVED-OVERLAY-PURE');
  assert.deepStrictEqual(overlay(null, menu, { tb_c: entries.tb_c }), { 3: { card: pub('card'), hero: pub('hero') } }, 'SERVED-OVERLAY-NO-LEGACY-BASE');
  assert.strictEqual(overlay(null, menu, { tb_b: { state: 'removed' } }), null, 'SERVED-OVERLAY-EMPTY-IS-NULL');
  ok('overlay: a pid entry serves its version\'s public card/hero; removed drops the dish (no legacy fallback); absent keeps today\'s legacy; items without an id / unknown keys ignored; input untouched');

  // ── 2. withVersionPhotos reads EXACTLY the served version; no doc → today's map byte-identical; a read error → null (omitted) ──
  const seen = [];
  const read = async (db, rid, vid) => { seen.push([rid, vid]); return vid === 'v7' ? { schema: 1, entries } : null; };
  assert.deepStrictEqual(await withVersionPhotos({}, RID, menu, legacy, read), overlay(legacy, menu, entries), 'SERVED-READS-SERVED-VERSION');
  assert.deepStrictEqual(seen, [[RID, 'v7']], 'SERVED-EXACT-VID');
  assert.strictEqual(await withVersionPhotos({}, RID, { ...menu, identity: { version_id: 'v-old' } }, legacy, read), legacy, 'SERVED-NO-DOC-SAME-OBJECT');
  assert.strictEqual(await withVersionPhotos({}, RID, { ...menu, identity: {} }, legacy, read), legacy, 'SERVED-NO-VID-LEGACY');
  const warn = console.warn; const w = []; console.warn = (...a) => w.push(a.join(' '));
  assert.strictEqual(await withVersionPhotos({}, RID, menu, legacy, async () => { throw new Error('down'); }), null, 'SERVED-READ-ERROR-OMITS');
  assert.strictEqual(await withVersionPhotos({}, RID, menu, legacy, async () => ({ schema: 2, entries })), null, 'SERVED-MALFORMED-OMITS');
  // codex r1 P2-5: EACH entry is validated — one malformed entry omits the whole field (deviation #3), never a silent legacy fallback
  for (const [label, bad] of [['pid without hero', { state: 'pid', pid: P1, card: pub('card') }], ['null entry', null], ['unknown state', { state: 'legacy' }],
    ['pid not hex', { state: 'pid', pid: 'XYZ', card: pub('card'), hero: pub('hero') }], ['card not https', { state: 'pid', pid: P1, card: 'http://x/y.webp', hero: pub('hero') }],
    ['removed with extra', { state: 'removed', pid: P1 }]]) {
    assert.strictEqual(await withVersionPhotos({}, RID, menu, legacy, async () => ({ schema: 1, entries: { tb_a: { state: 'pid', pid: P1, card: pub('card'), hero: pub('hero') }, tb_b: bad } })), null, `SERVED-MALFORMED-ENTRY-OMITS ${label}`);
  }
  console.warn = warn;
  assert.ok(w.length === 8 && w.every((x) => x.includes('public_menu_version_photos_unreadable')), 'SERVED-UNREADABLE-LOGGED');
  ok('withVersionPhotos: reads versions/{servedVid}/meta/photos only; no doc / no version id → today\'s map (same object); unreadable or malformed → photos omitted (never a removed photo shown) + logged');

  console.log(`served-photos: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('served-photos: FAILED —', e && e.stack || e); process.exit(1); });
