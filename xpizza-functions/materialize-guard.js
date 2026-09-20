'use strict';

/**
 * Materialize-time closed-kitchen guard (Scheduled Orders / Codex-on-diff on scheduled-checkout-ux).
 *
 * The intake guard (SCHED.asapWhileClosed in createOrder/chargeOnlineOrder) checks open-hours when an
 * online checkout is OPENED. But an online order is authorized at checkout and materializes LATER at
 * payment confirmation — a customer who opens checkout at 8:40pm (open) and pays at 8:50pm (past an
 * 8:45pm close) would otherwise land a live ASAP order on a dark kitchen.
 *
 * This is the shared re-check at the two materialize chokepoints (confirmAndMaterialize — which the
 * hosted webhook + materializeOnConfirm recovery both delegate to — and confirmAndMaterializeFrom
 * ManualClaim). For an UNSCHEDULED (ASAP) order it re-reads current hours and: OPEN or within the
 * post-close GRACE (config close + config/order_grace_minutes) → materialize normally; PAST the real
 * kitchen close → AUTO-REFUND the captured payment (pre-materialization → no factura → no fiscal void),
 * never land a live ASAP order on a dark kitchen. Refund-failure is split by cause (refund_pending →
 * reconciler owns it; hard-fail → manual_reconciliation), never a false "refunded". Returns true iff the
 * caller must NOT materialize (held / refunded / refund_pending / manual_reconciliation).
 *
 * Scheduled orders are untouched (they take their own hold path before reaching here). A config outage →
 * materialize (return false): captured money is NEVER stranded over a config blip, mirroring the shipped
 * inactive-restaurant post-capture posture. Returns true iff the order was held (caller must NOT materialize).
 */
const SCHED = require('./scheduled-orders');
const { orderContentKey, rateLimitKey } = require('./order-dedup');   // F3 — resolve the SAME content-stamp path createOrder/chargeOnlineOrder write

/* 🔴 Can THIS caller reverse a payment at all? voidOrRefund is the one dep the guard calls without
   checking first, so its absence is the difference between "refunds" and "throws mid-refund". Checked
   as a callable, not a presence: null, 0 or a stray object would pass a presence test and still throw. */
function canAutoRefund(deps) {
  return typeof (deps || {}).voidOrRefund === 'function';
}

/* 🔴 WOULD THIS ORDER NEED A PAID-AFTER-CLOSE REVERSAL? Extracted from the guard's own head so there
   is ONE implementation, because it is now asked from two places: the guard, and — before it touches
   anything — the dispatcher path, which must know whether it is heading for a refund it cannot
   perform BEFORE it claims the order, stamps the attempt captured and commits `confirmed`.
   Returns false for every legitimate non-refund outcome (scheduled, already resolved, open kitchen,
   within grace, config outage) so a caller that only reaches those is never parked. */
async function needsPaidAfterCloseRefund(deps, order, now) {
  if (Number.isFinite(Number(order && order.scheduled_for))) return false;   // scheduled holds via its own path
  if (!deps || !deps.getIdentity) return false;                              // no config reader → cannot re-check
  if (order && (order.payment_status === 'refunded' || order.status === 'cancelled' || order.materialized_at)) return false;

  const rid = (order && order.restaurant_id) || 'x_pizza';
  let hours;
  try { hours = (await deps.getIdentity(deps.db, rid)).hours; }
  catch (_) { return false; }   // config outage → materialize (never strand captured money over a blip)

  const graceMin = deps.getGraceMinutes ? await deps.getGraceMinutes(deps.db) : 15;
  return !SCHED.isWithinGrace(hours, now, graceMin);
}

/* 🔴 THE PARK IS A CONDITIONAL WRITE, NEVER AN UNCONDITIONAL ONE. An unconditional update could land
   on an order whose payment is already in flight — automatic recovery reaching
   refunding_paid_after_close with the attempt `reversing` and a provider call outstanding — and
   overwriting that to manual_reconciliation re-offers it to the dispatcher, whose Reembolsar issues a
   SECOND provider call outside the attempt CAS. So the park only writes from the state it expects to
   find, and reports whether it actually landed and whether it CHANGED anything (so the alert fires
   once per park rather than on every repeat). */
