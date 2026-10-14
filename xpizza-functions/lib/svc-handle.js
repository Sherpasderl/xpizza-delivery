'use strict';
// S1a PRODUCTION SAFETY NET (codex r1 P1-7 follow-up, hardened per codex r2 P1-1/P1-2) — the converted ownership/shift
// writers run behind config/driver_svc_handle_enabled so the restricted handle can be deployed OFF and flipped ON under
// watch (the emulator cannot bind the real Admin override, so this is the only live proof the override enforces rules):
//   - absent/false  → the DEFAULT Admin handle: byte-for-byte today's behavior;
//   - true          → the rules-bound svc-assigner handle, with a TOLERANT-MODE FALLBACK restricted to an UNEXPECTED
//                     denial (a rules gap): it falls back to the default handle + a loud alert ONLY when (a) the mode
//                     read SUCCEEDS and is not 'closed', and (b) a FRESH account read proves the target is NOT explicitly
//                     ineligible. An explicitly suspended/deactivated target stays DENIED even in tolerant (matching the
//                     rules suite); any read failure re-throws (never bypasses enforcement). Removed at the closed flip
//                     (flip-prep) and must not ship in S1b.
// The flag is cached with a BOUNDED, expiring, backed-off refresh so it can never stall an assignment or retain service
// routing indefinitely after failures.
const { svcAssignerDb } = require('./svc-assigner');

const FLAG_PATH = 'config/driver_svc_handle_enabled';
const MODE_PATH = 'platform_config/driver_enforcement_mode';
const FLAG_TTL_MS = 30_000;            // a fresh `true`/`false` is trusted this long
const FLAG_REFRESH_TIMEOUT_MS = 500;   // a refresh must resolve within this bound, else DEFAULT
const FLAG_BACKOFF_MS = 5_000;         // after a failed/timed-out refresh, don't hammer — DEFAULT until this elapses
const ALERT_TIMEOUT_MS = 2_000;        // the fallback alert await is bounded so a hung alert can't block the write

let _cache = { value: false, at: 0 };
let _inflight = null;
let _backoffUntil = 0;

function _withTimeout(promise, ms, onTimeout) {
  let timer;
  const t = new Promise((res) => { timer = setTimeout(() => res(onTimeout()), ms); });
  return Promise.race([promise.then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; }), t]);
}

// Cached, single-flight, BOUNDED read. Fresh within the TTL → the cached value. Stale → re-establish within the latency
// bound or DEFAULT (false) — a stale `true` is NEVER retained. A failed/timed-out refresh → DEFAULT + back off (no
// thundering re-reads). So the flag can never block an assignment or keep routing to the svc handle after failures.
async function svcHandleEnabled(db, now = Date.now()) {
  if (now - _cache.at < FLAG_TTL_MS) return _cache.value;   // fresh
  if (now < _backoffUntil) return false;                    // backing off a recent failure → default handle
  if (_inflight) return _inflight;                          // single-flight
  _inflight = (async () => {
    try {
      const r = await _withTimeout(
        db.ref(FLAG_PATH).once('value').then((s) => ({ v: s.val() === true })),
        FLAG_REFRESH_TIMEOUT_MS, () => ({ timeout: true }));
      if (r.timeout) { _backoffUntil = Date.now() + FLAG_BACKOFF_MS; return false; }   // bound not met → default + backoff
      _cache = { value: r.v, at: now };
      return r.v;
    } catch (e) {
      console.error('svc-handle: flag read failed → default handle, backing off', e && e.message);
      _backoffUntil = Date.now() + FLAG_BACKOFF_MS;
      return false;   // fail → DEFAULT (never retain a stale true)
    } finally { _inflight = null; }
  })();
  return _inflight;
}

// The write handle for this invocation: the svc-assigner handle when the flag is on, else the default handle (today).
async function pickHandle(db) { return (await svcHandleEnabled(db)) ? svcAssignerDb() : db; }

function isPermissionDenied(e) { return /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || e)); }

// A permission denial is an EXPECTED eligibility refusal ONLY when a FRESH account read proves the target is explicitly
// ineligible (deactivated or not-enabled). An eligible/absent target → NOT expected (a rules/schema fault or a rules
// gap). The account read THROWS on failure so the caller treats a failed classification as unexpected (loud / no bypass).
async function isExpectedEligibilityDenial(e, db, target) {
  if (!isPermissionDenied(e) || !target) return false;
  const a = (await db.ref(`driver_accounts/${target}`).once('value')).val();
  return !!a && (a.deactivated === true || a.enabled === false);
}

// Run doWrite(handle); fall back to the DEFAULT handle ONLY on an UNEXPECTED permission denial in a CONFIRMED tolerant
// mode (a rules gap — never an eligibility refusal, which stays denied even in tolerant). The mode + target reads must
// SUCCEED for a fallback; any read failure re-throws (never bypass). The alert await is bounded.
async function svcWriteOrFallback(db, handle, doWrite, { site, target }) {
  if (handle === db) return doWrite(db);
  try { const r = await doWrite(handle); return r; }
  catch (e) {
    if (!isPermissionDenied(e)) throw e;
    let mode;
    try { mode = (await db.ref(MODE_PATH).once('value')).val(); } catch (_) { throw e; }   // mode read failed → don't bypass
    if (mode === 'closed') throw e;                                                          // closed: eligibility refusal, propagate
    let expected;
    try { expected = await isExpectedEligibilityDenial(e, db, target); } catch (_) { throw e; }   // account read failed → loud
    if (expected) throw e;                                                                   // explicitly suspended/deactivated → stays denied
    console.error(`svc-handle: UNEXPECTED denial in tolerant mode at ${site} (target ${target} is eligible) — falling back to the default handle + alert`, e && e.message);
    try { await _withTimeout(db.ref('dispatcher_alerts').push({ type: 'svc_handle_fallback', site, target: target || null, error: String((e && e.message) || e).slice(0, 200), created_at: Date.now() }), ALERT_TIMEOUT_MS, () => null); } catch (_) {}
    return doWrite(db);                                                                       // byte-for-byte fallback
  }
}

function _resetCacheForTest() { _cache = { value: false, at: 0 }; _inflight = null; _backoffUntil = 0; }

module.exports = { svcHandleEnabled, pickHandle, isPermissionDenied, isExpectedEligibilityDenial, svcWriteOrFallback, FLAG_PATH, MODE_PATH, FLAG_TTL_MS, FLAG_REFRESH_TIMEOUT_MS, FLAG_BACKOFF_MS, _resetCacheForTest };
