'use strict';

/**
 * Pure core of the factura sequence reservation (ADR-0003). The RTDB transaction on
 * /restaurants/{rid}/factura_config/seq runs decideReserve() and commits nextSeq (or
 * aborts). Keeping the decision pure makes the concurrency/fail-closed behavior provable
 * without a live database.
 *
 * seq shape: { last_reserved: number, pending: { [orderId]: number } }
 * Dates are ISO 'YYYY-MM-DD' (lexical compare == chronological) per Codex #14.
 */

function decideReserve(seq, opts) {
  const { orderId, rangeEnd, todayISO, fechaLimiteISO } = opts;

  if (seq == null) {
    return { action: 'abort', reason: 'config_missing', reserved: null, nextSeq: undefined };
  }

  const pending = seq.pending || {};
  if (pending[orderId] != null) {
    // Already reserved for this order — idempotent, no new number, no write.
    return { action: 'idempotent', reason: null, reserved: pending[orderId], nextSeq: undefined };
  }

  if (fechaLimiteISO && todayISO > fechaLimiteISO) {
    return { action: 'abort', reason: 'expired', reserved: null, nextSeq: undefined };
  }

  const next = seq.last_reserved + 1;
  if (next > rangeEnd) {
    return { action: 'abort', reason: 'range_exhausted', reserved: null, nextSeq: undefined };
  }

  const nextSeq = { last_reserved: next, pending: { ...pending, [orderId]: next } };
  return { action: 'commit', reason: null, reserved: next, nextSeq };
}

module.exports = { decideReserve };
