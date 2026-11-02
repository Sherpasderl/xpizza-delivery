// Customer app S7a-2 (PLAN-capp-S7a r1-r3.4, APPROVED; MOCKUP-capp-S7a-states APPROVED 2026-10-27) — the multi-store SHELL host:
// Inicio, Buscar and store entry over the directory (capp-directory), the ONE shared menu cache (capp-menu-cache), store-entry
// eligibility (capp-eligibility), the shell navigation (capp-shell-nav) and the store mount (capp-ui, configured by capp-shell's
// configFor). Brand-agnostic (no restaurant id or name in this file — guarded). DARK: only the undeployed shell.html loads it.
//
// mount(doc, opts)
//   opts.fetchDirectory(etag|null) → Promise<{ status, body?, etag? }>       the directory transport (status 0 = network failure)
//   opts.fetchEnvelope(rid, etag|null) → Promise<{ status, body?, etag? }>   getPublicMenu
//   opts.readAvailability(rid, menu) → Promise<iterable of sold dish keys | null>   the live availability read (null = failed ⇒
//        FAIL-OPEN: every dish available, exactly as the forms' loadAvailability; the server refuses at intake)
//   opts.runtime { endpoints, intakeKey, mapsKey }   the app deployment's transport (configFor's runtime)
//   opts.auth  a CappAuthState instance (absent ⇒ unresolved — never assumed guest)
//   runtime.schedulingLive  S4's ONE switch (frame 3 B's second sentence, «Programar pedido», and the store's scheduling via
//                           configFor); absent ⇒ off. Replaces the former opts.schedulingLive (one source)
//   opts.storage, opts.now (ms), opts.timers, opts.win, opts.uiOpts (passed through to CappUI.mount: apiOpts, geolocation, …)
//   opts.onEvent(name, detail)  the controls whose screens land in later slices ('tab' orders / account, 'addr', 'loc-on')
//
// Paint is never awaited (r3.3-F6): the stored directory and stored menus paint at once as PRESENTATION; every read runs after.
// A store row enters ONLY while its eligibility is verified (< 60 s) AND its menu body is in hand; otherwise the tap is HELD (the
// drawn pressed state) and opens the moment both are true — a tombstone releases it, a failed directory shows frame 7.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappShellUI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIR_EVERY_MS = 60 * 1000, AVAIL_EVERY_MS = 30 * 1000, MENU_LRU = 8, RECENT_MAX = 5;
  const MENU_KEY = (rid) => `capp:menu:${rid}`, AVAIL_KEY = (rid) => `capp:avail:${rid}`, LRU_KEY = 'capp:menu:lru', RECENT_KEY = 'capp:recent', LOC_KEY = 'capp:guest_loc';
  const g = typeof self !== 'undefined' ? self : {};
  const pick = (opts, name, file) => opts[name] || g[name] || (typeof require === 'function' ? require(file) : null);

  function mount(doc, opts) {
    const o = opts || {};
    const CappDirectory = pick(o, 'CappDirectory', './capp-directory.js'), CappEligibility = pick(o, 'CappEligibility', './capp-eligibility.js');
    const CappMenuCache = pick(o, 'CappMenuCache', './capp-menu-cache.js'), CappMenu = pick(o, 'CappMenu', './capp-menu.js');
    const CappUI = pick(o, 'CappUI', './capp-ui.js'), CappShell = pick(o, 'CappShell', './capp-shell.js');
    const CappShellNav = pick(o, 'CappShellNav', './capp-shell-nav.js'), CappHome = pick(o, 'CappHome', './capp-home.js');
    const CappOrder = pick(o, 'CappOrder', './capp-order.js');   // «Pedido recibido» (the host's order screen)
    const CappRate = pick(o, 'CappRate', './capp-rate.js');   // C-2: the post-delivery rating sheet (presenter)
    // the native store-update: an INSTALLED app with a store to update from never reloads its bundled assets (that cannot update it)
    // and the store sheet replaces the shared «Actualización pendiente» notice — a no-reload adapter for the shared coordinator
    if (o.runtime && o.runtime.store) { try { const SC = o.SherpaClient || g.SherpaClient; if (SC && !SC.inert && typeof SC.registerAdapter === 'function') SC.registerAdapter({ canReload: () => false, notice: () => {} }); } catch (_) {} }
    const CappCheckout = pick(o, 'CappCheckout', './capp-checkout.js'), CappDeviceAccount = pick(o, 'CappDeviceAccount', './capp-device-account.js');
    const win = o.win || doc.defaultView;
    // capp-dark §3: the shell's own live map (the Inicio pin editor) follows the OS — one subscription, the same instance restyled
    const Theme = o.CappTheme || g.CappTheme || null;
    const themeStyles = () => (Theme && win ? Theme.mapStyles(win) : null);
    let pinMapRef = () => null;
    // §4: the installed app's status-bar icons follow the theme — once at boot, then on every REAL change (the subscription's media
    // event or its resume re-read): exactly one native call per flip. The web has no such plugin (no-op)
    const syncBar = () => { try { const sb = win && win.Capacitor && win.Capacitor.Plugins ? win.Capacitor.Plugins.StatusBar : null; if (!Theme || !sb || typeof sb.setStyle !== 'function') return; const p = sb.setStyle({ style: Theme.barStyle(win) }); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {} };
    const unTheme = Theme && win ? Theme.subscribe(win, () => { syncBar(); const pm = pinMapRef(); if (pm && pm.m && typeof pm.m.setOptions === 'function') { try { pm.m.setOptions({ styles: themeStyles() }); } catch (_) {} } }) : null;
    syncBar();
    const storage = o.storage !== undefined ? o.storage : (() => { try { return win.localStorage; } catch (_) { return null; } })();
    // state 4 (MOCKUP-capp-native-store-update): the INSTALLED app on a NEW build (its stamp vs the last build this device ran) ⇒ the
    // cart says «App actualizada…» once (closed ⇒ gone); the device's build is recorded at once (a reopen is never «updated» again)
    let appUpdated = false, curBuild = null;
    // the store round trip (MOCKUP-capp-native-store-update state 4; Codex store-update r1 #2): leaving for the store records WHICH
    // store's cart to come back to; the NEW build reopens that store with its cart open (the cart and any unresolved placement live in
    // their own durable records, untouched — the mount's reconciliation resumes the order's verification). One-shot, 24 h.
    const HANDOFF_KEY = 'capp:store_handoff', HANDOFF_MS = 24 * 3600e3;
    // the handoff records the build it left FROM: any later launch on a DIFFERENT build restores it (an offline first launch never
    // loses it — Codex store-update r2 #2); it is cleared only once the destination store has actually mounted
    function keepHandoff(rid) { try { if (storage && typeof rid === 'string') storage.setItem(HANDOFF_KEY, JSON.stringify({ v: 1, rid, at: Number(nowMs()), build: curBuild })); } catch (_) {} }
    function pendingHandoff() {
      let h = null; try { h = storage ? JSON.parse(storage.getItem(HANDOFF_KEY) || 'null') : null; } catch (_) { h = null; }
      const age = h && Number.isFinite(h.at) ? Number(nowMs()) - h.at : NaN;
      if (!h || h.v !== 1 || typeof h.rid !== 'string' || !(age >= 0 && age < HANDOFF_MS)) { if (h) clearHandoff(); return null; }
      return typeof h.build === 'string' && curBuild && h.build !== curBuild ? h.rid : null;   // not updated yet ⇒ kept, nothing restored
    }
    function clearHandoff() { try { if (storage) storage.removeItem(HANDOFF_KEY); } catch (_) {} }
    if (o.runtime && o.runtime.native === true) {
      try {
        const SC = o.SherpaClient || g.SherpaClient, b = SC && SC.identity && typeof SC.identity.build === 'string' ? SC.identity.build : null, st = storage;
        curBuild = b;
        if (b && st) { const last = st.getItem('capp:app_build'); if (last && last !== b) appUpdated = true; if (last !== b) st.setItem('capp:app_build', b); }
      } catch (_) { appUpdated = false; }
    }
    const nowMs = typeof o.now === 'function' ? o.now : () => Date.now();
    const clock = () => new Date(nowMs());
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
    const runtime = o.runtime || {};
    // PLAN-capp-desktop-website r2 D-2: the ONE breakpoint (capp-view.js, ≥ 1024 px ⇒ the APPROVED v6 desktop). Read synchronously
    // HERE so `.desk` is on #app before the first paint; a settled crossing re-renders the mounted store in place (state kept)
    // PLAN-capp-desktop-D4a-routing r2 (APPROVED, Phase 1 = URL REFLECTION): with o.routing (the web boot) the URL FOLLOWS the
    // screen by replaceState (the history STATE and the search kept — the single sentinel stays the sentinel, return evidence is
    // never stripped) and a cold / reloaded / new-tab URL is HYDRATED once; never a pushState, never Forward. Off (native, tests)
    // ⇒ nothing here runs
    const CappRoutes = pick(o, 'CappRoutes', './capp-routes.js');
    const routing = o.routing === true && !!CappRoutes && !!win && !!win.history && !!win.location;
    let pendingRoute = null, navGen = 0, hydrating = false, storeRoute = { step: 'store' }, booted = false, bootMode = 'none';
    const bootPath = routing ? String(win.location.pathname || '/') : '/';   // read BEFORE any paint could reflect over it
    const CappView = pick(o, 'CappView', './capp-view.js');
    const view = CappView ? CappView.createView(win, { timers: T }) : null;
    // G6: with the runtime's signup config (runtime.signup = { firebase, endpoints }) the shell owns the auth: the Firebase adapter
    // (its SDK loaded only AFTER the first paint) feeding CappAuthState, and the in-app sign-in sheet. Absent ⇒ exactly as before
    // (the host's opts.auth, 'signin' as a host event)
    // FLIP PRECONDITION (advisor 2026-10-27): runtime.signup stays ABSENT until G7's member Cuenta is APPROVED-HELD — a sign-in from
    // Cuenta lands on the member's Cuenta, which G7 draws
    const SU = runtime.signup && runtime.signup.firebase && runtime.signup.endpoints ? runtime.signup : null;
    let auth = o.auth || null, fbAuth = null, signup = null;
    const authNow = () => { try { return auth ? auth.state() : 'unresolved'; } catch (_) { return 'unresolved'; } };
    // PLAN-capp-store-promo-feeinfo r0: a MOUNTED store reads the same tri-state (its header's promo pill / «Envío gratis») and is
    // told when it changes — the shell's own repaint never reaches a store's #app
    // the ADMITTED identity's tri-state (Codex promo r1 #1 + the advisor's home ruling): 'member' only once S.member is applied — the
    // identity the checkout sends with — never the raw session; a session not (yet) admitted claims nothing. ONE rule: Inicio's promo
    // (vm.promoAuth) and a mounted store's header (its authState) both read it
    // Codex promo r2 P2-A: 'member' needs a USABLE token by the TRANSPORT's own predicate (CappApi.tokenUsable — what x-firebase-id-token
    // is built from); an admitted member without one is 'unresolved' (reserved, nothing claimed) until the token arrives
    // Codex promo r3: the ONE predicate WITH expiry (CappApi.tokenUsable — the transport's own header rule) at the shell's clock
    const apiMod = () => pick(o, 'CappApi', './capp-api.js');
    const usable = (m) => { const A = apiMod(); return A && typeof A.tokenUsable === 'function' ? A.tokenUsable(m, nowMs()) : null; };
    const admittedAuth = () => (S.member ? (usable(S.member) ? 'member' : 'unresolved') : authNow() === 'guest' ? 'guest' : 'unresolved');
    const storeAuth = () => { if (S.store && typeof S.store.ui.authChanged === 'function') S.store.ui.authChanged(); };
    const emit = (name, detail) => { try { (o.onEvent || (() => {}))(name, detail); } catch (_) {} };
    const $ = (id) => doc.getElementById(id);
    const app = $('app');
    const readJ = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
    const writeJ = (k, v) => { try { const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } };
    let dead = false, rebuild = true;

    const S = { tab: 'home', cuisine: '', filters: new Set(), q: '', recent: (readJ(RECENT_KEY) || []).filter((x) => typeof x === 'string').slice(0, RECENT_MAX),
      held: null, heldErr: false, store: null, layer: null, locDenied: false, loc: null, neutral: null, ret: null, retAssoc: null, order: null };
    let awaitOrderRoute = null;   // a /r/{rid}/pago reload waiting for its order's owner to resolve (identityChanged)
    // ── the guest location (r1 §2.3, owned by the SHELL, persisted per device): { lat, lng, confirmed, source: 'gps'|'pin', v } ──
    { const l = readJ(LOC_KEY); if (l && Number.isFinite(l.lat) && Number.isFinite(l.lng) && (l.source === 'gps' || l.source === 'pin')) S.loc = { lat: l.lat, lng: l.lng, confirmed: l.confirmed === true, source: l.source, v: Number(l.v) || 1 }; }
    function setLoc(lat, lng, source) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (S.loc && S.loc.lat === lat && S.loc.lng === lng && S.loc.source === source) return;
      S.loc = { lat, lng, confirmed: true, source, v: (S.loc ? S.loc.v : 0) + 1 }; S.locDenied = false;
      writeJ(LOC_KEY, S.loc);
    }
    const geoApi = () => (o.geolocation !== undefined ? o.geolocation : (win && win.navigator && win.navigator.geolocation) || null);
    // «Usar mi ubicación actual» (OWNER 2026-10-21: a detected fix is confirmed); denied / failed ⇒ the drawn locrow, NO fallback pin
    function geolocate(okMsg) {
      const g = geoApi(), deny = () => { if (dead) return; S.locDenied = true; schedule(); };
      if (!g || typeof g.getCurrentPosition !== 'function') return deny();
      try { g.getCurrentPosition((pos) => { if (dead) return; setLoc(pos.coords.latitude, pos.coords.longitude, 'gps'); toast(okMsg); schedule(); }, deny, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }); } catch (_) { deny(); }
    }
    let toastT = null;
    function toast(msg) { const t = $('toast'); if (!t || dead) return; t.textContent = msg; t.classList.add('on'); if (toastT !== null) T.clearTimeout(toastT); toastT = T.setTimeout(() => { toastT = null; if (!dead) t.classList.remove('on'); }, 4000); }

    // ── the menus: ONE cache; a validated fresh body is persisted (LRU of MENU_LRU stores) and seeded as presentation at boot ──
    const validateBody = (rid, b) => { if (!b || b.rid !== rid) return false; CappMenu.adaptMenu(b); return true; };
    function persist(rid, rec) {
      if (!writeJ(MENU_KEY(rid), rec)) return;
      const lru = [rid, ...(readJ(LRU_KEY) || []).filter((x) => x !== rid)];
      for (const old of lru.slice(MENU_LRU)) { try { storage.removeItem(MENU_KEY(old)); storage.removeItem(AVAIL_KEY(old)); } catch (_) {} }
      writeJ(LRU_KEY, lru.slice(0, MENU_LRU));
    }
    const cache = CappMenuCache.createMenuCache({ fetchEnvelope: o.fetchEnvelope, now: nowMs, validateBody, persist });
    const elig = CappEligibility.createEligibility({ now: nowMs });
    const dir = CappDirectory.createDirectory({ fetchDirectory: o.fetchDirectory, storage, now: nowMs, eligibility: elig });
    const cfgOf = (entry) => CappShell.configFor(entry, runtime);
    const views = new Map();   // rid → { body, view } (adapted once per body)
    function viewOf(rid, entry) {
      const e = cache.peek(rid); if (!e || !e.body) return null;
      const memo = views.get(rid); if (memo && memo.body === e.body) return memo.view;
      let view = null;
      try { const menu = CappMenu.adaptMenu(e.body); view = { menu, sections: CappUI.viewSections(menu, cfgOf(entry) || {}) }; } catch (_) { view = null; }
      views.set(rid, { body: e.body, view });
      return view;
    }
    const subscribed = new Set();
    function loadMenus() {
      for (const r of dir.view().rows) {
        if (r.gone) continue;
        if (!subscribed.has(r.rid)) { subscribed.add(r.rid); cache.seed(r.rid, readJ(MENU_KEY(r.rid))); cache.subscribe(r.rid, () => { schedule(); checkHeld(); tryRoute(); }); }   // a stored menu seeds once its row is known (a no-op when held in memory)
        cache.get(r.rid);   // directory order = visible stores first; the cache's global concurrency (3) and dedupe apply
      }
    }

    // ── availability (r3.3-F2): per MOUNTED store, sequence-guarded, fail-open; the last good map persisted with the menu ──
    const avail = new Map();   // rid → Set of sold dish keys (the Set the mount reads at render AND action time)
    const availOf = (rid) => { if (!avail.has(rid)) avail.set(rid, new Set((readJ(AVAIL_KEY(rid)) || []).filter((x) => typeof x === 'string'))); return avail.get(rid); };
    let availSeq = 0, availTimer = null;
    async function readAvail(rid, menu) {
      let keys = null;
      try { keys = typeof o.readAvailability === 'function' ? await o.readAvailability(rid, menu) : null; } catch (_) { keys = null; }
      return keys == null ? null : [...keys].map(String);
    }
    async function pollAvail() {
      const st = S.store; if (!st) return;
      const seq = ++availSeq;
      const keys = await readAvail(st.rid, st.ui.menu);
      if (seq !== availSeq || dead || S.store !== st) return;   // superseded, or the store was left
      const set = availOf(st.rid); set.clear();
      if (keys) { for (const k of keys) set.add(k); writeJ(AVAIL_KEY(st.rid), [...set]); }   // failed ⇒ every dish available (fail-open)
      st.ui.availabilityUpdated();
    }

    // ── the store mount ──
    function mountStore(entry, freshBody, carried) {
      const row = dir.view().rows.find((r) => r.rid === entry.rid);
      const cfg = row && cfgOf(row.entry), e = freshBody ? { body: freshBody, state: 'fresh' } : cache.peek(entry.rid);
      if (!cfg || !e || !e.body) return false;
      const uo = o.uiOpts || {};
      // r3.3-F2: only a FRESH-verified body authorizes ordering (cached-first is for PAINT only — Codex s7a2 r1 #3): a presentation
      // or STALE body mounts BROWSE-ONLY, its revalidation is started, and the fresh one turns it live in place
      const orderable = e.state === 'fresh';
      if (!orderable) cache.get(entry.rid);
      const apiOpts = { storage, ...(uo.apiOpts || {}) };
      const updOpts = { appUpdated: () => appUpdated, onAppUpdatedSeen: () => { appUpdated = false; } };   // the store's records live in the shell's storage (one device store)
      // a mount NEVER reads location.search itself: only the store that OWNS a hosted-checkout return gets it, once
      const ret = S.ret && S.ret.rid === entry.rid && !freshBody ? S.ret : null; if (ret) S.ret = null;
      const ui = CappUI.mount(doc, { ...uo, ...updOpts, ...(view ? { view, deskChrome: storeChrome, deskBrand: CappHome.brandLockHtml, deskTerms: () => { const l = legalVm(); return l && CappHome.legalUrl(l.terms) ? l.terms : null; } } : {}), guestCardOnly: runtime.guestCardOnly === true,
        onRoute: (r) => { if (!S.store || S.store.ui !== ui || !r) return; if (pendingRoute && pendingRoute.mounted && r.step !== 'store') cancelRoute(); storeRoute = r; reflect(); if (pendingRoute && pendingRoute.mounted) tryRoute(); }, ...(S.member ? { member: S.member } : {}), authState: admittedAuth, search: ret ? ret.search : '', apiOpts, orderable, deviceAccount: () => CappDeviceAccount.read(storage), beforeCheckout: () => adoptBeforeCheckout(), envelope: e.body, config: cfg, unavailable: availOf(entry.rid), now: clock, history: nav.adapterFor(entry), seedPin: () => S.loc,
        readAvailability: () => readAvail(entry.rid, ui && ui.menu),
        onCartChange: (snap) => { writeJ(cfg.cartKey, snap); if (typeof uo.onCartChange === 'function') uo.onCartChange(snap); },
        onEvent: (name, detail) => { if (name === 'outcome') { settleRet(entry.rid, detail); return; } if (name === 'signin' && SU) { openSignin(detail || {}); return; } if (name === 'back') { nav.back(); return; } if (name === 'home') { nav.tab({ name: 'home' }); return; } if (name === 'pin') { setLoc(detail.lat, detail.lng, detail.source === 'gps' ? 'gps' : 'pin'); return; } if (name === 'store-open') { if (runtime.store && detail && detail.url === runtime.store.url) { keepHandoff(entry.rid); openExternal(runtime.store.url); } return; } if ((name === 'placed') && detail && detail.order) showOrder(entry.rid, detail); emit(name, { rid: entry.rid, ...(detail || {}) }); } });
      S.store = { rid: entry.rid, ui, entry, body: e.body, fp: null, adopt: null };
      watchMenu(S.store);
      const carry = !carried && S.carry && S.carry.rid === entry.rid ? S.carry.snap : null; S.carry = null;   // «+» from Pedidos whose persist failed
      const snap = carried || carry || readJ(cfg.cartKey); if (snap) ui.restore(snap);   // an adoption carries the IN-MEMORY cart (Codex s7a2 r1 #1)
      const ro = !carried && S.reorder && S.reorder.rid === entry.rid ? S.reorder : null;
      if (ro) {   // «Volver a pedir»: replaces the cart (v6) through the store's own restore, refused where the store refuses an edit
        S.reorder = null;
        const r = ui.replaceCart({ ...reorderSnap(ui.menu, ro.lines, snap), rid: entry.rid });
        if (r && !r.locked && !r.blocked && !r.cleared) S.reorderOpen = entry.rid;
      }
      if (entry.dish) ui.openDetail(entry.dish);
      // the return's AUTHORITATIVE outcome settles the stored handoff (S7a-1 r3 §2 / r3.1 N3: never on anything else)
      // …and the association is KEPT: a LATER terminal outcome of this store (a status read, a recovery) settles it too (Codex s7a2 r1 #4)
      if (ret) S.retAssoc = { rid: entry.rid, handoff: ret.handoff };
      if (ret && ui.returning && typeof ui.returning.then === 'function') ui.returning.then((out) => settleRet(entry.rid, out), () => {});
      pollAvail(); availTimer = T.setInterval(pollAvail, AVAIL_EVERY_MS);
      return true;
    }
    // the mounted surface is NEVER remounted or re-priced while the customer is in it ([r2] ruling): a verified body enables the
    // ordering controls in place; if its CONTENT FINGERPRINT differs, the surface keeps the body it was entered with and the fresh
    // one is ADOPTED at the next transition where the menu is not visible — checkout entry (below) or the next store entry
    // no WebCrypto / a bad body ⇒ null ⇒ treated as CHANGED (adopted at checkout entry: the safe direction, never a silent re-price)
    const fpOf = (body) => Promise.resolve().then(() => CappCheckout.menuFingerprint(body)).catch(() => null);
    function watchMenu(st) {
      const check = async () => {
        const e = cache.peek(st.rid);
        if (S.store !== st || !e || !e.body || e.state !== 'fresh' || e.body === st.body) { if (S.store === st && e && e.body === st.body && e.state === 'fresh') { st.ui.setOrderable(true); tryRoute(); } return; }
        const [a, b] = await Promise.all([st.fp || (st.fp = fpOf(st.body)), fpOf(e.body)]);
        if (S.store !== st) return;
        st.adopt = a && b && a === b ? null : e.body;   // same content ⇒ nothing to adopt
        st.ui.setOrderable(true); tryRoute();
      };
      st.unwatch = cache.subscribe(st.rid, () => { check(); });
      check();
    }
    function adoptBeforeCheckout() {
      const st = S.store; if (!st || !st.adopt) return true;
      // D-4a §4 (Codex r1 P1-4): adoption never discards a lock — a locked mount is never torn down here (its lock path runs)
      if (st.ui.lockedNow && st.ui.lockedNow()) return true;
      if (!adoptInto(st)) return true;
      S.store.ui.openCart();
      return false;
    }
    // the staged fresh body adopted: the mount rebuilt on it, carrying the cart AS IT IS NOW → the new store record (or null)
    function adoptInto(st) {
      const body = st.adopt;
      // the cart (with its last-seen prices) is carried onto the fresh body; the cart sheet discloses any changed line (frame 13)
      // BEFORE the quote — the customer continues from there (continuing is acceptance)
      if (availTimer !== null) { T.clearInterval(availTimer); availTimer = null; }
      if (typeof st.unwatch === 'function') st.unwatch();
      const carried = st.ui.snapshot();   // the cart as it is NOW (never only the stored copy: a failed persistence must lose nothing)
      st.ui.destroy(); S.store = null;
      if (!mountStore(st.entry, body, carried)) return null;
      return S.store;
    }
    // ── G6: the in-app sign-in ──
    function openSignin(d) {
      if (!SU || !signup) { emit('signin', d); return; }   // no shell auth ⇒ the host's, as before
      // S4 frame G (owner: B), only under schedulingLive: a guest tapping «Programar» gets the drawn sheet with the guest exit kept (the
      // order stays ASAP) and only the subtitle changed; without the flag, exactly as G6
      const gate = d.ctx === 'schedule' && runtime.schedulingLive === true;
      signup.open({ ctx: d.ctx || null, prefill: d.prefill || null, memberOnly: d.ctx === 'schedule' && !gate, ...(gate ? { scheduleGate: true } : {}) });
    }
    // Codex G6 r1 #2 / r2 (an ALLOW-list, closed by construction): capp:member_complete {v:1, uid} is written ONLY at «Listo» — a new
    // account's completion, or an existing account the server confirmed complete. A RESTORED session becomes a member ONLY when the
    // mark names its uid; anything else (no mark — e.g. a crash between the SDK persisting the uid and «Listo» —, another uid) is
    // signed out and never applied, restore after restore until the sign-out is CONFIRMED (the 'guest' callback). An ordinary sign-out
    // clears the mark. (The app has never been live: no session predates the mark — nothing to grandfather.)
    const COMPLETE_KEY = 'capp:member_complete';
    const completeUid = () => { try { const v = JSON.parse(storage.getItem(COMPLETE_KEY) || 'null'); return v && v.v === 1 && typeof v.uid === 'string' ? v.uid : null; } catch (_) { return null; } };
    const markComplete = (uid) => { try { storage.setItem(COMPLETE_KEY, JSON.stringify({ v: 1, uid })); } catch (_) {} };
    const clearComplete = () => { try { storage.removeItem(COMPLETE_KEY); } catch (_) {} };
    async function signedIn(d) {
      markComplete(d.uid);
      CappDeviceAccount.remember(storage, d.phone);   // §4c: the device marker (full E.164), kept across ordinary sign-outs
      CappDeviceAccount.rememberProfile(storage, d);   // the member's own profile, for a RESTORED session's autofill
      await applyMember(d);
    }
    // Codex G6 r1 #1: EVERY non-member transition (a sign-out, a close mid-completion, a switch) reaches the mounted checkout — its
    // member context (and so its token) never outlives the session
    let memberGen = 0;
    function dropMember() { memberGen++; clearTokenTimers(); S.member = null; if (S.store) S.store.ui.setMember(null); identityChanged(); }
    // the member the store mounts / fills from: the profile + the member token the transport sends
    async function applyMember(p) {
      // Codex G6 r1 #3: applied only if, after the token's await, nothing has changed — no sign-out / switch in between, and the
      // session is still THIS uid's
      const gen = ++memberGen, uid = p.uid; clearTokenTimers();   // a new identity: the old one's token timers are cancelled
      let idToken = null; try { idToken = await fbAuth.idToken(); } catch (_) { idToken = null; }
      if (dead || gen !== memberGen) return;
      const u = auth && auth.state() === 'member' && auth.user ? auth.user() : null;
      if (!u || u.uid !== uid) return;
      // getIdToken: the transport asks the SDK at send time (cached while valid, refreshed once expired); idToken = the fallback
      // S-picker: with the runtime intlPhone the member's number stays E.164 (its own country); off ⇒ the local 8 digits, as before
      S.member = { uid: p.uid, name: p.name || '', phone: runtime.intlPhone === true ? String(p.phone || '') : String(p.phone || '').replace(/\D/g, '').replace(/^504/, ''), email: p.email || '', ...(typeof p.promos === 'boolean' ? { promos: p.promos } : {}), idToken: null, getIdToken: () => fbAuth.idToken(), onTokenChange: onMemberToken };
      { const A = apiMod(); if (A && typeof A.acceptToken === 'function') A.acceptToken(S.member, idToken, nowMs()); }   // the ONE setter (an unusable token is refused)
      if (S.store) S.store.ui.setMember(S.member);   // §4c: back on the SAME checkout step, filled in
      identityChanged();
      schedule();
      if (usable(S.member)) armExpiry(); else retryToken(gen, uid, 0);
    }
    // Codex promo r3: the member's identity-guarded token notifier — fired ONLY by CappApi.acceptToken (the transport's fresh token, the
    // retry's, admission's): the claim follows in place on Inicio (a repaint) and a mounted store (patchAuth), and the expiry re-arms
    function onMemberToken(m) {
      if (dead || !m || S.member !== m) return;
      armExpiry(); storeAuth(); schedule();
    }
    let tokTimer = null, expTimer = null;   // HANDLES (Codex promo r3): cancelled on a sign-out, a new identity and destroy()
    function clearTokenTimers() { if (tokTimer !== null) { T.clearTimeout(tokTimer); tokTimer = null; } if (expTimer !== null) { T.clearTimeout(expTimer); expTimer = null; } }
    // when the usable token reaches exp − skew the claim is withdrawn in place (reserved) and a refresh is tried
    function armExpiry() {
      if (expTimer !== null) { T.clearTimeout(expTimer); expTimer = null; }
      const A = apiMod(), m = S.member, t = usable(m); if (!A || !t) return;
      const gen = memberGen, uid = m.uid, at = A.tokenExpMs(t) - A.TOKEN_SKEW_MS;
      expTimer = T.setTimeout(() => {
        expTimer = null; if (dead || gen !== memberGen || !S.member || S.member.uid !== uid) return;
        if (usable(S.member)) { armExpiry(); return; }   // Codex promo r4 #2: fired EARLY (timer drift) ⇒ re-arm for the remaining time
        storeAuth(); schedule(); retryToken(gen, uid, 0);
      }, Math.max(0, at - nowMs()));
    }
    // Codex promo r2 P2-A: an admitted member whose token failed is retried (bounded); when it arrives, the SAME identity is re-handed to
    // the store (setMember, same uid ⇒ the header patched in place) and Inicio repaints — the claim upgrades, nothing re-renders
    const TOKEN_RETRY_MS = [2000, 10000, 30000];
    function retryToken(gen, uid, i) {
      if (tokTimer !== null) T.clearTimeout(tokTimer);
      tokTimer = T.setTimeout(async () => {
        tokTimer = null;
        const live = () => !dead && gen === memberGen && S.member && S.member.uid === uid;
        if (!live() || usable(S.member)) return;
        let t = null; try { t = await fbAuth.idToken(); } catch (_) { t = null; }
        if (!live() || usable(S.member)) return;
        const A = apiMod();
        if (!(A && A.acceptToken(S.member, t, nowMs())) && i + 1 < TOKEN_RETRY_MS.length) retryToken(gen, uid, i + 1);   // accepted ⇒ the notifier patches
      }, TOKEN_RETRY_MS[i]);
    }
    // ── G7 (MOCKUP-capp-member-cuenta-APPROVED-2026-10-27): the MEMBER's Cuenta, in the shell, under runtime.signup (G6's flag; absent ⇒
    //    the member's Cuenta stays the host's event, byte for byte) ──
    let suApi = null;
    const promosOv = { uid: null, v: null };   // frame 1b: the optimistic value while setPromos is in flight
    let signingOut = false;
    const phoneShown = (ph) => { const P = typeof CappPhone !== 'undefined' ? CappPhone : (o.CappPhone || null); const raw = String(ph || ''); if (!raw || !P) return raw;
      const q = P.parseE164(raw.startsWith('+') ? raw : '+' + P.DEFAULT_CC + P.digits(raw)); return q ? P.display(q.cc, P.format(q.cc, q.national)) : raw; };
    // the Cuenta's data: a member (S.member — the cached profile at once, frame 4a; a uid only ⇒ the placeholders, frame 4b), or, while the
    // session resolves, the profile on this device (decision 7: no height change on resolving); otherwise null ⇒ the guest's Cuenta
    // Codex G7 r1 #2 (privacy) + #5: cached data is SHOWN only for the uid the SDK's auth state names (with that uid's completion mark),
    // independent of the ID token; before the SDK answers, a profile on this device draws only the member GEOMETRY as neutral
    // placeholders (78 px, ruling A — no reflow). The switch is live only for the APPLIED member; a settled member with no stored
    // consent draws it OFF + dimmed (ruling (ii), OWNER-PENDING); while loading, frame 4b's ON-dimmed placeholder
    function acctVm() {
      if (!SU || signingOut) return null;
      const st = authNow(); let p = null, applied = false;
      if (st === 'member') {
        const u = auth && auth.user ? auth.user() : null, uid = u && u.uid;
        if (uid && completeUid() === uid) {
          applied = !!S.member && S.member.uid === uid;
          p = applied ? S.member : CappDeviceAccount.readProfile(storage, uid) || { uid };
        }
      } else if (st === 'unresolved') { const pk = CappDeviceAccount.peekProfile(storage); if (pk) p = { uid: pk.uid }; }
      if (!p) return null;
      const placeholder = !(p.name || p.phone || p.email);
      const ov = promosOv.uid && promosOv.uid === p.uid ? promosOv.v : null;
      return { placeholder, name: p.name || '', phone: phoneShown(p.phone), email: p.email || '', promos: applied && typeof p.promos === 'boolean' ? (typeof ov === 'boolean' ? ov : p.promos) : null,
        settled: applied, version: typeof CAPP_SYSTEM_VERSION !== 'undefined' ? CAPP_SYSTEM_VERSION : (o.version || '') };
    }
    async function togglePromos() {
      const m = S.member; if (!m || typeof m.promos !== 'boolean' || !suApi || promosOv.uid) return;
      const v = !m.promos, uid = m.uid; promosOv.uid = uid; promosOv.v = v; renderNow();   // optimistic
      let ok = false, got = v; try { const tok = await fbAuth.idToken(); const r = tok ? await suApi.setPromos({ idToken: tok, value: v }) : null; ok = !!r && r.ok === true; if (ok && typeof r.value === 'boolean') got = r.value; } catch (_) { ok = false; }
      promosOv.uid = null; promosOv.v = null;
      if (dead || !S.member || S.member.uid !== uid) return;
      // the committed value read back by the server (contract §6) is what the switch and the cache keep
      if (ok) { S.member.promos = got; const c = CappDeviceAccount.readProfile(storage, uid); if (c) CappDeviceAccount.rememberProfile(storage, { ...c, promos: got }); }
      renderNow(); if (!ok) toast('No se guardó el cambio. Intentá de nuevo.');   // frame 1b: back to its value
    }
    // «Cerrar sesión» (no confirm) / «Olvidar este teléfono» (frame 2, then also the device marker): the guest's Cuenta at once (frame 3);
    // the 'guest' callback clears the profile cache + the completion mark once the SDK confirms; a rejected sign-out restores the member
    async function signOutNow({ forget = false } = {}) {
      if (!fbAuth) return;
      if (forget) CappDeviceAccount.forget(storage);
      signingOut = true; dropMember(); renderNow();
      try { await fbAuth.signOut(); } catch (_) { signingOut = false; const u = auth && auth.user ? auth.user() : null; if (u && u.uid) applyMember(CappDeviceAccount.readProfile(storage, u.uid) || { uid: u.uid }); renderNow(); return; }
      signingOut = false; renderNow();
    }
    function startAuth() {
      if (!SU || fbAuth || dead) return;
      const CappAuthFirebase = pick(o, 'CappAuthFirebase', './capp-auth-firebase.js'), CappAuthState = pick(o, 'CappAuthState', './capp-auth-state.js'), CappSignup = pick(o, 'CappSignup', './capp-signup.js'), CappSignupApi = pick(o, 'CappSignupApi', './capp-signup-api.js');
      fbAuth = CappAuthFirebase.createFirebaseAuth({ config: SU.firebase, loadSdk: o.loadSdk });
      auth = CappAuthState.createAuthState({ subscribe: fbAuth.subscribe, timers: T });
      auth.onChange((st) => {
        storeAuth();
        if (st === 'guest') { CappDeviceAccount.forgetProfile(storage); clearComplete(); }   // a CONFIRMED sign-out: no personal data stays on show
        if (st !== 'member') { dropMember(); schedule(); return; }
        const u = auth.user && auth.user();
        // Codex G7 r1 #2: a cached profile of ANOTHER uid than the session's is purged (never shown, never kept)
        { const pk = CappDeviceAccount.peekProfile(storage); if (pk && u && u.uid && pk.uid !== u.uid) CappDeviceAccount.forgetProfile(storage); }
        // the sheet in progress owns its outcome: a member only at «Listo» (its 'signed-in'), never by the SDK's callback mid-flow
        if (signup && signup.state.open) { schedule(); return; }
        // a RESTORED session without THIS uid's completion mark: never a member; signed out (a rejected sign-out is retried at the next
        // restore — nothing is cleared until the 'guest' callback confirms it)
        if (u && u.uid && completeUid() !== u.uid) { dropMember(); fbAuth.signOut().catch(() => {}); schedule(); return; }
        // a session the SDK RESTORED (no sheet ran): the cached profile of THIS uid, at once (cached-first)
        // Codex Pedidos r2 P1: a switch to ANOTHER uid drops the previous member SYNCHRONOUSLY (before any token await) — whatever was
        // issued or shown for them is void before the new identity is admitted
        if (u && u.uid && S.member && S.member.uid !== u.uid) dropMember();
        if (u && u.uid && (!S.member || S.member.uid !== u.uid)) { const c = CappDeviceAccount.readProfile(storage, u.uid); applyMember(c || { uid: u.uid }); return; }
        schedule();
      });
      // the sheet's own host: an .app layer (the theme tokens live on .app) OUTSIDE the store mount's #app, transparent until open
      const host = doc.createElement('div'); host.className = 'app su-host'; host.id = 'su-host';
      (app.parentNode || doc.body).appendChild(host);
      const syncDark = () => { host.classList.toggle('dark', app.classList.contains('dark')); host.classList.toggle('desk', app.classList.contains('desk')); };   // D-2: the sheet follows the viewport too
      syncDark();
      signup = CappSignup.createSignup({ doc, host: { addEventListener: (...a) => host.addEventListener(...a), contains: (n) => host.contains(n), querySelector: (q) => host.querySelector(q), set innerHTML(v) { syncDark(); host.classList.toggle('open', !!v); host.innerHTML = v; }, get innerHTML() { return host.innerHTML; } },
        api: (suApi = CappSignupApi.createSignupApi({ endpoints: SU.endpoints, fetch: o.signupFetch })), auth: fbAuth, google: o.google || null, timers: T,
        ...(runtime.intlPhone === true ? { intlPhone: true, CappPhone: typeof CappPhone !== 'undefined' ? CappPhone : o.CappPhone } : {}),   // part B (b): the in-sheet country pane
        onEvent: (n, d) => { if (n === 'signed-in') signedIn(d); } });
    }
    function settleRet(rid, out) {
      const a = S.retAssoc; if (!a || a.rid !== rid) return;
      let done = false; try { done = CappShell.settleHandoff(storage, out, a.handoff); } catch (_) { done = false; }
      if (done) S.retAssoc = null;
    }
    function unmountStore() {
      const st = S.store; if (!st) return;
      if (availTimer !== null) { T.clearInterval(availTimer); availTimer = null; }
      availSeq++; if (typeof st.unwatch === 'function') st.unwatch(); st.ui.destroy(); S.store = null; rebuild = true;   // #app holds the store's markup: the next shell paint rebuilds it
    }

    // ── D-4a: reflection (pathname only) + one cold hydration, cancelled by any user navigation (Codex r2 #5) ──
    function replacePath(path) {
      if (!routing || typeof path !== 'string') return;
      try { if (path !== win.location.pathname) win.history.replaceState(win.history.state, '', path + win.location.search + win.location.hash); } catch (_) { /* never breaks the app */ }
    }
    function pathNow() {
      try {
        if (S.store) return CappRoutes.format({ name: 'store', rid: S.store.rid, ...storeRoute });
        if (S.neutral) return '/';
        // the order screen lives on its order flow's URL (D-3 r3 table: «Checkout, tip, outcome and tracker» = /r/{rid}/pago)
        if (S.tab === 'order' && S.order) return CappRoutes.format({ name: 'store', rid: S.order.rid, step: 'pago' });
        if (S.tab === 'receipt') return CappRoutes.format({ name: 'orders' });   // a past order's receipt is a step of «Pedidos» (no URL of its own)
        return CappRoutes.format({ name: S.tab === 'search' ? 'search' : S.tab === 'account' ? 'account' : S.tab === 'orders' ? 'orders' : 'home' });
      } catch (_) { return null; }   // an id outside the ONE domain is never written: the URL stays as it is
    }
    function reflect() { setTitle(); if (routing && booted && !pendingRoute) replacePath(pathNow()); }   // never before the boot's hydration decision
    // C-6a (D-3 r3 §0): the tab title follows the screen, with the URL — «Thing — what it is · Sherpa» (CappHome.titleOf, the copy)
    function titleNow() {
      const platform = dir.view().platform;
      if (S.store) {
        const row = dir.view().rows.find((r) => r.rid === S.store.rid), st = storeRoute || {};
        let dish = null; if (st.step === 'plato' && st.dish) { try { const d = S.store.ui.menu.dish(st.dish); dish = d ? d.name : null; } catch (_) { dish = null; } }
        return CappHome.titleOf({ screen: 'store', step: st.step, store: (row && row.entry && row.entry.name) || '', dish, platform });
      }
      if (S.tab === 'order' && S.order) return CappHome.titleOf({ screen: 'order', status: S.order.status });
      if (S.tab === 'orders' || S.tab === 'receipt') return CappHome.titleOf({ screen: 'orders' });
      if (S.tab === 'search') return CappHome.titleOf({ screen: 'search', q: S.q || '' });
      if (S.tab === 'account') return CappHome.titleOf({ screen: 'account' });
      return CappHome.titleOf({ screen: 'home', platform });
    }
    // C-6b: a dish row's ‹ › follow its scroll — ‹ off at the start, › off at the end (or with nothing to scroll): never a dead arrow
    function rowArrows(row) {
      for (const r of row ? [row] : [...app.querySelectorAll('.hsec .hrow.dishes')]) {
        const sec = r.closest('.hsec'), prev = sec && sec.querySelector('[data-act="rowprev"]'), next = sec && sec.querySelector('[data-act="rownext"]');
        if (prev) prev.disabled = !(r.scrollLeft > 0);
        if (next) next.disabled = !(r.scrollLeft + r.clientWidth < r.scrollWidth - 1);
      }
    }
    const onRowScroll = (e) => { const r = e.target; if (r && r.classList && r.classList.contains('hrow') && r.classList.contains('dishes')) rowArrows(r); };
    if (app && typeof app.addEventListener === 'function') app.addEventListener('scroll', onRowScroll, true);
    function setTitle() { try { const t = titleNow(); if (doc && typeof t === 'string' && doc.title !== t) doc.title = t; } catch (_) {} }
    // a user navigation cancels BOTH held intents — the cold link (pendingRoute) and the deferred /pago (awaitOrderRoute, Codex Pedidos r3)
    function cancelRoute() { if (pendingRoute || awaitOrderRoute) { pendingRoute = null; awaitOrderRoute = null; navGen++; } }
    function subscribeMenu(rid) { if (!subscribed.has(rid)) { subscribed.add(rid); cache.seed(rid, readJ(MENU_KEY(rid))); cache.subscribe(rid, () => { schedule(); checkHeld(); tryRoute(); }); } }
    function hydrate() {
      const r = CappRoutes.parse(bootPath);
      if (!r) { replacePath('/'); return; }   // unknown ⇒ Inicio, silently (no new copy)
      if (r.name === 'search' || r.name === 'account' || r.name === 'orders') { nav.tab({ name: r.name }); return; }
      if (r.name !== 'store') return;
      // a reload on an active order's own URL ⇒ its order screen (the device's record), never a fresh checkout
      if (r.step === 'pago' && activeOrder() && S.order.rid === r.rid) { if (nav.tab({ name: 'orders' })) nav.go({ name: 'order' }); return; }
      // Codex Pedidos r2: the device's record for THIS store whose owner is not resolved yet (a member session restoring) ⇒ the route
      // decision WAITS for the identity (identityChanged), then lands on the order or falls back to the store
      if (r.step === 'pago' && S.order && S.order.rid === r.rid && ownerNow() === null && !CappOrder.FINAL.has(S.order.status)) { awaitOrderRoute = { r, gen: navGen }; return; }
      pendingRoute = { r, gen: ++navGen, mounted: false };
      subscribeMenu(r.rid); cache.get(r.rid);
      tryRoute();
    }
    // every async continuation re-checks the generation: a stale directory / menu / adoption result never acts
    function tryRoute() {
      const p = pendingRoute; if (!p || p.gen !== navGen || dead) return;
      if (p.mounted) { continueRoute(p); return; }
      const rid = p.r.rid, st = dir.state(rid), v = dir.view(), e = cache.peek(rid);
      // CONFIRMED absence only: tombstoned, or a fresh COMPLETE directory that does not list it; offline / 503 / partial / cold /
      // expired eligibility / the missing endpoint are unverified ⇒ the link stays pending (and retries with every update)
      if (st === 'gone' || (st === 'unknown' && v.verified && !v.partial && !v.pending)) { pendingRoute = null; replacePath('/'); if (!S.store) renderNow(); return; }
      if (st === 'enterable' && e && e.body) {
        p.mounted = true; hydrating = true;
        let ok = false; try { ok = nav.go({ name: 'store', rid, dish: null }, saveScreen()); } finally { hydrating = false; }
        if (!ok || !S.store || S.store.rid !== rid || p.gen !== navGen) { if (pendingRoute === p) pendingRoute = null; reflect(); return; }
        continueRoute(p);
      }
    }
    function continueRoute(p) {
      const st = S.store; if (!st || st.rid !== p.r.rid || p.gen !== navGen) { if (pendingRoute === p) pendingRoute = null; return; }
      const step = p.r.step;
      if (step === 'plato') {
        // Codex r2 NEW P2: the dish is resolved against the VERIFIED FRESH body — the staged adoption body, else the mounted one once
        // orderable; only a presentation body so far ⇒ wait (watchMenu calls back)
        const fresh = st.adopt || (st.ui.orderable() ? st.body : null);
        if (!fresh) return;
        let has = false; try { has = !!CappMenu.adaptMenu(fresh).dish(p.r.dish); } catch (_) { has = false; }
        pendingRoute = null;
        if (!has) { storeRoute = { step: 'store' }; reflect(); return; }
        // Codex code r1 P2: a staged CHANGED body under a lock can't be adopted now ⇒ stay PENDING (never open on stale prices);
        // retried on every store report / menu update until the lock resolves
        if (st.adopt && st.ui.lockedNow && st.ui.lockedNow()) { pendingRoute = p; return; }
        const cur = st.adopt ? adoptInto(st) : st;
        if (cur && cur.ui) cur.ui.resumeTo('plato', p.r.dish);
        reflect(); return;
      }
      // Codex code r1 P2: /pago on a PRESENTATION menu (not orderable, no lock) can't run yet ⇒ keep the intent; the fresh menu
      // (watchMenu ⇒ tryRoute) runs it. A lock runs now (recoverLocked needs no fresh menu)
      if (step === 'pago' && !st.ui.orderable() && !(st.ui.lockedNow && st.ui.lockedNow())) return;
      pendingRoute = null;
      if (step === 'pedido' || step === 'pago') st.ui.resumeTo(step);
      reflect();
    }
    // ── the shell navigation (one history owner) ──
    const nav = CappShellNav.createShellNav({ win, home: { name: 'home' },
      onShow: (entry, x) => {
        if (!hydrating) cancelRoute();   // any user navigation cancels a pending cold link
        if (entry.name === 'store') { storeRoute = { step: 'store' }; if (!mountStore(entry)) T.setTimeout(() => nav.back(), 0); else if (S.reopenCart === entry.rid && S.store) { S.reopenCart = null; clearHandoff(); S.store.ui.openCart(); S.store.ui.resumeVerification(); } else if (S.reorderOpen === entry.rid && S.store) { S.reorderOpen = null; S.store.ui.openCart(); toast('Pedido cargado en tu carrito'); } reflect(); return; }
        if (entry.name !== 'store') { S.reorder = null; S.held = null; S.carry = null; }   // the customer went elsewhere: a held tap / «Volver a pedir» is void (Codex VP r2 #3)
        if (entry.name === 'order') { S.tab = 'order'; resumeOrder(); renderNow(); return; }
        if (entry.name === 'receipt') { if (!openReceipt(entry.oid)) { T.setTimeout(() => nav.tab({ name: 'orders' }), 0); return; } S.tab = 'receipt'; renderNow(); return; }
        if (entry.name === 'orders') { S.tab = 'orders'; loadOrders(); resumeOrder(); dir.visit(); renderNow(); return; }
        S.tab = entry.name; dir.visit(); dir.revalidate(); loadMenus();
        renderNow(x && x.restored ? x.restored : null);
      },
      onLeave: () => unmountStore() });

    // a store / dish tap: in now when eligible with a menu in hand; otherwise HELD until both (or released by a tombstone / failure)
    function enter(rid, dish) {
      cancelRoute();   // a tap is a user navigation
      if (S.reorder && S.reorder.rid !== rid) S.reorder = null;   // «Volver a pedir» belongs to ITS store's tap only
      if (S.carry && S.carry.rid !== rid) S.carry = null;
      if (dir.state(rid) === 'gone') return;
      S.held = { rid, dish: dish || null }; S.heldErr = false;
      { const pe = cache.peek(rid); if (pe && pe.state === 'failed') cache.get(rid); }   // frame 15: a failed menu is re-fetched before its sheet is ever shown
      if (checkHeld()) return;
      renderNow();   // the drawn pressed state
      if (dir.state(rid) !== 'enterable') dir.revalidate();
      cache.get(rid);
    }
    function checkHeld() {
      const h = S.held; if (!h || S.store) return false;
      const st = dir.state(h.rid), e = cache.peek(h.rid);
      if (st === 'unknown' && dir.view().phase === 'cold') return false;   // the directory has not answered yet (a return entered at boot): wait
      if (st === 'gone' || st === 'unknown') { S.held = null; S.reorder = null; S.carry = null; schedule(); return false; }
      if (st === 'enterable' && e && e.body) {
        S.held = null;
        if (S.q && S.tab === 'search') remember(S.q);
        nav.go({ name: 'store', rid: h.rid, dish: h.dish }, saveScreen());
        return true;
      }
      // S7a-2 frame 15: an enterable store whose menu did not load (no load in flight) ⇒ the app's error sheet over Inicio, the row
      // kept in its pressed state; «Reintentar» re-fetches (the hold stays), «Cerrar» releases it
      if (st === 'enterable' && e && e.state === 'failed' && !cache.pending(h.rid)) { if (S.layer !== 'menuerr') openLayer('menuerr'); return false; }
      const v = dir.view();
      if (st !== 'enterable' && v.failed && !v.pending) { S.held = null; S.reorder = null; S.carry = null; S.heldErr = true; schedule(); }   // r3.3-F1: frame 7 for the held tap
      return false;
    }
    dir.subscribe(() => { loadMenus(); checkHeld(); schedule(); tryRoute(); });
    function remember(q) { const t = String(q).trim(); if (!t) return; S.recent = [t, ...S.recent.filter((x) => x !== t)].slice(0, RECENT_MAX); writeJ(RECENT_KEY, S.recent); }

    // ── render: the shell screens (a mounted store owns #app) ──
    // ── «PEDIDOS» (v6 ordersHtml; NOTE-capp-pedidos-build + the advisor's rulings): the member's orders from getMyOrders (member-only,
    // the token in its header; a guest has none) + THIS device's active order (S.order, its local record). One read per visit, newest
    // first, generation-guarded (a sign-out / switch mid-read never paints another member's rows) ──
    let ordersGen = 0;
    // Codex Pedidos r1: requests AND results are bound to the ADMITTED uid — every identity transition invalidates them (identityChanged);
    // before admission (an unresolved / restoring session) nothing is declared: the screen WAITS and loads once the member is admitted.
    // ONE page of 20 (advisor ruling: v6 draws no «load more»; next_cursor is not followed)
    async function loadOrders() {
      const gen = ++ordersGen, who = ownerNow();
      if (who === null || (authNow() === 'member' && !S.member)) { S.ordersRead = { phase: 'loading', active: [], past: [], who: null }; return; }   // wait for admission
      if (!S.member || !suApi || !fbAuth) { S.ordersRead = { phase: 'ready', active: [], past: [], who }; return; }   // a guest: no history
      const uid = S.member.uid;
      S.ordersRead = { phase: 'loading', active: [], past: [], who };
      let tok = null; try { tok = await fbAuth.idToken(); } catch (_) { tok = null; }
      const r = tok ? await suApi.getMyOrders({ idToken: tok, limit: 20 }) : { ok: false, reason: 'unauthenticated' };
      const cur = auth && auth.user ? auth.user() : null;   // the uid it was issued for = the CURRENT admitted one AND the SDK's session
      if (dead || gen !== ordersGen || !S.member || S.member.uid !== uid || !cur || cur.uid !== uid) return;   // another identity now: not theirs
      S.ordersRead = r.ok ? { phase: 'ready', active: r.active, past: r.past, who } : { phase: 'error', active: [], past: [], who };
      if (S.tab === 'orders' && !S.store) renderNow();
      if (r.ok) { prefetchReceipts(); readPedidosRatings(); }
    }
    const DAYS3 = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], MON3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    function hnParts(ms) {
      try { const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: 'America/Tegucigalpa', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[x.type] = x.value;
        return { y: +p.year, mo: +p.month, d: +p.day, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), h: +p.hour % 24, mi: +p.minute }; } catch (_) { return null; }
    }
    // v6's own formats: fmtT «7:05 p.m.» (P:1187), an order's `when` «hoy · 7:05 p.m.» / «sáb 11 oct · …», a row's date «Sáb 11 oct»
    const fmtT = (h, m) => `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
    const dayText = (p) => `${DAYS3[p.wd]} ${p.d} ${MON3[p.mo - 1]}`;
    function whenOf(ms) { const p = hnParts(ms), n = hnParts(Number(nowMs())); if (!p) return null; return `${n && p.y === n.y && p.mo === n.mo && p.d === n.d ? 'hoy' : dayText(p)} · ${fmtT(p.h, p.mi)}`; }
    function dateOf(ms) { const p = hnParts(ms); if (!p) return null; const t = dayText(p); return t[0].toUpperCase() + t.slice(1); }
    function ordersVm(rows) {
      const storeOfRid = (rid) => { const r = rows.find((x) => x.rid === rid); return r ? CappHome.storeOf(r) : null; };
      const rd = S.ordersRead && S.ordersRead.who === ownerNow() ? S.ordersRead : { phase: 'loading', active: [], past: [] };
      const local = activeOrder();
      const statusText = (status, mode) => { const v = CappOrder.fromTracking({ status }, mode); return v ? CappOrder.statusCopy({ status: v.status, mode, storeName: '' }).t || '' : ''; };
      const active = [];
      // the server's own row, when it lists this order: its items_text verbatim wins over the device snapshot (Codex Pedidos r1 #5)
      const twin = local ? rd.active.concat(rd.past).find((r) => r.order_id === local.order_id) : null;
      // Codex Pedidos r2 P2: the device's order reached a FINAL state ⇒ the same order's cached server row (still «active» there) is stale
      const finalId = S.order && S.order.owner && S.order.owner === ownerNow() && CappOrder.FINAL.has(S.order.status) ? S.order.order_id : null;
      if (local) { const st = storeOfRid(local.rid); if (st) active.push({ store: st, oid: local.order_id, numText: local.display_number ? `Orden #${local.display_number}` : null, whenText: whenOf(local.placedAt),
        total: local.total, itemsLine: twin && typeof twin.items_text === 'string' ? twin.items_text : (local.lines || []).map((d) => `${d.n}× ${d.name}`).join(', '), statusText: local.scheduled ? CappOrder.SCHED.C.t : CappOrder.statusCopy({ status: local.status || 'new', mode: local.mode, driver: local.driver, stacked: local.stacked, storeName: local.storeName }).t, trackable: true }); }
      for (const r of rd.active) {
        if ((local && r.order_id === local.order_id) || r.order_id === finalId) continue;
        const st = storeOfRid(r.restaurant); if (!st) continue;   // a store the directory no longer lists: not drawn (reported)
        active.push({ store: st, oid: r.order_id, numText: r.display_number ? `Orden #${r.display_number}` : null, whenText: whenOf(r.ts), total: r.total, itemsLine: r.items_text, statusText: statusText(r.status, r.order_type || 'delivery'), trackable: false });
      }
      const past = rd.past.map((r) => { const st = storeOfRid(r.restaurant); return st ? { store: st, oid: r.order_id, dateText: dateOf(r.ts), total: r.total, itemsLine: r.items_text, again: reorderable(recipeOf(r.items, r.recipe_format)), rateHtml: rowRateHtml(r) } : null; }).filter(Boolean);
      const again = rd.phase === 'ready' ? againGroups(rows, rd.past) : [];
      return { phase: rd.phase, active, past, againReady: past.some((p) => p.again), again };
    }
    // MOCKUP-capp-native-store-update state 1 (owner: A + B): the INSTALLED app with a store, when the host says a newer store build
    // exists (o.updateAvailable — the «latest native build» signal; none wired yet ⇒ never shown). A (Inicio line): hidden by the
    // customer's tap until the next local day; B (Cuenta row): while the update exists
    const UPD_KEY = 'capp:update_hidden_day';
    const dayOf = (ms) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); } catch (_) { return null; } };
    const updateOn = () => { try { return !!runtime.store && typeof o.updateAvailable === 'function' && o.updateAvailable() === true; } catch (_) { return false; } };
    function updateVm() {
      if (!updateOn()) return { updateLine: false, updateRow: null };
      let hidden = null; try { hidden = storage && storage.getItem(UPD_KEY); } catch (_) { hidden = null; }
      return { updateLine: hidden !== dayOf(Number(nowMs())), updateRow: runtime.store.name };
    }
    // the top bar's two live facts — ONE source for Inicio's vm and the store page's bar (C-6c)
    const addrVm = () => ({ short: 'Tu ubicación', line: S.loc ? 'Tu ubicación' : 'Agregá tu dirección' });
    const memberInitial = () => (authNow() === 'member' && S.member && S.member.name ? String(S.member.name).trim().charAt(0).toUpperCase() || null : null);
    // C-6c (D-3 r3 frame 2a): the desktop store page carries the shell's top bar — no tab is current there
    const storeChrome = () => CappHome.desknavHtml({ tab: 'store', q: '', addr: addrVm(), memberInitial: memberInitial() });
    function vm() {
      const v = dir.view();
      const rows = S.heldErr ? [] : v.rows.map((r) => {
        const cfg = cfgOf(r.entry) || {}, e = cache.peek(r.rid);
        return { ...r, cfg, view: viewOf(r.rid, r.entry), menuState: e ? e.state : null, held: !!S.held && S.held.rid === r.rid };
      });
      const nCart = v.rows.reduce((a, r) => { const c = cfgOf(r.entry); const s = c && readJ(c.cartKey); return a + (s && Array.isArray(s.lines) ? s.lines.reduce((n, l) => n + (Number(l.qty) || 0), 0) : 0); }, 0);
      return { ...updateVm(), desk: !!(view && view.desk()), featPage: S.featPage || 0, legal: legalVm(), legalPending: legalPending(), memberInitial: memberInitial(), signupOn: !!SU, orders: ordersVm(v.rows), receiptOk: !!(S.member && suApi && fbAuth), helpOk: !!supportWa(), ordersTab: S.ordersTab || 'past', phase: S.heldErr ? 'error' : v.phase, partial: !S.heldErr && v.partial, rows, platform: v.platform, now: clock(), auth: authNow(), promoAuth: admittedAuth(), cuisine: S.cuisine, filters: S.filters,
        schedulingLive: runtime.schedulingLive === true, outOfZone: !S.heldErr && CappHome.allOutOfZone(v.rows, S.loc), addr: addrVm(), locDenied: S.locDenied && !S.loc, tab: S.tab, cartN: nCart, live: false, q: S.q, recent: S.recent, ...(SU && S.tab === 'account' ? { acct: acctVm() } : {}) };
    }
    // the in-place re-render keeps every scroll position and the focused control (no jump, no lost caret)
    function saveScreen() {
      const sc = app.querySelector('.scroller, .results'), rows = {};
      for (const r of app.querySelectorAll('.hsec')) { const h = r.querySelector('.hrow'); if (h) rows[r.getAttribute('aria-label')] = h.scrollLeft; }
      const a = doc.activeElement;
      return { top: sc ? sc.scrollTop : 0, rows, q: S.q, focus: a && app.contains(a) ? (a.id ? `#${a.id}` : a.dataset && a.dataset.act ? `[data-act="${a.dataset.act}"]${a.dataset.rid ? `[data-rid="${a.dataset.rid}"]` : ''}${a.dataset.val !== undefined ? `[data-val="${a.dataset.val}"]` : ''}` : null) : null,
        caret: a && a.id === 'gq' ? [a.selectionStart, a.selectionEnd] : null };
    }
    function restoreScreen(s) {
      if (!s) return;
      const sc = app.querySelector('.scroller, .results'); if (sc) sc.scrollTop = s.top || 0;
      for (const r of app.querySelectorAll('.hsec')) { const h = r.querySelector('.hrow'), x = s.rows && s.rows[r.getAttribute('aria-label')]; if (h && x) h.scrollLeft = x; }
      if (s.focus) { const el = app.querySelector(s.focus); if (el) { try { el.focus({ preventScroll: true }); if (s.caret && el.setSelectionRange) el.setSelectionRange(s.caret[0], s.caret[1]); } catch (_) {} } }
    }
    function renderNow(restored) {
      if (dead || S.store) return;
      const keep = restored || (app.firstElementChild ? saveScreen() : null);
      if (restored && typeof restored.q === 'string') S.q = restored.q;
      const v = vm();
      const layer = $('layer'), toastEl = $('toast');
      const scr = app.querySelector(':scope > .screen');
      const html = S.neutral ? CappHome.neutralReturnHtml(S.neutral.order) : S.tab === 'order' && S.order ? orderScreenHtml(v) : S.tab === 'receipt' && S.receipt ? receiptScreenHtml(v) : S.tab === 'orders' ? CappHome.ordersHtml(v) : S.tab === 'search' ? CappHome.searchHtml(v) : S.tab === 'account' && (runtime.guestCardOnly === true || SU) ? (v.acct ? CappHome.accountMemberHtml(v) : CappHome.accountGuestHtml(v)) : CappHome.homeHtml(v);
      if (scr && layer && toastEl && !rebuild) scr.innerHTML = html;   // the open layer (a live pin map) and a showing toast are never rebuilt
      else { rebuild = false; app.innerHTML = `<div class="screen">${html}</div><div class="layer" id="layer"></div><div class="toast" id="toast" role="status" aria-live="polite"></div>`; renderLayer(); }
      restoreScreen(keep);
      reflect();
      if (S.tab === 'home' && !S.store && !S.neutral) { askLegal(); rowArrows(); askRateNudge(); }
    }
    // ── «PEDIDO RECIBIDO» (v6 orderHtml via CappOrder; owner 2026-11-01: build what v6 draws) ──
    // A placed order leaves «Enviando» for this SHELL screen: the store mount is left (Inicio under it, so back ⇒ Inicio), the order
    // as SENT (capp-ui's snapshot) + the store's directory data. «Orden #N»: the forms' own order-number module (synced bytes) reads
    // order_tracking/{token}/display_number — capped, else hidden, never the long id. C → R flips at its own boundary (one handle).
    let orderNum = null, orderFlipT = null, orderStream = null, orderGen = 0;
    const FLS = () => (typeof FormLiveStatus !== 'undefined' ? FormLiveStatus : o.FormLiveStatus);
    // RTDB REST streaming (EventSource): a 'put' replaces the value at `path`, a 'patch' merges into it — folded into ONE record
    function applyRtdb(rec, type, path, data) {
      const segs = String(path || '/').split('/').filter(Boolean);
      if (!segs.length) return type === 'put' ? (data && typeof data === 'object' ? { ...data } : null) : { ...(rec || {}), ...(data && typeof data === 'object' ? data : {}) };
      const root = { ...(rec || {}) }; let cur = root;
      for (let i = 0; i < segs.length - 1; i++) { const k = segs[i]; cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...cur[k] } : {}; cur = cur[k]; }
      const last = segs[segs.length - 1];
      if (type === 'put') { if (data === null) delete cur[last]; else cur[last] = data; } else cur[last] = { ...(cur[last] && typeof cur[last] === 'object' ? cur[last] : {}), ...(data && typeof data === 'object' ? data : {}) };
      return root;
    }
    function streamOrder(od) {
      const ES = o.EventSource || (win && win.EventSource), base = typeof runtime.rtdbBase === 'string' ? runtime.rtdbBase : null;
      if (typeof ES !== 'function' || !base || od.scheduled || typeof od.token !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(od.token)) return;
      let es; try { es = new ES(`${base}/order_tracking/${encodeURIComponent(od.token)}.json`); } catch (_) { return; }
      orderStream = es; let rec = null; const gen = orderGen;
      const apply = (ev) => {
        if (dead || gen !== orderGen || S.order !== od) return;
        let m = null; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (!m || typeof m !== 'object' || typeof m.path !== 'string') return;
        rec = applyRtdb(rec, ev.type, m.path, m.data);
        const v = CappOrder.fromTracking(rec, od.mode); if (!v) return;
        Object.assign(od, v); saveActive();
        if (CappOrder.FINAL.has(v.status)) { closeStream(); rememberRateCandidate(od); }
        if ((S.tab === 'order' || S.tab === 'orders') && !S.store) renderNow();   // a final status also clears the Pedidos card (Codex r1)
      };
      es.addEventListener('put', apply); es.addEventListener('patch', apply);
      es.addEventListener('cancel', () => closeStream()); es.addEventListener('auth_revoked', () => closeStream());
    }
    function closeStream() { if (orderStream) { try { orderStream.close(); } catch (_) {} } orderStream = null; }
    // v6's «Llega a – b» / «Listo para recoger a – b»: S5's own window (form-live-status, synced bytes) — the placement window from the
    // restaurant's public prep (measured ▸ configured ▸ neutral) + its drive fallback (the capp runs no Directions); painted at once from
    // the neutral prep (no pop-in), refined IN PLACE when the public prep lands
    function windowOrder(od) {
      const F = FLS(); if (!F || od.scheduled) return;
      const pickup = od.mode !== 'delivery', anchor = od.placedAt;
      const paint = (pub) => { const w = F.windowFor({ stage: 'placement', anchorMs: anchor, prep: F.prepFor(pub, anchor, Number(nowMs())), driveMin: F.LIVE_STATUS.DRIVE_FALLBACK_MIN, pickup }); od.windowText = w ? F.fmtRange(w.low, w.high) : null; };
      paint(null);
      const base = typeof runtime.rtdbBase === 'string' ? runtime.rtdbBase : null;
      if (!base || typeof o.readPublic !== 'function' || !od.rid) return;
      const gen = orderGen;
      Promise.resolve().then(() => o.readPublic(`${base}/restaurants/${encodeURIComponent(od.rid)}/public.json`)).then((r) => (r && r.ok ? r.json() : null)).then((pub) => {
        if (dead || gen !== orderGen || S.order !== od || !pub) return; paint(pub); if (S.tab === 'order' && !S.store) renderNow();
      }).catch(() => {});
    }
    const OrderNumberMod = () => (typeof OrderNumber !== 'undefined' ? OrderNumber : o.OrderNumber);
    const trackBaseOf = (rid) => { const b = runtime.trackBases && runtime.trackBases[rid]; return typeof b === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(b) ? b : null; };
    const supportWa = () => (typeof runtime.supportWhatsapp === 'string' && /^\d{8,15}$/.test(runtime.supportWhatsapp) ? runtime.supportWhatsapp : null);
    // THE DEVICE'S ACTIVE ORDER (advisor ruling 2: token + the sent snapshot, device-only, until final or 24 h — not «history»): written
    // at placement and on every live change, restored at boot (the Pedidos active card, a reload of its URL), dropped when final / expired
    const ACTIVE_KEY = 'capp:active_order', ACTIVE_MS = 24 * 3600e3;
    // Codex Pedidos r1: the record has an OWNER (the admitted uid, or «guest» on this device) — another identity never sees or restores
    // it (a shared phone: Bob never opens Ana's order); a guest's record is dropped when a DIFFERENT member signs in unless that member
    // claimed THIS order (the frame-7 offer); the 24 h bound is LIVE (checked on every read), derived from placedAt, never a stored exp
    const ownerNow = () => (S.member && S.member.uid ? `u:${S.member.uid}` : authNow() === 'unresolved' || authNow() === 'member' ? null : 'guest');
    const validAge = (od) => { const t = Number(nowMs()); return !!od && Number.isFinite(od.placedAt) && od.placedAt <= t + 5 * 60e3 && t - od.placedAt < ACTIVE_MS; };
    function dropActive() { S.order = null; try { if (storage) storage.removeItem(ACTIVE_KEY); } catch (_) {} }
    // the order THIS identity may see now, or null (an expired one is dropped on the spot)
    function activeOrder() {
      const od = S.order; if (!od || CappOrder.FINAL.has(od.status)) return null;
      if (!validAge(od)) { stopOrder(); dropActive(); return null; }
      return od.owner && od.owner === ownerNow() ? od : null;
    }
    function saveActive() {
      const od = S.order; if (!storage) return;
      try { if (!od || CappOrder.FINAL.has(od.status) || !validAge(od) || !od.owner) { storage.removeItem(ACTIVE_KEY); return; }
        storage.setItem(ACTIVE_KEY, JSON.stringify({ v: 1, order: { ...od, grant: null }, exp: od.placedAt + ACTIVE_MS })); } catch (_) {}
    }
    function restoreActive() {
      let r = null; try { r = storage ? JSON.parse(storage.getItem(ACTIVE_KEY) || 'null') : null; } catch (_) { r = null; }
      const o2 = r && r.order;
      const ok = r && r.v === 1 && o2 && typeof o2 === 'object' && typeof o2.rid === 'string' && typeof o2.order_id === 'string' && typeof o2.owner === 'string'
        && Number.isFinite(r.exp) && r.exp === o2.placedAt + ACTIVE_MS && validAge(o2) && !CappOrder.FINAL.has(o2.status);
      if (!ok) { try { if (storage && r) storage.removeItem(ACTIVE_KEY); } catch (_) {} return; }
      S.order = { ...o2, grant: null, offerDone: true };   // shown only to its owner (activeOrder)
    }
    function identityChanged() {
      ordersGen++; S.ordersRead = null;   // any in-flight history read is void; nothing of the previous identity is shown
      rateGen++; rateCache.clear(); if (S.layer === 'rate') { S.rate = null; closeLayer(); }   // C-2: nothing of the previous identity's ratings
      S.held = null; S.reorder = null; S.carry = null;   // Codex VP r1 #2: a held tap / «Volver a pedir» of the previous identity never lands
      receiptGen++; prefetchGen++; S.receipt = null; receiptCache.clear(); receiptInflight.clear(); if (S.tab === 'receipt' && !S.store) nav.tab({ name: 'orders' });   // nor a receipt of hers
      const od = S.order, who = ownerNow();
      if (od && who !== null && od.owner !== who) {
        if (od.owner === 'guest' && who && who.startsWith('u:') && od.claimedBy === who) { od.owner = who; saveActive(); }   // claimed via the offer
        else if (od.owner === 'guest' && who && who.startsWith('u:')) { stopOrder(); dropActive(); }                       // a different member
        else stopOrder();                                                                                                   // hidden, kept for its owner
      }
      if (S.tab === 'order' && !activeOrder()) { if (S.order && CappOrder.FINAL.has(S.order.status) && S.order.owner === who) { /* its final screen stays */ } else nav.tab({ name: 'home' }); }
      if (awaitOrderRoute && who !== null) {   // the deferred /r/{rid}/pago: its order now (owned), else the store as a cold link
        const aw = awaitOrderRoute, rr = aw.r; awaitOrderRoute = null;
        // Codex Pedidos r3: the intent carries its navigation generation — any navigation since it was deferred voids it
        if (aw.gen === navGen) {
          if (activeOrder() && S.order.rid === rr.rid) { if (nav.tab({ name: 'orders' })) nav.go({ name: 'order' }); return; }
          pendingRoute = { r: rr, gen: ++navGen, mounted: false }; subscribeMenu(rr.rid); cache.get(rr.rid); tryRoute();
        }
      }
      // Codex Pedidos r2: the admitted owner's order resumes its live stream where it is shown (Pedidos / its screen)
      if ((S.tab === 'orders' || S.tab === 'order') && activeOrder()) resumeOrder();
      if (S.tab === 'orders' && !S.store) { loadOrders(); renderNow(); }
    }
    function resumeOrder() { const od = activeOrder(); if (!od || orderStream) return; if (!od.windowText) windowOrder(od); streamOrder(od); }
    function stopOrder() { orderGen++; closeStream(); if (orderNum) { try { orderNum.stop(); } catch (_) {} } orderNum = null; if (orderFlipT !== null) { T.clearTimeout(orderFlipT); orderFlipT = null; } }
    function showOrder(rid, d) {
      stopOrder();
      const row = dir.view().rows.find((r) => r.rid === rid), e = (row && row.entry) || {};
      S.order = { ...d.order, rid, order_id: d.order_id || null, token: typeof d.tracking_token === 'string' ? d.tracking_token : null, status: 'new',
        storeName: e.name || '', branch: e.branch || '', storeAddr: e.pickup_addr || '', display_number: null,
        grant: d.signup_grant && typeof d.signup_grant.token === 'string' ? { token: d.signup_grant.token, expires_at: d.signup_grant.expires_at } : null, offerDone: false,
        placedAt: Number(nowMs()), windowText: null, driver: null, stacked: false, doneAt: null, owner: ownerNow() || 'guest' };
      windowOrder(S.order); streamOrder(S.order); saveActive();
      const ON = OrderNumberMod(), base = typeof runtime.rtdbBase === 'string' ? runtime.rtdbBase : null;
      if (ON && base && typeof o.readPublic === 'function' && !S.order.scheduled) {
        const mine = S.order;
        orderNum = ON.createOrderNumber({ base, read: (u) => o.readPublic(u), setTimeout: T.setTimeout, clearTimeout: T.clearTimeout,
          paint: (state, n) => { if (dead || S.order !== mine) return; mine.display_number = state === 'number' ? n : (mine.display_number || null); saveActive(); if (S.tab === 'order' && !S.store) renderNow(); } });
        orderNum.start(S.order.token);
      }
      if (S.order.scheduled && Number.isFinite(S.order.scheduledFor)) {
        const at = S.order.scheduledFor + CappOrder.REVIEW_AFTER_MS - Number(nowMs());
        if (at > 0 && at < 2147483647) orderFlipT = T.setTimeout(() => { orderFlipT = null; if (!dead && S.tab === 'order' && !S.store) renderNow(); }, at + 1);
      }
      if (nav.tab({ name: 'home' })) nav.go({ name: 'order' });
    }
    function orderScreenHtml(v) {
      const od = S.order;
      return CappHome.shellWrap(v, CappOrder.orderHtml(od, { entry: 'app', now: Number(nowMs()), dark: app.classList.contains('dark'), helpOk: !!supportWa(), desk: !!v.desk,
        shareOk: !!(od.token && trackBaseOf(od.rid)), receiptOpen: !!S.orderReceipt, offerHtml: offerHtml(od), rateHtml: orderRateHtml(od) }));
    }
    // MOCKUP-capp-guest-checkout frame 7 (owner 10-27) in v6's .rw slot: a GUEST whose card order returned a live signup grant (the
    // phone already verified — no second code), under the shell's own sign-in (runtime.signup); «Ahora no» hides it for this order
    function offerHtml(od) {
      if (!SU || !signup || S.member || od.offerDone || !od.grant) return '';
      return CappUI.accountOfferHtml({ grant: od.grant, now: Number(nowMs()), phone: od.phone, email: od.email });
    }
    let offerBusy = false;
    async function offerCreate() {
      const od = S.order; if (!od || !od.grant || offerBusy || !suApi || !fbAuth) return;
      const em = app.querySelector('#offer-email'), email = em ? String(em.value || '').trim() : od.email;
      offerBusy = true;
      let uid = null, r = null;
      try { r = await suApi.redeemSignupGrant({ grant: od.grant.token, email, name: od.name || '' }); if (r && r.ok && r.token) uid = await fbAuth.signInWithCustomToken(r.token); } catch (_) { uid = null; }
      offerBusy = false;
      if (dead || S.order !== od) return;
      if (typeof uid === 'string' && uid) { od.offerDone = true; od.claimedBy = `u:${uid}`; await signedIn({ uid, name: (r && r.name) || od.name || '', phone: od.phoneWire, email: email || null, isNew: !!(r && r.isNew) }); if (!dead && S.tab === 'order' && !S.store) renderNow(); return; }
      // a grant the server would not redeem (expired, consumed): the approved sign-in sheet, pre-filled — never a dead control
      od.offerDone = true; renderNow(); openSignin({ ctx: 'account', prefill: od.phoneWire || null });
    }
    function orderAct(a) {
      const od = S.order; if (!od) return false;
      // v6: the app's close ⇒ «Pedidos» (data-tab="orders"); «Hacer otro pedido» ⇒ Inicio. The order stays ACTIVE (its record kept);
      // only the live work pauses — reopening it resumes the stream
      if (a === 'order-close') { stopOrder(); nav.tab({ name: 'orders' }); return true; }
      if (a === 'order-rate') { if (od.order_id) openRate(od.order_id); return true; }   // C-2: «Valorar tu pedido» / «Ver tu calificación»
      if (a === 'order-again') { stopOrder(); nav.tab({ name: 'home' }); return true; }
      if (a === 'order-receipt') { S.orderReceipt = !S.orderReceipt; renderNow(); return true; }
      if (a === 'order-help') { const n = supportWa(); if (n) { const msg = 'Hola, tengo un problema con mi pedido' + (od.display_number ? ' #' + od.display_number : ''); openExternal(`https://wa.me/${n}?text=${encodeURIComponent(msg)}`); } return true; }
      if (a === 'order-share') {
        const b = trackBaseOf(od.rid); if (!b || !od.token) return true;
        const url = `${b}/${encodeURIComponent(od.token)}`, nv = win && win.navigator;
        try { if (nv && nv.clipboard && typeof nv.clipboard.writeText === 'function') nv.clipboard.writeText(url).catch(() => {}); } catch (_) {}
        toast('Link de seguimiento copiado'); return true;
      }
      return false;
    }
    // ── a past order's RECEIPT (v6: a Pedidos past row opens the order screen in its past state, its «Resumen del pedido» open). The
    // screen draws AT ONCE from the row (store, status, items_text, total); the receipt read (getMyOrders ?order_id, NOTE-getMyOrders-
    // receipt) fills the lines, the envío / descuento / propina, the tender and the address. Bound to the identity like the history
    // read; kept per identity for an instant reopen. A refused / failed read leaves the row's screen (no new copy)
    // C-6a: the footer's Términos / Privacidad — the platform's legal URLs (getSignupConfig, the sign-in sheet's own source): held in
    // MEMORY once known and persisted opportunistically (a failed write never loses them — Codex C-6a r1 #4); asked ONCE per session at
    // idle, and only if — at that moment — the desktop Inicio still shows and the shell is alive (r1 #3)
    const LEGAL_KEY = 'capp:legal';
    let legalAsked = false, legalMem = null, legalSettled = false;
    const legalVm = () => { if (legalMem) return legalMem; const l = readJ(LEGAL_KEY); return l && typeof l === 'object' ? { terms: l.terms, privacy: l.privacy } : null; };
    const legalPending = () => !!suApi && typeof suApi.config === 'function' && !legalSettled && !legalVm();
    const onDeskHome = () => !dead && S.tab === 'home' && !S.store && !S.neutral && !!view && view.desk();
    function askLegal() {
      if (legalAsked || !suApi || typeof suApi.config !== 'function' || !onDeskHome()) return;
      legalAsked = true;
      const later = (f) => (win && typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(f, { timeout: 2000 }) : T.setTimeout(f, 200));
      later(() => {
        if (!onDeskHome()) { legalAsked = false; return; }   // left Inicio / the desk before idle: nothing dispatched; asked again on return
        suApi.config().then((c) => {
          legalSettled = true;
          if (dead || !c || c.ok !== true || c.legalReady !== true) { if (!dead && onDeskHome()) renderNow(); return; }   // no legal ⇒ the reserved slots go
          const next = { terms: c.termsUrl, privacy: c.privacyUrl }, changed = JSON.stringify(legalVm()) !== JSON.stringify(next);
          legalMem = next; writeJ(LEGAL_KEY, next);
          if (changed && onDeskHome()) renderNow();
        }, () => { legalSettled = true; if (!dead && onDeskHome()) renderNow(); });
      });
    }
    let receiptGen = 0; const receiptCache = new Map(), receiptInflight = new Map();
    function openReceipt(oid) {
      const who = ownerNow(), rd = S.ordersRead && S.ordersRead.who === who ? S.ordersRead : null;
      const row = rd && typeof oid === 'string' ? rd.past.find((r) => r.order_id === oid) : null;
      if (!row || !S.member) return false;
      S.receipt = { oid, who, row, data: receiptCache.get(oid) || null, failed: false };
      if (!S.receipt.data) loadReceipt(S.receipt);
      return true;
    }
    // ONE read per order per identity: the open and the idle prefetch share it (in flight or kept); null = refused / failed / stale
    function readReceipt(oid) {
      if (receiptCache.has(oid)) return Promise.resolve(receiptCache.get(oid));
      if (receiptInflight.has(oid)) return receiptInflight.get(oid);
      const gen = receiptGen, uid = S.member && S.member.uid;
      if (!uid || !suApi || !fbAuth) return Promise.resolve(null);
      const p = (async () => {
        let tok = null; try { tok = await fbAuth.idToken(); } catch (_) { tok = null; }
        const r = tok ? await suApi.getReceipt({ idToken: tok, orderId: oid }) : { ok: false, reason: 'unauthenticated' };
        const cur = auth && auth.user ? auth.user() : null;
        if (dead || gen !== receiptGen || !S.member || S.member.uid !== uid || !cur || cur.uid !== uid) return null;   // another identity now: not theirs
        if (!r.ok) return null;
        receiptCache.set(oid, r.receipt); return r.receipt;
      })();
      receiptInflight.set(oid, p); p.then(() => { if (receiptInflight.get(oid) === p) receiptInflight.delete(oid); });
      return p;
    }
    async function loadReceipt(rc) {
      const d = await readReceipt(rc.oid);
      if (dead || S.receipt !== rc) return;
      if (d) rc.data = d; else rc.failed = true;   // a refused / failed read: the row's own tail (nothing guessed)
      if (S.tab !== 'receipt' || S.store) return;
      // the held tail goes IN PLACE of its marker — nothing already drawn is touched (advisor 11-01, option A)
      const mark = app.querySelector('[data-rc-tail]');
      if (mark) { const tpl = doc.createElement('template'); tpl.innerHTML = CappOrder.orderHtml(receiptVm(rc), { ...receiptCtx(), tailOnly: true }); mark.replaceWith(tpl.content); }
      else renderNow();
    }
    // advisor 11-01 (3a): once «Pedidos» has painted, at idle, the first ≤ 5 past rows' receipts — ONE at a time, the same kept
    // receipts, void on any identity change — so the usual first open is complete at once. Bounded: never the whole list
    const PREFETCH_MAX = 5;
    const idle = (f) => (win && typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(f, { timeout: 2000 }) : T.setTimeout(f, 200));
    let prefetchGen = 0;
    // ── C-2 · THE RATING SHEET (PLAN §C-2; MOCKUP-capp-desktop-D3 r3 §9.2; advisor rulings 11-02) ── an ADMITTED member's own orders only
    // (the server has no guest path), behind runtime.ratings (dark until the owner turns it on). Reads: getMyRating per order, cached per
    // uid; the Pedidos rows read at most RATE_READS per view, sequentially at idle, their line's box reserved; the delivered order screen
    // reads its order at idle with the button's box reserved. The ONE nudge: the newest delivered order THIS device placed, once per order
    // id ever, at idle on Inicio — never over a store / checkout or an open sheet. «Ahora no» / Enviar retire the order from the nudge.
    const RATE_READS = 5, RATE_WINDOW_MS = 7 * 24 * 3600e3, RATE_SEEN_MS = 8 * 24 * 3600e3;
    const RATE_NUDGE_KEY = 'capp:rate_nudge', RATE_DONE_KEY = 'capp:rate_done', RATE_DONE_MAX = 20;
    const rateCache = new Map(); let rateGen = 0, rateNudgeTried = false;
    const rateUid = () => (runtime.ratings === true && !!CappRate && !!suApi && !!fbAuth && S.member && S.member.uid ? S.member.uid : null);
    const doneOf = (st) => st === 'delivered' || st === 'collected';
    // ONE read per order per uid: a read in flight is shared (its promise); 'queued' reserves an entry's box before its read starts
    function readRating(oid) {
      const uid = rateUid(); if (!uid) return Promise.resolve(null);
      const hit = rateCache.get(oid);
      if (hit && hit.who === uid) { if (hit.phase === 'ready') return Promise.resolve(hit); if (hit.phase === 'pending') return hit.p; }   // failed / queued ⇒ read
      const gen = rateGen;
      const p = (async () => {
        let tok = null; try { tok = await fbAuth.idToken(); } catch (_) { tok = null; }
        const r = tok ? await suApi.getMyRating({ idToken: tok, orderId: oid }) : { ok: false };
        if (dead || gen !== rateGen || rateUid() !== uid) return null;
        rateCache.set(oid, r.ok ? { phase: 'ready', who: uid, canRate: r.canRate, rating: r.rating, editableUntil: r.editableUntil } : { phase: 'failed', who: uid });
        return r.ok ? rateCache.get(oid) : null;
      })();
      rateCache.set(oid, { phase: 'pending', who: uid, p });
      return p;
    }
    // the entry state of one order: null (nothing drawn) | 'pending' | 'rate' | 'rated' | 'late'
    function rateState(oid) {
      const e = rateCache.get(oid); if (!e || e.who !== rateUid()) return null;
      if (e.phase === 'pending' || e.phase === 'queued') return 'pending';
      if (e.phase !== 'ready') return null;
      if (e.rating) return 'rated';
      if (e.canRate) return 'rate';
      return Number.isFinite(e.editableUntil) ? 'late' : null;   // fulfilled, window over, never rated; not fulfilled / closed ⇒ nothing
    }
    function orderRateHtml(od) {
      const uid = rateUid();
      if (!uid || !od || od.owner !== `u:${uid}` || !doneOf(od.status) || !od.order_id) return '';
      const e = rateCache.get(od.order_id);
      if (!e || e.who !== uid) {   // its read at idle; the button's box reserved meanwhile
        rateCache.set(od.order_id, { phase: 'queued', who: uid });
        idle(async () => { await readRating(od.order_id); if (!dead && S.tab === 'order' && S.order === od && !S.store) renderNow(); });
      }
      return CappRate.ctaHtml(rateState(od.order_id));
    }
    // a past row inside the window (by its placement time — the server decides) gets a line; beyond the read cap, nothing
    const rowRateable = (r) => doneOf((CappOrder.fromTracking({ status: r.status }, r.order_type || 'delivery') || {}).status) && Number(nowMs()) - r.ts < RATE_SEEN_MS;
    function rowRateHtml(r) {
      if (!rateUid() || !rowRateable(r)) return '';
      const st = rateState(r.order_id), e = rateCache.get(r.order_id);
      return st ? CappRate.lineHtml(st, r.order_id, e && e.rating && Number.isInteger(e.rating.store) ? e.rating.store : null) : '';
    }
    function readPedidosRatings() {
      const rd = S.ordersRead; if (!rateUid() || !rd || rd.phase !== 'ready') return;
      const ids = rd.past.filter((r) => rowRateable(r) && !rateCache.has(r.order_id)).slice(0, RATE_READS).map((r) => r.order_id);
      if (!ids.length) return;
      const gen = rateGen, uid = rateUid(); for (const id of ids) rateCache.set(id, { phase: 'queued', who: uid });
      if (S.tab === 'orders' && !S.store) renderNow();   // the lines' boxes reserved before any read lands
      idle(async () => {
        for (const id of ids) {
          if (dead || gen !== rateGen) return;
          await readRating(id);
          if (!dead && gen === rateGen && S.tab === 'orders' && !S.store) renderNow();
        }
      });
    }
    // what the sheet needs of an order: its store (names its dishes from the store's own menu), number, mode, purchased dish ids
    function rateCtxOf(oid) {
      const od = S.order;
      if (od && od.order_id === oid) return { oid, rid: od.rid, num: od.display_number || null, mode: od.mode, dishIds: (od.lines || []).map((l) => l && l.dish_id) };
      const rd = S.ordersRead, row = rd && rd.past ? rd.past.concat(rd.active).find((r) => r.order_id === oid) : null;
      if (row) return { oid, rid: row.restaurant, num: row.display_number || null, mode: row.order_type === 'pickup' ? 'pickup' : 'delivery', dishIds: (row.items || []).map((l) => l && l.dish_id) };
      const c = rateCandidate();
      return c && c.order_id === oid ? { oid, rid: c.rid, num: c.num || null, mode: c.mode, dishIds: c.dish_ids || [] } : null;
    }
    async function openRate(oid, { nudge = false } = {}) {
      const uid = rateUid(), ctx = rateCtxOf(oid); if (!uid || !ctx) return false;
      const gen = rateGen;
      const pk = cache.peek(ctx.rid);   // the store's menu names its dishes: the cached one, else its load
      const [e, ent] = await Promise.all([readRating(oid), Promise.resolve(pk && pk.body ? pk : cache.get(ctx.rid)).catch(() => null)]);
      if (dead || gen !== rateGen || rateUid() !== uid || !e) { if (!nudge && !dead) toast('No pudimos abrir tu calificación. Intentá de nuevo.'); return false; }
      if (nudge && (e.rating || !e.canRate)) return false;
      if (!e.rating && !e.canRate) return false;
      if (nudge && (S.store || S.layer || S.tab !== 'home' || S.neutral)) return false;   // never over a store / checkout or an open sheet
      let menu = null; try { menu = ent && ent.body ? CappMenu.adaptMenu(ent.body) : null; } catch (_) { menu = null; }
      const row = dir.view().rows.find((r) => r.rid === ctx.rid), storeName = row ? CappHome.storeOf(row).name : '';
      const dishes = CappRate.dishesOf(ctx.dishIds, (id) => { const d = menu && menu.dish(id); return d ? d.name : null; });
      S.rate = { ctx, storeName, dishes, initial: e.rating, value: CappRate.fromRating(e.rating), editable: e.canRate === true, sending: false, error: null };
      openLayer('rate');
      const h = doc.getElementById('rate-h'); if (h) h.focus();
      return true;
    }
    const rateVm = () => ({ storeName: S.rate.storeName, num: S.rate.ctx.num, dishes: S.rate.dishes, delivery: S.rate.ctx.mode === 'delivery', value: S.rate.value, initial: S.rate.initial, editable: S.rate.editable, sending: S.rate.sending, error: S.rate.error });
    // a tap re-renders the sheet and keeps focus on the same control (the comment keeps its caret)
    function rerenderRate() {
      const ae = doc.activeElement, ds = ae && ae.dataset ? { act: ae.dataset.act, id: ae.dataset.id, val: ae.dataset.val, field: ae.dataset.field } : null;
      const caret = ae && ae.id === 'rate-comment' ? [ae.selectionStart, ae.selectionEnd] : null;
      renderLayer();
      const L = $('layer'); if (!L || !ds) return;
      const sel = ds.field ? `[data-field="${ds.field}"]` : ds.act ? `[data-act="${ds.act}"]${ds.id ? `[data-id="${CSS_ESC(ds.id)}"]` : ''}${ds.val ? `[data-val="${ds.val}"]` : ''}` : null;
      const el = sel ? L.querySelector(sel) : null; if (el) { el.focus(); if (caret) try { el.setSelectionRange(caret[0], caret[1]); } catch (_) {} }
    }
    const CSS_ESC = (v) => String(v).replace(/["\\]/g, '\\$&');
    function syncRateSend() {
      const b = $('layer') && $('layer').querySelector('[data-act="rate-send"]'); if (!b || !S.rate) return;
      b.disabled = !(S.rate.editable && !S.rate.sending && Object.keys(CappRate.fieldsToSend(S.rate.initial, S.rate.value, S.rate.dishes.map((d) => d.id))).length);
    }
    function closeRate() { const oid = S.rate && S.rate.ctx.oid; S.rate = null; closeLayer(); if (oid) markRateDone(oid); if ((S.tab === 'orders' || S.tab === 'order') && !S.store) renderNow(); }
    const RATE_ERR = { window_closed: 'Ya no se puede calificar este pedido.', not_fulfilled: 'Todavía no podés calificar este pedido.' };   // OWNER-PENDING
    async function sendRate() {
      const R = S.rate, uid = rateUid(); if (!R || !uid || R.sending || !R.editable) return;
      const fields = CappRate.fieldsToSend(R.initial, R.value, R.dishes.map((d) => d.id)); if (!Object.keys(fields).length) return;
      R.sending = true; R.error = null; rerenderRate();
      const gen = rateGen;
      let tok = null; try { tok = await fbAuth.idToken(); } catch (_) { tok = null; }
      const r = tok ? await suApi.rateOrder({ idToken: tok, orderId: R.ctx.oid, fields }) : { ok: false, reason: 'unauthenticated' };
      if (dead || gen !== rateGen || S.rate !== R) return;
      R.sending = false;
      if (!r.ok) { R.error = RATE_ERR[r.reason] || 'No pudimos enviar tu calificación. Intentá de nuevo.'; rerenderRate(); return; }   // OWNER-PENDING
      const prev = rateCache.get(R.ctx.oid), base = R.initial || { store: null, dishes: {}, delivery: null, comment: null };
      const rating = { ...base, ...fields, dishes: fields.dishes || base.dishes || {} };   // the writer's merge: absent fields kept, dishes whole
      rateCache.set(R.ctx.oid, { phase: 'ready', who: uid, canRate: true, rating, editableUntil: prev && prev.phase === 'ready' ? prev.editableUntil : null });
      closeRate(); toast('Gracias por tu calificación');   // OWNER-PENDING
    }
    function rateAct(a, t) {
      if (a === 'rate-open') { if (t.dataset.oid) openRate(t.dataset.oid); return true; }
      if (!S.rate || S.layer !== 'rate') return false;
      const v = S.rate.value, n = Number(t.dataset.val);
      if (a === 'rate-star' && S.rate.editable && n >= 1 && n <= 5) { v.store = n; rerenderRate(); return true; }
      if (a === 'rate-dish' && S.rate.editable && (n === 1 || n === -1) && t.dataset.id) { const id = t.dataset.id; if (v.dishes[id] === n) delete v.dishes[id]; else v.dishes[id] = n; rerenderRate(); return true; }
      if (a === 'rate-del' && S.rate.editable && (n === 1 || n === -1)) { v.delivery = v.delivery === n ? null : n; rerenderRate(); return true; }
      if (a === 'rate-later') { closeRate(); return true; }
      if (a === 'rate-send') { sendRate(); return true; }
      return false;
    }
    // the nudge's record: the newest delivered order THIS device placed for a member (order id + what the sheet needs; no personal data)
    function rememberRateCandidate(od) {
      if (!storage || !od || !doneOf(od.status) || typeof od.owner !== 'string' || !od.owner.startsWith('u:') || !od.order_id || rateDone().includes(od.order_id)) return;
      try { storage.setItem(RATE_NUDGE_KEY, JSON.stringify({ v: 1, owner: od.owner, order_id: od.order_id, rid: od.rid, mode: od.mode, num: od.display_number || null,
        dish_ids: (od.lines || []).map((l) => l && l.dish_id).filter((x) => typeof x === 'string'), at: Number(nowMs()) })); } catch (_) {}
    }
    function rateCandidate() {
      let c = null; try { c = storage ? JSON.parse(storage.getItem(RATE_NUDGE_KEY) || 'null') : null; } catch (_) { c = null; }
      return c && c.v === 1 && typeof c.order_id === 'string' && typeof c.rid === 'string' && typeof c.owner === 'string' && Number.isFinite(c.at) ? c : null;
    }
    function rateDone() { let d = null; try { d = storage ? JSON.parse(storage.getItem(RATE_DONE_KEY) || '[]') : []; } catch (_) { d = []; } return Array.isArray(d) ? d.filter((x) => typeof x === 'string') : []; }
    function markRateDone(oid) {
      if (!storage) return;
      try { const d = rateDone().filter((x) => x !== oid); d.push(oid); storage.setItem(RATE_DONE_KEY, JSON.stringify(d.slice(-RATE_DONE_MAX)));
        const c = rateCandidate(); if (c && c.order_id === oid) storage.removeItem(RATE_NUDGE_KEY); } catch (_) {}
    }
    function askRateNudge() {
      if (rateNudgeTried) return;
      const uid = rateUid(); if (!uid) return;   // tried again once the member is admitted
      rateNudgeTried = true;
      const c = rateCandidate();
      if (!c || c.owner !== `u:${uid}` || rateDone().includes(c.order_id) || Number(nowMs()) - c.at > RATE_SEEN_MS) return;
      idle(async () => {
        if (dead || rateUid() !== uid) return;
        const e = await readRating(c.order_id);
        if (e && (e.rating || !e.canRate)) { markRateDone(c.order_id); return; }   // rated already / closed: never nudged again
        if (e) openRate(c.order_id, { nudge: true });
      });
    }
    function prefetchReceipts() {
      const rd = S.ordersRead, gen = ++prefetchGen, rg = receiptGen;
      if (!rd || rd.phase !== 'ready' || !S.member || !suApi || !fbAuth) return;
      const ids = rd.past.slice(0, PREFETCH_MAX).map((r) => r.order_id);
      idle(async () => {
        for (const id of ids) {
          if (dead || gen !== prefetchGen || rg !== receiptGen) return;
          await readReceipt(id);
        }
      });
    }
    function receiptVm(rc) {
      const d = rc.data, row = rc.row, tt = d ? d.totals : {}, c = (k) => (Number.isSafeInteger(tt[k]) ? tt[k] / 100 : null);
      const mode = (d ? d.order_type : row.order_type) === 'pickup' ? 'pickup' : 'delivery';
      const live = CappOrder.fromTracking({ status: d ? d.status : row.status }, mode);
      const e = (dir.view().rows.find((x) => x.rid === row.restaurant) || {}).entry || {};
      const a = d && d.address ? d.address : null;
      return { mode, status: live ? live.status : mode === 'delivery' ? 'delivered' : 'collected',   // v6: a past order with no status ⇒ its done state
        storeName: e.name || '', branch: e.branch || '', storeAddr: e.pickup_addr || '',
        display_number: row.display_number != null ? row.display_number : d && d.display_number != null ? d.display_number : null,   // the row's first: the head is drawn before the receipt lands
        lines: d && d.lines ? d.lines.map((l) => ({ n: l.qty, name: l.description, extras: '', total: l.line_cents / 100 })) : CappOrder.textLines(d ? d.items_text : row.items_text),
        fee: c('delivery_cents'), redeem: c('promo_discount_cents'), tip: c('tip_cents'), total: c('total_cents') != null ? c('total_cents') : row.total,
        pay: d ? d.tender.method : null, addr: a ? a.detected || a.area || '' : '', details: a && a.details ? a.details : '' };
    }
    const receiptCtx = () => ({ entry: 'app', past: true, now: Number(nowMs()), dark: app.classList.contains('dark'), helpOk: !!supportWa() });
    function receiptScreenHtml(v) {
      const rc = S.receipt;
      return CappHome.shellWrap(v, CappOrder.orderHtml(receiptVm(rc), { ...receiptCtx(), hold: !rc.data && !rc.failed }));
    }
    function receiptAct(a) {
      const rc = S.receipt; if (!rc) return;
      if (a === 'order-close') { nav.back(); return; }               // v6: the close ⇒ «Pedidos»
      if (a === 'order-again') { nav.tab({ name: 'home' }); return; }  // «Hacer otro pedido» ⇒ Inicio
      if (a === 'order-help') { const n = supportWa(), num = receiptVm(rc).display_number; if (n) openExternal(`https://wa.me/${n}?text=${encodeURIComponent('Hola, tengo un problema con mi pedido' + (num ? ' #' + num : ''))}`); }
      // 'order-receipt': a past order's summary stays open (v6)
    }
    // ── «Volver a pedir» (v6 Pedidos; advisor 11-01: enabled BY DATA, never by brand). A past row is reorderable when its recipe lines
    // carry the store's canonical dish_id (getMyOrders' approved delta; null = not resolvable ⇒ disclosed, never guessed). The pill
    // replaces that store's cart with the order (v6 reorder: same dishes, same options; what no longer fits the live menu is dropped
    // and COUNTED — the cart's «N platos ya no están disponibles»), opens the store and its cart. The tab lists, per store, the past
    // dishes still on its live menu; «+» adds one to that store's cart. A store whose lines are all null has no pill and no section.
    // A cart mid-placement (a pending placement / payment record, a frozen or unreadable cart) is NEVER overwritten.
    const RECIPE_MAX = 100;
    // Codex VP r1 #3/#4: the options' meaning comes from the row's DATA — recipe_format absent = the legacy recipe (normalizeReorderItems):
    // { name, count } matched by the extra's NAME only, { id, qty } by its legacy ID only; any other format (e.g. the dormant canonical
    // one) is not rebuilt here ⇒ every line unavailable (disclosed). A present but malformed options container ⇒ that line unavailable
    function recipeOf(items, format) {
      const out = [];
      for (const l of Array.isArray(items) ? items.slice(0, RECIPE_MAX) : []) {
        if (!l || typeof l !== 'object' || !Number.isInteger(l.qty) || l.qty < 1 || l.qty > 50) continue;
        let ok = format === undefined || format === null;
        const dish = typeof l.dish_id === 'string' && l.dish_id ? l.dish_id : null;
        const options = [];
        if (l.options !== undefined && !Array.isArray(l.options)) ok = false;
        for (const op of Array.isArray(l.options) ? l.options : []) {
          if (op && typeof op.name === 'string' && Number.isInteger(op.count) && op.id === undefined) options.push({ by: 'name', v: op.name, n: op.count });
          else if (op && typeof op.id === 'string' && Number.isInteger(op.qty) && op.name === undefined) options.push({ by: 'id', v: op.id, n: op.qty });
          else ok = false;   // malformed ⇒ the line cannot be rebuilt faithfully
        }
        out.push({ dish_id: ok ? dish : null, qty: l.qty, options });
      }
      return out;
    }
    const reorderable = (lines) => lines.some((l) => l.dish_id);
    const UNKNOWN = '\u0000';   // a key no menu serves: hydrate drops the line and COUNTS it (the one disclosure path)
    function reorderSnap(menu, lines, prev) {
      const out = lines.map((l, i) => {
        const ex = Array.from({ length: l.qty }, () => ({}));
        let key = l.dish_id || UNKNOWN;
        if (l.dish_id) {
          const offered = menu.extrasFor(l.dish_id);
          for (const op of l.options) {
            const e = offered.find((x) => (op.by === 'name' ? x.name === op.v : String(x.id) === op.v));   // strictly by the recorded kind
            if (!e || op.n < 1 || op.n > l.qty) { key = UNKNOWN; break; }   // an option the menu no longer offers / cannot carry ⇒ unavailable
            for (let k = 0; k < op.n; k++) ex[k][e.key] = 1;
          }
        }
        // Codex VP r1 #6: the prices on show NOW are what the customer saw — so a later change is disclosed by the cart's priceChanges()
        const d = key !== UNKNOWN ? menu.dish(key) : null, c = (v) => Math.round(Number(v) * 100);
        const seen = d ? ex.map((x) => ({ b: c(d.price), x: Object.fromEntries(Object.keys(x).map((k) => [k, c(menu.extra(k).price)])) })) : undefined;
        return { key, qty: l.qty, ex, added: i + 1, ...(seen ? { seen } : {}) };
      });
      return { v: 2, lines: out, ...(prev && (prev.mode === 'pickup' || prev.mode === 'delivery') ? { mode: prev.mode } : {}) };
    }
    function pastRow(oid) { const rd = S.ordersRead && S.ordersRead.who === ownerNow() ? S.ordersRead : null; return rd ? rd.past.find((r) => r.order_id === oid) || null : null; }
    function reorder(oid) {
      const r = pastRow(oid); if (!r) return;
      const lines = recipeOf(r.items, r.recipe_format); if (!reorderable(lines)) return;
      S.reorder = { rid: r.restaurant, lines };
      enter(r.restaurant, null);
    }
    // the tab: per store (the past rows' order), the distinct past dishes its LIVE menu still serves (a variant line ⇒ its launcher)
    function againGroups(rows, past) {
      const groups = [];
      for (const r of past) {
        const lines = recipeOf(r.items, r.recipe_format); if (!reorderable(lines)) continue;
        const row = rows.find((x) => x.rid === r.restaurant); if (!row) continue;
        const view = viewOf(row.rid, row.entry); if (!view) continue;
        let g = groups.find((x) => x.rid === row.rid);
        if (!g) groups.push(g = { rid: row.rid, store: CappHome.storeOf({ ...row, cfg: cfgOf(row.entry) || {}, view }), items: [] });
        for (const l of lines) {
          if (!l.dish_id) continue;
          let hit = null;
          for (const sec of view.sections) for (const it of sec.items) if (!hit && (it.id === l.dish_id || (it.group && it.group.choices.some((c) => c.id === l.dish_id)))) hit = it;
          if (hit && !g.items.some((x) => x.id === hit.id)) g.items.push(hit);
        }
      }
      return groups.filter((g) => g.items.length);
    }
    // «+» on a past dish (v6 add-past): one more of it in THAT store's cart; the customer stays on «Pedidos» («Agregado · {store}»).
    // Advisor ruling 2026-11-02: EXACTLY the store's own cart-write path (CappUI.createCartCore — the functions and guards a «+» inside
    // the store runs): the store's preconditions (a FRESH menu, the dish orderable and not sold out), its lock predicate, its restore
    // (reconcile first; a purchased cart cleared), its mutation (frozen ⇒ refused; the order-text cap) and its persistence (never while
    // frozen), in its order. Anything the store would refuse or disclose ⇒ the store itself opens and decides. Nothing beyond a tap in the store
    function addPast(rid, key) {
      const row = dir.view().rows.find((x) => x.rid === rid), cfg = row && cfgOf(row.entry), view = row && viewOf(rid, row.entry), e = cache.peek(rid);
      const A = apiMod();
      if (!cfg || !view || !A || !(e && e.state === 'fresh') || availOf(rid).has(key)) return enter(rid, key);   // the store's own «+» preconditions (a sold-out dish ⇒ its store)
      let api = null;
      try { api = A.createApi({ config: CappUI.apiConfigOf(cfg), CappCheckout, storage, ...((o.uiOpts && o.uiOpts.apiOpts) || {}), now: () => Number(nowMs()) }); } catch (_) { return enter(rid, key); }
      const core = CappUI.createCartCore({ menu: view.menu, cfg, api: () => api, mods: () => true, CappCart: pick(o, 'CappCart', './capp-cart.js'), CappSerialize: pick(o, 'CappSerialize', './capp-serialize.js') });
      // the store's own ORDER: its mount restores first (reconcile — a purchased cart cleared), then a tap mutates (frozen ⇒ refused)
      const rr = core.restore(readJ(cfg.cartKey));
      if (rr.blocked || (rr.hydrated && rr.hydrated.dropped)) return enter(rid, key);   // the store draws its own disclosure — never a silently shortened cart
      if (!core.mutate((c) => c.inc(key), true).ok) return enter(rid, key);   // frozen / not addable (a launcher) / the text cap: the store
      const snap = core.snapshotFor(rr.mode || 'delivery');
      // the store's notifyCart → the shell's onCartChange. A FAILED persist: the store's own «+» keeps the edit in its live cart —
      // so does this one: the in-memory cart goes to the store as its mount's carried cart (the adoption path), no «Agregado»
      if (!core.frozenNow() && !writeJ(cfg.cartKey, snap)) { S.carry = { rid, snap }; return enter(rid, null); }
      toast(`Agregado · ${row.entry.name || ''}`); renderNow();
    }
    function openExternal(url) { try { if (win && typeof win.open === 'function') win.open(url, '_blank', 'noopener'); } catch (_) {} }
    // ── the location layers ──
    let pinGen = 0, pinMap = null, pinDraft = null;
    pinMapRef = () => pinMap;
    function renderLayer() {
      const L = $('layer'); if (!L) return;
      pinGen++; pinMap = null;   // any open pin map is obsolete
      L.innerHTML = S.layer === 'rate' && S.rate ? CappRate.sheetHtml(rateVm()) : S.layer === 'forget' ? CappHome.forgetSheetHtml() : S.layer === 'menuerr' ? menuErrHtml() : S.layer === 'addr' ? CappHome.addrSheetHtml() : S.layer === 'softask' ? CappHome.softaskHtml() : S.layer === 'pin' ? CappHome.pinEditorHtml(CappUI.MAP_SVG, !!runtime.mapsKey) : '';
      if (S.layer !== 'pin') return;
      const firstHub = dir.view().rows.map((r) => r.entry).find((e) => Number.isFinite(e.hub_lat) && Number.isFinite(e.hub_lng));
      pinDraft = S.loc ? { lat: S.loc.lat, lng: S.loc.lng } : null;   // the editor's VIEW starts on the city when there is no location — never a pin
      const center = pinDraft || (firstHub ? { lat: firstHub.hub_lat, lng: firstHub.hub_lng } : null);
      const el = L.querySelector('[data-gmap="pin"]'), p = el && center ? CappUI.loadMapsFor(doc, runtime.mapsKey) : null;
      if (!p) return;
      const gen = pinGen;
      p.then((gm) => {
        if (dead || gen !== pinGen || !el.isConnected) return;
        const m = new gm.Map(el, { center, zoom: 17, disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy', keyboardShortcuts: true, styles: themeStyles() });   // capp-dark §3
        pinMap = { gen, m };
        m.addListener('idle', () => { if (gen !== pinGen || dead) return; const c = m.getCenter(); if (c) pinDraft = { lat: c.lat(), lng: c.lng() }; });
      }).catch(() => {});
    }
    function menuErrHtml() {
      const h = S.held, row = h ? dir.view().rows.find((r) => r.rid === h.rid) : null;   // the name is data (the directory's, as on the row)
      return CappUI.errSheetHtml({ title: `No pudimos abrir ${row ? CappHome.storeOf(row).name : ''}`, body: 'Su menú no cargó. Revisá tu conexión e intentá de nuevo.', icon: 'warn',
        acts: [{ act: 'menu-retry', label: 'Reintentar', primary: true }, { act: 'menu-close', label: 'Cerrar' }] });
    }
    function openLayer(k) { S.layer = k; renderLayer(); }
    function closeLayer() { S.layer = null; renderLayer(); }
    let pending = null;
    const raf = win && typeof win.requestAnimationFrame === 'function' ? (f) => win.requestAnimationFrame(f) : (f) => T.setTimeout(f, 16);
    function schedule() { if (pending || dead) return; pending = true; raf(() => { pending = null; renderNow(); }); }

    // ── controls ──
    function onClick(ev) {
      if (dead) return;
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !app.contains(t) || t.disabled) return;
      if (S.store && !t.closest('.desknav')) return;   // a mounted store owns its page — except the shell's own top bar (C-6c)
      const a = t.dataset.act;
      if (a && a.startsWith('rate-') && rateAct(a, t)) return;   // C-2: the rating sheet and the Pedidos rows' entries
      if (a === 'addr' && S.store) { nav.tab({ name: 'home' }); if (!S.store && S.tab === 'home') openLayer('addr'); return; }   // the address is the shell's: Inicio, with its sheet up
      // the Cuenta tab: with the guest rules ON (runtime.guestCardOnly), a guest's (and an unresolved) is frame 5b; a member's is a
      // later slice. Flag absent ⇒ exactly the S7a-2 behaviour: a host event (Codex guest r1 #3)
      if (a === 'tab') { const id = t.dataset.tab; if (id === 'account' && !SU && (runtime.guestCardOnly !== true || authNow() === 'member')) { emit('tab', { tab: id }); return; }   // G7: under runtime.signup the Cuenta is the shell's
        if (id === 'home' || id === 'search' || id === 'account' || id === 'orders') { if (S.tab === id && nav.depth() === 1) return; nav.tab({ name: id }); } else emit('tab', { tab: id }); return; }
      if (S.tab === 'receipt' && a.startsWith('order-')) return void receiptAct(a);
      if (a.startsWith('order-') && orderAct(a)) return;
      if (a === 'otab') { S.ordersTab = t.dataset.val === 'again' ? 'again' : 'past'; return renderNow(); }   // v6 Pedidos tabs
      if (a === 'reorder') return reorder(t.dataset.oid);
      if (a === 'add-past') return addPast(t.dataset.rid, t.dataset.id);
      if (a === 'go-receipt') { if (t.dataset.oid) nav.go({ name: 'receipt', oid: t.dataset.oid }); return; }   // v6: a past row opens its receipt
      if (a === 'go-order') { const od = activeOrder(); if (od && t.dataset.oid === od.order_id) nav.go({ name: 'order' }); return; }   // the device's active order ⇒ its live screen
      if (a === 'orders-help') { const n = supportWa(); if (n) { const od = S.order && S.order.order_id === t.dataset.oid ? S.order : null; const msg = 'Hola, tengo un problema con mi pedido' + (od && od.display_number ? ' #' + od.display_number : ''); openExternal(`https://wa.me/${n}?text=${encodeURIComponent(msg)}`); } return; }
      if ((a === 'app-update' || a === 'app-update-row') && updateOn()) {
        if (a === 'app-update') { try { const d = dayOf(Number(nowMs())); if (d && storage) storage.setItem(UPD_KEY, d); } catch (_) {} }
        openExternal(runtime.store.url); renderNow(); return;
      }
      if (a === 'offer-create') { offerCreate(); return; }
      if (a === 'offer-skip') { if (S.order) { S.order.offerDone = true; renderNow(); } return; }
      if (a === 'signin') { openSignin({ ctx: t.dataset.ctx || 'account' }); return; }
      if (a === 'help') { emit('help', {}); return; }
      if (a === 'site-help') { const n = supportWa(); if (n) openExternal(`https://wa.me/${n}`); return; }   // C-6a: the footer's Ayuda — the platform's support chat (Codex C-6a r1 #1)
      if (a === 'promos') { if (t.getAttribute('aria-disabled') !== 'true') togglePromos(); return; }   // G7 frame 1 / 1b
      if (a === 'signout') return void signOutNow();
      if (a === 'forget') return openLayer('forget');   // G7 frame 2
      if (a === 'forget-confirm') { closeLayer(); return void signOutNow({ forget: true }); }
      if (a === 'open-store') return enter(t.dataset.rid, null);
      if (a === 'open-dish') return enter(t.dataset.rid, t.dataset.id);
      if (a === 'cuisine') { S.cuisine = t.dataset.val || ''; S.featPage = 0; return renderNow(); }
      if (a === 'filter') { const k = t.dataset.val; if (S.filters.has(k)) S.filters.delete(k); else S.filters.add(k); S.featPage = 0; return renderNow(); }
      if (a === 'clearfilters') { S.cuisine = ''; S.filters.clear(); S.featPage = 0; return renderNow(); }
      // C-6b: the desktop Inicio rows — «Destacados» paged by 4, «Ver todo» → «Todos los restaurantes», ‹ on the dish rows
      if (a === 'feat-prev' || a === 'feat-next') { S.featPage = Math.max(0, (S.featPage || 0) + (a === 'feat-next' ? 1 : -1)); return renderNow(); }
      if (a === 'seeall') { const el = app.querySelector('section[aria-label="Todos los restaurantes"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
      if (a === 'rowprev') { const row = t.closest('.hsec') && t.closest('.hsec').querySelector('.hrow'); if (row && row.scrollBy) row.scrollBy({ left: -Math.round(row.clientWidth * 0.8), behavior: 'smooth' }); return; }
      if (a === 'rownext') { const row = t.closest('.hsec') && t.closest('.hsec').querySelector('.hrow'); if (row && row.scrollBy) row.scrollBy({ left: Math.round(row.clientWidth * 0.8), behavior: 'smooth' }); return; }
      if (a === 'menu-retry') { closeLayer(); if (S.held) cache.get(S.held.rid); return; }   // frame 15: the row stays held until the menu answers
      if (a === 'menu-close') { S.held = null; S.reorder = null; S.carry = null; cancelRoute(); closeLayer(); return renderNow(); }
      if (a === 'menus-retry') { loadMenus(); return renderNow(); }   // frame 16
      if (a === 'dir-retry') { S.heldErr = false; dir.revalidate(); return renderNow(); }
      if (a === 'recent') { S.q = t.dataset.q; return renderNow(); }
      if (a === 'clearq') { S.q = ''; renderNow(); const i = $('gq'); if (i) i.focus(); return; }
      if (a === 'neutral-home') { S.neutral = null; return renderNow(); }
      if (a === 'addr') return openLayer('addr');
      if (a === 'lclose') return closeLayer();   // «Cancelar» on the pin editor: the guest location is unchanged
      if (a === 'addr-new') return openLayer('pin');
      if (a === 'loc-use') { if (!readJ('capp:loc_asked')) return openLayer('softask'); closeLayer(); return geolocate('Usando tu ubicación actual'); }
      if (a === 'loc-allow') { writeJ('capp:loc_asked', true); closeLayer(); return geolocate('Ubicación activada'); }
      if (a === 'loc-deny') { writeJ('capp:loc_asked', true); S.locDenied = true; closeLayer(); return renderNow(); }
      if (a === 'loc-on') return geolocate('Ubicación activada');
      if (a === 'pin-done') {
        const live = pinMap && pinMap.gen === pinGen ? pinMap.m.getCenter() : null;
        const d = live ? { lat: live.lat(), lng: live.lng() } : pinDraft;
        closeLayer();
        if (d && Number.isFinite(d.lat) && Number.isFinite(d.lng)) { setLoc(d.lat, d.lng, 'pin'); toast('Pin confirmado'); }
        return renderNow();
      }
      emit(a, {});
    }
    function onInput(ev) {
      if (dead || S.store) return;
      const el = ev.target; if (!el || !el.dataset) return;
      if (el.dataset.field === 'rate-comment' && S.rate) { S.rate.value.comment = el.value; syncRateSend(); return; }   // C-2: typed in place
      if (el.dataset.field !== 'q') return;
      S.q = el.value; renderNow();
    }
    function onVisible() { if (doc.visibilityState === 'visible' && !S.store) { dir.revalidate(); loadMenus(); } }
    doc.addEventListener('click', onClick);
    doc.addEventListener('input', onInput);
    doc.addEventListener('visibilitychange', onVisible);
    const dirTimer = T.setInterval(() => { if (!S.store && doc.visibilityState !== 'hidden') dir.revalidate(); }, DIR_EVERY_MS);
    const unAuth = auth && typeof auth.onChange === 'function' ? auth.onChange(() => { storeAuth(); schedule(); }) : null;

    // ── boot: paint from storage (presentation) at once; then every read ──
    dir.boot();
    for (const r of dir.view().rows) cache.seed(r.rid, readJ(MENU_KEY(r.rid)));
    // ── a hosted-checkout return (S7a-1 r2 §1.5 / r3 §2): its owner from EXACT local records only. One owner ⇒ that store is entered
    //    with the return (held until it is enterable); none / several on a fresh return ⇒ the neutral surface (frame 11); a stored
    //    handoff with no owner never re-shows it on later boots (it is kept, untouched, for its authoritative outcome) ──
    {
      const search = o.search !== undefined ? String(o.search || '') : (win && win.location ? win.location.search : '');
      // candidates: the stored directory, the menu LRU, and every store that holds a placement / pay record on this device (a cold
      // boot has no directory yet); ownership itself is decided by resolveOwner on the EXACT records
      const held = []; try { for (let i = 0; storage && i < storage.length; i++) { const m = /^capp:([^:]+):(pending_pay|pending_place)$/.exec(storage.key(i) || ''); if (m) held.push(m[1]); } } catch (_) {}
      const rids = [...new Set([...dir.view().rows.map((r) => r.rid), ...(readJ(LRU_KEY) || []), ...held])];
      let br = null; try { br = CappShell.bootReturn({ search, storage, rids, now: nowMs }); } catch (_) { br = null; }
      bootMode = br ? br.mode : 'error';   // D-4a §3 (Codex code r1 P2): hydration is gated on THIS, never on UI flags
      if (br && br.strip && win && win.history && win.location) { try { win.history.replaceState(win.history.state, '', win.location.pathname + win.location.hash); } catch (_) {} }
      if (br && br.handoff && br.owner) {
        const h = br.handoff, q = new URLSearchParams({ pay: h.pay }); if (h.order) q.set('order', h.order); if (h.t) q.set('t', h.t);
        S.ret = { rid: br.owner, search: '?' + q.toString(), handoff: h };
      } else if (br && br.handoff && (br.mode === 'persisted' || br.mode === 'memory')) S.neutral = { order: br.handoff.order };
    }
    app.classList.add('app');
    if (view) app.classList.toggle('desk', view.desk());   // D-2: BEFORE the first paint (no pop-in)
    const unView = view ? view.subscribe((d) => {
      if (dead) return;
      app.classList.toggle('desk', d);
      const h = $('su-host'); if (h) h.classList.toggle('desk', d);
      if (S.store && S.store.ui && typeof S.store.ui.setView === 'function') S.store.ui.setView(d);   // the store's view-conditional DOM
      else renderNow();   // Codex C-6b r1 #1: the shell's desk-only DOM (H1 row, grids, footer) follows the crossing — state + scroll kept
    }) : null;
    renderNow();
    dir.revalidate();
    loadMenus();
    if (S.ret) enter(S.ret.rid, null);
    // D-4a §3: a payment return OWNS the boot (S.ret / S.neutral) — hydration runs only when the boot found NO return
    booted = true;
    restoreActive();   // the device's active order, before the boot's route decision (a reload of /r/{rid}/pago lands on it)
    if (routing && (bootMode === 'none' || bootMode === 'invalid')) hydrate(); else reflect();
    // back from the store on a NEW build (state 4): the store left for, its cart open — never on a payment return (that owns the boot)
    if (!S.ret && !S.neutral) { const rid = pendingHandoff(); if (rid) { appUpdated = true; S.reopenCart = rid; enter(rid); } }   // ANY return (persisted / memory / resumed, owned or not) owns the boot
    // a device Back leaves the sentinel: the nav (its listener runs first) re-pushes it — inheriting the PREVIOUS entry's URL — and
    // a blocked back renders nothing; this listener re-reflects the screen actually shown (pathname only)
    const onPopReflect = () => { if (dead) return; cancelRoute(); reflect(); };   // a device Back is a user navigation (Codex code r1 P1): it cancels a held cold link too
    if (routing && typeof win.addEventListener === 'function') win.addEventListener('popstate', onPopReflect);
    // Codex code r2 (inverted, one check): a pending cold link is retried ONLY while the user has done NOTHING since hydration began
    // — ANY gesture (a tap, a key, typing; in the store or the shell: its search, a category, a sheet, an in-app back, a blocked
    // exit) cancels it through the same cancelRoute / navGen, BEFORE any retry can fire. The router itself dispatches no events
    const USER_INTENT = ['pointerdown', 'click', 'keydown', 'input'];
    const onUserIntent = () => { if (!dead && (pendingRoute || awaitOrderRoute)) cancelRoute(); };
    if (routing && (pendingRoute || awaitOrderRoute) && typeof doc.addEventListener === 'function') for (const ev of USER_INTENT) doc.addEventListener(ev, onUserIntent, true);
    if (SU) raf(() => startAuth());   // G6: the Auth SDK after the first paint (never awaited by it)

    return {
      nav, dir, cache, eligibility: elig, state: S, render: renderNow, store: () => S.store,
      // §4c for the sign-in flow (G6): set the marker at sign-in; ONLY «Cerrar sesión y olvidar este teléfono» / deletion forgets it
      rememberAccount: (e164) => CappDeviceAccount.remember(storage, e164), forgetAccount: () => CappDeviceAccount.forget(storage),
      destroy() {
        dead = true; clearTokenTimers(); stopOrder(); if (typeof unTheme === 'function') { try { unTheme(); } catch (_) {} } unmountStore(); T.clearInterval(dirTimer); if (typeof unAuth === 'function') unAuth(); if (unView) unView(); if (view) view.destroy(); if (routing && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', onPopReflect); if (typeof doc.removeEventListener === 'function') for (const ev of USER_INTENT) doc.removeEventListener(ev, onUserIntent, true);
        doc.removeEventListener('click', onClick); doc.removeEventListener('input', onInput); doc.removeEventListener('visibilitychange', onVisible); if (app && typeof app.removeEventListener === 'function') app.removeEventListener('scroll', onRowScroll, true); nav.destroy();
      },
    };
  }

  return { mount, DIR_EVERY_MS, AVAIL_EVERY_MS, MENU_LRU };
});
