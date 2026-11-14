'use strict';
// PLAN-3a-capp-push-tokens r0 + capp PLAN-capp-push-r1 §6b + Codex push r1 (3 P1 + 4 P2) — the customer push callables over the faithful
// RTDB double (test/_fake-rtdb-sdk, strict: the Admin SDK's speculative null-first transaction pass, orderByChild().equalTo(), hooks for
// interleavings). The email promos consent by the REAL signup writer; the sweep claim by the REAL sweepClaim; deletion by the REAL
// deleteAccountCore; the policy by the REAL writePushPolicy. Run: node customer-push.test.js
const assert = require('assert');
const { fakeRtdb } = require('./test/_fake-rtdb-sdk');
const CP = require('./customer-push');
const S = require('./signup-core');
const PP = require('./marketing/push-policy');
const SE = require('./signup-endpoints');
const ACCOUNT = require('./account-lib');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ customer-push: exited without completing (a hang)\n'); process.exitCode = 1; } });
const quietly = async (f) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`id-${A}`]: { uid: A, customer: true }, [`id-${B}`]: { uid: B, customer: true }, 'id-hh': { uid: A, customer: true, handheld: true }, 'id-staff': { uid: A } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
const LEGAL = { terms_url: 'https://sherpa.hn/t', privacy_url: 'https://sherpa.hn/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' };   // the ops CLI's platform legal config
let CLOCK = 1_800_000_000_000;
const DEV = (i) => `fcm_device_${String(i).padStart(2, '0')}_` + 'x'.repeat(40);
const IID = (i) => `install_${String(i).padStart(2, '0')}_` + 'q'.repeat(12);   // one installation per device index

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
    register: (uid, i, o = {}) => reg({ method: 'POST', token: `id-${uid}`, body: { token: DEV(i), platform: 'android', app_build: '1.4.0', install_id: IID(i), pedidos: true, promociones: false, ...o } }),
    unregister: (uid, i) => unreg({ method: 'POST', token: `id-${uid}`, body: { token: DEV(i) } }),
    setPrefs: (uid, p) => set({ method: 'POST', token: `id-${uid}`, body: p }),
    getPrefs: (uid, o = {}) => getp({ method: 'GET', token: `id-${uid}`, ...o }),
    raw: { reg, unreg, set, getp } };
}
const devices = (db, uid) => Object.entries(db.get(CP.TOKENS) || {}).filter(([, r]) => r && r.uid === uid);
const prefsNode = (db, uid) => db.get(`${CP.PREFS}/${uid}`) ?? null;
const deleteAcct = (db, uid, o = {}) => quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid, phoneHash: null, now: CLOCK, revoke: async () => {}, ...o }));

