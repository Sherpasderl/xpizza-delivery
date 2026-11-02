'use strict';
// S-A1 r4 (Codex r3 P1-1) — the rating-redaction GRACE is sized from the HARD ceiling. Cloud Run's request timeout does not cancel
// execution, so a writer's "deadline" is not a bound; the only ceiling is each writer's configured timeoutSeconds. This guard reads
// the DEPLOYED options of EVERY ratings_v2 writer from the REAL discovery manifest (firebase-functions' loadStack, in a child process
// with the egress guard — the otp-salt-secret / drvc-secrets method) and requires REDACT_GRACE_MS ≥ 2× the largest. Raising a
// writer's timeout past grace / 2 turns this RED. A NEW ratings_v2 writer must be added to WRITERS (ratings-reader-contract lists them).
// Run: node ratings/ratings-grace.guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
const WRITERS = ['rateOrder', 'stampRatingFulfilment'];   // every function that writes ratings_v2 (rateOrder creates owner-bearing nodes)
const { REDACT_GRACE_MS } = require(path.join(FN, 'signup-endpoints'));

const env = { ...process.env };
require(path.join(FN, 'tools', 'secret-env')).scrub(env);
for (const v of ['FUNCTION_TARGET', 'PORT', 'K_SERVICE']) delete env[v];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ratings-grace-'));
const manifestPath = path.join(out, 'manifest.json');
Object.assign(env, { GCLOUD_PROJECT: 'demo-xpizza-grace', FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath });
const bin = path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'bin', 'firebase-functions.js');
const r = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env, encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, `GRACE-LOAD the codebase did not load (status ${r.status}):\n${String(r.stderr).slice(-1500)}`);
const endpoints = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).endpoints || {};
fs.rmSync(out, { recursive: true, force: true });
ok(`the deployed options come from the real discovery manifest (${Object.keys(endpoints).length} endpoints)`);

for (const w of WRITERS) {
  const e = endpoints[w];
  assert.ok(e, `premise: ${w} is deployed`);
  assert.ok(Number.isInteger(e.timeoutSeconds) && e.timeoutSeconds > 0, `🔴 GRACE-EXPLICIT ${w} must declare timeoutSeconds (a platform default is not a reviewed ceiling)`);
  assert.ok(REDACT_GRACE_MS >= 2 * e.timeoutSeconds * 1000, `🔴 GRACE-CEILING REDACT_GRACE_MS ${REDACT_GRACE_MS} ms < 2 × ${w}.timeoutSeconds ${e.timeoutSeconds} s — raise the grace or lower the writer's timeout`);
}
const max = Math.max(...WRITERS.map((w) => endpoints[w].timeoutSeconds));
ok(`REDACT_GRACE_MS (${REDACT_GRACE_MS / 60000} min) ≥ 2 × the largest ratings_v2 writer timeout (${WRITERS.map((w) => `${w} ${endpoints[w].timeoutSeconds} s`).join(', ')}; max ${max} s)`);

assert.ok(endpoints.drainRatingRedactions && endpoints.drainRatingRedactions.scheduleTrigger, '🔴 the drain has its own scheduled function');
ok('the drain is its own scheduled function (drainRatingRedactions)');

console.log(`ratings-grace.guard: OK (${n})`);
