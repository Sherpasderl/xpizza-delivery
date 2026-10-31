'use strict';
// DISH PHOTOS A2 (PLAN-dish-photos r2 §2.1 + amendment 2026-10-27) — photos/photo-state.js, the PURE three-state vocabulary.
// Run: node photos/photo-state.test.js
const assert = require('assert');
const S = require('./photo-state');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const P1 = 'a'.repeat(32), P2 = 'b'.repeat(32), P3 = 'c'.repeat(32);

// ── 1. validateDraftMap: entries are exactly {state:'pid', pid} | {state:'removed'}; keys = live item keys or THIS request's tmp refs ──
const live = new Set(['tb_margherita', 'tb_pepperoni']);
const tmp = new Set(['tmp:abcd1234']);
assert.deepStrictEqual(S.validateDraftMap(undefined, { liveKeys: live }), { ok: true, map: null }, 'PS-ABSENT-IS-NULL');
assert.deepStrictEqual(S.validateDraftMap({}, { liveKeys: live }), { ok: true, map: null }, 'PS-EMPTY-IS-NULL (an empty map is never stored)');
const good = { tb_margherita: { state: 'pid', pid: P1 }, tb_pepperoni: { state: 'removed' }, 'tmp:abcd1234': { state: 'pid', pid: P2 } };
assert.deepStrictEqual(S.validateDraftMap(good, { liveKeys: live, tmpRefs: tmp }), { ok: true, map: good }, 'PS-VALID');
const BAD = [
  ['not an object', [], 'photos_malformed'],
  ['unknown key', { tb_unknown: { state: 'removed' } }, 'photo_unknown_item'],
  ['tmp ref not in this request', { 'tmp:zzzz9999': { state: 'removed' } }, 'photo_unknown_item'],
  ['bad state', { tb_margherita: { state: 'legacy' } }, 'photos_malformed'],
  ['pid malformed', { tb_margherita: { state: 'pid', pid: 'XYZ' } }, 'photos_malformed'],
  ['pid uppercase', { tb_margherita: { state: 'pid', pid: 'A'.repeat(32) } }, 'photos_malformed'],
  ['extra field', { tb_margherita: { state: 'removed', note: 1 } }, 'photos_malformed'],
  ['pid on removed', { tb_margherita: { state: 'removed', pid: P1 } }, 'photos_malformed'],
  ['entry not object', { tb_margherita: 'pid' }, 'photos_malformed'],
  ['proto key', JSON.parse('{"__proto__": {"state":"removed"}}'), 'photo_unknown_item'],
];
for (const [label, v, code] of BAD) {
  const r = S.validateDraftMap(v, { liveKeys: live, tmpRefs: tmp });
  assert.strictEqual(r.ok, false, `PS-INVALID ${label}`);
  assert.strictEqual(r.code, code, `PS-INVALID-CODE ${label}`);
}
ok(`validateDraftMap: absent / empty → null (never stored); pid (32 lowercase hex) | removed only; keys = live or this request's tmp refs (${BAD.length} refusals)`);

// ── 2. rekeyTmp (amendment): a tmp-keyed entry moves to its allocated key; unknown tmp → refusal; a collision → refusal ──
assert.deepStrictEqual(S.rekeyTmp(good, new Map([['tmp:abcd1234', 'tb_calzone']])),
  { ok: true, map: { tb_margherita: { state: 'pid', pid: P1 }, tb_pepperoni: { state: 'removed' }, tb_calzone: { state: 'pid', pid: P2 } } }, 'PS-REKEY');
assert.deepStrictEqual(S.rekeyTmp({ tb_margherita: { state: 'removed' } }, new Map()), { ok: true, map: { tb_margherita: { state: 'removed' } } }, 'PS-REKEY-NOOP');
assert.strictEqual(S.rekeyTmp({ 'tmp:abcd1234': { state: 'removed' } }, new Map()).code, 'photo_unknown_item', 'PS-REKEY-UNMATCHED');
assert.strictEqual(S.rekeyTmp({ 'tmp:abcd1234': { state: 'removed' }, tb_calzone: { state: 'removed' } }, new Map([['tmp:abcd1234', 'tb_calzone']])).code, 'photos_malformed', 'PS-REKEY-COLLISION');
assert.deepStrictEqual(S.rekeyTmp(null, new Map()), { ok: true, map: null }, 'PS-REKEY-NULL');
ok('rekeyTmp: tmp entries move to their allocated keys; unmatched tmp → photo_unknown_item; a collision with an existing key → refused');

