'use strict';
// S2b (PLAN-structure-S2b-r3 §3; Codex r2 P1-4) — the builder takes an extra's key from its server-recorded entry, losslessly: a minted
// reuse and a renamed extra build, validate and round-trip through candidateSource with their KEPT keys, in both key modes; an extra whose
// key does not derive from its display and has no matching active entry is still refused (today's invariant). Real sources, the real
// allocator, the real build. Run: node catalog/s2b-build.test.js
const assert = require('assert');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate, candidateSource, assertCandidateValid, assertBuiltValid } = require('./candidate-validate');
const { validateSource } = require('./source-store');
const { allocateExtras } = require('./extras-allocate');
const { slugify } = require('./add-product');
let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const MODE = { x_pizza: 'name', la_musa: 'id' };
const throwsMsg = (fn, re) => { try { fn(); } catch (e) { assert.ok(re.test(String(e.message)), `refused, but not as expected: ${e.message}`); return; } assert.fail(`not refused (${re})`); };

// a retired extra re-added under a fresh minted key (the real allocator, the dark switch ON)
function minted(rid) {
  const live = buildSourceFromCode(rid); const gone = live.extras[0];
  live.extras = live.extras.slice(1);
  if (Array.isArray(live.structure.extra_order)) live.structure.extra_order = live.structure.extra_order.filter((k) => k !== gone.key);
  for (const f of ['extras_by_category', 'extras_by_item']) if (live.structure[f]) for (const v of Object.values(live.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(gone.key); if (i >= 0) v.splice(i, 1); }
  if (Array.isArray(live.structure.redeem_eligible_extras)) live.structure.redeem_eligible_extras = live.structure.redeem_eligible_extras.filter((k) => k !== gone.key);
  const derived = rid === 'la_musa' ? slugify(gone.display.name) : gone.display.name;
  const d = clone(live); d.extras.push({ ref: 'tmp:reuse-0001', price: gone.price, display: { name: gone.display.name, cat: gone.display.cat, price: gone.price } });
  if (Array.isArray(d.structure.extra_order)) d.structure.extra_order.push('tmp:reuse-0001');
  let k = 0; const src = allocateExtras({ incoming: d, activeExtras: live.extras, activeItems: live.items, keyMode: MODE[rid], reserved: new Map([[derived, ['extra']]]), switchOn: true, mintExtras: true, mint: { newKey: () => `i_aaaaaaaaaab${'cdefg'[k++]}` } }).source;
  if (Array.isArray(src.structure.extra_order)) src.structure.extra_order = src.structure.extra_order.map((x) => (x === 'tmp:reuse-0001' ? src.extras[src.extras.length - 1].key : x));
  return src;
}
// a renamed extra: its key kept, the rename recorded { display_id, field: 'name' }
function renamed(rid) {
  const s = clone(buildSourceFromCode(rid)); const x = s.extras[0];
  x.display.name = 'Nombre Nuevo S2b';
  s.frozen_extra_keys = { [x.key]: { display_id: String(x.display.id), field: 'name' } };
  return { s, key: x.key };
}

for (const rid of ['x_pizza', 'la_musa']) {
  cell(`BUILD-MINTED ${rid}: a minted reuse with its entry validates, builds under its KEPT key and round-trips through candidateSource`, () => {
    const src = minted(rid); const row = src.extras.find((e) => /^i_/.test(e.key));
    assert.ok(row, 'premise: a minted row');
    validateSource(src, rid);
    const { built } = buildSourceCandidate(rid, src);
    const b = built.extras.find((e) => e.key === row.key);
    assert.ok(b && b.display.name === row.display.name, 'built under its minted key with its name');
    assert.deepStrictEqual(built.frozen_extra_keys, src.frozen_extra_keys, 'the map travels with the build');
    assertBuiltValid(rid, built, 's2b-build');
    assertCandidateValid(rid, candidateSource(rid, { items: built.items, extras: built.extras, structure: built.structure, key_mode: built.key_mode, frozen_keys: built.frozen_keys, frozen_extra_keys: built.frozen_extra_keys }), 's2b-build round trip');
  });
  cell(`BUILD-RENAMED ${rid}: a renamed extra with its entry validates and builds under its kept key`, () => {
    const { s, key } = renamed(rid);
    validateSource(s, rid);
    const { built } = buildSourceCandidate(rid, s);
    assert.ok(built.extras.some((e) => e.key === key && e.display.name === 'Nombre Nuevo S2b'));
  });
  if (rid === 'x_pizza') cell('BUILD-REFUSED x_pizza: a minted / renamed row WITHOUT its entry — or with an entry for another display id — is still refused (today\'s invariant: name mode derives the key from the name)', () => {
    const src = minted(rid); const bare = clone(src); delete bare.frozen_extra_keys;
    throwsMsg(() => validateSource(bare, rid), /does not match its display record/);
    const wrong = clone(src); const k = Object.keys(wrong.frozen_extra_keys)[0]; wrong.frozen_extra_keys[k].display_id = 'nope';
    throwsMsg(() => validateSource(wrong, rid), /does not match its display record/);
    const { s } = renamed(rid); const r = clone(s); delete r.frozen_extra_keys; throwsMsg(() => validateSource(r, rid), /does not match its display record/);
  });
  if (rid === 'la_musa') cell('BUILD-ID-MODE la_musa: a minted row\'s display id IS its key, so the source invariant alone accepts it — the entry is enforced by the ONE new-extra validator (s2b-alloc VALIDATE) and drives labelRequired (§4)', () => {
    const bare = clone(minted(rid)); delete bare.frozen_extra_keys;
    validateSource(bare, rid);
  });
}
cell('BUILD-SHAPE: a malformed map is refused by validateSource', () => {
  const s = clone(buildSourceFromCode('la_musa')); s.frozen_extra_keys = { x: { display_id: 1 } };
  throwsMsg(() => validateSource(s, 'la_musa'), /frozen_extra_keys/);
});

if (fails.length) { console.error(`s2b-build FAILED ${fails.length} cell(s): ${fails.join(' | ')}`); process.exit(1); }
console.log(`s2b-build: OK (${n})`);
