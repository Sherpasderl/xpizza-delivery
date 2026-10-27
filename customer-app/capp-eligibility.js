// Customer app S7a (PLAN-capp-S7a r3.3-F1 [r2 ruling 3], perf, APPROVED) — store-entry ELIGIBILITY, on its own clock. Pure, UMD,
// brand-agnostic (no restaurant id or name in this file — guarded). DARK: no page loads it yet (the S7a-2 directory screens do).
//
//   A store row is ENTERABLE only while now − verified_at < WINDOW_MS (60 s), where verified_at = the RECEIPT time of the last
//   SUCCESSFUL verification that listed the store as active (a complete 200, a matching 304, or a partial that lists it). Nothing
//   else extends it: a pending or hanging request never does. Past the window the row reverts to HELD entry (the tap is held,
//   then opens on the next successful verification). A complete response that omits a store TOMBSTONES it (dropped: never
//   enterable again from cache, removed from the stored directory by the caller); a partial never tombstones.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappEligibility = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WINDOW_MS = 60 * 1000;

  function createEligibility(opts) {
    const o = opts || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const windowMs = Number.isFinite(o.windowMs) && o.windowMs > 0 ? o.windowMs : WINDOW_MS;
    const verifiedAt = new Map();   // rid → receipt time of its last successful verification
    const tombstoned = new Set();

    // a SUCCESSFUL verification, at its receipt time: `listed` = the rids it lists as active; `complete` = it is the whole directory
    function verified({ listed, complete, at }) {
      const t = Number.isFinite(at) ? at : now();
      const ids = new Set((listed || []).map(String));
      for (const rid of ids) { verifiedAt.set(rid, t); tombstoned.delete(rid); }
      if (complete === true) for (const rid of [...verifiedAt.keys()]) if (!ids.has(rid)) { verifiedAt.delete(rid); tombstoned.add(rid); }
      return [...tombstoned];
    }
    // a store the caller knows only from the stored directory (presentation) is never enterable until verified
    function state(rid) {
      const k = String(rid);
      if (tombstoned.has(k)) return 'gone';
      const t = verifiedAt.get(k);
      if (t === undefined) return 'held';
      const age = now() - t;
      return age >= 0 && age < windowMs ? 'enterable' : 'held';   // a clock that moved backwards is not trusted: held
    }
    return { verified, state, enterable: (rid) => state(rid) === 'enterable', verifiedAt: (rid) => verifiedAt.get(String(rid)) };
  }

  return { createEligibility, WINDOW_MS };
});
