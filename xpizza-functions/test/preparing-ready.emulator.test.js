'use strict';
/**
 * OWNER-RUN emulator test — notifyPreparing (Fix A: proactive "preparando · listo en ~X min" WhatsApp).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/preparing-ready.emulator.test.js"
 * (Owner-run: needs Java + the Firebase emulator, like pickup-ready.emulator.test.js.)
 *
 * Invokes the REAL onValueWritten trigger via `.run({data:{before,after},params})` against the RTDB
 * emulator, with `whatsapp.sendMessage` monkey-patched to a controllable spy. Asserts:
 *   1. →preparing (delivery AND pickup) → exactly ONE send; claimed+started+sent; ZERO /orders,tasks,
 *      payments,factura writes. Copy differs by order_type (readiness wording).
 *   2. double-invocation (redelivery + concurrent) → exactly ONE send (claim authority).
 *   3. STALE-STATUS GUARD: a 'preparing' event on an order whose CURRENT status has advanced
 *      (ready/delivered/completed/cancelled) → skip stale_status, NO send.
 *   4. isSendConfirmed classification: {} and null and thrown and {error} → send_unresolved_at (NO sent_at);
 *      {sent:true} and {id} → sent_at. (The bar is isSendConfirmed, NOT result!=null.)
 *   5. ineligible (no_phone / no_restaurant_id / unsupported / whatsapp_disabled / order_missing) → skip+reason,
 *      no claim/send.
 *   6. ETA: config restaurants/<rid>/prep_eta_min drives the number; absent → neutral fallback 25.
 *   7. no-op (preparing→preparing, →non-preparing) → early return, nothing written.
 */
const assert = require('assert');

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA || 'instanceTEST';
process.env.ULTRAMSG_TOKEN_LA_MUSA = process.env.ULTRAMSG_TOKEN_LA_MUSA || 'tokTEST';
process.env.TRACKING_BASE_LA_MUSA = process.env.TRACKING_BASE_LA_MUSA || 'https://track.lamusa.hn';

const app = require('../index.js');
const whatsapp = require('../whatsapp');
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

// ---- sendMessage spy: record calls, force the outcome ----
let sends = [];
let sendMode = 'ok';
whatsapp.sendMessage = async (phone, body, restaurantId) => {
  sends.push({ phone, body, restaurantId });
  if (sendMode === 'throw') throw new Error('injected provider failure');
  if (sendMode === 'null') return null;
  if (sendMode === 'obj_empty') return {};                 // unreadable HTTP-200 → UNCONFIRMED
  if (sendMode === 'error_body') return { error: 'nope' }; // error body → UNCONFIRMED
  if (sendMode === 'sent_flag') return { sent: true };     // UltraMsg positive flag, no id → CONFIRMED
  return { id: 'MSG-' + sends.length };                    // real id → CONFIRMED
};
function resetSpy(mode = 'ok') { sends = []; sendMode = mode; }

