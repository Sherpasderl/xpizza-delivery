// Customer app — THE ONE HOST of the multi-store shell, for the WEB site and the NATIVE app alike (PLAN-capp-desktop-website r2
// D-1; was the native shell's bootstrap, PLAN-capp-native-shell §1.2 / N2). The packaged shell (platform/native/package-capp.js,
// --target web | native: shell.html published AS index.html) loads the SAME customer-app modules, a generated CAPP_RUNTIME (the
// platform orders deployment's `runtime` block from platform/sites.json + the build's flags + its mode), then this file. It
// builds the shell's transports and runtime from that DATA and calls CappShellUI.mount(document, opts). Brand-agnostic (no
// restaurant id, name or host in this file — guarded). The web and native builds differ only in their stamp (deployment id,
// env) and runtime.mode; native-only behaviour (Preferences, the store-update UX) keys on runtime.mode === 'native'.
//
// boot(doc, opts) → the CappShellUI instance (or null with no / an invalid runtime)
//   opts.runtime  { mode: 'web' | 'native', functions_base, menu_endpoint, availability_base, intake_key, maps_key, firebase,
//                   directory_endpoint?, sdk_base, flags: { signup?, intlPhone?, guestCardOnly?, schedulingLive?, ratings?, sdkPay? } }   absent flag ⇒ dark
//   opts.fetch, opts.importModule (the dynamic import; tests inject), opts.CappShellUI, opts.CappSignupApi, and every other
//   CappShellUI.mount option (storage, now, timers, win, uiOpts, onEvent) passed through unchanged
// Transports (the CappShellUI contract):
//   fetchDirectory(etag)       the directory endpoint, If-None-Match ⇒ { status, body?, etag? }; none configured ⇒ { status: 0 }
//                              (the shell's drawn directory failure) — the endpoint is not wired yet (5f)
//   fetchEnvelope(rid, etag)   getPublicMenu's /menu/<rid> (the rid in the PATH), If-None-Match ⇒ { status, body?, etag? }
//   readAvailability(rid, menu) the RTDB restaurants/<rid>/item_availability node (no-store) mapped by CappAvailability onto the
//                              menu's dish keys via the envelope's availability identity (menu.availIdentity, 5f marker 1d.3) and
//                              the synced avail-key.js + availability-reducer.js — the forms' decision. An envelope WITHOUT the
//                              identity (older), a failed read or an unreadable body ⇒ null = FAIL-OPEN (every dish available;
//                              the server refuses a sold dish at intake). Never a guessed identity.
//   loadSdk()                  the BUNDLED Firebase SDK (platform/native/vendor, sha-pinned) — never gstatic at runtime
// auth: not passed — under runtime.signup the shell creates its own CappAuthState (capp-shell-ui startAuth); without it, the
// shell's documented unresolved state (never assumed guest).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.CappBoot = api;
    if (root.CAPP_RUNTIME && root.document) root.CappBoot.instance = api.boot(root.document, { runtime: root.CAPP_RUNTIME });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // the order endpoints the app calls (capp-api.js's E.*) — capp-boot.test.mjs pins this list EQUAL to capp-api's
  const MODES = Object.freeze(['web', 'native']);
  const ORDER_ENDPOINTS = Object.freeze(['quoteOrder', 'createOrder', 'chargeOnlineOrder', 'paymentStatus', 'requestCheckoutCode', 'verifyCheckoutCode']);
  // S2 (sdkPay): the adjustment (CONTRACT-sdk-customer §3) and checkout (CONTRACT-sdk-checkout r3) endpoints
  const SDK_ENDPOINTS = Object.freeze(['getPayAdjust', 'respondPayAdjust', 'placeSdkOrder', 'placeSdkStatus', 'cancelSdkPending', 'continueSdkPayment', 'listCards', 'removeCard', 'sdkPayStatus', 'recoverOrderAccess']);
  const g = typeof self !== 'undefined' ? self : {};
  const pick = (o, name) => o[name] || g[name];
  const avail = (o) => { const A = pick(o, 'CappAvailability'), R = pick(o, 'availabilityReducer'), K = pick(o, 'availKey');
    return A && R && typeof K === 'function' ? A.createAvailability({ availKey: K, decide: R.decide }) : null; };

  const STORE = Object.freeze({ ios: { host: 'apps.apple.com', name: 'App Store' }, android: { host: 'play.google.com', name: 'Google Play' } });
  function platformOf() { try { const C = g.Capacitor, p = C && typeof C.getPlatform === 'function' ? C.getPlatform() : null; return STORE[p] ? p : null; } catch (_) { return null; } }
  function storeFor(rt, plat = platformOf()) {
    if (rt.mode !== 'native' || !plat || !rt.store_urls || typeof rt.store_urls !== 'object') return null;
    const u = rt.store_urls[plat]; let ok = false; try { const x = new URL(u); ok = x.protocol === 'https:' && x.hostname === STORE[plat].host; } catch (_) { ok = false; }
    return ok ? { name: STORE[plat].name, url: u } : null;
  }
  function runtimeFor(rt, CappSignupApi) {
    const base = rt.functions_base, f = rt.flags || {};
    const url = (name) => `${base}/${name}`;
    return {
      endpoints: Object.fromEntries(ORDER_ENDPOINTS.map((n) => [n, url(n)])),
      intakeKey: rt.intake_key, mapsKey: rt.maps_key || undefined,
      ...(rt.mode === 'native' ? { native: true } : {}),   // the INSTALLED app (store-update state 4: a build change on this device)
      // «Pedido recibido»: the public tracking reads (order number) on the RTDB base; the per-context tracker links; the help WhatsApp
      ...(typeof rt.availability_base === 'string' && rt.availability_base ? { rtdbBase: rt.availability_base } : {}),
      ...(rt.track_bases && typeof rt.track_bases === 'object' && !Array.isArray(rt.track_bases) ? { trackBases: Object.fromEntries(Object.entries(rt.track_bases).filter(([, v]) => typeof v === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(v))) } : {}),
      ...(typeof rt.support_whatsapp === 'string' && /^\+[1-9]\d{7,14}$/.test(rt.support_whatsapp) ? { supportWhatsapp: rt.support_whatsapp.slice(1) } : {}),
      // the native store-update (MOCKUP-capp-native-store-update): the INSTALLED app's own store, from runtime.store_urls by its
      // platform — absent (web, no listing yet, an unknown platform) ⇒ no store sheet (today's shared notice stays)
      ...(storeFor(rt) ? { store: storeFor(rt) } : {}),
      ...(f.schedulingLive === true ? { schedulingLive: true } : {}),
      ...(f.intlPhone === true ? { intlPhone: true } : {}),
      ...(f.guestCardOnly === true ? { guestCardOnly: true } : {}),
      ...(f.ratings === true ? { ratings: true } : {}),   // C-2: the rating sheet + its entries (dark until the rating server is live)
      // S2: the in-app card screens + their endpoints (CONTRACT-sdk-customer §3 + CONTRACT-sdk-checkout r3; dark until D4 is live)
      ...(f.sdkPay === true ? { sdkPay: { endpoints: Object.fromEntries(SDK_ENDPOINTS.map((n) => [n, url(n)])) } } : {}),
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
    if (!rt || typeof rt.functions_base !== 'string' || !rt.functions_base || !MODES.includes(rt.mode)) return null;   // never a guessed mode
    const CappShellUI = pick(o, 'CappShellUI'), CappSignupApi = pick(o, 'CappSignupApi');
    const fetchFn = o.fetch || (typeof fetch === 'function' ? fetch.bind(g) : null);
    const importModule = o.importModule || ((p) => import(p));
    const sdk = String(rt.sdk_base || '');
    const { runtime: _r, fetch: _f, importModule: _i, CappShellUI: _c, CappSignupApi: _s, CappAvailability: _a, availabilityReducer: _ar, availKey: _ak, ...pass } = o;
    const mapper = avail(o);
    return CappShellUI.mount(doc, {
      ...pass,
      runtime: runtimeFor(rt, CappSignupApi),
      // D-4a Phase 1: the WEBSITE reflects / hydrates URLs; the native shell keeps today's navigation exactly (mode native ⇒ off)
      ...(rt.mode === 'web' ? { routing: true } : {}),
      fetchDirectory: (etag) => (typeof rt.directory_endpoint === 'string' && rt.directory_endpoint
        ? conditional(fetchFn, `${rt.functions_base}/${rt.directory_endpoint}`, etag) : Promise.resolve({ status: 0 })),
      fetchEnvelope: (rid, etag) => conditional(fetchFn, `${rt.functions_base}/${rt.menu_endpoint}/menu/${encodeURIComponent(rid)}`, etag),
      readAvailability: async (rid, menu) => {
        if (!mapper || !menu || !menu.availIdentity || typeof rid !== 'string' || !rid) return null;   // no identity ⇒ fail-open, no read
        mapper.observe(menu);   // the key history BEFORE the read, every time (a failed read still records it — the forms' rule)
        try {
          const res = await fetchFn(`${rt.availability_base}/restaurants/${encodeURIComponent(rid)}/item_availability.json`, { method: 'GET', cache: 'no-store' });
          if (!res || res.status !== 200) return null;
          return mapper.soldKeys(menu, await res.json());
        } catch (_) { return null; }
      },
      readPublic: (href) => fetchFn(href, { method: 'GET', cache: 'no-store' }),   // the order number's public tracking read
      loadSdk: () => Promise.all([importModule(`${sdk}firebase-app.js`), importModule(`${sdk}firebase-auth.js`)])
        .then(([app, authMod]) => ({ initializeApp: app.initializeApp, authMod })),
    });
  }

  return { boot, runtimeFor, storeFor, ORDER_ENDPOINTS, MODES };
});