// ── 3. states + diff lines (§2.1): legacy = absent; legacy → removed is a real change; only changed keys; sorted ──
assert.deepStrictEqual(S.kindOf(undefined), { kind: 'legacy' });
assert.deepStrictEqual(S.kindOf({ state: 'pid', pid: P1, card: 'x', hero: 'y' }), { kind: 'pid', pid: P1 }, 'PS-KIND-IGNORES-URLS');
assert.deepStrictEqual(S.kindOf({ state: 'removed' }), { kind: 'removed' });
const active = { tb_margherita: { state: 'pid', pid: P1, card: 'u1', hero: 'u2' }, tb_lasagna: { state: 'removed' }, tb_same: { state: 'pid', pid: P3, card: 'u', hero: 'v' } };
const cand = { tb_margherita: { state: 'pid', pid: P2 }, tb_pepperoni: { state: 'removed' }, tb_same: { state: 'pid', pid: P3 } };
assert.deepStrictEqual(S.photoDiffLines(active, cand), [
  { surface: 'item', key: 'tb_lasagna', field: 'photo', old: { kind: 'removed' }, new: { kind: 'legacy' } },
  { surface: 'item', key: 'tb_margherita', field: 'photo', old: { kind: 'pid', pid: P1 }, new: { kind: 'pid', pid: P2 } },
  { surface: 'item', key: 'tb_pepperoni', field: 'photo', old: { kind: 'legacy' }, new: { kind: 'removed' } },
], 'PS-DIFF-LINES');
assert.deepStrictEqual(S.photoDiffLines(null, null), [], 'PS-DIFF-NONE');
ok('photoDiffLines: three-state lines for changed keys only, sorted by key; legacy → removed is a line; URLs never compared');

// ── 4. equality (changesNothingElse / flag-off) + reset map + newly referenced pids ──
assert.strictEqual(S.sameStates(cand, cand), true);
assert.strictEqual(S.sameStates({ tb_same: { state: 'pid', pid: P3 } }, { tb_same: { state: 'pid', pid: P3, card: 'u', hero: 'v' } }), true, 'PS-SAME-IGNORES-URLS');
assert.strictEqual(S.sameStates(null, {}), true, 'PS-SAME-ABSENT-EQ-EMPTY');
assert.strictEqual(S.sameStates(null, { tb_x: { state: 'removed' } }), false, 'PS-SAME-REMOVED-NE-LEGACY');
assert.deepStrictEqual(S.resetMapFromActive(active), { tb_margherita: { state: 'pid', pid: P1 }, tb_lasagna: { state: 'removed' }, tb_same: { state: 'pid', pid: P3 } }, 'PS-RESET-MAP');
assert.strictEqual(S.resetMapFromActive(null), null, 'PS-RESET-ABSENT');
assert.deepStrictEqual(S.newlyReferencedPids({ a: { state: 'pid', pid: P1 } }, { a: { state: 'pid', pid: P1 }, b: { state: 'pid', pid: P2 }, c: { state: 'pid', pid: P2 } }), [P2], 'PS-NEW-PIDS');
assert.deepStrictEqual(S.referencedPids(cand), [P2, P3], 'PS-REFERENCED-SORTED-UNIQUE');
ok('sameStates (URLs ignored, absent == empty, removed ≠ legacy); resetMapFromActive (pid/removed kept, legacy absent); newly / all referenced pids');

// ── 5. the version doc: {schema:1, entries} with resolved public URLs; null when no entries ──
const url = (pid, v) => `https://storage.googleapis.com/tb-public/photos/tb_r/${pid}-${v}.webp`;
assert.deepStrictEqual(S.versionPhotosDoc(cand, url), { schema: 1, entries: {
  tb_margherita: { state: 'pid', pid: P2, card: url(P2, 'card'), hero: url(P2, 'hero') }, tb_pepperoni: { state: 'removed' }, tb_same: { state: 'pid', pid: P3, card: url(P3, 'card'), hero: url(P3, 'hero') } } }, 'PS-VERSION-DOC');
assert.strictEqual(S.versionPhotosDoc(null, url), null, 'PS-VERSION-DOC-ABSENT');
assert.throws(() => S.versionPhotosDoc({ a: { state: 'pid', pid: P1 } }, () => null), /photo_publish_failed/, 'PS-VERSION-DOC-NO-URL-FAILS-CLOSED');
ok('versionPhotosDoc: {schema:1, entries} with resolved card/hero URLs; null when the map is absent; an unresolvable URL fails closed');

// ── 6. parity: catalog/add-product.js keeps an INLINE copy (it requires nothing); it must agree with sameStates everywhere ──
{
  const { samePhotoStates } = require('../catalog/add-product');
  const E = [undefined, null, {}, { k: { state: 'removed' } }, { k: { state: 'pid', pid: P1 } }, { k: { state: 'pid', pid: P1, card: 'c', hero: 'h' } }, { k: { state: 'pid', pid: P2 } }, { j: { state: 'removed' } }, { k: { state: 'removed' }, j: { state: 'pid', pid: P3 } }];
  let pairs = 0;
  for (const a of E) for (const b of E) { pairs++; assert.strictEqual(samePhotoStates(a, b), S.sameStates(a, b), `PS-INLINE-PARITY ${JSON.stringify(a)} ~ ${JSON.stringify(b)}`); }
  ok(`parity: add-product.js's inline samePhotoStates == photo-state.sameStates over ${pairs} pairs`);
}

console.log(`photo-state: OK (${n})`);
