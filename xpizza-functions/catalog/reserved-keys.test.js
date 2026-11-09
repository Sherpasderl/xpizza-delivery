'use strict';
// S1c (PLAN-portal-item-edit r6 §2.2; design D4c-grill/item-s1/S1c-DESIGN.md D1/D2 + the advisor's ruling) — THE RESERVED-KEY SET.
// One doc per restaurant, restaurants/{rid}/meta/reserved_keys = { v: 1, keys: { <b64url(key)>: { dish?: <first version>,
// extra?: <first version> } } }. Add-only: a union never removes or rewrites an entry (a kind's first version is kept). The
// key codec is the identity registry's own. Fail-closed at the Firestore doc limit: 503 reserved_keys_full, nothing written.
// Run: node catalog/reserved-keys.test.js
//   new module catalog/reserved-keys.js: emptyReserved() · readReserved(data) · unionReserved(doc, { dish, extra }, versionId)
//     → { doc, added } · reservedKeySet(doc) → Map(key → kinds) · assertWithinLimit(doc) · RESERVED_MAX_ENTRIES
const assert = require('assert');
const RK = require('./reserved-keys');
const { encodeKey } = require('./identity-registry');

let n = 0;
const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── shape + codec ──
{
  assert.deepStrictEqual(RK.emptyReserved(), { v: 1, keys: {} }, 'RK-EMPTY');
  assert.deepStrictEqual(RK.readReserved(undefined), { v: 1, keys: {} }, 'RK-ABSENT an absent doc reads as empty');
  const keys = ['Carnivora', 'N.Y. Plain Slice', 'a/b', '50% off', 'Piña', 'i_abcdefghijkl'];
  const { doc } = RK.unionReserved(RK.emptyReserved(), { dish: keys, extra: [] }, 'v1');
  for (const k of keys) assert.ok(Object.prototype.hasOwnProperty.call(doc.keys, encodeKey(k)), `RK-CODEC ${k} is stored under the registry's own encoding`);
  assert.deepStrictEqual([...RK.reservedKeySet(doc).keys()].sort(), [...keys].sort(), 'RK-CODEC every key decodes back exactly');
  ok('empty / absent shapes; keys stored under the registry codec and decoded exactly (., /, %, accents)');
}

// ── malformed stored doc: fail closed ──
{
  for (const [bad, label] of [[{ v: 2, keys: {} }, 'unknown version'], [{ v: 1 }, 'no keys map'], [{ v: 1, keys: [] }, 'keys not a map'],
    [{ v: 1, keys: { [encodeKey('A')]: { dish: 5 } } }, 'non-string version'], [{ v: 1, keys: { [encodeKey('A')]: {} } }, 'entry with no kind'],
    [{ v: 1, keys: { '***': { dish: 'v1' } } }, 'undecodable key'], [{ v: 1, keys: { [encodeKey('A')]: { dish: 'v1', other: 'v1' } } }, 'unknown kind']]) {
    assert.throws(() => RK.readReserved(bad), /reserved_keys_malformed/, `RK-MALFORMED ${label} is refused, never read as empty`);
  }
  ok('a malformed stored doc is refused (reserved_keys_malformed), never treated as empty');
}

// ── union: add-only, idempotent, first version kept per kind ──
{
  const a = RK.unionReserved(RK.emptyReserved(), { dish: ['Carnivora', 'Pepperoni'], extra: ['Pepperoni', 'Queso'] }, 'v1');
  assert.strictEqual(a.added, 4, 'RK-UNION counts (key, kind) additions');
  const entry = (d, k) => d.keys[encodeKey(k)];
  assert.deepStrictEqual(entry(a.doc, 'Pepperoni'), { dish: 'v1', extra: 'v1' }, 'RK-UNION one key may be both a dish and an extra');
  const before = clone(a.doc);
  const b = RK.unionReserved(a.doc, { dish: ['Carnivora', 'Hawaiana'], extra: [] }, 'v2');
  assert.deepStrictEqual(a.doc, before, 'RK-PURE the input doc is not mutated');
  assert.deepStrictEqual(entry(b.doc, 'Carnivora'), { dish: 'v1' }, 'RK-FIRST a re-seen key keeps its first version');
  assert.deepStrictEqual(entry(b.doc, 'Hawaiana'), { dish: 'v2' }, 'RK-FIRST-NEW');
  assert.strictEqual(b.added, 1, 'RK-COUNT only the new (key, kind) is counted');
  const c = RK.unionReserved(b.doc, { dish: [], extra: [] }, 'v3');
  assert.strictEqual(c.added, 0, 'RK-ADDONLY'); assert.deepStrictEqual(c.doc, b.doc, 'RK-ADDONLY a version without a key never removes it (retired / deleted stays reserved)');
  const d = RK.unionReserved(b.doc, { dish: ['Carnivora', 'Hawaiana'], extra: ['Pepperoni', 'Queso'] }, 'v9');
  assert.strictEqual(d.added, 0, 'RK-IDEMPOTENT'); assert.deepStrictEqual(d.doc, b.doc, 'RK-IDEMPOTENT');
  assert.throws(() => RK.unionReserved(b.doc, { dish: [''], extra: [] }, 'v4'), /identity_bad_legacy_key|reserved_keys_bad_key/, 'RK-BADKEY an empty key is refused');
  assert.throws(() => RK.unionReserved(b.doc, { dish: ['A'], extra: [] }, ''), /reserved_keys_bad_version/, 'RK-BADVERSION');
  ok('union is add-only, idempotent and pure; a kind keeps its first version; a key may be dish and extra');
}

