'use strict';
// TRACKER FIXES T6 — the test-only MODULE INVERSE of retention-sweep.js (BUILD r1.5 "Inverse: the retention-sweep call-site hunk
// gets a module inverse + guard"). unapplyTrackerRetention(retention-sweep.js) === e8e77e24:retention-sweep.js byte-for-byte
// (tracker-retention-wiring.guard.test.js). Hunks: (1) the task pass renamed runTaskPass; (2) the runRetentionSweep wrapper that runs
// the tombstone sweep after it. Each hunk must occur EXACTLY once, else this throws. GENERATED from base vs candidate; JSON-quoted.

const MODULE = 'retention-sweep.js';   // the module this inverse reverses (form-source-inventory registers inverses by name)

const HUNKS = [
 [
  "// decoupled + testable.\nasync function runTaskPass(db, { healTerminalStatuses }) {\n  // Read /tasks BEFORE /orders (sequential, NOT Promise.all) as defense-in-depth: a task is written atomically\n",
  "// decoupled + testable.\nasync function runRetentionSweep(db, { healTerminalStatuses }) {\n  // Read /tasks BEFORE /orders (sequential, NOT Promise.all) as defense-in-depth: a task is written atomically\n"
 ],
 [
  "\n// TRACKER FIXES T6: the claims-index tombstone sweep runs AFTER the task pass — whatever it returned (dry-run, no candidates,\n// execute) — in its own try/catch, so it never affects task deletion or attribution, and regardless of the tracker flag\n// (tombstones from an earlier ON period must still expire). The task pass's result is returned unchanged.\nasync function runRetentionSweep(db, opts) {\n  const r = await runTaskPass(db, opts);\n  try {\n    const t = await require('./tracking/tombstones').sweepTrackerTombstones(db, Date.now());\n    if (t.scanned) console.log(`retentionSweepTasks: tracker tombstones — deleted ${t.deleted}, kept ${t.kept} of ${t.scanned}`);\n  } catch (e) { console.warn('retentionSweepTasks: tracker tombstone sweep failed (task pass unaffected)', e && e.message); }\n  return r;\n}\n\nmodule.exports = { runRetentionSweep };\n",
  "\nmodule.exports = { runRetentionSweep };\n"
 ]
];

function unapplyTrackerRetention(src) {
  let out = src;
  for (const [cand, base] of HUNKS) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`tracker-retention-inverse: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}

module.exports = { unapplyTrackerRetention, HUNKS, MODULE };
