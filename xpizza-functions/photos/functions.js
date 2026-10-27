// DISH PHOTOS A1 step 6 (PLAN-dish-photos r2 §2.2 E-P1 / E-P2, §2.8; advisor ruling 2026-10-26: a NEW isolation group) — the two photo
// HTTPS functions, ISOLATED. Loaded two ways: by index.js's photos early branch when FUNCTION_TARGET is one of the two (only this group
// loads), and by index.js's full load (which re-exports these same objects). Thin plumbing only: every decision lives in the tested
// cores (photos/upload-start.js, photos/process.js). sharp is NEVER required here — only lazily, inside photos/pipeline.js's
// processImage, i.e. only when photoProcess actually decodes an image (advisor ruling: never on the order path / cold start).
// Dark by default: PHOTOS_UPLOADS (RTDB config/photos_uploads_enabled) is OFF unless explicitly true → both answer photos_disabled.
require('../lib/admin');   // the ONE Admin app — before any module that may touch it, as in index.js
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { PORTAL_ORIGINS } = require('../portal/origins');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const { photosUploadsEnabled } = require('./flag');
const { photoUploadStartCore } = require('./upload-start');
const { photoProcessCore } = require('./process');
const { makeGcsSigner } = require('./signer');
const { makeGcsStore } = require('./gcs-store');
const { errorBody, ERRORS } = require('./errors');

const sendPhotoReply = (res, out) => res.status(out.status).json(out.body);
const fail = (code) => ({ status: ERRORS[code].status, body: errorBody(code) });
const randomId = () => crypto.randomBytes(15).toString('base64url');

// authorize THIS request (verified ID token → resolveAccess → the catalog.edit capability), mapped onto the photo error table
async function authorize(req, rid) {
  const a = await authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t) }, req, rid);
  if (!a.ok) return { fail: a.status === 400 ? 'bad_request' : a.status === 503 ? 'unavailable' : 'not_authorized' };
  if (!Array.isArray(a.caps) || !a.caps.includes('catalog.edit')) return { fail: 'not_authorized' };
  return { uid: a.uid };
}

async function handle(req, res, run) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const enabled = await photosUploadsEnabled(getDatabase());
    if (!enabled) return sendPhotoReply(res, fail('photos_disabled'));
    const a = await authorize(req, body.rid);
    if (a.fail) return sendPhotoReply(res, fail(a.fail));
    return sendPhotoReply(res, await run(body, a.uid, () => enabled));
  } catch (e) {
    console.error('photos_handler', e && e.message);
    return sendPhotoReply(res, fail('unavailable'));
  }
}

exports.photoUploadStart = onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 4 },
  (req, res) => handle(req, res, (body, uid, photosEnabled) => photoUploadStartCore({
    db: getFirestore(), bucket: getStorage().bucket().name, now: Date.now, newUploadId: randomId, photosEnabled,
    authorize: async () => ({ ok: true }),   // authorized above, on THIS request
    signer: makeGcsSigner({ bucket: (name) => getStorage().bucket(name) }),
  }, { uid, rid: body.rid, op_id: body.op_id, contentType: body.contentType, bytes: body.bytes })),
);

exports.photoProcess = onRequest(
  // PLAN §2.2 (P2-9): concurrency 1, 1 GiB, 60 s, capped instances — tuned later from measured peak memory only
  { region: 'us-central1', cors: PORTAL_ORIGINS, concurrency: 1, memory: '1GiB', timeoutSeconds: 60, maxInstances: 4 },
  (req, res) => handle(req, res, (body, uid, photosEnabled) => {
    const store = makeGcsStore(getStorage().bucket());
    return photoProcessCore({
      db: getFirestore(), storage: store, now: Date.now, newClaimId: randomId, photosEnabled,
      authorize: async () => ({ ok: true }),
      signRead: (path, exp) => store.signRead(path, exp),
      processImage: (buf, crops) => require('./pipeline').processImage(buf, crops),   // lazy: sharp loads only here
    }, { uid, rid: body.rid, uploadId: body.uploadId, crops: body.crops });
  }),
);
