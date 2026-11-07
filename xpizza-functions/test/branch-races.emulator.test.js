/**
 * ORCHESTRATION O1a — Codex r1/r2: the lifecycle-writer races (test/_branch-races.js) over the REAL RTDB emulator (Admin SDK, incl.
 * its cached-null transaction pass), through the shared runner (per-scenario + per-gate deadlines, exact completion count). The same
 * scenarios run on the in-memory fake in branches/branch-races.test.js.
 *   npm run test:branch-races
 */
require('./_emulator-required')('database');

const admin = require('firebase-admin');
const { runScenarios } = require('./_branch-races');

(async () => {
  const NS = 'demo-xpizza-branch-races';   // its own namespace: a clean database, no other suite's data
  const app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}` }, 'branch-races');
  const db = app.database();
  await db.ref().set(null);
  const r = await runScenarios(() => db, { perScenarioMs: 30000 });
  if (r.failed.length) { console.error(`\nbranch-races.emulator: FAIL (${r.failed.length}/${r.total})`); process.exit(1); }
  console.log(`\nbranch-races.emulator: OK (${r.done})`);
  process.exit(0);
})().catch((e) => { console.error('branch-races.emulator FAILED:', e); process.exit(1); });
