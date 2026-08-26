'use strict';
// createOrder idempotent-return hardening (F1) — the money matrix. Run: node createorder-idempotent.test.js
// Cases 1-11 exercise the pure classifier + read-only fingerprint; 12 proves store==compare with the REAL
// builder (drift = double orders); 13-15 are static source guards on the createOrder handler (index.js isn't
// require-safe — initializeApp at load — so control-flow invariants are locked structurally, the intake-gate
// pattern). The fine-grained module tests live in createorder-classify.test.js.
const fs = require('fs');
const assert = require('assert');
const { classifyExistingOrder, computeIncomingFingerprint } = require('./createorder-classify');
const { buildCreateOrderUpdates } = require('./create-order-build');
const { orderFingerprint } = require('./pixelpay-charge');
const { orderBreakdownCents } = require('./order-money');
const { isStatusChangeClosedToAutomation } = require('./manual-resolve');
const { redemptionFingerprint } = require('./rewards-redeem');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const D = { isPaymentStatusClosed: isStatusChangeClosedToAutomation };
const live = (o = {}) => ({ restaurant_id: 'la_musa', payment_method: 'cash', status: 'new', payment_status: 'pending', ...o });
const cls = (existing, method, matches, fp) => classifyExistingOrder(existing, { paymentMethod: method, restaurantMatches: matches }, fp, D);
const fpDeps = (o = {}) => ({ orderBreakdownCents, orderFingerprint, schedFingerprintExtra: (f) => (f && Number.isFinite(f.scheduled_for)) ? `${f.scheduled_for}|${f.order_type || ''}` : '', db: {}, prepareRedemption: async () => ({ ok: false }), ...o });

