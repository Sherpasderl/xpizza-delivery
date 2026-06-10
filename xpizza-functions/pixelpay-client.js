/**
 * X Pizza — PixelPay server-side transaction client (Stage 4, sub-stage 1).
 *
 * Server-to-server calls over the SDK's HTTP contract (we do NOT use the browser
 * SDK on the server — these are plain fetches):
 *   POST {endpoint}/api/v2/transaction/{action}
 *   headers: x-auth-key, x-auth-hash (+ x-auth-user for void), Accept/Content-Type: json
 *   body:    { env?, ...fields }      // env:"sandbox" required in sandbox; omitted in prod
 *   response envelope: { success, message, data, errors, code }  + HTTP status
 *
 * Roles (verified against the LIVE sandbox 2026-06-10 — see payments-probe/FINDINGS.md):
 *   - capture()  → THE authoritative confirm. Server sets the amount; the RESPONSE carries
 *                  response_approved + transaction_approved_amount + payment_hash
 *                  (== MD5(pixelpay_order_id|auth_key|secret)). A 2nd capture on a settled
 *                  uuid returns HTTP 412 with no data (→ caller routes to manual_reconciliation).
 *   - getStatus()→ LIVENESS ONLY. Returns { status, attemps, history } — NO amount/order/hash,
 *                  so it can confirm "did money move / was it reversed", never "for our order".
 *   - voidTransaction() → server-only; needs x-auth-user + void_signature.
 *
 * All crypto (payment_hash verify, void_signature, platform user) lives in ./pixelpay.
 */
const { resolvePixelPayConfig } = require('./pixelpay-config');
const ppCrypto = require('./pixelpay');

// Capture can settle real money; keep the timeout generous but bounded. A timed-out
// capture may STILL land at PixelPay — that is the lost-capture-response case the caller's
// state machine handles (capturing-claim → manual_reconciliation), never a blind retry.
const REQUEST_TIMEOUT_MS = 30000;

// Low-level POST to a transaction endpoint. Returns a normalized envelope; never throws
// for HTTP/PixelPay errors (returns { ok:false, ... }) — only network/abort rejects.
async function ppPost(action, body, extraHeaders = {}) {
  const cfg = resolvePixelPayConfig();
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-auth-key': cfg.app_key,
    'x-auth-hash': cfg.auth_hash,
    ...extraHeaders
  };
  const payload = { ...body };
  if (cfg.env) payload.env = cfg.env; // sandbox needs env in the body; prod omits

  const url = `${String(cfg.endpoint).replace(/\/+$/, '')}/api/v2/transaction/${action}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  return {
    ok: res.ok && !!(json && json.success),
    httpStatus: res.status,
    success: !!(json && json.success),
    message: json && json.message,
    code: json && json.code,
    data: (json && json.data) || null,
    errors: (json && json.errors) || null
  };
}

// ---- High-level operations ----

// CAPTURE — the authoritative confirm. `amountLempiras` is the decimal-lempira number the
// server sets (must equal the order total; capture > auth is rejected by PixelPay).
function capture({ payment_uuid, amountLempiras }) {
  return ppPost('capture', { payment_uuid, transaction_approved_amount: amountLempiras });
}

// STATUS — liveness only. data = { status, attemps, history } | null.
function getStatus({ payment_uuid }) {
  return ppPost('status', { payment_uuid });
}

// VOID — server-only. Verified vs live sandbox 2026-06-10:
//   - `void_reason` must be >= 8 chars (else 422).
//   - SANDBOX accepts void with just key+hash + {payment_uuid, void_reason}; providing a
//     void_signature/x-auth-user is REJECTED (401) by the shared sandbox account.
//   - PRODUCTION requires void_signature + x-auth-user, but the exact production signature
//     formula is UNVERIFIED here (the sandbox can't validate it) — PIN against PixelPay
//     docs / the live account before relying on production void/refund (Stage 6 gate).
function voidTransaction({ payment_uuid, pixelpayOrderId, voidReason = 'xpizza_auto_void' }) {
  const cfg = resolvePixelPayConfig();
  let reason = String(voidReason || '');
  if (reason.length < 8) reason = (reason + '_xpizza_void').slice(0, 32);

  const body = { payment_uuid, void_reason: reason };
  const headers = {};
  if (cfg.mode === 'production') {
    const auth_user = ppCrypto.platformUser(cfg.merchant_email);
    body.void_signature = ppCrypto.voidSignature(auth_user, pixelpayOrderId, cfg.secret);
    headers['x-auth-user'] = auth_user;
  }
  return ppPost('void', body, headers);
}

// ---- Interpretation helpers ----

// Verify a CAPTURE response is authoritative AND bound to our order + amount. The binding
// payment_hash comes from PixelPay's OWN response to our capture call (never the client),
// which is what makes this replay-safe.
function verifyCaptureResult(data, { pixelpayOrderId, expectedAmountLempiras }) {
  const cfg = resolvePixelPayConfig();
  if (!data) return { ok: false, reason: 'no_data' };
  const approved = data.response_approved === true;
  const amountOk = Number(data.transaction_approved_amount) === Number(expectedAmountLempiras);
  const hashOk =
    typeof data.payment_hash === 'string' &&
    ppCrypto.verifyPaymentHash(data.payment_hash, pixelpayOrderId, cfg.app_key, cfg.secret);
  const ok = approved && amountOk && hashOk;
  return {
    ok,
    approved,
    amountOk,
    hashOk,
    reason: ok ? 'verified' : !approved ? 'not_approved' : !amountOk ? 'amount_mismatch' : 'hash_mismatch'
  };
}

// Normalize a getStatus result to a coarse liveness verdict. The exact `status` enum is
// sandbox-pinned (paid seen; voided/declined/refunded TBD) — keep the raw value too.
function interpretStatus(result) {
  const status = result && result.data && result.data.status;
  return {
    status: status || null,
    paid: status === 'paid',
    reversed: status === 'voided' || status === 'refunded' || status === 'reversed',
    declined: status === 'declined' || status === 'rejected' || status === 'failed'
  };
}

module.exports = { capture, getStatus, voidTransaction, verifyCaptureResult, interpretStatus, ppPost };
