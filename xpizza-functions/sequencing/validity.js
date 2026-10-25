'use strict';
// BUILD-stacked-seq-server r5 §1 — the VALIDITY rule every reader of a stack's task copies applies (driver SDK, the server
// re-copy, derive, the out-of-sequence detector). A copy counts only while its provenance holds: it names this driver
// (stack_uid === assigned_driver_id) and no assignment happened after it was written (assigned_at <= stack_at). Every manual or
// server reassignment rewrites assigned_at, so a transfer, a manual reunion, a single re-assign and any leftover are inert by
// themselves — no cleanup writer is needed. Anything else → ignore (order-time).
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

module.exports = { validCopy, validPair };
