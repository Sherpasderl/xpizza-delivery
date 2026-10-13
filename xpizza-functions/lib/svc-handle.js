'use strict';
// S1a PRODUCTION SAFETY NET (codex r1 P1-7 follow-up) — the converted ownership/shift writers run behind the server
// flag config/driver_svc_handle_enabled so the restricted handle can be deployed OFF and flipped ON under watch
// (the emulator cannot bind the real Admin override, so this is the only live proof the override enforces rules):
//   - absent/false  → the DEFAULT Admin handle: byte-for-byte today's behavior;
//   - true          → the rules-bound svc-assigner handle, with a TOLERANT-MODE FALLBACK: an unexpected
//                     PERMISSION_DENIED (a rules gap — eligibility can never deny in tolerant, where every account is
//                     eligible) falls back to the default handle + a loud dispatcher alert, so a rules gap can never
//                     strand a live order while the flag is on. The fallback is TOLERANT-ONLY and is removed at the
//                     closed flip (flip-prep checklist). In closed mode a denial is a real eligibility refusal and
//                     propagates to the caller's handling.
// The flag is cached (short TTL, single-flight, fail-safe) so assignment invocations don't each pay an RTDB read.
const { svcAssignerDb } = require('./svc-assigner');

const FLAG_PATH = 'config/driver_svc_handle_enabled';
const MODE_PATH = 'platform_config/driver_enforcement_mode';
const FLAG_TTL_MS = 30_000;
let _cache = { value: false, at: 0 };   // last-known; defaults to false (the default handle) before the first read
let _inflight = null;

// Cached, single-flight read of the flag. A failed read returns the last-known value (false before any success).
async function svcHandleEnabled(db, now = Date.now()) {
  if (now - _cache.at < FLAG_TTL_MS) return _cache.value;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const v = (await db.ref(FLAG_PATH).once('value')).val() === true;
      _cache = { value: v, at: now };
      return v;
    } catch (e) {
      console.error('svc-handle: flag read failed, using last-known', _cache.value, e && e.message);
      return _cache.value;   // fail-safe: last-known (false before any success)
    } finally { _inflight = null; }
  })();
  return _inflight;
}

// The write handle for this invocation: the svc-assigner handle when the flag is on, else the default handle (today).
// Flag off creates NO svc app at all.
async function pickHandle(db) { return (await svcHandleEnabled(db)) ? svcAssignerDb() : db; }

function isPermissionDenied(e) { return /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || e)); }

// Run `doWrite(handle)`; if `handle` is the svc handle and the write is DENIED in TOLERANT mode, fall back to the
// default handle + a loud alert (a rules gap must never strand a live order). The enforcement mode is read ONLY on a
// denial (rare), so this adds no per-invocation cost.
async function svcWriteOrFallback(db, handle, doWrite, { site }) {
  if (handle === db) return doWrite(db);                       // flag off: default handle, no fallback machinery
  try { const r = await doWrite(handle); return r; }
  catch (e) {
    if (isPermissionDenied(e)) {
      let tolerant = true;
      try { tolerant = (await db.ref(MODE_PATH).once('value')).val() !== 'closed'; } catch (_) {}
      if (tolerant) {
        console.error(`svc-handle: DENIED in tolerant mode at ${site} — falling back to the default handle + alert`, e && e.message);
        try { await db.ref('dispatcher_alerts').push({ type: 'svc_handle_fallback', site, error: String((e && e.message) || e).slice(0, 200), created_at: Date.now() }); } catch (_) {}
        return doWrite(db);                                    // byte-for-byte fallback
      }
    }
    throw e;                                                   // closed-mode eligibility denial (caller handles) or an unexpected fault
  }
}

function _resetCacheForTest() { _cache = { value: false, at: 0 }; _inflight = null; }

module.exports = { svcHandleEnabled, pickHandle, isPermissionDenied, svcWriteOrFallback, FLAG_PATH, MODE_PATH, FLAG_TTL_MS, _resetCacheForTest };
