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
    const CappCheckout = pick(o, 'CappCheckout', './capp-checkout.js'), CappDeviceAccount = pick(o, 'CappDeviceAccount', './capp-device-account.js');
    const win = o.win || doc.defaultView;
    const storage = o.storage !== undefined ? o.storage : (() => { try { return win.localStorage; } catch (_) { return null; } })();
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
    const storeAuth = () => { if (S.store && typeof S.store.ui.authChanged === 'function') S.store.ui.authChanged(); };
    const emit = (name, detail) => { try { (o.onEvent || (() => {}))(name, detail); } catch (_) {} };
    const $ = (id) => doc.getElementById(id);
    const app = $('app');
    const readJ = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
    const writeJ = (k, v) => { try { const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } };
    let dead = false, rebuild = true;

    const S = { tab: 'home', cuisine: '', filters: new Set(), q: '', recent: (readJ(RECENT_KEY) || []).filter((x) => typeof x === 'string').slice(0, RECENT_MAX),
      held: null, heldErr: false, store: null, layer: null, locDenied: false, loc: null, neutral: null, ret: null, retAssoc: null };
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
      const apiOpts = { storage, ...(uo.apiOpts || {}) };   // the store's records live in the shell's storage (one device store)
      // a mount NEVER reads location.search itself: only the store that OWNS a hosted-checkout return gets it, once
      const ret = S.ret && S.ret.rid === entry.rid && !freshBody ? S.ret : null; if (ret) S.ret = null;
      const ui = CappUI.mount(doc, { ...uo, ...(view ? { view } : {}),
        onRoute: (r) => { if (!S.store || S.store.ui !== ui || !r) return; if (pendingRoute && pendingRoute.mounted && r.step !== 'store') cancelRoute(); storeRoute = r; reflect(); if (pendingRoute && pendingRoute.mounted) tryRoute(); }, ...(S.member ? { member: S.member } : {}), authState: authNow, search: ret ? ret.search : '', apiOpts, orderable, deviceAccount: () => CappDeviceAccount.read(storage), beforeCheckout: () => adoptBeforeCheckout(), envelope: e.body, config: cfg, unavailable: availOf(entry.rid), now: clock, history: nav.adapterFor(entry), seedPin: () => S.loc,
        readAvailability: () => readAvail(entry.rid, ui && ui.menu),
        onCartChange: (snap) => { writeJ(cfg.cartKey, snap); if (typeof uo.onCartChange === 'function') uo.onCartChange(snap); },
        onEvent: (name, detail) => { if (name === 'outcome') { settleRet(entry.rid, detail); return; } if (name === 'signin' && SU) { openSignin(detail || {}); return; } if (name === 'back') { nav.back(); return; } if (name === 'home') { nav.tab({ name: 'home' }); return; } if (name === 'pin') { setLoc(detail.lat, detail.lng, detail.source === 'gps' ? 'gps' : 'pin'); return; } emit(name, { rid: entry.rid, ...(detail || {}) }); } });
      S.store = { rid: entry.rid, ui, entry, body: e.body, fp: null, adopt: null };
      watchMenu(S.store);
      const snap = carried || readJ(cfg.cartKey); if (snap) ui.restore(snap);   // an adoption carries the IN-MEMORY cart (Codex s7a2 r1 #1)
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
    function dropMember() { memberGen++; S.member = null; if (S.store) S.store.ui.setMember(null); }
    // the member the store mounts / fills from: the profile + the member token the transport sends
    async function applyMember(p) {
      // Codex G6 r1 #3: applied only if, after the token's await, nothing has changed — no sign-out / switch in between, and the
      // session is still THIS uid's
      const gen = ++memberGen, uid = p.uid;
      let idToken = null; try { idToken = await fbAuth.idToken(); } catch (_) { idToken = null; }
      if (dead || gen !== memberGen) return;
      const u = auth && auth.state() === 'member' && auth.user ? auth.user() : null;
      if (!u || u.uid !== uid) return;
      // getIdToken: the transport asks the SDK at send time (cached while valid, refreshed once expired); idToken = the fallback
      // S-picker: with the runtime intlPhone the member's number stays E.164 (its own country); off ⇒ the local 8 digits, as before
      S.member = { uid: p.uid, name: p.name || '', phone: runtime.intlPhone === true ? String(p.phone || '') : String(p.phone || '').replace(/\D/g, '').replace(/^504/, ''), email: p.email || '', ...(typeof p.promos === 'boolean' ? { promos: p.promos } : {}), idToken, getIdToken: () => fbAuth.idToken() };
      if (S.store) S.store.ui.setMember(S.member);   // §4c: back on the SAME checkout step, filled in
      schedule();
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
        return CappRoutes.format({ name: S.tab === 'search' ? 'search' : S.tab === 'account' ? 'account' : 'home' });
      } catch (_) { return null; }   // an id outside the ONE domain is never written: the URL stays as it is
    }
    function reflect() { if (routing && booted && !pendingRoute) replacePath(pathNow()); }   // never before the boot's hydration decision
    function cancelRoute() { if (pendingRoute) { pendingRoute = null; navGen++; } }
    function subscribeMenu(rid) { if (!subscribed.has(rid)) { subscribed.add(rid); cache.seed(rid, readJ(MENU_KEY(rid))); cache.subscribe(rid, () => { schedule(); checkHeld(); tryRoute(); }); } }
    function hydrate() {
      const r = CappRoutes.parse(bootPath);
      if (!r) { replacePath('/'); return; }   // unknown ⇒ Inicio, silently (no new copy)
      if (r.name === 'search' || r.name === 'account') { nav.tab({ name: r.name }); return; }
      if (r.name !== 'store') return;
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
        if (entry.name === 'store') { storeRoute = { step: 'store' }; if (!mountStore(entry)) T.setTimeout(() => nav.back(), 0); reflect(); return; }
        S.tab = entry.name; dir.visit(); dir.revalidate(); loadMenus();
        renderNow(x && x.restored ? x.restored : null);
      },
      onLeave: () => unmountStore() });

    // a store / dish tap: in now when eligible with a menu in hand; otherwise HELD until both (or released by a tombstone / failure)
    function enter(rid, dish) {
      cancelRoute();   // a tap is a user navigation
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
      if (st === 'gone' || st === 'unknown') { S.held = null; schedule(); return false; }
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
      if (st !== 'enterable' && v.failed && !v.pending) { S.held = null; S.heldErr = true; schedule(); }   // r3.3-F1: frame 7 for the held tap
      return false;
    }
    dir.subscribe(() => { loadMenus(); checkHeld(); schedule(); tryRoute(); });
    function remember(q) { const t = String(q).trim(); if (!t) return; S.recent = [t, ...S.recent.filter((x) => x !== t)].slice(0, RECENT_MAX); writeJ(RECENT_KEY, S.recent); }

    // ── render: the shell screens (a mounted store owns #app) ──
    function vm() {
      const v = dir.view();
      const rows = S.heldErr ? [] : v.rows.map((r) => {
        const cfg = cfgOf(r.entry) || {}, e = cache.peek(r.rid);
        return { ...r, cfg, view: viewOf(r.rid, r.entry), menuState: e ? e.state : null, held: !!S.held && S.held.rid === r.rid };
      });
      const nCart = v.rows.reduce((a, r) => { const c = cfgOf(r.entry); const s = c && readJ(c.cartKey); return a + (s && Array.isArray(s.lines) ? s.lines.reduce((n, l) => n + (Number(l.qty) || 0), 0) : 0); }, 0);
      return { phase: S.heldErr ? 'error' : v.phase, partial: !S.heldErr && v.partial, rows, platform: v.platform, now: clock(), auth: authNow(), cuisine: S.cuisine, filters: S.filters,
        schedulingLive: runtime.schedulingLive === true, outOfZone: !S.heldErr && CappHome.allOutOfZone(v.rows, S.loc), addr: { short: 'Tu ubicación', line: S.loc ? 'Tu ubicación' : 'Agregá tu dirección' }, locDenied: S.locDenied && !S.loc, tab: S.tab, cartN: nCart, live: false, q: S.q, recent: S.recent, ...(SU && S.tab === 'account' ? { acct: acctVm() } : {}) };
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
      const html = S.neutral ? CappHome.neutralReturnHtml(S.neutral.order) : S.tab === 'search' ? CappHome.searchHtml(v) : S.tab === 'account' && (runtime.guestCardOnly === true || SU) ? (v.acct ? CappHome.accountMemberHtml(v) : CappHome.accountGuestHtml(v)) : CappHome.homeHtml(v);
      if (scr && layer && toastEl && !rebuild) scr.innerHTML = html;   // the open layer (a live pin map) and a showing toast are never rebuilt
      else { rebuild = false; app.innerHTML = `<div class="screen">${html}</div><div class="layer" id="layer"></div><div class="toast" id="toast" role="status" aria-live="polite"></div>`; renderLayer(); }
      restoreScreen(keep);
      reflect();
    }
    // ── the location layers ──
    let pinGen = 0, pinMap = null, pinDraft = null;
    function renderLayer() {
      const L = $('layer'); if (!L) return;
      pinGen++; pinMap = null;   // any open pin map is obsolete
      L.innerHTML = S.layer === 'forget' ? CappHome.forgetSheetHtml() : S.layer === 'menuerr' ? menuErrHtml() : S.layer === 'addr' ? CappHome.addrSheetHtml() : S.layer === 'softask' ? CappHome.softaskHtml() : S.layer === 'pin' ? CappHome.pinEditorHtml(CappUI.MAP_SVG, !!runtime.mapsKey) : '';
      if (S.layer !== 'pin') return;
      const firstHub = dir.view().rows.map((r) => r.entry).find((e) => Number.isFinite(e.hub_lat) && Number.isFinite(e.hub_lng));
      pinDraft = S.loc ? { lat: S.loc.lat, lng: S.loc.lng } : null;   // the editor's VIEW starts on the city when there is no location — never a pin
      const center = pinDraft || (firstHub ? { lat: firstHub.hub_lat, lng: firstHub.hub_lng } : null);
      const el = L.querySelector('[data-gmap="pin"]'), p = el && center ? CappUI.loadMapsFor(doc, runtime.mapsKey) : null;
      if (!p) return;
      const gen = pinGen;
      p.then((gm) => {
        if (dead || gen !== pinGen || !el.isConnected) return;
        const m = new gm.Map(el, { center, zoom: 17, disableDefaultUI: true, clickableIcons: false, gestureHandling: 'greedy', keyboardShortcuts: true });
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
      if (dead || S.store) return;
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!t || !app.contains(t) || t.disabled) return;
      const a = t.dataset.act;
      // the Cuenta tab: with the guest rules ON (runtime.guestCardOnly), a guest's (and an unresolved) is frame 5b; a member's is a
      // later slice. Flag absent ⇒ exactly the S7a-2 behaviour: a host event (Codex guest r1 #3)
      if (a === 'tab') { const id = t.dataset.tab; if (id === 'account' && !SU && (runtime.guestCardOnly !== true || authNow() === 'member')) { emit('tab', { tab: id }); return; }   // G7: under runtime.signup the Cuenta is the shell's
        if (id === 'home' || id === 'search' || id === 'account') { if (S.tab === id && nav.depth() === 1) return; nav.tab({ name: id }); } else emit('tab', { tab: id }); return; }
      if (a === 'signin') { openSignin({ ctx: t.dataset.ctx || 'account' }); return; }
      if (a === 'help') { emit('help', {}); return; }
      if (a === 'promos') { if (t.getAttribute('aria-disabled') !== 'true') togglePromos(); return; }   // G7 frame 1 / 1b
      if (a === 'signout') return void signOutNow();
      if (a === 'forget') return openLayer('forget');   // G7 frame 2
      if (a === 'forget-confirm') { closeLayer(); return void signOutNow({ forget: true }); }
      if (a === 'open-store') return enter(t.dataset.rid, null);
      if (a === 'open-dish') return enter(t.dataset.rid, t.dataset.id);
      if (a === 'cuisine') { S.cuisine = t.dataset.val || ''; return renderNow(); }
      if (a === 'filter') { const k = t.dataset.val; if (S.filters.has(k)) S.filters.delete(k); else S.filters.add(k); return renderNow(); }
      if (a === 'clearfilters') { S.cuisine = ''; S.filters.clear(); return renderNow(); }
      if (a === 'rownext') { const row = t.closest('.hsec') && t.closest('.hsec').querySelector('.hrow'); if (row && row.scrollBy) row.scrollBy({ left: Math.round(row.clientWidth * 0.8), behavior: 'smooth' }); return; }
      if (a === 'menu-retry') { closeLayer(); if (S.held) cache.get(S.held.rid); return; }   // frame 15: the row stays held until the menu answers
      if (a === 'menu-close') { S.held = null; cancelRoute(); closeLayer(); return renderNow(); }
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
      const el = ev.target; if (!el || !el.dataset || el.dataset.field !== 'q') return;
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
    }) : null;
    renderNow();
    dir.revalidate();
    loadMenus();
    if (S.ret) enter(S.ret.rid, null);
    // D-4a §3: a payment return OWNS the boot (S.ret / S.neutral) — hydration runs only when the boot found NO return
    booted = true;
    if (routing && (bootMode === 'none' || bootMode === 'invalid')) hydrate(); else reflect();   // ANY return (persisted / memory / resumed, owned or not) owns the boot
    // a device Back leaves the sentinel: the nav (its listener runs first) re-pushes it — inheriting the PREVIOUS entry's URL — and
    // a blocked back renders nothing; this listener re-reflects the screen actually shown (pathname only)
    const onPopReflect = () => { if (dead) return; cancelRoute(); reflect(); };   // a device Back is a user navigation (Codex code r1 P1): it cancels a held cold link too
    if (routing && typeof win.addEventListener === 'function') win.addEventListener('popstate', onPopReflect);
    // Codex code r2 (inverted, one check): a pending cold link is retried ONLY while the user has done NOTHING since hydration began
    // — ANY gesture (a tap, a key, typing; in the store or the shell: its search, a category, a sheet, an in-app back, a blocked
    // exit) cancels it through the same cancelRoute / navGen, BEFORE any retry can fire. The router itself dispatches no events
    const USER_INTENT = ['pointerdown', 'click', 'keydown', 'input'];
    const onUserIntent = () => { if (!dead && pendingRoute) cancelRoute(); };
    if (routing && pendingRoute && typeof doc.addEventListener === 'function') for (const ev of USER_INTENT) doc.addEventListener(ev, onUserIntent, true);
    if (SU) raf(() => startAuth());   // G6: the Auth SDK after the first paint (never awaited by it)

    return {
      nav, dir, cache, eligibility: elig, state: S, render: renderNow, store: () => S.store,
      // §4c for the sign-in flow (G6): set the marker at sign-in; ONLY «Cerrar sesión y olvidar este teléfono» / deletion forgets it
      rememberAccount: (e164) => CappDeviceAccount.remember(storage, e164), forgetAccount: () => CappDeviceAccount.forget(storage),
      destroy() {
        dead = true; unmountStore(); T.clearInterval(dirTimer); if (typeof unAuth === 'function') unAuth(); if (unView) unView(); if (view) view.destroy(); if (routing && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', onPopReflect); if (typeof doc.removeEventListener === 'function') for (const ev of USER_INTENT) doc.removeEventListener(ev, onUserIntent, true);
        doc.removeEventListener('click', onClick); doc.removeEventListener('input', onInput); doc.removeEventListener('visibilitychange', onVisible); nav.destroy();
      },
    };
  }

  return { mount, DIR_EVERY_MS, AVAIL_EVERY_MS, MENU_LRU };
});
