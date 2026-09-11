'use strict';
// Portal 2a Task 4 — the PRE-FLIP PARITY GATE. Run: node catalog/publish-parity.test.js
//
// THE CORNERSTONE. The cutover's entire safety claim is "publishing from the store is a provable
// no-op". That is only true if something explicitly compares what the STORE builds against what the
// CODE builds, and refuses the flip unless they are canonically identical.
//
// publishVersion's own integrity check is necessary but NOT sufficient for this: it proves the version
// was written and read back intact — self-consistency — and a store carrying a wrong-but-positive
// price is perfectly self-consistent. It would publish, hash cleanly, verify cleanly, and charge the
// wrong price. The explicit code-vs-store compare is the only thing standing there.
const assert = require('assert');
const { catalogDescriptor, assertStoreCodeParity } = require('./publish-parity');
const { integrityDescriptor } = require('./catalog-integrity');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2, formSource } = require('./form-menu-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const codeBuilt = (rid) => ({
  ...buildCatalogV2(rid, { formSource: formSource(rid), priceTable: MENU_BY_RESTAURANT[rid] }),
  extras: EXTRAS_BY_RESTAURANT[rid],
});
const storeBuilt = (rid, mutate) => {
  const source = buildSourceFromCode(rid);
  if (mutate) mutate(source);
  const { priceTable, formData, extras } = sourceToBuildInputs(source);
  return { ...buildCatalogV2(rid, { formData, priceTable }), extras };
};

// ── (a) THE NO-OP PROOF: code-built descriptor == store-built descriptor, both brands ───────────
for (const rid of ['x_pizza', 'la_musa']) {
  const c = catalogDescriptor(rid, codeBuilt(rid));
  const s = catalogDescriptor(rid, storeBuilt(rid));
  assert.deepStrictEqual(s, c, `${rid}: the store-built descriptor must equal the code-built one`);
  assert.doesNotThrow(() => assertStoreCodeParity(rid, storeBuilt(rid), codeBuilt(rid)), `${rid}: the gate passes on an unmutated store`);
  ok(`${rid}: code-built == store-built descriptor (counts ${c.item_count}+${c.extra_count}, both full hashes, structure) — the no-op proof`);
}

// ── (b) THE GATE BLOCKS a non-identical cutover — every drift class ─────────────────────────────
for (const [label, mutate] of [
  ['a changed price', (s) => { s.items[0].price = s.items[0].price + 1; s.items[0].display = { ...s.items[0].display, price: s.items[0].price }; }],
  ['an added item', (s) => { s.items.push({ key: 'Ghost', price: 100, display: { id: 999, cat: s.structure.categories[0].id, name: 'Ghost', price: 100 } }); s.structure.item_order.push('Ghost'); }],
  ['a removed item', (s) => { const k = s.items.pop().key; s.structure.item_order = s.structure.item_order.filter((x) => x !== k); }],
  ['a changed extra price', (s) => { s.extras[0].price += 1; s.extras[0].display = { ...s.extras[0].display, price: s.extras[0].price }; }],
  ['a reordered menu', (s) => { s.structure.item_order = [s.structure.item_order[1], s.structure.item_order[0], ...s.structure.item_order.slice(2)]; }],
  ['a changed display name', (s) => { s.items[0].display = { ...s.items[0].display, desc: 'edited in the portal' }; }],
]) {
  assert.throws(() => assertStoreCodeParity('x_pizza', storeBuilt('x_pizza', mutate), codeBuilt('x_pizza')),
    /parity_mismatch/, `${label} MUST block the flip`);
}
ok('the gate THROWS parity_mismatch on every drift class: price, added/removed item, extra price, reorder, display edit');
{
  // and the message must NAME what diverged — an operator aborting a cutover needs to know why
  let msg = '';
  try { assertStoreCodeParity('x_pizza', storeBuilt('x_pizza', (s) => { s.items[0].price += 1; s.items[0].display = { ...s.items[0].display, price: s.items[0].price }; }), codeBuilt('x_pizza')); }
  catch (e) { msg = e.message; }
  assert.ok(/menu_hash/.test(msg), `the mismatch must name the diverging field, got: ${msg}`);
  ok('the parity_mismatch names the diverging field (an aborting operator is told what differed)');
}

