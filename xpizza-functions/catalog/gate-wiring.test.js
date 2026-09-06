'use strict';
// Portal 2a Task 5 — production must actually USE the catalog gate. Run: node catalog/gate-wiring.test.js
//
// menu-gates.test.js proves the gate is CORRECT. This proves it is REACHED. A gate module that exists
// but is never wired leaves index.js reading the static set forever — the migration would be a no-op
// and every unit test would still pass. That failure has already happened twice in this program: the
// ladder recorders silenced by a name collision, and a portal CLI whose require never landed because a
// str.replace silently no-op'd (node --check passes both; only runtime notices).
//
// Source-level, because index.js cannot be imported without Firebase init.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SRC = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
// EVERY assertion below runs against CODE, not prose. A commented-out require is precisely the failure
// being guarded against, so a comment mentioning `createGateReader` must not satisfy an import check.
// Full-line comments only (a trailing comment on a real code line is left alone), newlines preserved so
// source ORDER — which check (4) depends on — is unchanged.
const CODE = SRC.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

// ── (1) Every identifier the wiring uses must be REALLY exported. node --check cannot see this: a
//        missing export is a runtime `previewVersion is not a function` on the order path.
{
  const gates = require('./menu-gates');
  const publish = require('./catalog-publish');
  const firestore = require('./catalog-firestore');
  for (const [mod, name, obj] of [['menu-gates', 'createGateReader', gates], ['catalog-publish', 'previewVersion', publish], ['catalog-firestore', 'getActiveVersionId', firestore]]) {
    assert.strictEqual(typeof obj[name], 'function', `${mod} must really export ${name} — index.js calls it`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(CODE), `index.js must reference ${name} in code`);
  }
  // The destructure must NAME each one — referencing an unimported identifier is a ReferenceError at runtime.
  for (const [name, mod] of [['createGateReader', 'menu-gates'], ['previewVersion', 'catalog-publish'], ['getActiveVersionId', 'catalog-firestore']]) {
    const re = new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require\\('\\./catalog/${mod}'\\)`);
    assert.ok(re.test(CODE), `${name} must be destructured from require('./catalog/${mod}') — otherwise ReferenceError on the order path`);
  }
  // Non-vacuity: commenting a require out must FAIL these checks. (It did not, until the comment
  // stripper above landed — the prose in a `// const { x } = require(...)` line satisfied the regex.)
  const sabotaged = CODE.replace("const { createGateReader } = require('./catalog/menu-gates');", "// const { createGateReader } = require('./catalog/menu-gates');")
    .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/\{[^}]*\bcreateGateReader\b[^}]*\}\s*=\s*require\('\.\/catalog\/menu-gates'\)/.test(sabotaged),
    'non-vacuity: a commented-out require must NOT satisfy the import check');
  ok('every identifier the gate wiring uses is really exported AND really imported (prose does not count)');
}

