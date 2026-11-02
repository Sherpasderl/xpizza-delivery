'use strict';
// S-A1 r4 (Codex r3 #4, defence in depth — recorded NOW, enforced as readers land): EVERY reader of ratings_v2 (S-A3 merchant comments,
// S-B aggregates, anything later) counts / returns a node ONLY through rating-v2.countable(node, ownerTombstoned) — state === 'live'
// AND the owner not in deleted_uids. The reviewed WRITER / deletion modules below are the only files that may touch ratings_v2
// without it; any OTHER non-test source that names ratings_v2 must call countable( — or this guard is RED.
// Run: node ratings/ratings-reader-contract.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { countable, STATES } = require('./rating-v2');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');

// 1. the predicate
assert.strictEqual(countable({ state: STATES.LIVE }, false), true);
for (const [node, tomb, why] of [[{ state: STATES.WITHDRAWN }, false, 'withdrawn'], [{ state: STATES.DELETED }, false, 'deleted'], [{ state: STATES.LIVE }, true, 'a tombstoned owner'],
  [null, false, 'no node'], [{}, false, 'no state']]) assert.strictEqual(countable(node, tomb), false, `🔴 ${why} must never count`);
ok('countable(node, ownerTombstoned): ONLY a live node whose owner is not tombstoned counts (withdrawn / deleted / tombstoned owner / malformed ⇒ never)');

// 2. the contract over the tree: names ratings_v2 ⇒ a reviewed writer / deletion module, or it calls countable(
const ALLOWED = new Set(['ratings/rating-v2.js', 'ratings/rate-order.js', 'ratings/rating-fulfilment.js', 'signup-endpoints.js', 'index.js', 'tools/ratings-v1-guard.js']);
const offends = (rel, src) => /ratings_v2/.test(src) && !ALLOWED.has(rel) && !/\bcountable\(/.test(src);
assert.ok(offends('ratings/aggregate.js', "const all = (await db.ref('ratings_v2').once('value')).val();"), 'self-check: a reader without countable( is flagged');
assert.ok(!offends('ratings/aggregate.js', "const all = (await db.ref('ratings_v2').once('value')).val(); for (const x of v) if (V2.countable(x, t)) n++;"), 'self-check: a reader through countable( passes');
const files = execFileSync('git', ['ls-files', '--', '.'], { cwd: FN, encoding: 'utf8' }).split('\n')
  .filter((f) => /\.(js|mjs)$/.test(f) && !/(^|\/)node_modules\//.test(f) && !/\.test\.(js|mjs)$/.test(f) && !/^test\//.test(f));
const bad = files.filter((f) => offends(f, fs.readFileSync(path.join(FN, f), 'utf8')));
assert.deepStrictEqual(bad, [], `🔴 ratings_v2 reader(s) without countable(): ${bad.join(', ')}`);
ok(`no ratings_v2 reader bypasses countable() (${files.length} source files scanned; reviewed writers: ${[...ALLOWED].join(', ')})`);

console.log(`ratings-reader-contract.guard: OK (${n})`);
