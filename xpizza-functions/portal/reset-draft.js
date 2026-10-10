// 1D add-product PHASE A §0.1 — the resetDraftToLive HTTPS function ("Volver al menú publicado"). A thin wrapper; the
// decisions live in the tested core (catalog/reset-draft.js). Deliberately NOT one of the five isolated portal
// functions (portal/functions.js): adding a sixth would rewrite the pinned early branch, export list and require graph
// for a rare recovery action. It loads with the full index.js — a slower cold start, on a path an owner takes rarely.
require('../lib/admin');
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('./origins');
const { withPreflightMaxAge } = require('./preflight-max-age');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const { resetDraftToLiveCore } = require('../catalog/reset-draft');
const { previewVersion } = require('../catalog/catalog-publish');
const { getActiveVersionId } = require('../catalog/catalog-firestore');

// The inverse of encodeUpdateTime (nanoseconds preserved), as portal/functions.js decodeUpdateTimeForEdit.
function decodeUpdateTime(v) {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new Timestamp(Number(sec), Number(nanos));
}

exports.resetDraftToLive = withPreflightMaxAge(onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 60, memory: '256MiB', maxInstances: 2 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const out = await resetDraftToLiveCore({
        db: getFirestore(),
        authorize: (rid) => authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid),
        readActiveVersionId: (fs, rid) => getActiveVersionId(fs, rid),
        previewVersion,
        toPrecondition: decodeUpdateTime,
      }, req.body || {}, req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('resetDraftToLive', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
));