// ── (2) The reader is a SINGLETON — its pointer/version caches are the whole cost story. Rebuilt per
//        request, every order would pay a pointer read plus a full structure read.
{
  const block = CODE.slice(CODE.indexOf('function gateReader()'), CODE.indexOf('async function resolvePricingTables'));
  assert.ok(block.length > 100, 'gateReader() must exist');
  assert.ok(/let _gateReader = null;/.test(CODE) && /if \(!_gateReader\)/.test(block), 'the gate reader must be a module-level singleton — its caches must survive across requests');
  assert.ok(/getVersionId:\s*\(rid\)\s*=>\s*getActiveVersionId\(/.test(block), 'it must be wired with the real pointer probe');
  assert.ok(/getMenu:\s*\(rid,\s*versionId\)\s*=>\s*previewVersion\(/.test(block), 'it must be wired with the real structure reader');
  ok('the gate reader is a singleton wired to the REAL pointer probe and the REAL structure reader');
}

// ── (3) BOTH intake sites pass the catalog set. A site left on the 3-arg form silently keeps the
//        static authority — the exact drift this task removes, invisible to every unit test.
{
  const calls = [...CODE.matchAll(/weekendOnlyViolation\(([^)]*)\)/g)].map((m) => m[1]);
  assert.strictEqual(calls.length, 2, `index.js must have exactly the 2 known intake sites (found ${calls.length}) — a new one would need wiring too`);
  for (const args of calls) {
    assert.strictEqual(args.split(',').length, 4, `every call site must pass the catalog key set — found: weekendOnlyViolation(${args})`);
    assert.ok(/weekendKeys\s*$/.test(args.trim()), `the 4th argument must be the resolved catalog set — found: weekendOnlyViolation(${args})`);
  }
  const awaits = [...CODE.matchAll(/const weekendKeys = await gateReader\(\)\.weekendOnlyKeysFor\(restaurantId\);/g)];
  assert.strictEqual(awaits.length, 2, 'both sites must RESOLVE the set from the gate reader, not reuse a stale local');
  ok('both intake sites resolve the catalog set and pass it (neither is left on the static 3-arg form)');
}

// ── (4) PLACEMENT: the resolve must precede the verdict at each site. An assignment that lands after
//        its use is `undefined` at the call → the injected set silently becomes the static fallback.
{
  let searchFrom = 0;
  for (let i = 0; i < 2; i++) {
    const resolve = CODE.indexOf('const weekendKeys = await gateReader()', searchFrom);
    const verdict = CODE.indexOf('weekendOnlyViolation(body.items', searchFrom);
    assert.ok(resolve > -1 && verdict > -1, `site ${i + 1} must have both halves`);
    assert.ok(resolve < verdict, `site ${i + 1}: the gate set must be resolved BEFORE the verdict — otherwise weekendKeys is undefined and the static fallback silently wins`);
    assert.ok(verdict - resolve < 500, `site ${i + 1}: the resolve must be adjacent to the verdict it feeds`);
    searchFrom = verdict + 1;
  }
  ok('at both sites the catalog set is resolved BEFORE the verdict that consumes it');
}

// ── (5) No OTHER production path may still read the static set as live authority.
{
  const code = CODE;   // prose about the fallback is not a read of it
  const reads = /\bX_PIZZA_WEEKEND_ONLY\b/;
  assert.ok(!reads.test(code), 'index.js must not import or read the static set in CODE — the catalog is the authority, and menu-gates owns the fallback');
  // Non-vacuity: the detector must actually fire on a source that does read it. Without this the
  // assertion above passes just as happily against a regex that can never match anything.
  assert.ok(reads.test(code.replace('const weekendBad =', 'const x = X_PIZZA_WEEKEND_ONLY; const weekendBad =')),
    'non-vacuity: the detector must catch a planted static read');
  assert.ok(code.includes('weekendOnlyViolation'), 'sanity: the pure verdict function is still called (the assertion is about the SET, not the function)');
  ok('index.js never reads X_PIZZA_WEEKEND_ONLY in code — the static set survives only as menu-gates\' internal fallback');
}
// ── (6) TASK 6 — the redemption seams. Same class of failure: an unwired seam silently keeps the
//        code allowlist, and no unit test can see it because the calculators still work either way.
{
  const gates = require('./menu-gates');
  assert.strictEqual(typeof gates.createGateReader({}).redeemEligibleFor, 'function', 'the reader must expose redeemEligibleFor');
  // Every consumer of the threaded `eligible` must actually forward it. A dropped forward at ANY layer
  // silently reverts that path to the code allowlist.
  const forwards = [
    ['rewards-redeem.js', /computeXPizza\(redeem, tables, eligible\)/, 'computeRedemption must forward eligible to computeXPizza'],
    ['rewards-redeem.js', /computeLaMusa\(redeem, tables, eligible\)/, 'computeRedemption must forward eligible to computeLaMusa'],
    ['rewards-redeem.js', /isXPizzaEligible\(name, eligible\)/, 'computeXPizza must consult the threaded allowlist'],
    ['rewards-redeem.js', /isLaMusaEligible\(id, tables, eligible\)/, 'computeLaMusa must consult the threaded allowlist'],
    ['rewards-redeem-intake.js', /computeRedemption\(\{ redeem, items, restaurantId, tables, eligible \}\)/, 'prepareRedemption must forward eligible'],
    ['createorder-classify.js', /db, tables, eligible = null \} = deps/, 'the classifier must accept eligible from deps'],
  ];
  for (const [file, re, why] of forwards) {
    const src = readFileSync(join(__dirname, '..', file), 'utf8').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(re.test(src), `${file}: ${why}`);
  }
  ok(`the threaded allowlist is forwarded at all ${forwards.length} layers (a dropped forward reverts that path to code)`);
}
{
  // The QUOTE must preview on the same allowlist the order enforces, or a customer is shown a
  // redemption the order then refuses.
  assert.ok(/quoteRedemptionCore\(db, \{[^)]*eligible: quoteEligible/.test(CODE), 'the quote seam must pass its resolved eligibility');
  assert.ok(/const quoteEligible = await gateReader\(\)\.redeemEligibleFor\(restaurantId\);/.test(CODE), 'and must resolve it from the same reader');
  // No redemption seam may be left unwired: every prepareRedemption / resolveRedemptionForOrder /
  // quoteRedemptionCore call in index.js must carry an eligible.
  const seams = [...CODE.matchAll(/(prepareRedemption|resolveRedemptionForOrder|quoteRedemptionCore)\(db, \{[\s\S]{0,600}?\}\)/g)];
  assert.ok(seams.length >= 3, `expected the 3 redemption seams, found ${seams.length}`);
  for (const m of seams) assert.ok(/\beligible:/.test(m[0]), `an unwired redemption seam silently keeps the code allowlist: ${m[0].slice(0, 70)}`);
  ok(`all ${seams.length} redemption seams in index.js pass a resolved allowlist`);
}
console.log(`gate-wiring: OK (${n})`);
