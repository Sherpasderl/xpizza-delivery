'use strict';
// S8 — WHO MAY MARK A DRIVER'S WEEK PAID. ONE helper, so the role is a one-line swap (advisor 2026-10-22: the owner
// decides in the mockup review; the lean is narrower than every dispatcher). DEFAULT = the S1b driver-admin gate:
// driver administration enabled (config/driver_admin_enabled) AND a dispatcher caller (not a customer token, not disabled,
// session not revoked). Returns the actor uid recorded on the payment.
const { assertAdminEnabled, assertDispatcherCaller } = require('../lib/driver-admin-ops');

async function assertCanManageDriverPay(request, { db, auth, HttpsError }) {
  const uid = request && request.auth && request.auth.uid;
  const token = request && request.auth && request.auth.token;
  await assertAdminEnabled(db, HttpsError);
  await assertDispatcherCaller(uid, token, { db, auth, HttpsError });
  return uid;
}

module.exports = { assertCanManageDriverPay };
