'use strict';
// PLAN-3a-capp-push-tokens r0 + capp PLAN-capp-push-r1 §6b — the customer push callables over the faithful RTDB double
// (test/_fake-rtdb-sdk, strict: the Admin SDK's speculative null-first transaction pass, orderByChild().equalTo()). The promos consent
// by the REAL signup writer (signup-core completeProfile / setPromos, platform scope); the sweep claim by the REAL sweepClaim; the
// policy by the REAL writePushPolicy. Run: node customer-push.test.js
const assert = require('assert');
const { fakeRtdb } = require('./test/_fake-rtdb-sdk');
const CP = require('./customer-push');
const S = require('./signup-core');
const PP = require('./marketing/push-policy');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ customer-push: exited without completing (a hang)\n'); process.exitCode = 1; } });
const quietly = async (f) => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`id-${A}`]: { uid: A, customer: true }, [`id-${B}`]: { uid: B, customer: true }, 'id-hh': { uid: A, customer: true, handheld: true }, 'id-staff': { uid: A } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
const LEGAL = { terms_url: 'https://sherpa.hn/t', privacy_url: 'https://sherpa.hn/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' };   // the ops CLI's platform legal config
let CLOCK = 1_800_000_000_000;

function world() {
  const db = fakeRtdb({ platform_config: { legal: LEGAL }, user_profiles: { [A]: { phone: '50499990000', phone_hash: 'ph_a', created_at: 1, last_login: 1 }, [B]: { phone: '50499990001', phone_hash: 'ph_b', created_at: 1, last_login: 1 } } }, { strict: true });
  const rl = [];
  const h = CP.makeCustomerPush({ getDatabase: () => db, getAuth: () => auth, now: () => CLOCK,
    checkRateLimit: async (_db, bucket, key, policy) => { assert.ok(policy && policy.windowMs > 0 && policy.max > 0, `🔴 ${bucket}: an explicit limiter policy`); rl.push({ bucket, key }); return { allowed: true }; } });
  const mk = (handler) => async ({ method, token, query = { context: 'platform' }, body } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query, body, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await quietly(() => handler(req, res)); return res;
  };
  const reg = mk(h.registerCustomerPushToken), unreg = mk(h.unregisterCustomerPushToken), set = mk(h.setCustomerPushPrefs), getp = mk(h.getCustomerPushPrefs);
  return { db, rl,
    register: (uid, token, o = {}) => reg({ method: 'POST', token: `id-${uid}`, body: { token, platform: 'android', app_build: '1.4.0', pedidos: true, promociones: false, ...o } }),
    unregister: (uid, token) => unreg({ method: 'POST', token: `id-${uid}`, body: { token } }),
    setPrefs: (uid, p) => set({ method: 'POST', token: `id-${uid}`, body: p }),
    getPrefs: (uid, o = {}) => getp({ method: 'GET', token: `id-${uid}`, ...o }),
    raw: { reg, unreg, set, getp } };
}
const devices = (db, uid) => Object.entries(db.get(CP.TOKENS) || {}).filter(([, r]) => r && r.uid === uid);
const DEV = (i) => `fcm_device_${String(i).padStart(2, '0')}_` + 'x'.repeat(40);