// ── the size cap (codex S1c r1 P2-1, advisor: a conservative ENTRY count, no Firestore-size math): fail closed ──
{
  assert.strictEqual(RK.RESERVED_MAX_ENTRIES, 5000, 'RK-LIMIT 5,000 keys (real menus hold ~100)');
  const keys = (count) => Array.from({ length: count }, (_, i) => `Producto ${i}`);
  const at = RK.unionReserved(RK.emptyReserved(), { dish: keys(5000), extra: [] }, 'v1').doc;
  assert.doesNotThrow(() => RK.assertWithinLimit(at), 'RK-LIMIT exactly at the cap is accepted');
  const over = RK.unionReserved(at, { dish: ['Uno Más'], extra: [] }, 'v2').doc;
  let err = null; try { RK.assertWithinLimit(over); } catch (e) { err = e; }
  assert.ok(err && /reserved_keys_full/.test(err.message) && err.status === 503, 'RK-FULL one past the cap: 503 reserved_keys_full');
  ok('past 5,000 keys the set refuses (503 reserved_keys_full) rather than drop a key');
}

// ── D3 (owner 2026-11-09): RENAMES only — a renamed item may not take another item's reserved key; additions are not judged ──
{
  const set = RK.reservedKeySet(RK.unionReserved(RK.emptyReserved(), { dish: ['Carnivora', 'Pizza Vieja', 'Hawaiana'], extra: ['Queso Extra'] }, 'v1').doc);
  const it = (key, id, name) => ({ key, display: { id, name } });
  const active = [it('Carnivora', 1, 'Carnivora'), it('Hawaiana', 2, 'Hawaiana')];
  const judge = (items) => RK.renameConflicts({ items, activeItems: active, reserved: set }).map((c) => c.key);
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'Carnivora'), it('Hawaiana', 2, 'Hawaiana')]), [], 'RKR-UNCHANGED untouched names are never judged');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'Pizza Vieja')]), ['Carnivora'], 'RKR-EXACT a rename onto another reserved key');
  assert.deepStrictEqual(judge([it('Carnivora', 1, '  pizza   VIEJA ')]), ['Carnivora'], 'RKR-NORMALIZED a rename onto a reserved key after folding');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'Queso Extra')]), ['Carnivora'], 'RKR-EXTRA an extra\'s reserved key counts');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'Carnívora')]), [], 'RKR-OWN a rename that folds to the item\'s OWN key is allowed');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'i_abcdefghijk2')]), ['Carnivora'], 'RKR-OPAQUE a rename into the opaque syntax');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'Carnivora Suprema')]), [], 'RKR-FREE a rename onto an unreserved name');
  assert.deepStrictEqual(judge([it('Pizza Vieja', 9, 'Pizza Vieja'), it('i_aaaaaaaaaaaa', 10, 'Hawaiana')]), [], 'RKR-ADDITION additions (no active item with that display.id) are never judged (owner)');
  assert.deepStrictEqual(judge([it('Hawaiana', 1, 'Pizza Vieja')]), ['Hawaiana'], 'RKR-ID matched by display.id: id 1 now carries another name');
  ok('D3: only renames are judged — exact, normalized, an extra key, the opaque syntax; own key and additions are free');
}
// ── codex S1c r1 P2-3: a NAME that looks like a minted key is refused — additions and renames (its own key included),
//    always (switch-independent); an untouched existing name is never judged ──
{
  const it = (key, id, name) => ({ key, display: { id, name } });
  const active = [it('Carnivora', 1, 'Carnivora'), it('i_aaaaaaaaaaab', 2, 'Pizza Nueva')];
  const judge = (items) => RK.opaqueNameProblems({ items, activeItems: active }).map((c) => c.key || c.ref);
  assert.deepStrictEqual(judge([...active]), [], 'RKO-UNTOUCHED untouched names are not judged');
  assert.deepStrictEqual(judge([{ ref: 'tmp:x1', display: { name: 'i_abcdefghijk2' } }]), ['tmp:x1'], 'RKO-ADDITION a new product named like a minted key');
  assert.deepStrictEqual(judge([{ ref: 'tmp:x2', display: { name: '  I_ABCDEFGHIJK2 ' } }]), ['tmp:x2'], 'RKO-ADDITION-CASE case and spaces do not help');
  assert.deepStrictEqual(judge([it('Carnivora', 1, 'i_zzzzzzzzzzzz')]), ['Carnivora'], 'RKO-RENAME a rename into the syntax');
  assert.deepStrictEqual(judge([it('i_aaaaaaaaaaab', 2, 'i_aaaaaaaaaaab')]), ['i_aaaaaaaaaaab'], 'RKO-OWN a rename to its OWN minted key is refused too');
  assert.deepStrictEqual(judge([{ ref: 'tmp:x3', display: { name: 'i_short' } }, it('Carnivora', 1, 'Pizza i_aaaaaaaaaaab')]), [], 'RKO-FREE names merely containing the prefix are fine');
  ok('a name in the minted-key syntax is refused for additions and renames (own key too); untouched names are not judged');
}
console.log(`\nreserved-keys: OK (${n})`);