async function parkForManualRefund(deps, orderId, now) {
  let landed = false;
  let alreadyParked = false;
  const tx = await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
    landed = false; alreadyParked = false;
    if (cur === null) return null;                                   // null-first-safe
    if (!cur) return;                                                // gone → nothing to park
    /* 🔴 BOTH STATES A PARKABLE ORDER CAN BE IN, and the second one is a defect I called unreachable.
       There are TWO hours lookups on this path: the early one, before the claim, and the guard's own,
       after the attempt has been stamped captured and the order committed `confirmed`. If the early
       lookup THROWS, or the kitchen's hours change between them, only the guard sees "closed" — and
       with the conditional accepting manual_reconciliation alone, the park refused the now-confirmed
       order and the guard still answered "held": HTTP 200, no park, no alert, a captured attempt and
       an unmaterialized confirmed order, eligible for automatic recovery.
       `confirmed` is not an in-flight refund; it is the state this path just created. What must never
       be overwritten is a reversal already running, which is refunding_paid_after_close and anything
       terminal — and those are still refused. */
    if (cur.payment_status !== 'manual_reconciliation' && cur.payment_status !== 'confirmed') return;
    if (cur.blocked_reason === PARK_REASON) { alreadyParked = true; return; }   // already parked → no write, no re-alert
    landed = true;
    /* A confirmed order is moved back to manual_reconciliation — leaving it `confirmed` with captured
       money and no food is the exact state this branch exists to prevent. An order already in
       manual_reconciliation keeps that status and only gains the reason. */
    return { ...cur, payment_status: 'manual_reconciliation', blocked_reason: PARK_REASON, manual_refund_required_at: now };
  });
  return { landed: !!(tx.committed && landed), alreadyParked };
}

const PARK_REASON = 'manual_refund_required_paid_after_close';
const PARK_ALERT = 'paid_after_close_manual_refund_required';
const PARK_ACTION = 'Reembolsar el pedido desde la cola de Pedidos — el reembolso automático no está disponible en esta ruta';

