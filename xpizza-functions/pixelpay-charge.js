/**
 * X Pizza — PixelPay online-payment orchestration helpers (Stage 3b).
 *
 * Pure, db-injected logic for the pending-first, browser-sale charge flow, kept
 * out of index.js so it can be unit-tested in isolation (see pixelpay-charge.test.js).
 * The HTTPS endpoint lives in index.js; the money-safety invariants it depends on
 * are documented there and in PAYMENT-PLAN.md (I1-I8).
 */
const crypto = require('crypto');

// CSPRNG attempt id. 16 hex chars (64 bits) — collision-proof for our volume.
function genAttemptId() {
  return crypto.randomBytes(8).toString('hex');
}

// Economic fingerprint binding an order_id to the exact thing we're charging.
// A second charge for the same order_id with a different cart/total yields a
// different fingerprint → 409 (we never silently charge a mutated amount).
function orderFingerprint(orderId, totalCents, itemsText, extra = '') {
  // `extra` binds the scheduled slot + fulfillment for scheduled orders (R2-#3) so a reused cart can't be
  // charged against a DIFFERENT slot. EMPTY for ASAP orders → the hash is byte-identical to the shipped
  // 3-part fingerprint (in-flight pending orders keep matching).
  const parts = [orderId, String(totalCents), String(itemsText)];
  if (extra) parts.push(String(extra));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// total_cents → decimal-lempira string PixelPay expects (38500 → "385.00").
function centsToLempiras(cents) {
  return (Number(cents) / 100).toFixed(2);
}

// Acquire (or reuse) the active payment attempt for an online order via a
// compare-and-swap transaction on orders/{id}. Returns one of:
//   { outcome: 'acquired', attempt_id }  → we own a FRESH attempt; write its record
//   { outcome: 'reuse',    attempt_id }  → an attempt is already active; reuse it
//   { outcome: 'already_paid' }          → payment_status already confirmed
//   { outcome: 'conflict' }              → fingerprint mismatch (order_id reused for a different cart)
//   { outcome: 'error' }                 → could not converge (retries exhausted / vanished)
//
// `attempt.status` lives in a DIFFERENT subtree than orders/{id}, so RTDB can't
// read it inside the orders/{id} transaction (Codex R4 caution #2). We therefore
// read-then-CAS in a bounded loop: pre-read order (+attempt) to DECIDE, then a
// CAS transaction ENACTS it only if the order state we keyed on is unchanged; if
// it moved under us we re-read and re-decide. `genId` is injectable for tests.
async function acquireOnlineAttempt(db, orderId, pendingOrderRecord, fingerprint, genId = genAttemptId) {
  const orderRef = db.ref(`orders/${orderId}`);

  for (let i = 0; i < 6; i++) {
    const order = (await orderRef.once('value')).val();

    // Terminal reads that need no write.
    if (order) {
      if (order.payment_status === 'confirmed') return { outcome: 'already_paid' };
      if (order.payment_fingerprint && order.payment_fingerprint !== fingerprint) {
        return { outcome: 'conflict' };
      }
    }

    // Decide intent from the pre-read.
    const candidate = genId();
    let decided;
    if (!order) {
      decided = { kind: 'create', newAaid: candidate };
    } else if (!order.active_attempt_id) {
      decided = { kind: 'install', newAaid: candidate };  // order exists, no lock (crash recovery)
    } else {
      const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
      if (!att) {
        // Pointer set but record missing → recreate THIS id, do not mint a second.
        decided = { kind: 'recover', reuseAaid: order.active_attempt_id };
      } else if (att.status === 'active') {
        decided = { kind: 'reuse', reuseAaid: order.active_attempt_id };
      } else if (att.status === 'capturing' || att.status === 'captured' || att.status === 'capture_unverified') {
        // A capture is in-flight or already done for this attempt. Opening a SECOND
        // attempt (a fresh auth) here risks a double charge if both get captured. Do NOT
        // rotate — tell the caller it's in progress so it polls confirm instead of re-charging.
        return { outcome: 'in_progress', attempt_id: order.active_attempt_id };
      } else {
        // genuinely TERMINAL failure (declined / voided / abandoned / converted / refunded)
        // → safe to open a fresh attempt.
        decided = { kind: 'rotate', newAaid: candidate, fromAaid: order.active_attempt_id };
      }
    }

    // Enact via CAS transaction on orders/{id}. NOTE: the Admin SDK calls the update
    // fn with `null` on its first (uncached) invocation; for non-create paths we fall
    // back to the pre-read `order` so we don't spuriously abort (returning a value
    // triggers the SDK's conflict re-check against the real server value).
    const tx = await orderRef.transaction((cur) => {
      if (decided.kind === 'create') {
        if (cur !== null) return;                       // exists on server → abort, re-decide
        return { ...pendingOrderRecord, active_attempt_id: decided.newAaid, payment_fingerprint: fingerprint };
      }
      const c = cur || order;                           // non-create: avoid first-call-null abort
      if (!c) return;                                   // genuinely absent
      if (c.payment_status === 'confirmed') return c;
      if (c.payment_fingerprint && c.payment_fingerprint !== fingerprint) return c;
      if (decided.kind === 'install') {
        if (c.active_attempt_id) return c;              // someone installed first → re-evaluate post-tx
        return { ...c, active_attempt_id: decided.newAaid, payment_fingerprint: c.payment_fingerprint || fingerprint };
      }
      if (decided.kind === 'reuse' || decided.kind === 'recover') {
        if (c.active_attempt_id !== decided.reuseAaid) return c; // pointer moved → re-evaluate
        return c;                                       // keep the same pointer (no change)
      }
      if (decided.kind === 'rotate') {
        if (c.active_attempt_id !== decided.fromAaid) return c;  // already rotated → re-evaluate
        return { ...c, active_attempt_id: decided.newAaid };
      }
      return c;
    });

    if (!tx.committed) continue;                        // create lost / transient → re-read & retry

    const committed = tx.snapshot.val();
    if (committed.payment_status === 'confirmed') return { outcome: 'already_paid' };
    if (committed.payment_fingerprint && committed.payment_fingerprint !== fingerprint) {
      return { outcome: 'conflict' };
    }
    const winner = committed.active_attempt_id;

    if (decided.kind === 'create' || decided.kind === 'install' || decided.kind === 'rotate') {
      if (winner === decided.newAaid) return { outcome: 'acquired', attempt_id: winner };
      continue;                                         // another id won → re-read to reuse/recover it
    }
    if (decided.kind === 'recover') {
      if (winner === decided.reuseAaid) return { outcome: 'acquired', attempt_id: winner };
      continue;
    }
    if (decided.kind === 'reuse') {
      if (winner === decided.reuseAaid) return { outcome: 'reuse', attempt_id: winner };
      continue;
    }
  }
  return { outcome: 'error' };
}

module.exports = { genAttemptId, orderFingerprint, centsToLempiras, acquireOnlineAttempt };
