// Customer app S2a (PLAN-capp-S2-r4 §2.4) — the APP ADAPTER for the shared self-update coordinator (sherpa-client.js):
// { canReload, prepareReload, afterReload }. The forms' adapter (order-self-update.js) depends on form globals, so the app has
// its own; it reads only what the host hands it. Pure, UMD, brand-agnostic (guarded). When the shared module is absent or
// INERT (an unstamped page) it registers nothing.
//
// canReload — FALSE while any of these hold (the coordinator ALSO refuses while a money attempt is latched outcome-unknown):
//   • a hosted-checkout return owns the page (`?pay=` in the URL);
//   • a placement is in flight (host state.placing);
//   • UNRESOLVED payment state exists: a live pending_place record or a pay stash (a reload never discards creds);
//   • the screen is the tip step, the «Realizando pedido…» card or «Enviando tu pedido…»;
//   • ordinary update only: an open sheet, or a tap / keystroke in the last 30 s (SherpaClient.quiet()).
//   The 426 transition (mode 'checkout') skips only the ordinary-update quietness checks.
// prepareReload — the host's snapshot (cart v2 + flow), which the coordinator writes to sessionStorage (a failed write = no reload).
// afterReload — the host restores it. The pay stash and pending_place live in localStorage and are never touched here.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSelfUpdate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BLOCKING_SCREENS = new Set(['tip', 'placing', 'sending']);

  // host: { state: () => ({ screen, placing, sheetOpen }), unresolved: () => bool, search: () => string,
  //         snapshot: () => data, restore: (data, ctx) => void, quiet: () => bool }
  function createAdapter(host) {
    const h = host || {};
    const st = () => { try { return h.state() || {}; } catch (_) { return null; } };
    function canReload(ctx) {
      try {
        if (new URLSearchParams(h.search ? h.search() : '').has('pay')) return false;
        const s = st();
        if (!s) return false;                                   // unreadable = not safe
        if (s.placing) return false;
        if (h.unresolved && h.unresolved()) return false;
        if (BLOCKING_SCREENS.has(s.screen)) return false;
        if (ctx && ctx.mode === 'checkout') return true;
        if (s.sheetOpen) return false;
        if (h.quiet && !h.quiet()) return false;
        return true;
      } catch (_) { return false; }
    }
    function prepareReload(ctx) { return h.snapshot ? h.snapshot(ctx) : null; }
    function afterReload(data, ctx) { if (h.restore && data) h.restore(data, ctx); }
    return { canReload, prepareReload, afterReload };
  }

  function register(sc, host) {
    if (!sc || sc.inert || typeof sc.registerAdapter !== 'function') return null;
    const a = createAdapter({ quiet: typeof sc.quiet === 'function' ? sc.quiet : undefined, ...host });
    sc.registerAdapter(a);
    return a;
  }

  return { createAdapter, register, BLOCKING_SCREENS };
});
