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
  const su = createSignup({ doc: w.document, host, api, auth, google: o.google || null, ...(o.intl ? { intlPhone: true, CappPhone: require('./capp-phone.js') } : {}), timers: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} }, onEvent: (n, d) => events.push([n, d]) });
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
  assert.deepEqual(b.events, [['signed-in', { uid: 'u_new', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com', isNew: true, promos: false }], ['done', {}]]);
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
  assert.deepEqual(b.events.filter((e) => e[0] === 'signed-in'), [['signed-in', { uid: 'u_b', name: 'Beto', phone: '+50488880000', email: 'beto@correo.com', isNew: true, promos: false }]], 'B\'s profile only');
});
test('Codex G6 r3 — a COMPLETE account leaves the sheet as «Listo» by any exit: done → Back → ✕ (phone and Google), the profile saved → Back → ✕; an incomplete one is still undone', async () => {
  const A = { ok: true, token: 'ct:u_a', isNew: false, name: 'Ana Pérez', completion: 'complete', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } };
  const b = sheet({ verify: A }); b.su.open({ ctx: 'checkout' }); await settle();
  await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('111111'); await b.click('[data-su="verify"]');
  assert.equal(b.txt('.sg .h1'), '¡Hola de nuevo, Ana!', 'premise');
  await b.click('[data-su="back"]'); await b.click('[data-su="back"]'); await b.type('#su-phone', '88887777');   // the field edited, never verified
  await b.click('[data-su="close"]');
  assert.deepEqual(b.events, [['signed-in', { uid: 'u_a', name: 'Ana Pérez', phone: '+50499990000', email: 'ana@gmail.com', isNew: false }], ['done', {}]], '🔴 a complete account\'s exit = «Listo» (with the VERIFIED number)');
  assert.equal(b.auth.calls.out, 0, 'never signed out');
  // the host's teardown (navigation / back gesture) follows the same rule
  const t = sheet({ verify: A }); t.su.open({ ctx: 'checkout' }); await settle();
  await t.type('#su-phone', '99990000'); await t.click('[data-su="phone-go"]'); await t.code('111111'); await t.click('[data-su="verify"]'); await t.click('[data-su="back"]');
  t.su.close(); await settle();
  assert.equal(t.events[0][0], 'signed-in', 'a teardown of a complete account = «Listo»');
  // Google, linked to a complete account
  const g = sheet({ config: { ok: true, termsUrl: null, privacyUrl: null, legalReady: true, googleEnabled: true, googleClientId: 'gid' },
    googleStart: { ok: true, nonce: 'n1' }, googleSignIn: { ok: true, linked: true, token: 'ct:u_g', isNew: false, name: 'Gabi', completion: 'complete', profile: { name: 'Gabi', email: 'gabi@gmail.com' } },
    google: { getIdToken: async () => 'gid-token' } });
  g.su.open({ ctx: 'checkout' }); await settle(); await g.click('[data-su="google"]'); await settle();
  assert.equal(g.txt('.sg .h1'), '¡Hola de nuevo, Gabi!', 'premise: Google, complete');
  await g.click('[data-su="back"]'); await g.click('[data-su="close"]');
  assert.equal(g.events[0][0], 'signed-in'); assert.equal(g.events[0][1].uid, 'u_g', '🔴 Google: the same rule');
  // a NEW account whose profile was saved: complete from there on
  const n = sheet(); n.su.open({ ctx: 'checkout' }); await settle();
  await n.type('#su-phone', '99990000'); await n.click('[data-su="phone-go"]'); await n.code('123456'); await n.click('[data-su="verify"]');
  await n.type('#su-email', 'ana@gmail.com'); await n.click('[data-su="email-go"]'); await n.type('#su-name', 'Ana'); await n.check('su-terms'); await n.click('[data-su="save"]');
  assert.equal(n.txt('.sg .h1'), '¡Perfil creado!'); await n.click('[data-su="back"]'); await n.click('[data-su="close"]');
  assert.equal(n.events[0][0], 'signed-in', 'saved ⇒ complete ⇒ «Listo»'); assert.equal(n.auth.calls.out, 0);
  // INCOMPLETE → Back → ✕ ⇒ undone (unchanged)
  const i = sheet(); i.su.open({ ctx: 'checkout' }); await settle();
  await i.type('#su-phone', '99990000'); await i.click('[data-su="phone-go"]'); await i.code('123456'); await i.click('[data-su="verify"]');
  await i.click('[data-su="back"]'); await i.click('[data-su="close"]');
  assert.deepEqual(i.events, [['closed', {}]]); assert.equal(i.auth.calls.out, 1, '🔴 an incomplete sign-in is still undone');
  // a guest choice after a complete sign-in: the customer declined — that session is undone, no member
  const q = sheet({ verify: A }); q.su.open({ ctx: 'checkout' }); await settle();
  await q.type('#su-phone', '99990000'); await q.click('[data-su="phone-go"]'); await q.code('111111'); await q.click('[data-su="verify"]');
  await q.click('[data-su="back"]'); await q.click('[data-su="back"]'); await q.click('[data-su="guest"]');
  assert.deepEqual(q.events, [['guest', {}]]); assert.equal(q.auth.calls.out, 1);
});
test('Codex G6 r4 — ONE finalization: «Listo» then the host\'s close ×2 ⇒ exactly one signed-in; a guest exit after a sign-in is final (no signed-in after the sign-out)', async () => {
  const A = { ok: true, token: 'ct:u_a', isNew: false, name: 'Ana Pérez', completion: 'complete', profile: { name: 'Ana Pérez', email: 'ana@gmail.com' } };
  const b = sheet({ verify: A }); b.su.open({ ctx: 'checkout' }); await settle();
  await b.type('#su-phone', '99990000'); await b.click('[data-su="phone-go"]'); await b.code('111111'); await b.click('[data-su="verify"]');
  await b.click('[data-su="finish"]'); b.su.close(); b.su.close(); await settle();
  assert.deepEqual(b.events.map((e) => e[0]), ['signed-in', 'done'], '🔴 finalized once: a later close never re-finishes');
  const g = sheet({ verify: A }); g.su.open({ ctx: 'checkout' }); await settle();
  await g.type('#su-phone', '99990000'); await g.click('[data-su="phone-go"]'); await g.code('111111'); await g.click('[data-su="verify"]');
  await g.click('[data-su="back"]'); await g.click('[data-su="back"]'); await g.click('[data-su="guest"]'); g.su.close(); await settle();
  assert.deepEqual(g.events.map((e) => e[0]), ['guest'], '🔴 no signed-in after the guest exit (its sign-out stands)'); assert.equal(g.auth.calls.out, 1);
  // a re-open is a fresh sheet again (the latch belongs to one opening)
  g.su.open({ ctx: 'checkout' }); await settle(); assert.equal(g.txt('.sg .h1'), 'Entrá a tu cuenta');
});
test('S4 frame G = B (only with the host\'s scheduleGate, i.e. schedulingLive): the drawn sheet, ONLY the subtitle «Para programar tu pedido necesitás una cuenta.», the guest exit kept; without it, G6 as before', async () => {
  const g = sheet(); g.su.open({ ctx: 'schedule', scheduleGate: true }); await settle();
  assert.equal(g.txt('.sg .h1'), 'Entrá a tu cuenta'); assert.equal(g.txt('.sg .sub'), 'Para programar tu pedido necesitás una cuenta.', '🔴 G = B');
  assert.equal(g.txt('[data-su="guest"]'), 'Prefiero seguir como invitado', '🔴 the guest exit kept (the order stays ASAP)');
  await g.click('[data-su="guest"]'); assert.deepEqual(g.events, [['guest', {}]]);
  const o = sheet(); o.su.open({ ctx: 'schedule', memberOnly: true }); await settle();
  assert.equal(o.txt('.sg .sub'), 'Guardá tus datos y pedí más rápido la próxima vez.'); assert.equal(o.q('[data-su="guest"]'), null, 'G6 unchanged without the gate');
});

// ── the sign-in sheet's country picker (MOCKUP-capp-member-cuenta-APPROVED-2026-10-27 part B, option (b)) — under runtime.intlPhone ──
test('Part B (b): under intlPhone the .cc is a BUTTON; the country list is a PANE inside the sheet (← Atrás back to the phone); the approved rows, Honduras checked', async () => {
  const b = sheet({ intl: true }); b.su.open({ ctx: 'account' }); await settle();
  const cc = b.q('.phonerow button.cc');
  assert.ok(cc, '🔴 SP-cc: the .cc is a button'); assert.equal(cc.textContent.trim(), '+504'); assert.equal(cc.getAttribute('aria-label'), 'País del número: Honduras +504'); assert.ok(cc.querySelector('svg'));
  await b.click('.phonerow button.cc');
  assert.equal(b.txt('.sg .h1'), 'País del número', '🔴 SP-pane: the country list is a pane of THIS sheet');
  assert.equal(b.txt('.sg .sub'), 'Solo cambia el código de tu WhatsApp. Entregamos únicamente en Honduras.');
  assert.equal(b.qa('.sg .clist .crow').length, 10); assert.deepEqual([b.txt('.crow.on .nm'), b.txt('.crow.on .code')], ['Honduras', '+504']); assert.ok(b.q('.crow.on svg'));
  assert.ok(b.q('[data-su="back"]'), 'the sheet\'s own ← Atrás'); assert.equal(b.w.document.querySelectorAll('.sheet').length, 1, 'never a second sheet');
  await b.click('[data-su="back"]');
  assert.equal(b.txt('.sg .h1'), 'Entrá a tu cuenta', 'Atrás ⇒ the phone pane');
});
test('Part B (b): picking a country returns to the phone pane with its code, its length and format; E.164 on the wire (request, verify, the signed-in phone)', async () => {
  const b = sheet({ intl: true, verify: { ok: true, token: 'ct:u_us', isNew: false, name: 'Ann', completion: 'complete', profile: { name: 'Ann', email: 'a@b.co' } } }); b.su.open({ ctx: 'account' }); await settle();
  await b.click('.phonerow button.cc'); await b.click('.crow[data-cc="1"]');
  assert.equal(b.txt('.sg .h1'), 'Entrá a tu cuenta', '🔴 SP-pick: back on the phone pane');
  assert.equal(b.q('.phonerow button.cc').textContent.trim(), '+1', '🔴 SP-pick: the chosen code'); assert.equal(b.q('#su-phone').getAttribute('placeholder'), '(555) 123-4567');
  await b.type('#su-phone', '30555512349'); assert.equal(b.q('#su-phone').value, '(305) 555-1234', '🔴 SP-len: the country\'s length and format');
  await b.click('[data-su="phone-go"]');
  assert.deepEqual(b.api.of('requestOtp'), [{ phone: '+13055551234' }], '🔴 SP-wire: E.164 of the chosen country');
  assert.match(b.txt('.sg .sub'), /\+1 \(305\) 555-1234/);
  await b.code('482913'); await b.click('[data-su="verify"]');
  assert.deepEqual(b.api.of('verifyOtp'), [{ phone: '+13055551234', code: '482913' }]);
  await b.click('[data-su="finish"]');
  assert.equal(b.events.find((e) => e[0] === 'signed-in')[1].phone, '+13055551234');
});
test('Part B (b): a device marker\'s full E.164 pre-fills ITS country; without intlPhone the sheet keeps the «+504» span and the 8-digit field, byte for byte', async () => {
  const b = sheet({ intl: true }); b.su.open({ ctx: 'checkout-returning', prefill: '+13055551234' }); await settle();
  assert.equal(b.q('.phonerow button.cc').textContent.trim(), '+1', '🔴 SP-prefill: the marker\'s country'); assert.equal(b.q('#su-phone').value, '(305) 555-1234');
  const off = sheet(); off.su.open({ ctx: 'account' }); await settle();
  assert.equal(off.q('.phonerow button.cc'), null); assert.equal(off.q('.phonerow span.cc').textContent, '+504');
});

// Codex G7 r1 #6 / r2: EVERY transport call site, PARSED (acorn — a regex is bypassed by `call ('…')`): each use of the transport's
// `call` (or any alias of it) must be a direct call whose first argument is E.<a listed key> or a template that begins with exactly
// one; a literal URL, a computed E[...], an unlisted key, an alias call or any other use of `call` (passed, .call/.apply) is a violation.
const acorn = createRequire(join(ROOT, 'xpizza-functions/x.js'))('acorn');
function endpointViolations(src, listed) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const kids = (n) => Object.values(n).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v && typeof v.type === 'string');
  const all = []; (function walk(n, parent, key) { all.push({ n, parent, key }); for (const [k, v] of Object.entries(n)) for (const c of (Array.isArray(v) ? v : [v])) if (c && typeof c.type === 'string') walk(c, n, k); })(ast, null, null);
  const names = new Set(['call']);   // the transport's function and every alias bound to it, transitively
  for (let grew = true; grew;) { grew = false; for (const { n } of all) if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'Identifier' && names.has(n.init.name) && !names.has(n.id.name)) { names.add(n.id.name); grew = true; } }
  const isE = (x) => x && x.type === 'MemberExpression' && x.object.type === 'Identifier' && x.object.name === 'E';
  const keyOf = (a) => (a && isE(a) && !a.computed && a.property.type === 'Identifier' ? a.property.name
    : a && a.type === 'TemplateLiteral' && a.quasis[0].value.cooked === '' && a.expressions.length && isE(a.expressions[0]) && !a.expressions[0].computed ? a.expressions[0].property.name : null);
  const bad = [], called = new Set();
  for (const { n, parent, key } of all) {
    if (isE(n) && n.computed) bad.push('computed E[...]');
    if (isE(n) && !n.computed && !listed.includes(n.property.name)) bad.push('unlisted E.' + n.property.name);
    if (n.type !== 'Identifier' || !names.has(n.name)) continue;
    if (parent && parent.type === 'FunctionDeclaration' && key === 'id') continue;                        // async function call(…)
    if (parent && parent.type === 'VariableDeclarator') continue;                                        // an alias binding (its uses are checked)
    if (parent && parent.type === 'CallExpression' && key === 'callee') {
      const k = keyOf(parent.arguments[0]);
      if (k === null) bad.push('call(' + src.slice(parent.arguments[0] ? parent.arguments[0].start : parent.start, (parent.arguments[0] || parent).end).slice(0, 40) + ')');
      else if (listed.includes(k)) called.add(k);
      continue;
    }
    bad.push('other use of ' + n.name);                                                                  // passed as a value, .call / .apply, …
  }
  for (const k of listed) if (!called.has(k)) bad.push('never called: ' + k);
  return bad;
}
test('runtime.signup endpoints: ENDPOINTS is the ONE source — every transport call site sends to an E.<listed key>, every key is called (G7 setPromos included); bypasses FAIL the guard', async () => {
  const { ENDPOINTS, createSignupApi } = require('./capp-signup-api.js');
  const src = readFileSync(join(HERE, 'capp-signup-api.js'), 'utf8');
  assert.deepEqual(endpointViolations(src, ENDPOINTS), [], '🔴 SU-endpoints: every call site uses a listed endpoint');
  assert.ok(ENDPOINTS.includes('setPromos'));
  // negative controls: the guard SEES a bypass (a literal URL, a computed key, an unlisted key)
  const inject = (line) => src.replace('return {\n      CONTEXT,', `async function bypass() { return ${line}; }\n    return {\n      CONTEXT,`);
  assert.notEqual(inject('x'), src, 'premise: the injection point exists');
  assert.ok(endpointViolations(inject("call('https://outside.test')"), ENDPOINTS).length > 0, 'control: a literal URL fails the guard');
  assert.ok(endpointViolations(inject("call(E['unlisted'])"), ENDPOINTS).length > 0, 'control: a computed key fails the guard');
  assert.ok(endpointViolations(inject('call(E.unlisted)'), ENDPOINTS).length > 0, 'control: an unlisted key fails the guard');
  assert.ok(endpointViolations(inject("call ('https://outside.test')"), ENDPOINTS).length > 0, '🔴 SU-endpoints control: the SPACED literal form fails the guard');
  assert.ok(endpointViolations(inject("call(E[ENDPOINTS[0]])"), ENDPOINTS).length > 0, 'control: a computed member fails the guard');
  assert.ok(endpointViolations(inject("(() => { const c = call; return c('https://outside.test'); })()"), ENDPOINTS).length > 0, '🔴 SU-endpoints control: an ALIASED call fails the guard');
  assert.ok(endpointViolations(inject("call.call(null, 'https://outside.test')"), ENDPOINTS).length > 0, 'control: call.call fails the guard');
  // runtime: every method, driven against a recording fetch, requests ONLY the listed endpoints
  const seen = [], EP = Object.fromEntries(ENDPOINTS.map((k) => [k, 'https://ep.test/' + k]));
  const a = createSignupApi({ endpoints: EP, fetch: async (u) => { seen.push(String(u).split('?')[0]); return { status: 200, json: async () => ({ ok: true }) }; } });
  await a.config(); await a.requestOtp({ phone: '+50496123344' }); await a.verifyOtp({ phone: '+50496123344', code: '123456' }); await a.googleStart({ sessionId: 's' });
  await a.googleSignIn({ sessionId: 's', idToken: 't' }); await a.completeProfile({ idToken: 't', email: 'a@b.test', name: 'A', promos: true }); await a.setPromos({ idToken: 't', value: true });
  await a.redeemSignupGrant({ grant: 'g', email: 'a@b.test', name: 'A', promos: false });
  await a.getMyOrders({ idToken: 't', limit: 20 });   // «Pedidos» (NOTE-getMyOrders): the member's history read
  await a.getMyRating({ idToken: 't', orderId: 'XPZ-1234' }); await a.rateOrder({ idToken: 't', orderId: 'XPZ-1234', fields: { store: 5 } });   // C-2
  assert.deepEqual([...new Set(seen)].sort(), Object.values(EP).sort(), '🔴 SU-endpoints: the requests are exactly the listed endpoints');
});
// ── C-2 (PLAN §C-2; 3a's getMyRating 1958b8ed + the S-A1 writer rateOrder): the member transport's two rating calls, against the REAL
// servers' bodies copied verbatim into fixtures/c2/rating-contract.json (rule 29 — never hand-made shapes) ──
const RC = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/c2/rating-contract.json'), 'utf8'));
const rateApi = (reply, seen = []) => createSignupApi({ endpoints: { getMyRating: 'https://ep.test/getMyRating', rateOrder: 'https://ep.test/rateOrder' },
  fetch: async (u, init) => { seen.push({ u: String(u), init }); const r = typeof reply === 'function' ? reply(u, init) : reply; return { status: r.status, json: async () => JSON.parse(JSON.stringify(r.body)) }; } });
