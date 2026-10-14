'use strict';
// PLAN-H0 (paid money on an unaccounted attempt / uncertain reversals: detect + alert + never auto-close) — the slice's
// test-only INVERSE. index.js carries 4 delimited, byte-pinned blocks `/* h0:begin <id> */ … /* h0:end <id> */` (pure insertions);
// unapplyH0Index removes them, so unapplyH0Index(index.js) === 8f1e017:index.js byte-for-byte (h0-wiring.guard). It is the NEWEST
// index.js slice: every index.js fold guard applies it FIRST. HUNKS are its exact edits in the PINNED modules
// (pixelpay-hosted-webhook.js, cancel-order-core.js, resolve-manual.js); unapplyH0Module is applied FIRST in every chain that pins them (order-control-wiring, d12-wiring),
// so any byte outside them still fails the pin. superseded-capture.js is NEW (no historical bytes): behavioural +
// mutation tests protect it (superseded-capture.test.js / test/superseded-capture.emulator.test.js).
const crypto = require('crypto');
const BASE = '8f1e017';
const BLOCKS = [
  {
    "id": "require",
    "sha": "1cf869e906f31a174a5cfce80c7ed38f239f0d765cef5f8917705245cec6833d",
    "original": ""
  },
  {
    "id": "reconcile-daily",
    "sha": "a361fc4a5ed82ba8a31e266e3d839c585f03751838b02b3d23f0444aa9411cfa",
    "original": ""
  },
  {
    "id": "sweep-fn",
    "sha": "bcc4646dc92a336d98214c9f5b5b8f37e3a7821f460427036767af9931c37d24",
    "original": ""
  },
  {
    "id": "reconciler-no-uuid",
    "sha": "ed7ddc1fb69112be4507a5c8bd13c0622853ab58a0d4b5da706a739c1fa888d0",
    "original": ""
  }
];
const rxFor = (id) => new RegExp(`[ \\t]*\\/\\* h0:begin ${id.replace(/[-]/g, '\\-')} \\*\\/\\n[\\s\\S]*?\\/\\* h0:end ${id.replace(/[-]/g, '\\-')} \\*\\/\\n(?:\\n(?=\\/\\/ ====))?`, 'g');
function unapplyH0Index(src) {
  const begins = (src.match(/\/\* h0:begin /g) || []).length;
  const ends = (src.match(/\/\* h0:end /g) || []).length;
  if (begins !== BLOCKS.length || ends !== BLOCKS.length) throw new Error(`h0-inverse: expected exactly ${BLOCKS.length} h0 index.js blocks (begin ${begins}, end ${ends})`);
  let out = src;
  for (const b of BLOCKS) {
    const found = out.match(rxFor(b.id)) || [];
    if (found.length !== 1) throw new Error(`h0-inverse: expected exactly one block ${b.id}, found ${found.length}`);
    if (crypto.createHash('sha256').update(found[0]).digest('hex') !== b.sha) throw new Error(`h0-inverse: block ${b.id} differs from its pinned bytes`);
    out = out.replace(rxFor(b.id), () => b.original);
  }
  return out;
}
const HUNKS = Object.freeze([
 {
  "file": "pixelpay-hosted-webhook.js",
  "now": "  const { db } = deps;\n  // PLAN-H0 §4 — a verified paid callback with NO payment uuid can never be reversed automatically, and must never read\n  // as 'refunded'. Park it durably for staff: the H0 sweep (superseded-capture.js) alerts it as reversal_uncertain.\n  if (!uuid) {\n    await db.ref().update({\n      [`payment_attempts/${attemptId}/status`]: 'manual_review',\n      [`payment_attempts/${attemptId}/hosted_callback_verified`]: true,\n      [`payment_attempts/${attemptId}/no_uuid_paid_callback`]: { at: now, hosted_order_id: hostedOrderId },\n      [`payment_attempts/${attemptId}/uncertain_at`]: now,\n      [`orders/${orderId}/status`]: 'cancelled',\n      [`orders/${orderId}/payment_status`]: 'manual_review',\n    });\n    return { code: 200, outcome: 'cancelled_no_uuid_manual_review' };\n  }\n  let voided = false;\n",
  "was": "  const { db } = deps;\n  let voided = false;\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "const { reverseRedemptionForOrder } = require('./rewards-reserve');   // Phase B1 — redemption hold reversal on cancel (single helper, idempotent)\nconst H0 = require('./superseded-capture');   // PLAN-H0 §4 — never auto-close over unresolved money on the order (read-only)\n\n",
  "was": "const { reverseRedemptionForOrder } = require('./rewards-reserve');   // Phase B1 — redemption hold reversal on cancel (single helper, idempotent)\n\n"
 },
 {
  "file": "cancel-order-core.js",
  "now": "  const claimed = claimTx.snapshot.val();\n\n  // PLAN-H0 §4 — BEFORE B.6 sets any attempt flag: unaccounted paid money or an uncertain reversal on ANY of the order's\n  // attempts (the claim snapshot's current evidence keys + its active attempt, each read fresh) → staff resolve it in\n  // PixelPay; automation never voids/finalizes over it. Refusal leaves no cancellation flags behind.\n  const h0 = await H0.unresolvedMoneyOnOrder(db, orderId, claimed);\n  if (h0) {\n    await releaseCancelClaim(orderRef, claimId);\n    await audit('manual_review', { reason: 'unresolved_money_on_order', attempt_id: h0.attemptId, kind: h0.kind });\n    return { status: 409, body: { ok: false, outcome: 'manual_review', order_id: orderId } };\n  }\n\n",
  "was": "  const claimed = claimTx.snapshot.val();\n\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "const MG = require('./materialize-guard');\nconst H0 = require('./superseded-capture');   // PLAN-H0 §4 — abandon never closes over money recorded on another attempt\nconst { readLiveBrand } = require('./pickup-label');   // R3-FIX D12\n",
  "was": "const MG = require('./materialize-guard');\nconst { readLiveBrand } = require('./pickup-label');   // R3-FIX D12\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "    if (action === 'abandon') {\n      if (MR.hasPaidEvidence(order, attempt) || H0.hasEvidenceKeys(order)) {   // PLAN-H0 §4: + money recorded on another attempt\n        await releaseClaim();\n",
  "was": "    if (action === 'abandon') {\n      if (MR.hasPaidEvidence(order, attempt)) {\n        await releaseClaim();\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "        if (cur === null) return null;                                  // null-first-safe (R1-#1): force server round-trip, don't abort\n        if (!cur || cur.resolving_claim_id !== claimId || cur.payment_status !== MR.resolvingStatus('abandon') || cur.paid_during_resolve === true || H0.hasEvidenceKeys(cur)) return;\n        return { ...cur, payment_status: 'abandoned', status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null };\n",
  "was": "        if (cur === null) return null;                                  // null-first-safe (R1-#1): force server round-trip, don't abort\n        if (!cur || cur.resolving_claim_id !== claimId || cur.payment_status !== MR.resolvingStatus('abandon') || cur.paid_during_resolve === true) return;\n        return { ...cur, payment_status: 'abandoned', status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null };\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "        const cur = abTx.snapshot.val() || {};\n        if (cur.paid_during_resolve === true || H0.hasEvidenceKeys(cur)) return { status: 409, body: { error: 'Se detectó un pago — usá \"Reembolsar\".', payment_uuid_present: true } };\n        return { status: 409, body: { error: 'No se pudo descartar (el estado cambió)', payment_status: cur.payment_status } };\n",
  "was": "        const cur = abTx.snapshot.val() || {};\n        if (cur.paid_during_resolve === true) return { status: 409, body: { error: 'Se detectó un pago — usá \"Reembolsar\".', payment_uuid_present: true } };\n        return { status: 409, body: { error: 'No se pudo descartar (el estado cambió)', payment_status: cur.payment_status } };\n"
 }
]);
function unapplyH0Module(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`h0-inverse: ${file}: an h0 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { unapplyH0Index, unapplyH0Module, BLOCKS, HUNKS, FILES, BASE };
