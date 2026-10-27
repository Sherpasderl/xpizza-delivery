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

// ── the signup sheet (capp-signup.js) against fakes of the transport + the auth adapter, rendered in jsdom ──
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const { createSignup, COPY } = require('./capp-signup.js');
const { createSignupApi } = require('./capp-signup-api.js');

function fakeApi(o = {}) {
  const calls = [];
  const rec = (n, r) => async (a) => { calls.push([n, a]); const v = typeof r === 'function' ? r(a) : r; return v; };
  return { calls, of: (n) => calls.filter((c) => c[0] === n).map((c) => c[1]),
    config: rec('config', o.config || { ok: true, termsUrl: 'https://legal.test/t', privacyUrl: 'https://legal.test/p', legalReady: true, googleEnabled: false, googleClientId: null }),
    requestOtp: rec('requestOtp', { ok: true, cooldown: 30 }),
    verifyOtp: rec('verifyOtp', o.verify || { ok: true, token: 'ct:u_new', isNew: true, name: null, completion: 'needed', profile: null }),
    googleStart: rec('googleStart', o.googleStart || { ok: false, reason: 'google_unconfigured' }),
    googleSignIn: rec('googleSignIn', o.googleSignIn || { ok: false, reason: 'bad_token' }),
    completeProfile: rec('completeProfile', o.complete || { ok: true }) };
}
function fakeAuth() {
  const calls = { ct: [], out: 0 }; let uid = null;
  return { calls, get uid() { return uid; },
    signInWithCustomToken: async (t) => { calls.ct.push(t); uid = t.replace(/^ct:/, ''); return uid; },
    signOut: async () => { calls.out++; uid = null; }, idToken: async () => (uid ? `id:${uid}` : null) };
}
function sheet(o = {}) {
  const w = new JSDOM('<!doctype html><body><div id="h"></div></body>', { pretendToBeVisual: true }).window;
  const host = w.document.getElementById('h'); const api = fakeApi(o); const auth = fakeAuth(); const events = [];
  if (o.holdSignIn) { const real = auth.signInWithCustomToken; auth.signInWithCustomToken = (t) => new Promise((r) => { o.holdSignIn.release = () => r(real(t)); }); }
  const su = createSignup({ doc: w.document, host, api, auth, google: o.google || null, timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} }, onEvent: (n, d) => events.push([n, d]) });
  const q = (s) => host.querySelector(s), qa = (s) => [...host.querySelectorAll(s)];
  const txt = (s) => { const el = q(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; };
  const click = async (s) => { const el = q(s); assert.ok(el, `premise: ${s}`); assert.ok(!el.disabled, `premise: ${s} enabled`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await settle(); };
  const type = async (s, v) => { const el = q(s); assert.ok(el, `premise: ${s}`); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); };
  const code = async (c) => { const el = q('[data-su-otp="0"]'); el.value = c; el.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); };
  const check = async (id) => { const el = q('#' + id); el.checked = true; el.dispatchEvent(new w.Event('change', { bubbles: true })); await settle(); };
  return { w, host, su, api, auth, events, q, qa, txt, click, type, code, check };
}

