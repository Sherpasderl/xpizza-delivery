'use strict';
// F3 double-order guard — pure collision decision + the materialize-side hold (DI'd RTDB). Run: node f3-duplicate-decision.test.js
const assert = require('assert');
const { duplicateSiblingDecision, holdIfDuplicateSibling } = require('./materialize-guard');
const { orderContentKey, rateLimitKey } = require('./order-dedup');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── pure duplicateSiblingDecision ────────────────────────────────────────────
{
  const stamp = (o = {}) => ({ at: 1, order_id: 'Y', payment_method: 'cash', ...o });
  const liveY = { status: 'new' };
  // materialize-side (expect a cash sibling)
  assert.deepEqual(duplicateSiblingDecision('X', stamp(), liveY, 'cash'), { collision: true, siblingOrderId: 'Y' });
  ok('live cash sibling, different id → collision');
  assert.equal(duplicateSiblingDecision('Y', stamp(), liveY, 'cash').collision, false);
  ok('stamp is self (same order_id) → no collision');
  for (const st of ['cancelled', 'delivered', 'completed']) {
    assert.equal(duplicateSiblingDecision('X', stamp(), { status: st }, 'cash').collision, false, st);
  }
  ok('sibling cancelled/delivered/completed → no collision');
  assert.equal(duplicateSiblingDecision('X', stamp({ payment_method: 'online' }), liveY, 'cash').collision, false);
  ok('sibling method mismatch → no collision');
  assert.equal(duplicateSiblingDecision('X', null, liveY, 'cash').collision, false);
  assert.equal(duplicateSiblingDecision('X', stamp(), null, 'cash').collision, false);
  ok('null stamp / null sibling → no collision');
  // create-side (expect an online sibling)
  assert.deepEqual(duplicateSiblingDecision('Y', stamp({ order_id: 'X', payment_method: 'online' }), { status: 'preparing' }, 'online'), { collision: true, siblingOrderId: 'X' });
  ok('create-side: live online sibling → collision');
  // PIN 1 — the decision has NO `at` parameter: an ancient stamp with a live sibling still collides.
  assert.equal(duplicateSiblingDecision('X', stamp({ at: 1 /* epoch, way >2min old */ }), liveY, 'cash').collision, true);
  ok('PIN 1: ancient stamp + live sibling → still collision (no 2-min freshness gate)');
}

// ── async holdIfDuplicateSibling (fake RTDB) ─────────────────────────────────
function fakeDb(store, opts = {}) {
  return { ref(path) {
    return {
      async once() { if (opts.throwOn && opts.throwOn(path)) throw new Error('read fail'); return { val: () => store[path] }; },
      async transaction(fn) { const next = fn(store[path]); store[path] = next; return { committed: true }; },
      async set(v) { store[path] = v; },
      async update() {},
    };
  } };
}
const PHONE = '+50433903062';
const CK = orderContentKey({ phone: PHONE, itemsText: '1x Pad Thai (L500)', orderType: 'delivery', scheduledFor: null });
const stampPath = `recent_order_content/${rateLimitKey(PHONE)}/${CK}`;
const orderX = () => ({ order_id: 'X', customer_phone: PHONE, items_text: '1x Pad Thai (L500)', order_type: 'delivery', restaurant_id: 'la_musa', payment_status: 'confirmed', status: 'pending_payment' });

(async () => {
  // collision → HOLD X (manual_reconciliation), alert written, NOT materialized/refunded
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'new' }, 'orders/X': orderX() };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, true, 'guard returns true (must NOT materialize)');
    assert.equal(store['orders/X'].payment_status, 'manual_reconciliation');
    assert.equal(store['orders/X'].blocked_reason, 'duplicate_of_sibling');
    assert.equal(store['orders/X'].sibling_order_id, 'Y');
    assert.ok(!store['orders/X'].materialized_at, 'X never materialized');
    assert.notEqual(store['orders/X'].payment_status, 'refunded', 'X never auto-refunded — money held for the dispatcher');
    assert.ok(store['dispatcher_alerts/duplicate_order_X'], 'dispatcher alert written');
    ok('collision → HOLD X (manual_reconciliation) + alert, never materialize/refund');
  }
  // PIN 1 regression — Y stamped >2min ago but STILL live → still HOLD (guard does not gate on freshness)
  {
    const store = { [stampPath]: { at: Date.now() - 10 * 60 * 1000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'ready' }, 'orders/X': orderX() };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, true, 'PIN 1: 10-min-old stamp + live Y → HOLD (never uses isContentRetap/2-min)');
    assert.equal(store['orders/X'].payment_status, 'manual_reconciliation');
    ok('PIN 1 regression: stamp 10min old but Y live → still HOLD');
  }
  // REVISE (codex): X concurrently transitions to a non-confirmed money-state between the guard's read and the
  // CAS commit → the CAS must NOT clobber that in-flight refund/cancel/resolve into manual_reconciliation. The
  // `order` param is the confirmed read (so collision detection fires), but orders/X at CAS time is refund_pending.
  for (const cur of [{ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close' }, { payment_status: 'refunded', status: 'cancelled' }, { payment_status: 'manual_review' }, { payment_status: 'failed' }]) {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'new' }, 'orders/X': { ...orderX(), ...cur } };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, true, `collision detected but must not materialize (${cur.payment_status})`);
    assert.equal(store['orders/X'].payment_status, cur.payment_status, `concurrent ${cur.payment_status} PRESERVED — not clobbered to manual_reconciliation`);
    assert.notEqual(store['orders/X'].blocked_reason, 'duplicate_of_sibling', `F3 did not overwrite the in-flight ${cur.payment_status}`);
  }
  ok('REVISE: concurrent non-confirmed X (refund_pending/refunded/manual_review/failed) → money-state PRESERVED, still not materialized');

  // sibling cancelled → NO hold (materialize X)
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'cancelled' }, 'orders/X': orderX() };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, false, 'cancelled sibling → materialize X');
    assert.equal(store['orders/X'].payment_status, 'confirmed', 'X untouched');
    ok('cancelled sibling → NO hold (X materializes)');
  }
  // no stamp → materialize
  {
    const store = { 'orders/X': orderX() };
    assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123), false);
    ok('no stamp → NO hold (X materializes)');
  }
  // self stamp (stamp holds X itself) → materialize
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'X', payment_method: 'cash' }, 'orders/X': orderX() };
    assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123), false);
    ok('self stamp → NO hold');
  }
  // FAIL-OPEN — a read throw → materialize (never hold a paid order on uncertainty)
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'new' }, 'orders/X': orderX() };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store, { throwOn: (p) => p.startsWith("orders/Y") }) }, 'X', orderX(), 123);
    assert.equal(held, false, 'read throw → fail-open (materialize)');
    assert.equal(store['orders/X'].payment_status, 'confirmed', 'X untouched on fail-open');
    ok('read error → FAIL-OPEN (materialize, never hold)');
  }

  console.log(`\nf3-duplicate-decision.test.js: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
