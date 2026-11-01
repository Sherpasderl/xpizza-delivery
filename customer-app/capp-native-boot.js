// Customer app — the NATIVE shell's bootstrap (PLAN-capp-native-shell §1.2, APPROVED; BUILD-ORDER N2). The packaged shell.html
// (platform/native/package-capp.js) loads the SAME customer-app modules as the web, then this file, then a generated
// CAPP_NATIVE_RUNTIME (the platform orders deployment's `runtime` block from platform/sites.json + the build's flags). It builds
// the shell's transports and runtime from that DATA and calls CappShellUI.mount(document, opts). Brand-agnostic (no restaurant id,
// name or host in this file — guarded). Not loaded by any web page: only the packaged native shell carries it.
//
// boot(doc, opts) → the CappShellUI instance (or null with no runtime)
//   opts.runtime  { functions_base, menu_endpoint, availability_base, intake_key, maps_key, firebase, directory_endpoint?,
//                   sdk_base, flags: { signup?, intlPhone?, guestCardOnly?, schedulingLive? } }   absent flag ⇒ dark
//   opts.fetch, opts.importModule (the dynamic import; tests inject), opts.CappShellUI, opts.CappSignupApi, and every other
//   CappShellUI.mount option (storage, now, timers, win, uiOpts, onEvent) passed through unchanged
// Transports (the CappShellUI contract):
//   fetchDirectory(etag)       the directory endpoint, If-None-Match ⇒ { status, body?, etag? }; none configured ⇒ { status: 0 }
//                              (the shell's drawn directory failure) — the endpoint is not wired yet (5f)
//   fetchEnvelope(rid, etag)   getPublicMenu's /menu/<rid> (the rid in the PATH), If-None-Match ⇒ { status, body?, etag? }
//   readAvailability()         null = FAIL-OPEN (every dish available; the server refuses a sold dish at intake). The RTDB →
//                              dish-key mapping needs the restaurant's availability identity, which the menu envelope will
//                              carry (advisor ruling; 5f) — until then this never guesses one. ⚠ LAUNCH BLOCKER (recorded).
//   loadSdk()                  the BUNDLED Firebase SDK (platform/native/vendor, sha-pinned) — never gstatic at runtime
// auth: not passed — under runtime.signup the shell creates its own CappAuthState (capp-shell-ui startAuth); without it, the
// shell's documented unresolved state (never assumed guest).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CappNativeBoot = api;
    if (root.CAPP_NATIVE_RUNTIME && root.document) root.CappNativeBoot.instance = api.boot(root.document, { runtime: root.CAPP_NATIVE_RUNTIME });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // the order endpoints the app calls (capp-api.js's E.*) — capp-native-boot.test.mjs pins this list EQUAL to capp-api's
  const ORDER_ENDPOINTS = Object.freeze(['quoteOrder', 'createOrder', 'chargeOnlineOrder', 'paymentStatus', 'requestCheckoutCode', 'verifyCheckoutCode']);
  const g = typeof self !== 'undefined' ? self : {};
  const pick = (o, name) => o[name] || g[name];

  function runtimeFor(rt, CappSignupApi) {
    const base = rt.functions_base, f = rt.flags || {};
    const url = (name) => `${base}/${name}`;
    return {
      endpoints: Object.fromEntries(ORDER_ENDPOINTS.map((n) => [n, url(n)])),
      intakeKey: rt.intake_key, mapsKey: rt.maps_key || undefined,
      ...(f.schedulingLive === true ? { schedulingLive: true } : {}),
      ...(f.intlPhone === true ? { intlPhone: true } : {}),
      ...(f.guestCardOnly === true ? { guestCardOnly: true } : {}),
      ...(f.signup === true ? { signup: { firebase: rt.firebase, endpoints: Object.fromEntries(CappSignupApi.ENDPOINTS.map((n) => [n, url(n)])) } } : {}),
    };
  }

  // one conditional GET ⇒ the transport shape; any throw ⇒ status 0 (network failure)
  async function conditional(fetchFn, href, etag) {
    try {
      const res = await fetchFn(href, { method: 'GET', cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {} });
      const tag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('ETag') : null;
      if (res.status === 304) return { status: 304, etag: tag || etag || undefined };
      if (res.status !== 200) return { status: res.status };
      let body; try { body = await res.json(); } catch (_) { return { status: 0 }; }
      return { status: 200, body, ...(tag ? { etag: tag } : {}) };
    } catch (_) { return { status: 0 }; }
  }

  function boot(doc, opts) {
    const o = opts || {}, rt = o.runtime;
    if (!rt || typeof rt.functions_base !== 'string' || !rt.functions_base) return null;
    const CappShellUI = pick(o, 'CappShellUI'), CappSignupApi = pick(o, 'CappSignupApi');
    const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch.bind(g) : null);
    const importModule = o.importModule || ((p) => import(p));
    const sdk = String(rt.sdk_base || '');
    const { runtime: _r, fetch: _f, importModule: _i, CappShellUI: _c, CappSignupApi: _s, ...pass } = o;
    return CappShellUI.mount(doc, {
      ...pass,
      runtime: runtimeFor(rt, CappSignupApi),
      fetchDirectory: (etag) => (typeof rt.directory_endpoint === 'string' && rt.directory_endpoint
        ? conditional(fetchFn, `${rt.functions_base}/${rt.directory_endpoint}`, etag) : Promise.resolve({ status: 0 })),
      fetchEnvelope: (rid, etag) => conditional(fetchFn, `${rt.functions_base}/${rt.menu_endpoint}/menu/${encodeURIComponent(rid)}`, etag),
      readAvailability: async () => null,
      loadSdk: () => Promise.all([importModule(`${sdk}firebase-app.js`), importModule(`${sdk}firebase-auth.js`)])
        .then(([app, authMod]) => ({ initializeApp: app.initializeApp, authMod })),
    });
  }

  return { boot, runtimeFor, ORDER_ENDPOINTS };
});
