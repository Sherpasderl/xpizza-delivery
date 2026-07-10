'use strict';
/**
 * OWNER-RUN emulator test — the STRICT "a blocked (86'd) attempt writes NOTHING" proof on the LIVE
 * createOrder / chargeOnlineOrder handlers (KDS Phase 2b · Slice 4 · KDS_2B_PLAN.md §6/§11, R4 #2).
 *
 * Runs the real onRequest handlers against the RTDB emulator via an ephemeral HTTP server:
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/intake-availability.emulator.test.js"
 * (Owner-run: needs Java + the Firebase emulator, like the repo's other *.emulator.test.js files.)
 *
 * Asserts:
 *   A. CASH blocked  → 400 {error:'item_unavailable', blocked:['Margherita']} AND zero writes to
 *      /orders, /payment_attempts, /rate_limits.
 *   B. ONLINE fresh blocked → 400 {error:'item_unavailable'} AND zero writes to the same three subtrees.
 *   C. ONLINE terminal BYPASS → a pre-confirmed (paid) order whose item is later 86'd is NOT re-rejected:
 *      the gate is bypassed and the handler returns 409 'Already paid' (never 400 item_unavailable).
 *   D. Positive control — an AVAILABLE cash cart passes the gate and writes an order.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

// Env MUST be set before requiring index.js (it reads MAKE_SECRET; the emulator host is set by emulators:exec).
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
// Sandbox PixelPay = intrinsic defaults (no creds needed); the online gate runs before any PixelPay use anyway.
delete process.env.PIXELPAY_MODE;

const SECRET = process.env.MAKE_SECRET;
const app = require('../index.js');                 // initializes the admin app against the emulator
const { getDatabase } = require('firebase-admin/database');
const { availKey } = require('../avail-key');
const db = getDatabase();

// POST JSON to an onRequest handler mounted on an ephemeral server; resolves { status, json }.
function post(handler, body, { secret = SECRET } = {}) {
  return new Promise((resolve, reject) => {
    // Firebase Functions v2 onRequest AUTO-APPLIES an express.json() body parser in the runtime. A bare
    // http.createServer(handler) bypasses that layer, so req.body arrives unparsed and every handler 400s
    // on "missing required fields" (validateOrderPayload) BEFORE ever reaching the availability gate — the
    // request never exercised what this suite tests. Mount the handler behind express.json() to mirror the
    // runtime so the (complete) payload passes validation + auth and reaches the gate.
    const wrapped = express();
    wrapped.use(express.json());
    wrapped.use(handler);
    const server = http.createServer(wrapped).listen(0, async () => {
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        server.close(() => resolve({ status: res.status, json, text }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

const MARG = availKey('Margherita');
const IDENTITY = { active: true, hub_lat: 15.5, hub_lng: -88.0, delivery_radius_km: 10, version: 1, name: 'X Pizza', phone: '+50497952893', hours: null };
const cashPayload = (orderId, itemName = 'Margherita') => ({
  restaurant_id: 'x_pizza', order_id: orderId, customer_name: 'Test', customer_phone: '99990000',
  items_text: `1x ${itemName}`, order_type: 'pickup', payment_method: 'cash',
  items: [{ name: itemName, qty: 1 }],
});
const onlinePayload = (orderId) => ({ ...cashPayload(orderId), payment_method: 'online' });

async function subtreeEmpty(name) {
  const v = (await db.ref(name).once('value')).val();
  return v == null || Object.keys(v).length === 0;
}
async function reset() {
  await db.ref('/').set(null);
  await db.ref('restaurants/x_pizza/identity').set(IDENTITY);
  await db.ref(`restaurants/x_pizza/item_availability/${MARG}`).set({ available: false, updated_at: Date.now() });
}

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // ── A. CASH blocked → 400 + ZERO writes ──
  await reset();
  {
    const r = await post(app.createOrder, cashPayload('CASH-86'));
    assert.strictEqual(r.status, 400, `cash blocked status (got ${r.status}: ${r.text})`);
    assert.strictEqual(r.json.error, 'item_unavailable');
    assert.deepStrictEqual(r.json.blocked, ['Margherita']);
    assert.ok(await subtreeEmpty('orders'), 'CASH blocked wrote to /orders');
    assert.ok(await subtreeEmpty('rate_limits'), 'CASH blocked wrote to /rate_limits');
    assert.ok(await subtreeEmpty('payment_attempts'), 'CASH blocked wrote to /payment_attempts');
    ok('CASH blocked → 400 item_unavailable + ZERO writes (orders/rate_limits/payment_attempts)');
  }

  // ── B. ONLINE fresh blocked → 400 + ZERO writes ──
  await reset();
  {
    const r = await post(app.chargeOnlineOrder, onlinePayload('ONL-86'));
    assert.strictEqual(r.status, 400, `online blocked status (got ${r.status}: ${r.text})`);
    assert.strictEqual(r.json.error, 'item_unavailable');
    assert.ok(await subtreeEmpty('orders'), 'ONLINE blocked wrote to /orders');
    assert.ok(await subtreeEmpty('rate_limits'), 'ONLINE blocked wrote to /rate_limits');
    assert.ok(await subtreeEmpty('payment_attempts'), 'ONLINE blocked wrote to /payment_attempts');
    ok('ONLINE fresh blocked → 400 item_unavailable + ZERO writes (orders/rate_limits/payment_attempts)');
  }

  // ── C. ONLINE terminal BYPASS → confirmed(paid) order later 86'd is NOT re-rejected ──
  await reset();
  {
    await db.ref('orders/ONL-PAID').set({
      order_id: 'ONL-PAID', restaurant_id: 'x_pizza', payment_method: 'online',
      payment_status: 'confirmed', status: 'new', total: 299, total_cents: 29900,
    });
    const r = await post(app.chargeOnlineOrder, onlinePayload('ONL-PAID'));
    assert.notStrictEqual(r.status, 400, 'a PAID order must NOT be re-rejected as item_unavailable');
    assert.strictEqual(r.status, 409, `expected Already-paid 409 (got ${r.status}: ${r.text})`);
    assert.strictEqual(r.json.error, 'Already paid');
    ok('ONLINE terminal bypass: paid order later 86 is NOT re-rejected (409 Already paid, gate skipped)');
  }

  // ── D. Positive control — AVAILABLE cash cart passes the gate and writes an order ──
  await reset();
  {
    await db.ref(`restaurants/x_pizza/item_availability/${MARG}`).set({ available: true, updated_at: Date.now() });
    const r = await post(app.createOrder, cashPayload('CASH-OK'));
    assert.strictEqual(r.status, 200, `available cart should succeed (got ${r.status}: ${r.text})`);
    assert.ok((await db.ref('orders/CASH-OK').once('value')).exists(), 'available cart did not write the order');
    ok('positive control: AVAILABLE cash cart passes the gate → order written (fail-open path intact)');
  }

  console.log(`\nAll ${pass} intake-availability emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
