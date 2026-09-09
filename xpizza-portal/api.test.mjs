// Portal 2b-2a Task 5 — the API client. Run: node --test xpizza-portal/api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { buildRequest, readResponse, apiFetch, ApiError, editCatalog, publishEdited } from './api.js';

test('the bearer goes in a HEADER and never in the URL', () => {
  // A token in a query string is written to server access logs, kept in browser history, and sent
  // onward in the Referer header of the next request — a short-lived credential leaked into three
  // places that outlive it. This is the assertion that matters most in this file.
  const { url, options } = buildRequest('getEditableCatalog', { rid: 'merch_a', tokenStr: 'TK-secret' });
  assert.strictEqual(options.headers.Authorization, 'Bearer TK-secret');
  assert.ok(!url.includes('TK-secret'), 'the token must not appear in the URL');
  assert.ok(!url.includes('Bearer'), 'nor any part of the auth header');
});

test('the url targets the right function with the rid as a query param', () => {
  const { url } = buildRequest('getEditableCatalog', { rid: 'merch_a', tokenStr: 'T' });
  assert.match(url, /^https:\/\/us-central1-xpizza-delivery\.cloudfunctions\.net\/getEditableCatalog\?restaurantId=merch_a$/);
  // no rid → no query string at all (getMyRestaurants takes none)
  assert.match(buildRequest('getMyRestaurants', { tokenStr: 'T' }).url, /\/getMyRestaurants$/);
});

test('the rid is encoded, not interpolated', () => {
  // It comes from a server response today, but a URL built by concatenation is one refactor away from
  // carrying whatever a caller puts in it.
  const { url } = buildRequest('getEditableCatalog', { rid: 'a b&x=1#f', tokenStr: 'T' });
  assert.ok(url.endsWith('restaurantId=a%20b%26x%3D1%23f'), `expected an encoded rid, got ${url}`);
  assert.ok(!url.includes('&x=1'), 'a crafted rid cannot append its own query parameter');
});

test('GET by default, POST only when there is a body', () => {
  assert.strictEqual(buildRequest('getMyRestaurants', { tokenStr: 'T' }).options.method, 'GET');
  const withBody = buildRequest('someFn', { tokenStr: 'T', body: { a: 1 } }).options;
  assert.strictEqual(withBody.method, 'POST');
  assert.strictEqual(withBody.body, '{"a":1}');
  assert.strictEqual(withBody.headers['Content-Type'], 'application/json');
  // a GET carries no body and no content-type
  assert.strictEqual(buildRequest('getMyRestaurants', { tokenStr: 'T' }).options.body, undefined);
});

test('a missing token is refused before a request is ever built', () => {
  for (const t of [undefined, null, '', 0, {}]) {
    assert.throws(() => buildRequest('getMyRestaurants', { tokenStr: t }), /missing_token/, `token ${JSON.stringify(t)} must be refused`);
  }
  // and a bogus function name cannot be used to reach some other host path
  for (const f of ['../../evil', 'a/b', '', null, 'has space']) {
    assert.throws(() => buildRequest(f, { tokenStr: 'T' }), /bad_function_name/, `function name ${JSON.stringify(f)} must be refused`);
  }
});

test('statuses map to typed kinds — an outage and a refusal are never the same thing', async () => {
  const mk = (status, body) => ({ ok: status < 400, status, json: async () => body });
  for (const [status, kind] of [[400, 'BadRequest'], [401, 'NotSignedIn'], [403, 'NotAuthorized'], [404, 'NotFound'], [409, 'Conflict'], [503, 'Unavailable'], [418, 'Failed'], [500, 'Failed']]) {
    await assert.rejects(() => readResponse(mk(status, { error: 'x' })), (e) => {
      assert.ok(e instanceof ApiError, 'a typed error');
      assert.strictEqual(e.kind, kind, `${status} → ${kind}`);
      assert.strictEqual(e.status, status, 'carrying the status');
      assert.deepStrictEqual(e.body, { error: 'x' }, 'and the server body, so the UI can be specific');
      return true;
    });
  }
  assert.notStrictEqual(KINDOF(503), KINDOF(403), 'Unavailable and NotAuthorized must stay distinct');
  function KINDOF(s) { return { 503: 'Unavailable', 403: 'NotAuthorized' }[s]; }
});

