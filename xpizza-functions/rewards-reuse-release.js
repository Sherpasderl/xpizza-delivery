'use strict';
// S2 B2 (D4c-grill/item-s1/S2-DESIGN.md §2 r1 B2; OWNER RULING 2026-11-10 «keep held until resolved») — when a fresh-only card gate
// refuses a FRESH attempt, the order's reward hold may have been REUSED by this request (a retry of the same order after its
// earlier checkout ended), so the owned-only release leaves it. It is released HERE only when the earlier attempt is
// DEFINITIVELY not captured — the stale-hold sweep's own rule (rewards-reserve.js definitivelyNotCaptured: payment failed, or
// the order cancelled), and never for an SDK-flow order (the sweep's own exclusion). Anything else keeps today's behaviour:
// held, and the sweep or reconciliation resolves it — an expired checkout with no bank callback may have been paid, and
// releasing its points would let them be spent twice. An OWNED hold is the owned-only release's job, never this one's.
const { releaseRedemption, definitivelyNotCaptured } = require('./rewards-reserve');

async function releaseReusedHoldIfSafe(db, { uid, rid, orderId, owned, now }) {
  if (owned) return { released: false, reason: 'owned' };
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (order && require('./payments/sdk/flow').isSdkOrder(order)) return { released: false, reason: 'sdk_flow' };
  if (!definitivelyNotCaptured(order)) return { released: false, reason: 'possibly_captured' };
  await releaseRedemption(db, { uid, rid, orderId, now });
  return { released: true };
}

module.exports = { releaseReusedHoldIfSafe };
