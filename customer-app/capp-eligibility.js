// Customer app S7a (PLAN-capp-S7a r3.3-F1 [r2 ruling 3], perf, APPROVED) — store-entry ELIGIBILITY, on its own clock. Pure, UMD,
// brand-agnostic (no restaurant id or name in this file — guarded). DARK: no page loads it yet (the S7a-2 directory screens do).
//
//   A store row is ENTERABLE only while now − verified_at < WINDOW_MS (60 s), where verified_at = the RECEIPT time of the last
//   SUCCESSFUL verification that listed the store as active (a complete 200, a matching 304, or a partial that lists it). Nothing
//   else extends it: a pending or hanging request never does. Past the window the row reverts to HELD entry (the tap is held,
//   then opens on the next successful verification). A complete response that omits a store TOMBSTONES it (dropped: never
//   enterable again from cache, removed from the stored directory by the caller); a PARTIAL that omits a store makes it HELD
//   (no longer verified — never tombstoned), even while its earlier verification would still be inside the window.
//   Codex perf-core r1 #2: the clock is a HIGH-WATER mark — every check and verification is evaluated at max(now, the latest
//   time seen), so a clock that moves backwards can never revive an eligibility that has already expired.
//   Codex perf-core r2: a rollback BEFORE expiry — the raw clock reads earlier than a store's verified_at — makes that store
//   SUSPECT: HELD until a NEW successful verification (the high-water age alone would freeze and keep it enterable).
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
    const known = new Set();   // every store ever verified (a complete response tombstones whichever of them it omits, held or not)
    let hw = -Infinity;   // the latest time observed
    const suspect = new Set();   // stores whose verification the raw clock has gone behind: held until verified again
    const clock = () => {
      const t = now();
      if (Number.isFinite(t)) { if (t > hw) hw = t; for (const [rid, at] of verifiedAt) if (t < at) suspect.add(rid); }
      return hw;
    };

    // a SUCCESSFUL verification, at its receipt time: `listed` = the rids it lists as active; `complete` = it is the whole directory
    function verified({ listed, complete, at }) {
      const cur = clock();
      const t = Number.isFinite(at) ? Math.min(at, cur) : cur;   // a receipt time is never later than the time seen
      const ids = new Set((listed || []).map(String));
      for (const rid of ids) { verifiedAt.set(rid, t); tombstoned.delete(rid); suspect.delete(rid); known.add(rid); }
      for (const rid of known) if (!ids.has(rid)) { verifiedAt.delete(rid); if (complete === true) tombstoned.add(rid); }   // omitted: tombstoned (complete) or held (partial)
      return [...tombstoned];
    }
    // a store the caller knows only from the stored directory (presentation) is never enterable until verified
    function state(rid) {
      const k = String(rid);
      if (tombstoned.has(k)) return 'gone';
      const t = verifiedAt.get(k);
      if (t === undefined) return 'held';
      const age = clock() - t;
      if (suspect.has(k)) return 'held';   // the clock went behind its verification: only a NEW verification clears it
      return age < windowMs ? 'enterable' : 'held';   // evaluated at the high-water time: a rollback cannot revive it
    }
    return { verified, state, enterable: (rid) => state(rid) === 'enterable', verifiedAt: (rid) => verifiedAt.get(String(rid)) };
  }

  return { createEligibility, WINDOW_MS };
});
