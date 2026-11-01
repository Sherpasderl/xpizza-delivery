'use strict';
// PLAN-guest-checkout-server r4 §3 — S3a (context:'platform' across the signup family), S3b (redeemSignupGrant), S3d (getMyProfile)
// over an in-memory RTDB whose TRANSACTION + multi-path UPDATE semantics match production (undefined ABORTS, null DELETES, a
// root update writes every path at once). The REAL handlers, otp-lib, signup-core and checkout-guest-lib; the grant comes from
// S2's REAL issuer (checkout-guest-gate grantFor over a stored order). The emulator cells are the S3 heavy suite.
// Run: node signup-platform.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const OTP = require('./otp-lib');
const S = require('./signup-core');
const SE = require('./signup-endpoints');
const G = require('./checkout-guest-lib');
const GATE = require('./checkout-guest-gate');
const { makeSignupPlatform } = require('./signup-platform');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const SECRET = 'q'.repeat(40);

function fakeDb() {
  const tree = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); if (!ks.length) throw new Error('root set'); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const FAIL = { at: null };   // inject a failure: a path prefix whose next write throws once
  const HOOK = { after: null, fn: null };   // run fn ONCE right after the next transaction on a path with this prefix (a race interleaving)
  const guard = (p) => { if (FAIL.at && String(p).startsWith(FAIL.at)) { FAIL.at = null; throw new Error(`injected failure at ${p}`); } };
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => { guard(p); set(p, v); },
    remove: async () => { guard(p); set(p, null); },
    update: async (m) => { for (const k of Object.keys(m)) guard(p ? `${p}/${k}` : k); for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    child: (c) => ref(p ? `${p}/${c}` : c),
    transaction: async (fn) => {
      guard(p); const next = fn(clone(get(p)) ?? null);
      const out = next === undefined ? { committed: false, snapshot: snap(get(p)) } : (set(p, next), { committed: true, snapshot: snap(get(p)) });
      if (HOOK.after && String(p).startsWith(HOOK.after)) { const f = HOOK.fn; HOOK.after = null; HOOK.fn = null; await f(); }
      return out;
    },
  });
  return { tree, get, set, ref, FAIL, HOOK };
}
function res() { const r = { statusCode: 0, body: null, headers: {} }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; }
function harness({ legal = true, rollout = 1, env = {} } = {}) {
  const db = fakeDb(); let clock = 1.8e12; const sent = []; const minted = [];
  if (legal) db.set('platform_config/legal', { terms_url: 'https://sherpa.test/t', privacy_url: 'https://sherpa.test/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' });
  if (rollout !== null) db.set('signup_config/rollout_at', rollout);
  const mintFail = { once: false };
  const auth = { createCustomToken: async (uid, claims) => { if (mintFail.once) { mintFail.once = false; throw new Error('injected mint failure'); } minted.push([uid, claims]); return `tok:${uid}`; }, verifyIdToken: async (t) => { const [kind, uid] = String(t).split(':'); if (kind === 'cust') return { uid, customer: true }; if (kind === 'staff') return { uid }; throw new Error('bad'); } };
  const H = makeSignupPlatform({ getDatabase: () => db, getAuth: () => auth, checkRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }), now: () => clock,
    env: { ULTRAMSG_INSTANCE_ID_PLATFORM: 'i', ULTRAMSG_TOKEN_PLATFORM: 't', SIGNUP_OTP_TEMPLATE_PLATFORM: 'Sherpa: {code}', ...env },
    sendPlatformOtp: require('./checkout-otp').sendPlatformOtp, senderConfigured: require('./checkout-otp').platformSenderConfigured, isSendConfirmed: () => true,
    fetchImpl: async (u, init) => { sent.push(new URLSearchParams(init.body).get('body')); return { ok: true, json: async () => ({ sent: 'true' }) }; },
    grantSecret: () => SECRET });
  const call = async (fn, body, extra = {}) => { const r = res(); const req = { method: 'POST', body, ip: '1.1.1.1', headers: {}, query: {}, get: (h) => (extra.headers || {})[h], ...extra }; await (fn === 'requestOtp' || fn === 'verifyOtp' ? H[fn](req, r, OTP) : H[fn](req, r)); return r; };
  return { db, sent, minted, mintFail, call, tick: (ms) => { clock += ms; }, now: () => clock, code: () => sent[sent.length - 1].match(/\d{6}/)[0] };
}
const PHONE = '+50499990000', DIGITS = '50499990000', PH = OTP.phoneHash(DIGITS);
const plat = (o = {}) => ({ phone: PHONE, context: 'platform', ...o });

