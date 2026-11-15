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
// Codex S7 r1 P2-1: the reach set is DERIVED from the code (export → handler → deps), never hard-coded:
//   payments/sdk/functions.js  an export reaches iff its handler is handlerOf('n') with n in the PSP_HANDLERS set literal, or it calls
//                              productionDeps( directly;
//   merchant/merchant-wiring.js an export reaches iff its handler uses a name tainted by the injected cancelCore() (fixpoint);
//   index.js                   an export reaches iff its handler — the SDK_MODE branches kept ONLY for placeSdkOrder's app
//                              (placeSdkApp mounts chargeOnlineApp in SDK mode) — contains productionDeps( / cancelOrderCore( /
//                              cancelSdkOrder( or a top-level name tainted by them (fixpoint).
// MIN is only a non-vacuity floor (the derivation must at least find these).
const acorn = require('acorn');
const MIN = ['cancelPaidOrder', 'merchantReject', 'placeSdkOrder', 'placeSdkStatus'];
const TOKENS = ['productionDeps(', 'cancelOrderCore(', 'cancelSdkOrder('];
const parse = (f) => { const src = fs.readFileSync(path.join(FN, f), 'utf8'); return { src, ast: acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }) }; };
const walk = (x, fn) => { if (!x || typeof x.type !== 'string') return; fn(x); for (const k of Object.keys(x)) { const v = x[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, fn)); else if (v && typeof v.type === 'string') walk(v, fn); } };
const textOf = (src, x) => src.slice(x.start, x.end);
// top-level names whose definition (transitively) contains a token
function tainted(src, ast, tokens) {
  const defs = [];
  for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration' && st.id) defs.push([st.id.name, textOf(src, st)]);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && d.init) defs.push([d.id.name, textOf(src, d.init)]);
  }
  const T = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, text] of defs) if (!T.has(name) && (tokens.some((t) => text.includes(t)) || [...T].some((n) => new RegExp(`(?<![A-Za-z0-9_$.])${n}\\b`).test(text)))) { T.add(name); changed = true; }
  }
  return T;
}
const reaches = (text, tokens, T) => tokens.some((t) => text.includes(t)) || [...T].some((n) => new RegExp(`(?<![A-Za-z0-9_$.])${n}\\b`).test(text));
function deriveReach() {
  const reach = new Set();
  { // payments/sdk/functions.js
    const { src, ast } = parse('payments/sdk/functions.js');
    let psp = null;
    walk(ast, (x) => { if (x.type === 'VariableDeclarator' && x.id.name === 'PSP_HANDLERS' && x.init && x.init.type === 'NewExpression') psp = new Set(x.init.arguments[0].elements.map((e) => e.value)); });
    assert.ok(psp && psp.size, 'SCB-DERIVE premise: the PSP_HANDLERS set literal');
    walk(ast, (x) => {
      if (x.type !== 'AssignmentExpression' || x.left.type !== 'MemberExpression' || x.left.object.name !== 'exports' || x.right.type !== 'CallExpression') return;
      const h = x.right.arguments[x.right.arguments.length - 1]; const ht = h ? textOf(src, h) : '';
      const m = ht.match(/handlerOf\('([A-Za-z]+)'\)/);
      if ((m && psp.has(m[1])) || ht.includes('productionDeps(')) reach.add(x.left.property.name);
    });
  }
  { // merchant/merchant-wiring.js
    const { src, ast } = parse('merchant/merchant-wiring.js');
    const T = tainted(src, ast, ['cancelCore()']);
    walk(ast, (x) => {
      if (x.type !== 'Property' || !x.value || x.value.type !== 'CallExpression' || x.value.callee.name !== 'onCall') return;
      const h = x.value.arguments[x.value.arguments.length - 1];
      if (h && reaches(textOf(src, h), ['cancelCore()'], T)) reach.add(x.key.name || x.key.value);
    });
  }
  { // index.js
    const { src, ast } = parse('index.js');
    const T = tainted(src, ast, TOKENS);
    const appHandler = (app) => { let h = null; walk(ast, (x) => { if (!h && x.type === 'CallExpression' && x.callee.type === 'MemberExpression' && x.callee.object.name === app && x.callee.property.name === 'all') h = x.arguments[1]; }); return h; };
    const withoutSdkBranches = (node) => { let t = textOf(src, node); const cuts = []; walk(node, (x) => { if (x.type === 'IfStatement' && x.test.type === 'Identifier' && x.test.name === 'SDK_MODE') cuts.push([x.consequent.start - node.start, x.consequent.end - node.start]); }); for (const [a, b] of cuts.sort((p, q) => q[0] - p[0])) t = t.slice(0, a) + '{}' + t.slice(b); return t; };
    walk(ast, (x) => {
      if (x.type !== 'AssignmentExpression' || x.left.type !== 'MemberExpression' || x.left.object.name !== 'exports' || x.right.type !== 'CallExpression') return;
      const h = x.right.arguments[x.right.arguments.length - 1]; if (!h) return;
      let text;
      if (h.type === 'Identifier' && h.name === 'placeSdkApp') text = textOf(src, appHandler('chargeOnlineApp'));   // SDK mode: every branch
      else if (h.type === 'Identifier' && appHandler(h.name)) text = withoutSdkBranches(appHandler(h.name));     // hosted mode: SDK branches never run
      else text = textOf(src, h);
      if (reaches(text, TOKENS, T)) reach.add(x.left.property.name);
    });
  }
  return [...reach].sort();
}
const REACH = deriveReach();
for (const m of MIN) assert.ok(REACH.includes(m), `SCB-DERIVE non-vacuity: the derived reach set must include ${m} (got ${REACH.join(', ')})`);
const RECOVERY = ['processSdkRecovery', 'recoverOrderAccess', 'sweepSdkRecovery'];
// the reviewed call sites: file → the call texts it may contain (counted), each serving REACH exports
const SITES = {
  'index.js': { 'productionDeps(': 2, 'cancelOrderCore(': 2 },                       // B2 + B4 (placeSdkOrder); cancelPaidOrder + the merchant cancel binding
  'payments/sdk/functions.js': { 'productionDeps(': 3 },                             // sweepSdkPayments, settleSdkOnStatus, depsFor (placeSdkStatus + cancelSdkPending ONLY)
  'merchant/merchant-wiring.js': { 'cancelCore()': 1 },                              // merchantReject (the injected cancelOrderCore)
  'cancel-order-core.js': { 'productionDeps(': 1, 'cancelSdkOrder(': 1 },            // its SDK route — reached only through cancelOrderCore (above)
  'payments/sdk/finish.js': { 'cancelSdkOrder(': 2 },                                // inside placeSdkOrder (the C6 self-cancel + the fence post-check self-cancel, PLAN-sdk-fence-r1)
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
ok(`SDK_PP_CONFIG is declared by EXACTLY the ${REACH.length} DERIVED provider-reaching exports (${REACH.join(', ')})`);
assert.deepStrictEqual(declaring('SDK_OTP_SENDER'), RECOVERY, `SCB-SENDER the exports declaring SDK_OTP_SENDER must be EXACTLY the recovery set (got ${declaring('SDK_OTP_SENDER').join(', ')})`);
ok('SDK_OTP_SENDER is declared by EXACTLY the three recovery functions');
console.log(`\nsdk-config-bindings.guard: OK (${n})`);
