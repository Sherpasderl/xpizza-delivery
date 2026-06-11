/**
 * Pure decision helpers for dual-transport driver push (Step 2a).
 *
 * These are deliberately free of any Firebase Admin / messaging / db calls so
 * they can be unit-tested with plain `node driver-push.test.js` (same idiom as
 * pixelpay-webhook.js). The thin db / admin.messaging() wrappers live in
 * index.js and compose these.
 */

/**
 * Is a driver reachable via push? True when they hold a usable FCM token OR a
 * real web-push subscription. The driver profile defaults push_subscription to
 * `{}` (empty object), which must NOT count — a real subscription carries an
 * `endpoint`. Drives the materialized `/drivers/{uid}/push_reachable` flag that
 * dispatch reads (tokens themselves are not world-readable).
 */
function computePushReachable(driver) {
  if (!driver) return false;
  const hasFcm = typeof driver.fcm_token === 'string' && driver.fcm_token.length > 0;
  const sub = driver.push_subscription;
  const hasWeb = !!(sub && typeof sub === 'object' && sub.endpoint);
  return hasFcm || hasWeb;
}

/**
 * Ordered transports to attempt for a driver — FCM first, then web-push.
 * sendDriverPush walks this until one send succeeds (fall back on ANY failure
 * of the earlier transport).
 */
function selectTransports(driver) {
  const out = [];
  if (driver) {
    if (typeof driver.fcm_token === 'string' && driver.fcm_token.length > 0) out.push('fcm');
    const sub = driver.push_subscription;
    if (sub && typeof sub === 'object' && sub.endpoint) out.push('web');
  }
  return out;
}

// FCM error codes that mean the token is permanently dead → clear it. Anything
// else (server/quota/network) is transient: fall back this time, keep the token.
const TERMINAL_FCM_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument'
]);

function isTerminalFcmError(err) {
  return !!(err && TERMINAL_FCM_CODES.has(err.code));
}

/** web-push: 404 Not Found / 410 Gone → dead subscription, clear it. */
function isTerminalWebPushError(err) {
  return !!(err && (err.statusCode === 404 || err.statusCode === 410));
}

// The high-importance Android notification channel the native app must create
// for new-order alerts to wake a locked phone. Kept in sync with the app.
const FCM_CHANNEL_ID = 'orders';
const PUSH_TTL_SECONDS = 600; // 10 min, matches the web-push TTL

/**
 * Build an admin.messaging() message for a single device token. Coerces every
 * `data` value to a string (FCM rejects non-string data values at send time)
 * and sets high priority + a notification channel so a backgrounded/locked
 * phone is woken; collapseKey == tag gives the same replace-prior-banner
 * behaviour the web-push `tag` provides.
 */
function buildFcmMessage(token, { title, body, tag, data } = {}) {
  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined || v === null) continue;
    stringData[k] = String(v);
  }
  return {
    token,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      ttl: PUSH_TTL_SECONDS * 1000, // android.ttl is milliseconds
      collapseKey: tag,
      notification: { tag, channelId: FCM_CHANNEL_ID }
    }
  };
}

/**
 * Shared-phone guard: only act on a token record whose `owner_uid` matches the
 * signed-in driver. Prevents pushing one driver's order to a phone now logged
 * in as a different driver.
 */
function validateTokenOwner(uid, tokenRecord) {
  return !!(tokenRecord && tokenRecord.owner_uid && tokenRecord.owner_uid === uid);
}

module.exports = {
  computePushReachable,
  selectTransports,
  isTerminalFcmError,
  isTerminalWebPushError,
  buildFcmMessage,
  validateTokenOwner,
  FCM_CHANNEL_ID,
  PUSH_TTL_SECONDS
};
