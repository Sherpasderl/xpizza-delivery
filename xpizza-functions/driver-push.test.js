/**
 * Unit tests for the pure driver-push decision helpers (Step 2a).
 * Run: `node driver-push.test.js`.
 *
 * These cover the transport-selection / reachability / error-classification
 * logic that drives dual-transport push (FCM + web-push fallback). The db /
 * admin.messaging() wrappers in index.js stay thin and are verified on deploy.
 */
const assert = require('assert');
const {
  computePushReachable,
  selectTransports,
  isTerminalFcmError,
  isTerminalWebPushError,
  buildFcmMessage,
  validateTokenOwner
} = require('./driver-push');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ---- computePushReachable ----
// Reachable via push = a usable FCM token OR a real web subscription.
// The driver profile defaults push_subscription to `{}` (empty object), which
// must NOT count as reachable. A real web subscription carries an `endpoint`.
{
  assert.strictEqual(
    computePushReachable({ push_subscription: {}, fcm_token: null }), false,
    'empty {} subscription + no fcm → not reachable');
  ok('reachable: empty {} subscription is not reachable');

  assert.strictEqual(
    computePushReachable({ push_subscription: null, fcm_token: null }), false,
    'null subscription + no fcm → not reachable');
  ok('reachable: null subscription is not reachable');

  assert.strictEqual(
    computePushReachable({}), false,
    'no fields at all → not reachable');
  ok('reachable: missing fields → not reachable');

  assert.strictEqual(
    computePushReachable({ push_subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: {} } }), true,
    'real web subscription (has endpoint) → reachable');
  ok('reachable: real web subscription is reachable');

  assert.strictEqual(
    computePushReachable({ fcm_token: 'tok-123' }), true,
    'fcm token present, no web sub → reachable');
  ok('reachable: fcm token alone is reachable');

  assert.strictEqual(
    computePushReachable({ push_subscription: { endpoint: 'https://x' }, fcm_token: 'tok' }), true,
    'both transports → reachable');
  ok('reachable: both transports is reachable');

  assert.strictEqual(
    computePushReachable({ fcm_token: '' }), false,
    'empty-string fcm token → not reachable');
  ok('reachable: empty-string fcm token is not reachable');
}

// ---- selectTransports ----
// Ordered list of transports to attempt for a driver, FCM first then web.
// sendDriverPush walks this list until one send succeeds.
{
  assert.deepStrictEqual(
    selectTransports({ fcm_token: 't', push_subscription: { endpoint: 'x' } }), ['fcm', 'web'],
    'both present → fcm then web');
  ok('transports: both → [fcm, web]');

  assert.deepStrictEqual(
    selectTransports({ fcm_token: 't' }), ['fcm'],
    'fcm only');
  ok('transports: fcm only → [fcm]');

  assert.deepStrictEqual(
    selectTransports({ push_subscription: { endpoint: 'x' } }), ['web'],
    'web only');
  ok('transports: web only → [web]');

  assert.deepStrictEqual(
    selectTransports({ push_subscription: {} }), [],
    'empty {} subscription → no transports');
  ok('transports: empty {} subscription → []');

  assert.deepStrictEqual(
    selectTransports({}), [],
    'nothing → no transports');
  ok('transports: nothing → []');
}

// ---- isTerminalFcmError ----
// Terminal = the token is permanently dead → clear it. Transient = keep the
// token (retry later / fall back this time, but do NOT delete).
{
  for (const code of [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument'
  ]) {
    assert.strictEqual(isTerminalFcmError({ code }), true, `${code} is terminal`);
  }
  ok('fcm error: dead/invalid-token codes are terminal');

  for (const code of [
    'messaging/internal-error',
    'messaging/server-unavailable',
    'messaging/quota-exceeded',
    'messaging/unavailable'
  ]) {
    assert.strictEqual(isTerminalFcmError({ code }), false, `${code} is transient`);
  }
  ok('fcm error: server/quota codes are transient (token kept)');

  assert.strictEqual(isTerminalFcmError(new Error('socket hang up')), false,
    'a bare network error is transient');
  ok('fcm error: bare/unknown error is transient');

  assert.strictEqual(isTerminalFcmError(null), false, 'null error is not terminal');
  ok('fcm error: null → not terminal');
}

