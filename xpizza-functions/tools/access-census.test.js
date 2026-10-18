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
const noArgs = run(['--project', 'xpizza-delivery']);
assert.strictEqual(noArgs.code, 2, `no --mapping and no --sections → usage error\n${noArgs.out.slice(0, 300)}`); assert.match(noArgs.out, /usage: access-census/);
const ab = run(['--project', 'xpizza-delivery', '--sections', 'a,b']);
assert.ok(!/usage: access-census/.test(ab.out), `--sections a,b needs no mapping (gets past argument parsing)\n${ab.out.slice(0, 300)}`);
const abc = run(['--project', 'xpizza-delivery', '--sections', 'a,b,c']);
assert.strictEqual(abc.code, 2, '--sections with c needs --mapping'); assert.match(abc.out, /usage: access-census/);
// codex Q3 r1 P2-5: an unknown section or an empty selection is a USAGE error (exit 2) decided BEFORE any Admin client is built —
// the credential here is unavailable, so reaching admin.initializeApp would surface as a credential failure (exit 1) instead
for (const bad of ['z', 'a,z', ',', '']) {
  const r = run(['--project', 'xpizza-delivery', '--sections', bad]);
  assert.strictEqual(r.code, 2, `--sections ${JSON.stringify(bad)} → exit 2 (usage), before any credential\n${r.out.slice(0, 400)}`);
  assert.match(r.out, /usage: access-census/, `--sections ${JSON.stringify(bad)}: the usage line is what stopped it\n${r.out.slice(0, 400)}`);
  assert.ok(!/FAILED|credential|nonexistent/i.test(r.out), `--sections ${JSON.stringify(bad)}: nothing past argument parsing ran\n${r.out.slice(0, 400)}`);
}
console.log('access-census: OK (inherited project refused, exit 2; explicit --project accepted by the guard; --sections a,b needs no mapping, c needs one; unknown/empty sections → exit 2 before any credential)');
