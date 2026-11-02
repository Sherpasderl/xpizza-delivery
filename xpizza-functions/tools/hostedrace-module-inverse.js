'use strict';
// FINDING-hosted-charge-recover-race (fix/hosted-recover-exclusive, defence in depth) — the test-only INVERSE for this slice's
// edits to pixelpay-hosted-webhook.js (and alert-prune.js, manual-resolve.js), which older fold guards pin byte-for-byte. Generated from
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
  "now": "\n  // ONE payment per attempt, bound ATOMICALLY (absent → this payment id). A re-delivery of the bound payment passes on; any\n  // OTHER payment id — including the loser of two concurrent first callbacks — is an extra payment with its own state\n  // machine (handleExtraPayment) and never touches this attempt's payment or reversal fields.\n  if (uuid) {\n    const bind = await db.ref(`payment_attempts/${attemptId}/payment_uuid`).transaction((cur) => (cur == null ? uuid : undefined));\n    const bound = bind.committed ? uuid : (bind.snapshot && bind.snapshot.val());\n    if (bound !== uuid) return handleExtraPayment(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now });\n  }\n\n  // CANCEL race (I9): cancelled before this paid callback → auto-void, NEVER materialize.\n",
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
  "now": "\n// The bound payment's paid_at / payment_reference are written ONCE (absent → value); a re-delivery leaves them as they were.\nasync function setPaidOnce(db, attemptId, { paidAt, reference }) {\n  await db.ref(`payment_attempts/${attemptId}/paid_at`).transaction((cur) => (cur == null ? paidAt : undefined));\n  await db.ref(`payment_attempts/${attemptId}/payment_reference`).transaction((cur) => (cur == null ? reference : undefined));\n}\n\n// ── AN EXTRA PAYMENT: a second distinct verified payment on an attempt that already has one (two payable checkouts paid) ──\n// Its OWN record under payment_attempts/{aaid}/extra_payments/{sha256(uuid)} (server-only; the exact uuid is stored inside and\n// checked on every read), its OWN phases, and its OWN reversal, scoped to its payment id — the attempt-level payment fields and\n// reversal state (status / refund_*) are never read or written for it, so the first payment's refund machinery is untouched.\n//   recorded → (durable alert + order flag) → held_for_review         live order: a person reviews it; never voided here\n//                                         → reversal_claimed → side_effect_started → voided | manual     cancelled order\n// Re-delivery resumes: an unwritten alert/flag is written; a held extra whose order is now cancelled is reversed; a claimed\n// but never-started reversal is started; a STARTED but unrecorded one is uncertain → manual, never re-sent. An unconfirmed void\n// is manual-only (no automatic retry). A failed alert / flag write answers 5xx so PixelPay re-delivers. No provider text is\n// ever copied into a record or an alert.\nconst extraKey = (uuid) => crypto.createHash('sha256').update(String(uuid)).digest('hex');\nconst orderCancelled = (o, att) => !!((att && att.cancel_pending) || (o && (o.status === 'cancelled' || (o.resolving_action === 'cancel' && o.cancel_claim_id))));\nasync function handleExtraPayment(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now }) {\n  const { db } = deps;\n  const key = extraKey(uuid);\n  const ref = db.ref(`payment_attempts/${attemptId}/extra_payments/${key}`);\n  const done = { code: 200, outcome: 'extra_payment_recorded' };\n  await ref.transaction((cur) => (cur == null ? { uuid, amount_cents: toCents(amount), at: now, phase: 'recorded' } : undefined));\n  const rec = (await ref.once('value')).val();\n  if (!rec || rec.uuid !== uuid) return { code: 500, outcome: 'extra_payment_key_mismatch' };   // never act on another payment's record\n  try {\n    await db.ref(`dispatcher_alerts/extra_payment_${key}`).set({ type: 'payment_extra_payment_received', detail: { orderId, attemptId }, created_at: rec.at });\n    await db.ref(`orders/${orderId}`).update({ extra_payment_review: true });\n  } catch (_) { return { code: 500, outcome: 'extra_payment_alert_failed' }; }   // surfaced: PixelPay re-delivers and this resumes\n\n  if (rec.phase === 'voided' || rec.phase === 'manual') return done;\n  if (rec.phase === 'side_effect_started') {   // a crash after the provider call may have started → uncertain → a person decides\n    await ref.update({ phase: 'manual', outcome: 'void_uncertain_manual' });\n    return done;\n  }\n  const [order, att] = (await Promise.all([db.ref(`orders/${orderId}`).once('value'), db.ref(`payment_attempts/${attemptId}`).once('value')])).map((x) => x.val());\n  if (!orderCancelled(order, att)) {\n    if (rec.phase !== 'held_for_review' && rec.phase !== 'reversal_claimed') await ref.update({ phase: 'held_for_review' });\n    if (rec.phase !== 'reversal_claimed') return done;\n  }\n  // Cancelled (or a claimed reversal to finish): CAS into side_effect_started IMMEDIATELY before the provider call, so exactly\n  // one delivery ever sends it; the claim step is separate so a crash before the call is provably \"not started\".\n  const claim = await ref.transaction((cur) => {\n    if (cur === null) return null;                                       // null-first-safe\n    if (!cur || cur.uuid !== uuid || !['recorded', 'held_for_review', 'reversal_claimed'].includes(cur.phase)) return;\n    return { ...cur, phase: 'reversal_claimed', claimed_at: cur.claimed_at || now };\n  });\n  if (!claim.committed) return done;\n  const start = await ref.transaction((cur) => {\n    if (cur === null) return null;\n    if (!cur || cur.uuid !== uuid || cur.phase !== 'reversal_claimed') return;\n    return { ...cur, phase: 'side_effect_started', started_at: now };\n  });\n  if (!start.committed) return done;\n  let voided = false;\n  try {\n    const vd = await deps.client.voidTransaction({ payment_uuid: uuid, pixelpayOrderId: hostedOrderId, voidReason: 'cancelled_before_payment' });\n    voided = !!(vd && vd.ok);\n  } catch (_) { voided = false; }\n  await ref.update(voided ? { phase: 'voided', outcome: 'auto_voided', finished_at: now } : { phase: 'manual', outcome: 'void_unconfirmed_manual', finished_at: now });\n  return done;\n}\n\n// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.\n",
  "was": "\n// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.\n"
 },
 {
  "file": "alert-prune.js",
  "now": "// Non-order-scoped alerts (no detail orderId/breaches) are never auto-dismissed here.\n// An extra-payment alert is a MONEY obligation, not an order flag: it stays until the person who reviews / returns the second\n// payment dismisses it, whatever the order's state (on a cancelled order by design).\nconst NEVER_AUTO_PRUNE = new Set(['payment_extra_payment_received']);\nfunction alertsToPrune(alerts, orders) {\n",
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
