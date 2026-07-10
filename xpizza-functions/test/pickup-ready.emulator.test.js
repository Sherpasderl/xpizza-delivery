'use strict';
/**
 * OWNER-RUN emulator test — notifyPickupReady, the KDS Phase 2c pickup-ready WhatsApp (KDS_2C_PLAN.md §Tests).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/pickup-ready.emulator.test.js"
 * (Owner-run: needs Java + the Firebase emulator, like the repo's other *.emulator.test.js files.)
 *
 * Invokes the REAL onValueWritten trigger via its v2 CloudFunction `.run({data:{before,after},params})`
 * against the RTDB emulator, with `whatsapp.sendMessage` monkey-patched to a controllable spy (count calls,
 * force object / null / throw). Asserts:
 *   1. pickup ready → exactly ONE send; claimed_at+send_started_at+sent_at; ZERO /orders,tasks,payments,factura.
 *   2. double-invocation (redelivery + concurrent) of the same ready event → exactly ONE send.
 *   3. delivery ready → skip not_pickup, no claim/send; a pickup ready → one send.
 *   4. send failure (null AND thrown) → send_unresolved_at, sent_at ABSENT (no false-sent).
 *   5. ineligible (no_phone / no_restaurant_id / unsupported / whatsapp_disabled / order_missing) → skip + reason.
 *   5b. skip-guard: a sent node is NOT overwritten by a later ineligible redelivery.
 *   5c. durable-start: if send_started_at write fails, sendMessage is NOT called (claimed_at-only = unsent).
 *   6. missing tracking_token → message sent WITHOUT a link (core message intact).
 *   7. no-op ready→ready (and →non-ready) → early return, nothing written.
 *   8. rules: /pickup_ready_notifications is an admin-only hard deny (all clients denied).
 *   9. tplPickupReady per-restaurant snapshot (brand + link / no-link).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
// la_musa creds so test 9's per-restaurant snapshot resolves La Musa's own tracking base (call-time read).
process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA = process.env.ULTRAMSG_INSTANCE_ID_LA_MUSA || 'instanceTEST';
process.env.ULTRAMSG_TOKEN_LA_MUSA = process.env.ULTRAMSG_TOKEN_LA_MUSA || 'tokTEST';
process.env.TRACKING_BASE_LA_MUSA = process.env.TRACKING_BASE_LA_MUSA || 'https://track.lamusa.hn';

const app = require('../index.js');            // initializes admin against the emulator + registers triggers
const whatsapp = require('../whatsapp');        // SAME module instance the trigger uses → the spy takes effect
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();

// ---- sendMessage spy: record calls, force the outcome (object success / null / throw) ----
let sends = [];
let sendMode = 'ok';
whatsapp.sendMessage = async (phone, body, restaurantId) => {
  sends.push({ phone, body, restaurantId });
  if (sendMode === 'throw') throw new Error('injected provider failure');
  if (sendMode === 'null') return null;
  return { id: 'MSG-' + sends.length };
};
function resetSpy(mode = 'ok') { sends = []; sendMode = mode; }

// ---- synthetic event for .run() ----
const ev = (orderId, before, after) => ({
  data: { before: { val: () => before }, after: { val: () => after } },
  params: { orderId }
});

const IDENTITY = { active: true, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 10, version: 1, name: 'X Pizza', phone: '+50497952893', hours: null, whatsapp_enabled: true };
const baseOrder = (o = {}) => ({ order_type: 'pickup', restaurant_id: 'x_pizza', customer_phone: '99990000', customer_name: 'Test', tracking_token: 'TOK123', status: 'ready', ...o });

const seedOrder = (id, o) => db.ref(`orders/${id}`).set(baseOrder(o));
const notif = async (id) => (await db.ref(`pickup_ready_notifications/${id}`).once('value')).val();
const subtree = async (p) => (await db.ref(p).once('value')).val();
async function reset() {
  await db.ref('/').set(null);
  await db.ref('restaurants/x_pizza/identity').set(IDENTITY);
  await db.ref('config/whatsapp_enabled').set(true);
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── 1. Pickup ready → ONE send; claimed+started+sent; ZERO writes to /orders,tasks,payments,factura ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('P1', {});
    const ordersBefore = await subtree('orders');
    await app.notifyPickupReady.run(ev('P1', 'preparing', 'ready'));
    assert.strictEqual(sends.length, 1, 'exactly one send');
    assert.strictEqual(sends[0].phone, '99990000');
    assert.strictEqual(sends[0].restaurantId, 'x_pizza');
    assert.ok(sends[0].body.includes('listo para recoger'), 'pickup-ready body');
    const n = await notif('P1');
    assert.ok(n.claimed_at && n.send_started_at && n.sent_at, 'claimed_at+send_started_at+sent_at set');
    assert.ok(!n.send_unresolved_at, 'no send_unresolved_at on success');
    assert.deepStrictEqual(await subtree('orders'), ordersBefore, '/orders unchanged (no order write)');
    assert.strictEqual(await subtree('tasks'), null, 'no tasks write');
    assert.strictEqual(await subtree('payment_attempts'), null, 'no payment_attempts write');
    assert.strictEqual(await subtree('facturas'), null, 'no factura write');
    ok('pickup ready → ONE send; claimed+started+sent; zero /orders,tasks,payments,factura writes');
  }

  // ── 2. Double-invocation of the SAME ready event → exactly ONE send (claim transaction authority) ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('P2', {});
    await app.notifyPickupReady.run(ev('P2', 'new', 'ready'));
    await app.notifyPickupReady.run(ev('P2', 'new', 'ready'));   // redelivery: same before='new'
    assert.strictEqual(sends.length, 1, 'redelivered event → still ONE send');
    await seedOrder('P2b', {}); resetSpy('ok');
    await Promise.all([                                          // concurrent race
      app.notifyPickupReady.run(ev('P2b', 'new', 'ready')),
      app.notifyPickupReady.run(ev('P2b', 'new', 'ready'))
    ]);
    assert.strictEqual(sends.length, 1, 'concurrent double-invoke → still ONE send');
    ok('double-invocation (redelivery + concurrent) → exactly ONE send (claim transaction)');
  }

  // ── 3. Delivery ready → skip not_pickup, no claim/send; a pickup ready → one send ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('D1', { order_type: 'delivery' });
    await app.notifyPickupReady.run(ev('D1', 'preparing', 'ready'));
    assert.strictEqual(sends.length, 0, 'delivery → no send');
    const n = await notif('D1');
    assert.ok(n && n.skipped_reason === 'not_pickup' && !n.claimed_at, 'delivery → skipped not_pickup, no claim');
    await seedOrder('D1p', {});
    await app.notifyPickupReady.run(ev('D1p', 'preparing', 'ready'));
    assert.strictEqual(sends.length, 1, 'pickup in same suite → one send');
    ok('delivery ready → skip not_pickup (no claim/send); pickup ready → one send');
  }

  // ── 4. Send failure (null → and thrown) → send_unresolved_at, sent_at ABSENT (no false-sent) ──
  await reset(); resetSpy('null');
  {
    await seedOrder('F1', {});
    await app.notifyPickupReady.run(ev('F1', 'preparing', 'ready'));
    assert.strictEqual(sends.length, 1, 'send attempted');
    const n = await notif('F1');
    assert.ok(n.send_started_at, 'send_started_at set (attempt was made)');
    assert.ok(n.send_unresolved_at && !n.sent_at, 'null return → send_unresolved_at, NO sent_at');
    resetSpy('throw');
    await seedOrder('F2', {});
    await app.notifyPickupReady.run(ev('F2', 'preparing', 'ready'));
    const n2 = await notif('F2');
    assert.ok(n2.send_unresolved_at && !n2.sent_at, 'thrown send → send_unresolved_at, NO sent_at');
    ok('send failure (null AND thrown) → send_unresolved_at, sent_at ABSENT');
  }

  // ── 5. Ineligible → skipped_at + correct reason, no claim, no send ──
  await reset(); resetSpy('ok');
  {
    for (const [id, over, reason] of [
      ['NOPHONE', { customer_phone: null }, 'no_phone'],
      ['NORID', { restaurant_id: null }, 'no_restaurant_id'],
      ['BADRID', { restaurant_id: 'taco_place' }, 'unsupported_restaurant']
    ]) {
      await seedOrder(id, over);
      await app.notifyPickupReady.run(ev(id, 'preparing', 'ready'));
      const n = await notif(id);
      assert.ok(n && n.skipped_reason === reason, `${id} → skipped ${reason}`);
      assert.ok(!n.claimed_at && !n.sent_at, `${id} → no claim/send`);
    }
    // whatsapp disabled (global kill switch)
    await db.ref('config/whatsapp_enabled').set(false);
    await seedOrder('WD', {});
    await app.notifyPickupReady.run(ev('WD', 'preparing', 'ready'));
    assert.ok((await notif('WD')).skipped_reason === 'whatsapp_disabled', 'disabled → skipped whatsapp_disabled');
    await db.ref('config/whatsapp_enabled').set(true);
    // order missing
    await app.notifyPickupReady.run(ev('GONE', 'preparing', 'ready'));
    assert.ok((await notif('GONE')).skipped_reason === 'order_missing', 'missing order → skipped order_missing');
    assert.strictEqual(sends.length, 0, 'all ineligible → zero sends');
    ok('ineligible (no_phone/no_restaurant_id/unsupported/whatsapp_disabled/order_missing) → skip reason, no claim/send');
  }

  // ── 5b. Skip-guard — a sent node is NOT overwritten by a later ineligible redelivery ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('SG', {});
    await app.notifyPickupReady.run(ev('SG', 'preparing', 'ready'));      // sends → sent_at
    assert.ok((await notif('SG')).sent_at, 'first run sent');
    await db.ref('orders/SG/order_type').set('delivery');                 // now ineligible
    await app.notifyPickupReady.run(ev('SG', 'new', 'ready'));            // stale redelivery
    const after = await notif('SG');
    assert.ok(after.sent_at && !after.skipped_at, 'sent_at survives; skipped_at did NOT land (guard held)');
    assert.strictEqual(sends.length, 1, 'no second send');
    ok('skip-guard: a sent node is not overwritten by a later ineligible redelivery');
  }

  // ── 5c. Durable-start — if the send_started_at write fails, sendMessage is NOT called ──
  await reset(); resetSpy('ok');
  {
    const RefProto = Object.getPrototypeOf(db.ref('x'));
    const origSet = RefProto.set;
    RefProto.set = function (...a) {
      if (this.key === 'send_started_at') return Promise.reject(new Error('injected: send_started_at write failed'));
      return origSet.apply(this, a);
    };
    try {
      await seedOrder('DS', {});
      await app.notifyPickupReady.run(ev('DS', 'preparing', 'ready'));
      assert.strictEqual(sends.length, 0, 'send_started_at fault → sendMessage NOT called');
      const n = await notif('DS');
      assert.ok(n.claimed_at, 'claimed_at set (claim won)');
      assert.ok(!n.send_started_at, 'send_started_at absent (write failed)');
      assert.ok(!n.sent_at && !n.send_unresolved_at, 'no send outcome — truthfully unsent (claimed_at-only)');
    } finally {
      RefProto.set = origSet;
    }
    ok('durable-start: send_started_at write failure → sendMessage NOT called; node is claimed_at-only (unsent)');
  }

  // ── 5d. Read error → read_error_at stamped (durable trace), no claim/send; guard holds on a sent node ──
  await reset(); resetSpy('ok');
  {
    const RefProto = Object.getPrototypeOf(db.ref('x'));
    const origOnce = RefProto.once;
    // Make ONLY the orders/<id> read throw (not the pickup_ready_notifications reads the helpers do).
    const throwOrderRead = (id) => function (...a) {
      if (this.key === id && this.parent && this.parent.key === 'orders') return Promise.reject(new Error('injected: order read failed'));
      return origOnce.apply(this, a);
    };
    // (a) fresh order-read failure → read_error_at, no claim, no send
    await seedOrder('RE', {});
    try {
      RefProto.once = throwOrderRead('RE');
      await app.notifyPickupReady.run(ev('RE', 'preparing', 'ready'));
    } finally { RefProto.once = origOnce; }
    assert.strictEqual(sends.length, 0, 'read error → no send');
    const n = await notif('RE');
    assert.ok(n && n.read_error_at, 'read_error_at stamped (durable ops-visible trace)');
    assert.ok(!n.claimed_at && !n.send_started_at && !n.sent_at, 'read error → no claim/start/sent');
    // (b) guard holds — a read-error redelivery must NOT stamp over an already-sent node
    await reset(); resetSpy('ok');
    await seedOrder('RE2', {});
    await app.notifyPickupReady.run(ev('RE2', 'preparing', 'ready'));   // sends → sent_at
    assert.ok((await notif('RE2')).sent_at, 'RE2 first run sent');
    try {
      RefProto.once = throwOrderRead('RE2');
      await app.notifyPickupReady.run(ev('RE2', 'new', 'ready'));       // stale redelivery, read now throws
    } finally { RefProto.once = origOnce; }
    const n2 = await notif('RE2');
    assert.ok(n2.sent_at && !n2.read_error_at, 'guard: read-error did NOT stamp over a sent node');
    assert.strictEqual(sends.length, 1, 'no second send');
    ok('read error → read_error_at stamped (no claim/send); guard: never overwrites a sent node');
  }

  // ── 6. Missing tracking_token → message sent WITHOUT a link (core message intact) ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('NT', { tracking_token: null });
    await app.notifyPickupReady.run(ev('NT', 'preparing', 'ready'));
    assert.strictEqual(sends.length, 1, 'sent');
    assert.ok(!sends[0].body.includes('http'), 'no link when token absent');
    assert.ok(sends[0].body.includes('listo para recoger'), 'core message still sent');
    assert.ok((await notif('NT')).sent_at, 'sent_at set');
    ok('missing tracking_token → message sent WITHOUT a link (core message intact)');
  }

  // ── 7. No-op ready→ready (and →non-ready) → early return, nothing written ──
  await reset(); resetSpy('ok');
  {
    await seedOrder('NOOP', {});
    await app.notifyPickupReady.run(ev('NOOP', 'ready', 'ready'));
    assert.strictEqual(sends.length, 0, 'no-op → no send');
    assert.strictEqual(await notif('NOOP'), null, 'no-op → nothing written');
    await app.notifyPickupReady.run(ev('NOOP', 'ready', 'preparing'));
    assert.strictEqual(sends.length, 0, 'after!=ready → no send');
    assert.strictEqual(await notif('NOOP'), null, 'after!=ready → nothing written');
    ok('no-op ready→ready (and →non-ready) → early return, nothing written');
  }

  // ── 8. Rules: /pickup_ready_notifications is an admin-only hard deny (all clients denied) ──
  {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
    assert.strictEqual(r.pickup_ready_notifications['.read'], false, 'public/kitchen_staff/dispatcher/driver read DENIED');
    assert.strictEqual(r.pickup_ready_notifications['.write'], false, 'all client write DENIED');
    assert.ok(!r['.read'] && !r['.write'], 'no root cascade grant over the deny');
    ok('rules: /pickup_ready_notifications admin-only deny (all clients denied; also gated by check:rules guard)');
  }

  // ── 9. tplPickupReady per-restaurant snapshot (brand + link / no-link) ──
  {
    const xp = whatsapp.tplPickupReady({ customerName: 'María', trackingToken: 'TOK', restaurantId: 'x_pizza' });
    assert.ok(xp.includes('X. Pizza') && xp.includes('🍕') && xp.includes('https://xpizzatrack.netlify.app/TOK'), 'x_pizza brand+emoji+link');
    const lm = whatsapp.tplPickupReady({ customerName: 'María', trackingToken: 'TOK', restaurantId: 'la_musa' });
    assert.ok(lm.includes('La Musa') && lm.includes('🍜') && lm.includes('https://track.lamusa.hn/TOK'), 'la_musa brand+emoji+own-base link');
    const noLink = whatsapp.tplPickupReady({ customerName: 'María', trackingToken: null, restaurantId: 'x_pizza' });
    assert.ok(!noLink.includes('http') && noLink.includes('listo para recoger'), 'no token → no link, core message intact');
    ok('tplPickupReady snapshot: per-restaurant brand + link / no-link');
  }

  console.log(`\nAll ${pass} pickup-ready emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
