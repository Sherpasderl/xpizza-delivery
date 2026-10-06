// ── P-SELFUPDATE CP2 — the SHARED BROWSER MODULE (sherpa-client.js) ─────────────────────────────────────────────────
//
// Canonical source: <repo>/platform/client/sherpa-client.js. Every manifest site folder carries a BYTE-IDENTICAL
// committed copy (`npm run sync:client` in xpizza-functions; a drift guard test fails on any difference). A classic
// script (no module, no inline code — CSP-safe), loaded with a plain <script src> before the page's own code.
//
// What it does (PLAN §1–§5):
//   • IDENTITY — read ONLY from the <meta> tags the build stamp writes (platform/stamp-version.js). No tags (local
//     files, a failed stamp) = INERT: no version checks, no reloads, no heartbeat, no X-Client headers. The page
//     behaves exactly as it did before the module existed.
//   • STALENESS (§2) — /version.json fetched `cache: no-store` on load, every 10 min while visible, and on wake
//     (visible / focus / online), coalesced (one check in flight). A malformed or unreachable answer = UNKNOWN = no
//     action. Stale = its (build, compat) differs from the page's.
//   • SAFE SELF-UPDATE (§3) — ONE coordinator + a per-app ADAPTER {canReload, prepareReload, afterReload}. NOTHING reloads
//     before the app has registered its adapter (its readiness declaration; no generic fallback); then only when the
//     adapter says it is safe. prepareReload's snapshot is written to sessionStorage; a failed write = NO
//     reload. A reload-loop guard (≤ 3 attempts per current→target, with backoff) then a non-blocking notice.
//   • THE UNKNOWN-OUTCOME LATCH (§3, owner Q8) — an in-memory set of money-bearing request attempts. An attempt is
//     added when sent and removed ONLY by an endpoint-specific DEFINITIVE outcome of THAT request (status + decodable
//     body; see definitiveOutcome). A network failure, a 5xx, a timeout, 202 in_progress or an undecodable body leaves
//     it latched until the page closes. While the set is non-empty EVERY reload path is refused and
//     the page shows "Actualización pendiente".
//   • THE REQUEST WRAPPER (§5) — SherpaClient.fetch(url, init, opts). It adds X-Client-App/-Deployment/-Build/-Compat
//     ONLY on the identity endpoints (IDENTITY_ENDPOINTS; advisor ruling CP2 Q6: a simple GET must not gain a
//     preflight); latches money-bearing attempts; treats `426 client_update_required` as TERMINAL and asks the
//     coordinator for an update. It returns the Response exactly as fetch would and rethrows exactly what fetch
//     throws: the caller's existing handling is unchanged.
//   • HEARTBEAT (§4) — POST to reportClientVersion on load (jittered), every 10 min while visible and on wake
//     (coalesced, ≥ 60 s apart). Fire-and-forget, bounded by a timeout, deferred while a money request is in flight,
//     every failure silent. Production deploys only (the stamp's Netlify CONTEXT).
//
// FAIL-OPEN: every module path is wrapped; an error in the module never blocks a page or a request (§ Rollout).
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && !root.SherpaClient) {
    try { root.SherpaClient = api.create({ window: root }); } catch (_) { /* never break the page */ }
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var VERSION_PATH = '/version.json';
  var HEARTBEAT_URL = 'https://us-central1-xpizza-delivery.cloudfunctions.net/reportClientVersion';
  var IDENTITY_ENDPOINTS = ['createOrder', 'quoteOrder', 'chargeOnlineOrder', 'quoteRedemption'];
  var MONEY_ENDPOINTS = ['createOrder', 'chargeOnlineOrder'];
  var CHECK_EVERY_MS = 10 * 60 * 1000;
  var HEARTBEAT_EVERY_MS = 10 * 60 * 1000;
  var HEARTBEAT_MIN_GAP_MS = 60 * 1000;
  var HEARTBEAT_TIMEOUT_MS = 8000;
  var VERSION_TIMEOUT_MS = 8000;
  var GUARD_MAX = 3;
  var GUARD_BACKOFF_MS = [0, 60 * 1000, 5 * 60 * 1000];
  var BUILD_RE = /^[A-Za-z0-9._-]{1,80}$/;
  var ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  var KEY_GUARD = 'sherpa_reload_guard';
  var KEY_SNAPSHOT = 'sherpa_reload_snapshot';
  var KEY_INSTANCE = 'sherpa_instance';
  var NOTICE_PENDING = 'Actualización pendiente';

  function readIdentity(doc) {
    var get = function (n) { var m = doc.querySelector('meta[name="' + n + '"]'); return m ? String(m.getAttribute('content') || '') : ''; };
    var id = { app: get('sherpa-app'), deployment: get('sherpa-deployment'), context: get('sherpa-context'),
      build: get('app-build'), compat: Number(get('app-compat')), env: get('sherpa-env') };
    if (!ID_RE.test(id.app) || !ID_RE.test(id.deployment) || !ID_RE.test(id.context) || !BUILD_RE.test(id.build)
      || !Number.isInteger(id.compat) || id.compat < 1) return null;
    return id;
  }

  // a /version.json body → {build, compat} | null (malformed = unknown)
  function parseVersion(v, identity) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.app !== identity.app || v.deployment !== identity.deployment) return null;
    if (typeof v.build !== 'string' || !BUILD_RE.test(v.build) || !Number.isInteger(v.compat) || v.compat < 1) return null;
    return { build: v.build, compat: v.compat };
  }
  var key = function (x) { return x.build + '|' + x.compat; };

  function endpointOf(url) {
    try { var p = String(url).split('?')[0].split('/'); return p[p.length - 1] || ''; } catch (_) { return ''; }
  }

  function create(opts) {
    var w = opts.window;
    var doc = opts.document || w.document;
    var now = opts.now || function () { return Date.now(); };
    var rand = opts.random || Math.random;
    var realFetch = opts.fetch || function (u, i) { return w.fetch(u, i); };
    var reload = opts.reload || function () { w.location.reload(); };
    var setT = opts.setTimeout || function (f, ms) { return w.setTimeout(f, ms); };
    var setI = opts.setInterval || function (f, ms) { return w.setInterval(f, ms); };
    var ss = function () { try { return w.sessionStorage || null; } catch (_) { return null; } };
    var log = function () { try { if (w.console) w.console.warn.apply(w.console, ['[sherpa]'].concat([].slice.call(arguments))); } catch (_) {} };

    var identity = null;
    try { identity = readIdentity(doc); } catch (_) { identity = null; }
    if (identity) { try { w.__SHERPA_DEPLOYMENT = { app: identity.app, deployment: identity.deployment, context: identity.context }; } catch (_) {} }

    // ── the latch ──────────────────────────────────────────────────────────────────────────────────────────────────
    var latched = new Set();
    var inFlightMoney = 0;
    var seq = 0;
    var latch = {
      begin: function (id) { latched.add(id); return id; },
      resolve: function (id) { latched.delete(id); },
      size: function () { return latched.size; },
    };

    // ── notice (non-blocking; CSSOM only, CSP-safe) ────────────────────────────────────────────────────────────────
    var adapter = null;
    var noticeEl = null;
    function notice(text) {
      try {
        if (adapter && typeof adapter.notice === 'function') { adapter.notice(text); return; }
        if (!doc.body) return;
        if (!noticeEl) {
          noticeEl = doc.createElement('div');
          noticeEl.setAttribute('role', 'status');
          noticeEl.setAttribute('data-sherpa-notice', '');
          var s = noticeEl.style;
          s.position = 'fixed'; s.left = '0'; s.right = '0'; s.bottom = '12px'; s.margin = '0 auto'; s.width = 'max-content'; s.zIndex = '2147483000';
          s.background = '#1f2937'; s.color = '#ffffff'; s.padding = '8px 14px'; s.borderRadius = '8px';
          s.font = '600 13px/1.3 system-ui, sans-serif'; s.pointerEvents = 'none'; s.maxWidth = '90vw';
          doc.body.appendChild(noticeEl);
        }
        noticeEl.textContent = text;
      } catch (_) {}
    }

    // ── reload-loop guard + snapshot (sessionStorage) ──────────────────────────────────────────────────────────────
    function readJSON(k) { try { var s = ss(); var v = s && s.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } }
    function writeJSON(k, v) { try { var s = ss(); if (!s) return false; s.setItem(k, JSON.stringify(v)); return s.getItem(k) !== null; } catch (_) { return false; } }
    function remove(k) { try { var s = ss(); if (s) s.removeItem(k); } catch (_) {} }

    // on load: a guard whose target we now ARE is a success → cleared
    if (identity) {
      var g0 = readJSON(KEY_GUARD);
      if (g0 && g0.to === key(identity)) remove(KEY_GUARD);
    }

    var stale = null;           // the target {build, compat} once known
    var updating = false;
    var forced = null;          // a 426 asked for an update: { mode: 'checkout' }

    function guardAllows(target) {
      var cur = key(identity), to = key(target);
      var g = readJSON(KEY_GUARD);
      if (!g || g.from !== cur || g.to !== to) return { ok: true, attempts: 0 };
      if (g.attempts >= GUARD_MAX) return { ok: false, exhausted: true };
      if (now() - g.last < GUARD_BACKOFF_MS[Math.min(g.attempts, GUARD_BACKOFF_MS.length - 1)]) return { ok: false };
      return { ok: true, attempts: g.attempts };
    }

    // THE coordinator. Every reload path comes through here. → true only when it reloaded.
    function tryUpdate(mode) {
      try {
        if (!identity || !stale || updating) return false;
        if (latched.size > 0) { notice(NOTICE_PENDING); return false; }
        var g = guardAllows(stale);
        if (!g.ok) { if (g.exhausted) notice(NOTICE_PENDING); return false; }
        // codex CP2 r1 B1: NO reload until the app's adapter has explicitly declared readiness (registerAdapter) — there
        // is no generic fallback. Until then the page may not yet have its payment-return protection, its snapshot
        // restore or its own idea of "busy"; a stale build simply waits for the registration.
        var a = adapter;
        if (!a || typeof a.canReload !== 'function') return false;
        var can = false;
        try { can = a.canReload({ mode: mode || 'idle' }) === true; } catch (e) { log('canReload threw', e); can = false; }
        if (!can) { if (typeof a.blockedNotice === 'string') notice(a.blockedNotice); return false; }
        var snap;
        if (a && typeof a.prepareReload === 'function') {
          try { snap = a.prepareReload({ mode: mode || 'idle' }); } catch (e) { log('prepareReload threw', e); return false; }
          if (snap === false) return false;
        }
        if (snap !== undefined && snap !== null) {
          if (!writeJSON(KEY_SNAPSHOT, { v: 1, deployment: identity.deployment, mode: mode || 'idle', at: now(), data: snap })) return false;   // failed write = NO reload
        }
        if (!writeJSON(KEY_GUARD, { from: key(identity), to: key(stale), attempts: g.attempts + 1, last: now() })) {
          remove(KEY_SNAPSHOT);
          return false;   // no loop guard possible → never reload unguarded
        }
        updating = true;
        reload();
        return true;
      } catch (e) { log('coordinator', e); return false; }
    }

    // IDLE (PLAN §3, dispatch / dispatch-mobile / dashboard / track / legal / catering): no focused field, none of the
    // app's OPEN overlays (each app names its own — an aria-modal element that merely exists is not "open"), no request
    // of ours in flight, no tap / key in the last 30 s (an SDK write a tap started settles well inside that), online,
    // and not within 30 s of coming back online (queued offline writes flush first). Anything unreadable = not idle.
    var lastInteraction = 0, lastOnline = 0, inFlightAll = 0, pendingSdkWrites = 0;
    // codex CP2 r1 B4: an app's SDK writes (Firebase set/update/remove/transaction) are COUNTED from issue until the SDK's
    // promise settles — i.e. until the server acknowledged (or definitively refused) them. A stalled connection keeps the
    // count up for as long as it lasts: "idle" means no outstanding write, not "30 s since the last tap".
    function trackWrite(p) {
      try {
        if (!p || typeof p.then !== 'function') return p;
        pendingSdkWrites += 1;
        var done = false;
        var settle = function () { if (!done) { done = true; pendingSdkWrites -= 1; } };
        p.then(settle, settle);
      } catch (_) {}
      return p;
    }
    var INTERACTION_GRACE_MS = 30 * 1000, ONLINE_GRACE_MS = 30 * 1000;
    function idleNow(cfg) {
      try {
        cfg = cfg || {};
        if (inFlightAll > 0 || pendingSdkWrites > 0) return false;
        if (now() - lastInteraction < INTERACTION_GRACE_MS || now() - lastOnline < ONLINE_GRACE_MS) return false;
        if (w.navigator && w.navigator.onLine === false) return false;
        var el = doc.activeElement;
        if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return false;
        var sel = ['dialog[open]'].concat(cfg.overlays || []).join(', ');
        if (doc.querySelector(sel)) return false;
        if (typeof cfg.busy === 'function' && cfg.busy()) return false;
        return true;
      } catch (_) { return false; }
    }
    function idleAdapter(cfg) {
      return { canReload: function () { return idleNow(cfg); }, blockedNotice: cfg && cfg.blockedNotice };
    }

    // ── staleness check ────────────────────────────────────────────────────────────────────────────────────────────
    var checking = null;
    function check() {
      if (!identity) return Promise.resolve(null);
      if (checking) return checking;
      checking = new Promise(function (resolve) {
        var done = false;
        var finish = function (v) { if (!done) { done = true; checking = null; resolve(v); } };
        setT(function () { finish(null); }, VERSION_TIMEOUT_MS);
        Promise.resolve().then(function () { return realFetch(VERSION_PATH, { cache: 'no-store', credentials: 'same-origin' }); })
          .then(function (r) { return r && r.ok ? r.json() : null; })
          .then(function (v) {
            var t = parseVersion(v, identity);
            if (t && key(t) !== key(identity)) stale = t;
            else if (t) stale = null;
            finish(t);
          }, function () { finish(null); });
      });
      return checking.then(function (t) { if (stale) tryUpdate(forced ? forced.mode : 'idle'); return t; });
    }

    // ── 426 → the coordinator (§5): terminal, never retried by the module ──────────────────────────────────────────
    function updateRequired(mode) {
      try {
        forced = { mode: mode || 'idle' };
        if (latched.size > 0) { notice(NOTICE_PENDING); return; }
        check().then(function () {
          // the server says update, but no newer deploy is visible yet → nothing to reload to; say so, never loop
          if (!stale) notice(NOTICE_PENDING);
        });
      } catch (_) {}
    }

    // ── the request wrapper ────────────────────────────────────────────────────────────────────────────────────────
    function clientHeaders() {
      if (!identity) return {};
      return { 'X-Client-App': identity.app, 'X-Client-Deployment': identity.deployment, 'X-Client-Build': identity.build, 'X-Client-Compat': String(identity.compat) };
    }
    function sfetch(url, init, o) {
      // UNSTAMPED (inert): a byte-identical pass-through — same arguments, no headers, no latch (ruling CP2 Q7.3)
      if (!identity) return realFetch(url, init);
      o = o || {};
      var ep = endpointOf(url);
      var req = init;
      try {
        if (identity && IDENTITY_ENDPOINTS.indexOf(ep) >= 0) {
          var h = {};
          var src = (init && init.headers) || {};
          if (typeof src.forEach === 'function' && !Array.isArray(src)) src.forEach(function (v, k) { h[k] = v; });
          else for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) h[k] = src[k];
          var ch = clientHeaders();
          for (var c in ch) h[c] = ch[c];
          req = Object.assign({}, init || {}, { headers: h });
        }
      } catch (_) { req = init; }
      var money = MONEY_ENDPOINTS.indexOf(ep) >= 0;
      var attempt = null;
      if (money) { attempt = latch.begin('a' + (++seq) + '_' + now()); inFlightMoney++; }
      inFlightAll++;
      var p;
      try { p = realFetch(url, req); } catch (e) { if (money) inFlightMoney--; inFlightAll--; throw e; }   // never issued: stays latched
      return Promise.resolve(p).then(function (res) {
        if (money) inFlightMoney--;
        inFlightAll--;
        try {
          // codex CP2 r1 B2: an attempt is cleared ONLY by an endpoint-specific DEFINITIVE outcome, judged on the status
          // AND a decodable body (read from a clone — the caller's Response is untouched). In-progress, ambiguous and
          // body-decode failures stay latched.
          // ONE decode of a clone, then in order: the latch FIRST (a definitive 426 clears its own attempt), then the
          // 426 hand-off — so the coordinator never sees this request's own attempt as still unknown
          if (res && (money || res.status === 426)) {
            var st = res.status;
            res.clone().json().then(function (body) {
              if (money && definitiveOutcome(ep, st, body)) latch.resolve(attempt);
              if (st === 426 && body && body.error === 'client_update_required') updateRequired(o.mode || (money ? 'checkout' : 'idle'));
            }, function () { /* undecodable body = ambiguous → stays latched; no 426 hand-off */ });
          }
        } catch (_) {}
        return res;
      }, function (err) {
        if (money) inFlightMoney--;
        inFlightAll--;
        throw err;   // network failure: the attempt stays latched (outcome unknown)
      });
    }

    // The DEFINITIVE outcomes, per money endpoint (the server contracts in index.js / pixelpay-hosted-charge.js):
    //   createOrder        2xx (created / idempotent existing) · 4xx with a typed {error} body (refused before any mutation)
    //   chargeOnlineOrder  2xx with a checkout_url (attempt installed / reused) · 409 {error:'Already paid'} ·
    //                      4xx with a typed {error} body. NOT 202 {status:'in_progress'} (checkout creation still underway).
    //   anything else — 5xx, 408, 1xx/3xx, a 2xx without the expected body, an undecodable body — is NOT definitive.
    function definitiveOutcome(ep, status, body) {
      var typed = body && typeof body === 'object' && !Array.isArray(body);
      var refusal = status >= 400 && status < 500 && status !== 408 && typed && typeof body.error === 'string' && body.error.length > 0;
      if (ep === 'createOrder') return (status >= 200 && status < 300 && typed) || refusal;
      if (ep === 'chargeOnlineOrder') {
        if (status === 202) return false;
        if (status >= 200 && status < 300) return !!(typed && typeof body.checkout_url === 'string' && body.checkout_url);
        return refusal;
      }
      return false;
    }

    // ── heartbeat ──────────────────────────────────────────────────────────────────────────────────────────────────
    var instance = null;
    function instanceId() {
      if (instance) return instance;
      var s = ss();
      try { instance = s && s.getItem(KEY_INSTANCE); } catch (_) { instance = null; }
      if (!instance || !/^[A-Za-z0-9_-]{8,64}$/.test(instance)) {
        instance = 'i' + Math.floor(rand() * 0xffffffff).toString(36) + Math.floor(rand() * 0xffffffff).toString(36) + now().toString(36);
        try { if (s) s.setItem(KEY_INSTANCE, instance); } catch (_) {}
      }
      return instance;
    }
    var lastBeat = 0;
    var beatQueued = false;
    function heartbeat(diag) {
      try {
        if (!identity || identity.env !== 'production') return;
        if (!diag && (beatQueued || now() - lastBeat < HEARTBEAT_MIN_GAP_MS)) return;
        if (inFlightMoney > 0) { setT(function () { heartbeat(diag); }, 5000); return; }   // never contend with an order request
        if (!diag) lastBeat = now();
        var body = { app: identity.app, deployment: identity.deployment, context: identity.context, build: identity.build, compat: identity.compat, instance: instanceId() };
        if (diag) body.diag = diag;
        var ctl = typeof w.AbortController === 'function' ? new w.AbortController() : null;
        if (ctl) setT(function () { try { ctl.abort(); } catch (_) {} }, HEARTBEAT_TIMEOUT_MS);
        var p = realFetch(HEARTBEAT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined, keepalive: false });
        if (p && typeof p.then === 'function') p.then(function () {}, function () {});   // every outcome silent
      } catch (_) {}
    }
    function scheduleBeat(minMs, spanMs) {
      if (beatQueued) return;
      beatQueued = true;
      setT(function () { beatQueued = false; heartbeat(); }, minMs + Math.floor(rand() * spanMs));
    }

    // ── triggers ───────────────────────────────────────────────────────────────────────────────────────────────────
    var visible = function () { try { return doc.visibilityState !== 'hidden'; } catch (_) { return true; } };
    function wake() { if (!visible()) return; check(); scheduleBeat(1000, 4000); }
    function start() {
      if (!identity || opts.autoStart === false) return;
      try {
        setT(function () { check(); }, 1500 + Math.floor(rand() * 1500));
        scheduleBeat(3000, 7000);
        setI(function () { if (visible()) { check(); heartbeat(); } }, CHECK_EVERY_MS);
        doc.addEventListener('visibilitychange', function () { if (visible()) wake(); });
        w.addEventListener('focus', wake);
        w.addEventListener('online', function () { lastOnline = now(); wake(); });
        var touched = function () { lastInteraction = now(); };
        doc.addEventListener('pointerdown', touched, true);
        doc.addEventListener('keydown', touched, true);
      } catch (e) { log('start', e); }
    }

    // ── adapters + after-reload restore ────────────────────────────────────────────────────────────────────────────
    var adapterReadyAt = null;
    function registerAdapter(a) {
      if (!a || typeof a.canReload !== 'function') { log('registerAdapter: an adapter must declare canReload — ignored'); return; }
      adapter = a;
      adapterReadyAt = now();
      try { doc.dispatchEvent(new w.CustomEvent('sherpa:adapter-ready', { detail: { at: adapterReadyAt } })); } catch (_) {}
      try {
        var snap = readJSON(KEY_SNAPSHOT);
        if (snap) {
          remove(KEY_SNAPSHOT);   // restored at most once
          if (identity && snap.v === 1 && snap.deployment === identity.deployment && a && typeof a.afterReload === 'function') {
            try { a.afterReload(snap.data, { mode: snap.mode }); } catch (e) { log('afterReload threw', e); }
          }
        }
      } catch (_) {}
      if (stale) tryUpdate(forced ? forced.mode : 'idle');
    }

    start();

    return {
      identity: identity,
      inert: !identity,
      fetch: sfetch,
      headers: clientHeaders,
      latch: latch,
      registerAdapter: registerAdapter,
      adapterReady: function () { return !!adapter; },
      trackWrite: trackWrite,
      pendingWrites: function () { return pendingSdkWrites; },
      idleAdapter: idleAdapter,
      quiet: function () { return now() - lastInteraction >= INTERACTION_GRACE_MS; },   // no tap / key in the last 30 s
      poke: function () { if (stale) tryUpdate(forced ? forced.mode : 'idle'); },
      check: check,
      reportDiag: function (d) { heartbeat(d); },
      isStale: function () { return !!stale; },
      updateRequired: updateRequired,
      _heartbeat: heartbeat,
      _updateRequired: updateRequired,
    };
  }

  return { create: create, readIdentity: readIdentity, parseVersion: parseVersion, endpointOf: endpointOf,
    IDENTITY_ENDPOINTS: IDENTITY_ENDPOINTS, MONEY_ENDPOINTS: MONEY_ENDPOINTS, HEARTBEAT_URL: HEARTBEAT_URL };
}));
