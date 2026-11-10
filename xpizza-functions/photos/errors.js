'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 + portal-ui Q2) — the ONE error-code table for the photo endpoints. The portal maps by
// `error`, never by status; `retryable: true` is sent ONLY on unavailable / rate_limited / in_progress / photo_publish_failed.
// `copy` / `frame` are the owner-approved texts (MOCKUP-portal-dish-photo.html, P5 / P6a-c) the portal renders for each code — kept
// here 1:1 so a code can never be added without deciding what the merchant sees. Codes without a frame of their own are mapped by
// the portal to its existing surfaces (P5 for photo_unavailable / bad_crop; the editCatalog error surface for the rest).

const P5 = 'No se pudo subir la foto.';
const ERRORS = Object.freeze({
  // E-P2 terminal image outcomes (a new, quota-charged upload is needed)
  too_large: Object.freeze({ status: 400, retryable: false, copy: 'Ese archivo pesa más de 10 MB. Elegí una foto más liviana.', frame: 'P6a' }),
  bad_type: Object.freeze({ status: 400, retryable: false, copy: 'Ese archivo no es JPG, PNG ni WEBP.', frame: 'P6b' }),
  too_small: Object.freeze({ status: 400, retryable: false, copy: 'Esa foto es muy pequeña: necesita al menos 500×440 px.', frame: 'P6c' }),
  bad_crop: Object.freeze({ status: 400, retryable: false, copy: P5, frame: 'P5' }),
  // P5 «No se pudo subir la foto.» + Reintentar
  unavailable: Object.freeze({ status: 503, retryable: true, copy: P5, frame: 'P5' }),
  upload_missing: Object.freeze({ status: 404, retryable: false, copy: P5, frame: 'P5' }),
  in_progress: Object.freeze({ status: 409, retryable: true, copy: P5, frame: 'P5' }),
  rate_limited: Object.freeze({ status: 429, retryable: true, copy: P5, frame: 'P5' }),
  // request / tenant / versioned-catalog codes (no photo frame of their own)
  op_conflict: Object.freeze({ status: 409, retryable: false, copy: null, frame: null }),
  not_authorized: Object.freeze({ status: 403, retryable: false, copy: null, frame: null }),
  photo_change_disabled: Object.freeze({ status: 409, retryable: false, copy: null, frame: null }),
  photo_publish_failed: Object.freeze({ status: 503, retryable: true, copy: null, frame: null }),
  photo_unavailable: Object.freeze({ status: 409, retryable: false, copy: P5, frame: 'P5' }),
  // §2.8: PHOTOS_UPLOADS off — E-P1 / E-P2 refuse (the portal hides the uploader when photosEnabled is absent)
  photos_disabled: Object.freeze({ status: 409, retryable: false, copy: null, frame: null }),
  // a malformed request (shape / type / bounds) — the portal never sends one; no merchant copy
  bad_request: Object.freeze({ status: 400, retryable: false, copy: null, frame: null }),
});

// the response body for a code: `{error}` plus `retryable: true` only where the table says so — never a free-text detail
function errorBody(code) {
  const e = ERRORS[code];
  if (!e) throw new Error(`unknown photo error code: ${code}`);
  return e.retryable ? { error: code, retryable: true } : { error: code };
}

// a typed failure the pipeline / endpoints throw; `detail` is for logs only (never sent)
function photoError(code, detail) {
  if (!ERRORS[code]) throw new Error(`unknown photo error code: ${code}`);
  const err = new Error(`photo_${code}${detail ? `: ${detail}` : ''}`);
  err.code = code; err.photo = true;
  return err;
}

module.exports = { ERRORS, errorBody, photoError };
