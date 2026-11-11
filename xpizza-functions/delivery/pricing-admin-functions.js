'use strict';
// DELIVERY PRICING WRITER (PLAN-delivery-pricing-app-only r2 §3) — the owner-only «Envío» HTTPS functions. Thin wrappers: every
// decision is in delivery/pricing-admin-core.js. Exported by index.js's full load.
require('../lib/admin');   // the ONE Admin app — before any module that may touch it, as in index.js
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('../portal/origins');
const { createRestaurantRegistry, makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const C = require('./pricing-admin-core');

let registry = null;
const registryOf = () => (registry || (registry = createRestaurantRegistry({ listIds: makeFirestoreRegistryReader(getFirestore()) })));
const deps = () => ({
  db: getDatabase(),
  verifyIdToken: (t) => getAuth().verifyIdToken(t),
  readRegistry: () => registryOf().readNow(),
  timestamp: () => ServerValue.TIMESTAMP,
});

function handler(name, core) {
  return async (req, res) => {
    try {
      const out = await core(deps(), req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error(name, e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  };
}

const OPTS = { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 2 };
exports.getDeliveryPricing = onRequest(OPTS, handler('getDeliveryPricing', C.getDeliveryPricingCore));
exports.setDeliveryPricing = onRequest(OPTS, handler('setDeliveryPricing', C.setDeliveryPricingCore));