// ---- isTerminalWebPushError ----
// Preserves existing behavior: web-push 404/410 → dead subscription, clear it.
{
  assert.strictEqual(isTerminalWebPushError({ statusCode: 404 }), true, '404 Gone');
  assert.strictEqual(isTerminalWebPushError({ statusCode: 410 }), true, '410 Not Found');
  ok('webpush error: 404/410 are terminal');

  assert.strictEqual(isTerminalWebPushError({ statusCode: 429 }), false, '429 is transient');
  assert.strictEqual(isTerminalWebPushError({ statusCode: 500 }), false, '500 is transient');
  assert.strictEqual(isTerminalWebPushError({}), false, 'no status → transient');
  ok('webpush error: 429/500/none are transient');
}

// ---- buildFcmMessage ----
// Builds the admin.messaging() message. Invariants that bite at runtime:
//   - every `data` value MUST be a string (FCM rejects non-string data)
//   - android priority 'high' + a notification channel → wakes a locked phone
//   - collapseKey == tag → a later banner replaces the earlier one (web parity)
{
  const msg = buildFcmMessage('tok-1', {
    title: '¡Nuevo pedido!',
    body: 'Cliente · L250',
    tag: 'order-PZX-1',
    data: { order_id: 12345, cancelled: true }   // deliberately non-string
  });

  assert.strictEqual(msg.token, 'tok-1', 'carries the target token');
  assert.strictEqual(msg.notification.title, '¡Nuevo pedido!');
  assert.strictEqual(msg.notification.body, 'Cliente · L250');

  // every data value stringified (the load-bearing invariant)
  for (const [k, v] of Object.entries(msg.data)) {
    assert.strictEqual(typeof v, 'string', `data.${k} must be a string, got ${typeof v}`);
  }
  assert.strictEqual(msg.data.order_id, '12345', 'order_id stringified for deep-link');
  assert.strictEqual(msg.data.cancelled, 'true', 'boolean stringified');

  assert.strictEqual(msg.android.priority, 'high', 'high priority wakes a locked phone');
  assert.ok(msg.android.notification.channelId, 'has a notification channel id');
  assert.strictEqual(msg.android.collapseKey, 'order-PZX-1', 'collapseKey == tag');
  assert.strictEqual(msg.android.notification.tag, 'order-PZX-1', 'notification tag == tag');
  ok('buildFcmMessage: token + notification + string data + high-priority + collapse');

  // empty/omitted data → still a valid (empty) data object, never undefined values
  const bare = buildFcmMessage('t', { title: 'x', body: 'y', tag: 'order-2' });
  assert.deepStrictEqual(bare.data, {}, 'missing data → empty object');
  ok('buildFcmMessage: missing data → {}');
}

// ---- validateTokenOwner ----
// Shared-phone guard: only act on a token whose owner_uid matches the signed-in
// driver. A token re-registered under a different account must not be sent to.
{
  assert.strictEqual(validateTokenOwner('u1', { owner_uid: 'u1', token: 't' }), true,
    'owner_uid matches → ok');
  ok('owner: matching owner_uid is valid');

  assert.strictEqual(validateTokenOwner('u1', { owner_uid: 'u2', token: 't' }), false,
    'owner_uid mismatch → reject');
  ok('owner: mismatched owner_uid is rejected');

  assert.strictEqual(validateTokenOwner('u1', null), false, 'no record → reject');
  assert.strictEqual(validateTokenOwner('u1', { token: 't' }), false, 'no owner_uid → reject');
  ok('owner: missing record/owner_uid is rejected');
}

console.log(`\n${pass} passed`);
