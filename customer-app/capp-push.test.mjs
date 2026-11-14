// Customer app — PUSH, the client core (PLAN-capp-push r1; owner 11-14: build now, «Pedidos» first). capp-push.js is pure: the plugin
// wrapper, the soft-ask state (never at first launch, never twice in a visit, 30 days after «Ahora no»), enable → permission → the FCM
// token → the server, forget at sign-out, taps → the order. Dark (a `push` runtime flag, native only); no UI here (mockup first).
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
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
const fakeApi = () => { const calls = []; return { calls, register: async (b) => { calls.push(['register', b]); return { ok: true, prefs: { pedidos: b.pedidos, promociones: b.promociones } }; }, unregister: async (b) => { calls.push(['unregister', b]); return { ok: true }; } }; };
const mk = (o = {}) => { const f = createFakePushPlugin(o.fake || {}); let t = o.t0 || 1_800_000_000_000; const store = o.store || memStore(), api = o.api === undefined ? fakeApi() : o.api;
  const push = P.createPush({ enabled: o.enabled !== false, plugin: o.plugin === undefined ? f.plugin : o.plugin, platform: o.platform || 'android', now: () => t, storage: store, api, appBuild: o.appBuild || '1.0.0+7' });
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
  assert.deepEqual(api.calls, [['register', { token: 'fcm_tok_test_0001', platform: 'android', app_build: '1.0.0+7', pedidos: true, promociones: false }]], '🔴 PUSH-ENABLE: the 6b contract body');
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

// ── PLAN-capp-push r1 §6b: the CLIENT against 3a's REAL callables (customer-push.js @ feat/capp-push-tokens-3a 4ab62975c (the per-channel consent), composed with
// its whole require closure by refLoader; 3a's own strict RTDB double; the promos consent by the REAL signup writer) ──
const { refLoader } = await import('./test/ref-require.mjs');
const { execFileSync } = await import('node:child_process');
const ROOT = join(HERE, '..');
const A3P = '4ab62975cbf0316919ce78d26bcac758c531d65b', R3 = refLoader(ROOT, A3P);
const CP = R3.require('xpizza-functions/customer-push.js'), SC = R3.require('xpizza-functions/signup-core.js'), { fakeRtdb } = R3.require('xpizza-functions/test/_fake-rtdb-sdk.js');
const Api = require('./capp-signup-api.js');
const UID = 'u_' + 'a'.repeat(24), IDT = `id-${UID}`;
function pushServer() {
  const db = fakeRtdb({ platform_config: { legal: { terms_url: 'https://sherpa.hn/t', privacy_url: 'https://sherpa.hn/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' } },
    user_profiles: { [UID]: { phone: '50499990000', phone_hash: 'ph_a', created_at: 1, last_login: 1 } } }, { strict: true });
  const auth = { verifyIdToken: async (t) => { if (t !== IDT) throw new Error('bad token'); return { uid: UID, customer: true }; } };
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
test('PUSH-API-PIN: 3a\'s customer-push.js is the pinned blob at 4ab62975c (feat/capp-push-tokens-3a, the per-channel consent), composed with its closure', () => {
  assert.equal(R3.blob('xpizza-functions/customer-push.js'), execFileSync('git', ['rev-parse', `${A3P}:xpizza-functions/customer-push.js`], { cwd: ROOT, encoding: 'utf8' }).trim());
  for (const n of ['registerCustomerPushToken', 'unregisterCustomerPushToken', 'setCustomerPushPrefs', 'getCustomerPushPrefs']) assert.ok(Api.ENDPOINTS.includes(n), `🔴 PUSH-API: ${n} is a client endpoint`);
});
test('PUSH-API: register → getPrefs → setPrefs → unregister against 3a\'s REAL handlers — the §6b shapes, ?context=platform, the token in a HEADER, the FCM token never in a URL', async () => {
  const { api, calls, db } = pushServer();
  const reg = await api.pushRegister({ idToken: IDT, token: 'fcm_tok_test_0001', platform: 'android', app_build: '1.0.0+7', pedidos: true, promociones: false });
  assert.deepEqual(reg, { ok: true, prefs: { pedidos: true, promociones: false } }, '🔴 PUSH-API: registered');
  const g = await api.pushGetPrefs({ idToken: IDT });
  assert.deepEqual(g.prefs, { pedidos: true, promociones: false }, 'the prefs as stored (once per person)');
  assert.ok(g.limits && Number.isSafeInteger(g.limits.quiet_from) && g.limits.quiet_from >= 0 && g.limits.quiet_from <= 1439, '🔴 PUSH-API: the server\'s limits (HN minutes)');
  assert.deepEqual(await api.pushSetPrefs({ idToken: IDT, pedidos: false, promociones: false }), { ok: true, prefs: { pedidos: false, promociones: false } });
  assert.deepEqual(await api.pushUnregister({ idToken: IDT, token: 'fcm_tok_test_0001' }), { ok: true });
  assert.equal(Object.keys(db.get(CP.TOKENS) || {}).length, 0, 'the token is gone server-side');
  for (const c of calls) {
    assert.equal(new URL(c.url).searchParams.get('context'), 'platform', `🔴 PUSH-API: ${c.name} ?context=platform`);
    assert.equal(c.headers['x-firebase-id-token'], IDT, `${c.name}: the ID token in its header`);
    assert.ok(!c.url.includes('fcm_tok') && !c.url.includes(IDT), `🔴 R20: ${c.name}'s URL carries no token`);
  }
});
// owner ruling 11-14 (advisor, Q4 + consent per channel): «Ofertas de Sherpa» ON calls setPrefs, and setPrefs RECORDS the push-offers
// consent itself (3a 4ab62975c: offers_consent { channel: 'push', copy_version }) — never the email / WhatsApp promos consent
test('PUSH-CONSENT (ruled 11-14; 3a 4ab62975c): «Ofertas de Sherpa» ON = setPrefs alone records the push-offers consent — never the email/WhatsApp one', async () => {
  const { api, db } = pushServer();
  await api.pushRegister({ idToken: IDT, token: 'fcm_tok_test_0001', platform: 'ios', app_build: '1', pedidos: true, promociones: false });
  const r = await api.pushSetPrefs({ idToken: IDT, pedidos: true, promociones: true });
  assert.deepEqual(r, { ok: true, prefs: { pedidos: true, promociones: true } }, '🔴 PUSH-CONSENT: the switch alone turns push offers on');
  const sc = db.get(`user_private/${UID}/consent/${SC.PLATFORM_SCOPE}/promos`);
  assert.ok(!sc || sc.value !== true, '🔴 PUSH-CONSENT: the email/WhatsApp promos consent is NEVER written by the push switch');
  const oc = (db.get(`${CP.PREFS}/${UID}`) || {}).offers_consent;
  assert.deepEqual(oc && [oc.channel, oc.value, oc.copy_version], ['push', true, CP.PUSH_OFFERS_COPY_VERSION], '🔴 PUSH-CONSENT: the server recorded the PUSH channel\'s consent, at the shown copy\'s version');
});
test('PUSH-API: no ID token ⇒ no call (never an unauthenticated request)', async () => {
  const { api, calls } = pushServer();
  assert.deepEqual(await api.pushRegister({ idToken: null, token: 'x', platform: 'ios', app_build: '1', pedidos: true, promociones: false }), { ok: false, reason: 'unauthenticated' });
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
    deniedTitle: 'Avisos apagados', deniedSub: 'Activalos en Ajustes del teléfono.', deniedAct: 'Abrir Ajustes', rowOrders: 'Mis pedidos activados', rowBoth: 'Mis pedidos · Ofertas de Sherpa' });
  assert.ok(!Object.values(P.COPY).some((v) => /WhatsApp/i.test(v)), 'owner Q3: no UI text says push replaces WhatsApp');
});
