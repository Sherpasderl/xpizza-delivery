'use strict';

// C2 golden — per-restaurant WhatsApp config + enablement gate (model B).
// Proves: resolveWhatsappConfig (x_pizza → hardcoded TRACKING_BASE constant, NOT env; la_musa → env;
// missing creds → null); isEnabledForRestaurant (x_pizza === global flag only, NO identity read →
// byte-identical; la_musa → global AND identity.whatsapp_enabled, fail-safe). Run: node whatsapp-config.test.js
const assert = require('assert');
const w = require('./whatsapp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const X_TRACK = 'https://xpizzatrack.netlify.app';

// ── resolveWhatsappConfig ──
// x_pizza: trackingBase is the HARDCODED constant — NOT process.env (even when a TRACKING_BASE env is set).
assert.equal(w.resolveWhatsappConfig('x_pizza', { TRACKING_BASE: 'http://nope', TRACKING_BASE_LA_MUSA: 'http://nope2' }).trackingBase, X_TRACK); ok('x_pizza trackingBase = hardcoded constant (not env)');
// la_musa: env-driven (instance, token, base)
assert.deepStrictEqual(
  w.resolveWhatsappConfig('la_musa', { ULTRAMSG_INSTANCE_ID_LA_MUSA: 'iLM', ULTRAMSG_TOKEN_LA_MUSA: 'tLM', TRACKING_BASE_LA_MUSA: 'https://lm.track' }),
  { apiBase: 'https://api.ultramsg.com/iLM', token: 'tLM', trackingBase: 'https://lm.track' }); ok('la_musa → env-driven instance/token/trackingBase');
// la_musa: missing creds → null (fail-safe: sendMessage then skips)
assert.equal(w.resolveWhatsappConfig('la_musa', {}), null); ok('la_musa no creds → null (fail-safe skip)');
assert.equal(w.resolveWhatsappConfig('la_musa', { ULTRAMSG_INSTANCE_ID_LA_MUSA: 'iLM' }), null); ok('la_musa token missing → null');
// la_musa with creds but NO tracking base → null (tracking base is folded into can-send creds; we
// must NOT fall back to the x_pizza link, or a la_musa order could send with an X. Pizza tracker URL).
assert.equal(w.resolveWhatsappConfig('la_musa', { ULTRAMSG_INSTANCE_ID_LA_MUSA: 'iLM', ULTRAMSG_TOKEN_LA_MUSA: 'tLM' }), null); ok('la_musa no TRACKING_BASE_LA_MUSA → null (no x_pizza-link fallback)');

// ── trackingUrl (x_pizza) ──
assert.equal(w.trackingUrl('TOK', 'x_pizza'), `${X_TRACK}/TOK`); ok('trackingUrl x_pizza → constant base');

// ── isEnabledForRestaurant (model B) ──
const stubDb = ({ globalEnabled = true, laEnabled, throwOn }) => ({
  ref(path) {
    return { once() {
      if (throwOn && path.includes(throwOn)) return Promise.reject(new Error('read fail'));
      if (path === 'config/whatsapp_enabled') return Promise.resolve({ val: () => globalEnabled });
      if (path.endsWith('/identity/whatsapp_enabled')) return Promise.resolve({ val: () => laEnabled });
      return Promise.resolve({ val: () => null });
    } };
  },
});
(async () => {
  // x_pizza = global flag ONLY (byte-identical to isEnabled) — never reads identity (stub throws on it, still OK)
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: true,  throwOn: 'identity' }), 'x_pizza'), true);  ok('x_pizza: global ON → true, no identity read (throws-on-identity stub still passes)');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: false, throwOn: 'identity' }), 'x_pizza'), false); ok('x_pizza: global OFF → false (global flag only)');
  // la_musa = global AND identity flag
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: true,  laEnabled: true }),  'la_musa'), true);  ok('la_musa: global ON + identity true → true');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: true,  laEnabled: false }), 'la_musa'), false); ok('la_musa: identity false → false (per-restaurant kill switch)');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: true,  laEnabled: undefined }), 'la_musa'), false); ok('la_musa: identity absent → false (requires === true)');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: false, laEnabled: true }),  'la_musa'), false); ok('la_musa: global OFF → false (global gate first)');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ globalEnabled: true,  throwOn: 'identity' }), 'la_musa'), false); ok('la_musa: identity read fails → false (fail-safe)');
  // Finding 2: global-flag read FAILURE — x_pizza fail-OPEN (byte-identical), la_musa fail-CLOSED.
  assert.equal(await w.isEnabledForRestaurant(stubDb({ throwOn: 'config' }), 'x_pizza'), true);                 ok('x_pizza: global read FAILS → true (fail-open preserved → byte-identical)');
  assert.equal(await w.isEnabledForRestaurant(stubDb({ throwOn: 'config', laEnabled: true }), 'la_musa'), false); ok('la_musa: global read FAILS → false (fail-closed, no leak)');

  console.log(`whatsapp-config: OK (${n} cases)`);
})();
