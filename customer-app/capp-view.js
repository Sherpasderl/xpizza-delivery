// Customer app — the ONE viewport breakpoint (PLAN-capp-desktop-website r2 D-2: switch on the APPROVED v6 desktop). Pure, UMD,
// brand-agnostic (guarded). A window at least BREAKPOINT px wide is the DESKTOP view (v6 `S.view === 'desk'`); anything else — or a
// window with no matchMedia — is the phone view, exactly today's shell.
//
// createView(win, { timers, settleMs }) → { desk(), subscribe(fn) → unsubscribe, destroy() }
//   desk()        the view NOW — read SYNCHRONOUSLY at creation (the shell sets `.desk` before its first paint: no pop-in, §P)
//   subscribe(fn) fn(desk) once per SETTLED change: a crossing is debounced (settleMs) and only a final value that differs from the
//                 last notified one is reported — a resize dragged back and forth across 1024 px re-renders at most once
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BREAKPOINT = 1024;
  const QUERY = `(min-width: ${BREAKPOINT}px)`;
  const SETTLE_MS = 120;

  function createView(win, opts) {
    const o = opts || {};
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    const settleMs = Number.isFinite(o.settleMs) && o.settleMs >= 0 ? o.settleMs : SETTLE_MS;
    let mql = null;
    try { mql = win && typeof win.matchMedia === 'function' ? win.matchMedia(QUERY) : null; } catch (_) { mql = null; }
    const read = () => { try { return !!(mql && mql.matches); } catch (_) { return false; } };
    let cur = read(), timer = null, dead = false;
    const subs = new Set();
    const settle = () => {
      timer = null; if (dead) return;
      const v = read(); if (v === cur) return;
      cur = v;
      for (const f of [...subs]) { try { f(v); } catch (_) { /* one subscriber never breaks another */ } }
    };
    const onChange = () => { if (dead) return; if (timer !== null) T.clearTimeout(timer); timer = T.setTimeout(settle, settleMs); };
    if (mql) { if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange); else if (typeof mql.addListener === 'function') mql.addListener(onChange); }
    return {
      desk: () => cur,
      subscribe(fn) { if (typeof fn !== 'function') return () => {}; subs.add(fn); return () => subs.delete(fn); },
      destroy() {
        dead = true; if (timer !== null) T.clearTimeout(timer); subs.clear();
        if (mql) { if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange); else if (typeof mql.removeListener === 'function') mql.removeListener(onChange); }
      },
    };
  }

  return { createView, BREAKPOINT, QUERY, SETTLE_MS };
});
