// Portal 2b-2a Task 5 — the API client.
//
// buildRequest is pure and separately exported so it can be tested in node: everything that decides
// WHERE a call goes and WHAT it carries is worth asserting, and none of it needs a browser.
//
// THE BEARER GOES IN A HEADER, NEVER THE URL. A token in a query string is written to server access
// logs, kept in browser history, and sent onward in the Referer header of any subsequent request — a
// short-lived credential leaked into three places that outlive it. This is the single most important
// line in the file.
const BASE = 'https://us-central1-xpizza-delivery.cloudfunctions.net';

// Typed failures, so the UI can say something useful rather than "error". The distinction that matters
// most is Unavailable vs NotAuthorized: one means try again, the other means this account cannot see
// this thing, and telling a merchant the wrong one sends them to re-authenticate over an outage.
export class ApiError extends Error {
  constructor(kind, status, body) {
    super(`${kind}${status ? ` (${status})` : ''}`);
    this.kind = kind; this.status = status || 0; this.body = body || null;
    // THE SERVER'S OWN ERROR CODE, surfaced as a first-class field. The typed `kind` comes from the
    // HTTP status and is too coarse on its own: `not_owner` and `fiscal_ack_required` are both 403,
    // and they need opposite actions from the merchant — tick the acknowledgement box, versus go and
    // find the owner. Telling a dispatcher "acknowledgement required" sends them to tick a box that
    // still will not let them publish.
    //
    // Only a STRING counts. A body whose `error` is an object or absent yields null rather than a
    // stringified guess, so a downstream panel lookup can never match on something the server did
    // not actually say.
    this.code = (body && typeof body.error === 'string') ? body.error : null;
  }
}
const KIND_BY_STATUS = {
  400: 'BadRequest',
  401: 'NotSignedIn',
  403: 'NotAuthorized',
  404: 'NotFound',
  409: 'Conflict',
  503: 'Unavailable',
};

