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
