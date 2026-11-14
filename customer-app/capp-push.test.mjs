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
  const push = P.createPush({ enabled: o.enabled !== false, plugin: o.plugin === undefined ? f.plugin : o.plugin, platform: o.platform || 'android', now: () => t, storage: store, api, appBuild: '1.0.0 (7)' });
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

test('PUSH-ENABLE: the system prompt only on enable → granted → register → the FCM token → the server body EXACTLY (Pedidos on, Promociones off)', async () => {
  const { push, f, api } = mk();
  const r = await push.enable();
  assert.equal(f.of('requestPermissions').length, 1, 'the system prompt, once');
  assert.equal(f.of('register').length, 1);
  assert.deepEqual(api.calls, [['register', { token: 'fcm_tok_test_0001', platform: 'android', app_build: '1.0.0 (7)', pedidos: true, promociones: false }]], '🔴 PUSH-ENABLE: the 6b contract body');
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
