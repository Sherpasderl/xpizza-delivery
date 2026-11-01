'use strict';
// DISH PHOTOS A2 step 9 (PLAN-dish-photos r2 §2.1, §2.4) — catalogDiff's photo lines: {surface:'item', key, field:'photo', old, new}
// with old/new ∈ {kind:'legacy'} | {kind:'pid',pid} | {kind:'removed'}, in `changed`, read from an OPTIONAL `photos` on the live and
// draft objects (the active version's meta/photos entries; the draft map). Absent on both ⇒ the diff — HASHED into the edit token —
// is byte-identical to today's. Not in largeChangeSet. Run: node photos/diff-photos.test.js
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { catalogDiff, issueEditToken, verifyEditToken } = require('../catalog/catalog-edit');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'x_pizza';
const P1 = '1'.repeat(32), P2 = '2'.repeat(32);
const built = () => { const i = sourceToBuildInputs(buildSourceFromCode(RID)); return { ...buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras }; };
const live = built(), draft = built();
const [K1, K2, K3] = live.items.map((it) => it.key);

// ── 1. no photos anywhere → byte-identical to today (the token binds this) ──
const today = catalogDiff(live, draft);
assert.strictEqual(JSON.stringify(catalogDiff({ ...live, photos: null }, { ...draft, photos: null })), JSON.stringify(today), 'DIFF-PHOTOS-NULL-IDENTICAL');
assert.strictEqual(JSON.stringify(catalogDiff({ ...live, photos: {} }, { ...draft })), JSON.stringify(today), 'DIFF-PHOTOS-EMPTY-IDENTICAL');
ok('no photo data (absent / null / empty) → the diff is byte-identical to today\'s');

// ── 2. three-state lines in `changed`, sorted with the rest; legacy → removed is a line; URLs never compared ──
const activeEntries = { [K1]: { state: 'pid', pid: P1, card: 'u1', hero: 'u2' }, [K3]: { state: 'pid', pid: P1, card: 'x', hero: 'y' } };
const draftMap = { [K1]: { state: 'pid', pid: P2 }, [K2]: { state: 'removed' }, [K3]: { state: 'pid', pid: P1 } };
const d = catalogDiff({ ...live, photos: activeEntries }, { ...draft, photos: draftMap });
const photoLines = d.changed.filter((l) => l.field === 'photo');
assert.deepStrictEqual(photoLines, [
  { key: K1, surface: 'item', field: 'photo', old: { kind: 'pid', pid: P1 }, new: { kind: 'pid', pid: P2 } },
  { key: K2, surface: 'item', field: 'photo', old: { kind: 'legacy' }, new: { kind: 'removed' } },
].sort((a, b) => (a.surface + a.key + a.field).localeCompare(b.surface + b.key + b.field)), 'DIFF-PHOTOS-LINES');
assert.deepStrictEqual(d.changed.filter((l) => l.field !== 'photo'), today.changed, 'DIFF-PHOTOS-OTHER-LINES-UNCHANGED');
assert.deepStrictEqual(d.largeChangeSet, today.largeChangeSet, 'DIFF-PHOTOS-NOT-IN-LARGE-CHANGE-SET');
const byKey = (a, b) => (a.surface + a.key + (a.field || a.reason || '')).localeCompare(b.surface + b.key + (b.field || b.reason || ''));
assert.deepStrictEqual(d.changed, [...d.changed].sort(byKey), 'DIFF-PHOTOS-DETERMINISTIC-ORDER');
ok('photo lines (pid → pid, legacy → removed) in `changed`, sorted with the rest; the unchanged pid with URLs is no line; largeChangeSet untouched');

// ── 3. a photo-only removal back to legacy (the draft drops an active pid) ──
const back = catalogDiff({ ...live, photos: activeEntries }, { ...draft, photos: { [K3]: { state: 'pid', pid: P1 } } });
assert.deepStrictEqual(back.changed.filter((l) => l.field === 'photo'), [{ key: K1, surface: 'item', field: 'photo', old: { kind: 'pid', pid: P1 }, new: { kind: 'legacy' } }], 'DIFF-PHOTOS-BACK-TO-LEGACY');
ok('a draft that no longer names an active pid shows pid → legacy');

// ── 4. the token binds the photo lines: a token issued over one photo diff does not verify another ──
const state = (diff) => ({ rid: RID, baseActiveVersionId: 'v1', sourceUpdateTime: 't', sourceHash: 'h', diff });
const tok = issueEditToken(state(d));
assert.deepStrictEqual(verifyEditToken(tok, state(d)), { ok: true, reason: null }, 'DIFF-PHOTOS-TOKEN-OK');
assert.strictEqual(verifyEditToken(tok, state(back)).reason, 'token_mismatch', 'DIFF-PHOTOS-TOKEN-BINDS-PHOTO-LINES');
assert.strictEqual(verifyEditToken(tok, state(today)).reason, 'token_mismatch', 'DIFF-PHOTOS-TOKEN-PHOTOS-VS-NONE');
ok('the edit token binds the photo lines (a different photo diff — or none — is token_mismatch)');

console.log(`diff-photos: OK (${n})`);
