'use strict';
// Portal 2b-1 Task 5 — verify-catalog --vs-active. Run: node catalog/verify-vs-active.test.js
//
// 2a's verifier asked "does the store equal the code?". After the first intended edit that question is
// SUPPOSED to fail, which makes the default mode useless exactly when a merchant starts using the
// portal — and a verifier that always fails is a verifier people stop running.
//
// The post-2b invariant is different: the store must equal what is ACTUALLY PUBLISHED. That is what
// catches the states that matter now — a draft saved but never published (the merchant thinks their
// price is live and it is not), or a publish that landed something other than the draft.
//
// The legacy mode stays, because it is still the right question during the cutover and after a
// rollback-to-code.
const assert = require('assert');
const { assertStoreCodeParity, assertStoreMatchesActive } = require('./publish-parity');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const { EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const builtFrom = (rid, mutate) => {
  const s = JSON.parse(JSON.stringify(buildSourceFromCode(rid)));
  if (mutate) mutate(s);
  const i = sourceToBuildInputs(s);
  return { ...buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }), extras: i.extras };
};
const codeBuilt = (rid) => ({ ...buildCatalogV2(rid), extras: EXTRAS_BY_RESTAURANT[rid] || {} });
const setPrice = (key, val) => (s) => { const it = s.items.find((x) => x.key === key); it.price = val; it.display.price = val; };

// ── (1) THE POST-EDIT WORLD: diverged from code, matching what is published ────────────────────
for (const [rid, key] of [['x_pizza', 'Margherita'], ['la_musa', 'dimsum_01']]) {
  const edited = builtFrom(rid, setPrice(key, 4321));
  // the merchant published that edit, so the ACTIVE version is the edited build
  assert.strictEqual(assertStoreMatchesActive(rid, edited, edited), true, `${rid}: store == active passes even though both differ from code`);
  // ...and the legacy question now fails, which is exactly why the new mode exists
  assert.throws(() => assertStoreCodeParity(rid, edited, codeBuilt(rid)), /parity_mismatch/,
    `${rid}: the legacy store==code check is EXPECTED to fail after an intended edit — that is what makes it useless post-2b`);
}
ok('after an intended edit, store == ACTIVE passes on both brands while store == code fails (which is why the mode exists)');

// ── (2) THE STATES IT HAS TO CATCH ────────────────────────────────────────────────────────────
{
  const rid = 'x_pizza';
  const active = builtFrom(rid);                                  // what is live
  // A draft saved but never published. The merchant believes their price is live; it is not. This is
  // the single most likely real-world failure of a portal, and the default mode cannot see it at all.
  const savedNotPublished = builtFrom(rid, setPrice('Margherita', 999));
  assert.throws(() => assertStoreMatchesActive(rid, savedNotPublished, active), /store_vs_active_mismatch/,
    'a draft saved but never published must be caught — the merchant thinks it is live');
  try { assertStoreMatchesActive(rid, savedNotPublished, active); } catch (e) {
    assert.ok(/menu_hash/.test(e.message), 'and the message must name WHAT differs, not merely that something did');
    assert.ok(/x_pizza/.test(e.message), 'and which restaurant');
    assert.ok(/store|active/.test(e.message), 'and which side is which');
  }
  // A published version whose EXTRAS differ — extras are priced lines too, and a price-only check misses them
  const extrasDiffer = builtFrom(rid, (s) => { s.extras[0].price += 40; });
  assert.throws(() => assertStoreMatchesActive(rid, extrasDiffer, active), /extras_hash/, 'an extras divergence is caught');
  // ...and one where only DISPLAY differs: no price moved, but customers see something else
  const displayDiffers = builtFrom(rid, (s) => { s.items.find((i) => i.key === 'Margherita').display.desc = 'changed'; });
  assert.throws(() => assertStoreMatchesActive(rid, displayDiffers, active), /display_hash/, 'a display-only divergence is caught');
  // ...and one where only the GATES differ: nothing visible changed, but what is orderable did
  const gatesDiffer = builtFrom(rid, (s) => { s.structure.weekend_only_cats = []; });
  assert.throws(() => assertStoreMatchesActive(rid, gatesDiffer, active), /structure/, 'a gate-only divergence is caught');
  ok('it catches a saved-but-unpublished draft, and divergence in extras, display and gates — not just prices');
}

