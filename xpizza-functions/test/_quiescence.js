'use strict';
/* QUIESCENCE for the trace / call-sequence suites (R1b).
 *
 * 🔴 WHY. Each trace suite records every RTDB + Firestore call a handler issues, then compared the recording with a
 * FROZEN base golden after `await wait(300)` — "so a fire-and-forget write the handler issued lands inside the
 * recording". Under load a late write (a) missed the window, so the CALL SEQUENCE / changed-path set differed from the
 * golden, or (b) landed in the NEXT case (its status flipped, e.g. 409 → 200). A fixed sleep is a guess about speed.
 *
 * THIS waits for the thing itself: every recorded call's result, if it is a thenable, is IN FLIGHT until it settles;
 * `quiescent()` resolves when nothing is in flight AND no new call has been recorded for `quietMs` (default 300 — the old
 * sleep becomes the LOWER bound, so nothing the old window caught is missed; the wait only grows while work is pending).
 * At `capMs` it THROWS, naming what is still pending: a hang is loud, never a silent proceed.
 *
 * track(result, label) returns `result` UNCHANGED (the same object): callers see exactly what they saw before.
 */
/* MONOTONIC clock: two trace suites patch Date.now to a CONTROLLED clock that jumps; a quiet window or cap measured on it
   could be faked by the jump. performance.now() is untouched by that patch. */
const { performance } = require('perf_hooks');
function makeQuiescence({ now = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 10 } = {}) {
  const pending = new Map();          // id → label
  let seq = 0;
  let lastActivity = now();
  const touch = () => { lastActivity = now(); };
  return {
    // call this for EVERY recorded call (thenable or not): any call is activity
    track(result, label) {
      touch();
      if (result && typeof result.then === 'function') {
        const id = ++seq;
        pending.set(id, label);
        const done = () => { pending.delete(id); touch(); };
        try { result.then(done, done); } catch { pending.delete(id); }
      }
      return result;
    },
    get inFlight() { return pending.size; },
    async quiescent({ quietMs = 300, capMs = 15000 } = {}) {
      const t0 = now();
      lastActivity = Math.max(lastActivity, t0);   // the quiet window starts no earlier than this call
      for (;;) {
        if (pending.size === 0 && now() - lastActivity >= quietMs) return now() - t0;
        if (now() - t0 >= capMs) {
          const labels = [...pending.values()];
          const e = new Error(`quiescence: not quiet after ${capMs} ms — ${labels.length} call(s) still in flight: ${labels.slice(0, 5).join(', ') || '(none; calls kept arriving)'}`);
          e.code = 'ENOTQUIET';
          throw e;
        }
        await sleep(pollMs);
      }
    },
  };
}

module.exports = { makeQuiescence };
