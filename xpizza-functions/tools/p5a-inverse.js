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
  "now": "  if (o === 'capture_failed' || o === 'failed' || o === 'mismatch_voided') {\n    return res.status(200).json({ ok: false, payment_status: o === 'mismatch_voided' && result.voided !== true ? 'refund_pending' : 'failed', order_id: orderId, detail: result.message || result.reason || 'payment not completed' });\n  }\n",
  "was": "  if (o === 'capture_failed' || o === 'failed' || o === 'mismatch_voided') {\n    return res.status(200).json({ ok: false, payment_status: o === 'mismatch_voided' ? 'failed' : 'failed', order_id: orderId, detail: result.message || result.reason || 'payment not completed' });\n  }\n"
 },
 {
  "file": "index.js",
  "now": "        : null;\n      if (!attempt) { left++; continue; } if (attempt.status === 'capturing') { if (await escalateStaleCapture(confirmDeps(db), { orderId, attemptId: order.active_attempt_id, now })) flagged++; else left++; continue; }   // a lost/crashed SDK capture → durable manual escalation (never re-captured, never declined)\n      if (attempt.hosted_state === 'paid') {\n",
  "was": "        : null;\n      if (!attempt) { left++; continue; }\n      if (attempt.hosted_state === 'paid') {\n"
 },
 {
  "file": "index.js",
  "now": "      const r = await voidOrRefund(deps, { orderId: a.order_id, attemptId, pixelpayOrderId, paymentUuid: a.payment_uuid, reason: 'xpizza_refund_retry', now });\n      retried++; if (r.voided) { try { const ro = (await db.ref(`orders/${a.order_id}`).once('value')).val(); if (ro) await reverseRedemptionForOrder(db, { orderId: a.order_id, order: ro, disposition: 'refund', now }); } catch (e) { console.warn(`refundReconciler: hold release failed for ${a.order_id}`, e && e.message); } }   // the refund CONFIRMED → release the hold kept secured while it was pending (idempotent)\n      if (!r.voided) {\n",
  "was": "      const r = await voidOrRefund(deps, { orderId: a.order_id, attemptId, pixelpayOrderId, paymentUuid: a.payment_uuid, reason: 'xpizza_refund_retry', now });\n      retried++;\n      if (!r.voided) {\n"
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
  "now": "\n// A capturing claim nobody finished (the capture response was lost, or the confirm crashed mid-capture) past this\n// age is ESCALATED to manual reconciliation — never re-captured from the sweep, never declined. Far above the\n// confirm's own stale window and function timeout, so an in-flight confirm is never touched.\nconst STALE_CAPTURE_ESCALATE_MS = 15 * 60 * 1000;\n\n// Sweep entry: CAS the attempt capturing → capture_unverified (only if it is still the SAME stale claim), secure the\n// redemption hold, then advertise manual_reconciliation. Returns true when it escalated.\nasync function escalateStaleCapture(deps, { orderId, attemptId, now, staleMs = STALE_CAPTURE_ESCALATE_MS }) {\n  const ref = deps.db.ref(`payment_attempts/${attemptId}`);\n  const pre = (await ref.once('value')).val();\n  if (!pre || pre.status !== 'capturing') return false;\n  if (now - (Number(pre.capturing_started_at) || 0) <= staleMs) return false;   // a missing start time counts as stale\n  const tx = await ref.transaction((cur) => {\n    if (cur === null) return null;                                               // null-first-safe\n    if (!cur || cur.status !== 'capturing' || cur.capturing_started_at !== pre.capturing_started_at) return;\n    return { ...cur, status: 'capture_unverified', manual_reason: 'stale_capturing_unrecovered', flagged_at: now };\n  });\n  if (!tx.committed) return false;\n  const order = (await deps.db.ref(`orders/${orderId}`).once('value')).val();\n  await holdRedemptionForManual(deps.db, { orderId, order, now, alert: deps.alert });\n  await deps.db.ref(`orders/${orderId}`).update({ payment_status: 'manual_reconciliation' });\n  deps.alert && deps.alert('manual_reconciliation', { orderId, attemptId, uuid: pre.payment_uuid || null, reason: 'stale_capturing_unrecovered' });\n  return true;\n}\n\nmodule.exports = { confirmOnlinePayment, confirmAndMaterialize, routeManualReconciliation, escalateStaleCapture, STALE_CAPTURE_ESCALATE_MS };\n",
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
