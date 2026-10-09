// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — the five merchant-portal HTTPS functions, isolated.
// Loaded two ways: by index.js's early branch when FUNCTION_TARGET is one of the five (only this group loads), and by
// index.js's full load (which re-exports these same objects). The three marked blocks are MOVED VERBATIM from
// index.js; the only in-block edit is the relative require-specifier rewrite './x' → '../x' (this file sits one level
// down). Sloppy mode on purpose: the moved code keeps index.js's semantics.
require('../lib/admin');   // the ONE Admin app — before any module that may touch it, as in index.js
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('./origins');
const { paymentAlert } = require('../lib/payment-alert');
const { getSalesStatsCore } = require('../stats/stats-api');
const { statsKeyer, _statsLiveCache } = require('../stats/keyer');
const { withPreflightMaxAge } = require('./preflight-max-age');
const { addProductIo } = require('../catalog/add-product-io');   // 1D add-product A — outside the moved blocks (the fold counts their requires)
const addProductIoForEdit = () => addProductIo({ fs: getFirestore(), rtdb: getDatabase() });

// ⟪moved:A — verbatim from index.js@bb37684 (relative require specifiers './' → '../')⟫
// ── Portal 2b-1 — the merchant catalog write path ──────────────────────────────────────────────
// Thin wrappers only. The handler bodies live in catalog/edit-catalog-handler.js so they can be
// TESTED: index.js cannot be imported without Firebase initialisation, and an untested handler on a
// price-and-factura path is a handler nobody has actually read. Everything below is plumbing — the
// decisions (auth, validate, CAS, diff, token) are all in the tested core.
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { previewVersion: previewVersionForEdit } = require('../catalog/catalog-publish');
const { sourceRefOf: sourceRefOfForEdit } = require('../catalog/source-store');
const { encodeUpdateTime: encodeUpdateTimeForEdit } = require('../catalog/edit-catalog-handler');
const { Timestamp: FirestoreTimestamp } = require('firebase-admin/firestore');
const { readVersionDocs: readVersionDocsForEdit, getActiveVersionId: getActiveVersionIdForEdit } = require('../catalog/catalog-firestore');
const { buildTablesFromDocs: buildTablesForEdit } = require('../catalog/catalog-transform');

// The LIVE published version, in the shape catalogDiff consumes: items + structure + extras. The diff
// must be against what is actually SERVING, not against the store — otherwise a merchant reviews their
// edit against their own previous unpublished draft and the review means nothing.
async function readActiveBuiltForEdit(rid) {
  const fs = getFirestore();
  const versionId = await getActiveVersionIdForEdit(fs, rid);
  if (versionId == null) throw new Error(`no_active_version: ${rid}`);   // fail-closed: nothing to diff against
  const [preview, docs] = await Promise.all([previewVersionForEdit(fs, rid, versionId), readVersionDocsForEdit(fs, rid, versionId)]);
  const { extras } = buildTablesForEdit(docs.itemDocs, docs.extraDocs);
  return { built: { items: preview.items, structure: preview.structure, extras }, versionId, extraRecords: preview.extras };   // 1D add-product A: + the extras' records
}

exports.editCatalog = onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 60, memory: '512MiB', maxInstances: 4 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const out = await editCatalogCore({
        db: getFirestore(),
        authorize: (rid) => authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid),
        readActiveBuilt: readActiveBuiltForEdit,
        toPrecondition: decodeUpdateTimeForEdit,
        addProduct: addProductIoForEdit(),   // 1D add-product A
      }, req.body || {}, req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('editCatalog', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);

const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion: publishVersionForEdit } = require('../catalog/catalog-publish');
const { makeRtdbMirror: makeRtdbMirrorForEdit } = require('../catalog/mirror-rtdb');

// The draft, with the updateTime the token is bound to. Read here (not inside the core) so the core
// stays free of Firestore and therefore testable.
async function readDraftForEdit(rid) {
  const snap = await sourceRefOfForEdit(getFirestore(), rid).get();
  if (!snap.exists) return { source: null, updateTime: null };
  return { source: snap.data(), updateTime: snap.updateTime ? encodeUpdateTimeForEdit(snap.updateTime) : null };
}

// The inverse of encodeUpdateTime. Nanoseconds are preserved on both sides: an ISO round trip truncates
// them, and a precondition built from a truncated time can never equal the stored updateTime — every
// conditional write would fail and no edit could ever be saved. Caught by the emulator e2e, which is
// exactly the class of bug a stub decides for itself.
function decodeUpdateTimeForEdit(v) {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new FirestoreTimestamp(Number(sec), Number(nanos));
}

