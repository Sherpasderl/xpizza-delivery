// Customer app G6 (PLAN-capp-signin-required r5.4; advisor scope 2026-10-27): the in-app sign-in / sign-up — the ONE Firebase Auth
// adapter (a fake SDK here), its feed into CappAuthState, and (later in this file) the signup panes against the proposed wire.
// Run: node --test customer-app/capp-signup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFirebaseAuth } = require('./capp-auth-firebase.js');
const { createAuthState } = require('./capp-auth-state.js');

// a fake of the two SDK modules: one auth object, onAuthStateChanged fires with the persisted user (restore) after init
function fakeSdk({ persisted = null, failLoad = false } = {}) {
  const calls = { load: 0, init: [], persistence: [], customToken: [], signOut: 0 };
  let listeners = [], user = persisted;
  const auth = { get currentUser() { return user ? { uid: user, getIdToken: async (f) => `id:${user}:${f ? 'fresh' : 'cached'}` } : null; } };
  const emit = () => { for (const l of listeners) l(user ? { uid: user } : null); };
  const authMod = {
    browserLocalPersistence: 'LOCAL', getAuth: () => auth,
    setPersistence: async (a, p) => { calls.persistence.push(p); },
    onAuthStateChanged: (a, next) => { listeners.push(next); Promise.resolve().then(() => next(user ? { uid: user } : null)); return () => { listeners = listeners.filter((x) => x !== next); }; },
    signInWithCustomToken: async (a, t) => { calls.customToken.push(t); user = t.replace(/^ct:/, ''); emit(); return { user: { uid: user } }; },
    signOut: async () => { calls.signOut++; user = null; emit(); },
  };
  const loadSdk = async () => { calls.load++; if (failLoad) throw new Error('sdk load failed'); return { initializeApp: (cfg, name) => { calls.init.push([cfg.apiKey, name]); return {}; }, authMod }; };
  return { loadSdk, calls };
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await tick(); };
const CFG = { apiKey: 'k_test', authDomain: 'x.test', projectId: 'p' };

test('G6 auth adapter: nothing loads until asked; ONE initialization with the RUNTIME\'s config, local persistence; a persisted session is restored by the first callback', async () => {
  const S = fakeSdk({ persisted: 'u1' });
  const fb = createFirebaseAuth({ config: CFG, loadSdk: S.loadSdk });
  assert.equal(S.calls.load, 0, 'never loaded at construction (no awaited network on paint)');
  const seen = []; fb.subscribe((u) => seen.push(u)); fb.subscribe(() => {});
  await settle();
  assert.equal(S.calls.load, 1, 'one load, shared'); assert.deepEqual(S.calls.init, [['k_test', 'capp']]); assert.deepEqual(S.calls.persistence, ['LOCAL']);
  assert.deepEqual(seen, [{ uid: 'u1' }], 'the cached session is restored');
  assert.equal(await fb.idToken(), 'id:u1:cached'); assert.equal(await fb.idToken(true), 'id:u1:fresh');
});
test('G6 auth adapter → CappAuthState: unresolved until the first callback (never guest); a custom token signs in ⇒ member; an ordinary sign-out ⇒ guest; a failed SDK ⇒ unavailable (never guest)', async () => {
  const S = fakeSdk();
  const fb = createFirebaseAuth({ config: CFG, loadSdk: S.loadSdk });
  const st = createAuthState({ subscribe: fb.subscribe, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  assert.equal(st.state(), 'unresolved');
  await settle(); assert.equal(st.state(), 'guest');
  assert.equal(await fb.signInWithCustomToken('ct:u9'), 'u9'); await settle();
  assert.deepEqual([st.state(), st.user()], ['member', { uid: 'u9' }]);
  await fb.signOut(); await settle(); assert.equal(st.state(), 'guest');
  const F = fakeSdk({ failLoad: true });
  const ff = createFirebaseAuth({ config: CFG, loadSdk: F.loadSdk });
  const st2 = createAuthState({ subscribe: ff.subscribe, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  await settle(); assert.equal(st2.state(), 'unavailable', '🔴 a failed SDK is never a guest');
  assert.equal(st2.retry(), true); await settle(); assert.equal(F.calls.load, 2, '«Reintentar» re-loads the SDK');
  await assert.rejects(createFirebaseAuth({ config: null, loadSdk: S.loadSdk }).signInWithCustomToken('ct:x'), /no firebase config/);
});
