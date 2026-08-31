'use strict';
// Pure, write-free recovery decisions for the factura print agent + reprint tool.

// A record needs a (re)print attempt when it exists, is not yet printed, and is not void.
function retryCandidate(record) {
  return !!record && !record.printed && !record.void;
}

// Manual reprint gate. Refuses the fiscal-copy case (already printed), void/missing records, AND a record
// already-printed-on-paper-but-not-recorded. The last check is its OWN gate BECAUSE printedAckFailed implies
// printed:false — without it, reprintDecision would fall through to {action:'reprint'} and the tool would clear
// the marker + queue a SECOND physical print of the same número (the automatic agent path is skip-guarded, but
// this manual path bypassed that guard). Placed after void/printed so a voided/printed record keeps its reason.
function reprintDecision(record) {
  if (record == null)         return { action: 'refuse', reason: 'not_found' };
  if (record.void)            return { action: 'refuse', reason: 'void' };
  if (record.printed)         return { action: 'refuse', reason: 'already_printed' };
  if (printedAckFailed(record)) return { action: 'refuse', reason: 'printed_ack_failed' };
  return { action: 'reprint' };
}

// True when a record is flagged as already-printed-on-paper-but-not-recorded (Fix A's marker).
// Such a record must NOT be auto-(re)printed — it waits for a manual decision.
function printedAckFailed(record) {
  return !!record && typeof record.print_error === 'string' && record.print_error.startsWith('printed_ack_failed');
}

module.exports = { retryCandidate, reprintDecision, printedAckFailed };
