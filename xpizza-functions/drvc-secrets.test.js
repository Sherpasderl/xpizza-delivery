'use strict';
// DRIVER C — Secret Manager binding (owner ruling 2026-10-26): notifyArrivedOnTap declares EXACTLY its 6 keys as `secrets`, no
// other export declares any of them, and the codebase loads with those keys present as env (a bound secret reaches the
// container as an env var). The declared options are read from the REAL discovery manifest — firebase-functions' own
// loadStack/stackToWire, the bytes the CLI deploys from — in a CHILD process (index.js is not require-safe) with the egress
// guard preloaded and FUNCTIONS_MANIFEST_OUTPUT_PATH set, so it writes the manifest and exits: it never serves a port.
// Run: node drvc-secrets.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = __dirname;
const ARRIVED_SECRETS = ['MAKE_SECRET', 'ULTRAMSG_INSTANCE_ID', 'ULTRAMSG_TOKEN', 'ULTRAMSG_INSTANCE_ID_LA_MUSA', 'ULTRAMSG_TOKEN_LA_MUSA', 'TRACKING_BASE_LA_MUSA'];
const FAKE = Object.fromEntries(ARRIVED_SECRETS.map((k) => [k, k === 'TRACKING_BASE_LA_MUSA' ? 'https://tb-track.test' : `tb-${k.toLowerCase()}`]));

// the child's env: the scrubbed parent (no real credential), the 6 FAKE values, a demo project; FUNCTION_TARGET / PORT removed
const env = { ...process.env };
require('./tools/secret-env').scrub(env);
for (const v of ['FUNCTION_TARGET', 'PORT', 'K_SERVICE']) delete env[v];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-drvc-manifest-'));
const manifestPath = path.join(out, 'manifest.json');
Object.assign(env, FAKE, { GCLOUD_PROJECT: 'demo-xpizza-drvc', FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath });
assert.ok(env.FUNCTIONS_MANIFEST_OUTPUT_PATH, 'premise: the manifest path is set (without it the binary SERVES a port)');
const bin = path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'bin', 'firebase-functions.js');   // not in the package's exports map
assert.ok(fs.existsSync(bin), 'premise: the firebase-functions discovery binary is installed');
const r = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env, encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, `DRVC-SEC-LOAD the codebase did not load with the 6 keys present as env (status ${r.status}, signal ${r.signal}):\n${String(r.stderr).slice(-2000)}`);
assert.ok(!/ERR_R3_EGRESS_REFUSED/.test(r.stderr), 'DRVC-SEC-EGRESS loading the codebase attempted a non-loopback connection');
for (const v of Object.values(FAKE)) assert.ok(!String(r.stdout + r.stderr).includes(v), 'DRVC-SEC-NOECHO a secret value reached the load output');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const endpoints = manifest.endpoints || {};
ok(`the codebase loads with the 6 keys present as env (discovery manifest, ${Object.keys(endpoints).length} endpoints; no egress, no value echoed)`);

const keysOf = (e) => (e.secretEnvironmentVariables || []).map((s) => s.key);
assert.ok(endpoints.notifyArrivedOnTap, 'premise: notifyArrivedOnTap is in the manifest');
assert.deepStrictEqual(keysOf(endpoints.notifyArrivedOnTap).slice().sort(), ARRIVED_SECRETS.slice().sort(), 'DRVC-SEC-EXACT notifyArrivedOnTap declares exactly the 6 secrets');
assert.strictEqual(new Set(keysOf(endpoints.notifyArrivedOnTap)).size, 6, 'DRVC-SEC-NODUP no secret declared twice');
ok(`notifyArrivedOnTap declares exactly: ${ARRIVED_SECRETS.join(', ')}`);

const others = Object.entries(endpoints).filter(([id]) => id !== 'notifyArrivedOnTap');
assert.ok(others.length > 80, `premise: the manifest carries the other exports (${others.length})`);
for (const [id, e] of others) {
  const hit = keysOf(e).filter((k) => ARRIVED_SECRETS.includes(k));
  assert.deepStrictEqual(hit, [], `DRVC-SEC-ONLY ${id} also declares ${hit.join(', ')}`);
}
ok(`none of the other ${others.length} exports declares any of the 6 (they keep their plain env)`);

// the load-time readers: whatsapp.js reads its UltraMsg config at module load — with the keys present as env (how a bound
// secret arrives) both brands resolve from them
{
  const saved = {}; for (const k of ARRIVED_SECRETS) { saved[k] = process.env[k]; process.env[k] = FAKE[k]; }
  try {
    delete require.cache[require.resolve('./whatsapp')];
    const wa = require('./whatsapp');
    const x = wa.resolveWhatsappConfig('x_pizza'); const l = wa.resolveWhatsappConfig('la_musa');
    assert.ok(x && x.apiBase.endsWith(`/${FAKE.ULTRAMSG_INSTANCE_ID}`) && x.token === FAKE.ULTRAMSG_TOKEN, 'DRVC-SEC-WA-X x_pizza resolves from the env-injected keys');
    assert.ok(l && l.apiBase.endsWith(`/${FAKE.ULTRAMSG_INSTANCE_ID_LA_MUSA}`) && l.token === FAKE.ULTRAMSG_TOKEN_LA_MUSA && l.trackingBase === FAKE.TRACKING_BASE_LA_MUSA, 'DRVC-SEC-WA-L la_musa resolves from the env-injected keys');
  } finally {
    for (const k of ARRIVED_SECRETS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve('./whatsapp')];
  }
  ok('whatsapp.js load-time reads resolve both brands from the keys present as env');
}
fs.rmSync(out, { recursive: true, force: true });
console.log(`drvc-secrets: OK (${n})`);
