// test-push-core.js — pure orchestration for the dispatcher "Probar notificación" self-test (item 2).
// No Firebase: the onRequest handler in index.js injects the real rate-limiter + sender; this module decides
// authorization, the 30-second per-uid limit outcome, and the HONEST HTTP mapping of the send result. Keeping it
// pure lets the whole decision be unit-tested (auth gate, secret rejection, limit, 200/409/502/503) without a runtime.

// The self-test notification payload. Title is owner-locked; the body matches the approved mockup's intent.
const TEST_PUSH_PAYLOAD = {
  title: 'Prueba de notificación · Torre',
  body: 'Si ves esto, las notificaciones funcionan en este teléfono.',
  tag: 'test',
  data: {},
};

const TEST_PUSH_MIN_INTERVAL_MS = 30 * 1000;   // at most one test per uid per 30 s

/**
 * Transaction updater for the per-uid limit, run on staff_push_test/<uid>/last_test_at. Abort (undefined) when
 * the last stamp is within the window; otherwise stamp `now`. Atomic across instances.
 */
function testPushRateUpdater(now, minIntervalMs) {
  return (cur) => (typeof cur === 'number' && now - cur < minIntervalMs) ? undefined : now;
}

/**
 * Decide the HTTP outcome for a self-test request. Injected deps:
 *   auth      — the result of authorizeDispatcherActionWithUid(req): { ok, code?, msg?, byKind?, uid? }
 *   rateLimit — async (uid) → { allowed, retryAfterSec }; MAY reject (→ 503, fail closed: diagnostic endpoint)
 *   send      — async (uid, payload) → { sent, reason }; MAY reject (the subscription read can → 503)
 * Returns { httpStatus, body, retryAfterSec? }. The caller sets Retry-After when retryAfterSec is present.
 *
 * Authorization (codex P2-5): dispatcher ID token ONLY — a verified, non-empty uid with byKind 'dispatcher'.
 * The RECON_SECRET path (uid:null, byKind:'recon_secret') is rejected; a target is NEVER taken from the request.
 * HTTP honesty (codex P2-7): 2xx only for sent:true; 409 no_sub; 502 a failed send; 503 a rejected read/limiter.
 */
async function runTestStaffPush({ auth, rateLimit, send }) {
  if (!auth || !auth.ok) {
    return { httpStatus: (auth && auth.code) || 401, body: { error: 'Unauthorized', detail: auth && auth.msg } };
  }
  if (auth.byKind !== 'dispatcher' || !auth.uid) {
    return { httpStatus: 403, body: { error: 'Unauthorized', detail: 'dispatcher sign-in required' } };
  }

  let limit;
  try {
    limit = await rateLimit(auth.uid);
  } catch (_) {
    return { httpStatus: 503, body: { error: 'unavailable', detail: 'rate limiter unavailable' } };   // fail CLOSED
  }
  if (!limit || !limit.allowed) {
    const retryAfterSec = (limit && limit.retryAfterSec) || Math.ceil(TEST_PUSH_MIN_INTERVAL_MS / 1000);
    return { httpStatus: 429, body: { error: 'rate_limited', retryAfterSec }, retryAfterSec };
  }

  let r;
  try {
    r = await send(auth.uid, TEST_PUSH_PAYLOAD);
  } catch (_) {
    return { httpStatus: 503, body: { error: 'unavailable' } };   // sendStaffPush reads the subscription — can reject
  }
  if (r && r.sent) return { httpStatus: 200, body: { ok: true } };
  if (r && r.reason === 'no_sub') return { httpStatus: 409, body: { error: 'no_sub' } };
  return { httpStatus: 502, body: { error: 'send_failed' } };
}

module.exports = { runTestStaffPush, testPushRateUpdater, TEST_PUSH_PAYLOAD, TEST_PUSH_MIN_INTERVAL_MS };
