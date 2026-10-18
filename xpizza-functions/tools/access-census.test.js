'use strict';
// PLATFORM F2 Q1 — the REAL access-census CLI pins the project: an INHERITED GOOGLE_CLOUD_PROJECT alone is refused (exit 2, project_guard_refused)
// before any client; with an explicit --project the guard lets it through. Safe by construction: no credential resolves, both data
// hosts are the dead port 127.0.0.1:1, the R1 emulator variables are scrubbed, no --apply. Run: node tools/access-census.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRUB = ['FUNCTIONS_EMULATOR', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_EMULATOR_HUB', 'XPIZZA_EMU_OFFSET', 'XPIZZA_EMU_SERVICES',
  'XPIZZA_EMU_DEAD', 'XPIZZA_EMU_RUN', 'FUNCTION_TARGET', 'FIREBASE_CONFIG', 'FB_DATABASE_URL'];
const run = (args) => {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, { GOOGLE_CLOUD_PROJECT: 'xpizza-delivery', GCLOUD_PROJECT: '', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'access-census.js'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000, env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const inherited = run(['--mapping', '/nonexistent.json']);
assert.strictEqual(inherited.code, 2, `inherited GOOGLE_CLOUD_PROJECT alone must exit 2\n${inherited.out.slice(0, 400)}`);
assert.match(inherited.out, /project_guard_refused/, `the project guard must be what stopped it\n${inherited.out.slice(0, 400)}`);
const stated = run(['--project', 'xpizza-delivery', '--mapping', '/nonexistent.json']);
assert.ok(!/project_guard_refused/.test(stated.out), `control: with --project the guard lets it through\n${stated.out.slice(0, 400)}`);
// positive marker: the guard ACCEPTED the explicit flag (it then stops at the nonexistent credential — nothing reachable)
assert.match(stated.out, /project: xpizza-delivery\s+\(stated explicitly/, `control: the guard accepted --project\n${stated.out.slice(0, 400)}`);
console.log('access-census: OK (inherited project refused, exit 2; explicit --project accepted by the guard)');