export function buildRequest(fnName, { rid, body, tokenStr, params } = {}) {
  if (typeof fnName !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(fnName)) throw new Error('bad_function_name');
  if (typeof tokenStr !== 'string' || !tokenStr) throw new Error('missing_token');
  // encodeURIComponent, not interpolation: the rid comes from a server response today, but a URL built
  // by concatenation is one refactor away from carrying whatever a caller puts in it.
  // Stats S1: optional extra query `params` (strings, encoded the same way). The rid has exactly ONE
  // spelling — a params entry may not restate it, and nothing token-like may ride in the URL.
  const extra = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || /^(restaurantId|token|authorization)$/i.test(k)) throw new Error('bad_param');
    extra.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  const parts = [...(rid ? [`restaurantId=${encodeURIComponent(rid)}`] : []), ...extra];
  const qs = parts.length ? `?${parts.join('&')}` : '';
  const options = {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${tokenStr}`,     // header, never the URL
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  return { url: `${BASE}/${fnName}${qs}`, options };
}

// Maps a response to either its parsed body or a typed ApiError. Never throws a raw fetch/JSON error at
// the UI, and never treats a non-2xx as success just because it happened to parse.
// P-SELFUPDATE CP2 — the one request wrapper at every platform-function call site (advisor ruling Q6/Q7). A non-identity
// endpoint: SherpaClient.fetch passes the SAME arguments through untouched; with no module loaded, it is fetch itself.
function sherpaFetch(u, o) { const S = (typeof window !== 'undefined') ? window.SherpaClient : null; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }

export async function readResponse(res) {
  let body = null;
  try { body = await res.json(); } catch (_) { /* an empty or non-JSON body is not itself a failure */ }
  if (!res.ok) throw new ApiError(KIND_BY_STATUS[res.status] || 'Failed', res.status, body);
  return body;
}

// `assertLive` (OPTIONAL; Stats S2): a SYNCHRONOUS check run after the token await and immediately before fetch, with no
// await in between — the last moment a request can still be withheld. It throws to withhold. Absent → exactly today's path.
export async function apiFetch(fnName, { rid, body, token, params, assertLive } = {}) {
  const tokenStr = await token();
  // Not signed in is its own case, and it must not become an unauthenticated request that the server
  // rejects: the round trip tells the caller nothing they did not already know.
  if (!tokenStr) throw new ApiError('NotSignedIn', 401, null);
  if (assertLive) assertLive();
  const { url, options } = buildRequest(fnName, { rid, body, tokenStr, params });
  let res;
  try {
    res = await sherpaFetch(url, options);
  } catch (e) {
    // A network failure, a CORS rejection, a DNS problem — all indistinguishable from here, and all
    // "try again" rather than "you are not allowed".
    throw new ApiError('Unavailable', 0, null);
  }
  return readResponse(res);
}

// ── ENVÍO (PLAN-portal-envio-step1 r2 §6, Codex r1 F3) — the Sherpa-admin delivery-fee callables ─────────────────────────
// These two never throw for an HTTP answer: the caller needs the RAW outcome to tell SAVED from UNKNOWN (a 503 after a commit,
// a transport error after sending, or a 200 whose body doesn't parse are all UNKNOWN until a fresh GET decides — envio-logic.js
// classifyPost / classifyRecovery). → { status, body } | { status: 200, body: null, malformed: true } | { transport: true }.
// A missing token or a withheld call (assertLive) throws BEFORE anything is sent — nothing landed, nothing to recover.
async function rawCall(fnName, { body, token, assertLive }) {
  const tokenStr = await token();
  if (!tokenStr) throw new ApiError('NotSignedIn', 401, null);
  if (assertLive) assertLive();
  const { url, options } = buildRequest(fnName, { body, tokenStr });
  let res;
  try { res = await sherpaFetch(url, options); } catch (_) { return { transport: true }; }
  let parsed = null, parsedOk = true;
  try { parsed = await res.json(); } catch (_) { parsedOk = false; }
  if (res.status === 200 && (!parsedOk || parsed === null || typeof parsed !== 'object')) return { status: 200, body: null, malformed: true };
  return { status: res.status, body: parsedOk ? parsed : null };
}
export const getDeliveryPricingRaw = ({ token, assertLive }) => rawCall('getDeliveryPricing', { token, assertLive });
export const setDeliveryPricingRaw = ({ token, assertLive, body }) => rawCall('setDeliveryPricing', { body, token, assertLive });

// ── Portal 2b-2b — THE WRITE CALLS ───────────────────────────────────────────────────────────────
// 🔴 MONEY PATH. These two carry a merchant's price into the catalog that serves the customer order
// forms and prints on the SAR factura.
//
// Both send `restaurantId` in the BODY, not only the query string: editCatalogCore and
// publishEditedCore read `body.restaurantId`. The rid stays in the query too, encoded, because that is
// what buildRequest does for every call and the server ignores it — but the body is what is read.

// Save the draft and get back the server's diff + the edit token bound to it. Does NOT publish.
export async function editCatalog({ rid, source, baseSourceUpdateTime, token }) {
  return apiFetch('editCatalog', {
    rid,
    token,
    body: { restaurantId: rid, source, baseSourceUpdateTime },
  });
}

// Publish the reviewed draft.
//
// TWO DIFFERENT TOKENS, and the names collide. `token` is the AUTH token getter (the bearer, as in
// every other call); `editToken` is the review token verifyEditToken checks, and it travels in the
// body under the key `token`. Sending the bearer there would authenticate fine and then fail the
// re-match, surfacing as `edit_superseded` — a confusing report of a bug that is not what happened.
//
// `acknowledgedChanges` is passed through UNTOUCHED and is always sent, including when it is `[]`.
// ackMatches compares the {key,surface} set in both directions and sentinel-collapses anything that is
// not an object with string key and surface, so reshaping, filtering or re-keying the server's own
// objects would fail the publish. An OMITTED empty array is worse still: ackMatches refuses a
// non-array outright, so dropping `[]` turns a valid publish into a 400.
export async function publishEdited({ rid, editToken, acknowledgedChanges, fiscalAck, token }) {
  const out = await apiFetch('publishEdited', {
    rid,
    token,
    body: {
      restaurantId: rid,
      token: editToken,
      acknowledgedChanges,                 // verbatim, never rebuilt from what the UI rendered
      fiscalAck: fiscalAck === true,       // the server checks `!== true`, so a truthy value is not enough
    },
  });
  // PORTAL-UI 1a (codex 1a r1 P2-7): a settled publish moves the branch's PUBLISHED key set; availability.js re-reads it.
  // Notification only, after the response — the request, its body and its result are unchanged.
  try { document.dispatchEvent(new CustomEvent('portal:published', { detail: { rid } })); } catch (_) { /* never breaks a publish */ }
  return out;
}

// 1D add-product A §0.1 — "Volver al menú publicado": replace the saved draft with the published menu, conditional on the
// revision the owner saw (a draft that changed since is refused, 409 stale_edit). Owner-only on the server.
export async function resetDraftToLive({ rid, expectedRevision, token }) {
  return apiFetch('resetDraftToLive', {
    rid,
    token,
    body: { restaurantId: rid, expectedRevision },
  });
}

// ── Stats S1 — sales history (getSalesStats) ─────────────────────────────────────────────────────
// JSON: KPIs, series, breakdowns, customers, times — aggregates only (the server never returns a
// phone, name or customer key).
export async function getSalesStats({ rid, from, to, granularity, compare, token, assertLive }) {
  return apiFetch('getSalesStats', { rid, token, assertLive, params: { from, to, granularity, compare } });
}

// THE TEXT/BLOB PATH. readResponse parses JSON only; a CSV export is text, so it gets its own reader
// with the SAME failure typing (a non-2xx still becomes an ApiError from its JSON error body).
export async function readTextResponse(res) {
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
    throw new ApiError(KIND_BY_STATUS[res.status] || 'Failed', res.status, body);
  }
  const text = await res.text();
  const h = (n) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(n) : null);
  const disp = h('Content-Disposition') || '';
  const m = /filename="([^"]+)"/.exec(disp);
  return { text, filename: m ? m[1] : null, nextCursor: h('X-Next-Cursor') || null };
}

// kind: 'daily' (one row per day) | 'orders' (per-order rows, ≤ 31 days, paginated by nextCursor).
export async function fetchSalesCsv({ rid, from, to, kind = 'daily', cursor, token, assertLive }) {
  const tokenStr = await token();
  if (!tokenStr) throw new ApiError('NotSignedIn', 401, null);
  if (assertLive) assertLive();   // synchronous, immediately before fetch (see apiFetch)
  const { url, options } = buildRequest('getSalesStats', { rid, tokenStr, params: { from, to, format: 'csv', kind, cursor } });
  let res;
  try { res = await sherpaFetch(url, options); } catch (e) { throw new ApiError('Unavailable', 0, null); }
  return readTextResponse(res);
}

// ── PORTAL-UI 1a — the branch-operations endpoints (portal/ops-functions.js). Each goes through apiFetch: the Bearer in a
// header, typed failures, the optional assertLive. Additions only; nothing above changed.
export async function getMyBranches({ token, assertLive }) {
  return apiFetch('getMyBranches', { token, assertLive });
}
export async function updateBranch({ rid, expectedVersion, patch, token }) {
  return apiFetch('updateBranch', { token, body: { rid, expectedVersion, patch } });
}
export async function setBranchPause({ rid, op, dur_min, reason, token }) {
  return apiFetch('setBranchPause', { token, body: op === 'resume' ? { rid, op } : { rid, op, dur_min, reason } });
}
export async function getBranchAvailability({ rid, brandId, token, assertLive }) {
  return apiFetch('getBranchAvailability', rid ? { rid, token, assertLive } : { token, assertLive, params: { brandId } });
}
export async function setBranchAvailability({ rids, key, available, token }) {
  return apiFetch('setBranchAvailability', { token, body: { rids, key, available } });
}

// ── PLAN-portal-team-invites T-b — the owner's «Equipo de trabajo» (access/team-http-core.js). Each goes through apiFetch: the
// Bearer in a header, typed failures, the optional assertLive (the view's generation check, the last moment before fetch).
// Additions only; nothing above changed.
export async function memberList({ brandId, token, assertLive }) {
  return apiFetch('memberList', { token, assertLive, body: { brandId } });
}
export async function memberInvite({ brandId, name, email, rids, canEditMenu, token, assertLive }) {
  return apiFetch('memberInvite', { token, assertLive, body: { brandId, name, email, rids, can_edit_menu: canEditMenu === true } });
}
export async function memberReissueInvite({ inviteId, token, assertLive }) {
  return apiFetch('memberReissueInvite', { token, assertLive, body: { inviteId } });
}
export async function memberCancelInvite({ inviteId, token, assertLive }) {
  return apiFetch('memberCancelInvite', { token, assertLive, body: { inviteId } });
}
export async function memberRevoke({ brandId, uid, token, assertLive }) {   // every branch of the brand (no rid): «Quitar acceso»
  return apiFetch('memberRevoke', { token, assertLive, body: { brandId, uid } });
}
export async function memberUpdate({ brandId, uid, rids, canEditMenu, token, assertLive }) {   // «Editar»: ONE call, one transaction
  return apiFetch('memberUpdate', { token, assertLive, body: { brandId, uid, rids, can_edit_menu: canEditMenu === true } });
}
// T-d — «Enviar al dueño para publicar»: records the manager's request against the edit token editCatalog just returned (the
// server verifies the token against the current draft + pointer; it never publishes). The rid travels in the body, as the
// write calls above do.
export async function requestPublish({ rid, editToken, token }) {
  return apiFetch('catalogRequestPublish', { rid, token, body: { restaurantId: rid, token: editToken } });
}

// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §3): Equipos — list the linked handhelds; revoke one.
export async function getBranchDevices({ rid, brandId, token, assertLive }) {
  return apiFetch('getBranchDevices', rid ? { rid, token, assertLive } : { token, assertLive, params: { brandId } });
}
export async function revokeBranchDevice({ rid, uid, token }) {
  return apiFetch('revokeBranchDevice', { token, body: { rid, uid } });
}

// PORTAL-UI 1b (PLAN-portal-ui-slice1b-sucursales r4 §3.2) — the O1b branch-lifecycle endpoints (portal/branch-lifecycle-core.js).
// The token (`expectedVersion`) is OPAQUE: an integer (identity) or a string (draft), echoed exactly as E1 sent it. Bodies are
// built here and nowhere else, so the allowlist tests run against the real request builders. Additions only.
export const E6_KEYS = Object.freeze(['brand_id', 'hours', 'location_name', 'op_id', 'phone', 'prep_default_min']);
export const E7_PATCH_KEYS = Object.freeze(['hours', 'phone', 'prep_default_min']);
export async function createBranchDraft({ opId, brandId, locationName, phone, hours, prepDefaultMin, token }) {
  return apiFetch('createBranchDraft', { token, body: { op_id: opId, brand_id: brandId, location_name: locationName, phone, hours, prep_default_min: prepDefaultMin } });
}
export async function updateBranchProfile({ rid, expectedVersion, patch, token }) {
  const p = {};
  for (const k of E7_PATCH_KEYS) if (patch && Object.prototype.hasOwnProperty.call(patch, k)) p[k] = patch[k];   // never another key
  return apiFetch('updateBranchProfile', { token, body: { rid, expectedVersion, patch: p } });
}
export async function setBranchActive({ rid, expectedVersion, active, token }) {
  return apiFetch('setBranchActive', { token, body: { rid, expectedVersion, active: active === true } });
}
export async function deleteBranchDraft({ rid, expectedVersion, token }) {
  return apiFetch('deleteBranchDraft', { token, body: { rid, expectedVersion } });
}

// ── DISH PHOTOS B (PLAN-dish-photos §2.2, FROZEN) — the two photo endpoints and the signed upload. Additions only. ──────
// E-P1: authorize an upload; the answer carries EVERY header the URL was signed with (Content-Type, the size range, create-
// only). E-P2: process the uploaded bytes with the two crops (EXIF-oriented integer rects) into a pid + its draft preview.
// The rid travels in the BODY, as the contract names it. Typed failures come from apiFetch; the UI maps them by `error`.
export async function photoUploadStart({ rid, opId, contentType, bytes, token }) {
  return apiFetch('photoUploadStart', { token, body: { rid, op_id: opId, contentType, bytes } });
}
export async function photoProcess({ rid, uploadId, crops, token }) {
  return apiFetch('photoProcess', { token, body: { rid, uploadId, crops } });
}
// The signed PUT. XMLHttpRequest rather than fetch for exactly one reason: upload PROGRESS (P4's determinate bar). It sends
// exactly E-P1's `url`, `method` and `headers` and nothing it invented (§2.2 r2 P2-1) — no Authorization (the signature is the
// credential), no extra header (an unsigned one fails the signature). The URL must be the path-style Storage upload prefix,
// the only one the CSP admits (netlify.toml connect-src pins the exact bucket + uploads/ prefix; here only its brand-free
// shape). Resolves on 2xx; rejects with an ApiError (Unavailable for a network failure, 'Aborted' when the caller's signal
// fired). `onProgress(0..1)`.
export const isUploadUrl = (url) => typeof url === 'string' && /^https:\/\/storage\.googleapis\.com\/[a-z0-9._-]+\/uploads\/[^?#]+\?/.test(url);
export function putSigned({ url, method, headers }, body, { onProgress, signal, XHR } = {}) {
  return new Promise((resolve, reject) => {
    if (!isUploadUrl(url) || method !== 'PUT' || !headers || typeof headers !== 'object') {
      reject(new ApiError('BadRequest', 0, { error: 'bad_upload_target' })); return;
    }
    const Ctor = XHR || globalThis.XMLHttpRequest;
    const xhr = new Ctor();
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, String(v));
    // the fraction of THIS body that has left (its size is known here; the event's own total is the same number)
    const size = body && typeof body.size === 'number' ? body.size : 0;
    if (xhr.upload && typeof onProgress === 'function' && size > 0) {
      xhr.upload.onprogress = (e) => { if (e && typeof e.loaded === 'number') onProgress(Math.min(1, e.loaded / size)); };
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? done(resolve, { status: xhr.status })
      : done(reject, new ApiError(KIND_BY_STATUS[xhr.status] || 'Failed', xhr.status, null)));
    xhr.onerror = () => done(reject, new ApiError('Unavailable', 0, null));
    xhr.onabort = () => done(reject, new ApiError('Aborted', 0, null));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}
