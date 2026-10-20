'use strict';
// TRACKER FIXES (BUILD-tracker-fixes §0) — config/tracker_fixes_enabled, a copy of lib/svc-handle.js's cached-flag pattern: fresh
// within 30 s → cached; a stale read re-establishes within 500 ms or returns OFF; a failed/timed-out refresh → OFF + 5 s backoff;
// a stale `true` is never retained. OFF = today's code paths verbatim. Each handler reads it ONCE per invocation (BUILD §0).
const FLAG_PATH = 'config/tracker_fixes_enabled';
const FLAG_TTL_MS = 30_000, FLAG_REFRESH_TIMEOUT_MS = 500, FLAG_BACKOFF_MS = 5_000;
let _cache = { value: false, at: 0 }, _inflight = null, _backoffUntil = 0;
function _withTimeout(p, ms, onTimeout) {
  let timer; const t = new Promise((res) => { timer = setTimeout(() => res(onTimeout()), ms); });
  return Promise.race([p.then((v) => { clearTimeout(timer); return v; }, (e) => { clearTimeout(timer); throw e; }), t]);
}
async function trackerFixesEnabled(db, now = Date.now()) {
  if (now - _cache.at < FLAG_TTL_MS) return _cache.value;
  if (now < _backoffUntil) return false;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await _withTimeout(db.ref(FLAG_PATH).once('value').then((s) => ({ v: s.val() === true })), FLAG_REFRESH_TIMEOUT_MS, () => ({ timeout: true }));
      if (r.timeout) { _backoffUntil = Date.now() + FLAG_BACKOFF_MS; _cache = { value: false, at: 0 }; return false; }
      _cache = { value: r.v, at: now };
      return r.v;
    } catch (e) {
      console.error('tracker-fixes: flag read failed → OFF, backing off', e && e.message);
      _backoffUntil = Date.now() + FLAG_BACKOFF_MS; _cache = { value: false, at: 0 };
      return false;
    } finally { _inflight = null; }
  })();
  return _inflight;
}
function _resetForTest() { _cache = { value: false, at: 0 }; _inflight = null; _backoffUntil = 0; }
module.exports = { trackerFixesEnabled, FLAG_PATH, FLAG_TTL_MS, FLAG_REFRESH_TIMEOUT_MS, FLAG_BACKOFF_MS, _resetForTest };
