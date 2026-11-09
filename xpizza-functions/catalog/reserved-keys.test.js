'use strict';
// S1c (PLAN-portal-item-edit r6 §2.2; design D4c-grill/item-s1/S1c-DESIGN.md D1/D2 + the advisor's ruling) — THE RESERVED-KEY SET.
// One doc per restaurant, restaurants/{rid}/meta/reserved_keys = { v: 1, keys: { <b64url(key)>: { dish?: <first version>,
// extra?: <first version> } } }. Add-only: a union never removes or rewrites an entry (a kind's first version is kept). The
// key codec is the identity registry's own. Fail-closed at the Firestore doc limit: 503 reserved_keys_full, nothing written.
// Run: node catalog/reserved-keys.test.js
//   new module catalog/reserved-keys.js: emptyReserved() · readReserved(data) · unionReserved(doc, { dish, extra }, versionId)
//     → { doc, added } · reservedKeySet(doc) → Map(key → kinds) · assertWithinLimit(doc) · RESERVED_LIMIT_BYTES
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

// ── the 1 MB limit: fail closed ──
{
  assert.ok(Number.isInteger(RK.RESERVED_LIMIT_BYTES) && RK.RESERVED_LIMIT_BYTES <= 1048576 - 1024, 'RK-LIMIT below the Firestore doc limit with headroom for the doc name');
  const small = RK.unionReserved(RK.emptyReserved(), { dish: ['A'], extra: [] }, 'v1').doc;
  assert.doesNotThrow(() => RK.assertWithinLimit(small));
  const many = []; for (let i = 0; many.join('').length < RK.RESERVED_LIMIT_BYTES; i++) many.push(`Producto de prueba número ${i}`);
  const big = RK.unionReserved(RK.emptyReserved(), { dish: many, extra: [] }, 'v1').doc;
  let err = null; try { RK.assertWithinLimit(big); } catch (e) { err = e; }
  assert.ok(err && /reserved_keys_full/.test(err.message) && err.status === 503, 'RK-FULL past the limit: 503 reserved_keys_full');
  ok('past the limit the set refuses (503 reserved_keys_full) rather than drop a key');
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
console.log(`\nreserved-keys: OK (${n})`);
