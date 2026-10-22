'use strict';
// ORCHESTRATION O1a — Codex r1 on 203076e0: the four lifecycle-writer races (test/_branch-races.js) over the in-memory Admin-SDK
// fake. The SAME scenarios run on the REAL RTDB in test/branch-races.emulator.test.js. Run: node branches/branch-races.test.js
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');
const { SCENARIOS } = require('../test/_branch-races');

(async () => {
  let n = 0; const failed = [];
  for (const [label, run] of SCENARIOS) {
    try { await run(fakeRtdb({})); console.log(`  ✓ ${++n} ${label}`); } catch (e) { failed.push(`${label}: ${e.message}`); console.log(`  ✗ ${label}\n      ${e.message}`); }
  }
  if (failed.length) { console.error(`\nbranch-races: FAIL (${failed.length}/${SCENARIOS.length})`); process.exit(1); }
  console.log(`\nbranch-races: OK (${n})`);
})().catch((e) => { console.error('branch-races FAILED:', e); process.exit(1); });