// ── (c) 🔒 WHY THE EXPLICIT GATE IS NEEDED — publishVersion's self-integrity does NOT catch this ──
{
  const rid = 'x_pizza';
  const wrong = storeBuilt(rid, (s) => { s.items[0].price = 12345; s.items[0].display = { ...s.items[0].display, price: 12345 }; });
  const wrongTables = {}; for (const i of wrong.items) wrongTables[i.key] = i.price;
  // publishVersion verifies by recomputing the descriptor from what it WROTE and comparing to the
  // record it wrote — self-consistent by construction. A wrong-but-positive price sails through.
  const selfDescriptor = integrityDescriptor(wrongTables, wrong.extras);
  assert.doesNotThrow(() => {
    const reread = integrityDescriptor(wrongTables, wrong.extras);          // what the read-back verify computes
    assert.deepStrictEqual(reread, selfDescriptor);                          // ...and it agrees with itself
  }, 'self-integrity is satisfied by a wrong-but-positive price — it only proves the write round-tripped');
  // the 1a value guard does not catch it either: 12345 is a perfectly valid positive integer
  assert.ok(Number.isInteger(12345) && 12345 > 0, 'and the value guard sees nothing wrong with it');
  // ONLY the explicit code-vs-store compare stops it
  assert.throws(() => assertStoreCodeParity(rid, wrong, codeBuilt(rid)), /parity_mismatch/,
    'the explicit gate is the ONLY thing that catches a wrong-but-positive price');
  ok('documented: self-integrity AND the value guard both pass a wrong-but-positive price — only the explicit code-vs-store gate blocks it');
}

