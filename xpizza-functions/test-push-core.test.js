/**
 * Unit tests for the dispatcher self-test-push orchestration (item 2). Pure — no Firebase.
 * Run: `node --test test-push-core.test.js`. Covers auth (P2-5), the per-uid limit, and the honest HTTP
 * mapping (P2-7). One test per kept behaviour (owner trim).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runTestStaffPush, testPushRateUpdater, TEST_PUSH_PAYLOAD, TEST_PUSH_MIN_INTERVAL_MS } = require('./test-push-core.js');

const dispatcher = { ok: true, byKind: 'dispatcher', uid: 'disp-1', actor: 'disp-1' };
const okLimit = async () => ({ allowed: true, retryAfterSec: 0 });
const sendOk = async () => ({ sent: true });
const sendNoSub = async () => ({ sent: false, reason: 'no_sub' });
const sendFailed = async () => ({ sent: false, reason: 'failed', statusCode: 500 });

// ---- authorization (P2-5): dispatcher uid only; reject secret / unauth / forged target ----
test('unauthenticated (auth.ok false) → the gate code, never sends', async () => {
  let sent = false;
  const out = await runTestStaffPush({ auth: { ok: false, code: 401, msg: 'missing bearer token' }, rateLimit: okLimit, send: async () => { sent = true; } });
  assert.equal(out.httpStatus, 401);
  assert.equal(sent, false);
});
test('RECON_SECRET path (uid null, byKind recon_secret) → 403, never sends (not a device)', async () => {
  let sent = false;
  const out = await runTestStaffPush({ auth: { ok: true, uid: null, byKind: 'recon_secret' }, rateLimit: okLimit, send: async () => { sent = true; } });
  assert.equal(out.httpStatus, 403);
  assert.equal(sent, false);
});
test('ok but non-dispatcher / empty uid → 403', async () => {
  for (const auth of [{ ok: true, byKind: 'driver', uid: 'd1' }, { ok: true, byKind: 'dispatcher', uid: '' }]) {
    const out = await runTestStaffPush({ auth, rateLimit: okLimit, send: sendOk });
    assert.equal(out.httpStatus, 403);
  }
});
test('a verified dispatcher → proceeds and sends to its OWN uid (never a request target)', async () => {
  let sentUid = null;
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: okLimit, send: async (uid) => { sentUid = uid; return { sent: true }; } });
  assert.equal(out.httpStatus, 200);
  assert.equal(sentUid, 'disp-1');
});

// ---- per-uid rate limit (P2-6, simplified): refuse within 30 s with 429 + Retry-After; fail CLOSED ----
test('within the window → 429 with retryAfterSec, never sends', async () => {
  let sent = false;
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: async () => ({ allowed: false, retryAfterSec: 12 }), send: async () => { sent = true; } });
  assert.equal(out.httpStatus, 429);
  assert.equal(out.retryAfterSec, 12);
  assert.equal(sent, false);
});
test('rate limiter rejects (RTDB hiccup) → 503, fail CLOSED (diagnostic), never sends', async () => {
  let sent = false;
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: async () => { throw new Error('rtdb down'); }, send: async () => { sent = true; } });
  assert.equal(out.httpStatus, 503);
  assert.equal(sent, false);
});

// ---- honest HTTP mapping of the send result (P2-7) ----
test('sent:true → 200 { ok:true }', async () => {
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: okLimit, send: sendOk });
  assert.deepEqual([out.httpStatus, out.body], [200, { ok: true }]);
});
test('no_sub → 409 (caller hasn\'t registered on this device)', async () => {
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: okLimit, send: sendNoSub });
  assert.equal(out.httpStatus, 409);
});
test('a FAILED send (resolved, not sent) → 502, never a false 2xx', async () => {
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: okLimit, send: sendFailed });
  assert.equal(out.httpStatus, 502);
});
test('the subscription read REJECTS → 503 (handled, not a crash)', async () => {
  const out = await runTestStaffPush({ auth: dispatcher, rateLimit: okLimit, send: async () => { throw new Error('read rejected'); } });
  assert.equal(out.httpStatus, 503);
});

// ---- rate updater (transaction logic) ----
test('rate updater: stamps now when never tested / outside the window', () => {
  assert.equal(testPushRateUpdater(1000, 30000)(null), 1000);
  assert.equal(testPushRateUpdater(40000, 30000)(1000), 40000);   // 39s later → allowed
});
test('rate updater: aborts (undefined) within the window', () => {
  assert.equal(testPushRateUpdater(1000 + 29999, 30000)(1000), undefined);
});

// ---- payload (owner-approved) ----
test('payload: owner-locked title + mockup body + tag test', () => {
  assert.equal(TEST_PUSH_PAYLOAD.title, 'Prueba de notificación · Torre');
  assert.match(TEST_PUSH_PAYLOAD.body, /funcionan en este teléfono/);
  assert.equal(TEST_PUSH_PAYLOAD.tag, 'test');
  assert.equal(TEST_PUSH_MIN_INTERVAL_MS, 30000);
});