(async () => {
  try {
    // ── 1. admission + shape: 401 / 400 / 405 before any write ──
    {
      const w = world();
      const body = { token: DEV(1), platform: 'ios', app_build: '1', install_id: IID(1), pedidos: true, promociones: false };
      for (const [why, token] of [['no token', undefined], ['a bad token', 'id-nope'], ['a HANDHELD token', 'id-hh'], ['a non-customer token', 'id-staff']]) {
        assert.strictEqual((await w.raw.reg({ method: 'POST', token, body })).code, 401, `${why} ⇒ 401`);
      }
      const bad = [{ ...body, platform: 'web' }, { ...body, app_build: 'x'.repeat(33) }, { ...body, token: 'has space' }, { ...body, pedidos: 'yes' },
        (({ install_id, ...r }) => r)(body), { ...body, install_id: 'short' }, { ...body, uid: B }];
      for (const b of bad) assert.strictEqual((await w.raw.reg({ method: 'POST', token: `id-${A}`, body: b })).code, 400, `a bad register body ⇒ 400 (${JSON.stringify(b).slice(0, 70)})`);
      assert.strictEqual((await w.raw.set({ method: 'POST', token: `id-${A}`, body: { pedidos: true, promociones: false } })).code, 400, 'setPrefs without expected_rev ⇒ 400');
      assert.strictEqual((await w.raw.reg({ method: 'POST', token: `id-${A}`, query: {}, body })).code, 400, 'no ?context=platform ⇒ 400');
      assert.strictEqual((await w.raw.reg({ method: 'GET', token: `id-${A}` })).code, 405, 'GET on register ⇒ 405');
      assert.strictEqual((await w.raw.getp({ method: 'POST', token: `id-${A}` })).code, 405, 'POST on getPrefs ⇒ 405');
      assert.deepStrictEqual([w.db.get(CP.TOKENS) ?? null, w.db.get(CP.PREFS) ?? null], [null, null], 'nothing written');
      ok('admission: no / bad / handheld / non-customer token ⇒ 401; a bad body (install_id, expected_rev included) or no ?context ⇒ 400; the wrong method ⇒ 405 — nothing written');
    }

    // ── 2. register: ONE record per token; the prefs are INITIALIZED once (rev 1) and returned as stored; no token / hash in the response ──
    {
      const w = world();
      const r = await w.register(A, 1);
      assert.deepStrictEqual([r.code, r.body], [200, { ok: true, prefs: { pedidos: true, promociones: false, rev: 1 } }], 'registered; the prefs initialized at rev 1');
      const h = CP.hashOf(DEV(1));
      const rec = w.db.get(`${CP.TOKENS}/${h}`);
      assert.deepStrictEqual(Object.keys(rec).sort(), ['app_build', 'at', 'claim', 'install_id', 'platform', 'token', 'uid'], 'the record: uid, token, platform, app_build, install_id, at, claim');
      assert.deepStrictEqual([rec.uid, rec.token, rec.install_id, rec.at], [A, DEV(1), IID(1), CLOCK]);
      assert.ok(!JSON.stringify(r.body).includes(DEV(1)) && !JSON.stringify(r.body).includes(h.slice(0, 8)), 'the response never carries the token or its hash');
      assert.deepStrictEqual(w.rl.map((x) => `${x.bucket}:${x.key}`), [`push_register:${A}`], 'rate-limited by the VERIFIED uid, an explicit policy');
      ok('register: one sha256-keyed record (with its install_id); the prefs initialized once (rev 1) and returned as stored');
      // Codex P2: every register (a refresh too) ROTATES the claim — an old cleanup can never remove the refreshed registration
      const c0 = rec.claim; CLOCK += 1000;
      await w.register(A, 1, { app_build: '1.5.0' });
      assert.deepStrictEqual([w.db.get(`${CP.TOKENS}/${h}/app_build`), w.db.get(`${CP.TOKENS}/${h}/at`)], ['1.5.0', CLOCK], 'a refresh updates build + time…');
      assert.notStrictEqual(w.db.get(`${CP.TOKENS}/${h}/claim`), c0, '…and ROTATES the claim');
      assert.strictEqual(await CP.pruneCustomerToken(w.db, h, c0), false, 'a late prune with the pre-refresh claim never removes it');
      ok('a refresh rotates the claim (a stale prune never removes the refreshed registration)');
    }

    // ── 3. Codex P2: a device moves to another account ONLY on the SAME installation; a replayed token from another install is refused ──
    {
      const w = world();
      await w.register(A, 1);
      const h = CP.hashOf(DEV(1)); const before = w.db.get(`${CP.TOKENS}/${h}`);
      const replay = await w.register(B, 1, { install_id: IID(9) });
      assert.deepStrictEqual([replay.code, replay.body.reason], [409, 'token_in_use'], 'another account replaying the token from ANOTHER install ⇒ 409 token_in_use');
      assert.deepStrictEqual(w.db.get(`${CP.TOKENS}/${h}`), before, 'A\'s registration is untouched');
      const sw = await w.register(B, 1);   // the same installation, another account signed in (a uid switch / a shared phone)
      assert.strictEqual(sw.code, 200, 'the same installation ⇒ the device moves to the signed-in account');
      assert.deepStrictEqual([w.db.get(`${CP.TOKENS}/${h}/uid`), devices(w.db, A).length], [B, 0], 'B holds it now; A no longer does');
      assert.notStrictEqual(w.db.get(`${CP.TOKENS}/${h}/claim`), before.claim, 'with a new claim');
      ok('a device moves to another account only on the same installation (install_id); a replay from another install ⇒ 409, untouched');
    }

    // ── 4. the cap: DEVICE_MAX per person, the oldest evicted ──
    {
      const w = world();
      for (let i = 0; i < CP.DEVICE_MAX + 2; i++) { CLOCK += 1000; assert.strictEqual((await w.register(A, i)).code, 200); }
      const mine = devices(w.db, A).map(([hh]) => hh);
      assert.strictEqual(mine.length, CP.DEVICE_MAX, `at most ${CP.DEVICE_MAX} devices per person`);
      assert.ok(!mine.includes(CP.hashOf(DEV(0))) && !mine.includes(CP.hashOf(DEV(1))) && mine.includes(CP.hashOf(DEV(CP.DEVICE_MAX + 1))), 'the two OLDEST evicted, the newest stays');
      ok(`the cap: ${CP.DEVICE_MAX} devices per person, the oldest evicted`);
    }

    // ── 5. the push switch IS the consent (owner 11-14); Codex P1: a register NEVER touches the prefs / consent; stale pref writes refused ──
    {
      const w = world();
      const r = await w.register(A, 1, { promociones: true });
      assert.deepStrictEqual(r.body, { ok: true, prefs: { pedidos: true, promociones: true, rev: 1 } }, `push offers ON with NO email/WhatsApp consent ⇒ 200 (${JSON.stringify(r.body)})`);
      assert.deepStrictEqual(prefsNode(w.db, A).offers_consent, { channel: 'push', value: true, copy_version: CP.PUSH_OFFERS_COPY_VERSION, at: CLOCK }, 'the push-offers consent record is written at initialization');
      // a withdrawal on device 2, then device 1 REFRESHES carrying its old promociones = true ⇒ the withdrawal stands
      CLOCK += 1000;
      assert.deepStrictEqual((await w.setPrefs(A, { pedidos: true, promociones: false, expected_rev: 1 })).body, { ok: true, prefs: { pedidos: true, promociones: false, rev: 2 } }, 'withdrawn (rev 2)');
      const tOff = CLOCK; CLOCK += 1000;
      const refresh = await w.register(A, 1, { promociones: true });
      assert.deepStrictEqual(refresh.body.prefs, { pedidos: true, promociones: false, rev: 2 }, 'a token refresh NEVER rewrites the prefs: the withdrawal stands (returned as stored)');
      assert.deepStrictEqual([prefsNode(w.db, A).offers_consent.value, prefsNode(w.db, A).offers_consent.at], [false, tOff], 'and never re-consents');
      ok('a register never touches prefs or consent: a refresh after a withdrawal on another device keeps the withdrawal');
      const stale = await w.setPrefs(A, { pedidos: false, promociones: true, expected_rev: 1 });
      assert.deepStrictEqual([stale.code, stale.body.reason, stale.body.prefs], [409, 'stale_prefs', { pedidos: true, promociones: false, rev: 2 }], 'a STALE pref write (expected_rev 1 < 2) ⇒ 409 stale_prefs with the current prefs');
      assert.strictEqual(prefsNode(w.db, A).rev, 2, 'nothing written');
      // the email promos consent (the REAL signup writer) never moves the push one; the sender's gate reads only the push record
      assert.deepStrictEqual((await S.completeProfile(w.db, { uid: A, rid: S.PLATFORM_SCOPE, email: 'ana@gmail.com', acceptTerms: true, promos: true, now: 5 })).ok, true, 'premise: email promos ON');
      assert.strictEqual(CP.pushOffersConsented(prefsNode(w.db, A)), false, 'email promos ON never lets an offer push through while push offers are OFF');
      assert.deepStrictEqual((await w.setPrefs(A, { pedidos: true, promociones: true, expected_rev: 2 })).body.prefs, { pedidos: true, promociones: true, rev: 3 });
      assert.deepStrictEqual((await S.setPromos(w.db, { uid: A, rid: S.PLATFORM_SCOPE, value: false, now: 6 })).ok, true, 'premise: email promos OFF');
      assert.strictEqual(CP.pushOffersConsented(prefsNode(w.db, A)), true, 'email promos OFF does NOT turn push offers off');
      const t3 = prefsNode(w.db, A).offers_consent.at; CLOCK += 1000;
      await w.setPrefs(A, { pedidos: false, promociones: true, expected_rev: 3 });
      assert.strictEqual(prefsNode(w.db, A).offers_consent.at, t3, 'a pedidos-only change keeps the consent record as it was');
      assert.strictEqual(CP.pushOffersConsented(null), false, 'no prefs ⇒ no');
      assert.strictEqual(CP.pushOffersConsented({ pedidos: true, promociones: true, rev: 1 }), false, 'a prefs node without the consent record ⇒ no (never inferred)');
      ok('stale pref writes ⇒ 409 stale_prefs; the push consent is per channel (the email consent never moves it; the gate reads only the push record)');
    }

    // ── 6. unregister: compare-and-clear on the caller's uid; idempotent ──
    {
      const w = world();
      await w.register(A, 1); await w.register(B, 2);
      assert.deepStrictEqual((await w.unregister(A, 2)).body, { ok: true }, 'another person\'s device: 200 (no oracle)…');
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${CP.hashOf(DEV(2))}/uid`), B, '…and untouched');
      assert.deepStrictEqual((await w.unregister(A, 1)).body, { ok: true });
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${CP.hashOf(DEV(1))}`) ?? null, null, 'the caller\'s own device is removed');
      assert.deepStrictEqual((await w.unregister(A, 1)).body, { ok: true }, 'idempotent: absent ⇒ ok');
      ok('unregister: only the caller\'s own registration is removed; another person\'s is untouched; idempotent');
    }

    // ── 7. getCustomerPushPrefs: prefs | null (with rev) + the limits of the REAL policy; a policy read error ⇒ 503 (fail closed) ──
    {
      const w = world();
      assert.deepStrictEqual((await w.getPrefs(A)).body, { ok: true, prefs: null, limits: PP.DEFAULTS }, 'nothing chosen yet ⇒ prefs null; never configured ⇒ the default limits');
      await w.register(A, 1);
      assert.deepStrictEqual((await PP.writePushPolicy(w.db, { expected: 0, policy: { promo_daily_max: 2, promo_weekly_max: 6, quiet_from: 1320, quiet_to: 480 }, actor: 'cli:op', now: 9 })).ok, true, 'premise: the owner raised the frequency');
      const g = await w.getPrefs(A);
      assert.deepStrictEqual(g.body, { ok: true, prefs: { pedidos: true, promociones: false, rev: 1 }, limits: { promo_daily_max: 2, promo_weekly_max: 6, quiet_from: 1320, quiet_to: 480 } });
      assert.ok(!JSON.stringify(g.body).includes(DEV(1)), 'never a token');
      await w.db.ref('platform_config/push/quiet_to').set(1320);   // a corrupt configured policy (from === to)
      assert.deepStrictEqual([(await w.getPrefs(A)).code, (await w.getPrefs(A)).body.reason], [503, 'unavailable'], 'a configured policy that cannot be read as valid ⇒ 503 (fail closed)');
      assert.strictEqual((await w.getPrefs(A, { query: { context: 'platform', x: '1' } })).code, 400, 'an extra query field ⇒ 400');
      ok('getCustomerPushPrefs: prefs (with rev) + the REAL policy\'s limits; a bad / unreadable configured policy ⇒ 503');
    }

    // ── 8. a deleted account: 403 before any write; a deletion landing DURING a register leaves nothing behind ──
    {
      const w = world();
      assert.strictEqual(await S.sweepClaim(w.db, A, 10, 50), 'claimed', 'premise: the REAL sweep claim');
      assert.deepStrictEqual([(await w.register(A, 1)).code, w.db.get(CP.TOKENS) ?? null], [403, null], 'a claimed account ⇒ 403, nothing written');
      const w2 = world();
      w2.db.hooks[`${CP.TOKENS}/${CP.hashOf(DEV(1))}`] = async () => { assert.strictEqual(await deleteAcct(w2.db, A), true, 'premise: the REAL deletion ran'); };   // before the register's token txn
      const r = await w2.register(A, 1);
      assert.deepStrictEqual([r.code, r.body.reason], [403, 'deleted'], 'a deletion landing mid-register ⇒ 403');
      assert.deepStrictEqual([devices(w2.db, A).length, (prefsNode(w2.db, A) || {})._deleted !== undefined], [0, true], 'no device survives; the prefs hold only the deletion fence');
      ok('a deleted account ⇒ 403 before any write; a deletion landing mid-register leaves no device behind');
    }

    // ── 9. Codex P1: setPrefs can NEVER resurrect prefs / consent after a deletion (the durable fence inside the prefs txn) ──
    {
      const w = world();
      await w.register(A, 1, { promociones: true });
      w.db.hooks[`${CP.PREFS}/${A}`] = async () => { assert.strictEqual(await deleteAcct(w.db, A), true, 'premise: the REAL deletion ran'); };   // admit passed; the deletion lands before the prefs txn
      const r = await w.setPrefs(A, { pedidos: true, promociones: true, expected_rev: 1 });
      assert.deepStrictEqual([r.code, r.body.reason], [403, 'deleted'], 'a setPrefs racing the deletion ⇒ 403');
      assert.deepStrictEqual(Object.keys(prefsNode(w.db, A)), ['_deleted'], 'the prefs stay the deletion FENCE — no prefs, no consent resurrected');
      assert.strictEqual(CP.pushOffersConsented(prefsNode(w.db, A)), false, 'and the sender\'s gate says no');
      ok('the durable deletion fence: a setPrefs racing a deletion never resurrects prefs or consent');
    }

    // ── 10. deletion (the REAL deleteAccountCore, deleteAccount AND the sweep): fence first (atomic), then discover, then drain ──
    {
      for (const via of ['deleteAccount', 'the inactivity sweep']) {
        const w = world();
        await w.register(A, 1, { promociones: true }); await w.register(A, 2); await w.register(B, 3);
        const done = await deleteAcct(w.db, A, via === 'deleteAccount' ? {} : { sweepCutoff: CLOCK });
        assert.strictEqual(done, true, `premise: ${via} ran`);
        assert.deepStrictEqual([devices(w.db, A).length, Object.keys(prefsNode(w.db, A) || {})], [0, ['_deleted']], `${via}: every device drained; the prefs are the deletion fence`);
        const atomic = w.db.writes.find(([kind, , v]) => kind === 'update' && v && Object.prototype.hasOwnProperty.call(v, `user_profiles/${A}`));
        assert.ok(atomic && Object.prototype.hasOwnProperty.call(atomic[2], `${CP.PREFS}/${A}`), `${via}: the prefs fence rides the SAME atomic update as the profile`);
        assert.strictEqual(devices(w.db, B).length, 1, `${via}: another person's device is untouched`);
      }
      ok('deletion: the prefs fence rides the profile\'s atomic update; every device is then discovered and drained; others untouched');
      // Codex P2: a SHARED device — the deletion discovered A's registration, but B re-registered it (same install) before the drain ⇒ B keeps it
      const w = world();
      await w.register(A, 1);
      const h = CP.hashOf(DEV(1));
      w.db.hooks[`${CP.TOKENS}/${h}`] = async () => { assert.strictEqual((await w.register(B, 1)).code, 200, 'premise: B took the shared device'); };   // before the deletion's drain txn
      assert.strictEqual(await deleteAcct(w.db, A), true);
      assert.strictEqual(w.db.get(`${CP.TOKENS}/${h}/uid`), B, 'deleting A never removes B\'s newer registration of the shared device (uid + claim compare)');
      ok('a shared device re-registered by another account between discovery and drain is never removed by the deletion');
      // Codex P1: FENCE first, then discover, then drain — a register landing during the drain finds the fence (403) and no device survives
      const w3 = world();
      await w3.register(A, 1);
      let late = null;
      w3.db.hooks[`${CP.TOKENS}/${CP.hashOf(DEV(1))}`] = async () => { late = await w3.register(A, 2); };   // during the drain of device 1, A registers device 2
      assert.strictEqual(await deleteAcct(w3.db, A), true);
      assert.strictEqual(late && late.code, 403, `a register landing during the drain is refused (the fence is already in) (${JSON.stringify(late && late.body)})`);
      assert.strictEqual(devices(w3.db, A).length, 0, 'no device of the deleted account survives (fence → discover → drain)');
      ok('fence → discover → drain: a register landing during the drain is refused; no device survives the deletion');
    }

    // ── 11. pruneCustomerToken (the sender's FCM terminal-error prune): compare-and-clear on the claim ──
    {
      const w = world();
      await w.register(A, 1);
      const h = CP.hashOf(DEV(1));
      const old = w.db.get(`${CP.TOKENS}/${h}/claim`);
      await w.register(B, 1);
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