// ── canonical: property order must not be able to hide or fake a difference ─────────────────────
{
  const rid = 'la_musa';
  const shuffled = storeBuilt(rid, (s) => {
    s.items = s.items.map((i) => ({ display: i.display, price: i.price, key: i.key, ...(i.has_photo !== undefined ? { has_photo: i.has_photo } : {}) }));
  });
  assert.doesNotThrow(() => assertStoreCodeParity(rid, shuffled, codeBuilt(rid)), 'reordered object properties are the SAME content — must still pass');
  ok('canonical: property-order differences do not fake a mismatch (content is what is compared)');
}
// ── 🔒 THE GATE MUST BE WIRED, and wired BEFORE the publish. A gate that exists in a module but is
//    not called from the cutover path is decoration — and "silently not wired" has bitten this program
//    before. publish-version.js is a CLI no test executes, so the wiring is asserted structurally.
{
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const SRC = readFileSync(join(__dirname, '..', 'tools', 'publish-version.js'), 'utf8');
  assert.ok(/require\('\.\.\/catalog\/publish-parity'\)/.test(SRC), 'publish-version must import the parity gate');
  assert.ok(/const FROM_STORE = process\.argv\.includes\('--from-store'\)/.test(SRC), '--from-store must be a real flag');
  // 1A Task 7 moved the input assembly into an exported, pure buildPublishInput() so a test can drive
  // the REAL thing — so the gate's position is now checked where it actually lives (inside that
  // function) and the CALL ORDER is checked in the CLI body. Text-order alone stopped being the right
  // question the moment the code was factored properly; what still has to be true is that the store is
  // read fail-closed, the candidate is built through the gated builder, and the publish comes last.
  const builder = SRC.slice(SRC.indexOf('function buildPublishCandidate'), SRC.indexOf('module.exports'));
  assert.ok(builder.length > 200 && builder.includes('sourceToBuildInputs'), 'non-vacuity: the slice really is buildPublishCandidate');
  assert.ok(builder.includes('assertStoreCodeParity(rid,'), 'the gate must be CALLED from the builder, not merely imported');
  assert.ok(builder.indexOf('assertStoreCodeParity(rid,') < builder.indexOf('return {'),
    'and it must run BEFORE the input is returned — a gate after the build is decoration');
  const body = SRC.slice(SRC.indexOf('const source_sha = gitSha()'));
  const baseline = body.indexOf('await readPublishBaseline(db, rid, { fromStore: FROM_STORE })');
  const build = body.indexOf('buildPublishCandidate(rid, baseline, { source_sha })');
  const publish = body.indexOf('await publishVersion(db, rid, input, { mirror, expected })');
  assert.ok(baseline > 0 && build > 0 && publish > 0, 'the CLI must read its baseline, build the candidate from it, and publish');
  assert.ok(baseline < build && build < publish,
    'the baseline is read FIRST, the candidate is built FROM it, and the publish comes LAST');
  // 🔴 THE CANDIDATE AND ITS EXPECTATION COME FROM ONE CALL. Reading the expectation separately is
  // the bug this replaced: the CLI captured a competing publish's revision as its own baseline, the
  // CAS compared it against itself, and a stale candidate reverted a live price.
  assert.ok(/const \{ input, expected \} = buildPublishCandidate\(/.test(body),
    'the candidate and the expectation must be produced together — pairing them by hand is what allowed a stale baseline');
  assert.ok(!/readExpectation|await readSource\(db, rid\)/.test(body),
    'the CLI must not read the source or the expectation on its own — both come from readPublishBaseline, in one order');
  ok('the gate is WIRED inside the builder; the CLI reads its baseline FIRST, builds the candidate and its expectation together, and publishes LAST');

  // verify-catalog must check store-vs-code too, so a drifted store is caught between cutovers
  const VC = readFileSync(join(__dirname, '..', 'tools', 'verify-catalog.js'), 'utf8');
  assert.ok(/assertStoreCodeParity\(rid, storeBuilt, codeBuilt\)/.test(VC), 'verify-catalog must assert store == code');
  assert.ok(/source_missing/.test(VC), 'and must tolerate a pre-2a absent store rather than failing the whole verify');
  ok('verify-catalog is store-aware: asserts store == code, and tolerates a pre-2a absent store');

  // The bug this catches, from experience: an edit added the --from-store branch but its `require`
  // silently no-op'd (the anchor string had changed), so the CLI referenced undefined identifiers.
  // `node --check` passes that happily — it is a runtime ReferenceError, and these CLIs are owner-run
  // one-shots where the first execution IS the cutover. Assert the imports resolve, statically.
  for (const [file, ids] of [
    ['tools/publish-version.js', ['readSource', 'sourceToBuildInputs', 'assertStoreCodeParity', 'buildCatalogV2', 'publishVersion']],
    ['tools/verify-catalog.js', ['readSource', 'sourceToBuildInputs', 'assertStoreCodeParity', 'buildCatalogV2']],
    ['tools/seed-source-store.js', ['validateSource', 'sourceRefOf', 'extrasKeyOf', 'readLiteral', 'pricingKeyOf', 'attachRedeemFields']],
    ['tools/rollback-version.js', ['rollbackVersion', 'makeRtdbMirror', 'RTDB_URL']],
  ]) {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    for (const id of ids) {
      const destructured = new RegExp(`\\{[^}]*\\b${id}\\b[^}]*\\}\\s*=\\s*require`).test(src);
      assert.ok(destructured, `${file} uses ${id} but never imports it — node --check cannot see this`);
    }
  }
  ok('import resolution: every identifier the portal-2a CLIs use is actually imported (node --check is blind to this)');

  // ── The ROLLBACK CLI. The runbook's recovery step is only real if the tool refuses to do the wrong
  //    thing: the target is EXPLICIT (never inferred — "the previous version" is ambiguous exactly
  //    when it matters), listing changes nothing, and an unknown or already-active target is refused.
  // COMMENT-STRIPPED: a commented-out `databaseURL: RTDB_URL` satisfied the raw-text check, which is
  // the same blindness that let a commented-out require pass the Task 5 wiring guard.
  const RB = readFileSync(join(__dirname, '..', 'tools', 'rollback-version.js'), 'utf8')
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
  // ...and anchored to the whole statement: `arg('to') || 'previous'` still matched a substring test,
  // which is precisely the inference this tool must never do.
  assert.ok(/const TO = arg\('to'\);\s*$/m.test(RB), 'the target must be EXACTLY the argument — no inferred default');
  assert.ok(/const RID = arg\('rid'\);\s*$/m.test(RB), 'and so must the restaurant');
  assert.ok(/if \(!TO\) \{[\s\S]{0,600}?nothing changed/.test(RB), 'omitting --to must LIST and change nothing');
  assert.ok(/refusing: \$\{TO\} is not a retained version/.test(RB), 'an unretained target must be refused, not attempted');
  assert.ok(/refusing: \$\{TO\} is ALREADY active/.test(RB), 'rolling back to the active version must be refused (a no-op flip still burns a lease)');
  const list = RB.indexOf('nothing changed.'), roll = RB.indexOf('await rollbackVersion(');
  assert.ok(list > 0 && roll > 0 && list < roll, 'the read-only listing path must return BEFORE any write path');
  assert.ok(/databaseURL: RTDB_URL/.test(RB), 'and it must pin databaseURL — admin.database() throws without it');
  // 1A Task 7: the rollback is a compare-and-set too. An operator picks a target from a list they
  // read a moment ago; if a publish lands in between, an unconditional flip buries a version nobody
  // ever saw. The CLI must roll back FROM the pointer it actually read, not from whatever is live by
  // the time the transaction runs. (Asserted structurally — this CLI is argv-driven and owner-run.)
  assert.ok(/const active = pointer\.exists \? \(pointer\.data\(\) \|\| \{\}\)\.version : null;/.test(RB),
    'the rollback CLI must read the live pointer');
  assert.ok(/expected: \{ activeVersionId: active \}/.test(RB),
    'and must roll back FROM that exact pointer — an unconditional flip buries whatever landed in between');
  assert.ok(RB.indexOf('const active =') < RB.indexOf('await rollbackVersion('),
    'and it must read it BEFORE the rollback, not after');
  ok('the rollback CLI is explicit-target, CAS-bound to the pointer it read, refuses unretained/already-active targets, and lists read-only');
}

console.log(`publish-parity: OK (${n})`);
