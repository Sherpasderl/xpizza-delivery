// Customer app S7a (PLAN-capp-S7a r3.3-F5 [r2 ruling 5], perf, APPROVED) — the shell's AUTH STATE. Pure, UMD, brand-agnostic
// (no restaurant id or name in this file — guarded). DARK: no page loads it yet.
//
//   unresolved   from boot until the SDK's FIRST auth callback — painted as NEITHER guest nor member (reserved slots, no promo,
//                no guest prompt); an identity tap shows its drawn pending state and waits (whenResolved). NEVER assumed guest.
//   guest        the first callback said: no user
//   member       the first callback said: a user
//   unavailable  the SDK failed to initialize, or gave no first callback within UNAVAILABLE_MS (10 s) — still NEVER guest: the
//                identity tap shows the drawn «Sin conexión» sheet with «Reintentar» (retry() re-initializes)
//   A later callback always wins (an `unavailable` that then hears from the SDK resolves to guest / member).
//
//   opts.subscribe(onUser, onError) → unsubscribe — the SDK adapter (onAuthStateChanged); opts.timers — { setTimeout, clearTimeout }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappAuthState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const UNAVAILABLE_MS = 10 * 1000;

  function createAuthState(opts) {
    const o = opts || {};
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const limit = Number.isFinite(o.unavailableMs) && o.unavailableMs > 0 ? o.unavailableMs : UNAVAILABLE_MS;
    let st = 'unresolved', user = null, timer = null, unsub = null;
    const listeners = new Set();
    let waiters = [];
    const settle = () => { const w = waiters; waiters = []; for (const r of w) r(st); };
    const set = (next, u) => {
      st = next; user = next === 'member' ? u : null;
      for (const fn of [...listeners]) { try { fn(st, user); } catch (_) {} }
      if (st !== 'unresolved') settle();
    };
    function start() {
      if (timer !== null) T.clearTimeout(timer);
      if (typeof unsub === 'function') { try { unsub(); } catch (_) {} }
      unsub = null;
      timer = T.setTimeout(() => { timer = null; if (st === 'unresolved') set('unavailable'); }, limit);
      try {
        unsub = o.subscribe(
          (u) => { if (timer !== null) { T.clearTimeout(timer); timer = null; } set(u ? 'member' : 'guest', u || null); },
          () => { if (timer !== null) { T.clearTimeout(timer); timer = null; } if (st === 'unresolved') set('unavailable'); });
      } catch (_) { if (timer !== null) { T.clearTimeout(timer); timer = null; } set('unavailable'); }
    }
    start();
    return {
      state: () => st,
      user: () => user,
      // an identity tap: resolves with the RESOLVED state (guest | member | unavailable) — never earlier, never a guess
      whenResolved: () => (st === 'unresolved' ? new Promise((r) => waiters.push(r)) : Promise.resolve(st)),
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      // «Reintentar» on the «Sin conexión» sheet: back to unresolved, re-subscribe
      retry: () => { if (st !== 'unavailable') return false; set('unresolved'); start(); return true; },
      destroy: () => { if (timer !== null) T.clearTimeout(timer); timer = null; if (typeof unsub === 'function') { try { unsub(); } catch (_) {} } unsub = null; listeners.clear(); },
    };
  }

  return { createAuthState, UNAVAILABLE_MS };
});
