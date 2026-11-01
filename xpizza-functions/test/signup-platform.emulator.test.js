'use strict';
// PLAN-guest-checkout-server r4 §3 — S3 through the REAL exported handlers (index.js requestOtp / verifyOtp with context:'platform',
// redeemSignupGrant, getMyProfile, completeProfile, getSignupConfig) on the RTDB + Firestore emulators.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:signup-platform
//   P  platform OTP: scope in the issuing transaction, the platform sender + SIGNUP template (provider stubbed — never the network),
//      verify → token + completion + profile; reasons; NO welcome credit; a forms code never verifies on the app and vice versa
//   F  forms differential: requestOtp / verifyOtp WITHOUT context answer exactly as before (keys {ok, token, is_new, name}; the
//      x_pizza welcome credit still lands) — the existing signup-http suite is the full forms differential and re-runs in the slot
//   G  redeemSignupGrant from a grant issued by S2's REAL issuer over a stored capp-guest order: one uid, consent/_platform,
//      apply once; 2 concurrent redemptions ⇒ one uid, both mint; refusals
//   M  getMyProfile: own data only (cross-user, deleted, non-customer); promos omitted / present
//   S  setPromos(platform) (Codex capp batch r1 #4): the member's own uid, exactly one selector, consent/_platform/promos read back
//      by getMyProfile, → {ok, value} (the stored value); tombstones write nothing; the forms' {ok:true} unchanged
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');
process.env.SIGNUP_GRANT_SECRET = 's'.repeat(40);
Object.assign(process.env, { ULTRAMSG_INSTANCE_ID_PLATFORM: 'plat-inst', ULTRAMSG_TOKEN_PLATFORM: 'plat-tok', SIGNUP_OTP_TEMPLATE_PLATFORM: 'Sherpa: {code}' });
// the platform provider is STUBBED at the fetch boundary (never the network); every other fetch is untouched
const SENT = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.ultramsg.com/plat-inst/')) { SENT.push(new URLSearchParams(init.body).get('body')); return { ok: true, json: async () => ({ sent: 'true', id: 1 }) }; }
  return realFetch(url, init);
};
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
const BRAND_SENT = [];
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false,
  sendMessage: async (phone, text) => { BRAND_SENT.push(String(text)); return { ok: true }; } } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({
  createCustomToken: async (uid, claims) => `tok:${uid}:${JSON.stringify(claims)}`,
  verifyIdToken: async (t) => { const [k, uid] = String(t).split(':'); if (k === 'cust') return { uid, customer: true }; if (k === 'staff') return { uid }; throw new Error('bad'); } }) } };

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const OTP = require('../otp-lib');
const GATE = require('../checkout-guest-gate');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('signup-platform(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
function call(handler, { method = 'POST', body, query = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await realFetch(`http://127.0.0.1:${s.address().port}/${query}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t, cache: r.headers.get('cache-control') }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const LEGAL = { terms_url: 'https://sherpa.test/t', privacy_url: 'https://sherpa.test/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' };
const reset = async () => { await rtdb.ref('otp_ip').remove(); await rtdb.ref('rate_limits').remove(); };

(async () => {
  await rtdb.ref('platform_config/legal').set(LEGAL);
  await rtdb.ref('signup_config/rollout_at').set(1);

  // ═══ P — the platform OTP pair ═══
  {
    const phone = '+50499770001', h = OTP.phoneHash(phone);
    await reset();
    let r = await call(app.requestOtp, { body: { phone, context: 'platform' } });
    assert.deepStrictEqual([r.status, r.json], [200, { ok: true, cooldown: 30 }]);
    assert.strictEqual((await rtdb.ref(`otp/${h}/scope`).get()).val(), '_platform');
    assert.match(SENT[SENT.length - 1], /^Sherpa: \d{6}$/, 'the PLATFORM sender + SIGNUP template');
    assert.strictEqual(BRAND_SENT.length, 0, 'never a brand sender');
    const code = SENT[SENT.length - 1].match(/\d{6}/)[0];
    r = await call(app.verifyOtp, { body: { phone, code: code === '000000' ? '111111' : '000000', context: 'platform' } });
    assert.deepStrictEqual(r.json, { ok: false, reason: 'code_wrong' });
    r = await call(app.verifyOtp, { body: { phone, code, context: 'platform' } });
    assert.strictEqual(r.json.ok, true); assert.strictEqual(r.json.is_new, true);
    assert.strictEqual(r.json.completion, 'needed'); assert.deepStrictEqual(r.json.profile, { name: null, email: null });
    const uid = (await rtdb.ref(`phone_index/${h}`).get()).val();
    assert.strictEqual(r.json.token, `tok:${uid}:{"customer":true}`);
    assert.strictEqual((await rtdb.ref('reward_welcome').get()).val(), null, '🔴 NO signup-time welcome credit for the platform');
    for (const b of [{ phone, context: 'platform', restaurant_id: 'x_pizza' }, { phone, context: 'app' }]) assert.strictEqual((await call(app.requestOtp, { body: b })).status, 400);
    // a FORMS code never verifies on the app; a platform code never on the forms
    await reset();
    await call(app.requestOtp, { body: { phone: '+50499770002', restaurant_id: 'x_pizza' } });
    const formsCode = BRAND_SENT[BRAND_SENT.length - 1].match(/\d{6}/)[0];
    assert.deepStrictEqual((await call(app.verifyOtp, { body: { phone: '+50499770002', code: formsCode, context: 'platform' } })).json, { ok: false, reason: 'code_wrong' });
    await reset(); await rtdb.ref(`otp/${OTP.phoneHash('+50499770003')}`).remove();
    await call(app.requestOtp, { body: { phone: '+50499770003', context: 'platform' } });
    const platCode = SENT[SENT.length - 1].match(/\d{6}/)[0];
    assert.deepStrictEqual((await call(app.verifyOtp, { body: { phone: '+50499770003', code: platCode } })).json, { ok: false }, '🔴 the forms\' verify refuses a platform challenge (generic, as today)');
  }
  ok('P platform OTP through the REAL exports: scope in the issuing txn, the platform sender + SIGNUP template, reasons, completion + profile, NO welcome credit; forms ⇄ platform codes never cross; bad scopes ⇒ 400');

  // ═══ F — forms differential: no context ⇒ today's exact answer ═══
  {
    const phone = '+50499770010';
    await reset();
    const rq = await call(app.requestOtp, { body: { phone, restaurant_id: 'x_pizza' } });
    assert.deepStrictEqual([rq.status, rq.json], [200, { ok: true, cooldown: 30 }]);
    assert.strictEqual((await rtdb.ref(`otp/${OTP.phoneHash(phone)}/scope`).get()).val(), null, 'no scope on a forms challenge');
    const code = BRAND_SENT[BRAND_SENT.length - 1].match(/\d{6}/)[0];
    const r = await call(app.verifyOtp, { body: { phone, code } });
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['is_new', 'name', 'ok', 'token'], '🔴 the forms\' verify answer is byte-shaped as before (no completion / profile / reason)');
    assert.ok((await rtdb.ref(`reward_welcome/${OTP.phoneHash(phone)}/x_pizza`).get()).exists(), 'the forms\' welcome credit still lands');
  }
  ok('F forms differential: requestOtp / verifyOtp without context answer exactly as before (no scope, the same keys, the welcome credit)');

  // ═══ G — redeemSignupGrant from S2's REAL grant issuer ═══
  {
    const phoneDigits = '50499770020', h = OTP.phoneHash(phoneDigits);
    const guest = { phone: phoneDigits, phone_hash: h };
    const created = Date.now();
    await rtdb.ref('orders/G-1').set({ status: 'pending_payment', created_at: created, guest_verified: guest });
    const g = await GATE.grantFor({ db: rtdb, orderId: 'G-1', guest, secret: process.env.SIGNUP_GRANT_SECRET, now: Date.now() });
    assert.ok(g.grant, 'premise: the real issuer granted');
    const body = { grant: g.grant.token, context: 'platform', email: 'g@example.com', name: 'Gabi', accept_terms: true, promos: false };
    await reset();
    const [a, b] = await Promise.all([call(app.redeemSignupGrant, { body }), call(app.redeemSignupGrant, { body })]);
    assert.ok(a.status === 200 && b.status === 200, `both concurrent redemptions mint (${a.text} / ${b.text})`);
    const uid = (await rtdb.ref(`phone_index/${h}`).get()).val();
    assert.ok(a.json.token.startsWith(`tok:${uid}:`) && b.json.token.startsWith(`tok:${uid}:`), '🔴 ONE uid for both');
    assert.strictEqual((await rtdb.ref(`user_private/${uid}/consent/_platform/terms/version`).get()).val(), 't1');
    assert.strictEqual((await rtdb.ref('grants_used/G-1/applied').get()).val(), true);
    await rtdb.ref(`user_private/${uid}/email`).set('later@example.com');
    await reset();
    const r = await call(app.redeemSignupGrant, { body: { ...body, email: 'other@example.com' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await rtdb.ref(`user_private/${uid}/email`).get()).val(), 'later@example.com', 'apply ONCE: a later member edit survives a replay');
    await reset();
    assert.deepStrictEqual((await call(app.redeemSignupGrant, { body: { ...body, grant: 'sg.x.y' } })).json, { ok: false, reason: 'grant_invalid' });
  }
  ok('G redeemSignupGrant through the REAL export from a REAL S2 grant: 2 concurrent redemptions ⇒ one uid, both mint; consent/_platform; apply once; a forged grant ⇒ grant_invalid');

  // ═══ M — getMyProfile: own data only ═══
  {
    const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
    await rtdb.ref(`user_profiles/${A}`).set({ phone: '50499770030', phone_hash: 'x', created_at: 5, name: 'Ana' });
    await rtdb.ref(`user_private/${A}`).set({ email: 'a@x.hn', consent: { _platform: { terms: { version: 't1' }, promos: { value: true } } } });
    await rtdb.ref(`user_profiles/${B}`).set({ phone: '50499770031', created_at: 5, name: 'Beto' });
    await reset();
    let r = await call(app.getMyProfile, { method: 'GET', query: '?context=platform', headers: { 'x-firebase-id-token': `cust:${A}` } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.name, 'Ana'); assert.strictEqual(r.json.promos, true); assert.strictEqual(r.cache, 'no-store');
    r = await call(app.getMyProfile, { method: 'GET', query: `?context=platform&uid=${B}`, headers: { 'x-firebase-id-token': `cust:${A}` } });
    assert.strictEqual(r.status, 400, '🔴 another user\'s identifier ⇒ 400, never their data');
    r = await call(app.getMyProfile, { method: 'GET', query: '?context=platform', headers: { 'x-firebase-id-token': `staff:${A}` } });
    assert.strictEqual(r.status, 401);
    r = await call(app.getMyProfile, { method: 'GET', query: '?context=platform', headers: { 'x-firebase-id-token': `cust:${B}` } });
    assert.ok(!('promos' in r.json), 'promos omitted when unset');
    await rtdb.ref(`deleted_uids/${B}`).set(1);
    assert.strictEqual((await call(app.getMyProfile, { method: 'GET', query: '?context=platform', headers: { 'x-firebase-id-token': `cust:${B}` } })).status, 403);
  }
  ok('M getMyProfile through the REAL export: own data only (a foreign uid param ⇒ 400), non-customer ⇒ 401, deleted ⇒ 403, promos present / omitted, no-store');

  // ═══ S — setPromos(platform): own uid, one selector, read back by getMyProfile; tombstones write nothing; the forms unchanged ═══
  {
    const A = 'u_' + 'p'.repeat(24), B = 'u_' + 'q'.repeat(24), C = 'u_' + 'r'.repeat(24);
    const terms = { version: 't1', at: 1 };
    await rtdb.ref('restaurants/x_pizza/legal').set({ ...LEGAL, terms_version: 'x1', promos_copy_version: 'xc1' });
    await rtdb.ref(`user_profiles/${A}`).set({ phone: '50499770040', created_at: 5, name: 'Pia' });
    await rtdb.ref(`user_private/${A}`).set({ email: 'p@x.hn', consent: { _platform: { terms, promos: { value: false, copy_version: 'c0', at: 1 } }, x_pizza: { terms: { version: 'x1', at: 1 } } } });
    await rtdb.ref(`user_private/${B}`).set({ email: 'q@x.hn', consent: { _platform: { terms, promos: { value: false, copy_version: 'c0', at: 1 } } } });
    const snapB = (await rtdb.ref(`user_private/${B}`).once('value')).val();
    await reset();
    const sp = (body, tok) => call(app.setPromos, { body, headers: tok ? { 'x-firebase-id-token': tok } : {} });
    let r = await sp({ context: 'platform', value: true, uid: B }, `cust:${A}`);
    assert.deepStrictEqual([r.status, r.json], [200, { ok: true, value: true }]);
    const stored = (await rtdb.ref(`user_private/${A}/consent/_platform`).once('value')).val();
    assert.deepStrictEqual([stored.terms, stored.promos.value, stored.promos.copy_version, typeof stored.promos.at], [terms, true, 'c1', 'number'], 'terms kept; the platform copy version');
    assert.deepStrictEqual((await rtdb.ref(`user_private/${B}`).once('value')).val(), snapB, '🔴 a body uid never redirects the write');
    r = await call(app.getMyProfile, { method: 'GET', query: '?context=platform', headers: { 'x-firebase-id-token': `cust:${A}` } });
    assert.strictEqual(r.json.promos, true, 'getMyProfile reads what setPromos wrote');
    for (const b of [{ context: 'platform', restaurant_id: 'x_pizza', value: false }, { context: 'platform', restaurant_id: null, value: false }, { context: 'platform', value: 'false' }])
      assert.deepStrictEqual([(r = await sp(b, `cust:${A}`)).status, r.json], [400, { ok: false, reason: 'bad_request' }], JSON.stringify(b));
    for (const tok of [null, `staff:${A}`]) assert.strictEqual((await sp({ context: 'platform', value: false }, tok)).status, 401, String(tok));
    assert.strictEqual((await rtdb.ref(`user_private/${A}/consent/_platform/promos/value`).once('value')).val(), true, 'no refused request wrote');
    // the tombstones: deleted_uids ⇒ 401; user_private {deleted_at} ⇒ 403 — nothing written either way
    await rtdb.ref(`deleted_uids/${B}`).set(1);
    assert.strictEqual((await sp({ context: 'platform', value: true }, `cust:${B}`)).status, 401);
    assert.deepStrictEqual((await rtdb.ref(`user_private/${B}`).once('value')).val(), snapB);
    await rtdb.ref(`user_private/${C}`).set({ deleted_at: 5 });
    assert.deepStrictEqual([(r = await sp({ context: 'platform', value: true }, `cust:${C}`)).status, r.json], [403, { ok: false, reason: 'deleted' }]);
    assert.deepStrictEqual((await rtdb.ref(`user_private/${C}`).once('value')).val(), { deleted_at: 5 });
    // the forms: {ok:true} only, the brand consent only
    r = await sp({ restaurant_id: 'x_pizza', value: true }, `cust:${A}`);
    assert.deepStrictEqual([r.status, r.json], [200, { ok: true }], 'forms: byte-identical answer');
    assert.strictEqual((await rtdb.ref(`user_private/${A}/consent/x_pizza/promos/value`).once('value')).val(), true);
  }
  ok('S setPromos(platform) through the REAL export: own uid only, one selector, consent/_platform/promos read back by getMyProfile, → {ok, value}; deleted_uids ⇒ 401, deleted_at ⇒ 403, nothing written; the forms\' {ok:true} unchanged');

  FINISHED = true;
  console.log(`\nsignup-platform(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
