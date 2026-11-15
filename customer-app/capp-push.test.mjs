// Customer app — PUSH, the client core (PLAN-capp-push r1; owner 11-14: build now, «Pedidos» first). capp-push.js is pure: the plugin
// wrapper, the soft-ask state (never at first launch, never twice in a visit, 30 days after «Ahora no»), enable → permission → the FCM
// token → the server, forget at sign-out, taps → the order. Dark (a `push` runtime flag, native only). Its UI markup (MOCKUP-capp-push
// r1, owner-approved 11-14) is pinned below against the mockup's own fragments; the shell's wiring is capp-s7a2's PUSH-SHELL cells.
// The plugin is a fake of @capacitor/push-notifications 8.1.1 EXACTLY as published (vendored definitions, pinned below).
// Run: node --test customer-app/capp-push.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFakePushPlugin, PUSH_EVENTS, PUSH_METHODS } from './test/fake-push-plugin.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const P = require('./capp-push.js');
const DAY = 864e5;
const INSTALL7 = 'BwcHBwcHBwcHBwcHBwcHBw';   // base64url of 16 bytes of 7 (mk's deterministic random)
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
const fakeApi = () => { const calls = []; return { calls, register: async (b) => { calls.push(['register', b]); return { ok: true, prefs: { pedidos: b.pedidos, promociones: b.promociones } }; }, unregister: async (b) => { calls.push(['unregister', b]); return { ok: true }; } }; };
const mk = (o = {}) => { const f = createFakePushPlugin(o.fake || {}); let t = o.t0 || 1_800_000_000_000; const store = o.store || memStore(), api = o.api === undefined ? fakeApi() : o.api;
  const push = P.createPush({ enabled: o.enabled !== false, plugin: o.plugin === undefined ? f.plugin : o.plugin, platform: o.platform || 'android', now: () => t, storage: store, api, appBuild: o.appBuild || '1.0.0+7', random: o.random || ((u) => u.fill(7)) });
  return { push, f, store, api, adv: (ms) => { t += ms; } }; };

