'use strict';
/**
 * The identity-registry writer enumeration — asserted against the WALK, never against a list.
 * Run: node tools/registry-writers.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. The next thing to be built fences every registry writer, and a fence is
 * only as good as the set it covers. A set written down by hand is correct on the day it is written
 * and silently wrong afterwards — and the spec's own rationale for this area named callers this tree
 * does not have, which is that failure one level up. So the set is derived from source, and this
 * asserts what the derivation finds.
 *
 * 🔴 AN EMPTY WALK MUST NEVER READ AS SUCCESS. Every assertion below is paired with a premise that
 * fails if the walk stopped seeing the tree: file counts, the builders still being exported, and a
 * negative control that would go quiet for the same reasons a real finding would.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { enumerate, ROOTS, BUILDERS } = require('./registry-writers.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const rel = (f) => path.relative(ROOT, f);
const r = enumerate();

// ── 1. PREMISE: THE WALK ACTUALLY SEES THE TREE ───────────────────────────────────────────────
/* Without this every set assertion below is satisfiable by a walk that found nothing. */
{
  assert.ok(r.scanned > 150, `🔴 the walk visited only ${r.scanned} production files — it is not seeing the tree, and every set below would be vacuous`);
  assert.strictEqual(ROOTS.length, 3, 'three roots are walked; dropping one would shrink the walk without shrinking the claim');
  for (const root of ROOTS) assert.ok(fs.existsSync(root), `🔴 a walked root does not exist: ${root}`);
  ok(`the walk visits ${r.scanned} production files across ${ROOTS.length} roots`);
}

// ── 2. THE PATH BUILDERS STILL EXIST AND ARE STILL EXPORTED ───────────────────────────────────
/* The whole walk keys off these two names. Renamed or unexported, it would find nothing and report
   a clean registry — the most dangerous possible false negative, so it fails loudly here instead. */
{
  const reg = require('../catalog/identity-registry.js');
  const src = fs.readFileSync(path.join(ROOT, 'catalog', 'identity-registry.js'), 'utf8');
  for (const b of BUILDERS) {
    assert.match(src, new RegExp(`const ${b} = `), `🔴 ${b} no longer exists — the walk keys off it and would silently find no writers`);
    assert.strictEqual(typeof reg[b], 'function', `🔴 ${b} is no longer exported — modules that write the registry could not reach it, and the walk could not follow them`);
  }
  ok(`both registry path builders (${BUILDERS.join(', ')}) exist and are exported`);
}

// ── 3. 🔴 THE DIRECT WRITE SITES THE WALK FINDS ───────────────────────────────────────────────
{
  const got = [...new Set(r.writes.map((w) => `${rel(w.file)}::${w.fn}`))].sort();
  assert.deepStrictEqual(got, [
    'catalog/identity-bootstrap.js::retireOrphanFenced',
    'catalog/identity-registry.js::ensureIdentity',
    'catalog/identity-registry.js::retireIdentity',
    'catalog/identity-sweep.js::sweepIdentityIntegrity',
  ], '🔴 the set of functions that WRITE the identity registry changed — a fence built for the old set would leave the new writer unfenced');
  assert.strictEqual(r.writes.length, 8, `🔴 the registry has ${r.writes.length} write sites, not 8 — each one is a place a generation fence must hold`);
  ok(`${r.writes.length} direct write sites in ${got.length} functions, enumerated from source`);
}

// ── 4. 🔴 EVERY FUNCTION THAT REACHES A WRITER, TRANSITIVELY ─────────────────────────────────
/* Fencing only the functions that touch the collection leaves these unfenced while they are what a
   caller actually invokes. The first version of this walk stopped after ONE call and therefore
   reported four — missing publishVersion (the live publish path), the hourly scheduled sweep, and
   every CLI. `reconcileLegacyOrphans` remains the one that matters most for the walk's own design:
   its writer is module-PRIVATE, so following only exported writers would not have found it. */
{
  const got = [...new Set(r.indirect.map((h) => `${rel(h.file)}::${h.fn}`))].sort();
  assert.deepStrictEqual(got, [
    'catalog/catalog-publish.js::publishVersion',
    'catalog/identity-backfill.js::backfillIdentities',
    'catalog/identity-backfill.js::ensureIdentitiesForKeys',
    'catalog/identity-bootstrap.js::reconcileLegacyOrphans',
    'catalog/identity-sweep.js::sweepAllIdentityIntegrity',
    'catalog/publish-edited-handler.js::publishEditedCore',
    'index.js::publishEdited',
    'index.js::sweepIdentityRegistry',
    'tools/backfill-identities.js::(module scope)',
    'tools/migrate-catalog-display.js::(module scope)',
    'tools/publish-version.js::(module scope)',
  ], '🔴 the set of functions that reach a registry writer changed — a fence built for the old set leaves the new caller unfenced');
  ok(`${got.length} functions reach a writer transitively, from immediate callers out to the merchant-facing endpoint`);
}