async function holdIfClosedAtMaterialize(deps, orderId, order, now) {
  if (Number.isFinite(Number(order && order.scheduled_for))) return false;
  if (!deps || !deps.getIdentity) return false;
  // Idempotent re-entry: a prior pass already resolved this order (refunded / cancelled / materialized). (E)
  if (order && (order.payment_status === 'refunded' || order.status === 'cancelled' || order.materialized_at)) return true;

  const rid = (order && order.restaurant_id) || 'x_pizza';
  if (!(await needsPaidAfterCloseRefund(deps, order, now))) return false;   // open, within grace, or unknowable → materialize

  /* 🔴 A CALLER THAT CANNOT REFUND MUST SAY SO, NOT DISCOVER IT MID-REFUND. Below this line the guard
     commits to reversing a payment, and it calls deps.voidOrRefund UNGUARDED while checking every
     other optional dep first. A caller wired without it therefore threw a TypeError that the catch
     two steps later reported as if the provider had failed: the order came to rest blocked with
     refund_failed_paid_after_close, an alert said the refund had failed, and PixelPay was never
     contacted. index.js's resolveDeps — the dispatcher path — has been exactly that caller for as
     long as this guard has existed.
     This does NOT make that path refund. It makes it fail HONESTLY: the order is parked for a human
     with a reason that names what they must do, before any state changes, and no money moves. The
     confirm path, which is fully wired, is untouched and still auto-refunds.
     Checked here rather than at the top of the function because everything above is a legitimate
     non-refund outcome — a scheduled order, an already-resolved one, an open kitchen, a config
     outage — and callers that only ever reach those genuinely do not need refund wiring. */
  /* 🔴 DEFENCE IN DEPTH — AND, SINCE THE ROUND THAT MADE IT REACHABLE, COVERED. An earlier version of
     this note said no cell reaches this branch and that its mutant had been deleted. Both were true
     when they were written; neither is true at HEAD, and the note outlived the code it described.
     What is true now: the dispatcher cell in test/resolve-manual.emulator.test.js drives exactly this
     path — resolveDeps supplies no voidOrRefund, so canAutoRefund is false and parking is what
     happens — and the two hours-lookup cells reach the park holding an order this path has just
     committed `confirmed`, which is the case pah-02 covers (restored after I deleted it as
     unreachable, which it was not).
     What the branch is FOR has not changed, which is why this is corrected rather than deleted:
     reaching this point means the guard is about to reverse a payment, and a caller wired the way
     resolveDeps was would otherwise crash mid-refund and have the catch two steps later blame the
     provider — the exact failure this commit exists to end. */
  if (!canAutoRefund(deps)) {
    const { landed } = await parkForManualRefund(deps, orderId, now);
    if (landed && deps.alert) {
      try { await deps.alert(PARK_ALERT, { orderId, restaurant_id: rid, order_id: orderId, missing: ['voidOrRefund'], action: PARK_ACTION }); } catch (_) {}
    }
    return true;   // held, not materialized, not refunded — a human owns it now
  }

  // Past the REAL kitchen close → AUTO-REFUND. The order is pre-materialization (a materialized order
  // returns above / at the caller's materialized_at check) → NO factura was issued → no fiscal void.
  // CAS refund claim so two concurrent guard passes can NEVER double-refund/double-message: ONLY the pass
  // that transitions confirmed→refunding_paid_after_close proceeds (didClaim); every other pass no-ops.
  const orderRef = deps.db.ref(`orders/${orderId}`);
  let didClaim = false;
  const claim = await orderRef.transaction((cur) => {
    didClaim = false;
    const o = cur || order;
    if (!o) return o;
    if (o.payment_status === 'refunded' || o.status === 'cancelled' || o.materialized_at) return o; // already resolved (lost the race)
    if (o.payment_status === 'refunding_paid_after_close') return o;                                 // another pass owns the refund
    if (o.payment_status !== 'confirmed') return o;                                                  // REVISE-4: only claim a CONFIRMED order (defensive — the guard runs post-confirm)
    didClaim = true;
    return { ...o, payment_status: 'refunding_paid_after_close', refunding_at: now };
  });
  if (!claim.committed || !didClaim) return true;   // lost / not-confirmed / other-owned / already-resolved → no-op

  const attemptId = order && order.active_attempt_id;
  // The captured payment's uuid — voidOrRefund needs it to ACTUALLY reverse the capture. A FALSY uuid makes
  // voidOrRefund take the "no payment to void" branch (voided:true) → it would mark the order refunded WITHOUT
  // refunding the customer (money-loss). Every real caller passes the attempt's payment_uuid; mirror that.
  let paymentUuid = null;
  try { paymentUuid = (await deps.db.ref(`payment_attempts/${attemptId}/payment_uuid`).once('value')).val() || null; } catch (_) {}

  // REVISE-1: missing uuid → NO reversal is/was attempted → route to manual_reconciliation (dispatcher-resolvable
  // in the existing panel; the resolver's no-uuid branch converges honestly). No reversal in flight ⇒ no race
  // with the hourly refundReconciler (which only re-drives refund_pending / stale reversing attempts).
  if (!paymentUuid) {
    await orderRef.update({ payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_failed_paid_after_close', { orderId, restaurant_id: rid, reason: 'no_payment_uuid' }); } catch (_) {} }
    return true;
  }

  let rref = null, threw = null;
  try {
    rref = await deps.voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId: `${orderId}-${attemptId}`, paymentUuid, reason: 'paid_after_close', now });
  } catch (e) { threw = e; }

  // CONFIRMED reversal (voided===true) → refund the customer. (An order-update throw here leaves the order at
  // refunding_paid_after_close; the item-5 stale-recovery sweep re-reads the attempt and finalizes it.)
  if (!threw && rref && rref.voided === true) {
    await orderRef.update({
      payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close',
      refunded_at: now, refund_ref: (rref && rref.ref) || rref.outcome || null,
    });
    if (deps.releaseRewardHold) { try { await deps.releaseRewardHold(deps.db, { orderId, order, now }); } catch (_) {} }   // exact cancel-path reverseRedemptionForOrder('refund'); idempotent, no-op for non-redeemed
    try { await deps.db.ref('paid_after_close_audit').push({ order_id: orderId, restaurant_id: rid, actor: 'system:paid_after_close', at: now, outcome: 'refunded' }); } catch (_) {}
    if (deps.sendPaidAfterCloseRefund) { try { await deps.sendPaidAfterCloseRefund(deps.db, { orderId, order }); } catch (_) {} }   // customer message ONLY after a confirmed refund
    return true;
  }

  // REVERSAL NOT CONFIRMED — split by whether a reversal is IN FLIGHT (owned by the hourly refundReconciler,
  // which re-drives an attempt in refund_pending / stale reversing via voidOrRefund's attempt-CAS). Re-read the
  // attempt: voided===false ⇒ voidOrRefund set it refund_pending; a throw may have left it reversing or untouched.
  let attemptStatus = null;
  try { attemptStatus = (await deps.db.ref(`payment_attempts/${attemptId}/status`).once('value')).val(); } catch (_) {}
  if (attemptStatus === 'refund_pending' || attemptStatus === 'reversing') {
    // REVISE-1: reversal IN FLIGHT → the reconciler finishes it (idempotent). Do NOT expose a manual button —
    // a direct manual void (resolve-manual.js) bypasses the attempt-CAS → double-refund. refund_pending sentinel.
    await orderRef.update({ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_pending_paid_after_close', { orderId, restaurant_id: rid, error: threw && threw.message }); } catch (_) {} }
  } else {
    // No reversal in flight (threw before the reversal CAS) → dispatcher-resolvable. SAFE: the reconciler ignores
    // this attempt (not refund_pending/reversing), so the resolver's direct void is the SOLE reversal — no race.
    await orderRef.update({ payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_failed_paid_after_close', { orderId, restaurant_id: rid, error: threw && threw.message }); } catch (_) {} }
  }
  return true;   // held / refunded / refund_pending / manual_reconciliation — caller must NOT materialize
}

// REVISE-5/-2: stale-recovery decision for a paid-after-close order whose ORDER outcome is hanging — either
//   (a) stuck at 'refunding_paid_after_close' (a crash between voidOrRefund and the order-update), OR
//   (b) parked at payment_status:'refund_pending' + blocked_reason:'refund_pending_paid_after_close' (the
//       reversal was in flight; the hourly reconciler re-drives the ATTEMPT to terminal, but nothing else
//       finalizes the ORDER → refunded-but-silent).
// PURE — the sweep (refundReconciler) re-reads the attempt and applies this. Money is always safe (the
// attempt's own CAS/idempotency); this closes the ORDER/customer outcome. Both states carry refunding_at.
//   attempt refunded/voided → finalize_refunded (complete the order + customer message — fires once);
//   attempt refund_pending/reversing → refund_pending (reconciler still owns it — leave as-is);
//   else (captured / gone) → manual_reconciliation (no reversal in flight → dispatcher-resolvable).
// Fresh (< staleMs since refunding_at) or not a paid-after-close hanging order → none.
function recoverRefundingDecision(order, attempt, now, staleMs) {
  if (!order) return { action: 'none' };
  const isRefunding = order.payment_status === 'refunding_paid_after_close';
  const isRefundPending = order.payment_status === 'refund_pending' && order.blocked_reason === 'refund_pending_paid_after_close';
  if (!isRefunding && !isRefundPending) return { action: 'none' };
  if ((now - (Number(order.refunding_at) || 0)) < staleMs) return { action: 'none' };
  const st = attempt && attempt.status;
  if (st === 'refunded' || st === 'voided') return { action: 'finalize_refunded' };
  if (st === 'refund_pending' || st === 'reversing') return { action: 'refund_pending' };
  return { action: 'manual_reconciliation' };
}

// ── F3: double-order guard (late online confirm collides with a live cash sibling) ──────────────────────────
// A statuses-set for "this sibling order is NOT live" — a materialized cash order on the KDS is live; a
// cancelled/finished one is not a collision (X may materialize).
const SIBLING_TERMINAL = new Set(['cancelled', 'delivered', 'completed']);

// PURE collision decision, shared by the materialize-side HOLD (siblingMethod='cash') and the create-side ALERT
// (siblingMethod='online'). A collision iff the content-key stamp holds a DIFFERENT order (≠ self) of the
// expected payment method whose point-read shows it currently LIVE. **PIN 1: deliberately independent of
// stamp.at / the 2-min freshness window** — a late confirm's window is the 45-min hosted TTL, so Y's LIVENESS is
// the truth, not the stamp's recency. `stamp` = { at, order_id, payment_method } | null; `siblingOrder` = the
// point-read orders/{stamp.order_id} | null.
function duplicateSiblingDecision(orderId, stamp, siblingOrder, siblingMethod) {
  if (!stamp || !stamp.order_id || stamp.order_id === orderId) return { collision: false };
  if (stamp.payment_method !== siblingMethod) return { collision: false };
  if (!siblingOrder || SIBLING_TERMINAL.has(siblingOrder.status)) return { collision: false };
  return { collision: true, siblingOrderId: stamp.order_id };
}

// Materialize-side PRIMARY guard: if this online order X would materialize while a live CASH sibling Y (same
// customer + same cart content) is already on the KDS, HOLD X for the dispatcher (manual_reconciliation →
// Reconciliación panel) instead of landing a duplicate. NEVER auto-refund (X's captured money stays put for a
// human), NEVER double-cook. Returns true iff the caller must NOT materialize. FAIL-OPEN: any error →
// materialize normally (a catchable double-cook beats a wrongful hold on a paid order). Mirrors
// holdIfClosedAtMaterialize's CAS-claim so two concurrent passes can never double-hold.
async function holdIfDuplicateSibling(deps, orderId, order, now) {
  try {
    if (!deps || !deps.db || !order || !order.customer_phone) return false;
    // Already resolved (materialized returns earlier in the caller; defensive) → let the normal flow handle it.
    if (order.status === 'cancelled' || order.materialized_at || order.payment_status === 'manual_reconciliation') return false;
    const sf = SCHED.normalizeScheduledFor(order.scheduled_for);
    const ck = orderContentKey({ phone: order.customer_phone, itemsText: order.items_text, orderType: order.order_type, scheduledFor: Number.isFinite(sf) ? sf : null });
    if (!ck) return false;
    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();
    // fast-out before the sibling point-read (no stamp / self / non-cash → not our collision)
    if (!stamp || !stamp.order_id || stamp.order_id === orderId || stamp.payment_method !== 'cash') return false;
    const siblingOrder = (await deps.db.ref(`orders/${stamp.order_id}`).once('value')).val();
    const dec = duplicateSiblingDecision(orderId, stamp, siblingOrder, 'cash');   // PIN 1: no 2-min gate — liveness of Y decides
    if (!dec.collision) return false;
    // CAS-claim X → manual_reconciliation. ONLY the pass that transitions this order proceeds (didClaim); a
    // concurrent guard pass no-ops. NEVER refund, NEVER materialize; the dispatcher resolves in the panel.
    const orderRef = deps.db.ref(`orders/${orderId}`);
    let didClaim = false;
    const claim = await orderRef.transaction((cur) => {
      didClaim = false;
      const o = cur || order;
      if (!o) return o;
      if (o.status === 'cancelled' || o.materialized_at || o.payment_status === 'manual_reconciliation') return o; // already resolved / materialized (lost the race)
      if (o.payment_status !== 'confirmed') return o;   // REVISE: only claim a CONFIRMED order — never clobber a concurrent refund/cancel/resolve (refunded/refund_pending/manual_review/failed/…) into manual_reconciliation (mirror holdIfClosedAtMaterialize)
      didClaim = true;
      return { ...o, payment_status: 'manual_reconciliation', blocked_reason: 'duplicate_of_sibling', sibling_order_id: dec.siblingOrderId, duplicate_held_at: now };
    });
    if (!claim.committed || !didClaim) return true;   // lost race / already held → still must NOT materialize
    try {
      await deps.db.ref(`dispatcher_alerts/duplicate_order_${orderId}`).set({
        order_id: orderId, sibling_order_id: dec.siblingOrderId, restaurant_id: order.restaurant_id || null,
        kind: 'duplicate_of_sibling', at: now,
      });
    } catch (_) {}
    if (deps.alert) { try { await deps.alert('duplicate_order', { orderId, restaurant_id: order.restaurant_id || null, sibling_order_id: dec.siblingOrderId }); } catch (_) {} }
    return true;   // HELD — caller must NOT materialize
  } catch (_) {
    return false;   // FAIL-OPEN — never hold a paid order on uncertainty
  }
}

module.exports = { holdIfClosedAtMaterialize, canAutoRefund, needsPaidAfterCloseRefund, parkForManualRefund, PARK_REASON, PARK_ALERT, PARK_ACTION, recoverRefundingDecision, holdIfDuplicateSibling, duplicateSiblingDecision };