test('PUSH-PIN: the fake is @capacitor/push-notifications 8.1.1 EXACTLY — the vendored definitions (sha-pinned), the same methods and events', () => {
  const dts = readFileSync(join(HERE, 'test/vendor/capacitor-push-notifications-8.1.1/definitions.d.ts'), 'utf8');
  assert.equal(createHash('sha256').update(dts).digest('hex'), '412de4d3b20140673aa8b8c1b6e096d7115f2f61876c67f5fcc494ef9777142e', '🔴 PUSH-PIN: the vendored definitions');
  const iface = dts.slice(dts.indexOf('export interface PushNotificationsPlugin'), dts.indexOf('\n}', dts.indexOf('export interface PushNotificationsPlugin')));
  const methods = [...new Set([...iface.matchAll(/^\s{4}([a-zA-Z]+)\(/gm)].map((m) => m[1]))].sort();
  const events = [...iface.matchAll(/addListener\(eventName: '([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...PUSH_METHODS].sort(), methods, '🔴 PUSH-PIN: the fake has exactly the plugin\'s methods');
  assert.deepEqual([...PUSH_EVENTS].sort(), events, '🔴 PUSH-PIN: the fake has exactly the plugin\'s events');
  assert.deepEqual(Object.keys(createFakePushPlugin().plugin).sort(), methods, 'and implements every one');
  assert.match(dts, /export type PermissionState|PermissionState/, 'premise');
  assert.match(readFileSync(join(HERE, 'test/vendor/capacitor-push-notifications-8.1.1/LICENSE'), 'utf8'), /MIT License/, 'the licence travels with it');
});

test('PUSH-DARK: off unless enabled, native (ios / android) and the plugin present — no plugin call at all when off', async () => {
  for (const [what, o] of [['flag off', { enabled: false }], ['web platform', { platform: 'web' }], ['no plugin', { plugin: null }]]) {
    const { push, f } = mk(o);
    assert.equal(push.available(), false, `🔴 PUSH-DARK: ${what}`);
    assert.equal(push.shouldOffer({ ordersPlaced: 3 }), false, `${what}: never offered`);
    assert.deepEqual(await push.enable(), { ok: false, reason: 'unavailable' }, `${what}: enable refuses`);
    assert.equal(f.calls.length, 0, `${what}: the plugin is never touched`);
  }
});

test('PUSH-ASK: never at first launch; once per visit; «Ahora no» snoozes 30 days; a decision (granted / denied) ends the asking', () => {
  const s = memStore();
  const a = mk({ store: s });
  assert.equal(a.push.shouldOffer({ ordersPlaced: 0 }), false, '🔴 PUSH-ASK: never before a first order');
  assert.equal(a.push.shouldOffer({ ordersPlaced: 1 }), true, 'after the first order');
  a.push.markOffered();
  assert.equal(a.push.shouldOffer({ ordersPlaced: 1 }), false, '🔴 PUSH-ASK: never twice in a visit');
  const b = mk({ store: s }); b.push.snooze();
  const c = mk({ store: s, t0: 1_800_000_000_000 + 29 * DAY });
  assert.equal(c.push.shouldOffer({ ordersPlaced: 2 }), false, '🔴 PUSH-ASK: «Ahora no» holds 30 days');
  const d = mk({ store: s, t0: 1_800_000_000_000 + 31 * DAY });
  assert.equal(d.push.shouldOffer({ ordersPlaced: 2 }), true, 'after 30 days, once more');
});
test('PUSH-RETURNS (owner Q2, 11-14): after «Ahora no» the card returns AT MOST TWICE, ≥ 30 days apart — a third «Ahora no» ends it; an OS denial ends it at once', async () => {
  const s = memStore(), T0 = 1_800_000_000_000;
  const at = (days) => mk({ store: s, t0: T0 + days * DAY });
  at(0).push.snooze();                                   // the first showing, «Ahora no»
  assert.equal(at(31).push.shouldOffer({ ordersPlaced: 2 }), true, 'return 1 (≥ 30 days)');
  at(31).push.snooze();
  assert.equal(at(50).push.shouldOffer({ ordersPlaced: 3 }), false, '🔴 PUSH-RETURNS: 30 days counted from the LAST «Ahora no»');
  assert.equal(at(62).push.shouldOffer({ ordersPlaced: 3 }), true, 'return 2');
  at(62).push.snooze();
  assert.equal(at(400).push.shouldOffer({ ordersPlaced: 9 }), false, '🔴 PUSH-RETURNS: never a third return');
  const d = mk({ fake: { onRequest: 'denied' } }); await d.push.enable();
  assert.equal(mk({ store: d.store, t0: T0 + 365 * DAY }).push.shouldOffer({ ordersPlaced: 9 }), false, '🔴 PUSH-RETURNS: never after an OS denial');
});

test('PUSH-ENABLE: the system prompt only on enable → granted → register → the FCM token → the server body EXACTLY (Pedidos on, Promociones off)', async () => {
  const { push, f, api } = mk();
  const r = await push.enable();
  assert.equal(f.of('requestPermissions').length, 1, 'the system prompt, once');
  assert.equal(f.of('register').length, 1);
  assert.deepEqual(api.calls, [['register', { token: 'fcm_tok_test_0001', platform: 'android', app_build: '1.0.0+7', install_id: INSTALL7, pedidos: true, promociones: false }]], '🔴 PUSH-ENABLE: the 6b contract body');
  const nb = mk({ appBuild: '1.0.0 (7)' }); await nb.push.enable();
  assert.equal(nb.api.calls[0][1].app_build, 'unknown', '🔴 PUSH-ENABLE: a build string the server would refuse is sent as "unknown" (3a vBuild)');
  assert.equal(r.ok, true);
  assert.deepEqual(push.state(), { state: 'granted', snoozed_at: null, registered: true });
  assert.equal(push.shouldOffer({ ordersPlaced: 5 }), false, 'decided ⇒ never asked again');
  assert.equal(f.listenerCount('registration') + f.listenerCount('registrationError'), 0, 'the one-shot listeners are removed');
  const g = mk({ fake: { permission: 'granted' } }); await g.push.enable();
  assert.equal(g.f.of('requestPermissions').length, 0, '🔴 PUSH-ENABLE: already granted ⇒ no prompt');
});

test('PUSH-DENIED: a denied permission is remembered (never asked again), nothing registered, nothing sent', async () => {
  const { push, f, api } = mk({ fake: { onRequest: 'denied' } });
  assert.deepEqual(await push.enable(), { ok: false, reason: 'denied' }, '🔴 PUSH-DENIED');
  assert.equal(f.of('register').length, 0); assert.equal(api.calls.length, 0);
  assert.equal(push.state().state, 'denied'); assert.equal(push.shouldOffer({ ordersPlaced: 9 }), false);
});

test('PUSH-REGERR: an OS registration error ⇒ no token, nothing sent (never a half registration)', async () => {
  const { push, api } = mk({ fake: { registrationError: 'APNs not configured' } });
  assert.deepEqual(await push.enable(), { ok: false, reason: 'registration_error' }, '🔴 PUSH-REGERR');
  assert.equal(api.calls.length, 0); assert.equal(push.state().registered, false);
});

test('PUSH-FORGET (rule 20): sign-out ⇒ the server forgets THIS token (the 6b body) and the device drops it', async () => {
  const { push, api, store } = mk();
  await push.enable(); api.calls.length = 0;
  await push.forget();
  assert.deepEqual(api.calls, [['unregister', { token: 'fcm_tok_test_0001' }]], '🔴 PUSH-FORGET: unregister exactly');
  assert.equal(push.state().registered, false, 'the device keeps no token');
  assert.ok(!String(store.getItem(P.KEY)).includes('fcm_tok_test_0001'), '🔴 PUSH-FORGET: no token left in storage');
  api.calls.length = 0; await push.forget();
  assert.equal(api.calls.length, 0, 'nothing to forget ⇒ no call');
});

test('PUSH-TAP: a tapped ORDER push opens that order; a malformed id or another payload does nothing', () => {
  const { push, f } = mk(); const got = [];
  push.onTap((x) => got.push(x));
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    f.tap({ order_id: 'XPZ261114-AB12' }); f.tap({ order_id: '../evil' }); f.tap({ campaign: 'c1' }); f.tap(null);
    assert.deepEqual(got, [{ kind: 'order', order_id: 'XPZ261114-AB12' }], '🔴 PUSH-TAP');
  });
});

// ── PLAN-capp-push r1 §6b: the CLIENT against 3a's REAL callables (customer-push.js @ feat/capp-push-tokens-3a 472177443 (approved: per-channel consent, install_id, the prefs rev CAS, register never consents), composed with
// its whole require closure by refLoader; 3a's own strict RTDB double; the promos consent by the REAL signup writer) ──
const { refLoader } = await import('./test/ref-require.mjs');
const { execFileSync } = await import('node:child_process');
const ROOT = join(HERE, '..');
const A3P = '4721774431f6c93dd51b7bf3d523e4ac791dc126', R3 = refLoader(ROOT, A3P);
const CP = R3.require('xpizza-functions/customer-push.js'), SC = R3.require('xpizza-functions/signup-core.js'), { fakeRtdb } = R3.require('xpizza-functions/test/_fake-rtdb-sdk.js');
const Api = require('./capp-signup-api.js');
const UID = 'u_' + 'a'.repeat(24), IDT = `id-${UID}`;
const UID2 = 'u_' + 'b'.repeat(24), IDT2 = `id-${UID2}`;
function pushServer({ policy } = {}) {
  const db = fakeRtdb({ platform_config: { legal: { terms_url: 'https://sherpa.hn/t', privacy_url: 'https://sherpa.hn/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' }, ...(policy ? { push: policy } : {}) },
    user_profiles: { [UID]: { phone: '50499990000', phone_hash: 'ph_a', created_at: 1, last_login: 1 }, [UID2]: { phone: '50499990001', phone_hash: 'ph_b', created_at: 1, last_login: 1 } } }, { strict: true });
  const auth = { verifyIdToken: async (t) => { const u = t === IDT ? UID : t === IDT2 ? UID2 : null; if (!u) throw new Error('bad token'); return { uid: u, customer: true }; } };
  const h = CP.makeCustomerPush({ getDatabase: () => db, getAuth: () => auth, now: () => 1_800_000_000_000, checkRateLimit: async () => ({ allowed: true }) });
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url), name = u.pathname.split('/').pop(), headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ name, url, method: init.method, headers, body: init.body ? JSON.parse(init.body) : undefined });
    const req = { method: init.method || 'GET', query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { code: 200, body: null, set() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    const e = console.error; console.error = () => {}; try { await h[name](req, res); } finally { console.error = e; }
    return { status: res.code, json: async () => res.body };
  };
  const api = Api.createSignupApi({ fetch, endpoints: Object.fromEntries(Api.ENDPOINTS.map((n) => [n, `https://fn.test/${n}`])) });
  return { db, api, calls };
}
test('PUSH-API-PIN: 3a\'s customer-push.js is the pinned blob at 472177443 (feat/capp-push-tokens-3a, APPROVED), composed with its closure', () => {
  assert.equal(R3.blob('xpizza-functions/customer-push.js'), execFileSync('git', ['rev-parse', `${A3P}:xpizza-functions/customer-push.js`], { cwd: ROOT, encoding: 'utf8' }).trim());
  for (const n of ['registerCustomerPushToken', 'unregisterCustomerPushToken', 'setCustomerPushPrefs', 'getCustomerPushPrefs']) assert.ok(Api.ENDPOINTS.includes(n), `🔴 PUSH-API: ${n} is a client endpoint`);
});
test('PUSH-API: register → getPrefs → setPrefs → unregister against 3a\'s REAL handlers — the §6b shapes, ?context=platform, the token in a HEADER, the FCM token never in a URL', async () => {
  const { api, calls, db } = pushServer();
  const reg = await api.pushRegister({ idToken: IDT, token: 'fcm_tok_test_0001', platform: 'android', app_build: '1.0.0+7', install_id: INSTALL7, pedidos: true, promociones: false });
  assert.deepEqual(reg, { ok: true, prefs: { pedidos: true, promociones: false, rev: 1 } }, '🔴 PUSH-API: registered (prefs initialized, rev 1)');
  const g = await api.pushGetPrefs({ idToken: IDT });
  assert.deepEqual(g.prefs, { pedidos: true, promociones: false, rev: 1 }, 'the prefs as stored (once per person)');
  assert.ok(g.limits && Number.isSafeInteger(g.limits.quiet_from) && g.limits.quiet_from >= 0 && g.limits.quiet_from <= 1439, '🔴 PUSH-API: the server\'s limits (HN minutes)');
  assert.deepEqual(await api.pushSetPrefs({ idToken: IDT, pedidos: false, promociones: false, expected_rev: 1 }), { ok: true, prefs: { pedidos: false, promociones: false, rev: 2 } });
  assert.deepEqual(await api.pushUnregister({ idToken: IDT, token: 'fcm_tok_test_0001' }), { ok: true });
  assert.equal(Object.keys(db.get(CP.TOKENS) || {}).length, 0, 'the token is gone server-side');
  for (const c of calls) {
    assert.equal(new URL(c.url).searchParams.get('context'), 'platform', `🔴 PUSH-API: ${c.name} ?context=platform`);
    assert.equal(c.headers['x-firebase-id-token'], IDT, `${c.name}: the ID token in its header`);
    assert.ok(!c.url.includes('fcm_tok') && !c.url.includes(IDT), `🔴 R20: ${c.name}'s URL carries no token`);
  }
});
// owner ruling 11-14 (advisor, Q4 + consent per channel): «Ofertas de Sherpa» ON calls setPrefs, and setPrefs RECORDS the push-offers
// consent itself (3a e73a605a2: offers_consent { channel: 'push', copy_version }) — never the email / WhatsApp promos consent
test('PUSH-CONSENT (ruled 11-14; 3a e73a605a2): «Ofertas de Sherpa» ON = setPrefs alone records the push-offers consent — never the email/WhatsApp one', async () => {
  const { api, db } = pushServer();
  await api.pushRegister({ idToken: IDT, token: 'fcm_tok_test_0001', platform: 'ios', app_build: '1', install_id: INSTALL7, pedidos: true, promociones: false });
  const r = await api.pushSetPrefs({ idToken: IDT, pedidos: true, promociones: true, expected_rev: 1 });
  assert.deepEqual(r, { ok: true, prefs: { pedidos: true, promociones: true, rev: 2 } }, '🔴 PUSH-CONSENT: the switch alone turns push offers on');
  const sc = db.get(`user_private/${UID}/consent/${SC.PLATFORM_SCOPE}/promos`);
  assert.ok(!sc || sc.value !== true, '🔴 PUSH-CONSENT: the email/WhatsApp promos consent is NEVER written by the push switch');
  const oc = (db.get(`${CP.PREFS}/${UID}`) || {}).offers_consent;
  assert.deepEqual(oc && [oc.channel, oc.value, oc.copy_version], ['push', true, CP.PUSH_OFFERS_COPY_VERSION], '🔴 PUSH-CONSENT: the server recorded the PUSH channel\'s consent, at the shown copy\'s version');
});
test('PUSH-API-REV (3a e73a605a2): a register never rewrites prefs; a stale expected_rev ⇒ stale_prefs WITH the current prefs; another installation\'s replay ⇒ token_in_use; an unreadable policy ⇒ unavailable', async () => {
  const { api, calls } = pushServer();
  const REG = (o) => api.pushRegister({ idToken: IDT, token: 'fcm_tok_test_0001', platform: 'android', app_build: '1', install_id: INSTALL7, pedidos: true, promociones: false, ...o });
  const first = await REG({ promociones: true });
  assert.deepEqual(first.prefs, { pedidos: true, promociones: false, rev: 1 }, '🔴 PUSH-API-REV: a register NEVER consents (3a 472177443) — offers start off whatever the body says');
  await api.pushSetPrefs({ idToken: IDT, pedidos: false, promociones: true, expected_rev: 1 });
  assert.deepEqual(await REG({ pedidos: true, promociones: false }), { ok: true, prefs: { pedidos: false, promociones: true, rev: 2 } }, '🔴 PUSH-API-REV: a refresh never re-consents / rewrites');
  assert.deepEqual(await api.pushSetPrefs({ idToken: IDT, pedidos: true, promociones: true, expected_rev: 1 }), { ok: false, reason: 'stale_prefs', prefs: { pedidos: false, promociones: true, rev: 2 } }, '🔴 PUSH-API-REV: stale ⇒ the current prefs back');
  const sent0 = calls.length;
  assert.deepEqual(await api.pushSetPrefs({ idToken: IDT, pedidos: true, promociones: true }), { ok: false, reason: 'bad_request' }, 'no expected_rev ⇒ bad_request');
  assert.equal(calls.length, sent0, '🔴 PUSH-API-REV: no expected_rev ⇒ never sent');
  assert.deepEqual(await api.pushRegister({ idToken: IDT2, token: 'fcm_tok_test_0001', platform: 'android', app_build: '1', install_id: 'another-install-0001', pedidos: true, promociones: false }), { ok: false, reason: 'token_in_use' }, '🔴 PUSH-API-REV: another installation ⇒ token_in_use');
  assert.equal((await api.pushRegister({ idToken: IDT2, token: 'fcm_tok_test_0001', platform: 'android', app_build: '1', install_id: INSTALL7, pedidos: true, promociones: false })).ok, true, 'the SAME installation (a uid switch) moves it');
  const sent = calls.length;   // 3a ALSO answers bad_request to it: the reply alone cannot tell the client's refusal from the server's
  assert.deepEqual(await REG({ install_id: 'short' }), { ok: false, reason: 'bad_request' }, 'a malformed install_id ⇒ bad_request');
  assert.equal(calls.length, sent, '🔴 PUSH-API-REV: a malformed install_id is never sent');
  const bad = pushServer({ policy: { v: 1, promo_daily_max: -5, promo_weekly_max: 1, quiet_from: 0, quiet_to: 0 } });
  assert.deepEqual(await bad.api.pushGetPrefs({ idToken: IDT }), { ok: false, reason: 'unavailable' }, '🔴 PUSH-API-REV: an unreadable policy ⇒ unavailable (503)');
});
test('PUSH-INSTALL: ONE install_id per installation — made once, kept across sign-outs and re-enables, 3a\'s shape; the real random source', async () => {
  const { push, api } = mk({ random: ((n) => (u) => u.fill(n++))(7) });   // a NEW value at every draw: only a kept id repeats
  await push.enable(); await push.forget(); await push.enable();
  const ids = api.calls.filter((c) => c[0] === 'register').map((c) => c[1].install_id);
  assert.deepEqual(ids, [INSTALL7, INSTALL7], '🔴 PUSH-INSTALL: stable across a sign-out');
  const f = createFakePushPlugin(), a2 = fakeApi(), p2 = P.createPush({ enabled: true, plugin: f.plugin, platform: 'ios', now: () => 1, storage: memStore(), api: a2, appBuild: '1' });
  await p2.enable(); assert.match(a2.calls[0][1].install_id, /^[A-Za-z0-9_-]{16,64}$/, '🔴 PUSH-INSTALL: crypto-random, 3a vInstall');
  assert.notEqual(a2.calls[0][1].install_id, INSTALL7);
});
test('PUSH-API: no ID token ⇒ no call (never an unauthenticated request)', async () => {
  const { api, calls } = pushServer();
  assert.deepEqual(await api.pushRegister({ idToken: null, token: 'x', platform: 'ios', app_build: '1', install_id: INSTALL7, pedidos: true, promociones: false }), { ok: false, reason: 'unauthenticated' });
  assert.equal(calls.length, 0);
});
test('PUSH-COPY-VERSION: the «Ofertas de Sherpa» sub-line IS the push-offers consent text — tied to 3a\'s PUSH_OFFERS_COPY_VERSION (change one ⇒ bump the other)', () => {
  const CONSENT_TEXT = { 'push-offers-1': 'Promociones de los restaurantes' };   // every version 3a has shipped → the exact text it consented to
  assert.equal(CONSENT_TEXT[CP.PUSH_OFFERS_COPY_VERSION], P.COPY.offersSub, '🔴 PUSH-COPY-VERSION: the shown consent text = the version the server records');
});
// THE SHIP GATE (the portal pattern): every push string is owner-approved (MOCKUP-capp-push r1, 11-14), pinned EXACTLY
test('SHIP GATE (push): no push string ships unapproved — the owner-approved copy, pinned', () => {
  assert.deepEqual([...P.COPY_PENDING], [], '🔴 placeholders still pending owner approval');
  assert.deepEqual({ ...P.COPY }, { askTitle: '¿Te avisamos cómo va tu pedido?', askOn: 'Activar avisos', askLater: 'Ahora no', toastOn: 'Avisos activados', orderLinePush: 'Te avisamos con una notificación',
    screenTitle: 'Notificaciones', ordersTitle: 'Mis pedidos', ordersSub: 'Cuando cambie el estado', offersTitle: 'Ofertas de Sherpa', offersSub: 'Promociones de los restaurantes',
    deniedTitle: 'Avisos apagados', deniedSub: 'Activalos en Ajustes del teléfono.', deniedAct: 'Abrir Ajustes',
    rowNone: 'Estado del pedido por WhatsApp', rowOrders: 'Mis pedidos activados', rowBoth: 'Mis pedidos · Ofertas de Sherpa', rowDenied: 'Apagadas en tu teléfono' });
  // rowNone is v6's own subtitle for the state BEFORE push (frame 4's annotation) — it names today's channel, it says nothing replaces it
  assert.ok(!Object.entries(P.COPY).some(([k, v]) => k !== 'rowNone' && /WhatsApp/i.test(v)), 'owner Q3: no UI text says push replaces WhatsApp');
});

