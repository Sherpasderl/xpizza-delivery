'use strict';
// INTL PHONE S-core step 3 — PHONE_WIRE_STRICT = RTDB config/phone_wire_strict, a copy of tracking/flag.js's cached-flag pattern: fresh
// within 30 s → cached; a stale read re-establishes within 500 ms or returns OFF; a failed/timed-out refresh → OFF + 5 s backoff; a
// stale `true` is never retained. OFF = today's sanitizePhone verbatim; ON = phone/intl.js parseSubmitted (the wire contract).
// Each intake handler reads it ONCE per request and passes it down. Owner flips it after the read-only phone census.
// step 5 (advisor ruling, Option S — the FLIP-ORDER guard): ON only for the census-backed object
//   { enabled: true, enabled_at: <ms>, census: { flip_safe: true, generated_at: <ms>, orders_in_window: <int ≥ 1> } }
// with generated_at ≤ enabled_at ≤ now and enabled_at − generated_at ≤ 7 days (a stale census cannot authorize a flip; checked
// against the FLIP time, so a valid flip never expires). Anything else present → OFF + console.error('phone_wire_strict_refused',
// <reason>) — no phone, no value echoed. Absent / enabled:false → OFF, silently.
const CENSUS_MAX_AGE_MS = 7 * 86400e3;
function strictRefusal(v, now) {
  if (v == null) return 'absent';
  if (typeof v !== 'object' || Array.isArray(v)) return 'not_an_object';
  if (v.enabled !== true) return 'disabled';
  const c = v.census;
  if (!c || typeof c !== 'object') return 'census_missing';
  if (c.flip_safe !== true) return 'census_not_flip_safe';
  if (!Number.isFinite(c.generated_at)) return 'census_generated_at_invalid';
  if (!Number.isInteger(c.orders_in_window) || c.orders_in_window < 1) return 'census_orders_in_window_invalid';   // > 0, as the census generator requires (codex r1 #3)
  if (!Number.isFinite(v.enabled_at)) return 'enabled_at_invalid';
  if (v.enabled_at > now) return 'enabled_at_in_future';
  if (c.generated_at > v.enabled_at) return 'census_after_enable';
  if (v.enabled_at - c.generated_at > CENSUS_MAX_AGE_MS) return 'census_stale';
  return null;
}
function evaluateStrict(v, now) {
  const why = strictRefusal(v, now);
  if (why && why !== 'absent' && why !== 'disabled') console.error('phone_wire_strict_refused', why);
  return why === null;
}
const FLAG_PATH = 'config/phone_wire_strict';
const FLAG_TTL_MS = 30_000, FLAG_REFRESH_TIMEOUT_MS = 500, FLAG_BACKOFF_MS = 5_000;
let _cache = { value: false, at: 0 }, _inflight = null, _backoffUntil = 0;
// the TTL / backoff clock: production = Date.now (late-bound); a trace suite installs its catalog clock ONCE (test/_catalog-clock.js),
// so no refresh can land inside a recorded request by wall time (advisor ruling B, 2026-11-01). The 500 ms deadline stays a real timer.
let _clock = () => Date.now(), _clockHooked = false;
function _withTimeout(p, ms, onTimeout) {
  let timer; const t = new Promise((res) => { timer = setTimeout(() => res(onTimeout()), ms); });
  return Promise.race([p.then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; }), t]);
}
async function phoneWireStrict(db, now = _clock()) {
  if (now - _cache.at < FLAG_TTL_MS) return _cache.value;
  if (now < _backoffUntil) return false;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await _withTimeout(db.ref(FLAG_PATH).once('value').then((s) => ({ v: evaluateStrict(s.val(), now) })), FLAG_REFRESH_TIMEOUT_MS, () => ({ timeout: true }));
      if (r.timeout) { _backoffUntil = _clock() + FLAG_BACKOFF_MS; _cache = { value: false, at: 0 }; return false; }
      _cache = { value: r.v, at: now };
      return r.v;
    } catch (e) {
      console.error('phone-wire-strict: flag read failed → OFF, backing off', e && e.message);
      _backoffUntil = _clock() + FLAG_BACKOFF_MS; _cache = { value: false, at: 0 };
      return false;
    } finally { _inflight = null; }
  })();
  return _inflight;
}
// codex r1 #2 (perf rule: no awaited flag read on a hot path) — the SYNCHRONOUS read the order intakes and requestOtp use.
// Fresh cache → its value. Otherwise ONE background revalidation (phoneWireStrict: in-flight dedupe, backoff, fail-closed) is
// started and NEVER awaited, and this call answers at once: a cold cache → OFF; a stale cached value → that value (stale-while-
// revalidate; a failed refresh resets the cache to OFF, so a stale `true` cannot outlive a failure).
function phoneWireStrictNow(db, now = _clock()) {
  if (_cache.at && now - _cache.at < FLAG_TTL_MS) return _cache.value;
  const answer = _cache.at ? _cache.value : false;
  phoneWireStrict(db, now).catch(() => {});
  return answer;
}
function _resetForTest() { _cache = { value: false, at: 0 }; _inflight = null; _backoffUntil = 0; }
function _useClock(fn) {
  if (typeof fn !== 'function') throw new Error('phone flag: _useClock needs a function');
  if (_clockHooked) throw new Error('phone flag: _useClock is once per process — a clock is already installed');
  _clock = fn; _clockHooked = true;
}
// a trace suite's warm (recorder OFF): wait out any in-flight refresh, then ONE fresh read → full-TTL fresh for the next request
async function _warmForTest(db) {
  while (_inflight) await _inflight;
  _cache = { value: false, at: 0 }; _backoffUntil = 0;
  return phoneWireStrict(db);
}
module.exports = { phoneWireStrict, phoneWireStrictNow, evaluateStrict, CENSUS_MAX_AGE_MS, FLAG_PATH, FLAG_TTL_MS, FLAG_REFRESH_TIMEOUT_MS, FLAG_BACKOFF_MS, _resetForTest, _useClock, _warmForTest };
