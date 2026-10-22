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
  assert.deepStrictEqual(resolveReturnBase('x_pizza', ENV, { entryMode: 'app' }).base, null, 'app → fail-closed until an app deployment exists');
  ok('entry_mode: absent / unknown → direct (byte-identical); app → fail-closed');

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

  console.log(`pixelpay-return-url: OK (${n} cases)`);
})().catch((e) => { console.error(e); process.exit(1); });