// ── (3) NON-VACUITY — it passes when it should, and is not a function that always throws ───────
{
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.strictEqual(assertStoreMatchesActive(rid, builtFrom(rid), builtFrom(rid)), true, `${rid}: identical builds pass`);
    // property order is not content: a re-serialized build must still match
    const reordered = builtFrom(rid);
    reordered.items = reordered.items.map((i) => ({ display: i.display, price: i.price, key: i.key, ...(i.has_photo !== undefined ? { has_photo: i.has_photo } : {}) }));
    assert.strictEqual(assertStoreMatchesActive(rid, reordered, builtFrom(rid)), true, `${rid}: property order does not fake a mismatch`);
  }
  ok('identical builds pass on both brands, and property order does not fake a mismatch');
}

// ── (4) THE LEGACY MODE IS UNCHANGED ──────────────────────────────────────────────────────────
// It is still the right question during the cutover and after a rollback-to-code, so 2b must not
// quietly retune it. Same inputs, same verdict, same error name as 2a.
{
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.strictEqual(assertStoreCodeParity(rid, builtFrom(rid), codeBuilt(rid)), true, `${rid}: store == code still passes at the seeded state`);
    assert.throws(() => assertStoreCodeParity(rid, builtFrom(rid, setPrice(rid === 'x_pizza' ? 'Margherita' : 'dimsum_01', 4321)), codeBuilt(rid)),
      /parity_mismatch/, `${rid}: and still fails, under its own error name, on a divergence`);
  }
  ok('the legacy store == code mode is behaviourally unchanged (still the right question for the cutover and rollback-to-code)');
}

// ── (5) THE CLI WIRING. The tool is owner-run; no test executes it, so this is structural. ─────
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'verify-catalog.js'), 'utf8')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
  assert.ok(/const VS_ACTIVE = process\.argv\.includes\('--vs-active'\)/.test(src), '--vs-active must be a real flag');
  assert.ok(/\bassertStoreMatchesActive\b/.test(src) && /\{[^}]*assertStoreMatchesActive[^}]*\}\s*=\s*require/.test(src),
    'the CLI must import AND use the new comparator (node --check cannot see a missing import)');
  assert.ok(/\bassertStoreCodeParity\b/.test(src), 'and must keep the legacy comparator for the default mode');
  // The two modes must be EXCLUSIVE. Running the code check in --vs-active mode would fail on every
  // intended edit, which is the exact uselessness this mode exists to remove.
  // Exact call text, not a loose proximity match. A near-miss regex passes against a CLI that compares
  // the store to ITSELF, or that runs both modes — neither of which any test here can execute.
  assert.ok(src.includes('assertStoreMatchesActive(rid, storeBuilt, built)'),
    'the store must be compared against the ACTIVE VERSION build, not against itself');
  assert.ok(src.includes('assertStoreCodeParity(rid, storeBuilt, codeBuilt)'), 'and the legacy mode against the code build');
  assert.ok(/if \(VS_ACTIVE\) \{[\s\S]{0,500}?assertStoreMatchesActive[\s\S]{0,200}?\} else \{[\s\S]{0,300}?assertStoreCodeParity/.test(src),
    'the modes must be an if/else — running both would fail on every intended edit');
  // ...and the served-vs-code loop must be skipped in --vs-active mode, for the same reason
  assert.ok(src.includes("for (const rid of (VS_ACTIVE ? [] : ['x_pizza', 'la_musa']))"),
    'the served-vs-code loop must be conditioned on the mode — after an edit it fails by design');
  assert.ok(/const \{ built, versionId \} = await activeBuiltOf\(rid\)/.test(src), 'the active build must come from the pointed version');
  assert.ok(/previewVersion|readVersionDocs/.test(src), 'and --vs-active must read the ACTIVE PUBLISHED version to compare against');
  ok('the CLI exposes --vs-active, imports and uses the new comparator, and the two modes are exclusive');
}
console.log(`verify-vs-active: OK (${n})`);
