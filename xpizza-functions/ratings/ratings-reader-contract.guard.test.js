'use strict';
// S-A1 r5 (Codex r4 #1) — the READ-SIDE guarantee needs a REAL contract. Exposure of a residual (not-yet-redacted) rating is impossible
// only if EVERY reader goes through rating-v2.readCountable (live AND owner not tombstoned; deleted_uids is permanent). So:
//   SINGLE-MODULE ACCESS — ratings/rating-v2.js is the ONLY non-test source that may name the `ratings_v2` path segment, in ANY form.
//   Every other module reaches a node only through its exports (ratingRef / ownedRatingIds for writers and redactors, readCountable
//   for readers). There is NO other allowlisted module.
// The detector reads STRING PIECES with a real parser (acorn — the handheld guard's method: decoded literals, template quasis, comments
// and regex contexts invisible), orders every literal / template piece by SOURCE POSITION, and flags a file when one piece contains the
// segment OR the in-order join of all pieces does — so a literal, a concatenation, a template with an inner literal, or an alias pair
// split across statements are all caught. A comment proves nothing either way.
// Run: node ratings/ratings-reader-contract.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');
const { countable, STATES } = require('./rating-v2');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
const OWNER = 'ratings/rating-v2.js';
const SEG = /ratings_v2/i;

function pieces(src) {
  let ast;
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(src, { ...opts, sourceType: 'script' }); } catch (_) { ast = acorn.parse(src, { ...opts, sourceType: 'module' }); }
  const out = [];
  (function walk(nd) {
    if (!nd || typeof nd !== 'object') return;
    if (Array.isArray(nd)) { nd.forEach(walk); return; }
    if (nd.type === 'Literal' && typeof nd.value === 'string') out.push([nd.start, nd.value]);
    if (nd.type === 'TemplateElement') out.push([nd.start, nd.value.cooked == null ? nd.value.raw : nd.value.cooked]);
    for (const [k, v] of Object.entries(nd)) if (k !== 'type' && v && typeof v === 'object') walk(v);
  }(ast));
  return out.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
}
const offends = (src) => { const ps = pieces(src); return ps.some((p) => SEG.test(p)) || SEG.test(ps.join('')); };

// 1. the predicate + the single reader exist
assert.strictEqual(countable({ state: STATES.LIVE }, false), true);
for (const [node, tomb, why] of [[{ state: STATES.WITHDRAWN }, false, 'withdrawn'], [{ state: STATES.DELETED }, false, 'deleted'], [{ state: STATES.LIVE }, true, 'a tombstoned owner'],
  [null, false, 'no node'], [{}, false, 'no state']]) assert.strictEqual(countable(node, tomb), false, `🔴 ${why} must never count`);
assert.strictEqual(typeof require('./rating-v2').readCountable, 'function', 'the single reader is exported');
ok('countable(node, ownerTombstoned): ONLY a live node whose owner is not tombstoned counts; readCountable is THE exported reader');

// 2. the detector's BYPASS cells (Codex r4): every disguise of the segment is caught; a comment neither hides nor proves anything
for (const [why, src] of [
  ['a literal', "db.ref('ratings_v2/' + id).once('value');"],
  ['a concatenation', "db.ref('ratings' + '_v2').once('value');"],
  ['a template with an inner literal', "db.ref(`${'ratings'}_v2/${id}`).once('value');"],
  ['a template', 'db.ref(`ratings_v2/${id}`);'],
  ['an alias pair split across statements', "const a = 'ratings'; const b = '_V2'; db.ref(a + b).once('value');"],
  ['a literal + a comment carrying countable(', "// countable( — this comment must not excuse the read\nconst all = (await db.ref('ratings_v2').once('value')).val();"],
]) assert.ok(offends(src), `🔴 BYPASS not caught: ${why}`);
for (const [why, src] of [['a comment only', '// ratings_v2/{id} is read through rating-v2.js\nconst x = 1;'], ['an unrelated path', "db.ref('order_ratings/' + id);"]])
  assert.ok(!offends(src), `the detector is not tripped by ${why}`);
ok('bypass cells: a literal, a concatenation, a template (with / without an inner literal), an alias pair split across statements and a literal beside a "countable(" comment are ALL caught; a comment-only mention / an unrelated path are not');

// 3. the contract over the tree: rating-v2.js is the ONLY non-test source naming the segment
const files = execFileSync('git', ['ls-files', '--', '.'], { cwd: FN, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(js|mjs|cjs)$/.test(f) && !/(^|\/)node_modules\//.test(f) && !/\.test\.(js|mjs|cjs)$/.test(f) && !/^test\//.test(f));
assert.ok(files.includes(OWNER) && files.length > 300, `premise: the scan covers the source (${files.length} files)`);
assert.ok(offends(fs.readFileSync(path.join(FN, OWNER), 'utf8')), 'premise: the owning module DOES name the segment (non-vacuity)');
const bad = files.filter((f) => f !== OWNER && offends(fs.readFileSync(path.join(FN, f), 'utf8')));
assert.deepStrictEqual(bad, [], `🔴 non-test source naming ratings_v2 outside ${OWNER}: ${bad.join(', ')} — go through rating-v2.js's exports`);
ok(`single-module access: ${OWNER} is the ONLY non-test source (of ${files.length}) that names ratings_v2 in any form`);

console.log(`ratings-reader-contract.guard: OK (${n})`);
