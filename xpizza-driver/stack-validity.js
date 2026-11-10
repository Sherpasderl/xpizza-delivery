// Stacked-order SEQUENCING — the client copy of the server's stack-copy VALIDITY rule. This is a BYTE-PINNED COPY of
// xpizza-functions/sequencing/validity.js (validCopy/validPair), enforced by stack-validity.guard.test.js, so the
// driver app, the server, the tracker-derive and the out-of-sequence detector all decide coherence the SAME way
// (one rule). A stack copy counts ONLY while its provenance holds: it names THIS driver (stack_uid ===
// assigned_driver_id) and no (re)assignment happened after it was written (assigned_at <= stack_at). Every manual or
// server reassignment rewrites assigned_at, so a transfer / manual reunion / single re-assign / leftover is inert by
// itself — stale metadata never sequences. Anything else → order-time (legacy). Keep the function bodies BELOW
// byte-identical to the server's (the guard extracts and compares them); the ESM export wrappers are not compared.
// ── BEGIN COPY: validity (xpizza-functions/sequencing/validity.js) ──
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function validCopy(t) {
  return !!t && typeof t === 'object'
    && typeof t.stack_id === 'string' && t.stack_id !== ''
    && (t.stop_seq === 1 || t.stop_seq === 2)
    && typeof t.stack_uid === 'string' && t.stack_uid === t.assigned_driver_id
    && fin(t.stack_at) && fin(t.assigned_at) && t.assigned_at <= t.stack_at;
}

function validPair(a, b) {
  return validCopy(a) && validCopy(b) && a.stack_id === b.stack_id && a.stack_uid === b.stack_uid && a.stop_seq + b.stop_seq === 3;
}
// ── END COPY: validity ──

export { fin, validCopy, validPair };
