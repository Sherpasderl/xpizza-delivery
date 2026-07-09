// Fixture suite for the canonical availKey() encoder (KDS Phase 2b · KDS_2B_PLAN.md #2/#11).
// availKey is THE single most important 2b correctness dependency: the KDS write, both order-form reads,
// and the server read must all encode a menu key to the SAME /restaurants/{rid}/item_availability/{key}
// string, or a "86" flag silently becomes invisible. This suite proves (1) round-trip reversibility,
// (2) no collisions, (3) RTDB-safe output, (4) stable real-menu keys, and (5) that the four surface copies
// never drift. Run: node avail-key.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CANONICAL = './xpizza-functions/avail-key.js';                 // server consumes this directly
const { availKey, decodeAvailKey } = require(CANONICAL);

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const RTDB_FORBIDDEN = /[.#$/[\]]/;                                  // . # $ / [ ]  — illegal in an RTDB key

// ── 1. Round-trip: decodeAvailKey(availKey(x)) === x for a hostile battery ──
const battery = [
  'plain', 'with space', 'a & b', 'café résumé ñ', 'Pizza N.1', '50% off', 'a/b/c', 'tag#1',
  'arr[0]', 'price$', 'a.b%c/d#e[f]$g', '', ' ', 'emoji 🍕 slice', 'A%2FB', 'A%252FB',
  'Sweet Corn & Calabrian Chili', 'dimsum_01',
];
for (const x of battery) {
  const k = availKey(x);
  assert.strictEqual(decodeAvailKey(k), x, `round-trips: ${JSON.stringify(x)} → ${JSON.stringify(k)} → back`);
}
ok(`round-trip reversible for ${battery.length} hostile inputs (spaces, &, accents, ., %, /, #, [, ], $, empty, unicode)`);

// ── 2. Collision (the R2 catch): distinct raws must never encode to the same key ──
assert.notStrictEqual(availKey('A/B'), availKey('AB'), 'A/B must not collide with AB');
assert.notStrictEqual(availKey('A/B'), availKey('A%2FB'), 'A/B must not collide with the literal string A%2FB');
assert.notStrictEqual(availKey('A.B'), availKey('A#B'), 'A.B must not collide with A#B');
assert.notStrictEqual(availKey('A.B'), availKey('AB'), 'A.B must not collide with AB');
// exhaustive small sweep: every distinct raw → a distinct key (bijective on this set)
const raws = ['A/B', 'AB', 'A%2FB', 'A%252FB', 'A.B', 'A#B', 'A B', 'A%2EB', 'A[B]', 'A$B'];
const keys = raws.map(availKey);
assert.strictEqual(new Set(keys).size, raws.length, 'no two distinct raws share a key (collision-free)');
ok('collision-free: A/B ≠ AB ≠ A%2FB ≠ A.B ≠ A#B; distinct raws → distinct keys');

// ── 3. RTDB-safe: every output contains none of . # $ [ ] / ──
for (const x of [...battery, ...raws, 'Pizza N.1', 'a.b.c', '#hash', '$dollar', 'a/b', '[x]']) {
  const k = availKey(x);
  assert.ok(!RTDB_FORBIDDEN.test(k), `output "${k}" (from ${JSON.stringify(x)}) is RTDB-safe (no . # $ [ ] /)`);
}
ok('RTDB-safe: no output contains . # $ [ ] /');

// ── 4. Real menu keys stable — snapshot so a future encoder edit can't silently change a live key ──
// x_pizza keys = item NAME; la_musa keys = item id/slug (menu-pricing.js contract, per plan #2).
const SNAPSHOT = {
  'Sopressatta Chili Honey':        'Sopressatta%20Chili%20Honey',
  'Sweet Corn & Calabrian Chili':   'Sweet%20Corn%20%26%20Calabrian%20Chili',
  'Cacio e Pepe':                   'Cacio%20e%20Pepe',
  'dimsum_01':                      'dimsum_01',
};
for (const [raw, expected] of Object.entries(SNAPSHOT)) {
  assert.strictEqual(availKey(raw), expected, `stable key: availKey(${JSON.stringify(raw)}) === ${JSON.stringify(expected)}`);
  assert.strictEqual(decodeAvailKey(expected), raw, `stable key round-trips: ${JSON.stringify(expected)} → ${JSON.stringify(raw)}`);
}
ok(`real menu keys snapshot stable (${Object.keys(SNAPSHOT).length}: x_pizza names + la_musa slug)`);

// ── 5. Anti-drift: the client surface copies are BYTE-IDENTICAL to the canonical ──
// If any copy drifts, its surface would encode a key differently and the 86 flag becomes invisible on it.
const canonicalSrc = readFileSync(new URL(CANONICAL, import.meta.url), 'utf8');
const COPIES = ['./xpizza-kitchen/avail-key.js', './xpizza-orders/avail-key.js', './la-musa-orders/avail-key.js'];
for (const copy of COPIES) {
  const src = readFileSync(new URL(copy, import.meta.url), 'utf8');
  assert.strictEqual(src, canonicalSrc, `${copy} is byte-identical to the canonical ${CANONICAL} (no drift)`);
}
ok(`all ${COPIES.length} client surface copies byte-identical to the canonical (KDS + both order forms + server)`);

console.log(`avail-key: OK (${n} cases)`);
