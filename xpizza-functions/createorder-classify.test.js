'use strict';
// Unit tests for createorder-classify.js — the pure classifier + the read-only fingerprint recompute.
// Run: node createorder-classify.test.js
const assert = require('assert');
const { classifyExistingOrder, computeIncomingFingerprint } = require('./createorder-classify');
const { orderFingerprint } = require('./pixelpay-charge');
const { orderBreakdownCents } = require('./order-money');
const { isStatusChangeClosedToAutomation } = require('./manual-resolve');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const deps = { isPaymentStatusClosed: isStatusChangeClosedToAutomation };
const live = (over = {}) => ({ restaurant_id: 'la_musa', payment_method: 'cash', status: 'new', payment_status: 'pending', ...over });

// ── classifyExistingOrder (pure) ─────────────────────────────────────────────
{
  // case 5 — genuine live same-order retry
  assert.deepEqual(classifyExistingOrder(live(), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '200' });
  ok('same method + live + no fp → 200');

  // case 1 — different restaurant
  assert.deepEqual(classifyExistingOrder(live(), { paymentMethod: 'cash', restaurantMatches: false }, null, deps), { action: '409', reason: 'restaurant' });
  ok('different restaurant → 409 restaurant');

  // case 2 — Miguel: existing online, incoming cash
  assert.deepEqual(classifyExistingOrder(live({ payment_method: 'online', status: 'pending_payment' }), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '409', reason: 'method' });
  ok('existing online, incoming cash → 409 method (Miguel)');

  // case 3 — terminal by status (same method so it's the STATUS axis under test, not case 2)
  for (const st of ['cancelled', 'delivered', 'completed', 'pending_payment']) {
    assert.deepEqual(classifyExistingOrder(live({ status: st }), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '409', reason: 'closed' }, `status ${st}`);
  }
  ok('status cancelled/delivered/completed/pending_payment → 409 closed');

  // case 3 — terminal by payment_status (∈ AUTOMATION_CLOSED_TERMINAL)
  for (const ps of ['refunded', 'abandoned', 'manual_reconciliation', 'confirmed', 'failed']) {
    assert.deepEqual(classifyExistingOrder(live({ payment_status: ps }), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '409', reason: 'closed' }, `payment_status ${ps}`);
  }
  ok('payment_status refunded/abandoned/manual_reconciliation/confirmed/failed → 409 closed');

  // live payment_status must NOT be closed
  assert.deepEqual(classifyExistingOrder(live({ payment_status: 'pending' }), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '200' });
  ok('payment_status pending (live cash) → 200');

  // case 4 — content mismatch
  assert.deepEqual(classifyExistingOrder(live({ payment_fingerprint: 'AAA' }), { paymentMethod: 'cash', restaurantMatches: true }, 'BBB', deps), { action: '409', reason: 'cart' });
  ok('fp present + incoming differs → 409 cart');
  // case 4 — content match
  assert.deepEqual(classifyExistingOrder(live({ payment_fingerprint: 'AAA' }), { paymentMethod: 'cash', restaurantMatches: true }, 'AAA', deps), { action: '200' });
  ok('fp present + incoming matches → 200');
  // legacy (no stored fp) → skip content → 200 even with an incoming fp
  assert.deepEqual(classifyExistingOrder(live(), { paymentMethod: 'cash', restaurantMatches: true }, 'BBB', deps), { action: '200' });
  ok('legacy order w/o stored fp → content skipped → 200');
  // incoming fp null (fail-open recompute) + stored fp present → skip content → 200
  assert.deepEqual(classifyExistingOrder(live({ payment_fingerprint: 'AAA' }), { paymentMethod: 'cash', restaurantMatches: true }, null, deps), { action: '200' });
  ok('incoming fp null (fail-open) → content skipped → 200');
}

// ── computeIncomingFingerprint (read-only) ───────────────────────────────────
const fpDeps = (over = {}) => ({ orderBreakdownCents, orderFingerprint, schedFingerprintExtra: (f) => (f && Number.isFinite(f.scheduled_for)) ? `${f.scheduled_for}|${f.order_type || ''}` : '', db: {}, prepareRedemption: async () => ({ ok: false }), ...over });

(async () => {
  const base = { orderId: 'PZX-1', restaurantId: 'la_musa', total: 500, itemsText: '1x Pad Thai (L500)', items: [], redeem: null, customerUid: null, scheduledForRaw: null, orderType: 'delivery' };

  // non-redemption: deterministic + equals the canonical orderFingerprint(orderId, breakdown.total_cents, items_text, '')
  const fp1 = await computeIncomingFingerprint(base, fpDeps());
  const expected = orderFingerprint('PZX-1', orderBreakdownCents(500, 'la_musa').total_cents, '1x Pad Thai (L500)', '');
  assert.equal(fp1, expected);
  ok('non-redeem fp == canonical orderFingerprint(total_cents, items_text)');

  // store == compare: same inputs recompute an IDENTICAL fp (the drift-proof invariant)
  const fp2 = await computeIncomingFingerprint(base, fpDeps());
  assert.equal(fp1, fp2);
  ok('store==compare: identical inputs → identical fp (no drift → no double-order)');

  // a changed cart → different fp (case-4 trigger source)
  const fp3 = await computeIncomingFingerprint({ ...base, total: 900, itemsText: '2x Pad Thai (L900)' }, fpDeps());
  assert.notEqual(fp1, fp3);
  ok('changed cart → different fp');

  // scheduled binds the slot into the extra
  const fpSched = await computeIncomingFingerprint({ ...base, scheduledForRaw: 1787000000000 }, fpDeps());
  const fpSchedExpected = orderFingerprint('PZX-1', orderBreakdownCents(500, 'la_musa').total_cents, '1x Pad Thai (L500)', '1787000000000|delivery');
  assert.equal(fpSched, fpSchedExpected);
  assert.notEqual(fpSched, fp1);
  ok('scheduled-cash fp binds the slot (extra exercised)');

  // redemption: uses prepareRedemption (read-only) priced total + appended items_text + rf:<hash>
  const redeemDeps = fpDeps({ prepareRedemption: async () => ({ ok: true, priced: { total_cents: 30000 }, itemsText: '1x Pad Thai (L500) | 1x Postre (Recompensa)', redemptionFp: 'SET9' }) });
  const fpRedeem = await computeIncomingFingerprint({ ...base, redeem: { r: 1 }, customerUid: 'u1' }, redeemDeps);
  const fpRedeemExpected = orderFingerprint('PZX-1', 30000, '1x Pad Thai (L500) | 1x Postre (Recompensa)', 'rf:SET9');
  assert.equal(fpRedeem, fpRedeemExpected);
  ok('redemption-cash fp uses prepared priced total + appended items_text + rf:<set> (extra exercised)');

  // FAIL-OPEN: prepareRedemption not ok → null (caller skips case 4, returns 200)
  const fpFailPrep = await computeIncomingFingerprint({ ...base, redeem: { r: 1 } }, fpDeps({ prepareRedemption: async () => ({ ok: false, status: 409 }) }));
  assert.equal(fpFailPrep, null);
  ok('redeem prepare !ok → null (fail-open)');

  // FAIL-OPEN: prepareRedemption throws → null
  const fpThrow = await computeIncomingFingerprint({ ...base, redeem: { r: 1 } }, fpDeps({ prepareRedemption: async () => { throw new Error('points read failed'); } }));
  assert.equal(fpThrow, null);
  ok('recompute throws → null (fail-open)');

  console.log(`\ncreateorder-classify.test.js: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
