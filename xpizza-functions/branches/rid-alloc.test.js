'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.3) — branch rid allocation + name reservation keys, pure.
//   rid = base + '_' + slug + suffix; base = brand id without leading/trailing '_', ≤ 20 (empty → 'b'); slug = the location name
//   NFKD-folded to ASCII, lowercased, non-[a-z0-9] runs → '_', trimmed, ≤ 15 (empty → 'sucursal'); suffix '' | _2 … _999.
//   Every candidate is valid under BOTH grammars (F1 isBrandId and the registry RID_RE) and the sequence is deterministic.
// Run: node branches/rid-alloc.test.js
const assert = require('assert');
const A = require('./rid-alloc');
const { isBrandId } = require('../brands/brand-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;   // the registry / portal grammar (catalog/restaurant-registry.js:30)
const bothGrammars = (r) => isBrandId(r) && RID_RE.test(r);

assert.deepStrictEqual(A.ridCandidates('tb_brand', 'Centro', 3), ['tb_brand_centro', 'tb_brand_centro_2', 'tb_brand_centro_3']);
assert.strictEqual(A.ridCandidates('x_pizza', 'Circunvalación Norte')[0], 'x_pizza_circunvalacion');
assert.strictEqual(A.ridCandidates('x_pizza', 'Circunvalación Norte')[0].length <= 40, true);
assert.deepStrictEqual(A.ridCandidates('tb_brand', 'Centro', 3), A.ridCandidates('tb_brand', 'Centro', 3), 'deterministic');
ok('the candidate sequence: base_slug, base_slug_2, … (deterministic; accents folded)');

assert.strictEqual(A.ridCandidates('tb_brand', '🍕🍕')[0], 'tb_brand_sucursal', 'an empty slug → sucursal');
assert.strictEqual(A.ridCandidates('tb_brand', '---')[0], 'tb_brand_sucursal');
assert.strictEqual(A.ridCandidates('_tb', 'Centro')[0], 'tb_centro', 'a leading underscore is stripped from the base');
assert.strictEqual(A.ridCandidates('___', 'Centro')[0], 'b_centro', 'an all-underscore base → b');
const long = 'a'.repeat(40);
const c = A.ridCandidates(long, 'Sucursal Gran Boulevard del Norte', 999);
assert.strictEqual(c[0], `${'a'.repeat(20)}_sucursal_gran_b`);
assert.ok(c.every((r) => r.length <= 40), 'every candidate ≤ 40 incl. the _999 suffix');
assert.strictEqual(c[998], `${'a'.repeat(20)}_sucursal_gran_b_999`);
assert.strictEqual(A.ridCandidates('tb_brand', 'Norte_', 1)[0], 'tb_brand_norte', 'trailing separators trimmed from the slug');
ok('edges: empty slug → sucursal; leading/all underscore base; 40-char brand id truncated; suffix space kept; ≤ 40 always');

// property: adversarial brand ids × names — every candidate valid under BOTH grammars, unique within the sequence
const brands = ['tb_brand', '_tb', 'x_pizza', 'a', 'z9', '0a', 'a'.repeat(40), '_'.repeat(5) + 'b', 'b_____c', 'tb__x__'];
const names = ['Centro', 'Ñandú', '🍕', '', ' ', 'Sucursal   Norte', '12', '-_-', 'A'.repeat(60), 'café — bar', 'İstanbul', 'ß', '中心'];
let checked = 0;
for (const b of brands) for (const nm of names) {
  const seq = A.ridCandidates(b, nm, 50);
  assert.strictEqual(new Set(seq).size, seq.length, `unique: ${b}/${nm}`);
  for (const r of seq) { assert.ok(bothGrammars(r), `both grammars: ${JSON.stringify(r)} (${b}/${nm})`); checked++; }
}
ok(`property: ${checked} candidates over adversarial brand ids × names — all valid under F1 AND the registry grammar, unique`);

// name reservation keys: case / accent / space-insensitive, RTDB-safe, non-empty
assert.strictEqual(A.nameKey('Centro'), A.nameKey('  CENTRO '), 'case + outer space insensitive');
assert.strictEqual(A.nameKey('Circunvalación'), A.nameKey('Circunvalacion'), 'accent insensitive');
assert.strictEqual(A.nameKey('Gran  Plaza'), A.nameKey('gran plaza'), 'inner space runs collapse');
assert.notStrictEqual(A.nameKey('Centro'), A.nameKey('Centro 2'));
for (const nm of ['🍕', '中心', 'a.b#c$d[e]f/g', '']) {
  const k = A.nameKey(nm);
  assert.ok(typeof k === 'string' && k.length >= 1 && k.length <= 64 && !/[.#$[\]/]/.test(k), `RTDB-safe non-empty key for ${JSON.stringify(nm)}: ${k}`);
}
assert.notStrictEqual(A.nameKey('🍕'), A.nameKey('🍔'), 'symbol-only names do not collide');
ok('nameKey: case / accent / space-insensitive; RTDB-safe; symbol-only names hashed (no collision)');

console.log(`rid-alloc: OK (${n})`);
