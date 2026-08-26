'use strict';

// N2 — pure decisions for sweepStalePending's paid-attempt case. A hosted attempt marked hosted_state:'paid'
// whose ORDER is still pending_payment (not confirmed/materialized) is STRANDED: the webhook captured the
// money but confirmAndMaterialize threw before the confirm-claim committed → captured money, no KDS, no notify,
// and the sweep used to just skip it (left++). N2 has the sweep RE-DRIVE the (idempotent) confirmAndMaterialize
// instead, and — bounded — flag a persistently-unrecoverable strand for a human. These pure helpers hold the
// state logic (index.js is not require-safe); the sweep does the I/O + the re-drive around them.

// PRE-redrive (P1: decide on the ORDER state, not the attempt). A paid attempt is genuinely DONE only if its
// order is confirmed or already materialized; anything else with a paid attempt is stranded → re-drive.
function isPaidStranded(order) {
  if (!order) return false;                                                          // no order → not our case
  if (order.payment_status === 'confirmed' || order.materialized_at) return false;   // genuinely done
  return true;                                                                       // paid attempt + pending order → STRANDED
}

// POST-redrive: what to do with the (re-read) order. Recovery clears the strand clock; a first-seen strand is
// stamped; a strand still unrecovered past graceMs is flagged for a human; within grace it's left for the next
// sweep. seenAt = order.paid_strand_seen_at (the first-detection timestamp).
function postRedrivePaidStrand(order, now, graceMs) {
  if (!order) return { outcome: 'leave' };
  if (order.payment_status === 'confirmed' || order.materialized_at) return { outcome: 'recovered' };
  const seen = order.paid_strand_seen_at;
  if (!Number.isFinite(seen)) return { outcome: 'stamp' };          // first detection of an unrecovered strand → start the clock
  if (now - seen > graceMs) return { outcome: 'flag' };             // still stranded past grace → manual_reconciliation + alert
  return { outcome: 'leave' };                                      // within grace → re-drive again next sweep
}

module.exports = { isPaidStranded, postRedrivePaidStrand };
