'use strict';
// H1a — builds the deployable handheld functions from the injected-dependency cores. index.js re-exports each one by name in
// its single /* h1:begin */ … /* h1:end */ block (static guards and the endpoint census read those names). Region us-central1.
// Everything is DARK: every handler refuses until A1 sets platform_config/handheld_pairing_enabled and/or a location's
// order_surface to 'handheld'.
// A-R1: the module exports a FACTORY. index.js's h1 block passes { cancelCore } — the existing cancelOrderCore bound to
// cancelDeps — so no money module is required anywhere under merchant/ (merchant-no-money.guard).
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { resolveBrand } = require('./merchant-brand');
const O = require('./merchant-orders');
const L = require('./merchant-location');
const D = require('./merchant-devices');
const R = require('./merchant-reject');

const REGION = 'us-central1';
const deps = () => ({
  db: getDatabase(),
  adminAuth: getAuth(),
  resolveBrand,
  HttpsError,
  now: () => Date.now(),
  timestamp: () => ServerValue.TIMESTAMP,
  newOpId: () => `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`,
  randomId: () => crypto.randomBytes(6).toString('hex'),
});
const call = (fn) => onCall({ region: REGION }, (request) => fn(deps(), request.auth || null, request.data));
const orderAction = (action) => call((d, auth, data) => O.runOrderAction(d, auth, action, data));

module.exports = function merchantWiring({ cancelCore }) {
  if (typeof cancelCore !== 'function') throw new Error('merchant-wiring: cancelCore must be injected');
  const rejectDeps = () => ({ ...deps(), cancelCore, newClaimId: () => crypto.randomUUID() });
  return {
    merchantAccept: orderAction('accept'),
    merchantMoreTime: orderAction('more'),
    merchantReady: orderAction('ready'),
    merchantHanded: orderAction('handed'),
    // A-R1: synchronous reject → cancel. 120 s so the core can settle after the 45 s response deadline.
    merchantReject: onCall({ region: REGION, timeoutSeconds: 120 },
      (request) => R.runReject(rejectDeps(), request.auth || null, request.data, O.runOrderActionDetailed)),
    merchantOrderState: call(O.orderState),
    merchantSetBusy: call(L.setBusy),
    merchantSetPause: call(L.setPause),
    merchantSetAvailability: call(L.setAvailability),
    merchantPairDevice: call(D.pairDevice),
    merchantRevokeDevice: call(D.revokeDevice),
    merchantHeartbeat: call(D.heartbeat),
    merchantMyLocations: call(D.myLocations),
  };
};
