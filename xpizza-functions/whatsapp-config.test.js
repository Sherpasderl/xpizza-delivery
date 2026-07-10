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

// ── brandFor + template bodies (D1): x_pizza BYTE-IDENTICAL, la_musa branded ──
assert.equal(w.brandFor('x_pizza'), 'X. Pizza'); ok('brandFor x_pizza = "X. Pizza"');
assert.equal(w.brandFor('la_musa'), 'La Musa'); ok('brandFor la_musa = "La Musa"');
assert.equal(w.brandFor(undefined), 'X. Pizza'); ok('brandFor default = "X. Pizza" (legacy/unknown)');
const ord = (rid) => w.tplOrderReceived({ customerName: 'Ana', total: 299, itemsText: 'X', trackingToken: 'T', restaurantId: rid });
assert.ok(ord('x_pizza').includes('Recibimos tu pedido en X. Pizza ✅')); ok('tplOrderReceived x_pizza body byte-identical ("X. Pizza")');
assert.ok(ord('la_musa').includes('Recibimos tu pedido en La Musa ✅')); ok('tplOrderReceived la_musa body branded ("La Musa")');
assert.ok(w.tplDelivered({ customerName: 'Ana', restaurantId: 'x_pizza' }).includes('disfrutes X. Pizza, Ana.')); ok('tplDelivered x_pizza — brand, no "tu"');
assert.ok(w.tplDelivered({ customerName: 'Ana', restaurantId: 'la_musa' }).includes('disfrutes La Musa, Ana.')); ok('tplDelivered la_musa — brand, no "tu"');
assert.ok(w.tplCancelled({ orderId: 'PZX-1', restaurantId: 'x_pizza' }).includes('pedido #PZX-1 en X. Pizza fue cancelado')); ok('tplCancelled x_pizza — brand line added');
assert.ok(w.tplCancelled({ orderId: 'PZX-1', restaurantId: 'la_musa' }).includes('pedido #PZX-1 en La Musa fue cancelado')); ok('tplCancelled la_musa — brand line added');

// ── E1: food-noun copy — x_pizza BYTE-IDENTICAL, la_musa branded ──
assert.equal(w.itemsEmojiFor('x_pizza'), '🍕'); ok('itemsEmojiFor x_pizza = 🍕');
assert.equal(w.itemsEmojiFor('la_musa'), '🍜'); ok('itemsEmojiFor la_musa = 🍜');
assert.equal(w.itemsEmojiFor(undefined), '🍕'); ok('itemsEmojiFor default = 🍕 (legacy/unknown)');
assert.equal(w.readyLineFor('x_pizza'), '¡Tu pizza está lista! 🍕'); ok('readyLineFor x_pizza = exact prior literal');
assert.equal(w.readyLineFor('la_musa'), '¡Tu pedido está listo! 🍜'); ok('readyLineFor la_musa = pedido/listo/🍜');
assert.equal(w.readyLineFor(undefined), '¡Tu pizza está lista! 🍕'); ok('readyLineFor default = x_pizza literal');
assert.ok(ord('x_pizza').includes('🍕 X')); ok('tplOrderReceived x_pizza item prefix 🍕 (byte-identical)');
assert.ok(ord('la_musa').includes('🍜 X')); ok('tplOrderReceived la_musa item prefix 🍜');
const drv = (rid) => w.tplDriverAssigned({ customerName: 'Ana', driverName: 'D', trackingToken: 'T', restaurantId: rid });
assert.ok(drv('x_pizza').includes('¡Tu pizza está lista! 🍕')); ok('tplDriverAssigned x_pizza ready line byte-identical');
assert.ok(drv('la_musa').includes('¡Tu pedido está listo! 🍜')); ok('tplDriverAssigned la_musa ready line (pedido/🍜)');

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
