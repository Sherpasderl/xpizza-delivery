'use strict';
// FINDING-hosted-charge-recover-race (fix/hosted-recover-exclusive, defence in depth) — the test-only INVERSE for this slice's
// edits to pixelpay-hosted-webhook.js (and alert-prune.js, manual-resolve.js, index.js), which older fold guards pin byte-for-byte. Generated from
// `git diff -U1 8a31e2a3` (each hunk carries one line of context each side, so it is unique); applying it returns the
// file to 8a31e2a3 byte-for-byte (hostedrace-wiring.guard). NEWEST layer: applied FIRST (innermost) at every per-file fold;
// it passes every file it does not own through untouched.
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": " */\nconst crypto = require('crypto');\nconst ppCrypto = require('./pixelpay');\n",
  "was": " */\nconst ppCrypto = require('./pixelpay');\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "const { holdRedemptionForManual, reverseRedemptionForOrder } = require('./rewards-reserve');   // [B] HOLD at a manual entry (alerts on a lost race); [C/#18] reverse the hold when a late paid callback voids a cancelled order\nconst XP = require('./extra-payment-repair');   // the second-payment record key, marker and completion write (one source with the sweep's repair)\n\n",
  "was": "const { holdRedemptionForManual, reverseRedemptionForOrder } = require('./rewards-reserve');   // [B] HOLD at a manual entry (alerts on a lost race); [C/#18] reverse the hold when a late paid callback voids a cancelled order\n\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "    // PERMANENT verification failure → manual_reconciliation + alert, then 2xx (won't change on retry, I8/R2-3).\n    // An UNVERIFIED callback never writes the attempt's payment binding (payment_uuid / paid_amount_cents): the hash covers\n    // only the order id, so its payment id and amount are claims. They are kept apart, once per claimed payment.\n    const claimedCents = toCents(amount);\n    const evKey = crypto.createHash('sha256').update(JSON.stringify([uuid || '', Number.isFinite(claimedCents) ? claimedCents : null])).digest('hex');\n    const evidence = { uuid: uuid || null, amount_cents: Number.isFinite(claimedCents) ? claimedCents : null, transaction_id: txnRef || null, at: now, binding_ok: bindingOk, hash_ok: hashOk, amount_ok: amountOk };\n    await db.ref(`payment_attempts/${attemptId}/unverified_callbacks/${evKey}`).transaction((cur) => (cur == null ? evidence : undefined));\n    await db.ref(`payment_attempts/${attemptId}`).update({\n",
  "was": "    // PERMANENT verification failure → manual_reconciliation + alert, then 2xx (won't change on retry, I8/R2-3).\n    await db.ref(`payment_attempts/${attemptId}`).update({\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "      manual_reason: `verify_fail binding=${bindingOk} hash=${hashOk} amount=${amountOk}`,\n      flagged_at: now\n    });\n",
  "was": "      manual_reason: `verify_fail binding=${bindingOk} hash=${hashOk} amount=${amountOk}`,\n      payment_uuid: uuid, paid_amount_cents: toCents(amount), flagged_at: now\n    });\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "\n  // ONE payment per attempt, bound ATOMICALLY (absent → this payment id). A re-delivery of the bound payment passes on; any\n  // OTHER payment id — including the loser of two concurrent first callbacks — is an extra payment: recorded and alerted for\n  // a person to refund, never voided automatically, and it never touches this attempt's payment or reversal fields.\n  if (uuid) {\n    const bind = await db.ref(`payment_attempts/${attemptId}/payment_uuid`).transaction((cur) => (cur == null ? uuid : undefined));\n    const bound = bind.committed ? uuid : (bind.snapshot && bind.snapshot.val());\n    if (bound !== uuid) return handleExtraPayment(deps, { orderId, attemptId, uuid, amount, now });\n  }\n\n  // CANCEL race (I9): cancelled before this paid callback → auto-void, NEVER materialize.\n",
  "was": "\n  // CANCEL race (I9): cancelled before this paid callback → auto-void, NEVER materialize.\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "      [`payment_attempts/${attemptId}/payment_hash_verified`]: true,\n      [`orders/${orderId}/paid_during_resolve`]: true,\n    });\n    await setPaidOnce(db, attemptId, { paidAt: now, reference: txnRef || uuid });\n    await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // paid evidence in manual-flow → HOLD the points (alerts if a race already freed the hold → possible mint)\n",
  "was": "      [`payment_attempts/${attemptId}/payment_hash_verified`]: true,\n      [`payment_attempts/${attemptId}/payment_reference`]: txnRef || uuid,\n      [`payment_attempts/${attemptId}/paid_at`]: now,\n      [`orders/${orderId}/paid_during_resolve`]: true,\n    });\n    await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // paid evidence in manual-flow → HOLD the points (alerts if a race already freed the hold → possible mint)\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "    hosted_state: 'paid', payment_uuid: uuid, paid_amount_cents: toCents(amount),\n    hosted_callback_verified: true, payment_hash_verified: true\n  });\n  await setPaidOnce(db, attemptId, { paidAt: now, reference: txnRef || uuid });   // immutable once written: a re-delivery never moves them\n\n",
  "was": "    hosted_state: 'paid', payment_uuid: uuid, paid_amount_cents: toCents(amount),\n    hosted_callback_verified: true, payment_hash_verified: true,\n    payment_reference: txnRef || uuid, paid_at: now\n  });\n\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "\n// The bound payment's paid_at / payment_reference are written ONCE (absent → value); a re-delivery leaves them as they were.\nasync function setPaidOnce(db, attemptId, { paidAt, reference }) {\n  await db.ref(`payment_attempts/${attemptId}/paid_at`).transaction((cur) => (cur == null ? paidAt : undefined));\n  await db.ref(`payment_attempts/${attemptId}/payment_reference`).transaction((cur) => (cur == null ? reference : undefined));\n}\n\n// A SECOND distinct verified payment on one attempt (owner 2026-11-02): it is NEVER voided automatically — on a live or a\n// cancelled order alike — a person refunds it in PixelPay. It is recorded ONCE under a collision-resistant key (sha256 of the\n// exact payment id, which is kept inside the record). The record is CLAIMED absent-only (a transaction: an existing record for\n// the same payment is a no-op, one for another payment id is refused), so its first sighting is never rewritten; the durable\n// alert and the order's manual-review flag are then written from the COMMITTED record, so a late or concurrent re-delivery\n// writes byte-identical values. Any failure answers 5xx so PixelPay re-delivers and the next delivery completes the alert and\n// flag. A pending marker written BEFORE the claim (and removed in the same update as the alert + flag) lets the payments sweep\n// complete the alert when a crash is followed by re-deliveries the endpoint dedupes. The first payment's binding, reference\n// and paid_at are never touched, and no provider text is copied anywhere.\nasync function handleExtraPayment(deps, { orderId, attemptId, uuid, amount, now }) {\n  const { db } = deps;\n  const key = XP.extraKey(uuid);\n  try { await db.ref(`extra_payment_pending/${key}`).set(XP.pendingMarker({ attemptId, orderId, now })); }\n  catch (_) { return { code: 500, outcome: 'extra_payment_marker_failed' }; }\n  let rec;\n  try {\n    const claim = await db.ref(XP.extraRecordPath(attemptId, key)).transaction((cur) => (cur == null ? { uuid, amount_cents: toCents(amount), at: now } : undefined));\n    rec = claim.snapshot && claim.snapshot.val();\n  } catch (_) { return { code: 500, outcome: 'extra_payment_claim_failed' }; }\n  if (!rec || rec.uuid !== uuid) return { code: 500, outcome: 'extra_payment_key_mismatch' };   // never write over another payment's record\n  try { await db.ref().update(XP.extraCompletionUpdate(key, rec, { orderId, attemptId })); }\n  catch (_) { return { code: 500, outcome: 'extra_payment_write_failed' }; }\n  return { code: 200, outcome: 'extra_payment_recorded' };\n}\n\n// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.\n",
  "was": "\n// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.\n"
 },
 {
  "file": "alert-prune.js",
  "now": "// Non-order-scoped alerts (no detail orderId/breaches) are never auto-dismissed here.\n// An extra-payment alert is a MONEY obligation, not an order flag: it stays until the person who reviews / returns the second\n// payment dismisses it, whatever the order's state (on a cancelled order by design).\nconst NEVER_AUTO_PRUNE = new Set(['payment_extra_payment_received', 'payment_extra_payment_quarantined']);\nfunction alertsToPrune(alerts, orders) {\n",
  "was": "// Non-order-scoped alerts (no detail orderId/breaches) are never auto-dismissed here.\nfunction alertsToPrune(alerts, orders) {\n"
 },
 {
  "file": "alert-prune.js",
  "now": "  for (const [key, alert] of Object.entries(alerts || {})) {\n    if (alert && NEVER_AUTO_PRUNE.has(alert.type)) continue;\n    const ids = alertOrderIds(alert);\n",
  "was": "  for (const [key, alert] of Object.entries(alerts || {})) {\n    const ids = alertOrderIds(alert);\n"
 },
 {
  "file": "manual-resolve.js",
  "now": "// ── Paid-evidence detection (universal — pre-claim window, during resolve, or post-terminal) ───────\n// Any of: the order's paid_during_resolve flag, or the attempt's persisted UUID / verified capture / unverified callback\n// evidence (a paid callback that failed verification — possibly real money, kept apart from the binding).\n// BROAD — used to ROUTE AMBIGUITY (a bare UUID may be a declined auth) to manual_review, NEVER to gate a void.\n",
  "was": "// ── Paid-evidence detection (universal — pre-claim window, during resolve, or post-terminal) ───────\n// Any of: the order's paid_during_resolve flag, or the attempt's persisted UUID / verified capture.\n// BROAD — used to ROUTE AMBIGUITY (a bare UUID may be a declined auth) to manual_review, NEVER to gate a void.\n"
 },
 {
  "file": "manual-resolve.js",
  "now": "    (order && order.paid_during_resolve === true) ||\n    (attempt && (attempt.payment_uuid || attempt.capture_verified === true || attempt.unverified_callbacks))\n  );\n",
  "was": "    (order && order.paid_during_resolve === true) ||\n    (attempt && (attempt.payment_uuid || attempt.capture_verified === true))\n  );\n"
 },
 {
  "file": "index.js",
  "now": "    try { repair = await retryRewardLedgerRepair({ db, alert: (k, d) => paymentAlert(db, k, d) }, { now }); }\n    catch (e) { console.error('sweepStalePending: ledger-repair retry failed', e && e.message); } try { await require('./extra-payment-repair').repairPendingExtraPayments({ db, now }); } catch (e) { console.warn('sweepStalePending: extra-payment repair failed', e && e.message); }\n    console.log(`sweepStalePending: manual_flagged=${flagged} left=${left} paid_strand_recovered=${recovered} ledger_healed=${repair.healed} ledger_pending=${repair.pending}`);\n",
  "was": "    try { repair = await retryRewardLedgerRepair({ db, alert: (k, d) => paymentAlert(db, k, d) }, { now }); }\n    catch (e) { console.error('sweepStalePending: ledger-repair retry failed', e && e.message); }\n    console.log(`sweepStalePending: manual_flagged=${flagged} left=${left} paid_strand_recovered=${recovered} ledger_healed=${repair.healed} ledger_pending=${repair.pending}`);\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "      // still finds the binding and can recover a crashed `creating`.\n      // The claim is EXCLUSIVE: only the request that moves the attempt record from ABSENT to `creating` may mint a\n      // checkout. The order CAS above cannot give that guarantee for `recover` (it commits unchanged for every racer\n      // whose pre-read landed between the pointer write and this one), so every racer that loses here re-reads\n      // and answers in_progress — one payable checkout per attempt, never N.\n      const claim = await db.ref(`payment_attempts/${attemptId}`).transaction((cur) => {\n        if (cur !== null) return;                                       // already claimed (or real record) → abort\n        return {\n          order_id: orderId,\n          hosted_state: 'creating',\n          hosted_order_id: hostedOrderId,\n          hosted_created_at: now,\n          hosted_expires_at: expiresAt,\n          poll_token: pollToken,\n          total_cents: pendingOrderRecord.total_cents\n        };\n      });\n      if (!claim.committed) continue;                                   // another request claimed it → re-read (→ in_progress)\n      return { outcome: 'claimed', attempt_id: attemptId, hosted_order_id: hostedOrderId, poll_token: pollToken, expires_at: expiresAt };\n",
  "was": "      // still finds the binding and can recover a crashed `creating`.\n      await db.ref(`payment_attempts/${attemptId}`).update({\n        order_id: orderId,\n        hosted_state: 'creating',\n        hosted_order_id: hostedOrderId,\n        hosted_created_at: now,\n        hosted_expires_at: expiresAt,\n        poll_token: pollToken,\n        total_cents: pendingOrderRecord.total_cents\n      });\n      return { outcome: 'claimed', attempt_id: attemptId, hosted_order_id: hostedOrderId, poll_token: pollToken, expires_at: expiresAt };\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function unapplyHostedRaceModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`hostedrace-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, FILES, unapplyHostedRaceModule };
