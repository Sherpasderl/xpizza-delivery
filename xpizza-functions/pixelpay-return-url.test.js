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

console.log(`pixelpay-return-url: OK (${n} cases)`);
