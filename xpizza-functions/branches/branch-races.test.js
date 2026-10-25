'use strict';
// ORCHESTRATION O1a — Codex r1/r2: the lifecycle-writer races (test/_branch-races.js) over the in-memory Admin-SDK fake, through
// the shared runner (per-scenario + per-gate deadlines, exact completion count). The SAME scenarios run on the REAL RTDB in
// test/branch-races.emulator.test.js. Run: node branches/branch-races.test.js
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const { runScenarios } = require('../test/_branch-races');

(async () => {
  const r = await runScenarios(() => fakeRtdb({}), { perScenarioMs: Number(process.env.RACE_SCENARIO_MS) || 20000 });
  if (r.failed.length) { console.error(`\nbranch-races: FAIL (${r.failed.length}/${r.total})`); process.exit(1); }
  console.log(`\nbranch-races: OK (${r.done})`);
  process.exit(0);
})().catch((e) => { console.error('branch-races FAILED:', e); process.exit(1); });
