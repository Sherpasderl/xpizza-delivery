'use strict';
// F3 double-order guard — pure collision decision + the materialize-side hold (DI'd RTDB). Run: node f3-duplicate-decision.test.js
const assert = require('assert');
const { duplicateSiblingDecision, holdIfDuplicateSibling } = require('./materialize-guard');
const { orderContentKey, orderContentKeyVerbatim, readContentStamp, legacyItemsText, rateLimitKey } = require('./order-dedup');

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

  // ── PLAN-menu-ordering §3 (codex serialization r1 P1): the forms now serialize in cart INSERTION order ──
  {
    const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Margherita (L250)';
    const AB = `${A} | ${B}`, BA = `${B} | ${A}`;
    const args = (t) => ({ phone: PHONE, itemsText: t, orderType: 'delivery', scheduledFor: null });
    const pathOf = (k) => `recent_order_content/${rateLimitKey(PHONE)}/${k}`;
    const order = (id, t) => ({ ...orderX(), order_id: id, items_text: t, restaurant_id: 'x_pizza' });
    assert.equal(orderContentKey(args(AB)), orderContentKey(args(BA)), '[A,B] and [B,A] → the same content key');
    assert.notEqual(orderContentKeyVerbatim(args(AB)), orderContentKeyVerbatim(args(BA)), 'premise: the pre-§3 key told them apart');
    // the cash sibling Y was built [A,B]; the late online X was built [B,A] (independently assembled) — and vice versa
    for (const [yText, xText] of [[AB, BA], [BA, AB]]) {
      const store = { [pathOf(orderContentKey(args(yText)))]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'new' }, 'orders/X': order('X', xText) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', xText), 123), true, `🔴 Y ${yText === AB ? '[A,B]' : '[B,A]'} vs X ${xText === AB ? '[A,B]' : '[B,A]'}: the REAL guard holds the duplicate`);
      assert.equal(store['orders/X'].payment_status, 'manual_reconciliation');
    }
    ok('§3: the same cart in either line order is ONE content key — the real holdIfDuplicateSibling holds the late duplicate both ways');
    // TRANSITION: Y was stamped by the PREVIOUS deploy (verbatim key, menu-ordered text); X materializes after the deploy
    {
      const store = { [pathOf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 60000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'preparing' }, 'orders/X': order('X', AB) };
      assert.notEqual(orderContentKeyVerbatim(args(AB)), orderContentKey(args(AB)), 'premise: a multi-line legacy stamp sits under a DIFFERENT key');
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB), 123), true, '🔴 a LEGACY-stamped live sibling still matches');
      ok('§3 transition: a sibling stamped under the pre-§3 VERBATIM key still holds the duplicate');
    }
    // both stamps present → the LATEST `at` wins (exactly the old single key's "last writer" semantics)
    {
      const legacy = pathOf(orderContentKeyVerbatim(args(AB))), canon = pathOf(orderContentKey(args(AB)));
      const st1 = { [legacy]: { at: 1000, order_id: 'Y', payment_method: 'cash' }, [canon]: { at: 2000, order_id: 'X', payment_method: 'online' }, 'orders/Y': { status: 'new' }, 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(st1) }, 'X', order('X', AB), 123), false, 'the newer canonical stamp (X itself) wins over an older legacy one → no hold, as one shared key would have said');
      const st2 = { [legacy]: { at: 3000, order_id: 'Y', payment_method: 'cash' }, [canon]: { at: 2000, order_id: 'X', payment_method: 'online' }, 'orders/Y': { status: 'new' }, 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(st2) }, 'X', order('X', AB), 123), true, 'a newer legacy stamp (cash Y) wins → hold');
      const one = { [pathOf(orderContentKey(args(B)))]: { at: 5, order_id: 'Y', payment_method: 'cash' } };
      const reads = []; const db = { ref: (p) => ({ once: async () => { reads.push(p); return { val: () => one[p] }; } }) };
      assert.deepStrictEqual(await readContentStamp(db, args(B)), one[pathOf(orderContentKey(args(B)))]);
      assert.equal(reads.length, 1, 'a one-line cart has ONE key (canonical === verbatim) → one read');
      ok('§3: with both stamps present the LATEST `at` wins; a one-line cart costs one read');
    }
  }

  // ── §3 r2 (codex r2 P1): a LEGACY sibling (stamped by a pre-§3 client, menu order) is found from an incoming cart in
  //    ANY line order — the guard rebuilds the legacy key in menu order from the cached snapshot (deps.menuNamesFor) ──
  {
    const MENU = ['Carnivora', 'Crispy Bacon', 'Margherita', 'Pepperoni'];
    const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Pepperoni (L307)';
    const AB = `${A} | ${B}`, BA = `${B} | ${A}`;   // AB = what a pre-§3 client sent (menu order)
    const args = (t) => ({ phone: PHONE, itemsText: t, orderType: 'delivery', scheduledFor: null });
    const pathOf = (k) => `recent_order_content/${rateLimitKey(PHONE)}/${k}`;
    const order = (id, t) => ({ ...orderX(), order_id: id, items_text: t, restaurant_id: 'x_pizza' });
    const legacyStamp = { [pathOf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 60000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': { status: 'preparing' } };
    const deps = (store, names = MENU, logs = []) => ({ db: fakeDb(store), menuNamesFor: names === undefined ? undefined : () => names, logsink: logs });
    { const store = { ...legacyStamp, 'orders/X': order('X', BA) };
      assert.equal(await holdIfDuplicateSibling(deps(store), 'X', order('X', BA), 123), true, '🔴 legacy [A,B] sibling + incoming [B,A] → HELD (the codex r2 reproduction)');
      assert.equal(store['orders/X'].payment_status, 'manual_reconciliation'); }
    { const store = { ...legacyStamp, 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling(deps(store), 'X', order('X', AB), 123), true, 'control: legacy [A,B] + incoming [A,B] → held'); }
    // the snapshot is missing (cold instance / unknown rid): the incoming verbatim key is read instead, and that is logged
    { const store = { ...legacyStamp, 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB), 123), true, 'no snapshot: a same-order legacy sibling is still found (incoming verbatim)');
      const logs = []; const db = fakeDb({ ...legacyStamp });
      await readContentStamp(db, args(BA), { menuNames: null, orderId: 'X', log: (...a) => logs.push(a.join(' ')) });
      assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"X"') && l.includes('"reason":"no_menu_snapshot"')), 'the fallback is LOGGED with the order_id and reason');
      const store2 = { ...legacyStamp, 'orders/X': order('X', BA) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store2) }, 'X', order('X', BA), 123), false, 'no snapshot + a permuted legacy sibling → not found (the logged, bounded transition gap)'); }
    { const seen = []; const db = { ref: (p) => ({ once: async () => { seen.push(p); return { val: () => null }; } }) };
      await readContentStamp(db, args(BA), { menuNames: MENU, orderId: 'X' });
      assert.deepStrictEqual(seen.sort(), [pathOf(orderContentKey(args(BA))), pathOf(orderContentKeyVerbatim(args(AB)))].sort(), 'reads exactly the canonical key and the MENU-ORDER legacy key (no extra read)'); }
    ok('§3 r2: a legacy [A,B] sibling is held from an incoming [B,A] (menu-order legacy key from deps.menuNamesFor); control held; no snapshot → incoming verbatim, logged');
  }

  console.log(`\nf3-duplicate-decision.test.js: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