(async () => {
  // ── 1. requestOtp(platform): the scope IN the issuing transaction, the platform sender + template, scope refusals ──
  {
    const t = harness();
    const r = await t.call('requestOtp', plat());
    assert.deepStrictEqual([r.statusCode, r.body], [200, { ok: true, cooldown: 30 }]);
    assert.strictEqual(t.db.get(`otp/${PH}/scope`), '_platform', 'the scope is on the challenge');
    assert.strictEqual(t.db.get(`otp/${PH}/rid`), '_platform', 'the stash names the platform — never a brand default');
    assert.match(t.sent[0], /^Sherpa: \d{6}$/, 'the PLATFORM sender with the configured SIGNUP template');
    for (const b of [plat({ restaurant_id: 'x_pizza' }), plat({ context: 'app' }), { phone: PHONE, context: null }]) {
      const x = await t.call('requestOtp', b); assert.deepStrictEqual([x.statusCode, x.body], [400, { ok: false, reason: 'bad_request' }], JSON.stringify(b));
    }
    for (const ph of ['99990000', '+4412345678901', '+5049999000']) { t.tick(31e3); const before = t.sent.length; const x = await t.call('requestOtp', plat({ phone: ph })); assert.deepStrictEqual(x.body, { ok: true, cooldown: 30 }); assert.strictEqual(t.sent.length, before, `no send for ${ph}`); }
    const u = harness({ env: { SIGNUP_OTP_TEMPLATE_PLATFORM: '' } });
    assert.deepStrictEqual((await u.call('requestOtp', plat())).body, { ok: true, cooldown: 30 }, 'an unconfigured sender is still uniform (logged)');
    assert.strictEqual(u.sent.length, 0);
    assert.strictEqual(u.db.get('otp_ip'), undefined, '🔴 nothing reserved: the shared IP allowance (the forms\' too)');
    assert.strictEqual(u.db.get(`otp/${PH}`), undefined, '🔴 nothing reserved: the per-phone window / no code');
  }
  ok('requestOtp(platform): scope _platform written in the issuing transaction, stash _platform, the platform sender + SIGNUP template; both/other scopes ⇒ 400; disallowed phones ⇒ uniform, no send');

  // ── 2. the scope is enforced INSIDE verifyConsume, both directions ──
  {
    const now = 1e12, code = '123456';
    const rec = (scope) => ({ code_hash: OTP.hashCode(code), expires_at: now + 1000, attempts: 0, sends: [now], ...(scope ? { scope } : {}) });
    assert.strictEqual(OTP.verifyConsume(rec(), now, code).outcome, 'ok', 'forms: an unscoped record (today)');
    assert.strictEqual(OTP.verifyConsume(rec('_platform'), now, code).outcome, 'fail', '🔴 forms cannot use a platform challenge');
    assert.deepStrictEqual(OTP.verifyConsume(rec('_platform'), now, code).next, rec('_platform'), 'untouched (no attempt counted)');
    assert.strictEqual(OTP.verifyConsume(rec('_platform'), now, code, '_platform').outcome, 'ok');
    assert.strictEqual(OTP.verifyConsume(rec(), now, code, '_platform').outcome, 'fail', '🔴 the app cannot use a forms challenge');
  }
  ok('verifyConsume: the challenge scope must EQUAL the caller\'s — forms ⇄ platform cross-use fails untouched; unscoped forms records verify exactly as today');

  // ── 3. verifyOtp(platform): success, reasons, no welcome credit, completion + profile ──
  {
    const t = harness();
    await t.call('requestOtp', plat());
    let r = await t.call('verifyOtp', plat({ code: '000000' === t.code() ? '111111' : '000000' }));
    assert.deepStrictEqual(r.body, { ok: false, reason: 'code_wrong' });
    r = await t.call('verifyOtp', plat({ code: t.code() }));
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.is_new, true); assert.strictEqual(r.body.name, null);
    const uid = t.db.get(`phone_index/${PH}`);
    assert.match(uid, /^u_[0-9a-f]{24}$/); assert.strictEqual(r.body.token, `tok:${uid}`); assert.deepStrictEqual(t.minted.pop(), [uid, { customer: true }]);
    assert.strictEqual(r.body.completion, 'needed', 'post-rollout, no platform terms yet');
    assert.deepStrictEqual(r.body.profile, { name: null, email: null }, 'promos OMITTED when no consent is stored');
    assert.strictEqual(t.db.get('reward_welcome'), undefined, '🔴 NO signup-time welcome credit for the platform scope');
    assert.strictEqual(t.db.get(`otp/${PH}`), undefined, 'one-time use');
    assert.deepStrictEqual((await t.call('verifyOtp', plat({ code: '123456' }))).body, { ok: false, reason: 'code_wrong' }, 'nothing live');
    // expired / too many attempts (+ retry_in_s)
    t.tick(60e3); await t.call('requestOtp', plat()); t.tick(OTP.LIMITS.CODE_TTL + 1);
    assert.deepStrictEqual((await t.call('verifyOtp', plat({ code: t.code() }))).body, { ok: false, reason: 'code_expired' });
    t.tick(60e3); await t.call('requestOtp', plat());
    const wrong = t.code() === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP.LIMITS.MAX_ATTEMPTS - 1; i++) assert.strictEqual((await t.call('verifyOtp', plat({ code: wrong }))).body.reason, 'code_wrong');
    const last = (await t.call('verifyOtp', plat({ code: wrong }))).body;
    assert.strictEqual(last.reason, 'too_many_attempts'); assert.ok(last.retry_in_s >= 1);
    assert.strictEqual((await t.call('verifyOtp', plat({ code: t.code() }))).body.reason, 'too_many_attempts', 'capped');
    // a forms-issued challenge cannot be verified by the app
    t.tick(60e3); t.db.set(`otp/${PH}`, { code_hash: OTP.hashCode('424242'), expires_at: t.now() + 60e3, attempts: 0, sends: [t.now()] });
    assert.deepStrictEqual((await t.call('verifyOtp', plat({ code: '424242' }))).body, { ok: false, reason: 'code_wrong' });
    // the returning member: completion complete + profile with promos
    t.db.set(`user_private/${uid}/consent/_platform`, { terms: { version: 't1', privacy_version: 'p1', at: 1 }, promos: { value: true, copy_version: 'c1', at: 1 } });
    t.db.set(`user_private/${uid}/email`, 'ana@example.com'); t.db.set(`user_profiles/${uid}/name`, 'Ana');
    t.tick(60e3); t.db.set(`otp/${PH}`, null); await t.call('requestOtp', plat());
    r = await t.call('verifyOtp', plat({ code: t.code() }));
    assert.deepStrictEqual([r.body.is_new, r.body.name, r.body.completion, r.body.profile], [false, 'Ana', 'complete', { name: 'Ana', email: 'ana@example.com', promos: true }]);
    assert.strictEqual(t.db.get(`phone_index/${PH}`), uid, 'the SAME global phone account');
  }
  ok('verifyOtp(platform): reasons code_wrong / code_expired / too_many_attempts (+retry_in_s); success mints for the global phone account, NO welcome credit, completion needed→complete, profile {name, email, promos?}; a forms challenge is refused');

  // ── 4. completion: off when the rollout is inactive / legal missing / legacy ──
  {
    for (const [o, want] of [[{ legal: false }, 'off'], [{ rollout: null }, 'off']]) {
      const t = harness(o); await t.call('requestOtp', plat());
      assert.strictEqual((await t.call('verifyOtp', plat({ code: t.code() }))).body.completion, want, JSON.stringify(o));
    }
    const t = harness({ rollout: 2e12 }); await t.call('requestOtp', plat());
    assert.strictEqual((await t.call('verifyOtp', plat({ code: t.code() }))).body.completion, 'off', 'a LEGACY account (created before rollout_at)');
  }
  ok('completion: off without rollout_at / without platform legal / for a legacy account (the forms\' suCompletionState, server-side)');

  // ── the grant, from S2's REAL issuer over a stored capp-guest order ──
  async function grantSetup(t, { orderId = 'XPZ-G1', phone = DIGITS } = {}) {
    const guest = { phone, phone_hash: OTP.phoneHash(phone) };
    t.db.set(`orders/${orderId}`, { status: 'pending_payment', created_at: t.now(), guest_verified: guest });
    const g = await GATE.grantFor({ db: t.db, orderId, guest, secret: SECRET, now: t.now() });
    assert.ok(g.grant, 'premise: the real issuer granted');
    return g.grant.token;
  }
  const redeemBody = (grant, o = {}) => ({ grant, context: 'platform', email: 'Ana@Example.com', name: ' Ana Pérez ', accept_terms: true, promos: true, ...o });

  // ── 5. redeemSignupGrant: success, apply once, replay re-mints only, a later member edit survives ──
  {
    const t = harness();
    const grant = await grantSetup(t);
    let r = await t.call('redeemSignupGrant', redeemBody(grant));
    assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body));
    const uid = t.db.get(`phone_index/${PH}`);
    assert.deepStrictEqual(r.body, { ok: true, token: `tok:${uid}`, is_new: true, name: 'Ana Pérez', completion: 'complete' });
    const prof = t.db.get(`user_profiles/${uid}`);
    assert.match(prof.created_by, /^g_[0-9a-f]{24}$/, 'the redemption\'s unique creation marker (ruling 3)');
    delete prof.created_by;
    assert.deepStrictEqual(prof, { phone: DIGITS, phone_hash: PH, created_at: t.now(), last_login: t.now(), name: 'Ana Pérez' }, 'the phone from the ORDER');
    const priv = t.db.get(`user_private/${uid}`);
    assert.strictEqual(priv.email, 'ana@example.com'); assert.strictEqual(priv.email_source, 'typed'); assert.strictEqual(priv.email_verified, false);
    assert.deepStrictEqual(priv.consent._platform, { terms: { version: 't1', privacy_version: 'p1', at: t.now() }, promos: { value: true, copy_version: 'c1', at: t.now() } }, 'consent/_platform with the RECORDED legal versions');
    assert.strictEqual(t.db.get('grants_used/XPZ-G1/applied'), true);
    assert.strictEqual(t.db.get('grants_used/XPZ-G1/uid'), uid);
    // the member edits the email (completeProfile path) — a replay of the grant never rewrites it, and only re-mints
    t.db.set(`user_private/${uid}/email`, 'nuevo@example.com');
    t.tick(1000);
    r = await t.call('redeemSignupGrant', redeemBody(grant, { email: 'otra@example.com', name: 'Otra', promos: false }));
    assert.deepStrictEqual(r.body, { ok: true, token: `tok:${uid}`, is_new: false, name: 'Ana Pérez', completion: 'complete' });
    assert.strictEqual(t.db.get(`user_private/${uid}/email`), 'nuevo@example.com', '🔴 the later member edit wins (apply ONCE)');
    assert.strictEqual(t.db.get(`user_private/${uid}/consent/_platform/promos/value`), true, 'changed inputs on a retry are ignored');
  }
  ok('redeemSignupGrant: one uid for the order\'s phone, profile from the ORDER, consent/_platform + email + name applied ONCE from the recorded inputs; a replay only re-mints and never overwrites a later member edit');

  // ── 6. redeemSignupGrant refusals: grant_invalid (no oracle), fields, legal, deleted; nothing consumed ──
  {
    const t = harness();
    const grant = await grantSetup(t);
    const [, body, sig] = grant.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: t.now() + 1e9 })).toString('base64url');
    for (const [why, b] of [['tampered', redeemBody(`sg.${forged}.${sig}`)], ['garbage', redeemBody('sg.x.y')], ['another secret', redeemBody(G.signGrant(G.grantPayload('XPZ-G1', PH, t.now()), 'z'.repeat(40)))]])
      assert.deepStrictEqual((await t.call('redeemSignupGrant', b)).body, { ok: false, reason: 'grant_invalid' }, why);
    for (const [why, b, reason] of [['no terms', redeemBody(grant, { accept_terms: 'yes' }), 'bad_request'], ['promos not boolean', redeemBody(grant, { promos: 1 }), 'bad_request'],
      ['empty name', redeemBody(grant, { name: '  ' }), 'bad_request'], ['long name', redeemBody(grant, { name: 'x'.repeat(81) }), 'bad_request'], ['bad email', redeemBody(grant, { email: 'ana@' }), 'bad_email'],
      ['a rid scope', { ...redeemBody(grant), restaurant_id: 'x_pizza' }, 'bad_request'], ['no context', { ...redeemBody(grant), context: undefined }, 'bad_request']])
      assert.deepStrictEqual((await t.call('redeemSignupGrant', b)).body, { ok: false, reason }, why);
    assert.strictEqual(t.db.get('grants_used'), undefined, 'nothing consumed by a refusal');
    // the order lost its guest_verified / the stored phone does not hash to the grant's
    t.db.set('orders/XPZ-G1/guest_verified/phone', '50488881111');
    assert.deepStrictEqual((await t.call('redeemSignupGrant', redeemBody(grant))).body, { ok: false, reason: 'grant_invalid' }, '🔴 the phone is re-derived from the order');
    t.db.set('orders/XPZ-G1/guest_verified', null);
    assert.deepStrictEqual((await t.call('redeemSignupGrant', redeemBody(grant))).body, { ok: false, reason: 'grant_invalid' }, 'no guest_verified');
    // expired
    const t2 = harness(); const g2 = await grantSetup(t2); t2.tick(G.GRANT_TTL_MS);
    assert.deepStrictEqual((await t2.call('redeemSignupGrant', redeemBody(g2))).body, { ok: false, reason: 'grant_invalid' }, 'expired');
    // legal unconfigured; a deleted account
    const t3 = harness({ legal: false }); const g3 = await grantSetup(t3);
    assert.deepStrictEqual((await t3.call('redeemSignupGrant', redeemBody(g3))).body, { ok: false, reason: 'legal_unconfigured' });
    const t4 = harness(); const g4 = await grantSetup(t4); t4.db.set(`phone_index/${PH}`, 'u_' + 'a'.repeat(24)); t4.db.set('deleted_uids/u_' + 'a'.repeat(24), 1);
    const d = await t4.call('redeemSignupGrant', redeemBody(g4)); assert.deepStrictEqual([d.statusCode, d.body], [403, { ok: false, reason: 'deleted' }]);
    // a grant already used by ANOTHER uid
    const t5 = harness(); const g5 = await grantSetup(t5); t5.db.set('grants_used/XPZ-G1', { uid: 'u_' + 'b'.repeat(24), at: 1, inputs: {}, legal: {} });
    assert.deepStrictEqual((await t5.call('redeemSignupGrant', redeemBody(g5))).body, { ok: false, reason: 'grant_invalid' });
  }
  ok('redeemSignupGrant refusals: tampered / foreign-secret / expired / lost or mismatched guest_verified ⇒ grant_invalid (one reason); fields ⇒ bad_request / bad_email; legal_unconfigured; deleted ⇒ 403; another uid\'s use ⇒ grant_invalid; nothing consumed');

  // ── 7. failure injected after each step, then a retry: one uid, one profile, consent once ──
  for (const at of ['grants_used', 'user_profiles', 'user_private', 'never']) {
    const t = harness();
    const grant = await grantSetup(t);
    if (at !== 'never') t.db.FAIL.at = at;
    const first = await t.call('redeemSignupGrant', redeemBody(grant));
    if (at !== 'never') assert.strictEqual(first.statusCode, 500, `${at}: the injected failure surfaces`);
    if (at === 'user_private') assert.strictEqual(Object.keys(t.db.get('user_profiles') || {}).length, 0, '🔴 ruling 2: a FAILED apply undoes the profile this call created');
    const r = await t.call('redeemSignupGrant', redeemBody(grant, { email: 'cambio@example.com' }));
    assert.strictEqual(r.statusCode, 200, `${at}: the retry completes (${JSON.stringify(r.body)})`);
    const uid = t.db.get(`phone_index/${PH}`);
    assert.strictEqual(r.body.token, `tok:${uid}`);
    assert.strictEqual(Object.keys(t.db.get('user_profiles')).length, 1, `${at}: one profile`);
    assert.strictEqual(t.db.get(`user_private/${uid}/consent/_platform/terms/version`), 't1');
    const wantEmail = at === 'grants_used' ? 'cambio@example.com' : 'ana@example.com';   // the use is recorded at step 2: before it, a retry's inputs are the first recorded
    assert.strictEqual(t.db.get(`user_private/${uid}/email`), wantEmail, `${at}: the RECORDED inputs win`);
  }
  ok('redeemSignupGrant: a failure injected at the use record / the profile / the apply, then a retry ⇒ one uid, one profile, consent once, the recorded inputs');

  // ── 8. getMyProfile: own data only ──
  {
    const t = harness();
    const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
    t.db.set(`user_profiles/${A}`, { phone: '50499990000', phone_hash: PH, created_at: 5, name: 'Ana' });
    t.db.set(`user_private/${A}`, { email: 'a@x.hn', consent: { _platform: { terms: { version: 't1' }, promos: { value: false } } } });
    t.db.set(`user_profiles/${B}`, { phone: '50488881111', created_at: 5, name: 'Beto' });
    const get = (q, hdr, body) => t.call('getMyProfile', body, { method: 'GET', query: q, headers: hdr ? { 'x-firebase-id-token': hdr } : {} });
    let r = await get({ context: 'platform' }, `cust:${A}`);
    assert.deepStrictEqual(r.body, { ok: true, name: 'Ana', email: 'a@x.hn', phone: '50499990000', phone_last4: '0000', consent: { terms: true, terms_version: 't1', promos: false }, completion: 'complete', promos: false });
    assert.strictEqual(r.headers['Cache-Control'], 'no-store');
    for (const [q, why] of [[{ context: 'platform', uid: B }, 'a uid param'], [{ context: 'platform', phone: '50488881111' }, 'a phone param'], [{}, 'no scope'], [{ context: 'x_pizza' }, 'a rid scope']]) {
      r = await get(q, `cust:${A}`); assert.deepStrictEqual([r.statusCode, r.body], [400, { ok: false, reason: 'bad_request' }], `🔴 ${why}`);
    }
    r = await get({ context: 'platform' }, `cust:${A}`, { uid: B }); assert.strictEqual(r.statusCode, 400, '🔴 a body field');
    for (const tok of [null, `staff:${A}`, 'garbage']) { r = await get({ context: 'platform' }, tok); assert.deepStrictEqual([r.statusCode, r.body], [401, { ok: false, reason: 'unauthenticated' }], String(tok)); }
    t.db.set(`deleted_uids/${A}`, 1);
    r = await get({ context: 'platform' }, `cust:${A}`); assert.deepStrictEqual([r.statusCode, r.body], [403, { ok: false, reason: 'deleted' }]);
    r = await get({ context: 'platform' }, `cust:${B}`);
    assert.strictEqual(r.body.name, 'Beto'); assert.ok(!('promos' in r.body), 'promos OMITTED when no consent is stored'); assert.deepStrictEqual(r.body.consent, { terms: false, terms_version: null, promos: false });
  }
  ok('getMyProfile: the caller\'s OWN data (token uid only); any uid / phone / body parameter or a wrong scope ⇒ 400; non-customer / missing token ⇒ 401; tombstone ⇒ 403; promos omitted when unset; no-store');

  // ── 9. the signup family's scope parsing (signup-endpoints): forms unchanged, platform additive, both/neither refused ──
  {
    const db = fakeDb();
    db.set('platform_config/legal', { terms_url: 'u', privacy_url: 'p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' });
    db.set('restaurants/x_pizza/legal', { terms_url: 'xu', privacy_url: 'xp', terms_version: 'x1', privacy_version: 'xp1', promos_copy_version: 'xc1' });
    db.set('signup_config/rollout_at', 1);
    const env = { GOOGLE_OAUTH_AUDIENCES__PLATFORM: 'plat-client', GOOGLE_OAUTH_AUDIENCES__X_PIZZA: 'xp-client' };
    const H = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: t, customer: true }) }), checkRateLimit: async () => ({ allowed: true }),
      resolveRid: (raw) => (raw === 'x_pizza' ? { restaurantId: 'x_pizza' } : raw == null ? { restaurantId: 'x_pizza', defaulted: true } : { error: 'unknown' }), env });
    const call = async (fn, o) => { const r = res(); await H[fn]({ method: o.method || 'POST', body: o.body || {}, query: o.query || {}, headers: {}, ip: '1', get: (h) => (o.headers || {})[h] }, r); return r; };
    let r = await call('getSignupConfig', { method: 'GET', query: { context: 'platform' } });
    assert.deepStrictEqual(r.body, { ok: true, terms_url: 'u', privacy_url: 'p', legal_ready: true, google_enabled: true, google_client_id: 'plat-client', email_login_enabled: false, rollout_at: 1 });
    r = await call('getSignupConfig', { method: 'GET', query: { restaurant_id: 'x_pizza' } });
    assert.strictEqual(r.body.google_client_id, 'xp-client', 'forms: unchanged'); assert.strictEqual(r.body.terms_url, 'xu');
    for (const q of [{ restaurant_id: 'x_pizza', context: 'platform' }, {}, { context: 'other' }]) assert.strictEqual((await call('getSignupConfig', { method: 'GET', query: q })).statusCode, 400, JSON.stringify(q));
    const U = 'u_' + 'c'.repeat(24);
    r = await call('completeProfile', { body: { context: 'platform', email: 'c@x.hn', accept_terms: true, promos: false, name: ' Cami ' }, headers: { 'x-firebase-id-token': U } });
    assert.deepStrictEqual(r.body, { ok: true });
    assert.strictEqual(db.get(`user_private/${U}/consent/_platform/terms/version`), 't1'); assert.strictEqual(db.get(`user_profiles/${U}/name`), 'Cami');
    assert.strictEqual(db.get(`user_private/${U}/consent/x_pizza`), undefined, 'never a brand consent');
    assert.strictEqual((await call('completeProfile', { body: { context: 'platform', email: 'c@x.hn', accept_terms: true, promos: false, name: '' }, headers: { 'x-firebase-id-token': U } })).statusCode, 400, 'an empty name');
    r = await call('completeProfile', { body: { restaurant_id: 'x_pizza', email: 'c@x.hn', accept_terms: true, promos: true }, headers: { 'x-firebase-id-token': U } });
    assert.deepStrictEqual(r.body, { ok: true }); assert.strictEqual(db.get(`user_private/${U}/consent/x_pizza/terms/version`), 'x1', 'forms: unchanged');
    r = await call('setPromos', { body: { context: 'platform', value: true }, headers: { 'x-firebase-id-token': U } });
    assert.deepStrictEqual(r.body, { ok: true, value: true }); assert.strictEqual(db.get(`user_private/${U}/consent/_platform/promos/value`), true);
    for (const b of [{ restaurant_id: 'x_pizza', context: 'platform', session_id: 's'.repeat(24) }, { session_id: 's'.repeat(24) }]) assert.strictEqual((await call('googleStart', { body: b })).statusCode, 400, JSON.stringify(b));
    r = await call('googleStart', { body: { context: 'platform', session_id: 's'.repeat(24) } });
    assert.ok(r.body.ok && r.body.nonce); assert.strictEqual(Object.values(db.get('auth_challenges'))[0].rid, '_platform');
  }
  ok('signup family: getSignupConfig / completeProfile (+ name) / setPromos / googleStart take EITHER restaurant_id (forms, unchanged) OR context:platform (platform legal, consent/_platform, platform audiences); both / neither ⇒ 400');

  // ── 10. rules: grants_used is server-only (the grant's use record: uid, recorded inputs, legal versions) ──
  {
    const rules = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
    assert.ok(rules.grants_used, 'grants_used has a rule');
    assert.strictEqual(rules.grants_used['.read'], false); assert.strictEqual(rules.grants_used['.write'], false);
    assert.deepStrictEqual(Object.keys(rules.grants_used).filter((x) => !x.startsWith('.')), [], 'no nested grant');
  }
  ok('rules: grants_used is server-only with no nested grant');

  // ── 11. Codex S3 r1 P1: a deletion racing a redemption never resurrects the account and never gets a token ──
  {
    const ACCOUNT = require('./account-lib');
    // the REAL deletion sequence (signup-endpoints deleteAccountCore): the BC2 tombstone FIRST, then today's removals
    const deleteNow = (t, uid) => async () => { await S.tombstone(t.db, uid, { now: t.now() }); await t.db.ref().update(ACCOUNT.accountDeleteUpdates(uid, PH, t.now())); };
    for (const after of ['grants_used', 'user_profiles', 'user_private']) {
      const t = harness();
      const grant = await grantSetup(t);
      t.db.HOOK.after = after;
      t.db.HOOK.fn = async () => deleteNow(t, t.db.get(`phone_index/${PH}`) || Object.keys(t.db.get('user_profiles') || {})[0])();
      const r = await t.call('redeemSignupGrant', redeemBody(grant));
      const uid = t.db.get('grants_used/XPZ-G1/uid');
      assert.deepStrictEqual([r.statusCode, r.body], [403, { ok: false, reason: 'deleted' }], `🔴 deletion after the ${after} step ⇒ refused`);
      assert.strictEqual(t.minted.length, 0, `🔴 deletion after ${after}: NO token for the tombstoned uid`);
      assert.strictEqual(t.db.get(`user_profiles/${uid}`), undefined, `🔴 deletion after ${after}: the profile is NOT resurrected`);
      assert.deepStrictEqual(Object.keys(t.db.get(`user_private/${uid}`)), ['deleted_at'], `🔴 deletion after ${after}: no consent / email restored beside the tombstone`);
    }
  }
  ok('Codex S3 r1 P1: a deletion completing after the use record / the profile / the apply ⇒ 403 deleted, NO token, the profile not resurrected, user_private stays exactly {deleted_at}');

  // ── 12. a failure AFTER the apply (before the name / before the mint), then a retry ──
  {
    const t = harness();
    const grant = await grantSetup(t);
    t.db.HOOK.after = 'user_private'; t.db.HOOK.fn = async () => { t.db.FAIL.at = 'user_profiles'; };   // the apply commits, the name write then fails
    assert.strictEqual((await t.call('redeemSignupGrant', redeemBody(grant))).statusCode, 500);
    const uid = t.db.get(`phone_index/${PH}`);
    assert.strictEqual(t.db.get(`user_profiles/${uid}/name`), undefined, 'premise: applied, name not yet written');
    let r = await t.call('redeemSignupGrant', redeemBody(grant, { name: 'Otro' }));
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(t.db.get(`user_profiles/${uid}/name`), 'Ana Pérez', 'the retry fills the RECORDED name (never the new input)');
    assert.strictEqual(t.db.get(`user_private/${uid}/grants_applied/XPZ-G1`), true);
    // the mint fails after a complete apply ⇒ a retry only re-mints (nothing re-applied)
    const t2 = harness(); const g2 = await grantSetup(t2);
    t2.mintFail.once = true;
    assert.strictEqual((await t2.call('redeemSignupGrant', redeemBody(g2))).statusCode, 500);
    const uid2 = t2.db.get(`phone_index/${PH}`);
    t2.db.set(`user_private/${uid2}/email`, 'editado@example.com');
    r = await t2.call('redeemSignupGrant', redeemBody(g2));
    assert.deepStrictEqual([r.statusCode, r.body.token, r.body.name], [200, `tok:${uid2}`, 'Ana Pérez']);
    assert.strictEqual(t2.db.get(`user_private/${uid2}/email`), 'editado@example.com', 'nothing re-applied after a failed mint');
  }
  ok('a failure after the apply (the name write, or the mint) then a retry ⇒ 200, the RECORDED name filled once, nothing re-applied, a token for the claimed uid');

  // ── 13. Codex S3 r1 P2: platform verifyOtp never overwrites a profile a concurrent grant redemption created ──
  {
    const t = harness();
    const grant = await grantSetup(t);
    await t.call('requestOtp', plat());
    // pause verify right after it claimed the uid (phone_index txn); a grant redemption for the same phone completes; verify resumes
    t.db.HOOK.after = 'phone_index'; t.db.HOOK.fn = async () => { const x = await t.call('redeemSignupGrant', redeemBody(grant)); assert.strictEqual(x.statusCode, 200); };
    const r = await t.call('verifyOtp', plat({ code: t.code() }));
    const uid = t.db.get(`phone_index/${PH}`);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(t.db.get(`user_profiles/${uid}/name`), 'Ana Pérez', '🔴 the grant-created profile (name) survives the interleaved verify');
    assert.deepStrictEqual([r.body.is_new, r.body.name, r.body.completion], [false, 'Ana Pérez', 'complete']);
  }
  ok('Codex S3 r1 P2: verify paused after the uid claim, a grant redemption completes, verify resumes ⇒ the profile (and its name) is never overwritten; is_new false');

  // ── 14. Codex S3 r1 P2: EXACTLY one selector — an explicit null restaurant_id refuses a platform request (and context on a form) ──
  {
    const t = harness();
    for (const fn of ['requestOtp', 'verifyOtp']) {
      const r = await t.call(fn, plat({ restaurant_id: null, code: '123456' }));
      assert.deepStrictEqual([r.statusCode, r.body], [400, { ok: false, reason: 'bad_request' }], `${fn}: {context:'platform', restaurant_id:null}`);
    }
    assert.strictEqual(t.sent.length, 0, '🔴 no OTP sent');
    const grant = await grantSetup(t);
    assert.deepStrictEqual((await t.call('redeemSignupGrant', { ...redeemBody(grant), restaurant_id: null })).body, { ok: false, reason: 'bad_request' });
    const db = fakeDb(); db.set('platform_config/legal', { terms_url: 'u', privacy_url: 'p', terms_version: 't', privacy_version: 'p', promos_copy_version: 'c' });
    const H = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (x) => ({ uid: x, customer: true }) }), checkRateLimit: async () => ({ allowed: true }),
      resolveRid: (raw) => (raw === 'x_pizza' ? { restaurantId: 'x_pizza' } : raw == null ? { restaurantId: 'x_pizza', defaulted: true } : { error: 'unknown' }), env: {} });
    const c = async (fn, o) => { const r = res(); await H[fn]({ method: o.method || 'POST', body: o.body || {}, query: o.query || {}, headers: {}, ip: '1', get: () => 'u_' + 'd'.repeat(24) }, r); return r.statusCode; };
    for (const [fn, o] of [['getSignupConfig', { method: 'GET', query: { context: 'platform', restaurant_id: '' } }], ['googleStart', { body: { context: 'platform', restaurant_id: null, session_id: 's'.repeat(24) } }],
      ['googleSignIn', { body: { context: 'platform', restaurant_id: null, session_id: 's'.repeat(24), id_token: 'x' } }], ['completeProfile', { body: { context: 'platform', restaurant_id: null, email: 'a@b.hn', accept_terms: true, promos: true } }],
      ['setPromos', { body: { context: 'platform', restaurant_id: null, value: true } }], ['completeProfile', { body: { context: null, restaurant_id: 'x_pizza', email: 'a@b.hn', accept_terms: true, promos: true } }]])
      assert.strictEqual(await c(fn, o), 400, `${fn}: ${JSON.stringify(o.body || o.query)}`);
  }
  ok('Codex S3 r1 P2: an explicit null restaurant_id refuses every platform endpoint (requestOtp sends nothing); a context key (even null) refuses a forms-shaped body — the forms never send context');

  // ── 15. ruling 3 (Codex S3 r2): the rollback removes ONLY the profile THIS call created — never another call's, even with the
  //    SAME created_at + phone_hash (Codex's repro: redemption creates, deletion removes, an overlapping sign-in recreates it)
  {
    const t = harness();
    const ACCOUNT = require('./account-lib');
    const grant = await grantSetup(t);
    t.db.HOOK.after = 'user_profiles';   // right after the redemption's create-if-absent
    t.db.HOOK.fn = async () => {
      const uid = t.db.get(`phone_index/${PH}`);
      const mine = t.db.get(`user_profiles/${uid}`);
      await S.tombstone(t.db, uid, { now: t.now() }); await t.db.ref().update(ACCOUNT.accountDeleteUpdates(uid, PH, t.now()));
      // another call's profile at the same uid with the SAME created_at + phone_hash (no marker of this redemption)
      t.db.set(`user_profiles/${uid}`, { phone: mine.phone, phone_hash: mine.phone_hash, created_at: mine.created_at, last_login: mine.created_at });
    };
    const r = await t.call('redeemSignupGrant', redeemBody(grant));
    assert.deepStrictEqual([r.statusCode, r.body], [403, { ok: false, reason: 'deleted' }]);
    const uid = t.db.get('grants_used/XPZ-G1/uid');
    assert.ok(t.db.get(`user_profiles/${uid}`), '🔴 the other call\'s profile survives the rollback (same created_at + phone_hash)');
    assert.strictEqual(t.minted.length, 0);
  }
  ok('ruling 3: the rollback is keyed on this call\'s unique created_by marker — another call\'s profile with the SAME created_at + phone_hash is never removed');

  // ── 16. ruling 4 (Codex S3 r2): a DELAYED redemption never overwrites a later completeProfile name edit ──
  {
    const t = harness();
    const grant = await grantSetup(t);
    // pause the original right after its apply; a retry completes; the member edits the name; the original resumes
    t.db.HOOK.after = 'user_private';
    t.db.HOOK.fn = async () => {
      const retry = await t.call('redeemSignupGrant', redeemBody(grant));
      assert.strictEqual(retry.statusCode, 200);
      t.db.set(`user_profiles/${t.db.get(`phone_index/${PH}`)}/name`, 'Editado por el miembro');   // completeProfile's name write
    };
    const r = await t.call('redeemSignupGrant', redeemBody(grant));
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(t.db.get(`user_profiles/${t.db.get(`phone_index/${PH}`)}/name`), 'Editado por el miembro', '🔴 the later edit survives the resumed original');
    assert.strictEqual(r.body.name, 'Editado por el miembro');
  }
  ok('ruling 4: the name is create-if-absent — a paused original resuming after a retry + a member edit never overwrites the edit');

  // ── 17. Codex capp batch r1 #4: the PLATFORM setPromos — the member's own uid, exactly one selector, the forms unchanged, the
  //    platform consent where getMyProfile / profileOf read it, the stored value confirmed; a tombstone writes nothing ──
  {
    const db = fakeDb();
    db.set('platform_config/legal', { terms_url: 'u', privacy_url: 'p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' });
    db.set('restaurants/x_pizza/legal', { terms_url: 'xu', privacy_url: 'xp', terms_version: 'x1', privacy_version: 'xp1', promos_copy_version: 'xc1' });
    const H = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (x) => { if (!String(x).startsWith('cust:')) throw new Error('bad'); return { uid: x.slice(5), customer: true }; } }),
      checkRateLimit: async () => ({ allowed: true }), resolveRid: (raw) => (raw === 'x_pizza' ? { restaurantId: 'x_pizza' } : raw == null ? { restaurantId: 'x_pizza', defaulted: true } : { error: 'unknown' }), env: {}, now: () => 777 });
    const call = async (body, tok) => { const r = res(); await H.setPromos({ method: 'POST', body, query: {}, headers: {}, ip: '1', get: (h) => (h === 'x-firebase-id-token' ? tok : undefined) }, r); return r; };
    const A = 'u_' + 'e'.repeat(24), B = 'u_' + 'f'.repeat(24);
    const terms = { version: 't1', at: 1 };
    db.set(`user_private/${A}`, { email: 'a@x.hn', consent: { _platform: { terms, promos: { value: false, copy_version: 'c0', at: 1 } }, x_pizza: { terms: { version: 'x1', at: 1 }, promos: { value: false, copy_version: 'xc1', at: 1 } } } });
    db.set(`user_private/${B}`, { email: 'b@x.hn', consent: { _platform: { terms, promos: { value: false, copy_version: 'c0', at: 1 } } } });
    const snapB = JSON.stringify(db.get(`user_private/${B}`));
    // the member's OWN uid: a body uid is ignored; B is never touched
    let r = await call({ context: 'platform', value: true, uid: B }, `cust:${A}`);
    assert.deepStrictEqual([r.statusCode, r.body], [200, { ok: true, value: true }]);
    assert.deepStrictEqual(db.get(`user_private/${A}/consent/_platform`), { terms, promos: { value: true, copy_version: 'c1', at: 777 } }, 'terms kept; the platform copy version + server clock');
    assert.strictEqual(db.get(`user_private/${A}/consent/x_pizza/promos/value`), false, 'never a brand consent');
    assert.strictEqual(JSON.stringify(db.get(`user_private/${B}`)), snapB, '🔴 another member untouched');
    // exactly what the platform profile reads
    assert.strictEqual((await S.profileOf(db, A, S.PLATFORM_SCOPE)).promos, true);
    r = await call({ context: 'platform', value: false }, `cust:${A}`);
    assert.deepStrictEqual(r.body, { ok: true, value: false }); assert.strictEqual((await S.profileOf(db, A, S.PLATFORM_SCOPE)).promos, false);
    // exactly one selector: any restaurant_id key (a known brand, null, empty) with context:'platform' ⇒ 400, nothing written
    const before = JSON.stringify(db.tree);
    for (const b of [{ context: 'platform', restaurant_id: 'x_pizza', value: true }, { context: 'platform', restaurant_id: null, value: true }, { context: 'platform', restaurant_id: '', value: true },
      { context: 'Platform', value: true }, { context: null, value: true }, { value: true }])
      assert.deepStrictEqual([(r = await call(b, `cust:${A}`)).statusCode, r.body], [400, { ok: false, reason: 'bad_request' }], JSON.stringify(b));
    for (const v of ['true', 1, null, undefined]) assert.deepStrictEqual((await call({ context: 'platform', value: v }, `cust:${A}`)).body, { ok: false, reason: 'bad_request' }, String(v));
    // signed-in member only
    for (const tok of [undefined, '', 'garbage', A]) assert.deepStrictEqual([(r = await call({ context: 'platform', value: true }, tok)).statusCode, r.body], [401, { ok: false, reason: 'unauthenticated' }], String(tok));
    const H2 = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async () => ({ uid: A, customer: false }) }), checkRateLimit: async () => ({ allowed: true }), resolveRid: () => ({ error: 'x' }), env: {} });
    r = res(); await H2.setPromos({ method: 'POST', body: { context: 'platform', value: true }, headers: {}, ip: '1', get: () => 'staff' }, r);
    assert.strictEqual(r.statusCode, 401, 'a non-customer token');
    assert.strictEqual(JSON.stringify(db.tree), before, '🔴 no refused request wrote anything');
    // no completed platform profile (no consent/_platform/terms) ⇒ not_completed, nothing created; no platform legal ⇒ legal_unconfigured
    const C = 'u_' + 'g'.repeat(24);
    db.set(`user_private/${C}`, { email: 'c@x.hn', consent: { x_pizza: { terms: { version: 'x1', at: 1 } } } });
    assert.deepStrictEqual([(r = await call({ context: 'platform', value: true }, `cust:${C}`)).statusCode, r.body], [400, { ok: false, reason: 'not_completed' }]);
    assert.strictEqual(db.get(`user_private/${C}/consent/_platform`), undefined, 'a brand completion never completes the platform');
    assert.deepStrictEqual((await call({ context: 'platform', value: true }, `cust:${'u_' + 'h'.repeat(24)}`)).body, { ok: false, reason: 'not_completed' });
    assert.strictEqual(db.get(`user_private/${'u_' + 'h'.repeat(24)}`), undefined, 'an absent record is never created');
    // the tombstones: deleted_uids ⇒ 401 (never resolved to a uid); user_private deleted_at ⇒ 403; neither writes
    db.set(`deleted_uids/${B}`, 1);
    assert.deepStrictEqual([(r = await call({ context: 'platform', value: true }, `cust:${B}`)).statusCode, r.body], [401, { ok: false, reason: 'unauthenticated' }]);
    assert.strictEqual(JSON.stringify(db.get(`user_private/${B}`)), snapB, '🔴 deleted_uids: nothing written');
    db.set(`user_private/${C}`, { deleted_at: 5 });
    assert.deepStrictEqual([(r = await call({ context: 'platform', value: true }, `cust:${C}`)).statusCode, r.body], [403, { ok: false, reason: 'deleted' }]);
    assert.deepStrictEqual(db.get(`user_private/${C}`), { deleted_at: 5 }, '🔴 the tombstone stays exactly {deleted_at}');
    db.set('platform_config/legal', null);
    assert.deepStrictEqual([(r = await call({ context: 'platform', value: true }, `cust:${A}`)).statusCode, r.body], [400, { ok: false, reason: 'legal_unconfigured' }]);
    // the forms: byte-identical — {ok:true} only (no value), the brand consent only
    r = await call({ restaurant_id: 'x_pizza', value: true }, `cust:${A}`);
    assert.deepStrictEqual([r.statusCode, r.body], [200, { ok: true }], 'forms: no `value` field');
    assert.strictEqual(db.get(`user_private/${A}/consent/x_pizza/promos/value`), true); assert.strictEqual(db.get(`user_private/${A}/consent/_platform/promos/value`), false);
  }
  {
    // the confirmed value is READ BACK from the committed record, never echoed from the request
    const legal = { terms_url: 'u', privacy_url: 'p', terms_version: 't', privacy_version: 'p', promos_copy_version: 'c' };
    const stub = (committedVal) => ({ ref: (p) => ({ once: async () => ({ val: () => (p === 'platform_config/legal' ? legal : null), exists: () => p === 'platform_config/legal' }),
      transaction: async (fn) => { fn({ consent: { _platform: { terms: { version: 't' } } } }); return { committed: true, snapshot: { val: () => committedVal } }; } }) });
    const U = 'u_' + 'i'.repeat(24);
    assert.deepStrictEqual(await S.setPromos(stub({ consent: { _platform: { terms: {}, promos: { value: false } } } }), { uid: U, rid: '_platform', value: true, now: 1, confirm: true }), { ok: true, value: false }, '🔴 the STORED value');
    for (const v of [null, { deleted_at: 9, consent: { _platform: { promos: { value: true } } } }, { consent: {} }, { consent: { _platform: { promos: { value: 'yes' } } } }])
      assert.deepStrictEqual(await S.setPromos(stub(v), { uid: U, rid: '_platform', value: true, now: 1, confirm: true }), { ok: false, reason: 'aborted' }, JSON.stringify(v));
    assert.deepStrictEqual(await S.setPromos(stub(null), { uid: U, rid: '_platform', value: true, now: 1 }), { ok: true }, 'without confirm: today\'s answer');
  }
  ok('Codex capp batch r1 #4: platform setPromos — own uid only (a body uid ignored), exactly one selector, boolean only, 401 without a customer token; consent/_platform/promos (what profileOf reads) with the platform copy version, terms kept; → {ok, value} READ BACK from the committed record; not_completed / legal_unconfigured; deleted_uids ⇒ 401 and deleted_at ⇒ 403 with nothing written; the forms\' {ok:true} unchanged');

  console.log(`\nsignup-platform: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
