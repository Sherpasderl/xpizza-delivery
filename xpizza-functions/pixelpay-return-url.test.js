'use strict';

// Unit + golden test for the restaurant-aware hosted-checkout return base (pixelpay-return-url.js).
// Proves: x_pizza byte-identical to the original inline default; la_musa selects its own origin and
// FAILS CLOSED if unset — never falling back to the x_pizza origin. Run: node pixelpay-return-url.test.js
const assert = require('assert');
const { resolveReturnBase } = require('./pixelpay-return-url');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const X_DEFAULT = 'https://xpizzaorders.netlify.app';

// ── x_pizza: byte-identical to the original `PIXELPAY_RETURN_URL || default` (trailing slash stripped) ──
assert.deepStrictEqual(resolveReturnBase('x_pizza', {}), { base: X_DEFAULT, error: null }); ok('x_pizza, no env → orders-site default');
assert.deepStrictEqual(resolveReturnBase('x_pizza', { PIXELPAY_RETURN_URL: 'https://foo.app/' }), { base: 'https://foo.app', error: null }); ok('x_pizza, env set → that origin (trailing slash stripped)');
// default param coercion path is the same for any non-la_musa id
assert.equal(resolveReturnBase('x_pizza', undefined).base, X_DEFAULT); ok('x_pizza, undefined env → default (no crash)');

// ── la_musa: its own origin ──
assert.deepStrictEqual(resolveReturnBase('la_musa', { PIXELPAY_RETURN_URL_LA_MUSA: 'https://lamusa.app/' }), { base: 'https://lamusa.app', error: null }); ok('la_musa, env set → la_musa origin (slash stripped)');

// ── la_musa: FAIL-CLOSED when unset (binding gate constraint 1) ──
const miss = resolveReturnBase('la_musa', {});
assert.equal(miss.base, null); assert.ok(miss.error); ok('la_musa, no env → FAIL-CLOSED (base null + error)');
// CRITICAL: la_musa must NOT fall back to the x_pizza PIXELPAY_RETURN_URL origin.
const noFallback = resolveReturnBase('la_musa', { PIXELPAY_RETURN_URL: 'https://xpizzaorders.netlify.app' });
assert.equal(noFallback.base, null); assert.ok(noFallback.error); ok('la_musa never falls back to the x_pizza origin (no silent mis-routing)');

