'use strict';
// S2 P-A (PLAN-capp-S2-r4 §2.1a) — THE CUSTOM-DOMAIN SWAP IS CONFIG ONLY. Pure, no emulator.
// The app's host lives in exactly two places, both config: the `context:"platform"` orders deployment in platform/sites.json
// and the env PIXELPAY_RETURN_URL_APP. This test loads the REAL manifest, swaps the app's host for a synthetic one through
// the real loader + the real resolver, and proves: the app resolves to the new host; the add-only transition (old origin
// KEPT) serves both origins (CORS + return base by the caller's Origin); an env naming an undeclared origin fails closed;
// every `direct` resolution for both brands is unchanged; and no code or test file names the app host.
// Run: node platform-domain-swap.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./platform-manifest');
const { resolveReturnBase, resolveReturnBaseForCharge } = require('./pixelpay-return-url');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'platform', 'sites.json'), 'utf8'));
const isApp = (d) => d.app === 'orders' && d.context === M.PLATFORM_CONTEXT;
const appOf = (sites) => sites.deployments.find(isApp);
const OLD = appOf(REAL).origins[0];
const ENV_KEY = appOf(REAL).pay_return.env;
const NEW = 'https://pedir.example.test';
const clone = (o) => JSON.parse(JSON.stringify(o));
const synth = (mut) => { const c = clone(REAL); mut(appOf(c)); return c; };
const wire = (list) => JSON.stringify(list.map((o) => (o instanceof RegExp ? { re: o.source, flags: o.flags } : o)));
const app = (sites, env, requestOrigin) => resolveReturnBase('x_pizza', env, { entryMode: 'app', requestOrigin, sites: M.loadPlatform(sites, M.PLATFORM.compat).sites });

// 1. the host swapped outright: origins + default + env = the new host → the app resolves there
const SWAPPED = synth((d) => { d.origins = [NEW]; d.pay_return.default = NEW; });
assert.deepStrictEqual(app(SWAPPED, { [ENV_KEY]: NEW }, undefined), { base: NEW, error: null });
assert.deepStrictEqual(app(SWAPPED, {}, NEW), { base: NEW, error: null });
ok('a swapped host (manifest + env only) → entry_mode app resolves to the new host');

// 2. the add-only transition: the new origin ADDED, the old one KEPT (never retired, r4) → both in BOTH CORS lists
const TRANSITION = synth((d) => { d.origins = [OLD, NEW]; d.pay_return.default = NEW; });
const P = M.loadPlatform(TRANSITION, M.PLATFORM.compat);
for (const o of [OLD, NEW]) {
  assert.ok(P.ACCOUNT_ORIGINS.includes(o), `ACCOUNT_ORIGINS carries ${o}`);
  assert.ok(P.PUBLIC_MENU_ORIGINS.includes(o), `PUBLIC_MENU_ORIGINS carries ${o}`);
}
const forms = REAL.deployments.filter((d) => d.app === 'orders' && !isApp(d)).flatMap((d) => d.origins);
assert.strictEqual(wire(P.ACCOUNT_ORIGINS.slice(0, forms.length)), wire(forms), 'the form origins are untouched by the swap');
ok('transition state (new origin added, old kept): both app origins are in ACCOUNT_ORIGINS and PUBLIC_MENU_ORIGINS; the form origins are untouched');

// 3. an env naming an origin the deployment does NOT declare → fail closed (never an unknown return)
for (const sites of [SWAPPED, TRANSITION, REAL]) {
  assert.deepStrictEqual(app(sites, { [ENV_KEY]: 'https://undeclared.example.test' }, undefined), { base: null, error: 'return_url_unconfigured: app base not a declared origin' });
}
ok('an env naming an undeclared origin → return_url_unconfigured: app base not a declared origin (fail closed)');