exports.publishEdited = onRequest(
  /* 🔴 timeoutSeconds AND catalog-publish.js's LEASE_MS MUST MOVE TOGETHER. Both are 120s. Raise this
     one alone and a long publish outlives its own lease, then gets refused at the flip's re-read —
     correct behaviour, confusing failure, and the operator would be reading Firestore docs rather than
     looking at the constant they changed. This 120s is also what BOUNDS the flip's whole-collection
     registry reads: it trips long before any Firestore limit, loudly and atomically, which is why
     registry growth is a watch item rather than a blocker (see the read-cost note in
     catalog/catalog-publish.js). */
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 120, memory: '512MiB', maxInstances: 2 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
      const out = await publishEditedCore({
        db: getFirestore(),
        authorize: (rid) => authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid),
        readActiveBuilt: readActiveBuiltForEdit,
        readDraft: readDraftForEdit,
        publishVersion: publishVersionForEdit,
        mirror: makeRtdbMirrorForEdit(getDatabase()),
        alarm: (kind, detail) => paymentAlert(getDatabase(), kind, detail),
        addProduct: addProductIoForEdit(),   // 1D add-product A
      }, req.body || {}, req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('publishEdited', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);
// ⟪/moved:A⟫

// ⟪moved:B — verbatim from index.js@bb37684 (relative require specifiers './' → '../')⟫
// ── Portal 2b-2a — the merchant portal's READ endpoints ────────────────────────────────────────
// Thin wrappers; the decisions live in the tested core (index.js cannot be imported under Firebase
// init, and an untested handler on a tenant boundary is one nobody has read carefully).
//
// The ownership index lives in RTDB, so `db` is getDatabase() — getFirestore() would find nothing and
// every merchant would see an empty portal, which looks exactly like "you own no restaurants".
const { getMyRestaurantsCore, getEditableCatalogCore } = require('../catalog/portal-reads');
const { getActiveVersionId: getActiveVersionIdForPortal } = require('../catalog/catalog-firestore');

exports.getMyRestaurants = onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    try {
      const out = await getMyRestaurantsCore({
        db: getDatabase(),
        verifyIdToken: (t) => getAuth().verifyIdToken(t),
      }, req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('getMyRestaurants', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);

exports.getEditableCatalog = onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 },
  async (req, res) => {
    try {
      const out = await getEditableCatalogCore({
        // Owners live in RTDB and the source document lives in Firestore. Handing either the wrong
        // client is a silent failure: an RTDB-less authorize denies every owner, a Firestore-less
        // source read finds nothing.
        db: getDatabase(),
        fsdb: getFirestore(),
        authorize: (rid) => authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid),
        readActiveVersionId: (fsdb, rid) => getActiveVersionIdForPortal(fsdb, rid),
        readActiveBuilt: readActiveBuiltForEdit,   // 1D add-product A: assess the saved draft against what is serving
      }, req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('getEditableCatalog', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);
// ⟪/moved:B⟫

// ⟪moved:C — verbatim from index.js@bb37684 (relative require specifiers './' → '../')⟫
exports.getSalesStats = onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 60, memory: '512MiB', maxInstances: 10 },
  async (req, res) => {
    try {
      const out = await getSalesStatsCore({
        authorize: (rid) => authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid),
        fsdb: getFirestore(),
        rtdb: getDatabase(),
        getKeyer: statsKeyer,
        nowMs: Date.now(),
        liveCache: _statsLiveCache,
      }, req);
      if (out.contentType) {
        res.set('Content-Type', out.contentType);
        if (out.filename) res.set('Content-Disposition', `attachment; filename="${out.filename}"`);
        for (const [k, v] of Object.entries(out.headers || {})) res.set(k, v);
        res.set('Access-Control-Expose-Headers', 'X-Next-Cursor, Content-Disposition');   // the portal reads both cross-origin
        return res.status(out.status).send(out.body);
      }
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error('getSalesStats', e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);
// ⟪/moved:C⟫

// The ONLY behaviour delta of this slice: an OPTIONS preflight also carries Access-Control-Max-Age: 600. Applied
// OUTSIDE the unchanged onRequest({cors: PORTAL_ORIGINS, …}) — Firebase's cors middleware ends a preflight before any
// handler runs — and every property of the returned CloudFunction (__endpoint, the __trigger getter, …) is kept.
for (const name of ['editCatalog', 'publishEdited', 'getMyRestaurants', 'getEditableCatalog', 'getSalesStats']) {
  exports[name] = withPreflightMaxAge(exports[name]);
}
