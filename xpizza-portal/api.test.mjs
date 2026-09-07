// Portal 2b-2a Task 5 — the API client. Run: node --test xpizza-portal/api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { buildRequest, readResponse, apiFetch, ApiError } from './api.js';

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
