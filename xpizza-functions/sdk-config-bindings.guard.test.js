'use strict';
// D4 row 16 / S7 (d) (NOTE-sdk-d4-S7-plan.md; advisor 11-12: «the reach set EQUALS the binding set») — every Cloud Function that can
// reach the SDK payment provider declares the SDK_PP_CONFIG secret, and NO other does; SDK_OTP_SENDER is bound on exactly the three
// recovery functions. Firebase reads a secret version at DEPLOY, so a function that reaches the provider without the binding would
// run UNCONFIGURED (every PSP call → unknown → a lock) — e.g. a merchant reject of an SDK-paid order could not void the hold.
//   1. the CALL-SITE inventory: every non-test call of productionDeps( / productionEndpointDeps's psp builder / cancelOrderCore( /
//      cancelSdkOrder( / the merchant cancelCore binding is a REVIEWED site, each mapped to the exports it serves — a new site fails
//      here until it is reviewed into REACH;
//   2. the REAL discovery manifest (firebase-functions' own loadStack, the bytes the CLI deploys from): the exports declaring
//      SDK_PP_CONFIG are EXACTLY REACH, and those declaring SDK_OTP_SENDER are EXACTLY the recovery set.
// Each failure message starts with SCB-<check>. Run: node sdk-config-bindings.guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = __dirname;
// the REVIEWED reach set: the exports whose handler can reach payments/sdk/deps.productionDeps (directly, or through
// cancelOrderCore → cancelSdkOrder → the void)
const REACH = ['cancelPaidOrder', 'cancelSdkPending', 'merchantReject', 'placeSdkOrder', 'placeSdkStatus', 'settleSdkOnStatus', 'sweepSdkPayments'];
const RECOVERY = ['processSdkRecovery', 'recoverOrderAccess', 'sweepSdkRecovery'];
// the reviewed call sites: file → the call texts it may contain (counted), each serving REACH exports
const SITES = {
  'index.js': { 'productionDeps(': 2, 'cancelOrderCore(': 2 },                       // B2 + B4 (placeSdkOrder); cancelPaidOrder + the merchant cancel binding
  'payments/sdk/functions.js': { 'productionDeps(': 2 },                             // sweepSdkPayments, settleSdkOnStatus
  'payments/sdk/endpoints.js': { 'productionDeps(': 1 },                             // the PSP deps: placeSdkStatus, cancelSdkPending ONLY
  'merchant/merchant-wiring.js': { 'cancelCore()': 1 },                              // merchantReject (the injected cancelOrderCore)
  'cancel-order-core.js': { 'productionDeps(': 1, 'cancelSdkOrder(': 1 },            // its SDK route — reached only through cancelOrderCore (above)
  'payments/sdk/finish.js': { 'cancelSdkOrder(': 1 },                                // inside placeSdkOrder
  'payments/sdk/sweeper.js': { 'cancelSdkOrder(': 1 },                               // inside sweepSdkPayments
  'payments/sdk/switch-endpoint.js': { 'cancelSdkOrder(': 2 },                       // inside cancelSdkPending
  'payments/sdk/coordinator.js': { 'cancelSdkOrder(': 1 },                           // expirePending (sweeper / status paths)
};
const TEXTS = ['productionDeps(', 'cancelOrderCore(', 'cancelSdkOrder(', 'cancelCore()'];
{
  const files = execFileSync('git', ['ls-files', '*.js'], { cwd: FN, encoding: 'utf8' }).split('\n').filter((f) => f && !/test\.js$|^test\/|^tools\/|\.guard\.|^contract\//.test(f));
  const found = {};
  for (const f of files) {
    const code = fs.readFileSync(path.join(FN, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const t of TEXTS) {
      // a CALL: not the definition (`function name(` / `name = (`)
      const k = code.split(t).length - 1 - (code.split(`function ${t}`).length - 1);
      if (k > 0) (found[f] = found[f] || {})[t] = k;
    }
  }
  for (const f of ['payments/sdk/deps.js', 'merchant/merchant-core-binding.js']) delete found[f];   // the definitions' own files
  assert.deepStrictEqual(found, SITES, `SCB-SITES the provider-reaching call sites changed — review each into REACH (got ${JSON.stringify(found)})`);
  ok(`every provider-reaching call site is a reviewed site (${Object.keys(SITES).length} files)`);
}

// the REAL discovery manifest (the otp-salt-secret.test.js / drvc-secrets method)
const env = { ...process.env };
require('./tools/secret-env').scrub(env);
for (const v of ['FUNCTION_TARGET', 'PORT', 'K_SERVICE']) delete env[v];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sdk-bindings-manifest-'));
const manifestPath = path.join(out, 'manifest.json');
Object.assign(env, { OTP_SALT: 'tb-otp-salt-'.padEnd(40, 'x'), GCLOUD_PROJECT: 'demo-xpizza-sdkbind', FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath });
const bin = path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'bin', 'firebase-functions.js');
const r = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env, encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, `SCB-LOAD the codebase did not load (status ${r.status}):\n${String(r.stderr).slice(-2000)}`);
const endpoints = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).endpoints || {};
fs.rmSync(out, { recursive: true, force: true });
const keysOf = (e) => (e.secretEnvironmentVariables || []).map((s) => s.key);
const declaring = (k) => Object.entries(endpoints).filter(([, e]) => keysOf(e).includes(k)).map(([id]) => id).sort();
for (const id of [...REACH, ...RECOVERY]) assert.ok(endpoints[id], `SCB-MANIFEST premise: ${id} is a deployed export`);
assert.deepStrictEqual(declaring('SDK_PP_CONFIG'), REACH, `SCB-PP the exports declaring SDK_PP_CONFIG must EQUAL the reach set (got ${declaring('SDK_PP_CONFIG').join(', ')})`);
ok(`SDK_PP_CONFIG is declared by EXACTLY the ${REACH.length} provider-reaching exports`);
assert.deepStrictEqual(declaring('SDK_OTP_SENDER'), RECOVERY, `SCB-SENDER the exports declaring SDK_OTP_SENDER must be EXACTLY the recovery set (got ${declaring('SDK_OTP_SENDER').join(', ')})`);
ok('SDK_OTP_SENDER is declared by EXACTLY the three recovery functions');
console.log(`\nsdk-config-bindings.guard: OK (${n})`);