test('a 2xx returns the parsed body; a non-2xx is never treated as success just because it parsed', async () => {
  assert.deepStrictEqual(await readResponse({ ok: true, status: 200, json: async () => ({ restaurants: [] }) }), { restaurants: [] });
  // a body that PARSES but came with an error status is still a failure
  await assert.rejects(() => readResponse({ ok: false, status: 403, json: async () => ({ restaurants: ['sneaky'] }) }), /NotAuthorized/);
  // an empty / non-JSON 200 is not itself a failure
  assert.strictEqual(await readResponse({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }), null);
});

test('apiFetch: not signed in short-circuits, and a network failure is Unavailable not NotAuthorized', async () => {
  await assert.rejects(() => apiFetch('getMyRestaurants', { token: async () => null }), (e) => {
    assert.strictEqual(e.kind, 'NotSignedIn', 'no token → NotSignedIn without a round trip');
    return true;
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };   // CORS/DNS/offline look like this
  try {
    await assert.rejects(() => apiFetch('getMyRestaurants', { token: async () => 'T' }), (e) => {
      assert.strictEqual(e.kind, 'Unavailable', 'a network/CORS failure is "try again", not "you are not allowed"');
      assert.ok(e instanceof ApiError, 'and never a raw TypeError reaching the UI');
      return true;
    });
  } finally { globalThis.fetch = realFetch; }
});


// ── Portal 2b-2b Task 2 — THE WRITE CALLS ────────────────────────────────────────────────────────
// 🔴 First money-path task. These two calls are how a merchant's price reaches the catalog that serves
// the customer order forms and prints on the SAR factura. Everything the UI does downstream — which
// panel it shows, whether it re-reviews or retries — is decided from what these throw, so the typed
// kind and the server's own error code both have to survive the trip intact.

// A fetch double that records exactly what was sent, so the assertions are about the REQUEST, not
// about a mock's convenience.
function captureFetch(response) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
    return response;
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const errRes = (status, body) => ({ ok: false, status, json: async () => body });

test('editCatalog POSTs the draft with the bearer in the HEADER and the rid in the body', async () => {
  const f = captureFetch(okRes({ token: 'ET-1', diff: { changed: [] }, updateTime: 'U2' }));
  try {
    const out = await editCatalog({ rid: 'merch a/b', source: { restaurant_id: 'x' }, baseSourceUpdateTime: 'U1', token: async () => 'TK-secret' });
    assert.deepStrictEqual(out, { token: 'ET-1', diff: { changed: [] }, updateTime: 'U2' }, 'the parsed body comes back');
    const c = f.calls[0];
    assert.strictEqual(c.options.method, 'POST', 'a write is a POST — the handler refuses anything else (405)');
    assert.strictEqual(c.options.headers.Authorization, 'Bearer TK-secret', 'bearer in the header');
    assert.ok(!c.url.includes('TK-secret'), 'and NEVER in the URL — it would land in access logs, history and Referer');
    assert.ok(c.url.includes('merch%20a%2Fb'), 'the rid is encoded, not interpolated');
    // restaurantId travels in the BODY: editCatalogCore reads body.restaurantId, not the query string.
    assert.strictEqual(c.body.restaurantId, 'merch a/b', 'the handler reads the rid from the BODY');
    assert.deepStrictEqual(c.body.source, { restaurant_id: 'x' }, 'the draft source, verbatim');
    assert.strictEqual(c.body.baseSourceUpdateTime, 'U1', 'the CAS precondition — the write is conditional on it');
  } finally { f.restore(); }
});

test('publishEdited sends the edit token, the ack set verbatim, and fiscalAck as a literal true', async () => {
  const ack = [{ key: 'Pizza', surface: 'item', reason: 'swing_gt_50', old: 299, new: 900 }];
  const f = captureFetch(okRes({ versionId: 'v9' }));
  try {
    await publishEdited({ rid: 'x_pizza', editToken: 'ET-1', acknowledgedChanges: ack, fiscalAck: true, token: async () => 'TK' });
    const c = f.calls[0];
    assert.strictEqual(c.options.method, 'POST');
    assert.strictEqual(c.options.headers.Authorization, 'Bearer TK', 'the AUTH token is the bearer');
    assert.ok(!c.url.includes('ET-1') && !c.url.includes('TK'), 'neither token is ever in the URL');
    assert.strictEqual(c.body.restaurantId, 'x_pizza');
    // The name collision that is easy to get wrong: the BODY's `token` is the EDIT token (what
    // verifyEditToken checks), while the bearer is the AUTH token. Sending the wrong one here means a
    // publish that authenticates fine and then fails the re-match, which reads as "superseded".
    assert.strictEqual(c.body.token, 'ET-1', "body.token is the EDIT token, not the bearer");
    // VERBATIM. ackMatches compares {key,surface} as a set in both directions and sentinel-collapses
    // anything that is not an object with string key+surface. The client must not reshape, filter,
    // re-key or strip extra properties off the server's own objects.
    assert.deepStrictEqual(c.body.acknowledgedChanges, ack, 'the ack set is passed through untouched');
    assert.strictEqual(c.body.acknowledgedChanges[0].reason, 'swing_gt_50', '...including fields the server sent that it does not read back');
    assert.strictEqual(c.body.fiscalAck, true, 'a literal true — the server checks `!== true`, so "1" or "yes" would be refused');
  } finally { f.restore(); }
});

test('an EMPTY ack set is still sent — the seal is not the ack set', async () => {
  // A modest fiscal price edit (299→310, a 3.7% swing) produces an EMPTY largeChangeSet and still
  // requires fiscalAck. If the client dropped an empty array the server would see `undefined`, and
  // `ackMatches` refuses a non-array outright — so an omitted [] turns a valid publish into a 400.
  const f = captureFetch(okRes({ versionId: 'v10' }));
  try {
    await publishEdited({ rid: 'x_pizza', editToken: 'ET-2', acknowledgedChanges: [], fiscalAck: true, token: async () => 'TK' });
    const c = f.calls[0];
    assert.ok(Array.isArray(c.body.acknowledgedChanges), 'still an array');
    assert.deepStrictEqual(c.body.acknowledgedChanges, [], 'an empty ack set is SENT, not omitted');
    assert.ok('acknowledgedChanges' in c.body, 'the key is present — undefined is not the same as []');
  } finally { f.restore(); }
});

test('every server error code reaches the UI on .code — the panels are chosen from it', async () => {
  // Task 7 renders a designed panel per code. A client that surfaced only the HTTP status would
  // collapse not_owner and fiscal_ack_required into one 403, and they need opposite actions: tick the
  // box, versus go and find the owner.
  const CODES = [
    [409, 'stale_edit'], [409, 'edit_superseded'], [400, 'large_change_unconfirmed'],
    [403, 'not_owner'], [403, 'fiscal_ack_required'], [503, 'store_unavailable'],
    [400, 'invalid_source'], [500, 'publish_failed'],
  ];
  for (const [status, code] of CODES) {
    const f = captureFetch(errRes(status, { error: code, detail: 'why' }));
    try {
      await assert.rejects(() => publishEdited({ rid: 'r', editToken: 'E', acknowledgedChanges: [], fiscalAck: true, token: async () => 'T' }), (e) => {
        assert.ok(e instanceof ApiError, `${code} arrives typed`);
        assert.strictEqual(e.code, code, `${code} is on .code`);
        assert.strictEqual(e.status, status, '...alongside the status');
        assert.strictEqual(e.body.detail, 'why', '...and the server detail survives for the panel copy');
        return true;
      });
    } finally { f.restore(); }
  }
  // the two 403s must stay distinguishable — same kind, different code
  const a = new ApiError('NotAuthorized', 403, { error: 'not_owner' });
  const b = new ApiError('NotAuthorized', 403, { error: 'fiscal_ack_required' });
  assert.strictEqual(a.kind, b.kind, 'same typed kind');
  assert.notStrictEqual(a.code, b.code, '...but distinguishable by code, which is what the panel needs');
  // a body with no error code must not invent one
  assert.strictEqual(new ApiError('Failed', 500, null).code, null, 'no body → no code, never a guessed string');
  assert.strictEqual(new ApiError('Failed', 500, { nope: 1 }).code, null, 'a body without `error` → no code');
  assert.strictEqual(new ApiError('Failed', 500, { error: { nested: 1 } }).code, null, 'a non-string `error` is not a code');
});

test('the write calls keep the outage/refusal distinction', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    for (const call of [
      () => editCatalog({ rid: 'r', source: {}, baseSourceUpdateTime: 'U', token: async () => 'T' }),
      () => publishEdited({ rid: 'r', editToken: 'E', acknowledgedChanges: [], fiscalAck: true, token: async () => 'T' }),
    ]) {
      await assert.rejects(call, (e) => {
        assert.strictEqual(e.kind, 'Unavailable', 'a network/CORS failure is "try again"');
        assert.strictEqual(e.code, null, '...and carries no server code, because the server never answered');
        return true;
      });
    }
  } finally { globalThis.fetch = real; }
  // and not-signed-in short-circuits before any write leaves the browser
  for (const call of [
    () => editCatalog({ rid: 'r', source: {}, baseSourceUpdateTime: 'U', token: async () => null }),
    () => publishEdited({ rid: 'r', editToken: 'E', acknowledgedChanges: [], fiscalAck: true, token: async () => null }),
  ]) {
    await assert.rejects(call, (e) => { assert.strictEqual(e.kind, 'NotSignedIn'); return true; });
  }
});