(async () => {
  try {
    // ── 1. admission + shape: 401 / 400 / 405 before any write ──
    {
      const w = world();
      for (const [why, token] of [['no token', undefined], ['a bad token', 'id-nope'], ['a HANDHELD token', 'id-hh'], ['a non-customer token', 'id-staff']]) {
        assert.strictEqual((await w.raw.reg({ method: 'POST', token, body: { token: DEV(1), platform: 'ios', app_build: '1', pedidos: true, promociones: false } })).code, 401, `${why} ⇒ 401`);
      }
      const bad = [{ token: DEV(1), platform: 'web', app_build: '1', pedidos: true, promociones: false }, { token: DEV(1), platform: 'ios', app_build: 'x'.repeat(33), pedidos: true, promociones: false },
        { token: 'has space', platform: 'ios', app_build: '1', pedidos: true, promociones: false }, { token: DEV(1), platform: 'ios', app_build: '1', pedidos: 'yes', promociones: false },
        { token: DEV(1), platform: 'ios', app_build: '1', pedidos: true }, { token: DEV(1), platform: 'ios', app_build: '1', pedidos: true, promociones: false, uid: B }];
      for (const body of bad) assert.strictEqual((await w.raw.reg({ method: 'POST', token: `id-${A}`, body })).code, 400, `a bad register body ⇒ 400 (${JSON.stringify(body).slice(0, 60)})`);
      assert.strictEqual((await w.raw.reg({ method: 'POST', token: `id-${A}`, query: {}, body: { token: DEV(1), platform: 'ios', app_build: '1', pedidos: true, promociones: false } })).code, 400, 'no ?context=platform ⇒ 400');
      assert.strictEqual((await w.raw.reg({ method: 'GET', token: `id-${A}` })).code, 405, 'GET on register ⇒ 405');
      assert.strictEqual((await w.raw.getp({ method: 'POST', token: `id-${A}` })).code, 405, 'POST on getPrefs ⇒ 405');
      assert.strictEqual(w.db.get(CP.TOKENS) ?? null, null, 'nothing written');
      ok('admission: no / bad / handheld / non-customer token ⇒ 401; a bad body or no ?context=platform ⇒ 400; the wrong method ⇒ 405 — nothing written');
    }

    // ── 2. register: ONE record per token (sha256-keyed), the prefs once per person; the response never carries a token or hash ──
    {
      const w = world();
      const r = await w.register(A, DEV(1));
      assert.deepStrictEqual([r.code, r.body], [200, { ok: true, prefs: { pedidos: true, promociones: false } }], 'registered');
      const h = CP.hashOf(DEV(1));
      const rec = w.db.get(`${CP.TOKENS}/${h}`);
      assert.deepStrictEqual(Object.keys(rec).sort(), ['app_build', 'at', 'claim', 'platform', 'token', 'uid'], 'the record: uid, token, platform, app_build, at, claim');
      assert.deepStrictEqual([rec.uid, rec.token, rec.platform, rec.app_build, rec.at], [A, DEV(1), 'android', '1.4.0', CLOCK]);
      assert.deepStrictEqual(w.db.get(`${CP.PREFS}/${A}`), { pedidos: true, promociones: false, at: CLOCK }, 'the prefs, once per person');
      assert.ok(!JSON.stringify(r.body).includes(DEV(1)) && !JSON.stringify(r.body).includes(h.slice(0, 8)), 'the response never carries the token or its hash');
      assert.deepStrictEqual(w.rl.map((x) => `${x.bucket}:${x.key}`), [`push_register:${A}`], 'rate-limited by the VERIFIED uid, an explicit policy');
      ok('register: one sha256-keyed record { uid, token, platform, app_build, at, claim }; prefs once per person; no token / hash in the response');
      // a refresh keeps the claim; another person's registration of the SAME device moves it (a uid switch / a shared phone)
      const c0 = rec.claim;
      CLOCK += 1000;
      await w.register(A, DEV(1), { app_build: '1.5.0' });
      assert.deepStrictEqual([w.db.get(`${CP.TOKENS}/${h}/claim`), w.db.get(`${CP.TOKENS}/${h}/app_build`), w.db.get(`${CP.TOKENS}/${h}/at`)], [c0, '1.5.0', CLOCK], 'a refresh keeps the claim, updates the build and time');
      await w.register(B, DEV(1));
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${h}/uid`), B, 'the device MOVES to the signed-in person');
      assert.notStrictEqual(w.db.get(`${CP.TOKENS}/${h}/claim`), c0, 'with a NEW claim (an old cleanup can never remove it)');
      assert.deepStrictEqual(devices(w.db, A), [], 'A no longer holds it');
      ok('a refresh keeps the claim; another person\'s registration of the same device moves it (new claim)');
    }

    // ── 3. the cap: DEVICE_MAX per person, the oldest evicted ──
    {
      const w = world();
      for (let i = 0; i < CP.DEVICE_MAX + 2; i++) { CLOCK += 1000; assert.strictEqual((await w.register(A, DEV(i))).code, 200); }
      const mine = devices(w.db, A).map(([hh]) => hh).sort();
      assert.strictEqual(mine.length, CP.DEVICE_MAX, `at most ${CP.DEVICE_MAX} devices per person`);
      assert.ok(!mine.includes(CP.hashOf(DEV(0))) && !mine.includes(CP.hashOf(DEV(1))), 'the two OLDEST were evicted');
      assert.ok(mine.includes(CP.hashOf(DEV(CP.DEVICE_MAX + 1))), 'the newest stays');
      ok(`the cap: ${CP.DEVICE_MAX} devices per person, the oldest evicted`);
    }

    // ── 4. promociones needs the PLATFORM promos consent (the REAL signup writer) — refused before ANY write ──
    {
      const w = world();
      const r = await w.register(A, DEV(1), { promociones: true });
      assert.deepStrictEqual([r.code, r.body.reason], [409, 'promos_consent_required'], 'no consent ⇒ 409 promos_consent_required');
      assert.deepStrictEqual([w.db.get(CP.TOKENS) ?? null, w.db.get(CP.PREFS) ?? null], [null, null], 'refused before ANY write (no token, no prefs)');
      assert.deepStrictEqual((await S.completeProfile(w.db, { uid: A, rid: S.PLATFORM_SCOPE, email: 'ana@gmail.com', acceptTerms: true, promos: false, now: 5 })).ok, true, 'premise: the real platform profile (promos OFF)');
      assert.strictEqual((await w.register(A, DEV(1), { promociones: true })).code, 409, 'consent recorded as OFF ⇒ still 409');
      assert.strictEqual((await w.setPrefs(A, { pedidos: true, promociones: true })).body.reason, 'promos_consent_required', 'setPrefs: the same rule');
      assert.deepStrictEqual((await S.setPromos(w.db, { uid: A, rid: S.PLATFORM_SCOPE, value: true, now: 6 })).ok, true, 'premise: the REAL writer turns platform promos ON');
      assert.deepStrictEqual((await w.register(A, DEV(1), { promociones: true })).body, { ok: true, prefs: { pedidos: true, promociones: true } }, 'with consent ⇒ registered with promociones');
      assert.deepStrictEqual((await w.setPrefs(A, { pedidos: false, promociones: true })).body, { ok: true, prefs: { pedidos: false, promociones: true } }, 'setPrefs with consent');
      assert.deepStrictEqual((await w.setPrefs(A, { pedidos: true, promociones: false })).body, { ok: true, prefs: { pedidos: true, promociones: false } }, 'turning promos OFF never needs consent');
      ok('promociones requires the platform promos consent (the REAL writer): 409 promos_consent_required before any write; OFF always allowed');
    }

    // ── 5. unregister: compare-and-clear on the caller's uid; idempotent ──
    {
      const w = world();
      await w.register(A, DEV(1)); await w.register(B, DEV(2));
      assert.deepStrictEqual((await w.unregister(A, DEV(2))).body, { ok: true }, 'another person\'s device: 200 (no oracle)…');
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${CP.hashOf(DEV(2))}/uid`), B, '…and untouched');
      assert.deepStrictEqual((await w.unregister(A, DEV(1))).body, { ok: true });
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${CP.hashOf(DEV(1))}`) ?? null, null, 'the caller\'s own device is removed');
      assert.deepStrictEqual((await w.unregister(A, DEV(1))).body, { ok: true }, 'idempotent: absent ⇒ ok');
      ok('unregister: only the caller\'s own registration is removed; another person\'s is untouched; idempotent');
    }

    // ── 6. getCustomerPushPrefs: prefs | null + the limits from the REAL policy (owner-editable) ──
    {
      const w = world();
      assert.deepStrictEqual((await w.getPrefs(A)).body, { ok: true, prefs: null, limits: PP.DEFAULTS }, 'nothing chosen yet ⇒ prefs null; the default limits');
      await w.register(A, DEV(1));
      assert.deepStrictEqual((await PP.writePushPolicy(w.db, { expected: 0, policy: { promo_daily_max: 2, promo_weekly_max: 6, quiet_from: 1320, quiet_to: 480 }, actor: 'cli:op', now: 9 })).ok, true, 'premise: the owner raised the frequency');
      const g = await w.getPrefs(A);
      assert.deepStrictEqual(g.body, { ok: true, prefs: { pedidos: true, promociones: false }, limits: { promo_daily_max: 2, promo_weekly_max: 6, quiet_from: 1320, quiet_to: 480 } });
      assert.ok(!JSON.stringify(g.body).includes(DEV(1)) && !JSON.stringify(g.body).includes(CP.hashOf(DEV(1)).slice(0, 8)), 'never a token or a hash');
      assert.strictEqual((await w.getPrefs(A, { query: { context: 'platform', x: '1' } })).code, 400, 'an extra query field ⇒ 400');
      ok('getCustomerPushPrefs: the person\'s prefs (null before any choice) + the limits the REAL policy holds; never a token');
    }

    // ── 7. a deleted account: 403 before any write; a deletion landing DURING a register leaves nothing behind ──
    {
      const w = world();
      assert.strictEqual(await S.sweepClaim(w.db, A, 10, 50), 'claimed', 'premise: the REAL sweep claim');
      assert.deepStrictEqual([(await w.register(A, DEV(1))).code, w.db.get(CP.TOKENS) ?? null], [403, null], 'a claimed account ⇒ 403, nothing written');
      const w2 = world();
      const orig = w2.db.ref;
      let armed = true;
      w2.db.ref = (p) => { const r = orig(p);
        if (armed && p === CP.TOKENS) return { ...r, orderByChild: (c) => { armed = false; return { equalTo: (x) => ({ once: async () => { await S.sweepClaim(w2.db, A, 10, 50); return r.orderByChild(c).equalTo(x).once(); } }) }; } };
        return r; };   // the sweep claims the account AFTER the token write, before the register's own re-check
      const r = await w2.register(A, DEV(1));
      w2.db.ref = orig;
      assert.deepStrictEqual([r.code, r.body.reason], [403, 'deleted'], 'a deletion landing mid-register ⇒ 403');
      assert.deepStrictEqual([w2.db.get(`${CP.TOKENS}/${CP.hashOf(DEV(1))}`) ?? null, w2.db.get(`${CP.PREFS}/${A}`) ?? null], [null, null], 'and NOTHING is left behind (token + prefs cleared)');
      ok('a deleted account ⇒ 403 before any write; a deletion landing mid-register ⇒ its own token and prefs are cleared');
    }

    // ── 8. pruneCustomerToken (the sender's FCM terminal-error prune): compare-and-clear on the claim ──
    {
      const w = world();
      await w.register(A, DEV(1));
      const h = CP.hashOf(DEV(1));
      const old = w.db.get(`${CP.TOKENS}/${h}/claim`);
      await w.register(B, DEV(1));   // the device moved: a NEW registration
      assert.strictEqual(await CP.pruneCustomerToken(w.db, h, old), false, 'a late prune with the OLD claim…');
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${h}/uid`), B, '…never removes the newer registration');
      assert.strictEqual(await CP.pruneCustomerToken(w.db, h, w.db.get(`${CP.TOKENS}/${h}/claim`)), true);
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${h}`) ?? null, null, 'the current claim ⇒ removed');
      ok('pruneCustomerToken: compare-and-clear on the claim — a late prune never removes a newer registration');
    }

    FINISHED = true;
    console.log(`customer-push: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