test('G6 sheet — a NEW phone account: phone → code → email → name + Términos → «¡Perfil creado!» → «Listo» = signed-in (the transport\'s calls, in order)', async () => {
  const b = sheet(); b.su.open({ ctx: 'checkout' }); await settle();
  assert.equal(b.txt('.sg .h1'), 'Entrá a tu cuenta'); assert.equal(b.txt('.sg .bm'), 'Sherpa');
  assert.ok(b.q('[data-su="phone-go"]').disabled, 'disabled until 8 digits');
  assert.equal(b.q('[data-su="google"]'), null, 'Google off in the config ⇒ no button'); assert.equal(b.qa('.sg button').some((x) => /correo/i.test(x.textContent)), false, '«Continuar con correo» is G6b (not drawn)');
  assert.equal(b.txt('[data-su="guest"]'), 'Prefiero seguir como invitado');
  await b.type('#su-phone', '9999 0000'); assert.equal(b.q('#su-phone').value, '9999-0000');
  await b.click('[data-su="phone-go"]');
  assert.deepEqual(b.api.of('requestOtp'), [{ phone: '+50499990000' }]);
  assert.equal(b.txt('.sg .h1'), 'Ingresá el código'); assert.match(b.txt('.sg .sub'), /\+504 9999-0000/);
  assert.match(b.txt('[data-su-left]'), /^Reenviar en 0:(29|30)$/, 'the prototype\'s countdown');
  await b.code('482913'); await b.click('[data-su="verify"]');
  assert.deepEqual(b.api.of('verifyOtp'), [{ phone: '+50499990000', code: '482913' }]); assert.deepEqual(b.auth.calls.ct, ['ct:u_new']);
  assert.equal(b.txt('.sg .h1'), 'Tu correo');
  await b.type('#su-email', 'ana@'); assert.deepEqual(b.qa('.chip').map((c) => c.textContent), ['ana@gmail.com', 'ana@hotmail.com', 'ana@yahoo.com']);
  assert.ok(b.q('[data-su="email-go"]').disabled);
  await b.click('.chip[data-v="ana@gmail.com"]'); await b.click('[data-su="email-go"]');
  assert.equal(b.txt('.sg .h1'), '¿Cómo te llamás?');
  assert.deepEqual(b.qa('.checks a').map((a) => a.getAttribute('href')), ['https://legal.test/t', 'https://legal.test/p']);
  await b.type('#su-name', 'Ana Pérez'); assert.ok(b.q('[data-su="save"]').disabled, '🔴 Términos are required');
  await b.check('su-terms'); await b.click('[data-su="save"]');
  assert.deepEqual(b.api.of('completeProfile'), [{ idToken: 'id:u_new', email: 'ana@gmail.com', name: 'Ana Pérez', promos: false }]);
  assert.equal(b.txt('.sg .h1'), '¡Perfil creado!');
  await b.click('[data-su="finish"]');
  assert.deepEqual(b.events, [['signed-in', { uid: 'u_new', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com', isNew: true }], ['done', {}]]);
  assert.equal(b.host.innerHTML, '', 'closed'); assert.equal(b.auth.calls.out, 0, 'a completed account stays signed in');
});
test('G6 sheet — an EXISTING complete account: «¡Hola de nuevo, Ana!» (no completion panes); ✕ on that pane = «Listo» (the member is applied)', async () => {
  const b = sheet({ verify: { ok: true, token: 'ct:u_ana', isNew: false, name: 'Ana Pérez', completion: 'complete', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } } });
  b.su.open({ prefill: '+50499990000' }); await settle();
  assert.equal(b.q('#su-phone').value, '9999-0000', '«Entrá de nuevo»: the device marker pre-fills the phone');
  await b.click('[data-su="phone-go"]'); await b.code('111111'); await b.click('[data-su="verify"]');
  assert.equal(b.txt('.sg .h1'), '¡Hola de nuevo, Ana!'); assert.equal(b.api.of('completeProfile').length, 0);
  await b.click('[data-su="close"]');
  assert.deepEqual(b.events, [['signed-in', { uid: 'u_ana', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com', isNew: false }], ['done', {}]], '🔴 ✕ on the done pane still signs the member in');
});
test('G6 sheet — code errors: the approved lines (wrong / expired / too many with minutes) and the forms\' generic line; the boxes clear', async () => {
  for (const [r, line] of [[{ ok: false, reason: 'code_wrong' }, COPY.codeErr.code_wrong], [{ ok: false, reason: 'code_expired' }, COPY.codeErr.code_expired],
    [{ ok: false, reason: 'too_many_attempts', retryInS: 540 }, 'Demasiados intentos. Probá de nuevo en 9 min.'], [{ ok: false, reason: 'offline' }, 'Código incorrecto o vencido']]) {
    const b = sheet({ verify: r }); b.su.open({}); await settle();
    await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('123456'); await b.click('[data-su="verify"]');
    assert.equal(b.txt('.inline.err'), line, `${r.reason}`); assert.equal(b.qa('[data-su-otp]').every((x) => x.value === ''), true);
    assert.equal(b.auth.calls.ct.length, 0, 'never signed in');
  }
});
test('G6 sheet — closing MID-completion signs out (never a member without the Términos); a late verify after a close lands nothing; member-only ⇒ no guest link', async () => {
  const b = sheet(); b.su.open({}); await settle();
  await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('123456'); await b.click('[data-su="verify"]');
  assert.equal(b.txt('.sg .h1'), 'Tu correo', 'premise: signed in, completion needed');
  await b.click('[data-su="close"]');
  assert.equal(b.auth.calls.out, 1, '🔴 the sign-in is undone'); assert.deepEqual(b.events, [['closed', {}]]);
  let release; const late = sheet({ verify: () => new Promise((r) => { release = r; }) });
  late.su.open({}); await settle(); await late.type('#su-phone', '99990000'); await late.click('[data-su="phone-go"]'); await late.code('123456');
  late.q('[data-su="verify"]').dispatchEvent(new late.w.MouseEvent('click', { bubbles: true })); await settle();
  await late.click('[data-su="close"]'); release({ ok: true, token: 'ct:u_late', isNew: true, completion: 'needed' }); await settle();
  assert.deepEqual(late.auth.calls.ct, [], '🔴 a verify answering after the close never signs in'); assert.equal(late.host.innerHTML, '');
  const g = sheet(); g.su.open({ ctx: 'checkout', memberOnly: true }); await settle();
  assert.equal(g.q('[data-su="guest"]'), null, 'a member-only gate has no guest path');
  const g2 = sheet(); g2.su.open({ ctx: 'checkout' }); await settle(); await g2.click('[data-su="guest"]');
  assert.deepEqual(g2.events, [['guest', {}]]);
});

test('G6 transport — `context:\'platform\'` on every call (never a restaurant id); the member token header; reasons pass through; a hang is bounded ⇒ offline', async () => {
  const sent = []; let hang = false;
  const fetch = async (u, i) => { sent.push({ u, i }); if (hang) return new Promise(() => {});
    const ep = u.split('?')[0].split('/').pop();
    const j = ep === 'getSignupConfig' ? { ok: true, terms_url: 't', privacy_url: 'p', legal_ready: true, google_enabled: true, google_client_id: 'gid' }
      : ep === 'verifyOtp' ? { ok: false, reason: 'too_many_attempts', retry_in_s: 540 } : { ok: true, cooldown: 30 };
    return { status: 200, json: async () => j }; };
  const EP = Object.fromEntries(['requestOtp', 'verifyOtp', 'getSignupConfig', 'googleStart', 'googleSignIn', 'completeProfile', 'redeemSignupGrant'].map((k) => [k, `https://fn.test/${k}`]));
  const api = createSignupApi({ endpoints: EP, fetch, timeoutMs: 20 });
  assert.deepEqual(await api.config(), { ok: true, termsUrl: 't', privacyUrl: 'p', legalReady: true, googleEnabled: true, googleClientId: 'gid' });
  assert.equal(sent[0].u, 'https://fn.test/getSignupConfig?context=platform'); assert.equal(sent[0].i.method, 'GET');
  await api.requestOtp({ phone: '+50499990000' });
  assert.deepEqual(JSON.parse(sent[1].i.body), { phone: '+50499990000', context: 'platform' }, '🔴 the platform wire: requestOtp');
  assert.deepEqual(await api.verifyOtp({ phone: '+50499990000', code: '1' }), { ok: false, reason: 'too_many_attempts', retryInS: 540 });
  await api.completeProfile({ idToken: 'id:u1', email: 'a@b.co', name: 'Ana', promos: true });
  assert.equal(sent[3].i.headers['x-firebase-id-token'], 'id:u1', '🔴 completeProfile carries the member token');
  assert.deepEqual(JSON.parse(sent[3].i.body), { context: 'platform', email: 'a@b.co', accept_terms: true, promos: true, name: 'Ana' });
  for (const s of sent) assert.equal(/restaurant_id/.test(String(s.i.body || '') + s.u), false, '🔴 never a restaurant id');
  hang = true;
  assert.deepEqual(await api.requestOtp({ phone: '+50499990000' }), { ok: false, reason: 'offline' }, 'bounded');
});
test('G6 sheet — a custom-token sign-in that lands AFTER the close is undone (signed out); nothing is emitted for it', async () => {
  const hold = {}; const b = sheet({ holdSignIn: hold }); b.su.open({}); await settle();
  await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('123456');
  b.q('[data-su="verify"]').dispatchEvent(new b.w.MouseEvent('click', { bubbles: true })); await settle();
  assert.equal(typeof hold.release, 'function', 'premise: the sign-in is in flight');
  await b.click('[data-su="close"]'); hold.release(); await settle();
  assert.equal(b.auth.uid, null, '🔴 a mint for a closed sheet is signed out'); assert.equal(b.auth.calls.out, 1);
  assert.deepEqual(b.events, [['closed', {}]]);
});
test('G6 sheet — «Prefiero seguir como invitado» only where a checkout is behind the sheet (advisor 2026-10-27, the prototype): never from Cuenta', async () => {
  for (const ctx of ['checkout', 'checkout-returning', 'code', 'refusal']) {
    const b = sheet(); b.su.open({ ctx }); await settle();
    assert.equal(b.txt('[data-su="guest"]'), 'Prefiero seguir como invitado', `shown for ${ctx}`);
  }
  for (const ctx of ['account', 'reauth', 'schedule', null]) {
    const b = sheet(); b.su.open({ ctx }); await settle();
    assert.equal(b.q('[data-su="guest"]'), null, `🔴 no guest link for ${ctx}`);
  }
});
test('Codex G6 r1 #4 — A verified, Back ×2, then B: nothing of A (name / email / consent) reaches B\'s panes or B\'s profile', async () => {
  const A = { ok: true, token: 'ct:u_a', isNew: false, name: 'Ana Pérez', completion: 'complete', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } };
  const B = { ok: true, token: 'ct:u_b', isNew: true, name: null, completion: 'needed', profile: null };
  const seq = [A, B]; const b = sheet({ verify: () => seq.shift() }); b.su.open({ ctx: 'checkout' }); await settle();
  await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('111111'); await b.click('[data-su="verify"]');
  assert.equal(b.txt('.sg .h1'), '¡Hola de nuevo, Ana!', 'premise: A');
  await b.click('[data-su="back"]'); await b.click('[data-su="back"]');
  assert.equal(b.txt('.sg .h1'), 'Entrá a tu cuenta', 'premise: back on the phone pane');
  await b.type('#su-phone', '88880000'); await b.click('[data-su="phone-go"]'); await b.code('222222'); await b.click('[data-su="verify"]');
  assert.equal(b.txt('.sg .h1'), 'Tu correo');
  assert.equal(b.q('#su-email').value, '', '🔴 B never inherits A\'s email');
  await b.type('#su-email', 'beto@correo.com'); await b.click('[data-su="email-go"]');
  assert.equal(b.q('#su-name').value, '', '🔴 B never inherits A\'s name');
  assert.equal(b.q('#su-terms').checked, false, 'nor A\'s consent');
  await b.type('#su-name', 'Beto'); await b.check('su-terms'); await b.click('[data-su="save"]'); await b.click('[data-su="finish"]');
  assert.deepEqual(b.api.of('completeProfile'), [{ idToken: 'id:u_b', email: 'beto@correo.com', name: 'Beto', promos: false }]);
  assert.deepEqual(b.events.filter((e) => e[0] === 'signed-in'), [['signed-in', { uid: 'u_b', name: 'Beto', phone: '+50488880000', email: 'beto@correo.com', isNew: true }]], 'B\'s profile only');
});
