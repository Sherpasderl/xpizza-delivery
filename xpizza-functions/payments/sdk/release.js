'use strict';
// SDK order cancellation cleanup (BRIEF r5 §8 step 5) — the NON-financial release, run only AFTER the coordinator won the order
// decision and classified every hold. It calls the existing release helpers DIRECTLY (never cancelOrderCore, which routes SDK
// orders back to the coordinator). Each step is idempotent; any failure throws so the coordinator's recorded cleanup stays
// unfinished and the sweeper resumes it. (There is no inventory reservation to release at this base: cancelOrderCore releases none.)
const { cleanupTasksAndDriver } = require('../../cancel-order-core');
const { reverseEarnForOrder } = require('../../rewards-earn');
const { reverseRedemptionForOrder } = require('../../rewards-reserve');

async function releaseSdkOrder(deps, orderId, order) {
  const now = deps.now();
  await cleanupTasksAndDriver(deps, orderId, order, now);
  const earn = await reverseEarnForOrder(deps.db, { orderId, order, now });
  if (earn && earn.ok === false) throw new Error('sdk release: earn reversal failed');
  const red = await reverseRedemptionForOrder(deps.db, { orderId, order, disposition: 'refund', now });
  if (red && red.ok === false && !red.skipped) throw new Error('sdk release: redemption reversal failed');
}
module.exports = { releaseSdkOrder };
