'use strict';
// F3 double-order guard — pure collision decision + the materialize-side hold (DI'd RTDB). Run: node f3-duplicate-decision.test.js
const assert = require('assert');
const { duplicateSiblingDecision, holdIfDuplicateSibling } = require('./materialize-guard');
const { orderContentKey, orderContentKeyVerbatim, readContentStamp, contentKeysRecord, legacyKeyByOrder, legacyItemsText, rateLimitKey } = require('./order-dedup');

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
// §3 r4: a sibling is a real order with its OWN content — the guard holds only when that content is X's (verified)
const sibY = (extra = {}, content = {}) => ({ order_id: 'Y', customer_phone: PHONE, items_text: '1x Pad Thai (L500)', order_type: 'delivery', payment_method: 'cash', ...content, ...extra });

(async () => {
  // collision → HOLD X (manual_reconciliation), alert written, NOT materialized/refunded
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'new' }), 'orders/X': orderX() };
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
    const store = { [stampPath]: { at: Date.now() - 10 * 60 * 1000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'ready' }), 'orders/X': orderX() };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, true, 'PIN 1: 10-min-old stamp + live Y → HOLD (never uses isContentRetap/2-min)');
    assert.equal(store['orders/X'].payment_status, 'manual_reconciliation');
    ok('PIN 1 regression: stamp 10min old but Y live → still HOLD');
  }
  // REVISE (codex): X concurrently transitions to a non-confirmed money-state between the guard's read and the
  // CAS commit → the CAS must NOT clobber that in-flight refund/cancel/resolve into manual_reconciliation. The
  // `order` param is the confirmed read (so collision detection fires), but orders/X at CAS time is refund_pending.
  for (const cur of [{ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close' }, { payment_status: 'refunded', status: 'cancelled' }, { payment_status: 'manual_review' }, { payment_status: 'failed' }]) {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'new' }), 'orders/X': { ...orderX(), ...cur } };
    const held = await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', orderX(), 123);
    assert.equal(held, true, `collision detected but must not materialize (${cur.payment_status})`);
    assert.equal(store['orders/X'].payment_status, cur.payment_status, `concurrent ${cur.payment_status} PRESERVED — not clobbered to manual_reconciliation`);
    assert.notEqual(store['orders/X'].blocked_reason, 'duplicate_of_sibling', `F3 did not overwrite the in-flight ${cur.payment_status}`);
  }
  ok('REVISE: concurrent non-confirmed X (refund_pending/refunded/manual_review/failed) → money-state PRESERVED, still not materialized');

  // sibling cancelled → NO hold (materialize X)
  {
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'cancelled' }), 'orders/X': orderX() };
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
    const store = { [stampPath]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'new' }), 'orders/X': orderX() };
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
      const store = { [pathOf(orderContentKey(args(yText)))]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'new' }, { items_text: yText }), 'orders/X': order('X', xText) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', xText), 123), true, `🔴 Y ${yText === AB ? '[A,B]' : '[B,A]'} vs X ${xText === AB ? '[A,B]' : '[B,A]'}: the REAL guard holds the duplicate`);
      assert.equal(store['orders/X'].payment_status, 'manual_reconciliation');
    }
    ok('§3: the same cart in either line order is ONE content key — the real holdIfDuplicateSibling holds the late duplicate both ways');
    // TRANSITION: Y was stamped by the PREVIOUS deploy (verbatim key, menu-ordered text); X materializes after the deploy
    {
      const store = { [pathOf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 60000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'preparing' }, { items_text: AB }), 'orders/X': order('X', AB) };
      assert.notEqual(orderContentKeyVerbatim(args(AB)), orderContentKey(args(AB)), 'premise: a multi-line legacy stamp sits under a DIFFERENT key');
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB), 123), true, '🔴 a LEGACY-stamped live sibling still matches');
      ok('§3 transition: a sibling stamped under the pre-§3 VERBATIM key still holds the duplicate');
    }
    // both stamps present → the LATEST `at` wins (exactly the old single key's "last writer" semantics)
    {
      const legacy = pathOf(orderContentKeyVerbatim(args(AB))), canon = pathOf(orderContentKey(args(AB)));
      const st1 = { [legacy]: { at: 1000, order_id: 'Y', payment_method: 'cash' }, [canon]: { at: 2000, order_id: 'X', payment_method: 'online' }, 'orders/Y': sibY({ status: 'new' }, { items_text: AB }), 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(st1) }, 'X', order('X', AB), 123), false, 'the newer canonical stamp (X itself) wins over an older legacy one → no hold, as one shared key would have said');
      const st2 = { [legacy]: { at: 3000, order_id: 'Y', payment_method: 'cash' }, [canon]: { at: 2000, order_id: 'X', payment_method: 'online' }, 'orders/Y': sibY({ status: 'new' }, { items_text: AB }), 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(st2) }, 'X', order('X', AB), 123), true, 'a newer legacy stamp (cash Y) wins → hold');
      const one = { [pathOf(orderContentKey(args(B)))]: { at: 5, order_id: 'Y', payment_method: 'cash' } };
      const reads = []; const db = { ref: (p) => ({ once: async () => { reads.push(p); return { val: () => one[p] }; } }) };
      assert.deepStrictEqual(await readContentStamp(db, args(B)), one[pathOf(orderContentKey(args(B)))]);
      assert.equal(reads.length, 1, 'a one-line cart has ONE key (canonical === verbatim) → one read');
      ok('§3: with both stamps present the LATEST `at` wins; a one-line cart costs one read');
    }
  }

  // ── §3 r3/r4 (codex r3 P1, r4 P1): a LEGACY sibling (stamped by a pre-§3 client, menu order) is found from an incoming
  //    cart in ANY line order through what chargeOnlineOrder PERSISTED at intake (warm snapshot): content_key + the
  //    menu-order PERMUTATION of the order's own lines — the legacy key is REBUILT from the order's own text, never stored.
  //    A paid order is held only on a VERIFIED sibling (its own content = this order's). ──
  {
    const MENU = ['Carnivora', 'Crispy Bacon', 'Margherita', 'Pepperoni'];
    const A = '2x Carnivora (L340) [Pizza 1: Mozzarella | Pizza 2: Pepperoni]', B = '1x Pepperoni (L307)';
    const AB = `${A} | ${B}`, BA = `${B} | ${A}`;   // AB = what a pre-§3 client sent (menu order)
    const args = (t) => ({ phone: PHONE, itemsText: t, orderType: 'delivery', scheduledFor: null });
    const pathOf = (k) => `recent_order_content/${rateLimitKey(PHONE)}/${k}`;
    const keysOf = (t) => contentKeysRecord(args(t), { menuNames: MENU, orderId: 'X' });   // what intake persists (warm)
    const order = (id, t, keys = keysOf(t)) => ({ ...orderX(), order_id: id, items_text: t, restaurant_id: 'x_pizza', ...keys });
    const legacyStamp = (ytext = AB, ystatus = 'preparing') => ({ [pathOf(orderContentKeyVerbatim(args(AB)))]: { at: Date.now() - 60000, order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: ystatus }, { items_text: ytext }) });
    const quiet = async (fn) => { const logs = []; const w = console.warn; console.warn = (...a) => logs.push(a.join(' ')); try { return { r: await fn(), logs }; } finally { console.warn = w; } };
    assert.deepStrictEqual(keysOf(BA), { content_key: orderContentKey(args(BA)), content_legacy_order: [1, 0] }, 'premise: warm intake persists content_key + the menu-order permutation of the order\'s OWN lines ([B,A] → [A,B] = [1,0])');
    assert.strictEqual(legacyKeyByOrder(args(BA), [1, 0]), orderContentKeyVerbatim(args(AB)), 'premise: the reader rebuilds the MENU-ORDER legacy key from the order\'s own text');
    { const store = { ...legacyStamp(), 'orders/X': order('X', BA) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123), true, '🔴 legacy [A,B] sibling + incoming [B,A] (persisted permutation) → HELD');
      assert.equal(store['orders/X'].payment_status, 'manual_reconciliation'); }
    { const store = { ...legacyStamp(), 'orders/X': order('X', AB) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB), 123), true, 'control: legacy [A,B] + incoming [A,B] → held'); }
    ok('§3 r4: a legacy [A,B] sibling is held from an incoming [B,A] via the persisted PERMUTATION (legacy key rebuilt from the order\'s own text); control held');

    // (a) VERIFIED sibling only — whichever key found the stamp, the sibling's own content must be this order's
    { const store = { ...legacyStamp('1x Margherita (L250)'), 'orders/X': order('X', BA) };   // the stamp points at an UNRELATED live cash order
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123));
      assert.equal(r, false, '🔴 a stamp pointing at an unrelated live cash order → NO hold (the paid order is never held on an unverified pointer)');
      assert.equal(store['orders/X'].payment_status, 'confirmed', 'X untouched');
      assert.ok(!store['dispatcher_alerts/duplicate_order_X'], 'no alert');
      assert.ok(logs.some((l) => l.includes('duplicate_sibling_not_verified') && l.includes('"order_id":"X"') && l.includes('"sibling_id":"Y"') && l.includes('"reason":"sibling_content_mismatch"')), 'the refusal is LOGGED {order_id, sibling_id, reason}'); }
    for (const [label, ytext] of [['another phone', null], ['another type', null], ['an extra line', `${AB} | 1x Margherita (L250)`], ['different extras on a pizza', AB.replace('Pepperoni]', 'Mozzarella]')]]) {
      const store = { ...legacyStamp(ytext || AB), 'orders/X': order('X', BA) };
      if (label === 'another phone') store['orders/Y'].customer_phone = '+50499990000';
      if (label === 'another type') store['orders/Y'].order_type = 'pickup';
      assert.equal((await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123))).r, false, `🔴 a sibling with ${label} → not held`);
    }
    // r5: the reward lines a sibling's server appended are known by PROVENANCE (redemption + reward_text_appended), never by pattern
    const RW = ' | 1x Margherita (Recompensa)';
    { const store = { ...legacyStamp(`${AB}${RW}`), 'orders/X': order('X', BA) };   // Y redeemed (provenance recorded); X did not
      Object.assign(store['orders/Y'], { redemption: { model: 'add_free' }, reward_text_appended: RW });
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123), true, 'a sibling whose server appended a reward (provenance) is the same cart → held'); }
    ok('§3 r4 (a): the sibling\'s OWN content is verified before any hold — unrelated / other phone / other type / other lines / other extras → not held, logged; a reward the sibling\'s server appended (provenance) → held');

    // ── §3 r5 (codex r5 P1-A / P1-B, verbatim): provenance, not pattern ──
    { // P1-A: a CLIENT line that ends " (Recompensa)" — no redemption on the sibling → nothing is stripped → NOT the same cart
      const PA = `${AB} | 1x Extra dish (L99) (Recompensa)`;
      // each lookup with the X that reads it: canonical + legacy (persisted permutation), verbatim (no persisted keys → today's fallback)
      for (const [keyName, key, xKeys] of [['canonical', orderContentKey(args(BA)), undefined], ['legacy', orderContentKeyVerbatim(args(AB)), undefined], ['verbatim', orderContentKeyVerbatim(args(BA)), {}]]) {
        const x = order('X', BA, xKeys);
        const reads = []; const db0 = fakeDb({ [pathOf(key)]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/Y': sibY({ status: 'preparing' }, { items_text: PA }), 'orders/X': x });
        const db = { ref: (p) => { const r0 = db0.ref(p); return { ...r0, once: async (...q) => { reads.push(p); return r0.once(...q); } }; } };
        const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db }, 'X', x, 123));
        assert.ok(reads.includes('orders/Y'), `premise (${keyName}): the stamp was FOUND through this lookup (the sibling was read)`);
        assert.equal(r, false, `🔴 r5 P1-A (${keyName} lookup): a paid line ending "(Recompensa)" on a sibling with no redemption is NOT stripped → not held`);
        assert.ok(logs.some((l) => l.includes('"reason":"sibling_content_mismatch"')), `…logged (${keyName})`);
      } }
    { // P1-B: a reward display name with an unbalanced "[" — today (207170e) HOLDS; provenance strips exactly what was appended
      const PAID = '2x Carnivora (L340)', RB = ' | 1x Margherita [special (Recompensa)';
      const a1 = (t) => ({ phone: PHONE, itemsText: t, orderType: 'delivery', scheduledFor: null });
      const store = { [pathOf(orderContentKey(a1(PAID)))]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' },
        'orders/Y': sibY({ status: 'preparing', redemption: { model: 'add_free' }, reward_text_appended: RB }, { items_text: PAID + RB }),
        'orders/X': { ...orderX(), items_text: PAID, ...contentKeysRecord(a1(PAID), { menuNames: MENU }) } };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', store['orders/X'], 123), true, '🔴 r5 P1-B: online X + live cash Y with the same paid cart and a "[special" reward name → HELD (as on main)'); }
    { // a redeemed sibling written BEFORE this deploy (no provenance) cannot be verified → today's behaviour (held), LOGGED
      const store = { ...legacyStamp(`${AB}${RW}`), 'orders/X': order('X', BA) };
      Object.assign(store['orders/Y'], { redemption: { model: 'add_free' } });
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123));
      assert.equal(r, true, 'a pre-deploy redeemed sibling (no provenance) → today\'s behaviour: held');
      assert.ok(logs.some((l) => l.includes('duplicate_sibling_unverifiable') && l.includes('"reason":"no_reward_provenance"') && l.includes('"sibling_id":"Y"')), 'logged'); }
    { // provenance recorded but the text no longer ends with it → not the content that was stamped → not held, logged
      const store = { ...legacyStamp(`${AB} | 1x Otra (Recompensa)`), 'orders/X': order('X', BA) };
      Object.assign(store['orders/Y'], { redemption: { model: 'add_free' }, reward_text_appended: RW });
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA), 123));
      assert.equal(r, false, 'provenance that is not the text\'s suffix → not held'); assert.ok(logs.some((l) => l.includes('"reason":"sibling_content_mismatch"')), 'logged'); }
    { // r5 P2: a valid canonical key with NO permutation and no reason → an explicit, logged fallback
      const noOrder = { content_key: orderContentKey(args(BA)) };
      const store = { ...legacyStamp(), 'orders/X': order('X', BA, noOrder) };
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA, noOrder), 123));
      assert.equal(r, false, 'no permutation → the incoming verbatim key (the permuted legacy sibling is not found)');
      assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"X"') && l.includes('"reason":"legacy_order_absent"')), '🔴 r5 P2: logged legacy_order_absent');
      const withReason = { content_key: orderContentKey(args(BA)), content_key_legacy_reason: 'no_menu_snapshot' };
      const store2 = { ...legacyStamp(), 'orders/X': order('X', BA, withReason) };
      assert.ok((await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store2) }, 'X', order('X', BA, withReason), 123))).logs.some((l) => l.includes('"reason":"intake_no_menu_snapshot"')), 'an intake reason is carried into the guard\'s log'); }
    { // X's own reward lines are cut by X's provenance when its legacy key is rebuilt
      const XR = ' | 1x Margherita (Recompensa)'; const xk = { ...contentKeysRecord(args(BA + XR), { menuNames: MENU, suffix: XR }), reward_text_appended: XR };
      assert.deepStrictEqual(xk.content_legacy_order, [1, 0], 'the permutation covers the CLIENT lines only (provenance)');
      assert.strictEqual(legacyKeyByOrder(args(BA + XR), xk.content_legacy_order, XR), orderContentKeyVerbatim(args(AB + XR)), 'rebuilt: client lines in menu order, then exactly the appended text'); }
    { // …and the GUARD uses it: an incoming X that redeemed (its own provenance) finds a legacy stamp of the same full text in
      // menu order and holds — the rebuild must cut X's appended text exactly (else the permutation never fits X's lines)
      const XR = ' | 1x Margherita (Recompensa)';
      const xr = { ...order('X', BA + XR, {}), ...contentKeysRecord(args(BA + XR), { menuNames: MENU, suffix: XR }), reward_text_appended: XR };
      const store = { [pathOf(orderContentKeyVerbatim(args(AB + XR)))]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' },
        'orders/Y': sibY({ status: 'preparing' }, { items_text: AB + XR }), 'orders/X': xr };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', xr, 123), true, '🔴 r5: X\'s legacy key rebuilt from its client lines + its OWN provenance → the menu-order legacy stamp is found → held'); }
    ok('§3 r5: P1-A (a paid line ending "(Recompensa)", no redemption) → not held on canonical / legacy / verbatim, logged; P1-B ("[special" reward name, provenance) → HELD; pre-deploy redeemed sibling → today\'s behaviour, logged; stale provenance → not held; P2 legacy_order_absent / intake reason logged; X\'s own reward lines by provenance');

    // (b) a corrupted permutation can only cost a hold (today's behaviour, logged) — never name another order's content
    for (const [label, perm] of [['too short', [0]], ['duplicate index', [0, 0]], ['out of range', [0, 2]], ['not integers', ['1', '0']], ['not an array', 'xyz'], ['an index object of the wrong length', { 0: 1, 1: 0, 2: 2 }], ['a non-dense object', { 0: 1, 2: 0 }]]) {
      const bad = { ...keysOf(BA), content_legacy_order: perm };
      const store = { ...legacyStamp(), 'orders/X': order('X', BA, bad) };
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA, bad), 123));
      assert.equal(r, false, `🔴 permutation ${label} → today's behaviour: the permuted legacy sibling is not found`);
      assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"reason":"invalid_legacy_order"')), `…LOGGED invalid_legacy_order (${label})`);
    }
    { const dense = { ...keysOf(BA), content_legacy_order: { 0: 1, 1: 0 } };   // RTDB may hand an index array back as a dense object
      const store = { ...legacyStamp(), 'orders/X': order('X', BA, dense) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA, dense), 123), true, 'a dense {0:…,1:…} permutation is accepted'); }
    { const swapped = { ...keysOf(AB), content_legacy_order: [1, 0] };   // a VALID but wrong permutation: still this cart's own lines
      const store = { ...legacyStamp('1x Margherita (L250)'), [pathOf(orderContentKeyVerbatim(args(BA)))]: { at: Date.now(), order_id: 'Y', payment_method: 'cash' }, 'orders/X': order('X', AB, swapped) };
      assert.equal((await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB, swapped), 123))).r, false, 'a valid-but-wrong permutation names only this cart\'s lines; with an unrelated sibling behind it → still not held (verified)'); }
    ok('§3 r4 (b): an invalid persisted permutation (length / duplicate / range / type / shape) → today\'s behaviour, logged; dense RTDB object accepted; a wrong valid one can never cause a false hold');

    // no keys / stale keys / intake-unavailable legacy (r3, unchanged)
    { const store = { ...legacyStamp(), 'orders/X': order('X', AB, {}) };
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB, {}), 123));
      assert.equal(r, true, 'no persisted keys: a same-order legacy sibling is still found (incoming verbatim)');
      assert.ok(logs.some((l) => l.includes('"reason":"no_persisted_keys"') && l.includes('"order_id":"X"')), 'logged');
      const store2 = { ...legacyStamp(), 'orders/X': order('X', BA, {}) };
      assert.equal((await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store2) }, 'X', order('X', BA, {}), 123))).r, false, 'no keys + permuted → not found (the logged, bounded transition gap)'); }
    { const stale = keysOf('1x Margherita (L250)'); const store = { ...legacyStamp(), 'orders/X': order('X', BA, stale) };
      const { r, logs } = await quiet(() => holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', BA, stale), 123));
      assert.equal(r, false, 'stale keys → not trusted'); assert.ok(logs.some((l) => l.includes('"reason":"stale_persisted_keys"')), 'logged'); }
    { const logs = []; const k = contentKeysRecord(args(BA), { menuNames: null, orderId: 'X', log: (...a) => logs.push(a.join(' ')) });
      assert.deepStrictEqual(Object.keys(k).sort(), ['content_key', 'content_key_legacy_reason']); assert.strictEqual(k.content_key_legacy_reason, 'no_menu_snapshot');
      assert.ok(logs.some((l) => l.includes('content_key_legacy_unavailable') && l.includes('"order_id":"X"')), 'logged at intake');
      const kk = contentKeysRecord(args(AB), { menuNames: null, log: () => {} }); const store = { ...legacyStamp(), 'orders/X': order('X', AB, kk) };
      assert.equal(await holdIfDuplicateSibling({ db: fakeDb(store) }, 'X', order('X', AB, kk), 123), true, 'legacy unavailable at intake: a same-order sibling is still found (incoming verbatim)'); }
    { const seen = []; const db = { ref: (p) => ({ once: async () => { seen.push(p); return { val: () => null }; } }) };
      await holdIfDuplicateSibling({ db }, 'X', order('X', BA), 123);
      assert.deepStrictEqual(seen.sort(), [pathOf(orderContentKey(args(BA))), pathOf(orderContentKeyVerbatim(args(AB)))].sort(), 'reads exactly the canonical key and the REBUILT menu-order legacy key (no extra read)'); }
    ok('§3 r3: no keys → today\'s behaviour, logged; stale keys untrusted, logged; intake-unavailable legacy → incoming verbatim; exactly two reads');
  }

  console.log(`\nf3-duplicate-decision.test.js: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
