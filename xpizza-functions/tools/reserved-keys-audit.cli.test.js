'use strict';
// S1c D5 — the reservation audit CLI refuses before any client: no --project flag, a project other than the repo's, an unknown
// or repeated argument, or no --rid. (Its reads and its one-transaction apply are pinned by test/reserved-keys-audit.emulator.test.js.)
// Run: node tools/reserved-keys-audit.cli.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const CLI = path.join(__dirname, 'reserved-keys-audit.js');
const env = { ...process.env }; delete env.GOOGLE_CLOUD_PROJECT; delete env.GCLOUD_PROJECT; delete env.GOOGLE_APPLICATION_CREDENTIALS;
for (const k of Object.keys(env)) if (/EMULATOR_HOST$|^FIREBASE_AUTH_EMULATOR/.test(k)) delete env[k];   // the project guard refuses a half-configured emulator set on its own
// no credential can resolve: if a refusal ever regressed, the run fails at its first token fetch instead of reading a real project
env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, 'no-such-credential-file.json'); env.CLOUDSDK_CONFIG = path.join(__dirname, 'no-such-gcloud-config');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 20000 });

for (const [args, want, label] of [
  [['--rid=tb_x'], /project_guard_refused/, 'RKC-NOPROJECT no --project'],
  [['--rid=tb_x', '--project', 'some-other-project'], /project_guard_refused/, 'RKC-WRONGPROJECT another project'],
  [['--project', 'xpizza-delivery', '--rid=tb_x', '--yes'], /REFUSED — unrecognised|REFUSED — unknown/, 'RKC-UNKNOWN an unknown flag'],
  [['--project', 'xpizza-delivery', '--rid=tb_x', '--apply', '--apply'], /more than once/, 'RKC-REPEAT a repeated flag'],
  [['--project', 'xpizza-delivery'], /--rid=<rid> is required/, 'RKC-NORID no --rid'],
]) {
  const r = run(...args);
  assert.notStrictEqual(r.status, 0, `${label}: refused (exit ≠ 0)`);
  assert.match(`${r.stdout}\n${r.stderr}`, want, `${label}: the refusal names its reason`);
  assert.ok(!/reserved_keys: (would add|added)/.test(r.stdout), `${label}: nothing was read or written`);
}
ok('the CLI refuses before any client: no / wrong project, unknown or repeated argument, no --rid');
console.log(`\nreserved-keys-audit.cli: OK (${n})`);
