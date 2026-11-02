'use strict';
// GUEST-SERVER train item (advisor ruling 2026-11-01): deploy-dotenv-guard ships this train, so a NEW function gets NO plain env
// at deploy (no dotenv is copied; existing functions keep their deployed env via inferDetailsFromExisting). OTP_SALT therefore
// reaches the three NEW otp-lib readers as a Secret Manager secret, bound on EXACTLY them:
//   requestCheckoutCode, verifyCheckoutCode, redeemSignupGrant (+ S-A(d) getMerchantRatingComments: the sealed-cursor key, HKDF-derived)
// and on NO other export — above all not on the EXISTING plain-env readers (requestOtp, verifyOtp, chargeOnlineOrder, claimOrder):
// the same name as a secret there is the secret/plain overlap the dotenv guard exists to prevent. Readers stay
// process.env.OTP_SALT (a bound secret arrives there); otp-lib reads it at ITS module load, so every require of it must be lazy
// (inside a handler — never at a module's top level), which runs after the container's env is in place.
// The declared options are read from the REAL discovery manifest (firebase-functions' own loadStack → the bytes the CLI deploys
// from), in a child process with the egress guard preloaded — the drvc-secrets.test.js method.
// Run: node otp-salt-secret.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = __dirname;
const BOUND = ['requestCheckoutCode', 'verifyCheckoutCode', 'redeemSignupGrant', 'getMerchantRatingComments'];   // + S-A(d): its cursor key is HKDF(OTP_SALT) — a NEW function, read lazily from process.env
const EXISTING_READERS = ['requestOtp', 'verifyOtp', 'chargeOnlineOrder', 'claimOrder'];
const FAKE_SALT = 'tb-otp-salt-'.padEnd(40, 'x');

// 1. the real discovery manifest, the codebase loaded with OTP_SALT present only as env (how a bound secret arrives)
const env = { ...process.env };
require('./tools/secret-env').scrub(env);
for (const v of ['FUNCTION_TARGET', 'PORT', 'K_SERVICE']) delete env[v];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-otp-salt-manifest-'));
const manifestPath = path.join(out, 'manifest.json');
Object.assign(env, { OTP_SALT: FAKE_SALT, GCLOUD_PROJECT: 'demo-xpizza-otpsalt', FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath });
const bin = path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'bin', 'firebase-functions.js');
assert.ok(fs.existsSync(bin), 'premise: the firebase-functions discovery binary is installed');
const r = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env, encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, `OTPS-LOAD the codebase did not load (status ${r.status}, signal ${r.signal}):\n${String(r.stderr).slice(-2000)}`);
assert.ok(!/ERR_R3_EGRESS_REFUSED/.test(r.stderr), 'OTPS-EGRESS loading the codebase attempted a non-loopback connection');
assert.ok(!String(r.stdout + r.stderr).includes(FAKE_SALT), 'OTPS-NOECHO the salt value reached the load output');
const endpoints = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).endpoints || {};
fs.rmSync(out, { recursive: true, force: true });
ok(`the codebase loads with OTP_SALT as env (discovery manifest, ${Object.keys(endpoints).length} endpoints; no egress, no value echoed)`);

// 2. EXACTLY the three NEW readers declare secret OTP_SALT; no other export does — the existing plain readers included
const keysOf = (e) => (e.secretEnvironmentVariables || []).map((s) => s.key);
for (const id of [...BOUND, ...EXISTING_READERS]) assert.ok(endpoints[id], `premise: ${id} is in the manifest`);
for (const id of BOUND) assert.ok(keysOf(endpoints[id]).includes('OTP_SALT'), `🔴 OTPS-BOUND ${id} does not declare secret OTP_SALT (a NEW function gets no plain env ⇒ otp-lib fails closed ⇒ 500)`);
const declaring = Object.entries(endpoints).filter(([, e]) => keysOf(e).includes('OTP_SALT')).map(([id]) => id).sort();
assert.deepStrictEqual(declaring, BOUND.slice().sort(), `🔴 OTPS-EXACT the exports declaring secret OTP_SALT are ${declaring.join(', ')}`);
for (const id of EXISTING_READERS) assert.ok(!keysOf(endpoints[id]).includes('OTP_SALT'), `🔴 OTPS-PLAIN ${id} must keep its deployed plain OTP_SALT (no secret/plain overlap)`);
for (const id of BOUND) assert.strictEqual(keysOf(endpoints[id]).filter((k) => k === 'OTP_SALT').length, 1, `OTPS-NODUP ${id}`);
assert.ok(keysOf(endpoints.redeemSignupGrant).includes('SIGNUP_GRANT_SECRET'), 'redeemSignupGrant still binds SIGNUP_GRANT_SECRET');
ok(`secret OTP_SALT is declared by EXACTLY ${BOUND.join(', ')}; none of the existing readers (${EXISTING_READERS.join(', ')}) nor any other export declares it; redeemSignupGrant keeps SIGNUP_GRANT_SECRET`);

// 3. the readers: process.env.OTP_SALT read by otp-lib at ITS load; every require of otp-lib is lazy (never at a module's top level)
{
  // (no source-text read of otp-lib: the env path is proven BEHAVIOURALLY below — it loads from an injected salt, the codebase without one)
  // the whole codebase loads with OTP_SALT ABSENT (otp-lib throws at its own load on a missing salt): no module reads it eagerly
  const env0 = { ...env, FUNCTIONS_MANIFEST_OUTPUT_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-otp-salt-nosalt-')), 'm.json') };
  delete env0.OTP_SALT;
  const r0 = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env: env0, encoding: 'utf8', timeout: 120000 });
  fs.rmSync(path.dirname(env0.FUNCTIONS_MANIFEST_OUTPUT_PATH), { recursive: true, force: true });
  assert.strictEqual(r0.status, 0, `🔴 OTPS-LAZY the codebase does not load WITHOUT OTP_SALT — something reads it at module load, before a bound secret could matter:\n${String(r0.stderr).slice(-1500)}`);
  const saved = process.env.OTP_SALT; process.env.OTP_SALT = FAKE_SALT;
  try { delete require.cache[require.resolve('./otp-lib')]; assert.ok(/^[0-9a-f]{64}$/.test(require('./otp-lib').phoneHash('50499990000')), 'otp-lib loads and hashes from the env-injected salt'); }
  finally { if (saved === undefined) delete process.env.OTP_SALT; else process.env.OTP_SALT = saved; delete require.cache[require.resolve('./otp-lib')]; }
}
ok('readers: otp-lib reads process.env.OTP_SALT at its own load; the WHOLE codebase loads with OTP_SALT absent (every otp-lib require is lazy, inside a handler); it loads from the env-injected value');

console.log(`otp-salt-secret: OK (${n})`);
