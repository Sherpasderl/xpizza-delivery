'use strict';
/* The WhatsApp CANCELLATION carries the kitchen's display_number (#47) — never the long order id (owner 2026-10-12).
 * Invokes the REAL sendOrderStatusNotifications trigger (onValueWritten on /orders/{id}/status) via .run() against the
 * RTDB emulator, with the order as the platform writes it (display_number stamped by allocateDisplayNumberOnSale, or not
 * yet). whatsapp.sendMessage is replaced by a spy that renders the DEFERRED template exactly as the real sendMessage does
 * (renderTemplate with the brand this restaurant resolves to). Run: npm run test:cancel-number
 */
const assert = require('assert');
(function requireEmulator() {
  const EE = require('../lib/emulator-endpoint');
  let why = null;
  try {
    if (!process.env[EE.OFFSET_VAR]) throw new Error(`${EE.OFFSET_VAR} is not set — the run's slot is unknown`);
    const v = EE.validateEmulatorEnv(process.env);
    if (v.endpoints.database === EE.NULL_ENDPOINT) throw new Error('the database is the NULL endpoint — this run did not start it');
  } catch (e) { why = String(e && e.message || e).replace(/^🔴 REFUSED — /, ''); }
  if (why) {
    console.error(`\n🛑 REFUSING TO RUN — FIREBASE_DATABASE_EMULATOR_HOST is not this run's local emulator (${why}).`);
    console.error('   This test wipes the database ROOT and index.js points at PRODUCTION. Run it via:');
    console.error('   npm run test:cancel-number   (firebase emulators:exec --only database …)\n');
    process.exit(2);
  }
})();

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA || 'instanceTEST';
process.env.ULTRAMSG_TOKEN_LA_MUSA = process.env.ULTRAMSG_TOKEN_LA_MUSA || 'tokTEST';

const app = require('../index.js');
const whatsapp = require('../whatsapp');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('cancel-number: FAILED — exited without completing'); process.exitCode = 1; } });

let sends = [];
const BRAND = { x_pizza: 'X. Pizza', la_musa: 'La Musa' };
whatsapp.sendMessage = async (phone, body, restaurantId) => {
  assert.ok(whatsapp.isDeferred(body), 'the cancellation template arrives DEFERRED (rendered at send, D12b)');
  sends.push({ phone, restaurantId, body: whatsapp.renderTemplate(body, BRAND[restaurantId] || null) });
  return { id: 'MSG-' + sends.length };
};
const ev = (orderId, before, after) => ({ data: { before: { val: () => before }, after: { val: () => after } }, params: { orderId } });
const IDENTITY = { active: true, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 10, version: 1, name: 'X Pizza', phone: '+50497952893', hours: null, whatsapp_enabled: true };
async function reset() {
  const url = db.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `refusing to wipe: ${url}`);
  await db.ref('/').set(null);
  await db.ref('restaurants/x_pizza/identity').set(IDENTITY);
  await db.ref('restaurants/la_musa/identity').set({ ...IDENTITY, name: 'La Musa' });
  await db.ref('config/whatsapp_enabled').set(true);
  sends = [];
}
async function cancel(id, rid, extra) {
  await db.ref(`orders/${id}`).set({ order_type: 'pickup', restaurant_id: rid, customer_phone: '99990000', customer_name: 'Test', payment_method: 'cash', tracking_token: `TOK${id}`, status: 'cancelled', ...extra });
  await app.sendOrderStatusNotifications.run(ev(id, 'new', 'cancelled'));
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const id = `PZX-261012-CANCEL-${rid}`;
    // stamped: "#47"
    await reset();
    await cancel(id, rid, { display_number: 47 });
    assert.strictEqual(sends.length, 1, `${rid}: one cancellation message`);
    assert.ok(sends[0].body.includes(`Lamentamos avisarte que tu pedido #47 en ${BRAND[rid]} fue cancelado.`), `${rid}: the kitchen's number — ${sends[0].body.split('\n')[0]}`);
    assert.ok(!sends[0].body.includes(id) && !sends[0].body.includes('PZX'), `🔴 ${rid}: the long order id never appears`);
    // not stamped yet (the allocator is fail-open): no number at all — never the long id
    await reset();
    await cancel(id, rid, {});
    assert.strictEqual(sends.length, 1, `${rid}: one message without a number`);
    assert.ok(sends[0].body.includes(`Lamentamos avisarte que tu pedido en ${BRAND[rid]} fue cancelado.`), `${rid}: no number — ${sends[0].body.split('\n')[0]}`);
    assert.ok(!sends[0].body.includes('#') && !sends[0].body.includes('PZX'), `🔴 ${rid}: no "#", no long id`);
    ok(`${rid}: the real cancellation trigger says "tu pedido #47 en ${BRAND[rid]}" when stamped, "tu pedido en ${BRAND[rid]}" when not — never the long id`);
  }
  // a suppressed cancellation stays suppressed (an abandoned cart): no message at all
  await reset();
  await cancel('PZX-ABANDONED', 'x_pizza', { display_number: 5, payment_status: 'abandoned' });
  assert.strictEqual(sends.length, 0, 'an abandoned cart is still not notified');
  ok('an abandoned cart is still not notified (cancel-notify suppression unchanged)');
  FINISHED = true;
  console.log(`\ncancel-number(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('cancel-number FAILED:', e); process.exit(1); });
