'use strict';
// LEDGER S2 (PLAN-5f-ledger-shadow-s1-r3 §5) — the CAPTURE EVIDENCE builder. The two void paths (pixelpay-confirm.js mismatch void,
// pixelpay-hosted-webhook.js voidPaid) attempt their void FIRST, exactly as before, then write the attempt update they always wrote; that
// same update now also carries payment_attempts/{aid}/capture_evidence/{confirm|webhook} = the PROVIDER-reported facts:
//   { v, amount_cents, payment_uuid, at, verified, approved, mismatch_reason }
// never the intended order amount, never `status:'captured'`, never a status / reversal marker. SYNCHRONOUS and NON-THROWING (Codex #108
// r3 #3): every field is normalized to a Firebase-valid value or null — a missing / non-finite / string / oversized provider amount is null
// (pixelpay-client.js verifyCaptureResult treats absent capture data as a verification failure) — and any throw yields the fixed
// { v:1, unparsed:true, at }, so the path's own update and outcome can never change.
const KEY_SAFE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_CENTS = 1e9;   // L 10,000,000 — anything larger is not a real capture
const keySafe = (x) => (typeof x === 'string' && KEY_SAFE.test(x) ? x : null);
const atOf = (x) => (Number.isSafeInteger(x) && x > 0 ? x : null);

function centsOf(x) {
  let lps = null;
  if (typeof x === 'number' && Number.isFinite(x)) lps = x;
  else if (typeof x === 'string' && /^\d{1,9}(\.\d{1,2})?$/.test(x)) lps = Number(x);
  if (lps === null || lps < 0) return null;
  const c = Math.round(lps * 100);
  return Number.isSafeInteger(c) && c <= MAX_CENTS ? c : null;
}

// a: { capture (the raw provider capture response) | amountLempiras, paymentUuid, at, verified, approved, mismatchReason }
function evidenceOf(a) {
  try {
    const amount = a.capture !== undefined ? (a.capture && a.capture.data ? a.capture.data.transaction_approved_amount : null) : a.amountLempiras;
    const ev = { v: 1, amount_cents: centsOf(amount), payment_uuid: keySafe(a.paymentUuid), at: atOf(a.at), verified: a.verified === true,
      approved: typeof a.approved === 'boolean' ? a.approved : null, mismatch_reason: keySafe(a.mismatchReason) };
    for (const [k, v] of Object.entries(ev)) {
      if (!(v === null || typeof v === 'boolean' || typeof v === 'string' || Number.isSafeInteger(v))) throw new Error(`capture evidence: ${k}`);
    }
    return ev;
  } catch (_) {
    return { v: 1, unparsed: true, at: a && typeof a === 'object' ? atOf(a.at) : null };
  }
}

module.exports = { evidenceOf };