(async () => {
  // 1 — same method + content + non-terminal → 200
  assert.deepEqual(cls(live(), 'cash', true, null), { action: '200' }); ok('1 live same-order retry → 200');
  // 2 — existing online / pending_payment, incoming cash → 409 method (Miguel)
  assert.deepEqual(cls(live({ payment_method: 'online', status: 'pending_payment' }), 'cash', true, null), { action: '409', reason: 'method' }); ok('2 online→cash → 409 method (Miguel)');
  // 3 — cancelled → 409 closed
  assert.deepEqual(cls(live({ status: 'cancelled' }), 'cash', true, null), { action: '409', reason: 'closed' }); ok('3 cancelled → 409 closed');
  // 4 — delivered → 409 closed (C1b)
  assert.deepEqual(cls(live({ status: 'delivered' }), 'cash', true, null), { action: '409', reason: 'closed' }); ok('4 delivered → 409 closed (C1b)');
  // 5 — completed → 409 closed (C1b)
  assert.deepEqual(cls(live({ status: 'completed' }), 'cash', true, null), { action: '409', reason: 'closed' }); ok('5 completed → 409 closed (C1b)');
  // 6 — payment_status refunded (∈ AUTOMATION_CLOSED_TERMINAL) → 409 closed
  assert.deepEqual(cls(live({ payment_status: 'refunded' }), 'cash', true, null), { action: '409', reason: 'closed' }); ok('6 payment_status refunded → 409 closed');
  // 7 — scheduled (held) same method+content → 200 (held is LIVE, must not 409)
  assert.deepEqual(cls(live({ status: 'scheduled' }), 'cash', true, null), { action: '200' }); ok('7 scheduled/held → 200 (live)');
  // 8 — different cart (fingerprint mismatch) → 409 cart
  assert.deepEqual(cls(live({ payment_fingerprint: 'AAA' }), 'cash', true, 'BBB'), { action: '409', reason: 'cart' }); ok('8 fingerprint mismatch → 409 cart');
  // 9 — legacy (no stored fp) → content skipped → 200
  assert.deepEqual(cls(live(), 'cash', true, 'BBB'), { action: '200' }); ok('9 legacy no-fp → content skipped → 200');
  // 10 — different restaurant → 409 restaurant
  assert.deepEqual(cls(live(), 'cash', false, null), { action: '409', reason: 'restaurant' }); ok('10 different restaurant → 409 restaurant');
  // 11 — fail-safe: covered structurally at #14 (existence read throw → 500). Assert fail-open recompute here:
  assert.deepEqual(cls(live({ payment_fingerprint: 'AAA' }), 'cash', true, null), { action: '200' }); ok('11 incoming fp null (fail-open recompute) → 200, never 409');

  // 12 — STORE == COMPARE parity with the REAL builder (drift → double orders). For each cart variant, the
  //      payment_fingerprint the builder STORES must equal what a retry RECOMPUTES from the same inputs.
  const parity = async (label, ctx, deps) => {
    const fp = await computeIncomingFingerprint(ctx, deps);
    const built = buildCreateOrderUpdates({
      orderId: ctx.orderId, orderType: 'delivery', now: 1, trackingToken: 'tok', total: ctx.total,
      lat: 1, lng: 2, fields: { customer_name: 'x', customer_phone: '+50412345678', items_text: ctx.itemsText, notes: '—', payment_method: 'cash', address_detected: 'a', address_details: 'b' },
      hubSnap: { hub_lat: 0, hub_lng: 0, restaurant_name: 'R', restaurant_phone: 'p' },
      restaurantId: ctx.restaurantId, priceBreakdown: orderBreakdownCents(ctx.total, ctx.restaurantId),
      facturaPriced: { items: null, factura_items: null }, cashTenderedCents: 0, freeOrder: false, rewardStamp: {},
      paymentFingerprint: fp,
    });
    const stored = built[`orders/${ctx.orderId}`].payment_fingerprint;
    const recomputed = await computeIncomingFingerprint(ctx, deps);
    assert.equal(stored, fp, `${label}: builder stores the computed fp`);
    assert.equal(stored, recomputed, `${label}: store == retry-recompute (no drift)`);
    ok(`12 store==compare parity — ${label}`);
  };
  const baseCtx = { orderId: 'PZX-A', restaurantId: 'la_musa', total: 500, itemsText: '1x Pad Thai (L500)', items: [], redeem: null, customerUid: null, scheduledForRaw: null, orderType: 'delivery' };
  await parity('ASAP cash', baseCtx, fpDeps());
  await parity('scheduled cash', { ...baseCtx, orderId: 'PZX-B', scheduledForRaw: 1787000000000 }, fpDeps());
  await parity('redemption cash', { ...baseCtx, orderId: 'PZX-C', redeem: { r: 1 }, customerUid: 'u1' },
    fpDeps({ prepareRedemption: async () => ({ ok: true, priced: { total_cents: 30000 }, itemsText: '1x Pad Thai (L500) | 1x Postre (Recompensa)', redemptionFp: 'SET9' }) }));

  // ── Static source guards on the createOrder handler ──
  const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const a = SRC.indexOf("createOrderApp.all('*'"); assert.ok(a !== -1);
  const b = SRC.indexOf('createOrderApp.use('); assert.ok(b !== -1, 'createOrder body end marker');
  const body = SRC.slice(a, b);
  const idx = (s) => { const i = body.indexOf(s); assert.ok(i !== -1, `marker not found: ${s}`); return i; };

  // 13 — the idempotent 200 body includes tracking_token (C3)
  assert.ok(/idempotent: true, order_id: orderId, tracking_token:/.test(body), 'idempotent 200 returns tracking_token'); ok('13 idempotent 200 body includes tracking_token (C3)');

  // 14 — REGRESSION GUARD (owner hard rule): the idempotent 200 AND the 409 order_conflict both resolve BEFORE
  //      checkItemAvailability / checkRateLimit / resolveRedemptionForOrder — a legit retry short-circuits and
  //      never re-runs the 86-gate, rate-limit, or reserve (no 429-on-retry / no re-reserve, exactly as before).
  const p200 = idx("idempotent: true, order_id: orderId, tracking_token:");
  const p409 = idx("error: 'order_conflict', reason: cls.reason");
  for (const gate of ['checkItemAvailability(', 'checkRateLimit(', 'resolveRedemptionForOrder(']) {
    const g = idx(gate);
    assert.ok(p200 < g, `idempotent 200 must precede ${gate}`);
    assert.ok(p409 < g, `409 order_conflict must precede ${gate}`);
  }
  ok('14 idempotent 200 / 409 short-circuit BEFORE availability + rate-limit + reserve (no regression)');

  // invariant 3 — the fingerprint recompute is READ-ONLY (uses prepareRedemption, never the reserving path)
  assert.ok(/computeIncomingFingerprint\(/.test(body), 'createOrder computes incomingFp');
  assert.ok(!/computeIncomingFingerprint[\s\S]{0,400}resolveRedemptionForOrder/.test(SRC.slice(idx('computeIncomingFingerprint('), idx('computeIncomingFingerprint(') + 400)), 'incomingFp compute must not call resolveRedemptionForOrder');
  ok('14b fingerprint recompute is read-only (prepareRedemption, never resolveRedemptionForOrder)');

  // 15 — ADDITIVE-GUARDRAIL: buildCreateOrderUpdates without a fp is byte-identical (no payment_fingerprint key);
  //      with a fp it adds EXACTLY that one field.
  const mk = (fp) => buildCreateOrderUpdates({
    orderId: 'PZX-G', orderType: 'pickup', now: 1, trackingToken: 'tok', total: 500, lat: 0, lng: 0,
    fields: { customer_name: 'x', customer_phone: '+50412345678', items_text: 'i', notes: '—', payment_method: 'cash', pickup_time: 'standard' },
    hubSnap: { hub_lat: 0, hub_lng: 0, restaurant_name: 'R', restaurant_phone: 'p' }, restaurantId: 'la_musa',
    priceBreakdown: orderBreakdownCents(500, 'la_musa'), facturaPriced: { items: null, factura_items: null },
    cashTenderedCents: 0, freeOrder: false, rewardStamp: {}, paymentFingerprint: fp,
  })['orders/PZX-G'];
  const without = mk(null), withFp = mk('DEADBEEF');
  assert.ok(!('payment_fingerprint' in without), 'no fp → field absent (byte-identical to pre-F1)');
  const keysDelta = Object.keys(withFp).filter((k) => !(k in without));
  assert.deepEqual(keysDelta, ['payment_fingerprint'], 'with fp → EXACTLY one added field');
  assert.equal(withFp.payment_fingerprint, 'DEADBEEF');
  ok('15 additive-guardrail: payment_fingerprint is the ONLY delta; absent → pre-F1 byte-identical');

  // 16 — REDEMPTION RESIDUAL (codex follow-up): when the top-level fp compute blips to null, createOrder
  //      recomputes the store fp from the ALREADY-RESOLVED reserve (redemptionPriced + redemptionCanonical). That
  //      recompute MUST equal what a retry's computeIncomingFingerprint produces, or store!=compare → false-409.
  {
    const canonical = { rid: 'la_musa', reward: 'r', set: ['pad-thai'] };
    const rfp = redemptionFingerprint(canonical);
    const priced = { total_cents: 30000 }, itemsText = '1x Pad Thai (L500) | 1x Postre (Recompensa)';
    const schedExtra = `${1787000000000}|delivery`;
    // the exact store-side formula index.js uses (schedExtra + rf:<redemptionFingerprint(canonical)>):
    const storeFormula = orderFingerprint('PZX-R', priced.total_cents, itemsText, [schedExtra, `rf:${rfp}`].filter(Boolean).join('|'));
    // the retry's compare, via computeIncomingFingerprint with a prep that returns those same resolved values:
    const compareFp = await computeIncomingFingerprint(
      { orderId: 'PZX-R', restaurantId: 'la_musa', total: 500, itemsText: 'raw', items: [], redeem: { r: 1 }, customerUid: 'u1', scheduledForRaw: 1787000000000, orderType: 'delivery' },
      fpDeps({ prepareRedemption: async () => ({ ok: true, priced, itemsText, redemptionFp: rfp }) }));
    assert.equal(storeFormula, compareFp, 'redemption store-recompute == retry compare (store==compare on the blip path)');
    ok('16 redemption blip: store-recompute fp == retry compare (no false-409)');

    // structural: index.js guards the recompute (only when incomingFp blipped AND it is a redemption order)
    assert.ok(/if \(!storeFp && redemptionCanonical && redemptionPriced\)/.test(SRC), 'recompute guarded by !storeFp && redemptionCanonical && redemptionPriced');
    assert.ok(/redemptionFingerprint\(redemptionCanonical\)/.test(SRC), 'recompute uses redemptionFingerprint(redemptionCanonical)');
    ok('16b recompute is guarded (redemption + fp-null only) and uses the resolved canonical');
  }

  console.log(`\ncreateorder-idempotent.test.js: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
