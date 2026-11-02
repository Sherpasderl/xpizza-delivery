'use strict';
// PLAN-capp-native-shell D3 — the customer app's RUNTIME transport in platform/sites.json (the platform orders deployment's
// `runtime` block). Its keys are the PUBLIC client keys the live forms already serve; because the forms stay byte-unchanged the
// block is a second committed copy, so this guard pins it EQUAL to the forms' own literals (BOTH forms) — it can never drift.
// Key values are compared with assert.ok only: a failure names the field, never prints a value. Run: node platform-runtime.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const RT = M.PLATFORM.appRuntime();
const FORMS = M.PLATFORM.sites.deployments.filter((d) => d.app === 'orders' && d.context !== M.PLATFORM_CONTEXT).map((d) => d.folder);

// 1. present and valid on the live manifest
assert.ok(RT && typeof RT === 'object', 'premise: the app deployment carries a runtime block');
assert.deepStrictEqual(M.validateManifest(M.PLATFORM.sites), []);
assert.match(RT.note, /PUBLIC client keys/); assert.match(RT.note, /NOT secrets/);
assert.strictEqual(RT.functions_base, `https://us-central1-${RT.firebase.projectId}.cloudfunctions.net`, 'ONE exact functions host (the native CSP names it)');
ok('the runtime block validates; its note says these are public client keys, not secrets; one cloudfunctions.net host');

// 2. DRIFT: equal to EACH live form's committed literals
assert.ok(FORMS.length >= 2, 'premise: both order forms');
for (const f of FORMS) {
  const html = fs.readFileSync(path.join(ROOT, f, 'index.html'), 'utf8'), acct = fs.readFileSync(path.join(ROOT, f, 'account.js'), 'utf8');
  const ik = html.match(/const ORDER_SECRET\s*=\s*'([^']+)'/), mk = html.match(/maps\/api\/js\?key=([A-Za-z0-9_-]+)&/), fbm = acct.match(/fb:\s*\{([\s\S]*?)\}/);
  assert.ok(ik && mk && fbm, `premise: ${f} still carries its intake key, Maps key and Firebase config literals`);
  assert.ok(ik[1] === RT.intake_key, `🔴 runtime.intake_key differs from ${f}/index.html's`);
  assert.ok(mk[1] === RT.maps_key, `🔴 runtime.maps_key differs from ${f}/index.html's`);
  const fb = Object.fromEntries([...fbm[1].matchAll(/(\w+)\s*:\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
  for (const k of Object.keys(RT.firebase)) assert.ok(fb[k] === RT.firebase[k], `🔴 runtime.firebase.${k} differs from ${f}/account.js's`);
  assert.ok(Object.keys(fb).length === Object.keys(RT.firebase).length, `🔴 ${f}/account.js's Firebase config has fields the runtime lacks`);
}
ok(`intake_key, maps_key and every firebase field EQUAL the literals in ${FORMS.join(' and ')} (values never printed)`);

// 3. the validator refuses a malformed block, and the block only on the app deployment
const clone = () => JSON.parse(JSON.stringify(M.PLATFORM.sites));
const appOf = (m) => m.deployments.find((d) => d.app === 'orders' && d.context === M.PLATFORM_CONTEXT);
const bad = (mut, re) => { const c = clone(); mut(c); assert.throws(() => M.loadPlatform(c, M.PLATFORM.compat), re); };
bad((c) => { appOf(c).runtime.extra = 1; }, /runtime must be exactly/);
bad((c) => { delete appOf(c).runtime.note; }, /runtime must be exactly/);
bad((c) => { appOf(c).runtime.note = ''; }, /public client keys/);
bad((c) => { appOf(c).runtime.functions_base = 'http://us-central1-x.cloudfunctions.net'; }, /functions_base must be an exact https origin/);
bad((c) => { appOf(c).runtime.functions_base = 'https://*.cloudfunctions.net'; }, /functions_base must be an exact https origin/);
bad((c) => { appOf(c).runtime.menu_endpoint = '../menu'; }, /menu_endpoint/);
bad((c) => { appOf(c).runtime.intake_key = 'short'; }, /intake_key malformed/);
bad((c) => { appOf(c).runtime.maps_key = 'has space in it xxxxxxxxxxxxx'; }, /maps_key malformed/);
bad((c) => { delete appOf(c).runtime.firebase.appId; }, /runtime\.firebase must be exactly/);
bad((c) => { appOf(c).runtime.availability_base = 'https://other.firebaseio.com'; }, /availability_base must be the firebase databaseURL/);
bad((c) => { c.deployments.find((d) => d.app === 'orders' && d.context !== M.PLATFORM_CONTEXT).runtime = appOf(c).runtime; }, /runtime is only for the platform orders deployment/);
ok('refused: extra / missing keys, an empty note, http / wildcard bases, a path-like endpoint, malformed keys, an incomplete firebase config, a foreign availability base, a runtime block on a form');

// 3b. support_whatsapp (owner 2026-11-01: Sherpa's help WhatsApp, E.164) — optional, shape-checked; the committed value is the owner's
assert.strictEqual(RT.support_whatsapp, '+50497952893', '🔴 the owner-confirmed help number, E.164, in the ONE runtime block');
bad((c) => { appOf(c).runtime.support_whatsapp = '97952893'; }, /support_whatsapp must be E\.164/);
bad((c) => { appOf(c).runtime.support_whatsapp = '+504 9795 2893'; }, /support_whatsapp must be E\.164/);
bad((c) => { appOf(c).runtime.support_whatsapp = 50497952893; }, /support_whatsapp must be E\.164/);
{ const c2 = clone(); delete appOf(c2).runtime.support_whatsapp; assert.deepStrictEqual(M.validateManifest(c2), [], 'absent ⇒ still valid (optional)'); }
ok('runtime.support_whatsapp = the owner\'s E.164 number; malformed refused; absent allowed (optional)');

// 4. absent ⇒ appRuntime() is null (nothing invented)
const c = clone(); delete appOf(c).runtime;
assert.strictEqual(M.loadPlatform(c, M.PLATFORM.compat).appRuntime(), null);
ok('no runtime block ⇒ appRuntime() is null');
console.log(`platform-runtime: OK (${n})`);
