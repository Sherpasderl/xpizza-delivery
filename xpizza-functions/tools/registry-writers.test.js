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

// ── 4. 🔴 ENTRY POINTS THAT REACH A WRITER WITHOUT WRITING THEMSELVES ─────────────────────────
/* Fencing only the functions that touch the collection would leave these unfenced while they are the
   things a caller actually invokes. reconcileLegacyOrphans is the one that matters most: its writer
   is module-PRIVATE, so an enumeration that followed only exported writers would not have found it. */
{
  const got = [...new Set(r.indirect.map((h) => `${rel(h.file)}::${h.fn} -> ${h.calls}`))].sort();
  assert.deepStrictEqual(got, [
    'catalog/identity-backfill.js::backfillIdentities -> ensureIdentity',
    'catalog/identity-backfill.js::ensureIdentitiesForKeys -> ensureIdentity',
    'catalog/identity-bootstrap.js::reconcileLegacyOrphans -> retireOrphanFenced',
    'catalog/identity-sweep.js::sweepAllIdentityIntegrity -> sweepIdentityIntegrity',
  ], '🔴 the set of entry points that reach a registry writer changed');
  ok(`${got.length} indirect entry points, including one whose writer is module-private`);
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

// ── 7. 🔴 COMMENTED-OUT AND QUOTED WRITES ARE NOT WRITES ──────────────────────────────────────
/* The same code-versus-data trap that made the emulator-arming detector read its own fixtures. */
{
  const { scanFile } = require('./registry-writers.js');
  const tmp = path.join(require('os').tmpdir(), `registry-walk-probe-${process.pid}.js`);
  fs.writeFileSync(tmp, [
    "const { idsColOf } = require('./identity-registry');",
    '/* tx.set(idsColOf(db, rid, kind).doc(x), {}); */',
    "// tx.set(idsColOf(db, rid, kind).doc(x), {});",
    'function realWriter() { const ref = idsColOf(db, rid, kind).doc(x); tx.set(ref, {}); }',
    'module.exports = { realWriter };',
  ].join('\n'));
  try {
    const probe = scanFile(tmp);
    assert.strictEqual(probe.writes.length, 1,
      `🔴 the walk counted a commented-out write: found ${probe.writes.length} in a file with one real write and two commented ones`);
    assert.strictEqual(probe.writes[0].fn, 'realWriter', 'and it attributed the real one to its enclosing function');
  } finally { fs.unlinkSync(tmp); }
  ok('commented-out writes are not counted, and a real one is attributed to its function');
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
