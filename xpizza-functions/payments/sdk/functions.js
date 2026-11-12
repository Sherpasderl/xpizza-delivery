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

// D4 S7 (a)/(d): the HTTP + recovery functions over endpoints.makeHandlers. ONLY status and switch get the PSP deps (they can
// reach the provider ⇒ SDK_PP_CONFIG); cards, the flag and recovery get plain deps (no provider, no PSP secret); the recovery
// three bind SDK_OTP_SENDER + OTP_SALT (NEW functions: the secret, never a plain env)
const { onRequest } = require('firebase-functions/v2/https');
const { onValueCreated } = require('firebase-functions/v2/database');
const { defineSecret } = require('firebase-functions/params');
const { SDK_OTP_SENDER } = require('./secrets');
const OTP_SALT = defineSecret('OTP_SALT');
const PSP_HANDLERS = new Set(['placeSdkStatus', 'cancelSdkPending']);
const depsFor = (name) => {
  const db = getDatabase();
  const verifyIdToken = (t) => require('firebase-admin/auth').getAuth().verifyIdToken(t);
  if (PSP_HANDLERS.has(name)) return { ...require('./deps').productionDeps(db), verifyIdToken };
  const EP = require('./endpoints');
  let sender = null; try { sender = EP.parseSender(SDK_OTP_SENDER.value()); } catch (_) { sender = null; }
  return { db, clock: () => Date.now(), verifyIdToken, senderConfig: () => sender };
};
const handlerOf = (name) => (...a) => require('./endpoints').makeHandlers(() => depsFor(name))[name](...a);
const HTTP = { region: 'us-central1', cors: true, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 };
exports.placeSdkStatus = onRequest({ ...HTTP, secrets: [SDK_PP_CONFIG] }, handlerOf('placeSdkStatus'));
exports.cancelSdkPending = onRequest({ ...HTTP, secrets: [SDK_PP_CONFIG] }, handlerOf('cancelSdkPending'));
exports.listCards = onRequest(HTTP, handlerOf('listCards'));
exports.removeCard = onRequest(HTTP, handlerOf('removeCard'));
exports.sdkPayStatus = onRequest(HTTP, handlerOf('sdkPayStatus'));
exports.recoverOrderAccess = onRequest({ ...HTTP, secrets: [SDK_OTP_SENDER, OTP_SALT] }, handlerOf('recoverOrderAccess'));
exports.processSdkRecovery = onValueCreated({ ref: '/sdk_recovery_queue/{id}', region: 'us-central1', memory: '256MiB', secrets: [SDK_OTP_SENDER, OTP_SALT] }, (event) => handlerOf('processSdkRecovery')(event));
exports.sweepSdkRecovery = onSchedule({ schedule: 'every 10 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB', secrets: [SDK_OTP_SENDER, OTP_SALT] }, () => handlerOf('sweepSdkRecovery')());
exports.ENDPOINT_EXPORTS = Object.freeze(['placeSdkStatus', 'cancelSdkPending', 'listCards', 'removeCard', 'sdkPayStatus', 'recoverOrderAccess', 'processSdkRecovery', 'sweepSdkRecovery']);

exports.settleSdkOnStatus = onValueWritten({ ref: '/orders/{orderId}/status', region: 'us-central1', memory: '256MiB', secrets: [SDK_PP_CONFIG] }, async (event) => {
  const after = event.data.after.val();
  if (after !== 'delivered' && after !== 'completed') return;
  const db = getDatabase();
  const order = (await db.ref(`orders/${event.params.orderId}`).once('value')).val();
  if (!require('./flow').isSdkOrder(order)) return;
  await require('./coordinator').settleTerminal(require('./deps').productionDeps(db), { orderId: event.params.orderId });
});
