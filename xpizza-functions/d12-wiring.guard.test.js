'use strict';
// R3-FIX D12 — wiring guard for the pickup line ("Recoger en …").
//   1. PROOF: tools/d12-inverse.js turns every D12-touched module back into the D12 base (ebc8564) BYTE-FOR-BYTE, each hunk
//      exactly once — the inverse the older zero-diff pins (order-control-wiring, identity-record-guards) apply first, so
//      it must be exact; a byte inside a hunk, a byte outside every hunk and a duplicated hunk are each detected.
//   2. NO BRAND LITERAL in either order builder (create-order-build.js, materialize.js) or the helper: no restaurant name
//      — derived from the seeded identities, the existing literal maps and the old literal, never hand-listed here — and
//      the pickup text itself lives in pickup-label.js only.
//   3. Both builders name the pickup through pickupLabel; every materialize caller hands it the restaurant's identity.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const stripComments = require('./tools/strip-comments');
const { HUNKS, FILES, unapplyD12 } = require('./tools/d12-inverse');
// D12b (brand display name) landed on top of D12: its exact inverse is reversed FIRST (newest first)
const { unapplyD12b, FILES: D12B_FILES } = require('./tools/d12b-inverse');
// PLAN-H0 (newest; resolve-manual.js) is reversed FIRST, then D12b, so any byte outside the H0 / D12b / D12 seams still fails.
const { unapplyH0Module, FILES: H0_FILES } = require('./tools/h0-inverse');
// BRAND-AGNOSTIC SERVER (r3 §E; newest — materialize.js / pixelpay-confirm.js / resolve-manual.js) is reversed before H0
const readRaw = (f) => { const src = require('./tools/brand-server-inverse').unapplyBrandServerModule(f, require('./tools/stackseq-module-inverse').unapplyStackseqModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'))); return H0_FILES.includes(f) ? unapplyH0Module(f, src) : src; };
const readD12 = (f) => (D12B_FILES.includes(f) ? unapplyD12b(f, readRaw(f)) : readRaw(f));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const BASE = 'ebc8564';
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });

// ── 1. the inverse ──
assert.deepStrictEqual([...FILES].sort(), ['create-order-build.js', 'materialize.js', 'pixelpay-confirm.js', 'resolve-manual.js', 'restaurant-config.js', 'scheduled-release-core.js']);
for (const f of FILES) assert.strictEqual(unapplyD12(f, readD12(f)), baseOf(f), `🔴 ${f} minus the D12 hunks is not ${BASE}:${f} — something beyond the D12 seams changed`);
{
  const f = 'materialize.js'; const src = readD12(f);
  const outside = src.replace('Pure (no db / no I/O)', 'Pure (no db / no IO)');
  assert.notStrictEqual(outside, src, 'premise');
  assert.notStrictEqual(unapplyD12(f, outside), baseOf(f), 'a byte OUTSIDE every hunk is detected');
  const h = HUNKS.find((x) => x.file === f);
  assert.throws(() => unapplyD12(f, src.replace(h.now, h.now.replace('pickupLabel', 'pickupLabeI'))), /occurs 0 times/, 'a byte INSIDE a hunk is detected');
  assert.throws(() => unapplyD12(f, src + h.now), /occurs 2 times/, 'a duplicated hunk is detected');
}
ok(`PROOF: unapplyD12 → ${BASE} byte-for-byte for ${FILES.length} modules (${HUNKS.length} hunks, each once); a byte inside/outside a hunk and a duplicated hunk are each detected`);

// ── 2. no brand literal ──
const { IDENTITIES } = require('./seed_identity');
const names = new Set(['X. Pizza', 'X Pizza']);   // the old literal and x_pizza's config name
for (const id of Object.values(IDENTITIES)) names.add(id.name);
for (const m of read('whatsapp.js').matchAll(/BRAND_BY_RESTAURANT\s*=\s*\{([^}]*)\}/g)) for (const v of m[1].matchAll(/'([^']+)'/g)) names.add(v[1]);
assert.ok(names.has('La Musa') && names.size >= 3, 'premise: the brand names are derived');
const BUILDERS = ['create-order-build.js', 'materialize.js', 'pickup-label.js'];
for (const f of BUILDERS) {
  const code = stripComments(read(f));
  for (const nm of names) assert.ok(!code.includes(nm), `🔴 ${f} carries the brand literal "${nm}"`);
}
for (const f of ['create-order-build.js', 'materialize.js']) assert.ok(!/Recoger en/.test(stripComments(read(f))), `🔴 ${f} writes pickup text itself — it must come from pickupLabel`);
assert.ok(/Recoger en el restaurante/.test(read('pickup-label.js')));
{
  const planted = stripComments(read('materialize.js').replace("pickupLabel(order.restaurant_display_name", "('Recoger en X. Pizza' || pickupLabel)(order.restaurant_display_name"));
  assert.ok([...names].some((nm) => planted.includes(nm)), 'sensitivity: a planted literal is seen');
}
ok(`NO brand literal (${[...names].join(', ')}) and no pickup text in either builder; "Recoger en …" lives in pickup-label.js only`);

// ── 3. wiring ──
assert.ok(/: pickupLabel\(hubSnap\.restaurant_display_name, hubSnap\.restaurant_name\);/.test(read('create-order-build.js')), 'createOrder: from its config snapshot');
assert.ok(/: pickupLabel\(order\.restaurant_display_name, live\.display_name, order\.restaurant_name, live\.name\);/.test(read('materialize.js')), 'materialize: snapshot display → live display → snapshot name → live name');
assert.ok(!/restaurant\.name/.test(stripComments(read('materialize.js')).split('const addressShort')[1].split('updates[`order_tracking')[0]), '🔴 the x_pizza-only RESTAURANT fallback never names a pickup');
const callers = { 'pixelpay-confirm.js': 1, 'resolve-manual.js': 1, 'scheduled-release-core.js': 1 };
for (const [f, want] of Object.entries(callers)) {
  const calls = stripComments(read(f)).split('buildMaterializeUpdates(').slice(1).map((s) => s.slice(0, s.indexOf(')')));
  assert.strictEqual(calls.length, want, `${f}: ${want} materialize call`);
  assert.ok(calls.every((c) => /liveIdentity/.test(c)), `🔴 ${f}: every materialize call hands over the restaurant's identity`);
}
ok('wiring: createOrder names the pickup from its snapshot; materialize from snapshot → live identity; every materialize caller (confirm, manual resolve, scheduled release) passes the identity');

console.log(`\nd12-wiring.guard: OK (${n})`);
