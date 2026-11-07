'use strict';
// The payment-alert sanitize slice (fix/payment-alert-sanitize) — the test-only INVERSE for its edits to pixelpay-cancel.js and pixelpay-confirm.js,
// which older fold guards pin byte-for-byte. Generated from `git diff -U1 8a31e2a3` (each hunk carries one line of context each
// side, so it is unique); applying it returns the file to 8a31e2a3 byte-for-byte (alertsan-wiring.guard). NEWEST layer: applied
// FIRST (innermost) at every per-file fold; it passes every file it does not own through untouched.
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {
  "file": "pixelpay-cancel.js",
  "now": "\n// The provider's own words never leave this module: every record, alert and result carries a FIXED message and a short code\n// derived from what was observed. PixelPay's own `code` passes only through this allowlist — empty until its codes are\n// confirmed from PixelPay's documentation; anything else reads 'unknown' (absent: 'none').\nconst PROVIDER_CODES = Object.freeze({});\nconst VOID_MESSAGES = Object.freeze({\n  voided: 'void confirmed',\n  provider_declined: 'void declined by the provider',\n  provider_http_error: 'void request failed at the provider',\n  provider_unreachable: 'void request did not complete',\n  // our client's own PIXELPAY_OUTCOME_UNKNOWN reasons (not provider text): the same outcome, its diagnostic kept as the code\n  envelope_incomplete: 'void request did not complete',\n  body_empty: 'void request did not complete',\n  body_unparseable: 'void request did not complete',\n  body_read_failed: 'void request did not complete',\n  no_payment_to_void: 'no payment to void',\n});\nconst OUTCOME_UNKNOWN_REASONS = new Set(['envelope_incomplete', 'body_empty', 'body_unparseable', 'body_read_failed']);\nfunction providerCode(raw) {\n  if (raw === undefined || raw === null || raw === '') return 'none';\n  const k = String(raw);\n  return Object.prototype.hasOwnProperty.call(PROVIDER_CODES, k) ? PROVIDER_CODES[k] : 'unknown';\n}\nfunction classifyVoid(vd) {\n  if (vd && vd.ok) return { code: 'voided', provider_code: providerCode(vd.code) };\n  const http = vd && Number(vd.httpStatus);\n  return { code: Number.isFinite(http) && (http < 200 || http >= 300) ? 'provider_http_error' : 'provider_declined', provider_code: providerCode(vd && vd.code) };\n}\n\nasync function voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId, paymentUuid, reason, now }) {\n",
  "was": "\nasync function voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId, paymentUuid, reason, now }) {\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "  let message = null;\n  let code = null;\n  let pcode = 'none';\n\n",
  "was": "  let message = null;\n\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "      voided = !!vd.ok;\n      ({ code, provider_code: pcode } = classifyVoid(vd));\n    } catch (e) {\n      code = e && e.code === 'PIXELPAY_OUTCOME_UNKNOWN' && OUTCOME_UNKNOWN_REASONS.has(e.reason) ? e.reason : 'provider_unreachable';\n    }\n",
  "was": "      voided = !!vd.ok;\n      message = vd.message || (vd.errors ? JSON.stringify(vd.errors) : null);\n    } catch (e) {\n      message = (e && e.message) || 'void_error';\n    }\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "    voided = true;\n    code = 'no_payment_to_void';\n  }\n  message = VOID_MESSAGES[code];\n\n",
  "was": "    voided = true;\n    message = 'no_payment_to_void';\n  }\n\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "      message,\n      code,\n      provider_code: pcode,\n      at: now\n",
  "was": "      message,\n      at: now\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "    // The audit write failing must not strand the void result; log via alert.\n    deps.alert && deps.alert('refund_audit_write_failed', { orderId, attemptId, error: 'audit_write_failed' });\n  }\n",
  "was": "    // The audit write failing must not strand the void result; log via alert.\n    deps.alert && deps.alert('refund_audit_write_failed', { orderId, attemptId, error: e && e.message });\n  }\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "    refund_message: message,\n    refund_code: code,\n    reversing_phase: null                                            // clear the phase marker on the terminal write\n",
  "was": "    refund_message: message,\n    reversing_phase: null                                            // clear the phase marker on the terminal write\n"
 },
 {
  "file": "pixelpay-cancel.js",
  "now": "  if (!voided) {\n    deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message, code, provider_code: pcode });\n  }\n  return { outcome: voided ? 'refunded' : 'refund_pending', voided, message, code };\n}\n\n// A capture decline's FIXED text and code (the decision itself is the caller's and does not change).\nconst CAPTURE_MESSAGES = Object.freeze({ capture_declined: 'capture declined by the provider', capture_not_found: 'capture not found' });\nfunction captureDecline(code, cap) { return { decline_message: CAPTURE_MESSAGES[code], decline_code: code, provider_code: providerCode(cap && cap.code) }; }\n\nmodule.exports = { voidOrRefund, VOID_MESSAGES, PROVIDER_CODES, CAPTURE_MESSAGES, captureDecline };\n",
  "was": "  if (!voided) {\n    deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message });\n  }\n  return { outcome: voided ? 'refunded' : 'refund_pending', voided, message };\n}\n\nmodule.exports = { voidOrRefund };\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    }\n    await attemptRef.update({ status: 'declined', failed_at: now, ...require('./pixelpay-cancel').captureDecline('capture_not_found', cap) });\n    await orderRef.update({ payment_status: 'failed' });\n    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'release', now });   // [C/#15] definitive not-captured (PixelPay queried → declined/failed) → release the redemption hold promptly\n    return { outcome: 'capture_failed', message: require('./pixelpay-cancel').CAPTURE_MESSAGES.capture_not_found };\n  }\n",
  "was": "    }\n    await attemptRef.update({ status: 'declined', failed_at: now, decline_message: cap.message || 'capture_not_found' });\n    await orderRef.update({ payment_status: 'failed' });\n    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'release', now });   // [C/#15] definitive not-captured (PixelPay queried → declined/failed) → release the redemption hold promptly\n    return { outcome: 'capture_failed', message: cap.message || 'capture not found' };\n  }\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    // Declined / amount>auth / etc. — no money moved. Open for COD fallback.\n    await attemptRef.update({ status: 'declined', failed_at: now, ...require('./pixelpay-cancel').captureDecline('capture_declined', cap) });\n    await orderRef.update({ payment_status: 'failed' });\n    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'release', now });   // [C/#15] definitive not-captured (PixelPay queried → declined/failed) → release the redemption hold promptly\n    return { outcome: 'capture_failed', message: require('./pixelpay-cancel').CAPTURE_MESSAGES.capture_declined };\n  }\n",
  "was": "    // Declined / amount>auth / etc. — no money moved. Open for COD fallback.\n    await attemptRef.update({ status: 'declined', failed_at: now, decline_message: cap.message || null });\n    await orderRef.update({ payment_status: 'failed' });\n    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'release', now });   // [C/#15] definitive not-captured (PixelPay queried → declined/failed) → release the redemption hold promptly\n    return { outcome: 'capture_failed', message: cap.message };\n  }\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
function unapplyAlertSanModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`alertsan-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, FILES, unapplyAlertSanModule };
