'use strict';
// H1c-server (PLAN-H1c r3 + codex r4, APPROVED) — the deployable handheld-push functions. index.js re-exports each by name in its
// single /* h1c:begin */ … /* h1c:end */ block (static guards and the endpoint census read those names). Region us-central1.
// DARK like H1a: a device can only register / reconcile through authorizeHandheld (pairing gate + surface), and the triggers send
// only to locations whose order_surface is 'handheld'. A plain exports object (runtime-vs-source discovery reads the names).
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const { resolveBrand } = require('./merchant-brand');
const IO = require('./merchant-push-io');

const REGION = 'us-central1';
const deps = () => ({ db: getDatabase(), resolveBrand, HttpsError, now: () => Date.now(), messaging: getMessaging(), queryLocationOrders: IO.queryLocationOrders });
const call = (fn) => onCall({ region: REGION }, (request) => fn(deps(), request.auth || null, request.data));

module.exports = {
  merchantRegisterPush: call(IO.registerPush),
  merchantUnregisterPush: call(IO.unregisterPush),
  merchantPendingOrders: call(IO.pendingOrders),
  // two NARROW subscriptions (never the order parent: that would fire on every order write)
  merchantPushOnStatus: onValueWritten({ ref: '/orders/{orderId}/status', region: REGION }, (event) => IO.onStatusWritten(deps(), event)),
  merchantPushOnAnswered: onValueWritten({ ref: '/orders/{orderId}/handheld_answered', region: REGION }, (event) => IO.onAnsweredWritten(deps(), event)),
};
