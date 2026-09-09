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

export function buildRequest(fnName, { rid, body, tokenStr } = {}) {
  if (typeof fnName !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(fnName)) throw new Error('bad_function_name');
  if (typeof tokenStr !== 'string' || !tokenStr) throw new Error('missing_token');
  // encodeURIComponent, not interpolation: the rid comes from a server response today, but a URL built
  // by concatenation is one refactor away from carrying whatever a caller puts in it.
  const qs = rid ? `?restaurantId=${encodeURIComponent(rid)}` : '';
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
export async function readResponse(res) {
  let body = null;
  try { body = await res.json(); } catch (_) { /* an empty or non-JSON body is not itself a failure */ }
  if (!res.ok) throw new ApiError(KIND_BY_STATUS[res.status] || 'Failed', res.status, body);
  return body;
}

export async function apiFetch(fnName, { rid, body, token } = {}) {
  const tokenStr = await token();
  // Not signed in is its own case, and it must not become an unauthenticated request that the server
  // rejects: the round trip tells the caller nothing they did not already know.
  if (!tokenStr) throw new ApiError('NotSignedIn', 401, null);
  const { url, options } = buildRequest(fnName, { rid, body, tokenStr });
  let res;
  try {
    res = await fetch(url, options);
  } catch (e) {
    // A network failure, a CORS rejection, a DNS problem — all indistinguishable from here, and all
    // "try again" rather than "you are not allowed".
    throw new ApiError('Unavailable', 0, null);
  }
  return readResponse(res);
}

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
  return apiFetch('publishEdited', {
    rid,
    token,
    body: {
      restaurantId: rid,
      token: editToken,
      acknowledgedChanges,                 // verbatim, never rebuilt from what the UI rendered
      fiscalAck: fiscalAck === true,       // the server checks `!== true`, so a truthy value is not enough
    },
  });
}
