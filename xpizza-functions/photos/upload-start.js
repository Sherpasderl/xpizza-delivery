'use strict';
// DISH PHOTOS A1 step 4 (PLAN-dish-photos r2 §2.2 E-P1, §2.7, §2.8) — photoUploadStart's CORE: deps-injected, no HTTP, no globals.
//   1. PHOTOS_UPLOADS off → photos_disabled (nothing read, nothing signed)
//   2. authorize EVERY call (resolveAccess + catalog.edit in the wiring; a revoked member's retry is refused) → not_authorized / unavailable
//   3. shape: rid / op_id / contentType ∈ jpeg|png|webp / bytes 1..10485760 → bad_request
//   4. ONE Firestore transaction keyed by {uid, rid, op_id}:
//        - an existing op → the same uploadId (a retry), or op_conflict when {contentType, bytes} differ; NOT rate-charged
//        - a new op → the FAIL-CLOSED rate limits (30 new starts / UTC hour / uid, 200 / Honduras day / rid) → rate_limited; else create
//          photo_uploads/{uploadId} {rid, uid, op_id, contentType, bytes, state:'issued', attempts:0, created_at} + the op doc + both counters
//      any transaction failure → unavailable (fail CLOSED: no URL is ever signed without the limiter having counted it)
//   5. sign the create-only PUT through the injected signer (re-signed on every retry: same object path, fresh expiry)
const crypto = require('crypto');
const { buildUploadGrant, UPLOAD_MAX_BYTES, ALLOWED_CONTENT_TYPES } = require('./signer');
const { errorBody, ERRORS } = require('./errors');
const { hnDateISO } = require('../lib/hn-date');

const RATE = Object.freeze({ PER_UID_PER_HOUR: 30, PER_RID_PER_DAY: 200 });
const RID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const fail = (code) => ({ status: ERRORS[code].status, body: errorBody(code) });
const opKeyOf = (uid, rid, opId) => crypto.createHash('sha256').update(`${uid}\n${rid}\n${opId}`).digest('hex').slice(0, 40);

async function photoUploadStartCore(deps, { uid, rid, op_id: opId, contentType, bytes }) {
  const { db, bucket, now, newUploadId, photosEnabled, authorize, signer } = deps;
  if (!photosEnabled()) return fail('photos_disabled');
  if (typeof uid !== 'string' || !UID_RE.test(uid) || typeof rid !== 'string' || !RID_RE.test(rid)
    || typeof opId !== 'string' || !OP_ID_RE.test(opId) || !ALLOWED_CONTENT_TYPES.includes(contentType)
    || !Number.isInteger(bytes) || bytes < 1 || bytes > UPLOAD_MAX_BYTES) return fail('bad_request');
  let auth;
  try { auth = await authorize({ uid, rid }); } catch (_) { auth = { ok: false, code: 'unavailable' }; }
  if (!auth || auth.ok !== true) return fail(auth && auth.code === 'not_authorized' ? 'not_authorized' : 'unavailable');

  const t = now();
  const opRef = db.collection('photo_upload_ops').doc(opKeyOf(uid, rid, opId));
  const uidRef = db.collection('photo_rate_uid').doc(`${uid}__${Math.floor(t / 3600000)}`);
  const ridRef = db.collection('photo_rate_rid').doc(`${rid}__${hnDateISO(t)}`);
  let outcome;
  try {
    outcome = await db.runTransaction(async (tx) => {
      const [op, u, r] = [await tx.get(opRef), await tx.get(uidRef), await tx.get(ridRef)];   // all reads before any write
      if (op.exists) {
        const o = op.data();
        if (o.contentType !== contentType || o.bytes !== bytes) return { code: 'op_conflict' };
        return { uploadId: o.uploadId };
      }
      const uc = u.exists ? Number(u.data().count) || 0 : 0;
      const rc = r.exists ? Number(r.data().count) || 0 : 0;
      if (uc >= RATE.PER_UID_PER_HOUR || rc >= RATE.PER_RID_PER_DAY) return { code: 'rate_limited' };
      const uploadId = newUploadId();
      tx.create(db.collection('photo_uploads').doc(uploadId), { rid, uid, op_id: opId, contentType, bytes, state: 'issued', attempts: 0, created_at: t });
      tx.create(opRef, { uid, rid, op_id: opId, uploadId, contentType, bytes, created_at: t });
      tx.set(uidRef, { count: uc + 1, uid, at: t });
      tx.set(ridRef, { count: rc + 1, rid, at: t });
      return { uploadId };
    });
  } catch (_) { return fail('unavailable'); }               // fail CLOSED
  if (outcome.code) return fail(outcome.code);

  try {
    const grant = await buildUploadGrant({ bucket, rid, uploadId: outcome.uploadId, contentType, bytes, nowMs: t, signer });
    return { status: 200, body: grant };
  } catch (_) { return fail('unavailable'); }               // the doc stands; a retry with the same op_id re-signs it
}

module.exports = { photoUploadStartCore, RATE, opKeyOf };
