'use strict';
// ── P-SELFUPDATE §5/§6 — the HTTP compatibility FLOOR for the identity-bearing `orders` endpoints ────────────────────
//
// The browser module sends X-Client-App / X-Client-Deployment / X-Client-Build / X-Client-Compat on every request to
// the platform's functions. On createOrder, chargeOnlineOrder, quoteOrder and quoteRedemption:
//
//   1. LOG every request's client identity on ONE structured line — `client_version {endpoint, app, deployment, build,
//      compat, headerless}` (advisor ruling R3.1: header-less identity requests are COUNTED FROM THIS LOG LINE, never by
//      a database write on the money path). Synchronous console output only: no I/O, no await, can never throw.
//   2. READ the floor `platform_config/client_floor/{app}` — ABSENT = OFF. Cached per instance (TTL), each read bounded
//      by a short timeout, at most one read in flight. A timeout / read error / malformed value keeps the LAST KNOWN
//      VALID floor; a cold instance with no valid value fails OPEN with an alarm line (safe while D4-b's readers accept
//      the legacy format; D5 must flip this to fail closed — PLAN §6).
//   3. A request is BELOW the floor when the floor is set and its compat (taken only when X-Client-App names the
//      endpoint's own app; a header-less or foreign request maps to the endpoint's app with NO compat) is absent or lower.
//      A below-floor request is refused with a typed `426 {error:"client_update_required", app, required_compat}`
//      BEFORE any mutation, unless a READ-ONLY probe shows it can only be an existing result / a live-checkout reuse —
//      then it is admitted and the AUTHORITATIVE decision re-checks (a race into fresh issuance → a NON-426 typed
//      conflict; see index.js + pixelpay-hosted-charge.js `refuseFresh`).
const FLOOR_TTL_MS = 30 * 1000;
const FLOOR_READ_TIMEOUT_MS = 1000;
const COMPAT_RE = /^\d{1,6}$/;
const HDR_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HDR_BUILD_RE = /^[A-Za-z0-9._-]{1,80}$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const hdr = (req, name) => {
  const v = req && req.headers ? req.headers[name] : undefined;
  return typeof v === 'string' ? v.trim() : '';
};
// → { app, deployment, build, compat, headerless } — values that fail their shape are null (never trusted, never thrown on)
function readClientHeaders(req) {
  const app = hdr(req, 'x-client-app');
  const deployment = hdr(req, 'x-client-deployment');
  const build = hdr(req, 'x-client-build');
  const compat = hdr(req, 'x-client-compat');
  return {
    app: HDR_ID_RE.test(app) ? app : null,
    deployment: HDR_ID_RE.test(deployment) ? deployment : null,
    build: HDR_BUILD_RE.test(build) ? build : null,
    compat: COMPAT_RE.test(compat) ? Number(compat) : null,
    headerless: !app,
  };
}

// The ONE structured line per identity request. Never throws, never awaits.
function logClientVersion(endpoint, h, sink = console) {
  try {
    sink.log('client_version', JSON.stringify({ endpoint, app: h.app, deployment: h.deployment, build: h.build, compat: h.compat, headerless: h.headerless }));
  } catch (_) { /* logging must never affect the request */ }
}

const validFloor = (v) => Number.isInteger(v) && v >= 0;

// deps: { getDb: () => db, ttlMs, timeoutMs, now, log }
function createFloorReader({ getDb, ttlMs = FLOOR_TTL_MS, timeoutMs = FLOOR_READ_TIMEOUT_MS, now = Date.now, log = console } = {}) {
  const state = new Map();   // app → { value: int|null, checkedAt, known: boolean }
  const inflight = new Map();
  const alarm = (kind, app, detail) => { try { log.error('client_floor_alarm', JSON.stringify({ kind, app, detail: String(detail || '').slice(0, 160) })); } catch (_) {} };

  function read(app) {
    if (inflight.has(app)) return inflight.get(app);
    const p = (async () => {
      const prev = state.get(app);
      let timer;
      try {
        const snap = await Promise.race([
          getDb().ref(`platform_config/client_floor/${app}`).get(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('floor_read_timeout')), timeoutMs); }),
        ]);
        const v = snap.val();
        if (v === null) { state.set(app, { value: null, checkedAt: now(), known: true }); return; }   // ABSENT = OFF
        if (validFloor(v)) { state.set(app, { value: v, checkedAt: now(), known: true }); return; }
        alarm('malformed', app, JSON.stringify(v));
      } catch (e) {
        alarm('read_failed', app, e && e.message);
      } finally {
        clearTimeout(timer);
      }
      // failure / malformed → keep the LAST KNOWN VALID value; cold → fail OPEN (alarmed); retry after the TTL either way
      if (prev && prev.known) state.set(app, { ...prev, checkedAt: now() });
      else { alarm('cold_fail_open', app, 'no valid floor known — enforcement OFF'); state.set(app, { value: null, checkedAt: now(), known: false }); }
    })().finally(() => inflight.delete(app));
    inflight.set(app, p);
    return p;
  }

  // → { floor: int|null, source: 'cache'|'read' }
  async function floorFor(app) {
    const s = state.get(app);
    if (s && now() - s.checkedAt < ttlMs) return { floor: s.value, source: 'cache' };
    await read(app);
    return { floor: state.get(app).value, source: 'read' };
  }
  return { floorFor, _state: () => new Map(state) };
}

function isBelowFloor(h, endpointApp, floor) {
  if (!validFloor(floor)) return false;                                   // OFF (absent / fail-open)
  const compat = (h && h.app === endpointApp) ? h.compat : null;          // header-less / foreign → mapped, no compat
  return !(Number.isInteger(compat) && compat >= floor);
}

function updateRequired(res, app, floor) {
  return res.status(426).json({ error: 'client_update_required', app, required_compat: floor });
}

// READ-ONLY admission probes (PLAN §5 (1)). They never write and never grant anything by themselves: an admitted request
// is re-checked at the authoritative decision.
//   createOrder: admitted only if the order already EXISTS (then the idempotency branch answers before any write).
async function existingOrderProbe(db, rawOrderId) {
  const id = typeof rawOrderId === 'string' ? rawOrderId : (rawOrderId == null ? '' : String(rawOrderId));
  if (!ORDER_ID_RE.test(id)) return { admit: false };
  try { return { admit: (await db.ref(`orders/${id}`).once('value')).exists() }; } catch (_) { return { admit: false }; }
}
//   chargeOnlineOrder: admitted only if the order holds a still-LIVE created checkout (genuine reuse — the same test
//   acquireHostedAttempt / classifyHostedAttempt apply). The caller then also requires classify to say `reuse`.
async function liveCheckoutProbe(db, rawOrderId, now) {
  const id = typeof rawOrderId === 'string' ? rawOrderId : (rawOrderId == null ? '' : String(rawOrderId));
  if (!ORDER_ID_RE.test(id)) return { admit: false };
  try {
    const order = (await db.ref(`orders/${id}`).once('value')).val();
    if (!order || !order.active_attempt_id || order.payment_status === 'confirmed') return { admit: false };
    const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
    return { admit: !!(att && att.hosted_state === 'created' && Number(att.hosted_expires_at) > now && att.hosted_checkout_url) };
  } catch (_) { return { admit: false }; }
}

module.exports = {
  readClientHeaders, logClientVersion, createFloorReader, isBelowFloor, updateRequired, existingOrderProbe, liveCheckoutProbe,
  FLOOR_TTL_MS, FLOOR_READ_TIMEOUT_MS,
};