// 4. the two-origin transition: the caller's declared Origin wins whatever the env names; no / undeclared Origin → env/default
for (const env of [{ [ENV_KEY]: NEW }, { [ENV_KEY]: OLD }, {}]) {
  assert.deepStrictEqual(app(TRANSITION, env, OLD), { base: OLD, error: null }, `an OLD-host request returns to the old host (env ${JSON.stringify(env)})`);
  assert.deepStrictEqual(app(TRANSITION, env, NEW), { base: NEW, error: null }, `a NEW-host request returns to the new host (env ${JSON.stringify(env)})`);
}
assert.deepStrictEqual(app(TRANSITION, { [ENV_KEY]: NEW }, undefined), { base: NEW, error: null }, 'no Origin → the env');
assert.deepStrictEqual(app(TRANSITION, { [ENV_KEY]: OLD }, 'https://undeclared.example.test'), { base: OLD, error: null }, 'an undeclared Origin → the env');
assert.deepStrictEqual(app(TRANSITION, {}, null), { base: NEW, error: null }, 'no Origin, no env → the default');
ok('transition: an old-host request returns to the old host and a new-host one to the new host, whatever the env; no / undeclared Origin → env, else default');

// 5. every `direct` resolution for both brands is byte-identical to the unmodified manifest
(async () => {
  const RIDS = ['x_pizza', 'la_musa', 'x_pizza_centro', 'la_musa_sur'];
  const ENVS = [{}, { PIXELPAY_RETURN_URL: 'https://x.app/', PIXELPAY_RETURN_URL_LA_MUSA: 'https://lm.app' }, { [ENV_KEY]: NEW }];
  const BRANDS = [undefined, 'x_pizza', 'la_musa', 'nobrand'];
  let cases = 0;
  for (const sites of [SWAPPED, TRANSITION]) for (const rid of RIDS) for (const env of ENVS) for (const brandId of BRANDS) for (const requestOrigin of [undefined, OLD, NEW]) {
    assert.deepStrictEqual(resolveReturnBase(rid, env, { brandId, requestOrigin, sites }), resolveReturnBase(rid, env, { brandId, requestOrigin, sites: REAL }));
    const identity = brandId === undefined ? null : { brand_id: brandId };
    assert.deepStrictEqual(await resolveReturnBaseForCharge(rid, env, { identity, requestOrigin, readBrandId: async () => brandId, sites }),
      await resolveReturnBaseForCharge(rid, env, { identity, requestOrigin, readBrandId: async () => brandId, sites: REAL }));
    cases++;
  }
  ok(`every direct resolution for both brands (${cases} cases, resolver + charge wrapper) is byte-identical to the unmodified manifest`);

  // 6. NO CODE CHANGE: no tracked file under xpizza-functions/ (except the bundled sites.json), platform/client/ or
  //    customer-app/ names the app's host or its Netlify site — tests included
  const app0 = appOf(REAL);
  const needles = [...new Set([...app0.origins.map((o) => new URL(o).host), app0.netlify_site])];
  const files = execFileSync('git', ['ls-files', '--', 'xpizza-functions', 'platform/client', 'customer-app'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => f !== 'xpizza-functions/platform/sites.json' && !/^xpizza-functions\/node_modules\//.test(f));
  assert.ok(files.length > 500 && files.includes('xpizza-functions/index.js') && files.includes('customer-app/index.html'), `premise: the scan covers the code (${files.length} files)`);
  const hits = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, 'latin1');
    for (const h of needles) if (s.includes(h)) hits.push(`${f}: ${h}`);
  }
  assert.deepStrictEqual(hits, [], `🔴 the app host is named outside config: ${hits.join(', ')}`);
  assert.ok(fs.readFileSync(path.join(__dirname, 'platform', 'sites.json'), 'utf8').includes(needles[0]), 'non-vacuity: the needle IS in the manifest');
  ok(`no code or test file names the app host (${needles.join(', ')}): the swap is manifest + env only (${files.length} files scanned)`);

  console.log(`platform-domain-swap: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