// ── S3b: routing as DATA (platform/sites.json pay_return), brand-aware, ONE precedence rule ──
(async () => {
  const { resolveReturnBaseForCharge, hasOwnDeployment } = require('./pixelpay-return-url');
  const M = require('./platform-manifest');
  const ENV = { PIXELPAY_RETURN_URL: 'https://x.app/', PIXELPAY_RETURN_URL_LA_MUSA: 'https://lm.app' };
  assert.ok(hasOwnDeployment('x_pizza') && hasOwnDeployment('la_musa') && !hasOwnDeployment('x_pizza_centro'), 'premise: the manifest carries both brands\' return data');
  assert.ok(!/la_musa|x_pizza/.test(require('fs').readFileSync(require('path').join(__dirname, 'pixelpay-return-url.js'), 'utf8').replace(/\/\/[^\n]*/g, '')), 'no brand literal in the resolver code');
  ok('the return allowlist is manifest data; the resolver code carries no brand literal');

  for (const m of [undefined, null, 'direct', 'DIRECT', 'web', 7]) assert.deepStrictEqual(resolveReturnBase('x_pizza', ENV, { entryMode: m }), { base: 'https://x.app', error: null }, `entry_mode ${m} → direct`);
  ok('entry_mode: absent / unknown → direct (byte-identical)');

  // (a) a BRANCH whose identity.brand_id is x_pizza returns to x_pizza's site; (b) a malformed brand_id fails closed
  assert.deepStrictEqual(resolveReturnBase('x_pizza_centro', ENV, { brandId: 'x_pizza' }), { base: 'https://x.app', error: null }, '(a) branch → its brand\'s base');
  for (const bad of ['', 'X PIZZA', 'unknown', '123', 7, {}]) assert.strictEqual(resolveReturnBase('x_pizza_centro', ENV, { brandId: bad }).base, null, `(b) malformed brand_id ${JSON.stringify(bad)} → fail-closed`);
  assert.strictEqual(resolveReturnBase('x_pizza_centro', ENV, {}).base, null, 'a branch with no brand_id → fail-closed (never another brand\'s site)');
  assert.strictEqual(resolveReturnBase('x_pizza_centro', ENV, { brandId: 'nobrand' }).base, null, 'a brand with no deployment → fail-closed');
  assert.deepStrictEqual(resolveReturnBase('la_musa', ENV, { brandId: 'x_pizza' }), { base: 'https://lm.app', error: null }, 'precedence: the rid\'s OWN deployment wins over a brand_id');
  ok('(a) a branch (brand_id x_pizza) → x_pizza\'s base; (b) a malformed / absent / deployment-less brand → fail-closed; the rid\'s own deployment takes precedence');

  // fresh (identity held) and resume (one brand leaf read) resolve the SAME base — a legacy rid and a branch rid
  let reads = 0; const readBrandId = (v) => async () => { reads++; return v; };
  const legFresh = await resolveReturnBaseForCharge('x_pizza', ENV, { identity: { hub_lat: 1 } });
  const legResume = await resolveReturnBaseForCharge('x_pizza', ENV, { identity: null, readBrandId: readBrandId('x_pizza') });
  assert.deepStrictEqual([legFresh, legResume, reads], [{ base: 'https://x.app', error: null }, { base: 'https://x.app', error: null }, 0], 'legacy rid: same base, and the resume reads NOTHING');
  const brFresh = await resolveReturnBaseForCharge('x_pizza_centro', ENV, { identity: { brand_id: 'x_pizza' } });
  const brResume = await resolveReturnBaseForCharge('x_pizza_centro', ENV, { identity: null, readBrandId: readBrandId('x_pizza') });
  assert.deepStrictEqual([brFresh, brResume, reads], [{ base: 'https://x.app', error: null }, { base: 'https://x.app', error: null }, 1], 'branch rid: same base; the resume reads the ONE brand leaf');
  assert.strictEqual((await resolveReturnBaseForCharge('x_pizza_centro', ENV, { identity: { brand_id: 'X!' } })).base, null, 'fresh branch, malformed brand → fail-closed');
  assert.strictEqual((await resolveReturnBaseForCharge('x_pizza_centro', ENV, { readBrandId: async () => { throw new Error('down'); } })).base, null, 'resume, unreadable brand → fail-closed');
  ok('one rule on both paths: fresh and resume resolve the SAME base (legacy rid: no read; branch rid: one brand_id leaf)');

  // the manifest validates the routing data
  const S = M.PLATFORM.sites;
  const withPR = (id, pr) => ({ ...S, deployments: S.deployments.map((d) => (d.id === id ? { ...d, pay_return: pr } : d)) });
  assert.deepStrictEqual(M.validateManifest(S), [], 'the shipped manifest is valid');
  for (const [id, pr, re] of [['kitchen-xpizza', { env: 'X' }, /only for an orders/], ['orders-xpizza', { env: 'lower' }, /ENV_KEY/], ['orders-xpizza', { env: 'X', default: 'http://a.b' }, /exact https/], ['orders-xpizza', { env: 'X', extra: 1 }, /\{ env, default\? \}/], ['orders-xpizza', 'X', /\{ env, default\? \}/]]) {
    assert.ok(M.validateManifest(withPR(id, pr)).some((e) => re.test(e)), `manifest rejects pay_return ${JSON.stringify(pr)} on ${id}`);
  }
  ok('the manifest rejects pay_return off an orders deployment, a bad env key, a non-https default and an unknown shape');

  // ── S2 P-A: the customer APP's deployment (context 'platform') — Origin-selected base, add-only origins, fail-closed ──
  const appDep = S.deployments.filter((d) => d.app === 'orders' && d.context === M.PLATFORM_CONTEXT);
  assert.strictEqual(appDep.length, 1, 'premise: the manifest declares exactly one platform orders deployment');
  const A = appDep[0]; const A_ENV = A.pay_return.env; const A0 = A.origins[0];
  const withApp = (mut) => { const c = JSON.parse(JSON.stringify(S)); mut(c.deployments.find((d) => d.id === A.id), c); return c; };
  const TWO = withApp((d) => { d.origins = [A0, 'https://new.app.test']; });
  const app = (env, requestOrigin, sites = S) => resolveReturnBase('x_pizza', env, { entryMode: 'app', requestOrigin, sites });
  assert.deepStrictEqual(app({}, undefined), { base: A.pay_return.default, error: null }, 'no env, no Origin → the declared default');
  assert.deepStrictEqual(app({ [A_ENV]: `${A0}/` }, undefined), { base: A0, error: null }, 'env = a declared origin (slash stripped) → it');
  assert.deepStrictEqual(app({}, 'https://evil.example'), { base: A.pay_return.default, error: null }, 'an UNDECLARED Origin never steers the return → the default');
  assert.deepStrictEqual(app({ [A_ENV]: 'https://evil.example' }, undefined), { base: null, error: 'return_url_unconfigured: app base not a declared origin' }, 'env naming an undeclared origin → fail-closed');
  assert.deepStrictEqual(app({ [A_ENV]: 'https://new.app.test' }, A0, TWO), { base: A0, error: null }, 'two declared origins: an OLD-host Origin returns to the old host whatever the env names');
  assert.deepStrictEqual(app({ [A_ENV]: A0 }, 'https://new.app.test', TWO), { base: 'https://new.app.test', error: null }, 'and a NEW-host Origin to the new host');
  assert.deepStrictEqual(app({ [A_ENV]: 'https://new.app.test' }, 'https://nope.test', TWO), { base: 'https://new.app.test', error: null }, 'an undeclared Origin → the env (declared)');
  assert.deepStrictEqual(app({ [A_ENV]: 'https://new.app.test' }, null, TWO), { base: 'https://new.app.test', error: null }, 'no Origin → the env (declared)');
  for (const o of [`${A0}/`, A0.toUpperCase(), `${A0}:443`, `${A0}.evil.test`, 7, {}]) assert.deepStrictEqual(app({}, o), { base: A.pay_return.default, error: null }, `a NON-EXACT Origin ${JSON.stringify(o)} is not a declared origin`);
  const NOAPP = { ...S, deployments: S.deployments.filter((d) => d.id !== A.id) };
  assert.deepStrictEqual(app({ [A_ENV]: A0 }, A0, NOAPP), { base: null, error: 'return_url_unconfigured: no app deployment' }, 'no app deployment → fail-closed');
  ok('app: a declared Origin is the base; else env/default, which must be declared; undeclared/inexact Origins never steer; no deployment → fail-closed');

  assert.ok(M.validateManifest(withApp((d, c) => { c.deployments.push({ ...d, id: 'orders-app2', origins: ['https://two.app.test'], pay_return: { env: 'X2', default: 'https://two.app.test' } }); })).some((e) => /at most one orders deployment may have context platform/.test(e)), 'two platform orders deployments → refused');
  assert.ok(M.validateManifest(withApp((d) => { d.pay_return = { env: A_ENV, default: 'https://elsewhere.test' }; })).some((e) => /must be one of its own origins/.test(e)), 'default not one of its origins → refused');
  assert.ok(M.validateManifest(withApp((d) => { d.pay_return = { env: A_ENV }; })).some((e) => /needs pay_return with a default/.test(e)), 'no default → refused');
  assert.ok(M.validateManifest(withApp((d) => { delete d.pay_return; })).some((e) => /needs pay_return with a default/.test(e)), 'no pay_return → refused');
  assert.throws(() => M.loadPlatform(withApp((d, c) => { c.deployments.push({ ...d, id: 'orders-app2', origins: ['https://two.app.test'], pay_return: { env: 'X2', default: 'https://two.app.test' } }); }), M.PLATFORM.compat), /at most one/);
  ok('the validator refuses a second platform orders deployment and a pay_return default outside its own origins (at load)');

  // the charge wrapper: app short-circuits FIRST — no brand read, even an unreadable / malformed brand never refuses it
  let brandReads = 0;
  const throwing = async () => { brandReads++; throw new Error('brand leaf unreadable'); };
  for (const rid of ['x_pizza', 'la_musa', 'third_brand_centro']) {
    assert.deepStrictEqual(await resolveReturnBaseForCharge(rid, {}, { identity: null, entryMode: 'app', readBrandId: throwing }), { base: A.pay_return.default, error: null }, `${rid}: app resume with an unreadable brand → resolves`);
    assert.deepStrictEqual(await resolveReturnBaseForCharge(rid, {}, { identity: { brand_id: 'X!' }, entryMode: 'app', requestOrigin: A0 }), { base: A0, error: null }, `${rid}: app fresh with a malformed brand → resolves`);
  }
  assert.strictEqual(brandReads, 0, 'app never reads the brand leaf');
  assert.deepStrictEqual(await resolveReturnBaseForCharge('x_pizza', ENV, { entryMode: 'direct', requestOrigin: A0 }), { base: 'https://x.app', error: null }, 'direct ignores the Origin');
  ok('charge wrapper: app short-circuits before the own-deployment check and any brand read (third brand, unreadable leaf → resolves); direct ignores the Origin');

  // a rid literally named 'platform' never borrows the app deployment on the direct path
  assert.strictEqual(resolveReturnBase('platform', { [A_ENV]: A0 }).base, null, 'direct rid "platform" → no deployment');
  assert.strictEqual(resolveReturnBase('x_pizza_centro', { [A_ENV]: A0 }, { brandId: 'platform' }).base, null, 'brand_id "platform" → no deployment');
  ok('the platform context is never a rid\'s or a brand\'s own deployment on the direct path');

  // DIFFERENTIAL — every direct case for both brands is byte-identical to the PRE-S2 resolver over the PRE-S2 manifest (276ed944)
  const { execFileSync } = require('child_process');
  const ROOT = require('path').join(__dirname, '..');
  const gitShow = (f) => execFileSync('git', ['show', `276ed944:${f}`], { cwd: ROOT, encoding: 'utf8' });
  const oldSites = JSON.parse(gitShow('platform/sites.json'));
  const Mod = require('module');
  const oldMod = new Mod(require.resolve('./pixelpay-return-url.js'), module);
  oldMod.filename = require.resolve('./pixelpay-return-url.js'); oldMod.paths = module.paths;
  const realReq = oldMod.require.bind(oldMod);
  oldMod.require = (id) => (id === './platform-manifest' ? { ...M, PLATFORM: M.loadPlatform(oldSites, M.PLATFORM.compat) } : realReq(id));
  oldMod._compile(gitShow('xpizza-functions/pixelpay-return-url.js'), oldMod.filename);
  const OLD = oldMod.exports;
  const RIDS = ['x_pizza', 'la_musa', 'x_pizza_centro', 'la_musa_sur', 'third_brand', 'platform'];
  const ENVS = [{}, ENV, { PIXELPAY_RETURN_URL: 'https://foo.app/' }, { PIXELPAY_RETURN_URL_LA_MUSA: 'https://lm.app/' }, { [A_ENV]: A0 }];
  const BRANDS = [undefined, null, 'x_pizza', 'la_musa', 'nobrand', 'X!', 'platform'];
  const MODES = [undefined, null, 'direct', 'DIRECT', 'web', 7];
  const ORIGINS = [undefined, A0, 'https://orders.xpizza.hn'];
  let cases = 0;
  for (const rid of RIDS) for (const env of ENVS) for (const brandId of BRANDS) for (const entryMode of MODES) for (const requestOrigin of ORIGINS) {
    assert.deepStrictEqual(resolveReturnBase(rid, env, { brandId, entryMode, requestOrigin }), OLD.resolveReturnBase(rid, env, { brandId, entryMode }), `direct differential ${rid} ${JSON.stringify(env)} ${brandId} ${entryMode}`);
    const ident = brandId === undefined ? null : { brand_id: brandId };
    assert.deepStrictEqual(
      await resolveReturnBaseForCharge(rid, env, { identity: ident, entryMode, requestOrigin, readBrandId: async () => brandId }),
      await OLD.resolveReturnBaseForCharge(rid, env, { identity: ident, entryMode, readBrandId: async () => brandId }), `charge differential ${rid}`);
    cases++;
  }
  ok(`DIFFERENTIAL: ${cases} direct cases × (resolver + charge wrapper) byte-identical to the pre-S2 resolver over the pre-S2 manifest (276ed944)`);

  console.log(`pixelpay-return-url: OK (${n} cases)`);
})().catch((e) => { console.error(e); process.exit(1); });