// ── 5. 🔴 THE NEGATIVE CONTROL: A READER THAT IMPORTS THE BUILDERS IS NOT A WRITER ────────────
/* catalog-publish.js imports idsColOf AND keysColOf and uses them heavily — entirely for tx.get().
   A walk that matched "imports the builders" rather than "writes through them" would name it, and
   the fence would then be applied to a read path while a real writer stayed uncovered. This is the
   cell that proves the walk reads the OPERATION, not the import. */
{
  const pub = fs.readFileSync(path.join(ROOT, 'catalog', 'catalog-publish.js'), 'utf8');
  assert.match(pub, /idsColOf/, 'premise — catalog-publish really does use the builders');
  assert.match(pub, /keysColOf/, 'premise — both of them');
  assert.ok(/tx\.get\(\s*keysColOf/.test(pub), 'premise — and it uses them for reads');
  assert.deepStrictEqual(r.writes.filter((w) => /catalog-publish/.test(w.file)), [],
    '🔴 a read-only user of the path builders was enumerated as a writer — the walk is matching imports, not writes');
  ok('catalog-publish.js uses both builders for READS and is correctly not a writer');
}

// ── 6. 🔴 THE WALK DISTINGUISHES REGISTRY WRITES FROM OTHER WRITES IN THE SAME FILE ───────────
/* identity-bootstrap.js writes version docs and source docs too. If the walk counted every tx.set in
   a file that touches the registry, it would over-report and the fence would be asked to cover
   writes that have nothing to do with identity. */
{
  const boot = fs.readFileSync(path.join(ROOT, 'catalog', 'identity-bootstrap.js'), 'utf8');
  const allTxWrites = (boot.match(/\btx\s*\.\s*(?:set|update|delete|create)\s*\(/g) || []).length;
  const found = r.writes.filter((w) => /identity-bootstrap/.test(w.file)).length;
  assert.ok(allTxWrites > found,
    `premise — identity-bootstrap.js has other writes too (${allTxWrites} transactional writes in all)`);
  assert.strictEqual(found, 2,
    `🔴 the walk found ${found} registry writes in identity-bootstrap.js, not 2 — it is counting writes to other collections`);
  ok(`identity-bootstrap.js has ${allTxWrites} transactional writes; exactly ${found} touch the registry`);
}

// ── 7. 🔴 THE SPELLINGS A REVIEWER FOUND — five missed, one falsely counted ──────────────────
/* The regex version of this walk was wrong in BOTH directions, and every one of these came from
   review rather than from me. A missed spelling is a writer the fence never covers; a falsely counted
   one puts the fence on a read path while a real writer stays uncovered. The parser makes all of them
   structural: a string is a Literal and can never be a CallExpression, and a call is a call however
   it is spelled. */
{
  const { scanFile } = require('./registry-writers.js');
  const os = require('os');
  const probe = (src) => {
    const f = path.join(os.tmpdir(), `rw-probe-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(f, src);
    try { return scanFile(f); } finally { fs.unlinkSync(f); }
  };
  const IMPORT = "const { idsColOf, keysColOf } = require('./identity-registry');\n";

  const areWrites = {
    'argument form (the dominant spelling here)': 'function w(){ const r = idsColOf(db,rid,kind).doc(id); tx.set(r, {}); }',
    'receiver form, chained off the builder': 'function w(){ idsColOf(db,rid,kind).doc(id).set({}); }',
    'computed access': "function w(){ const r = idsColOf(db,rid,kind).doc(id); tx['set'](r, {}); }",
    'a differently-named transaction': 'function w(){ const r = idsColOf(db,rid,kind).doc(id); transaction.set(r, {}); }',
    'arguments split across lines': 'function w(){ const r = idsColOf(db,rid,kind).doc(id);\n  tx.set(\n    r,\n    { a: 1 }\n  ); }',
    'the other builder': 'function w(){ const r = keysColOf(db,rid,kind).doc(k); tx.delete(r); }',
    'update, not just set': 'function w(){ const r = idsColOf(db,rid,kind).doc(id); tx.update(r, { a: 1 }); }',
  };
  for (const [name, body] of Object.entries(areWrites)) {
    const r = probe(`${IMPORT}${body}\nmodule.exports={w};`);
    assert.ok(r.writes.length >= 1, `🔴 a real registry write was MISSED (${name}) — the fence would never cover it`);
    assert.strictEqual(r.writes[0].fn, 'w', `and it is attributed to its enclosing function (${name})`);
  }

  const areNot = {
    'the write exists only inside a STRING': 'function w(){ const s = "tx.set(idsColOf(db, rid, kind).doc(x), {})"; return s; }',
    'a template literal holding the same text': 'function w(){ const s = `tx.set(idsColOf(db, rid, kind).doc(x), {})`; return s; }',
    'a line comment': 'function w(){ // tx.set(idsColOf(db,rid,kind).doc(id), {});\n  return 1; }',
    'a block comment': 'function w(){ /* tx.set(idsColOf(db,rid,kind).doc(id), {}); */ return 1; }',
    'a READ through the same builder': 'async function w(){ const r = idsColOf(db,rid,kind).doc(id); return tx.get(r); }',
    'a write to an unrelated collection': 'function w(){ const r = db.collection("x").doc(id); tx.set(r, {}); }',
  };
  for (const [name, body] of Object.entries(areNot)) {
    const r = probe(`${IMPORT}${body}\nmodule.exports={w};`);
    assert.strictEqual(r.writes.length, 0, `🔴 something that is NOT a registry write was counted (${name}) — the fence would be aimed at it while a real writer stayed uncovered`);
  }

  /* An ALIASED builder, which the regex version could not see at all. */
  const aliased = probe("const { idsColOf: mk } = require('./identity-registry');\nfunction w(){ const r = mk(db,rid,kind).doc(id); tx.set(r, {}); }\nmodule.exports={w};");
  assert.strictEqual(aliased.writes.length, 1, '🔴 a builder imported under an alias hides every write through it');

  ok(`${Object.keys(areWrites).length} write spellings detected, ${Object.keys(areNot).length} non-writes rejected (strings and template literals included), and an aliased builder resolved`);
}

// ── 7b. 🔴 REACHABILITY IS TRANSITIVE — the live publish path is an entry point ────────────────
/* The first version reported only DIRECT callers, so publishVersion — which reaches ensureIdentity
   through ensureIdentitiesForKeys, and is the path a merchant's save actually takes — did not appear,
   nor did the scheduled sweep. An entry-point claim that stops one frame short reads as complete and
   is not, which is the same defect as capturing a baseline one step late. */
{
  const byName = new Map(r.indirect.map((h) => [`${rel(h.file)}::${h.fn}`, h]));
  for (const [key, why] of [
    ['catalog/catalog-publish.js::publishVersion', 'THE LIVE PUBLISH PATH reaches a registry writer'],
    ['index.js::sweepIdentityRegistry', 'the hourly scheduled sweep reaches a registry writer'],
    ['catalog/identity-backfill.js::ensureIdentitiesForKeys', 'the immediate caller is still found'],
  ]) {
    assert.ok(byName.has(key), `🔴 ${why}, and the walk does not report it (${key})`);
  }
  assert.ok(byName.get('catalog/catalog-publish.js::publishVersion').depth >= 2,
    'and it is found through a CHAIN, not as a direct caller — which is what the first version could not do');
  ok(`${r.indirect.length} functions reach a writer transitively, including the live publish path and the scheduled sweep`);
}

// ── 7c. 🔴 A FILE THAT DOES NOT PARSE IS REPORTED, NOT READ AS CLEAN ─────────────────────────
/* The parser is what makes every claim above structural — so a file it cannot read is a hole in the
   walk, and a hole reported as "no writes found" is indistinguishable from a clean file. That is the
   same failure as an empty walk passing: silence read as evidence. */
{
  const { scanFile } = require('./registry-writers.js');
  const os = require('os');
  const f = path.join(os.tmpdir(), `rw-unparsable-${process.pid}.js`);
  fs.writeFileSync(f, 'function w( { this is not javascript @@@ ');
  try {
    const bad = scanFile(f);
    assert.strictEqual(bad.parseFailed, true, '🔴 a file that could not be parsed was reported as clean');
    assert.deepStrictEqual(bad.writes, [], 'and it reports no writes — but flagged, not silently');
  } finally { fs.unlinkSync(f); }
  assert.deepStrictEqual(r.parseFailures, [],
    `🔴 ${r.parseFailures.length} production file(s) did not parse, so the walk did not see them: ${r.parseFailures.join(', ')}`);
  ok(`an unparsable file is flagged rather than read as clean, and all ${r.scanned} production files parsed`);
}

// ── 8. 🔴 THE SENSITIVITY PARTNER: A BLIND WALK FAILS ─────────────────────────────────────────
/* Every assertion above passes if the walk sees the tree. This one proves they would FAIL if it did
   not — otherwise "the set is exactly these four" is satisfied by a walk that found nothing and a
   list that happened to be empty. */
{
  const { jsFilesUnder } = require('./registry-writers.js');
  const empty = jsFilesUnder(path.join(require('os').tmpdir(), `definitely-not-here-${process.pid}`));
  assert.deepStrictEqual(empty, [], 'a walk of a missing directory yields nothing rather than throwing');
  assert.notDeepStrictEqual(r.writes, [], '🔴 the real walk found NO writers — which is what a broken walk also looks like');
  assert.ok(r.writes.length >= 8, 'and the real walk is what makes the assertions above non-vacuous');
  ok('an empty walk yields an empty set — so the assertions above are claims about the tree, not about nothing');
}

console.log(`\n${n} cells passed`);
