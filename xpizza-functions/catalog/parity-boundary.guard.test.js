'use strict';
// Portal 2b-1 Task 4 — THE PARITY BOUNDARY. Run: node catalog/parity-boundary.guard.test.js
//
// 2a's safety was `assertStoreCodeParity`: the store had to equal the in-code tables, so the cutover
// was provably a no-op. 2b-1 drops that gate — but for ONE handler only, and the scoping is the whole
// safety argument. Two ways it can be broken, and each is invisible in review:
//
//   TOO NARROW — the gate creeps back into publishEdited, and every merchant edit is refused because it
//   differs from code. That is the portal not working at all.
//
//   TOO WIDE — the gate is removed from the 2a cutover CLI as "no longer needed". That is the far worse
//   direction: the cutover's entire claim is that it changes nothing, and the gate is what proves it.
//   Lose it and a botched store silently becomes live prices during the one operation nobody is
//   watching closely, because it is supposed to be a no-op.
//
// Structural, and comment-stripped: a mention in prose is not a call, and — as the 2a wiring guard
// learned the hard way — a commented-out line satisfies a naive regex.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const ROOT = join(__dirname, '..');
const codeOf = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');

const GATE = 'assertStoreCodeParity';

// ── (1) THE 2a CUTOVER GATE IS STILL THERE, and still runs BEFORE the publish ──────────────────
{
  const cli = codeOf('tools/publish-version.js');
  assert.ok(new RegExp(`\\{[^}]*\\b${GATE}\\b[^}]*\\}\\s*=\\s*require\\('\\.\\./catalog/publish-parity'\\)`).test(cli),
    'the 2a cutover CLI must still IMPORT the parity gate');
  const called = cli.indexOf(`${GATE}(rid,`);
  const published = cli.indexOf('await publishVersion(db, rid,');
  assert.ok(called > 0, 'and still CALL it — an import alone is decoration');
  assert.ok(published > 0, 'sanity: the CLI still publishes');
  assert.ok(called < published, 'and it must still run BEFORE publishVersion — after the flip it proves nothing');
  assert.ok(/--from-store/.test(cli), 'the --from-store cutover path still exists');
  ok('the 2a cutover gate is intact: imported, called, and still ahead of the publish');
}

// ── (2) publishEdited DOES NOT call it — the drop, scoped to exactly one handler ───────────────
{
  const handler = codeOf('catalog/publish-edited-handler.js');
  assert.ok(!new RegExp(`\\b${GATE}\\b`).test(handler),
    'publishEdited must NOT invoke the parity gate — a merchant edit is SUPPOSED to differ from code');
  // non-vacuity: the file really is the publish path, so "does not call it" is a fact about this
  // handler and not about some empty file the guard happens to be pointed at
  assert.ok(/publishVersion\(/.test(handler), 'sanity: this file really does publish');
  assert.ok(/verifyEditToken\(/.test(handler), 'and really is the token-bound path');
  ok('publishEdited does not call the parity gate — and the file really is the publishing, token-bound path');
}

// ── (3) THE DROP REACHES NO FURTHER ───────────────────────────────────────────────────────────
// publishVersion never contained the gate (it lives in the CLI wrapper), and the serving path never
// did either. Asserted so that "we already dropped parity" cannot later justify removing something
// else — these are the loads that were NEVER parity's to carry.
{
  const publish = codeOf('catalog/catalog-publish.js');
  assert.ok(!new RegExp(`\\b${GATE}\\b`).test(publish), 'publishVersion must remain parity-free (it always was — the gate lives in the CLI)');
  // Scoped to publishVersion's OWN body. A file-wide search finds the same calls inside rollbackVersion
  // and previewVersion, so removing them from the publish path looked fine — two mutations survived on
  // exactly that, and a guard that cannot see the load-bearing call is not guarding it.
  const pubBody = publish.slice(publish.indexOf('async function publishVersion'), publish.indexOf('async function rollbackVersion'));
  assert.ok(pubBody.length > 200 && pubBody.includes('acquireLease'), 'non-vacuity: the slice really is publishVersion');
  for (const [needle, why] of [
    ['await readVersionDocs(db, rid, versionId)', 'verify-before-flip: the version is re-read before the pointer moves'],
    ['await verifyVersionStructure(db, rid, versionId)', 'the structure bijection is re-verified before the flip'],
    ['await flipPointer(db, rid, token, versionId, snapshot)', 'the flip is still the last step, under a lease'],
  ]) {
    assert.ok(pubBody.includes(needle), `${why} — must still be present INSIDE publishVersion`);
  }
  // and the verification must precede the flip, not merely coexist with it
  assert.ok(pubBody.indexOf('await readVersionDocs(db, rid, versionId)') < pubBody.indexOf('await flipPointer('),
    'the re-read must come BEFORE the flip — verifying after the pointer moved proves nothing');
  assert.ok(pubBody.indexOf('await verifyVersionStructure(db, rid, versionId)') < pubBody.indexOf('await flipPointer('),
    'and so must the structure check');
  const resolver = codeOf('catalog/pricing-tables.js');
  assert.ok(!new RegExp(`\\b${GATE}\\b`).test(resolver), 'the serving resolver must stay parity-free (2c made the catalog authoritative)');
  assert.ok(/heartbeat\(restaurantId, now\(\)\)/.test(resolver) && /serveFingerprint\(restaurantId, cat/.test(resolver),
    'sanity: the resolver is unchanged and still serving');
  ok('the drop reaches no further: publishVersion still verifies-before-flip, and the serving resolver is untouched');
}

// ── (4) NON-VACUITY — the detector fires on planted code in BOTH directions ────────────────────
// Without this the guard could be a regex that never matches anything, passing forever.
{
  const detects = (src) => new RegExp(`\\b${GATE}\\b`).test(
    src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n'));
  assert.strictEqual(detects(`const x = ${GATE}(rid, a, b);`), true, 'a planted call is detected');
  assert.strictEqual(detects(`// we removed ${GATE} here`), false, 'a comment is not a call');
  assert.strictEqual(detects(`const y = 1;   // ${GATE}`), false, 'nor is a trailing comment');
  assert.strictEqual(detects('const y = 1;'), false, 'and ordinary code is not a false positive');
  ok('non-vacuity: the detector catches a planted call and ignores prose in both directions');
}
console.log(`parity-boundary.guard: OK (${n})`);