test('C-2 getMyRating: every state the sheet renders maps field by field (3a\'s real bodies) — not fulfilled / unrated / rated / edited / past window / withdrawn / deleted / a v1 thumb', async () => {
  const G = RC.getMyRating, want = {
    not_fulfilled: { rating: null, canRate: false, editableUntil: null },
    unrated: { rating: null, canRate: true, editableUntil: 604801000 },
    rated: { rating: { store: 4, dishes: { 'x_pizza-dish-7': 1 }, delivery: -1, comment: 'Rica', legacyThumb: null, ratedAt: 2000, editedAt: null }, canRate: true, editableUntil: 604801000 },
    edited: { rating: { store: 4, dishes: { 'x_pizza-dish-7': 1 }, delivery: -1, comment: 'Riquísima', legacyThumb: null, ratedAt: 2000, editedAt: 3000 }, canRate: true, editableUntil: 604801000 },
    past_window: { rating: { store: 4, dishes: { 'x_pizza-dish-7': 1 }, delivery: -1, comment: 'Riquísima', legacyThumb: null, ratedAt: 2000, editedAt: 3000 }, canRate: false, editableUntil: 604801000 },
    withdrawn: { rating: null, canRate: true, editableUntil: 604801000 },
    deleted: { rating: null, canRate: false, editableUntil: null },
    v1_thumb: { rating: { store: null, dishes: {}, delivery: null, comment: null, legacyThumb: 1, ratedAt: 2000, editedAt: null }, canRate: false, editableUntil: null },
  };
  for (const [k, w] of Object.entries(want)) assert.deepEqual(await rateApi(G[k]).getMyRating({ idToken: 't', orderId: 'XPZ-1234' }), { ok: true, ...w }, `🔴 RT-1: ${k}`);
});
test('C-2 getMyRating: GET ?order_id ALONE (the endpoint refuses any other key), the token in its header, no body; 403 ⇒ not_allowed, 429 ⇒ rate_limited, 400 / a malformed 200 ⇒ failed — never a guess', async () => {
  const seen = []; await rateApi(RC.getMyRating.unrated, seen).getMyRating({ idToken: 'tok', orderId: 'XPZ-1234' });
  assert.equal(seen.length, 1); assert.equal(seen[0].u, 'https://ep.test/getMyRating?order_id=XPZ-1234', '🔴 RT-2: the exact query');
  assert.deepEqual(seen[0].init, { method: 'GET', headers: { 'x-firebase-id-token': 'tok' } }, '🔴 RT-2: the token in the header, no body');
  assert.deepEqual(await rateApi(RC.getMyRating.generic_403).getMyRating({ idToken: 't', orderId: 'XPZ-1234' }), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(await rateApi(RC.getMyRating.rate_limited).getMyRating({ idToken: 't', orderId: 'XPZ-1234' }), { ok: false, reason: 'rate_limited' });
  assert.deepEqual(await rateApi(RC.getMyRating.bad_request).getMyRating({ idToken: 't', orderId: 'XPZ-1234' }), { ok: false, reason: 'failed' });
  const r = RC.getMyRating.rated.body;
  for (const [why, body] of [['can_rate missing', { ...r, can_rate: undefined }], ['a store of 6', { ...r, rating: { ...r.rating, store: 6 } }], ['dishes as an array', { ...r, rating: { ...r.rating, dishes: [1] } }],
    ['a vote of 0', { ...r, rating: { ...r.rating, dishes: { a: 0 } } }], ['a 501-char comment', { ...r, rating: { ...r.rating, comment: 'x'.repeat(501) } }], ['a negative until', { ...r, editable_until: -5 }]])
    assert.deepEqual(await rateApi({ status: 200, body: body }).getMyRating({ idToken: 't', orderId: 'XPZ-1234' }), { ok: false, reason: 'failed' }, `🔴 RT-2: ${why} ⇒ failed, never a guess`);
  const none = []; const a = rateApi(RC.getMyRating.unrated, none);
  assert.equal((await a.getMyRating({ orderId: 'XPZ-1234' })).reason, 'unauthenticated'); assert.equal((await a.getMyRating({ idToken: 't', orderId: '../x' })).reason, 'bad_request');
  assert.equal(none.length, 0, 'nothing sent without a token or with a bad id');
});
test('C-2 rateOrder: POST { order_id, …fields } with the token; 3a\'s every answer mapped; a body the writer would refuse is refused HERE, never sent', async () => {
  const seen = []; const a = rateApi(RC.rateOrder.recorded, seen);
  assert.deepEqual(await a.rateOrder({ idToken: 'tok', orderId: 'XPZ-1234', fields: { store: 5, dishes: { 'x_pizza-dish-7': 1 }, comment: 'Rica' } }), { ok: true, dishesUnavailable: false });
  assert.equal(seen[0].u, 'https://ep.test/rateOrder'); assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.headers['x-firebase-id-token'], 'tok');
  assert.deepEqual(JSON.parse(seen[0].init.body), { order_id: 'XPZ-1234', store: 5, dishes: { 'x_pizza-dish-7': 1 }, comment: 'Rica' }, '🔴 RT-3: exactly the set fields');
  const R = RC.rateOrder, call = (k) => rateApi(R[k]).rateOrder({ idToken: 't', orderId: 'XPZ-1234', fields: { store: 4 } });
  assert.deepEqual(await call('dishes_unavailable'), { ok: true, dishesUnavailable: true });
  for (const k of ['window_closed', 'not_fulfilled', 'not_rated', 'dish_not_purchased']) assert.deepEqual(await call(k), { ok: false, reason: k }, `🔴 RT-3: ${k}`);
  assert.deepEqual(await call('generic_403'), { ok: false, reason: 'not_allowed' }); assert.equal((await call('unavailable')).ok, false);
  const none = []; const b = rateApi(R.recorded, none);
  for (const [why, f] of [['no field', {}], ['a store of 6', { store: 6 }], ['a 0.5 store', { store: 4.5 }], ['an unknown key', { stars: 5 }], ['a vote of 0', { dishes: { a: 0 } }], ['a 501-char comment', { comment: 'x'.repeat(501) }],
    ['a bad dish id', { dishes: { 'a/b': 1 } }], ['31 dishes', { dishes: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`d${i}`, 1])) }], ['a delivery of 2', { delivery: 2 }]])
    assert.deepEqual(await b.rateOrder({ idToken: 't', orderId: 'XPZ-1234', fields: f }), { ok: false, reason: 'bad_request' }, `🔴 RT-3: ${why} refused locally`);
  assert.equal(none.length, 0, '🔴 RT-3: no refusable body ever reaches the server');
});
