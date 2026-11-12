'use strict';
// The SDK payments Cloud Functions (BRIEF r5 §1, D5): a 5-minute bounded sweeper and a status trigger. Both call the SAME
// idempotent coordinator functions; the sweeper never depends on the trigger.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueWritten } = require('firebase-functions/v2/database');
const { getDatabase } = require('firebase-admin/database');
// D4 (PLAN-sdk-d4-r4 row 16): every function that can reach the SDK provider declares the SDK config secret
const { SDK_PP_CONFIG } = require('./secrets');

exports.sweepSdkPayments = onSchedule({ schedule: 'every 5 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB', secrets: [SDK_PP_CONFIG] }, async () => {
  const out = await require('./sweeper').sweepSdkPayments(require('./deps').productionDeps(getDatabase()));
  console.log(`sweepSdkPayments: visited=${out.visited} closed=${out.closed} failed=${out.failed}`);
});

exports.settleSdkOnStatus = onValueWritten({ ref: '/orders/{orderId}/status', region: 'us-central1', memory: '256MiB', secrets: [SDK_PP_CONFIG] }, async (event) => {
  const after = event.data.after.val();
  if (after !== 'delivered' && after !== 'completed') return;
  const db = getDatabase();
  const order = (await db.ref(`orders/${event.params.orderId}`).once('value')).val();
  if (!require('./flow').isSdkOrder(order)) return;
  await require('./coordinator').settleTerminal(require('./deps').productionDeps(db), { orderId: event.params.orderId });
});
