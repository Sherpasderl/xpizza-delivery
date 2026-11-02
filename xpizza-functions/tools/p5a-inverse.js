'use strict';
// P5a (PixelPay unknown outcome) — the test-only INVERSE for the slice's edits to files older slices pin byte-for-byte.
// Generated from `git diff -U1 8a31e2a3` per file (each hunk carries one line of context on each side, so it is unique);
// applying every hunk turns the slice's file back into 8a31e2a3's byte-for-byte (p5a-wiring.guard). It is the NEWEST
// layer: every chain applies it FIRST (innermost) — the index.js chains through unapplyP5aIndex, the per-file chains
// through unapplyP5aModule (which passes every file it does not own through untouched).
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "const ppCrypto = require('./pixelpay');\nconst { confirmOnlinePayment, confirmAndMaterialize, escalateStaleCapture } = require('./pixelpay-confirm');\nconst N2 = require('./n2-paid-strand-decision');   // N2: sweep re-drives a stranded PAID hosted order (paid attempt + still-pending order)\n",
  "was": "const ppCrypto = require('./pixelpay');\nconst { confirmOnlinePayment, confirmAndMaterialize } = require('./pixelpay-confirm');\nconst N2 = require('./n2-paid-strand-decision');   // N2: sweep re-drives a stranded PAID hosted order (paid attempt + still-pending order)\n"
 },
 {
  "file": "index.js",
  "now": "const { resolveManualReconciliationCore, recoverStaleResolve } = require('./resolve-manual');   // the resolver core + sweep recovery (emulator-driven)\nconst { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, retryRewardLedgerRepair, isReconcilerRetryable, noteRefundRetry, escalateConfirmedRefunds } = require('./cancel-order-core');   // universal dispatcher-cancel core (CANCEL_PAID_ORDER_FIX_PLAN rev-5) + [A] ledger-repair retry\nconst { runPrediction, runLabelAndUpdate } = require('./ready-time-predict-core');   // Phase-1 Step-3 shadow predictor + prediction-logging (PURE SHADOW)\n",
  "was": "const { resolveManualReconciliationCore, recoverStaleResolve } = require('./resolve-manual');   // the resolver core + sweep recovery (emulator-driven)\nconst { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, retryRewardLedgerRepair, isReconcilerRetryable } = require('./cancel-order-core');   // universal dispatcher-cancel core (CANCEL_PAID_ORDER_FIX_PLAN rev-5) + [A] ledger-repair retry\nconst { runPrediction, runLabelAndUpdate } = require('./ready-time-predict-core');   // Phase-1 Step-3 shadow predictor + prediction-logging (PURE SHADOW)\n"
 },
 {
  "file": "index.js",
  "now": "  if (o === 'capture_failed' || o === 'failed' || o === 'mismatch_voided') {\n    return res.status(200).json({ ok: false, payment_status: o === 'mismatch_voided' && result.voided !== true ? 'refund_pending' : 'failed', order_id: orderId, detail: result.message || result.reason || 'payment not completed' });\n  }\n",
  "was": "  if (o === 'capture_failed' || o === 'failed' || o === 'mismatch_voided') {\n    return res.status(200).json({ ok: false, payment_status: o === 'mismatch_voided' ? 'failed' : 'failed', order_id: orderId, detail: result.message || result.reason || 'payment not completed' });\n  }\n"
 },
 {
  "file": "index.js",
  "now": "        : null;\n      if (!attempt) { left++; continue; } if (attempt.status === 'capturing' || attempt.status === 'capture_unverified') { if (await escalateStaleCapture(confirmDeps(db), { orderId, attemptId: order.active_attempt_id, now })) flagged++; else left++; continue; }   // a lost/crashed SDK capture → durable manual escalation (never re-captured, never declined)\n      if (attempt.hosted_state === 'paid') {\n",
  "was": "        : null;\n      if (!attempt) { left++; continue; }\n      if (attempt.hosted_state === 'paid') {\n"
 },
 {
  "file": "index.js",
  "now": "      /* h0:end reconciler-no-uuid */\n      try { await noteRefundRetry(db, { attemptId, orderId: a.order_id, now }); } catch (e) { console.warn(`refundReconciler: review marker failed for ${attemptId} — void deferred`, e && e.message); continue; } const r = await voidOrRefund(deps, { orderId: a.order_id, attemptId, pixelpayOrderId, paymentUuid: a.payment_uuid, reason: 'xpizza_refund_retry', now });   // the durable to-do BEFORE the void\n      retried++;\n",
  "was": "      /* h0:end reconciler-no-uuid */\n      const r = await voidOrRefund(deps, { orderId: a.order_id, attemptId, pixelpayOrderId, paymentUuid: a.payment_uuid, reason: 'xpizza_refund_retry', now });\n      retried++;\n"
 },
 {
  "file": "index.js",
  "now": "    }\n    let escalated = 0; try { escalated = await escalateConfirmedRefunds({ db }, { now }); } catch (e) { console.warn('refundReconciler: escalation pass failed (retried next run)', e && e.message); } console.log(`refundReconciler: retried=${retried} stillPending=${stillPending} escalated=${escalated}`);   // confirmed refunds → staff release the points (never automatic)\n\n",
  "was": "    }\n    console.log(`refundReconciler: retried=${retried} stillPending=${stillPending}`);\n\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    const recheck = deps.client.interpretStatus(await deps.client.getStatus({ payment_uuid: uuid }));\n    if (recheck.paid || !recheck.status) {   // paid → settled-but-lost; NO status at all → not evidence of \"no money moved\"\n      await routeManualReconciliation(deps, { orderId, attemptId, uuid, now, reason: recheck.paid ? undefined : 'capture_412_status_unknown' });\n      return { outcome: 'manual_reconciliation' };\n",
  "was": "    const recheck = deps.client.interpretStatus(await deps.client.getStatus({ payment_uuid: uuid }));\n    if (recheck.paid) {\n      await routeManualReconciliation(deps, { orderId, attemptId, uuid, now });\n      return { outcome: 'manual_reconciliation' };\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    } catch (_) { /* void failed → refund_pending below */ }\n    if (!voided) await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // unconfirmed void → money may still be held → secure the hold\n    await attemptRef.update({ status: voided ? 'voided' : 'refund_pending', mismatch_reason: v.reason, failed_at: now });\n",
  "was": "    } catch (_) { /* void failed → refund_pending below */ }\n    await attemptRef.update({ status: voided ? 'voided' : 'refund_pending', mismatch_reason: v.reason, failed_at: now });\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "// Route a paid-but-unverifiable capture to the audited manual-reconciliation queue.\nasync function routeManualReconciliation(deps, { orderId, attemptId, uuid, now, reason }) {\n  await deps.db.ref(`payment_attempts/${attemptId}`).update({\n",
  "was": "// Route a paid-but-unverifiable capture to the audited manual-reconciliation queue.\nasync function routeManualReconciliation(deps, { orderId, attemptId, uuid, now }) {\n  await deps.db.ref(`payment_attempts/${attemptId}`).update({\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    payment_uuid: uuid,\n    manual_reason: reason || 'paid_lost_capture_response',\n    flagged_at: now\n",
  "was": "    payment_uuid: uuid,\n    manual_reason: 'paid_lost_capture_response',\n    flagged_at: now\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "\n// A capturing claim nobody finished (the capture response was lost, or the confirm crashed mid-capture) past this\n// age is ESCALATED to manual reconciliation — never re-captured from the sweep, never declined. Far above the\n// confirm's own stale window and function timeout, so an in-flight confirm is never touched.\nconst STALE_CAPTURE_ESCALATE_MS = 15 * 60 * 1000;\n\n// Sweep entry: CAS the attempt capturing → capture_unverified (only if it is still the SAME stale claim), secure the\n// redemption hold, then advertise manual_reconciliation. Returns true when it escalated.\nasync function escalateStaleCapture(deps, { orderId, attemptId, now, staleMs = STALE_CAPTURE_ESCALATE_MS }) {\n  const ref = deps.db.ref(`payment_attempts/${attemptId}`);\n  const pre = (await ref.once('value')).val();\n  if (!pre) return false;\n  if (pre.status === 'capture_unverified') return finishEscalation(deps, { orderId, attemptId, now, uuid: pre.payment_uuid || null });   // RESUME: the attempt was escalated, the order may not have been\n  if (pre.status !== 'capturing') return false;\n  if (now - (Number(pre.capturing_started_at) || 0) <= staleMs) return false;   // a missing start time counts as stale\n  const tx = await ref.transaction((cur) => {\n    if (cur === null) return null;                                               // null-first-safe\n    if (!cur || cur.status !== 'capturing' || cur.capturing_started_at !== pre.capturing_started_at) return;\n    return { ...cur, status: 'capture_unverified', manual_reason: 'stale_capturing_unrecovered', flagged_at: now };\n  });\n  if (!tx.committed) return false;\n  return finishEscalation(deps, { orderId, attemptId, now, uuid: pre.payment_uuid || null });\n}\n\n// The order half of an escalation — idempotent, so a sweep that finds the attempt already capture_unverified completes\n// it: secure the hold, then advertise manual_reconciliation. A no-op (false) once the order is already there.\n// Only an order still waiting on its payment may be escalated — never one a resolver, a refund or a cancel has touched.\nconst escalatable = (o) => !!o && o.status === 'pending_payment' && (o.payment_status == null || o.payment_status === 'pending');\nasync function finishEscalation(deps, { orderId, attemptId, now, uuid }) {\n  const ref = deps.db.ref(`orders/${orderId}`);\n  const order = (await ref.once('value')).val();\n  if (!escalatable(order)) return false;\n  await holdRedemptionForManual(deps.db, { orderId, order, now, alert: deps.alert });   // secure first; it never re-acquires a freed hold\n  const tx = await ref.transaction((cur) => {\n    if (cur === null) return null;                                     // null-first-safe\n    if (!escalatable(cur)) return;                                     // settled meanwhile (resolver / refund / cancel) → refuse\n    return { ...cur, payment_status: 'manual_reconciliation' };\n  });\n  if (!tx.committed) return false;\n  deps.alert && deps.alert('manual_reconciliation', { orderId, attemptId, uuid, reason: 'stale_capturing_unrecovered' });\n  return true;\n}\n\nmodule.exports = { confirmOnlinePayment, confirmAndMaterialize, routeManualReconciliation, escalateStaleCapture, STALE_CAPTURE_ESCALATE_MS };\n",
  "was": "\nmodule.exports = { confirmOnlinePayment, confirmAndMaterialize, routeManualReconciliation };\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "const { holdIfClosedAtMaterialize } = MG;   // paid-after-close re-check (Codex-on-diff)\nconst { reverseRedemptionForOrder, settleRedemptionAtConfirm, holdRedemptionForManual } = require('./rewards-reserve');   // Phase B1 — redemption reversal/settle on manual resolve (single helper, no-op for non-redeemed)\nconst { usesPlatformFactura } = require('./factura/eligibility');   // fiscal-brand gate: X.Pizza owes a SAR factura, La Musa does not\n",
  "was": "const { holdIfClosedAtMaterialize } = MG;   // paid-after-close re-check (Codex-on-diff)\nconst { reverseRedemptionForOrder, settleRedemptionAtConfirm } = require('./rewards-reserve');   // Phase B1 — redemption reversal/settle on manual resolve (single helper, no-op for non-redeemed)\nconst { usesPlatformFactura } = require('./factura/eligibility');   // fiscal-brand gate: X.Pizza owes a SAR factura, La Musa does not\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "    await orderRef.update({ payment_status: finalStatus, status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null });\n    if (voided) await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now }); else await holdRedemptionForManual(db, { orderId, order, now, alert });   // CONFIRMED refund → release; unconfirmed → keep it secured (the reconciler releases on confirm) (held_paid/reserved → released; consumed → credit debit_applied)\n    await audit(finalStatus, { voided });\n",
  "was": "    await orderRef.update({ payment_status: finalStatus, status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null });\n    await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now });   // manual refund → release the hold (held_paid/reserved → released; consumed → credit debit_applied)\n    await audit(finalStatus, { voided });\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "const { reverseEarnForOrder } = require('./rewards-earn');   // Rewards Phase A — earn clawback on cancel (idempotent, fail-open)\nconst { reverseRedemptionForOrder, holdRedemptionForManual } = require('./rewards-reserve');   // Phase B1 — redemption hold reversal on cancel (single helper, idempotent)\nconst H0 = require('./superseded-capture');   // PLAN-H0 §4 — never auto-close over unresolved money on the order (read-only)\n",
  "was": "const { reverseEarnForOrder } = require('./rewards-earn');   // Rewards Phase A — earn clawback on cancel (idempotent, fail-open)\nconst { reverseRedemptionForOrder } = require('./rewards-reserve');   // Phase B1 — redemption hold reversal on cancel (single helper, idempotent)\nconst H0 = require('./superseded-capture');   // PLAN-H0 §4 — never auto-close over unresolved money on the order (read-only)\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "  try { earnRes = await reverseEarnForOrder(db, { orderId, order, now }); } catch (e) { earnRes = { ok: false }; console.warn(`cancelOrder reverse-earn failed for ${orderId}`, e && e.message); }\n  // An UNCONFIRMED reversal (refund_pending) keeps the hold secured instead of releasing it — the reconciler releases it\n  // when the refund confirms. The secure step alerts on its own failure; it is not journaled as a refund repair.\n  if (fin.payment_status === 'refund_pending') { try { await holdRedemptionForManual(db, { orderId, order, now, alert }); } catch (e) { console.warn(`cancelOrder hold-redemption failed for ${orderId}`, e && e.message); } redRes = { ok: true, skipped: true }; }\n  else try { redRes = await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now }); } catch (e) { redRes = { ok: false }; console.warn(`cancelOrder reverse-redemption failed for ${orderId}`, e && e.message); }\n  const earnFailed = !earnRes || earnRes.ok === false;\n",
  "was": "  try { earnRes = await reverseEarnForOrder(db, { orderId, order, now }); } catch (e) { earnRes = { ok: false }; console.warn(`cancelOrder reverse-earn failed for ${orderId}`, e && e.message); }\n  try { redRes = await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now }); } catch (e) { redRes = { ok: false }; console.warn(`cancelOrder reverse-redemption failed for ${orderId}`, e && e.message); }\n  const earnFailed = !earnRes || earnRes.ok === false;\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "      uid: order.customer_uid || null, rid: order.restaurant_id || 'x_pizza', has_redemption: !!order.redemption,   // [A revise] ledger coords → heal INDEPENDENTLY of the order node (a purged order can't orphan a diverged ledger)\n      earn_failed: earnFailed, redemption_failed: redFailed, redemption_mode: fin.payment_status === 'refund_pending' ? 'hold' : 'reverse',   // an UNCONFIRMED refund: the retry keeps the hold, never releases it\n      reason: reason || 'cancel', first_failed_at: now, updated_at: now, attempts: 0 })\n      .catch((e) => console.error(`cancelOrder repair-journal write failed for ${orderId}`, e && e.message));\n",
  "was": "      uid: order.customer_uid || null, rid: order.restaurant_id || 'x_pizza', has_redemption: !!order.redemption,   // [A revise] ledger coords → heal INDEPENDENTLY of the order node (a purged order can't orphan a diverged ledger)\n      earn_failed: earnFailed, redemption_failed: redFailed, reason: reason || 'cancel', first_failed_at: now, updated_at: now, attempts: 0 })\n      .catch((e) => console.error(`cancelOrder repair-journal write failed for ${orderId}`, e && e.message));\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "  for (const orderId of Object.keys(repairs)) {\n    const r = await healLedgerRepair(deps, orderId, repairs[orderId] || {}, now);\n    if (r === 'healed') healed++; else pending++;\n  }\n  return { healed, pending };\n}\n\n// One ledger-repair record. The redemption leg honours the record's restriction:\n//   redemption_mode 'hold' (or no mode on an online / missing order) → re-secure the hold, never release it;\n//   redemption_mode 'reverse' (or no mode on a cash order)           → reverse, as before.\n// The earn leg runs unless the record says it never failed (earn_failed === false). Returns 'healed' | 'pending'.\nasync function healLedgerRepair(deps, orderId, rec, now) {\n  const { db, alert } = deps;\n  {\n    const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n",
  "was": "  for (const orderId of Object.keys(repairs)) {\n    const rec = repairs[orderId] || {};\n    const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "    const rid = (order && order.restaurant_id) || rec.rid || 'x_pizza';\n    if (!uid) { await alert('reward_reversal_orphaned', { orderId }); return 'pending'; }\n    const ord = order || { customer_uid: uid, restaurant_id: rid, redemption: rec.has_redemption ? true : null };\n    let earn = { ok: true, skipped: true }, red = { ok: false };\n    if (rec.earn_failed !== false) { try { earn = await reverseEarnForOrder(db, { orderId, order: ord, now }); } catch (_) { earn = { ok: false }; } }\n    // No automatic release of a hold whose money may have moved. A record without a mode (written before this rule) on\n    // an ONLINE order — or on an order that is gone — is treated as 'hold'; a refunded online order is ESCALATED to staff.\n    const online = order ? order.payment_method === 'online' : true;\n    const mode = rec.redemption_mode || (online ? 'hold' : 'reverse');\n    if (mode === 'hold') {\n      try { await holdRedemptionForManual(db, { orderId, order: ord, now, alert }); } catch (_) {}\n      // a DURABLE, idempotent escalation (a throw keeps this record pending) — never a best-effort alert that could vanish\n      let escalatedOk = true;\n      if (order && order.payment_status === 'refunded') {\n        try { await db.ref(`dispatcher_alerts/refund_points_order_${orderId}`).set({ type: 'payment_refund_confirmed_release_points', detail: { orderId }, created_at: now }); }\n        catch (_) { escalatedOk = false; }\n      }\n      red = order && escalatedOk ? { ok: true, skipped: true } : { ok: false };   // a gone order or an unwritten escalation stays pending, never \"healed\"\n    } else {\n      try { red = await reverseRedemptionForOrder(db, { orderId, order: ord, disposition: rec.disposition || 'refund', now }); } catch (_) { red = { ok: false }; }\n    }\n    const earnOk = !!earn && earn.ok !== false;\n    const redOk = !!red && (red.ok !== false || red.skipped === true);\n    if (earnOk && redOk) { await db.ref(`reward_ledger_repair/${orderId}`).remove(); return 'healed'; }\n    const attempts = (Number(rec.attempts) || 0) + 1;\n",
  "was": "    const rid = (order && order.restaurant_id) || rec.rid || 'x_pizza';\n    if (!uid) { pending++; await alert('reward_reversal_orphaned', { orderId }); continue; }\n    const ord = order || { customer_uid: uid, restaurant_id: rid, redemption: rec.has_redemption ? true : null };\n    let earn = { ok: false }, red = { ok: false };\n    try { earn = await reverseEarnForOrder(db, { orderId, order: ord, now }); } catch (_) { earn = { ok: false }; }\n    try { red = await reverseRedemptionForOrder(db, { orderId, order: ord, disposition: rec.disposition || 'refund', now }); } catch (_) { red = { ok: false }; }\n    const earnOk = !!earn && earn.ok !== false;\n    const redOk = !!red && (red.ok !== false || red.skipped === true);\n    if (earnOk && redOk) { await db.ref(`reward_ledger_repair/${orderId}`).remove(); healed++; continue; }\n    pending++;\n    const attempts = (Number(rec.attempts) || 0) + 1;\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "    if (attempts === 3 || attempts % 12 === 0) await alert('reward_reversal_stuck', { orderId, attempts });   // persistent divergence → escalate to a human\n    return 'pending';\n  }\n}\n\n// The refund reconciler's durable to-do (ruling, codex P5a r3): a per-ATTEMPT review marker is written BEFORE the void is\n// retried, so a refund can never become terminal without a record. Once the attempt is refunded, the marker is\n// ESCALATED to staff — a durable, idempotent dispatcher alert «refund confirmed — release points» — and NOTHING is\n// released automatically: the points stay secured until a person releases them.\nasync function noteRefundRetry(db, { attemptId, orderId, now }) {\n  await db.ref(`refund_hold_review/${attemptId}`).update({ order_id: orderId || null, attempt_id: attemptId, last_retry_at: now });\n}\n\nasync function escalateConfirmedRefunds(deps, { now }) {\n  const { db } = deps;\n  const marks = (await db.ref('refund_hold_review').once('value')).val() || {};\n  let escalated = 0;\n  for (const attemptId of Object.keys(marks)) {\n    const m = marks[attemptId] || {};\n    if (m.escalated_at) continue;\n    const att = (await db.ref(`payment_attempts/${attemptId}`).once('value')).val();\n    if (att && att.status !== 'refunded') continue;                    // not confirmed yet → a later run escalates it\n    const orderId = m.order_id || (att && att.order_id) || null;\n    const order = orderId ? (await db.ref(`orders/${orderId}`).once('value')).val() : null;\n    if (order && !order.redemption) { await db.ref(`refund_hold_review/${attemptId}`).remove(); continue; }   // no points involved\n    await db.ref(`dispatcher_alerts/refund_points_${attemptId}`).set({ type: 'payment_refund_confirmed_release_points', detail: { orderId, attemptId }, created_at: now });\n    await db.ref(`refund_hold_review/${attemptId}`).update({ escalated_at: now });\n    escalated++;\n  }\n  return escalated;\n}\n\nmodule.exports = { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, retryRewardLedgerRepair, healLedgerRepair, noteRefundRetry, escalateConfirmedRefunds, isReconcilerRetryable: C.isReconcilerRetryable };\n",
  "was": "    if (attempts === 3 || attempts % 12 === 0) await alert('reward_reversal_stuck', { orderId, attempts });   // persistent divergence → escalate to a human\n  }\n  return { healed, pending };\n}\n\nmodule.exports = { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, retryRewardLedgerRepair, isReconcilerRetryable: C.isReconcilerRetryable };\n"
 },
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "  const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n  if (voided) await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now });\n  else await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // unconfirmed void → the money may still be held → secure, never release\n  deps.alert && deps.alert('hosted_cancel_void', { orderId, attemptId, voided, reason });\n",
  "was": "  const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n  await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now });\n  deps.alert && deps.alert('hosted_cancel_void', { orderId, attemptId, voided, reason });\n"
 },
 {
  "file": "pixelpay-client.js",
  "now": "\n// The response was lost after PixelPay may have acted: callers treat this exactly like a network/abort reject.\n// What a 2xx must carry to count as an answer for that action: capture / void must say `success` (anulada or\n// declined); a status must name the state (its body is data-only — `success` is not required there).\nfunction hasActionEvidence(action, json) {\n  if (action === 'status') return !!(json.data && typeof json.data.status === 'string' && json.data.status);\n  return typeof json.success === 'boolean';\n}\n\nfunction outcomeUnknown(httpStatus, reason, cause) {\n  return Object.assign(new Error(`PIXELPAY_OUTCOME_UNKNOWN: ${reason} (HTTP ${httpStatus})`), { code: 'PIXELPAY_OUTCOME_UNKNOWN', httpStatus, reason, cause });\n}\n\n// Low-level POST to a transaction endpoint. Returns a normalized envelope; never throws\n// for HTTP/PixelPay errors (returns { ok:false, ... }) — only network/abort rejects, and a 2xx\n// whose envelope cannot be read (code PIXELPAY_OUTCOME_UNKNOWN).\nasync function ppPost(action, body, extraHeaders = {}) {\n",
  "was": "\n// Low-level POST to a transaction endpoint. Returns a normalized envelope; never throws\n// for HTTP/PixelPay errors (returns { ok:false, ... }) — only network/abort rejects.\nasync function ppPost(action, body, extraHeaders = {}) {\n"
 },
 {
  "file": "pixelpay-client.js",
  "now": "  let res;\n  let text = '';\n  try {\n    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });\n    // The deadline covers the BODY too. Headers alone settle nothing: a 2xx whose body is lost may still\n    // have moved money, so it is an UNKNOWN outcome (the lost-response path), never an envelope.\n    try { text = await res.text(); } catch (e) { if (res.ok) throw outcomeUnknown(res.status, 'body_read_failed', e); text = ''; }\n  } finally {\n",
  "was": "  let res;\n  try {\n    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });\n  } finally {\n"
 },
 {
  "file": "pixelpay-client.js",
  "now": "\n  let json = null;\n  try { json = text ? JSON.parse(text) : null; } catch { json = null; }\n  // A 2xx with no readable JSON object (empty, not JSON, a bare value or array) is not an answer.\n  if (res.ok && !(json && typeof json === 'object' && !Array.isArray(json))) {\n    throw outcomeUnknown(res.status, text ? 'body_unparseable' : 'body_empty');\n  }\n  if (res.ok && !hasActionEvidence(action, json)) throw outcomeUnknown(res.status, 'envelope_incomplete');\n\n",
  "was": "\n  const text = await res.text().catch(() => '');\n  let json = null;\n  try { json = text ? JSON.parse(text) : null; } catch { json = null; }\n\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);

function unapplyP5aModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`p5a-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyP5aIndex = (src) => unapplyP5aModule('index.js', src);

module.exports = { BASE, HUNKS, FILES, unapplyP5aModule, unapplyP5aIndex };
