'use strict';
// PLAN-S5 — the index.js inverse-fold guard for this slice. Run: node s5-wiring.guard.test.js
//   1. PROOF: tools/s5-inverse.js turns index.js back into the base (b98cd04d) BYTE-FOR-BYTE — the inverse every fold guard
//      and pin chain applies FIRST; an edit inside a hunk, a duplicated hunk and a byte outside are each caught.
//   2. The hunks are exactly the plan's: the ready_at branch (in the status writer's if/else chain, on 'ready' only) and the
//      prepStatsDaily require + scheduled export (the scheduler shape of §5.1).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyS5Index, HUNKS, BASE } = require('./tools/s5-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))))))));   // H1c, then H1a (newer), are reversed FIRST: this checks S5's own layer
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.notStrictEqual(unapplyS5Index(real), real, 'non-vacuity: the s5 hunks are present and swapped back');
assert.strictEqual(unapplyS5Index(real), base, `🔴 index.js minus the s5 hunks is not ${BASE}:index.js`);
assert.throws(() => unapplyS5Index(real.replace("order_tracking/${trackingToken}/ready_at`] = ServerValue.TIMESTAMP;", "order_tracking/${trackingToken}/ready_at`] = Date.now();")), /occurs 0 times/, 'an edit INSIDE a hunk');
assert.throws(() => unapplyS5Index(real + HUNKS[1].now), /occurs 2 times/, 'a duplicated hunk');
assert.notStrictEqual(unapplyS5Index(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the hunks survives (the base pin catches it)');
ok(`index.js: unapplyS5Index → ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks); an edit inside, a duplicated hunk and a byte outside are each caught`);

{
  const block = (h) => { const m = h.now.match(/\/\* s5:begin ([a-z-]+) \*\/[\s\S]*?\/\* s5:end \1 \*\//); assert.ok(m, 'each hunk is one delimited s5 block'); return m[0]; };
  const [ready, job] = HUNKS.map(block);
  assert.ok(/\} else if \(after === 'ready'\) \{\n\s+trackingUpdates\[`order_tracking\/\$\{trackingToken\}\/ready_at`\] = ServerValue\.TIMESTAMP;/.test(ready), 'the ready branch stamps ready_at with the server clock');
  assert.ok(/picked_up_at`\] = ServerValue\.TIMESTAMP;[\s\S]*after === 'ready'[\s\S]*after === 'delivered'/.test(HUNKS[0].now), 'the branch sits in the same if/else chain as picked_up_at / delivered_at');
  assert.strictEqual((ready.match(/trackingUpdates\[/g) || []).length, 1, 'one stamp, nothing else');
  assert.ok(job.includes("const { runPrepStats } = require('./prep-stats');") && /exports\.prepStatsDaily = onSchedule\(\s*\{ schedule: 'every day 04:00', timeZone: 'America\/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' \}/.test(job), 'the scheduler: daily 04:00 Tegucigalpa, 300 s, 256 MiB');
  assert.ok(/runPrepStats\(\{ db: getDatabase\(\), nowMs: Date\.now\(\), log: console \}\)/.test(job), 'the job runs on the module\'s Admin db (no second connection)');
  assert.ok(!/x_pizza|la_musa|xpizza|lamusa/i.test(HUNKS.map((h) => h.now).join('') + fs.readFileSync(path.join(__dirname, 'prep-stats.js'), 'utf8').replace(/\/\/.*$/gm, '')), '🔴 no brand literal in the s5 hunks or prep-stats.js');
  ok('the hunks are exactly the plan\'s: ready_at on the ready transition only (server clock, same chain as picked_up_at), and the prepStatsDaily scheduler (daily 04:00, 300 s, 256 MiB, the module db); no brand literal');
}
console.log(`\ns5-wiring.guard: OK (${n})`);
