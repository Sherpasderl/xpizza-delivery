// dispatch-maps-perf.mjs — PLAN-dispatch-maps-decouple §6.4 measurement harness.
//
// Measures that the board becomes useful INDEPENDENT of Google Maps. Single timing origin t0 = the
// onAuth-authorized showScreen('main'); metrics board-useful (t0 → a seeded fixture order card + its assign
// control present) and driver-useful (t0 → a seeded driver roster row), each under three scenarios:
//   maps_delayed  — the Maps script is held (served after a long delay)
//   maps_failed   — the Maps script request is aborted
//   no_map_baseline — the Maps script is held indefinitely (the baseline board-useful/driver-useful)
//
// Harness contract (pinned):
//   - chrome-headless-shell, mac_arm-131.0.6778.204 (the version the dispatch CDP suites already use)
//   - viewport 1440x900 DPR1, CPU throttle 4x, network Slow-4G (~400 kb/s, 400 ms RTT) via CDP
//   - observation deadline 10 s/run; a metric not reached by 10 s is recorded as a failure, not a hang
//   - CDP network interception serves a local fixture of index.html; Firebase + Maps are intercepted and RTDB
//     snapshots are injected through a stubbed XPD, so NO real network and NO real backend are used
//   - >= 5 repeats/scenario; the MEDIAN gates, p95 is reported
//   - artifact: ./dispatch-maps-perf.json (median+p95 per metric per scenario, plus pass/fail vs budget)
//
// Budgets (executable, PLAN §6.4): median board-useful AND median driver-useful under maps_delayed/maps_failed
//   must be <= 1.15x their OWN no_map_baseline medians; no long task > 50 ms from this code during load;
//   input-to-paint (assign click) <= 100 ms. Map-useful is NOT budgeted (depends on Google's CDN).
//
// NB: the measured run is a HEAVY-SLOT activity (spawns Chrome, full page + interception). This module is the
// harness; `node dispatch-maps-perf.mjs` performs the run and writes the artifact. Run it in the gate/heavy env.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, 'dispatch-maps-perf.json');

export const CONFIG = {
  chrome: { kind: 'chrome-headless-shell', version: 'mac_arm-131.0.6778.204' },
  viewport: { width: 1440, height: 900, dpr: 1 },
  throttle: { cpu: 4, network: { label: 'Slow-4G', downKbps: 400, upKbps: 400, rttMs: 400 } },
  timingOrigin: "onAuth-authorized showScreen('main')",
  deadlineMs: 10_000,
  repeats: 5,
  gate: 'median',
  scenarios: ['maps_delayed', 'maps_failed', 'no_map_baseline'],
  metrics: ['board_useful_ms', 'driver_useful_ms', 'input_to_paint_ms', 'max_long_task_ms'],
  budgets: {
    board_useful_vs_baseline_max_ratio: 1.15,
    driver_useful_vs_baseline_max_ratio: 1.15,
    max_long_task_ms: 50,
    input_to_paint_ms: 100,
    map_useful: 'not budgeted (depends on Google CDN)',
  },
  readiness: {
    board_useful: "first orders+tasks snapshot AND a seeded '.unassigned-card[data-order-id]' with its assign control present",
    driver_useful: 'a seeded driver roster row rendered (independent of board-useful and of Maps)',
    map_useful: 'mapReady === true AND the one post-init replay ran',
  },
};

// The measured run (heavy). Separated so CONFIG/ARTIFACT schema can be imported + asserted by a light test.
export async function run() {
  // Intentionally not auto-run in the light lane. Wiring the CDP driver (chrome-remote-interface / puppeteer-core),
  // the fixture server, Firebase/Maps interception, and the injected-snapshot XPD stub happens in the heavy slot.
  throw new Error('dispatch-maps-perf: measured run must be invoked in the heavy/gate env (Chrome required).');
}

// Writing the artifact: on a real run, fill `results` with measured medians/p95 + pass/fail. Until then, emit
// the harness contract with status "pending" — never fabricated numbers (perf numbers are measured, not claimed).
function writeArtifact(results) {
  const doc = {
    plan: 'PLAN-dispatch-maps-decouple §6.4',
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    status: results ? 'measured' : 'pending-heavy-slot',
    results: results || null,
  };
  writeFileSync(ARTIFACT, JSON.stringify(doc, null, 2) + '\n');
  return ARTIFACT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Light invocation: emit the harness contract artifact (status pending). The heavy run replaces `results`.
  const flagRun = process.argv.includes('--run');
  if (flagRun) { await run(); }
  else { const p = writeArtifact(null); console.log('wrote harness-contract artifact (status pending-heavy-slot):', p); }
}

export { writeArtifact, ARTIFACT };
