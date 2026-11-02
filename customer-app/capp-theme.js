// Customer app — capp-dark (PLAN-capp-dark-mode r2 §2.5, APPROVED): THE theme source for what CSS cannot reach (the Google maps' styles,
// the native status bar). CSS itself follows the OS through the stylesheet's media query (first paint, no script); this module only
// tells the JS surfaces. isDark: the document's explicit data-theme (a future manual choice) wins, else the OS preference; any failure
// ⇒ light (fail-safe). subscribe: the media `change` + a re-read when the page becomes visible again (a WebView may drop `change`
// while backgrounded) — `fn` fires only on a real change; returns the unsubscribe. Pure, UMD, brand-agnostic.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappTheme = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const QUERY = '(prefers-color-scheme: dark)';
  function isDark(win) {
    try {
      const t = win && win.document && win.document.documentElement ? win.document.documentElement.getAttribute('data-theme') : null;
      if (t === 'dark') return true;
      if (t === 'light') return false;
      return !!(win && typeof win.matchMedia === 'function' && win.matchMedia(QUERY).matches);
    } catch (_) { return false; }
  }
  function subscribe(win, fn) {
    if (!win || typeof fn !== 'function') return () => {};
    let last = isDark(win), mq = null;
    const check = () => { const now = isDark(win); if (now === last) return; last = now; try { fn(now); } catch (_) {} };
    const onVis = () => { try { if (!win.document || win.document.visibilityState !== 'hidden') check(); } catch (_) {} };
    try { mq = typeof win.matchMedia === 'function' ? win.matchMedia(QUERY) : null; } catch (_) { mq = null; }
    try { if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', check); else if (mq && typeof mq.addListener === 'function') mq.addListener(check); } catch (_) {}
    try { if (win.document) win.document.addEventListener('visibilitychange', onVis); } catch (_) {}
    return () => {
      try { if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', check); else if (mq && typeof mq.removeListener === 'function') mq.removeListener(check); } catch (_) {}
      try { if (win.document) win.document.removeEventListener('visibilitychange', onVis); } catch (_) {}
    };
  }

  // the Google maps' dark style (JSON styling — allowed because the maps use no mapId, and settable LIVE with setOptions on the same
  // instance; colorScheme cannot change after construction). The values are Google's documented «night mode» example style.
  const MAP_DARK = Object.freeze([
    { elementType: 'geometry', stylers: [{ color: '#242f3e' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#242f3e' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#746855' }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
    { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#263c3f' }] },
    { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#38414e' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#212a37' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9ca5b3' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#746855' }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f2835' }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#f3d19c' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3948' }] },
    { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#d59563' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#17263c' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#515c6d' }] },
    { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#17263c' }] },
  ]);
  const mapStyles = (win) => (isDark(win) ? MAP_DARK : null);

  return { isDark, subscribe, mapStyles, MAP_DARK, QUERY };
});
