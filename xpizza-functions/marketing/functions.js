'use strict';
// PLAN-3a-marketing-server r0 steps 1–2 — the portal «Marketing» HTTPS functions. Thin wrappers only: every decision is in
// marketing/offers-core.js. Exported by index.js's FULL load (inside the checkout endpoints block, the member-reads pattern); a
// FUNCTION_TARGET-isolated group (the portal-ops / photos pattern) is a follow-up at the train re-cut — it folds a new inverse into
// every index.js wiring guard.
require('../lib/admin');   // the ONE Admin app — before any module that may touch it, as in index.js
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('../portal/origins');
const { getFirestore } = require('firebase-admin/firestore');
const { makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const C = require('./offers-core');
const AN = require('./anuncio-core');

const deps = () => ({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t), now: () => Date.now(), readMirror: makeRtdbMirrorReader(getDatabase()),
  readCategoryMenu: (rid) => getRestaurantMenu(getFirestore(), rid) });   // a category offer's dishes: the ACTIVE version (save / publish only)

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

const READ_OPTS = { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 };
const WRITE_OPTS = { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 };

exports.getMarketing = onRequest(READ_OPTS, handler('getMarketing', C.getMarketingCore));
exports.marketingOfferSave = onRequest(WRITE_OPTS, handler('marketingOfferSave', C.marketingOfferSaveCore));
exports.marketingOfferSetState = onRequest(WRITE_OPTS, handler('marketingOfferSetState', C.marketingOfferSetStateCore));
exports.marketingOfferRepeat = onRequest(WRITE_OPTS, handler('marketingOfferRepeat', C.marketingOfferRepeatCore));
// step 3 — the «Anuncio», dark until platform_config/marketing.anuncio_enabled (no charge field; the ledger posts later)
exports.getAnuncioWeeks = onRequest(READ_OPTS, handler('getAnuncioWeeks', AN.getAnuncioWeeksCore));
exports.anuncioBook = onRequest(WRITE_OPTS, handler('anuncioBook', AN.anuncioBookCore));
exports.anuncioCancel = onRequest(WRITE_OPTS, handler('anuncioCancel', AN.anuncioCancelCore));
