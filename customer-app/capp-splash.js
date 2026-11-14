// Customer app — the opening animation «wake» (OWNER 2026-11-01, DECISIONS:3308: Variant A, reduced motion = a 150 ms fade, the
// INSTALLED app only, never the website; MOCKUP-capp-splash-animation.html). Brand-agnostic: the Sherpa (Sola) mark only.
//
//   markupHtml()   the overlay, painted with the FIRST frame: platform/native/package-capp.js writes it into the NATIVE page right
//                  after #app (the website's page never carries it). Same background + mark (104 px) as the native splash, so the
//                  native → web switch is invisible. The animation itself is CSS (capp.css .csplash): it plays from first paint.
//                  Every class it carries is cs-prefixed (W1, 11-14: a global rule must never reach it — WAKE-8/9).
//   start(o)       the exit only (no timers besides READY and the cap): at READY — the shell's `capp:ready` (the first settled screen
//                  painted: the store list from cache or network, its error frame, a store, an order) — the overlay fades (200 ms;
//                  150 ms under reduced motion) and is removed; a READY that came before start() is read from the root's
//                  data-capp-ready; the HARD CAP (4 s) fades it regardless, so a stuck boot never traps the customer. The overlay is
//                  pointer-events:none throughout. The Capacitor SplashScreen plugin, when present, is hidden at once (the overlay is
//                  already painted), so exactly one splash is ever on screen.
// The mark's geometry is the native icon/splash's (platform/native/brand-assets.js) — byte-equal, guarded by capp-splash.test.mjs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSplash = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RING = 'M24 9.2 A14.8 14.8 0 1 1 24 38.8 A14.8 14.8 0 1 1 24 9.2';
  const NORTH = 'M24 12.6L27.3 24L20.7 24Z';
  const SOUTH = 'M27.3 24L24 31.6L20.7 24Z';
  const PIVOT_R = 1.7, RING_R = 14.8;
  const CAP_MS = 4000, FADE_MS = 200, FADE_RM_MS = 150;
  const READY_EVENT = 'capp:ready', READY_ATTR = 'data-capp-ready';

  function markupHtml() {
    return `<div class="csplash" id="csplash" aria-hidden="true"><svg class="cs-mark" viewBox="0 0 48 48" aria-hidden="true"><circle class="cs-halo" cx="24" cy="24" r="${RING_R}"/>`
      + `<g class="cs-ringg"><path class="cs-ring" d="${RING}"/></g><g class="cs-needle"><path class="cs-north" d="${NORTH}"/><path class="cs-south" d="${SOUTH}"/></g>`
      + `<circle class="cs-pivot" cx="24" cy="24" r="${PIVOT_R}"/></svg></div>`;
  }

  // the shell's ONE «first screen ready» signal (once): the root attribute (a late listener reads it) + the event
  function signalReady(doc, win) {
    try {
      const r = doc && doc.documentElement; if (!r || r.getAttribute(READY_ATTR) === '1') return;
      r.setAttribute(READY_ATTR, '1');
      if (win && typeof win.dispatchEvent === 'function' && typeof win.CustomEvent === 'function') win.dispatchEvent(new win.CustomEvent(READY_EVENT));
    } catch (_) { /* never breaks the app */ }
  }

  function start(o) {
    const doc = o && o.doc, win = (o && o.win) || (doc && doc.defaultView);
    const el = doc && doc.getElementById('csplash'); if (!el || !win) return null;
    const T = (o && o.timers) || { setTimeout: (f, ms) => win.setTimeout(f, ms), clearTimeout: (h) => win.clearTimeout(h) };
    try { const sp = win.Capacitor && win.Capacitor.Plugins && win.Capacitor.Plugins.SplashScreen; if (sp && typeof sp.hide === 'function') sp.hide(); } catch (_) {}
    let done = false, cap = null;
    const reduced = () => { try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } };
    function finish() {
      if (done) return; done = true;
      if (cap !== null) T.clearTimeout(cap);
      win.removeEventListener(READY_EVENT, finish);
      el.classList.add('cs-exit');   // the CSS fades it; a still-settling needle snaps north in the same fade
      T.setTimeout(() => { el.classList.add('cs-gone'); }, reduced() ? FADE_RM_MS : FADE_MS);
    }
    if (doc.documentElement.getAttribute(READY_ATTR) === '1') finish();
    else { win.addEventListener(READY_EVENT, finish); cap = T.setTimeout(finish, CAP_MS); }
    return { finish, done: () => done };
  }

  return { markupHtml, start, signalReady, RING, NORTH, SOUTH, PIVOT_R, RING_R, CAP_MS, FADE_MS, FADE_RM_MS, READY_EVENT, READY_ATTR };
});
