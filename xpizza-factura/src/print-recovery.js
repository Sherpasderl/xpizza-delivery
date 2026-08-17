'use strict';
// Pure, write-free recovery decisions for the factura print agent + reprint tool.

// A record needs a (re)print attempt when it exists, is not yet printed, and is not void.
function retryCandidate(record) {
  return !!record && !record.printed && !record.void;
}

// Manual reprint gate. Refuses the fiscal-copy case (already printed) and void/missing records.
function reprintDecision(record) {
  if (record == null) return { action: 'refuse', reason: 'not_found' };
  if (record.void)    return { action: 'refuse', reason: 'void' };
  if (record.printed) return { action: 'refuse', reason: 'already_printed' };
  return { action: 'reprint' };
}

// True when a record is flagged as already-printed-on-paper-but-not-recorded (Fix A's marker).
// Such a record must NOT be auto-(re)printed — it waits for a manual decision.
function printedAckFailed(record) {
  return !!record && typeof record.print_error === 'string' && record.print_error.startsWith('printed_ack_failed');
}

module.exports = { retryCandidate, reprintDecision, printedAckFailed };
