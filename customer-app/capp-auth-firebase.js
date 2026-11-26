// Customer app G6 (PLAN-capp-signin-required r5.4 §1, advisor scope 2026-10-27) — the ONE Firebase Auth adapter. UMD, brand-agnostic
// (no restaurant id or name; the project config is the app RUNTIME's, never typed here). DARK.
//
//   The SDK is the one the forms load (gstatic firebasejs 10.12.2: app + auth), imported LAZILY — never awaited by a paint. The
//   session persists on the device (browserLocalPersistence), so a returning member is RESTORED by the SDK's first auth callback; until
//   then CappAuthState reports `unresolved` (never guest).
//   createFirebaseAuth({ config, loadSdk? }) →
//     subscribe(onUser, onError) → unsubscribe     the CappAuthState adapter: onUser({ uid } | null) on every auth change
//     signInWithCustomToken(token, { live, before }?) → Promise<uid | null>   verifyOtp / redeemSignupGrant / Google all end in a custom
//                                                       token. null = skipped (not live at its turn) or compensated (not live when it
//                                                       landed: signed out again, scoped to ITS uid, inside its own slot)
//     signOut() → Promise                            an ORDINARY sign-out (the device marker is kept, §4c)
//     signOutIf(uid) → Promise<boolean>              signs out ONLY while the SDK user is still `uid` (a sheet undoing its OWN sign-in)
//     current() → uid | null                         the SDK's user NOW (null = none, or the SDK not loaded yet) — read inside a slot's liveness
//   THE QUEUE (PLAN-capp-multitab-gate-r7 C1, #347-4): every SDK identity transition — the three above — runs strictly ONE at a time,
//   in call order, so a stale attempt's continuation can never undo a NEWER sign-in (Ana's late call signing Bob out)
//     idTokenOwned(force?) → Promise<{ token, uid }>  uid = the SDK's user when the answer is made (null = signed out); token = null
//                                                       when that is not the user the token was asked for; REJECTS on a token failure
//   loadSdk() → Promise<{ initializeApp, authMod }> is injectable (tests use a fake; production imports the SDK).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappAuthFirebase = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';   // the version the order forms load (their ensureFirebase)
  const importSdk = () => Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]).then(([app, authMod]) => ({ initializeApp: app.initializeApp, authMod }));

  function createFirebaseAuth(opts) {
    const o = opts || {};
    const loadSdk = typeof o.loadSdk === 'function' ? o.loadSdk : importSdk;
    let ready = null;   // Promise<{ auth, authMod }> — ONE initialization per adapter
    let authNow = null;   // the initialized auth, for current()
    function ensure() {
      if (ready) return ready;
      if (!o.config || typeof o.config !== 'object' || !o.config.apiKey) return Promise.reject(new Error('capp-auth: no firebase config'));
      ready = loadSdk().then(async ({ initializeApp, authMod }) => {
        const app = initializeApp(o.config, o.appName || 'capp');
        const auth = authMod.getAuth(app);
        await authMod.setPersistence(auth, authMod.browserLocalPersistence);
        authNow = auth;
        return { auth, authMod };
      });
      ready.catch(() => { ready = null; });   // a failed load can be retried («Reintentar» on «Sin conexión»)
      return ready;
    }
    const userOf = (u) => (u && u.uid ? { uid: u.uid } : null);
    // the ONE queue: a transition starts only when the previous one has settled (whatever its outcome)
    let tail = Promise.resolve();
    const slot = (fn) => { const run = tail.then(fn); tail = run.then(() => {}, () => {}); return run; };
    const currentIs = (auth, uid) => !!uid && !!auth.currentUser && auth.currentUser.uid === uid;
    return {
      subscribe(onUser, onError) {
        let live = true, unsub = null;
        ensure().then(({ auth, authMod }) => {
          if (!live) return;
          unsub = authMod.onAuthStateChanged(auth, (u) => { if (live) onUser(userOf(u)); }, (e) => { if (live && typeof onError === 'function') onError(e); });
        }, (e) => { if (live && typeof onError === 'function') onError(e); });
        return () => { live = false; if (typeof unsub === 'function') { try { unsub(); } catch (_) {} } };
      },
      signInWithCustomToken(token, opts2) {
        if (typeof token !== 'string' || !token) return Promise.reject(new Error('capp-auth: no token'));
        const p = opts2 || {}, live = typeof p.live === 'function' ? p.live : () => true;
        return slot(async () => {
          if (!live()) return null;   // closed before its turn: no SDK call at all
          const { auth, authMod } = await ensure();
          if (!live()) return null;
          if (typeof p.before === 'function') p.before();   // inside the slot, BEFORE the SDK call (C4's pending-sign-in marker)
          const cred = await authMod.signInWithCustomToken(auth, token);
          const uid = cred && cred.user ? cred.user.uid : (auth.currentUser && auth.currentUser.uid) || null;
          if (live()) return uid;
          // landed for a closed attempt: undone INSIDE this slot (the next transition waits), and only while the SDK still holds ITS uid
          if (currentIs(auth, uid)) await authMod.signOut(auth);
          return null;
        });
      },
      signOut() { return slot(async () => { const { auth, authMod } = await ensure(); await authMod.signOut(auth); }); },
      current() { return authNow && authNow.currentUser ? authNow.currentUser.uid || null : null; },
      signOutIf(uid) { return slot(async () => { const { auth, authMod } = await ensure(); if (!currentIs(auth, uid)) return false; await authMod.signOut(auth); return true; }); },
      // Codex #152 #2: the token WITH the SDK user it belongs to — and only if that user is STILL the SDK's current one when the token
      // arrives (a sign-out / switch can land while getIdToken is in flight, BEFORE the auth listeners — and so the shell — hear of it)
      async idTokenOwned(force) {
        const { auth } = await ensure();
        // Codex #189 #1: a changed user (or none) is an ANSWER — { token: null, uid: who the SDK holds now } — never a bare null, which
        // the transport cannot tell from a failed read; a failed read rejects (the caller's transient path)
        const u = auth.currentUser; if (!u || !u.uid) return { token: null, uid: null };
        const token = await u.getIdToken(force === true);
        const now = auth.currentUser, nu = now && now.uid ? now.uid : null;
        return token && nu === u.uid ? { token, uid: u.uid } : { token: null, uid: nu };
      },
    };
  }

  return { createFirebaseAuth, SDK };
});
