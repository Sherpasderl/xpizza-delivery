'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 E-P1) — the upload-signing SEAM.
// buildUploadGrant() is pure apart from the injected `signer`: it validates the request, then asks the signer for a V4 signed PUT
// bound to the method, the object, the Content-Type and two extension headers — `x-goog-content-length-range: 1,10485760` (size cap
// enforced by GCS itself) and `x-goog-if-generation-match: 0` (create-only: an upload can never overwrite an existing object). It
// returns EVERY header the client must send; the client sends exactly `url`, `method` and `headers`, nothing it invented (r2 P2-1).
// The signer is INJECTED because the Storage emulator does not sign. Production passes makeGcsSigner(storage), where `storage` is a
// @google-cloud/storage client the caller already holds (E-P1 wiring; prod signing needs the A0 signBlob grant on the functions'
// service account). Nothing here requires the Storage library, so loading this module costs nothing.

const UPLOAD_MAX_BYTES = 10485760;
const UPLOAD_URL_TTL_MS = 10 * 60 * 1000;
const ALLOWED_CONTENT_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const RID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;          // a restaurant id is a single safe path segment
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;          // server-minted; never a path

function refuse(detail) { const e = new Error(`invalid_upload_request: ${detail}`); e.code = 'invalid_upload_request'; throw e; }

const uploadObjectPath = (rid, uploadId) => `uploads/${rid}/${uploadId}`;
const extensionHeadersFor = () => ({ 'x-goog-content-length-range': `1,${UPLOAD_MAX_BYTES}`, 'x-goog-if-generation-match': '0' });

async function buildUploadGrant({ bucket, rid, uploadId, contentType, bytes, nowMs, signer }) {
  if (typeof bucket !== 'string' || !bucket) refuse('bucket');
  if (typeof rid !== 'string' || !RID_RE.test(rid)) refuse('rid');
  if (typeof uploadId !== 'string' || !UPLOAD_ID_RE.test(uploadId)) refuse('uploadId');
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) refuse('contentType');
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > UPLOAD_MAX_BYTES) refuse('bytes');
  if (typeof signer !== 'function') refuse('signer');
  if (!Number.isFinite(nowMs)) refuse('nowMs');
  const objectPath = uploadObjectPath(rid, uploadId);
  const extensionHeaders = extensionHeadersFor();
  const expiresMs = nowMs + UPLOAD_URL_TTL_MS;
  const url = await signer({ bucket, objectPath, method: 'PUT', contentType, extensionHeaders, expiresMs });
  return { uploadId, url, method: 'PUT', headers: { 'Content-Type': contentType, ...extensionHeaders }, expiresAt: expiresMs };
}

// the production signer over a caller-supplied @google-cloud/storage client: V4, path-style (virtualHostedStyle false)
function makeGcsSigner(storage) {
  return async ({ bucket, objectPath, method, contentType, extensionHeaders, expiresMs }) => {
    if (method !== 'PUT') throw new Error(`makeGcsSigner: only PUT uploads are signed (got ${method})`);
    const [url] = await storage.bucket(bucket).file(objectPath).getSignedUrl({
      version: 'v4', action: 'write', expires: expiresMs, contentType, extensionHeaders, virtualHostedStyle: false,
    });
    return url;
  };
}

module.exports = { buildUploadGrant, makeGcsSigner, uploadObjectPath, UPLOAD_MAX_BYTES, UPLOAD_URL_TTL_MS, ALLOWED_CONTENT_TYPES };