// ── stage 2 (MOCKUP-capp-push r1): the core's new edges + the UI markup EXACTLY as the approved mockup draws it ──
test('PUSH-SERVER-ACK: a token the server did not take is never «registered» (the UI never claims «activados»); the next enable retries', async () => {
  const calls = [];
  const api = { register: async (b) => { calls.push(b); return calls.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, prefs: { pedidos: true, promociones: false } }; }, unregister: async () => ({ ok: true }) };
  const { push, f } = mk({ api });
  assert.equal((await push.enable()).ok, false);
  assert.deepEqual(push.state(), { state: 'granted', snoozed_at: null, registered: false }, '🔴 PUSH-ACK: refused ⇒ not registered');
  assert.equal((await push.enable()).ok, true); assert.equal(f.of('requestPermissions').length, 1, 'granted already ⇒ no second prompt');
  assert.equal(push.state().registered, true, '🔴 PUSH-ACK: taken ⇒ registered');
  const n = mk({ api: null }); await n.push.enable(); assert.equal(n.push.state().registered, true, 'no server in play ⇒ the device token alone');
});
test('PUSH-FORGET-2 (rule 20 + consent per person): sign-out also deletes the token ON THE PHONE (after the server call) and ends this device\'s opt-in; an OS denial stays', async () => {
  const { push, f, api } = mk();
  await push.enable(); api.calls.length = 0;
  const seq = []; const un = f.plugin.unregister; f.plugin.unregister = async () => { seq.push('plugin'); return un(); }; const ar = api.unregister; api.unregister = async (b) => { seq.push('server'); return ar(b); };
  await push.forget();
  assert.deepEqual(seq, ['server', 'plugin'], '🔴 PUSH-FORGET-2: the server forgets it, then the phone deletes it');
  assert.equal(push.state().state, 'never', '🔴 PUSH-FORGET-2: the next member opts in for themselves');
  seq.length = 0; await push.forget(); assert.deepEqual(seq, [], 'nothing held ⇒ nothing called');
  const d = mk({ fake: { onRequest: 'denied' } }); await d.push.enable(); await d.push.forget();
  assert.equal(d.push.state().state, 'denied', '🔴 PUSH-FORGET-2: the phone\'s denial is the phone\'s');
  const off = mk({ enabled: false }); await off.push.forget(); assert.equal(off.f.calls.length, 0, 'dark ⇒ no plugin call');
});
test('PUSH-PERMISSION: the OS permission re-read (Ajustes) — denied ⇒ remembered and the token dropped; allowed again ⇒ the denial cleared', async () => {
  const { push, f } = mk({ fake: { permission: 'granted' } });
  await push.enable(); assert.equal(push.state().registered, true, 'premise');
  f.setPermission('denied'); assert.equal(await push.permission(), 'denied');
  assert.deepEqual(push.state(), { state: 'denied', snoozed_at: null, registered: false }, '🔴 PUSH-PERMISSION: turned off in Ajustes ⇒ denied');
  f.setPermission('granted'); assert.equal(await push.permission(), 'granted');
  assert.equal(push.state().state, 'never', '🔴 PUSH-PERMISSION: allowed again ⇒ the switches come back (a fresh opt-in)');
  assert.equal(await mk({ enabled: false }).push.permission(), null, 'dark ⇒ null, no call');
});
// the approved mockup's own markup (MOCKUP-capp-push r1, extracted verbatim): frame 1 (the card), F2a / F2b (the screen), F2c (denied),
// F4a / F4b (the Cuenta row). The app adds only its data-act hooks; the row's chevron is the app's own IC.chev (its sibling rows' icon)
const MOCK = {"ask": "<div class=\"px-ask\" role=\"group\" aria-label=\"Avisos de tu pedido\"><div class=\"hd\"><span class=\"ic\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/></svg></span><div class=\"t\"><b>¿Te avisamos cómo va tu pedido?</b></div></div><div class=\"acts\"><button class=\"primary\">Activar avisos</button><button class=\"btn2\">Ahora no</button></div></div>", "f2a": "<div class=\"topbar\"><button class=\"iconbtn\" data-act=\"back\" aria-label=\"Volver\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M19 12H5\"></path><path d=\"M11 18l-6-6 6-6\"></path></svg></button><h1>Notificaciones</h1><span class=\"sp\"></span></div><div class=\"scroller\"><div class=\"rows\"><div class=\"rowbtn\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/></svg><span class=\"t\">Mis pedidos<span>Cuando cambie el estado</span></span><button class=\"switch\" role=\"switch\" aria-checked=\"true\" aria-label=\"Mis pedidos\"></button></div><div class=\"rowbtn\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12V4h8l9 9-8 8z\"/><circle cx=\"7.5\" cy=\"8.5\" r=\"1.3\"/></svg><span class=\"t\">Ofertas de Sherpa<span>Promociones de los restaurantes</span></span><button class=\"switch\" role=\"switch\" aria-checked=\"false\" aria-label=\"Ofertas de Sherpa\"></button></div></div></div>", "f2b": "<div class=\"topbar\"><button class=\"iconbtn\" data-act=\"back\" aria-label=\"Volver\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M19 12H5\"></path><path d=\"M11 18l-6-6 6-6\"></path></svg></button><h1>Notificaciones</h1><span class=\"sp\"></span></div><div class=\"scroller\"><div class=\"rows\"><div class=\"rowbtn\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/></svg><span class=\"t\">Mis pedidos<span>Cuando cambie el estado</span></span><button class=\"switch\" role=\"switch\" aria-checked=\"true\" aria-label=\"Mis pedidos\"></button></div><div class=\"rowbtn\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12V4h8l9 9-8 8z\"/><circle cx=\"7.5\" cy=\"8.5\" r=\"1.3\"/></svg><span class=\"t\">Ofertas de Sherpa<span>Promociones de los restaurantes</span></span><button class=\"switch\" role=\"switch\" aria-checked=\"true\" aria-label=\"Ofertas de Sherpa\"></button></div></div></div>", "f2c": "<div class=\"topbar\"><button class=\"iconbtn\" data-act=\"back\" aria-label=\"Volver\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M19 12H5\"></path><path d=\"M11 18l-6-6 6-6\"></path></svg></button><h1>Notificaciones</h1><span class=\"sp\"></span></div><div class=\"scroller\"><div class=\"px-quiet\"><span class=\"ic\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M8.6 6.4A6 6 0 0 1 18 11v5l1.5 2H9\"/><path d=\"M6 11v5l-1.5 2H5\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/><path d=\"M4 4l16 16\"/></svg></span><div class=\"t\"><b>Avisos apagados</b><span>Activalos en Ajustes del teléfono.</span><button class=\"lnk\">Abrir Ajustes</button></div></div><div class=\"rows\"><div class=\"rowbtn\" aria-disabled=\"true\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"/><path d=\"M10 20a2 2 0 0 0 4 0\"/></svg><span class=\"t\">Mis pedidos<span>Cuando cambie el estado</span></span><span class=\"switch\" role=\"switch\" aria-checked=\"false\" aria-disabled=\"true\"></span></div><div class=\"rowbtn\" aria-disabled=\"true\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 12V4h8l9 9-8 8z\"/><circle cx=\"7.5\" cy=\"8.5\" r=\"1.3\"/></svg><span class=\"t\">Ofertas de Sherpa<span>Promociones de los restaurantes</span></span><span class=\"switch\" role=\"switch\" aria-checked=\"false\" aria-disabled=\"true\"></span></div></div></div>", "f4a": "<button class=\"rowbtn\" data-act=\"sub-notifs\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"></path><path d=\"M10 20a2 2 0 0 0 4 0\"></path></svg><span class=\"t\">Notificaciones<span>Mis pedidos activados</span></span><svg class=\"i chev\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M9 6l6 6-6 6\"></path></svg></button>", "f4b": "<button class=\"rowbtn\" data-act=\"sub-notifs\"><svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z\"></path><path d=\"M10 20a2 2 0 0 0 4 0\"></path></svg><span class=\"t\">Notificaciones<span>Mis pedidos · Ofertas de Sherpa</span></span><svg class=\"i chev\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M9 6l6 6-6 6\"></path></svg></button>"};
const norm = (h) => h.replace(/ data-(act|k)="[^"]*"/g, '').replace(/><\/path>/g, '/>').replace(/class="i chev"/g, 'class="i"');
test('PUSH-UI-MOCKUP: the soft card, the «Notificaciones» screen (on / off / both) and the denied card are the mockup\'s markup EXACTLY', () => {
  assert.equal(norm(P.askHtml()), norm(MOCK.ask), '🔴 PUSH-UI: frame 1 — card A, no sub-line (owner Q1)');
  assert.equal(norm(P.screenHtml({ pedidos: true, promociones: false })), norm(MOCK.f2a), '🔴 PUSH-UI: F2a — pedidos on, ofertas off');
  assert.equal(norm(P.screenHtml({ pedidos: true, promociones: true })), norm(MOCK.f2b), '🔴 PUSH-UI: F2b — both on');
  assert.equal(norm(P.screenHtml({ denied: true, pedidos: true, promociones: true })), norm(MOCK.f2c), '🔴 PUSH-UI: F2c — denied: the quiet card, both off + inert');
  assert.match(P.askHtml(), /data-act="push-on">Activar avisos<.*data-act="push-later">Ahora no</, 'the shell\'s hooks');
  assert.match(P.screenHtml({ denied: true }), /<button class="lnk" data-act="push-settings">Abrir Ajustes<\/button>/, '🔴 PUSH-UI: «Abrir Ajustes» is the host\'s settings hook');
  assert.ok(!/data-act="push-pref"/.test(P.screenHtml({ denied: true })), '🔴 PUSH-UI: denied ⇒ no live switch');
  assert.equal((P.screenHtml({ pedidos: false, promociones: false, busy: true }).match(/aria-disabled="true"/g) || []).length, 2, 'a save in flight ⇒ both switches wait');
});
test('PUSH-ROW: the Cuenta row\'s subtitle — before push (v6), pedidos, both, offers alone, OS denied (frame 4 annotations)', () => {
  assert.equal(P.rowSub({}), 'Estado del pedido por WhatsApp');
  assert.equal(P.rowSub({ granted: true, pedidos: true }), 'Mis pedidos activados', '🔴 PUSH-ROW: F4a');
  assert.equal(P.rowSub({ granted: true, pedidos: true, promociones: true }), 'Mis pedidos · Ofertas de Sherpa', '🔴 PUSH-ROW: F4b');
  assert.equal(P.rowSub({ denied: true, granted: true, pedidos: true }), 'Apagadas en tu teléfono', '🔴 PUSH-ROW: denied wins');
  assert.equal(P.rowSub({ granted: true, pedidos: false, promociones: true }), 'Ofertas de Sherpa', '🔴 PUSH-ROW: offers alone (advisor 11-14: no WhatsApp talk)');
});