test('ONLY a literal true becomes a fiscal attestation — nothing truthy is coerced into one', async () => {
  // 🔴🔴 The SAR attestation is a person's signature that the change to a fiscal document is theirs.
  // The server enforces `!== true`, and the client must not undo that by coercing on the way out: a
  // `!!fiscalAck` would turn a stray 'yes', 1, or a non-empty string into a valid attestation — a
  // signature nobody gave, on a legal document. Every other test in this file passes a literal true,
  // which is exactly why coercion is invisible without this one.
  for (const truthy of ['yes', 'true', 1, {}, [], 'on']) {
    const f = captureFetch(okRes({ versionId: 'v' }));
    try {
      await publishEdited({ rid: 'x_pizza', editToken: 'E', acknowledgedChanges: [], fiscalAck: truthy, token: async () => 'T' });
      assert.strictEqual(f.calls[0].body.fiscalAck, false,
        `fiscalAck ${JSON.stringify(truthy)} is truthy but is NOT an attestation — it must go out as false and be refused`);
    } finally { f.restore(); }
  }
  // ...and the genuine one still gets through, or the gate would be unsatisfiable
  const f = captureFetch(okRes({ versionId: 'v' }));
  try {
    await publishEdited({ rid: 'x_pizza', editToken: 'E', acknowledgedChanges: [], fiscalAck: true, token: async () => 'T' });
    assert.strictEqual(f.calls[0].body.fiscalAck, true, 'a literal true IS the attestation');
  } finally { f.restore(); }
  // absent is absent, never an accidental yes
  const g = captureFetch(okRes({ versionId: 'v' }));
  try {
    await publishEdited({ rid: 'x_pizza', editToken: 'E', acknowledgedChanges: [], token: async () => 'T' });
    assert.strictEqual(g.calls[0].body.fiscalAck, false, 'omitting fiscalAck is not attesting');
  } finally { g.restore(); }
});