const ev = (orderId, before, after) => ({
  data: { before: { val: () => before }, after: { val: () => after } },
  params: { orderId }
});
const IDENTITY = { active: true, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 10, version: 1, name: 'X Pizza', phone: '+50497952893', hours: null, whatsapp_enabled: true };
// default live status is 'preparing' (the window this trigger fires in)
const baseOrder = (o = {}) => ({ order_type: 'delivery', restaurant_id: 'x_pizza', customer_phone: '99990000', customer_name: 'Test', tracking_token: 'TOK123', status: 'preparing', ...o });
const seedOrder = (id, o) => db.ref(`orders/${id}`).set(baseOrder(o));
const notif = async (id) => (await db.ref(`preparing_notifications/${id}`).once('value')).val();
const subtree = async (p) => (await db.ref(p).once('value')).val();
async function reset() {
  await db.ref('/').set(null);
  await db.ref('restaurants/x_pizza/identity').set(IDENTITY);
  await db.ref('restaurants/la_musa/identity').set({ ...IDENTITY, name: 'La Musa' });
  await db.ref('config/whatsapp_enabled').set(true);
}
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. →preparing (delivery AND pickup) → ONE send; claimed+started+sent; ZERO order/side writes ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('D1', { order_type: 'delivery' });
    await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
    const ordersBefore = await subtree('orders');
    await app.notifyPreparing.run(ev('D1', 'new', 'preparing'));
    assert.strictEqual(sends.length, 1, 'delivery preparing → exactly one send');
    assert.ok(sends[0].body.includes('preparando') && /estará listo en ~20 min/.test(sends[0].body), 'delivery readiness copy + config ETA');
    assert.ok(/salga en camino/.test(sends[0].body) && !/listo para recoger/.test(sends[0].body), 'delivery copy (not pickup)');
    const n = await notif('D1');
    assert.ok(n.claimed_at && n.send_started_at && n.sent_at && !n.send_unresolved_at, 'claimed+started+sent, no unresolved');
    assert.deepStrictEqual(await subtree('orders'), ordersBefore, '/orders unchanged');
    assert.strictEqual(await subtree('tasks'), null, 'no tasks write');
    assert.strictEqual(await subtree('payment_attempts'), null, 'no payment write');
    assert.strictEqual(await subtree('facturas'), null, 'no factura write');

    await seedOrder('K1', { order_type: 'pickup' });
    await app.notifyPreparing.run(ev('K1', 'new', 'preparing'));
    assert.strictEqual(sends.length, 2, 'pickup preparing → send too (both types)');
    assert.ok(/listo para recoger/.test(sends[1].body), 'pickup readiness copy');
    ok('→preparing (delivery + pickup) → ONE send each; claimed+started+sent; zero order/side writes');
  }

  // ── 2. Redelivery + concurrent → exactly ONE send ──
  await reset(); resetSpy('ok'); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
  {
    await seedOrder('R1', {});
    await app.notifyPreparing.run(ev('R1', 'new', 'preparing'));
    await app.notifyPreparing.run(ev('R1', 'new', 'preparing'));
    assert.strictEqual(sends.length, 1, 'redelivered → ONE send');
    await seedOrder('R2', {}); resetSpy('ok');
    await Promise.all([
      app.notifyPreparing.run(ev('R2', 'new', 'preparing')),
      app.notifyPreparing.run(ev('R2', 'new', 'preparing'))
    ]);
    assert.strictEqual(sends.length, 1, 'concurrent → ONE send');
    const markers = await subtree('preparing_notifications');
    assert.ok(markers.R1 && markers.R2 && markers.R1 !== markers.R2, 'distinct per-order markers (interpolated path)');
    ok('redelivery + concurrent → exactly ONE send; distinct per-order markers');
  }

  // ── 3. STALE-STATUS GUARD: preparing event on an already-advanced order → skip, NO send ──
  await reset(); resetSpy('ok');
  {
    for (const st of ['ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled']) {
      await seedOrder('S_' + st, { status: st });                 // CURRENT status already past preparing
      await app.notifyPreparing.run(ev('S_' + st, 'new', 'preparing'));   // a delayed/redelivered preparing event
      const n = await notif('S_' + st);
      assert.ok(n && n.skipped_reason === 'stale_status' && !n.claimed_at, `status=${st}: skip stale_status, no claim`);
    }
    assert.strictEqual(sends.length, 0, 'stale events → ZERO sends');
    ok('stale-status guard: late preparing event on ready/otd/delivered/completed/cancelled → skip, no send');
  }

  // ── 4. isSendConfirmed classification (NOT result != null) ──
  await reset(); await db.ref('restaurants/x_pizza/prep_eta_min').set(20);
  {
    const cases = [
      ['null', false], ['throw', false], ['obj_empty', false], ['error_body', false],
      ['sent_flag', true], ['ok', true]
    ];
    let i = 0;
    for (const [mode, confirmed] of cases) {
      resetSpy(mode);
      const id = 'C' + (i++);
      await seedOrder(id, {});
      await app.notifyPreparing.run(ev(id, 'new', 'preparing'));
      const n = await notif(id);
      assert.ok(n.send_started_at, `${mode}: attempt made`);
      if (confirmed) assert.ok(n.sent_at && !n.send_unresolved_at, `${mode}: → sent_at`);
      else assert.ok(n.send_unresolved_at && !n.sent_at, `${mode}: → send_unresolved_at, NO sent_at`);
    }
    ok('isSendConfirmed: {}/null/thrown/{error} → unresolved; {sent:true}/{id} → sent_at');
  }

  // ── 5. Ineligible → skip + reason, no claim/send ──
  await reset(); resetSpy('ok');
  {
    const seedRaw = (id, o) => db.ref(`orders/${id}`).set(o);
    await seedRaw('E_missing_phone', baseOrder({ customer_phone: '' }));
    await seedRaw('E_no_rid', baseOrder({ restaurant_id: '' }));
    await seedRaw('E_unsupported', baseOrder({ restaurant_id: 'taco_stand' }));
    // whatsapp_disabled: use la_musa (fails CLOSED on its own identity flag; x_pizza would read the GLOBAL flag).
    await seedOrder('E_disabled', { restaurant_id: 'la_musa' }); await db.ref('restaurants/la_musa/identity/whatsapp_enabled').set(false);
    // (E_missing order is simply never seeded)
    const expect = {
      E_missing_phone: 'no_phone', E_no_rid: 'no_restaurant_id',
      E_unsupported: 'unsupported_restaurant', E_disabled: 'whatsapp_disabled'
    };
    for (const [id, reason] of Object.entries(expect)) {
      await app.notifyPreparing.run(ev(id, 'new', 'preparing'));
      const n = await notif(id);
      assert.ok(n && n.skipped_reason === reason && !n.claimed_at && !n.sent_at, `${id} → skip ${reason}, no claim/send`);
    }
    await app.notifyPreparing.run(ev('E_never_seeded', 'new', 'preparing'));
    const nm = await notif('E_never_seeded');
    assert.ok(nm && nm.skipped_reason === 'order_missing', 'missing order → skip order_missing');
    assert.strictEqual(sends.length, 0, 'ineligible → zero sends');
    ok('ineligible (no_phone/no_rid/unsupported/disabled/order_missing) → skip+reason, no claim/send');
  }

  // ── 6. ETA fallback when config absent → neutral 25 ──
  await reset(); resetSpy('ok');   // reset() does NOT seed prep_eta_min → absent
  {
    await seedOrder('ETA1', { order_type: 'pickup' });
    await app.notifyPreparing.run(ev('ETA1', 'new', 'preparing'));
    assert.ok(/~25 min/.test(sends[0].body), 'absent prep_eta_min → neutral fallback 25');
    ok('ETA: absent config → fallback 25 (config-driven with neutral default)');
  }

  // ── 7. No-op transitions → early return, nothing written ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('N1', {});
    await app.notifyPreparing.run(ev('N1', 'preparing', 'preparing'));  // no-op rewrite
    await app.notifyPreparing.run(ev('N1', 'new', 'ready'));            // not preparing
    assert.strictEqual(sends.length, 0, 'no-op / non-preparing → no send');
    assert.strictEqual(await notif('N1'), null, 'nothing written to the marker');
    ok('no-op (preparing→preparing) + non-preparing (→ready) → early return, nothing written');
  }

  console.log(`\npreparing-ready.emulator.test.js: ${pass} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
