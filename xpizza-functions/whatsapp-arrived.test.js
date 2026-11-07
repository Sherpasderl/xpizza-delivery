'use strict';
// DRIVER C — the «llegó» WhatsApp template (OWNER-APPROVED mockup, frame 1) + the fail-closed instanceFor; every EXISTING template
// and the existing routing are byte-unchanged vs the base whatsapp.js. Run: node whatsapp-arrived.test.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const W = require('./whatsapp');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// the approved copy, exactly: the notice, a blank line, «Sigue su ubicación:», the restaurant's own tracking link
assert.strictEqual(W.renderTemplate(W.tplArrived({ customerName: 'Daniela', trackingToken: 'tb_tok', restaurantId: 'x_pizza' }), null),
  '¡Daniela, tu repartidor llegó! 🛵 Ya está afuera con tu pedido.\n\nSigue su ubicación:\nhttps://xpizzatrack.netlify.app/tb_tok', 'DRVC-WA-COPY the approved text');
assert.strictEqual(W.renderTemplate(W.tplArrived({ customerName: '  ', trackingToken: 'tb_tok', restaurantId: 'x_pizza' }), null),
  '¡Tu repartidor llegó! 🛵 Ya está afuera con tu pedido.\n\nSigue su ubicación:\nhttps://xpizzatrack.netlify.app/tb_tok', 'DRVC-WA-NONAME no name → the neutral opening');
assert.strictEqual(W.renderTemplate(W.tplArrived({ customerName: 'Tb Brand Name', trackingToken: 't', restaurantId: 'x_pizza' }), 'Tb Brand'),
  W.renderTemplate(W.tplArrived({ customerName: 'Tb Brand Name', trackingToken: 't', restaurantId: 'x_pizza' }), null), 'DRVC-WA-BRANDFREE the copy names no brand');
assert.ok(W.isDeferred(W.tplArrived({})), 'DRVC-WA-DEFERRED minted through the deferred path');
ok('the «llegó» template is the approved copy, neutral without a name, brand-free, deferred');

// instanceFor: fail closed — only a restaurant with its OWN instance
assert.strictEqual(W.instanceFor('x_pizza'), 'default', 'DRVC-INST-DEFAULT');
assert.strictEqual(W.instanceFor('la_musa', {}), null, 'DRVC-INST-NOCREDS la_musa without creds → null');
assert.strictEqual(W.instanceFor('la_musa', { ULTRAMSG_INSTANCE_ID_LA_MUSA: 'i', ULTRAMSG_TOKEN_LA_MUSA: 't', TRACKING_BASE_LA_MUSA: 'https://tb' }), 'la_musa', 'DRVC-INST-LAMUSA');
for (const bad of ['tb_unknown', '', undefined, null, 'X_PIZZA']) assert.strictEqual(W.instanceFor(bad), null, `DRVC-INST-UNKNOWN ${bad}`);
assert.ok(W.resolveWhatsappConfig('tb_unknown'), 'premise: today\'s resolveWhatsappConfig still routes an unknown id to the default instance (unchanged)');
ok('instanceFor: default / la_musa with creds / null for la_musa without creds and every unknown id; resolveWhatsappConfig unchanged');

// every EXISTING template + the existing exports render byte-identically to the base module
const baseSrc = execFileSync('git', ['show', 'c8b08cf1:xpizza-functions/whatsapp.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
const tmp = path.join(__dirname, `.whatsapp-base-${process.pid}.js`);
fs.writeFileSync(tmp, baseSrc);
try {
  const B = require(tmp);
  const ctx = { customerName: 'Tbcliente', orderId: 'tb_o', itemsText: '1x tb', total: 100, trackingToken: 'tb_tok', driverName: 'Tbdriver', etaMinutes: 7,
    pickupTime: '7:30', displayNumber: 42, code: '123456', orderType: 'delivery' };
  const pairs = [['tplOrderReceived'], ['tplPickupReceived'], ['tplDelivered'], ['tplCancelled'], ['tplPickupReady'], ['tplPreparing'], ['tplOtp']];
  let n = 0;
  for (const rid of ['x_pizza', 'la_musa', 'tb_unknown']) for (const brand of [null, 'Tb Marca']) for (const [t] of pairs) {
    assert.strictEqual(W.renderTemplate(W[t]({ ...ctx, restaurantId: rid }), brand), B.renderTemplate(B[t]({ ...ctx, restaurantId: rid }), brand), `DRVC-WA-GOLDEN ${t} ${rid} ${brand}`);
    n++;
  }
  for (const rid of ['x_pizza', 'la_musa', 'tb_unknown']) {
    assert.strictEqual(W.tplDriverAssigned({ ...ctx, restaurantId: rid }), B.tplDriverAssigned({ ...ctx, restaurantId: rid }), 'DRVC-WA-GOLDEN driverAssigned');
    assert.strictEqual(W.tplOutForDelivery({ ...ctx, restaurantId: rid }), B.tplOutForDelivery({ ...ctx, restaurantId: rid }), 'DRVC-WA-GOLDEN outForDelivery');
    assert.deepStrictEqual(W.resolveWhatsappConfig(rid, {}), B.resolveWhatsappConfig(rid, {}), 'DRVC-WA-GOLDEN routing');
    n += 3;
  }
  assert.deepStrictEqual(Object.keys(W).filter((k) => !['tplArrived', 'instanceFor'].includes(k)).sort(), Object.keys(B).sort(), 'DRVC-WA-EXPORTS only tplArrived + instanceFor are new');
  assert.strictEqual(W.isEnabledForRestaurant.toString(), B.isEnabledForRestaurant.toString(), 'DRVC-WA-ENABLED isEnabledForRestaurant byte-unchanged');
  assert.strictEqual(W.sendMessage.toString(), B.sendMessage.toString(), 'DRVC-WA-SEND sendMessage byte-unchanged');
  ok(`every existing template / routing / sender is byte-identical to the base module (${n} cells); only tplArrived + instanceFor are new`);
} finally { fs.unlinkSync(tmp); void os; }

console.log(`\n${pass} passed`);
