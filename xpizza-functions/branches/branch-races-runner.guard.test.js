'use strict';
// ORCHESTRATION O1a — Codex r2 P3: the race runner can never pass silently. The unit runner is spawned with a preload that makes
// materializeBranch refuse at once (its scenarios' gates are never reached); it must exit NON-ZERO and say why (a GATE-TIMEOUT or
// SCENARIO-TIMEOUT, and the FAIL line) — not exit 0 with no output. A clean run is the control. Run: node branches/branch-races-runner.guard.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = path.join(__dirname, 'branch-races.test.js');
const env = { ...process.env, RACE_SCENARIO_MS: '1500' };
const probe = spawnSync(process.execPath, ['-r', path.join(__dirname, '..', 'test', '_probe-refuse-materialize.js'), runner], { encoding: 'utf8', env, timeout: 120000 });
const out = `${probe.stdout || ''}${probe.stderr || ''}`;
assert.notStrictEqual(probe.status, 0, `RUNNER-PROBE a refusing materializeBranch let the race runner exit 0:\n${out}`);
assert.match(out, /GATE-TIMEOUT|SCENARIO-TIMEOUT/, `RUNNER-PROBE the unreached gate is not named:\n${out}`);
assert.match(out, /branch-races: FAIL \(\d+\/\d+\)/, `RUNNER-PROBE no FAIL summary:\n${out}`);
console.log('  ✓ 1 a refusing materializeBranch makes the race runner FAIL loudly (timeout named, FAIL summary, non-zero exit)');
const control = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 120000 });
assert.strictEqual(control.status, 0, `RUNNER-PROBE control: the unmodified runner fails:\n${control.stdout}${control.stderr}`);
console.log('  ✓ 2 control: the unmodified runner passes');
console.log('\nbranch-races-runner.guard: OK (2)');
