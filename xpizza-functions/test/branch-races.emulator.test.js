/**
 * ORCHESTRATION O1a — Codex r1 on 203076e0: the four lifecycle-writer races (test/_branch-races.js) over the REAL RTDB emulator
 * (Admin SDK, incl. its cached-null transaction pass). The same scenarios run on the in-memory fake in branches/branch-races.test.js.
 *   npm run test:branch-races
 */
require('./_emulator-required')('database');

const assert = require('assert');
const admin = require('firebase-admin');
const { SCENARIOS } = require('./_branch-races');

(async () => {
  const NS = 'demo-xpizza-branch-races';   // its own namespace: a clean database, no other suite's data
  const app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` }, 'branch-races');
  const db = app.database();
  await db.ref().set(null);
  let n = 0; const failed = [];
  for (const [label, run] of SCENARIOS) {
    try { await run(db); console.log(`  ✓ ${++n} ${label}`); } catch (e) { failed.push(label); console.log(`  ✗ ${label}\n      ${e.message}`); }
  }
  assert.ok(n + failed.length === SCENARIOS.length && SCENARIOS.length >= 6, 'non-vacuity: every scenario ran');
  if (failed.length) { console.error(`\nbranch-races.emulator: FAIL (${failed.length}/${SCENARIOS.length})`); process.exit(1); }
  console.log(`\nbranch-races.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('branch-races.emulator FAILED:', e); process.exit(1); });
