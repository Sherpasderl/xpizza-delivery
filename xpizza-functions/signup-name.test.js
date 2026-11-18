'use strict';
// Calificaciones v2 S3 (PLAN-3a-merchant-reviews-v2 r3 §3; advisor 11-15: 3a ships every server piece) — the STRUCTURED name
// (given_name + family_name) lives in user_private/{uid}, written ONLY inside the fenced transactions that abort on the deletion
// tombstone: completeProfile (optional fields) and setMyName (a later edit). Deletion REPLACES user_private/{uid} with { deleted_at }
// in its one atomic update, so a name never outlives the account. The REAL cores and handlers (signup-core, signup-endpoints) and the
// REAL deleteAccountCore at BOTH deletion paths (deleteAccount; the inactivity sweep) over merchant/_fake-db, whose transaction is
// RTDB's compare-and-set (afterUpdater commits a deletion between the name updater's run and its put ⇒ the updater re-runs).
// Run: node signup-name.test.js
const assert = require('assert');
const { createFakeDb } = require('./merchant/_fake-db');
const S = require('./signup-core');
const SE = require('./signup-endpoints');
const ACCOUNT = require('./account-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 signup-name: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });

const UID = 'u_' + 'n'.repeat(24), PH = 'ph_n';
const LEGAL = { terms_url: 'https://x/t', privacy_url: 'https://x/p', terms_version: 't1', privacy_version: 'p1', promos_copy_version: 'c1' };
function seeded() {
  return createFakeDb({
    user_profiles: { [UID]: { phone: '50499990000', phone_hash: PH, created_at: 1, last_login: 1 } },
    user_private: { [UID]: { email: 'ana@x.hn', last_active: 5 } },
    phone_index: { [PH]: UID },
    restaurants: { x_pizza: { legal: LEGAL } },
  });
}
const revoke = async () => {};
const deleteNow = (db) => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 1000, revoke });
const sweepNow = (db) => SE.deleteAccountCore(db, ACCOUNT, { uid: UID, phoneHash: PH, now: 1000, sweepCutoff: 500, revoke });
const complete = (db, extra = {}) => S.completeProfile(db, { uid: UID, rid: 'x_pizza', email: 'ana@x.hn', acceptTerms: true, promos: false, now: 100, ...extra });
const setName = (db, givenName, familyName) => S.setMyName(db, { uid: UID, givenName, familyName });

(async () => {
  // ── 1. the fields: both or neither, 1..40 trimmed; written inside the completeProfile / setMyName transaction ──
  {
    const db = seeded();
    assert.deepStrictEqual(await complete(db, { givenName: '  Ana ', familyName: ' Pérez  ' }), { ok: true });
    assert.deepStrictEqual([db.get(`user_private/${UID}/given_name`), db.get(`user_private/${UID}/family_name`)], ['Ana', 'Pérez'], 'completeProfile stores the trimmed structured name');
    for (const [g, f] of [['Ana', undefined], [undefined, 'Pérez'], ['', 'Pérez'], ['  ', 'Pérez'], ['Ana', 'x'.repeat(41)], [7, 'Pérez'], ['Ana', null]]) {
      const before = db.get(`user_private/${UID}`);
      assert.deepStrictEqual(await complete(db, { givenName: g, familyName: f }), { ok: false, reason: 'bad_request' }, `completeProfile: ${JSON.stringify([g, f])} ⇒ bad_request`);
      assert.deepStrictEqual(await setName(db, g, f), { ok: false, reason: 'bad_request' }, `setMyName: ${JSON.stringify([g, f])} ⇒ bad_request`);
      assert.deepStrictEqual(db.get(`user_private/${UID}`), before, 'a refused name writes nothing');
    }
    assert.deepStrictEqual(await complete(db), { ok: true }, 'completeProfile without a name still works');
    assert.deepStrictEqual([db.get(`user_private/${UID}/given_name`), db.get(`user_private/${UID}/family_name`)], ['Ana', 'Pérez'], 'no name fields ⇒ the stored name is kept');
    assert.deepStrictEqual(await setName(db, ' Bea ', 'Zúñiga'), { ok: true });
    assert.deepStrictEqual([db.get(`user_private/${UID}/given_name`), db.get(`user_private/${UID}/family_name`), db.get(`user_private/${UID}/email`)], ['Bea', 'Zúñiga', 'ana@x.hn'], 'setMyName replaces the name and keeps the rest of the node');
    assert.strictEqual(db.get(`user_profiles/${UID}/name`), null, 'the profile `name` is never derived or written');
  }
  ok('the structured name: both or neither, 1..40 trimmed, written by completeProfile / setMyName into user_private only');

  // ── 2. the name transaction PAUSED, a deletion commits, the transaction resumes ⇒ re-run on the tombstone ⇒ aborted, no name ──
  for (const [label, del] of [['deleteAccount', deleteNow], ['the inactivity sweep', sweepNow]]) {
    for (const [writer, write] of [['completeProfile', (db) => complete(db, { givenName: 'Ana', familyName: 'Pérez' })], ['setMyName', (db) => setName(db, 'Ana', 'Pérez')]]) {
      const db = seeded();
      db.hooks.afterUpdater = async (p) => { assert.strictEqual(p, `user_private/${UID}`, 'premise: the hook interleaves the name transaction'); assert.strictEqual(await del(db), true, `premise: ${label} committed`); };
      const r = await write(db);
      assert.deepStrictEqual(r, { ok: false, reason: 'deleted' }, `name txn paused, ${label} commits, resumed ⇒ aborted (${writer})`);
      assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 1000 }, `after ${label}, user_private is { deleted_at } only (${writer})`);
    }
  }
  ok('a name write paused across a deletion (deleteAccount AND the sweep) re-runs on the tombstone and aborts: no name survives');

  // ── 2b. a deletion that commits RIGHT AFTER the name transaction commits ⇒ the name is gone (it lived only in the fenced node) ──
  for (const [label, del] of [['deleteAccount', deleteNow], ['the inactivity sweep', sweepNow]]) {
    for (const [writer, write] of [['completeProfile', (db) => complete(db, { givenName: 'Ana', familyName: 'Pérez' })], ['setMyName', (db) => setName(db, 'Ana', 'Pérez')]]) {
      const db = seeded();
      const real = db.ref; let armed = true;
      const racing = { ...db, ref: (p) => {
        const r = real(p);
        if (armed && p === `user_private/${UID}`) return { ...r, transaction: async (fn) => { const out = await r.transaction(fn); armed = false; assert.strictEqual(await del(db), true, `premise: ${label} committed`); return out; } };
        return r;
      } };
      assert.deepStrictEqual(await write(racing), { ok: true }, `premise: the ${writer} transaction committed first`);
      assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 1000 }, `deletion right after the name txn commits ⇒ no name survives (${writer}, ${label})`);
    }
  }
  ok('a deletion right after the name transaction leaves { deleted_at } only — the name is never a second write');

  // ── 3. the DELETION paused mid-flight (after its reads, before its update), a name write commits ⇒ wiped by the deletion's update ──
  for (const [label, del] of [['deleteAccount', deleteNow], ['the inactivity sweep', sweepNow]]) {
    const db = seeded();
    const real = db.ref; let armed = true;
    const paused = { ...db, ref: (p) => {
      const r = real(p);
      if (armed && p === `user_orders/${UID}`) { armed = false; return { ...r, once: async (...a) => { assert.deepStrictEqual(await setName(db, 'Ana', 'Pérez'), { ok: true }, 'premise: the name committed mid-deletion'); return r.once(...a); } }; }
      return r;
    } };
    assert.strictEqual(await SE.deleteAccountCore(paused, ACCOUNT, { uid: UID, phoneHash: PH, now: 1000, revoke, ...(del === sweepNow ? { sweepCutoff: 500 } : {}) }), true, `premise: ${label} completed`);
    assert.ok(!armed, 'premise: the name write ran inside the deletion');
    assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 1000 }, `deletion paused, a name write, the update ⇒ the name is wiped (${label})`);
  }
  ok('a name written while a deletion is in flight is wiped by the deletion\'s one atomic update (both paths)');

  // ── 4. after a deletion: user_private is { deleted_at } only and every name write is refused ──
  {
    const db = seeded();
    assert.deepStrictEqual(await setName(db, 'Ana', 'Pérez'), { ok: true });
    assert.strictEqual(await deleteNow(db), true);
    assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 1000 }, 'a name written before the deletion is wiped atomically');
    assert.deepStrictEqual(await setName(db, 'Ana', 'Pérez'), { ok: false, reason: 'deleted' }, 'after deletion: setMyName refused');
    assert.deepStrictEqual(await complete(db, { givenName: 'Ana', familyName: 'Pérez' }), { ok: false, reason: 'deleted' }, 'after deletion: completeProfile refused');
    assert.deepStrictEqual(db.get(`user_private/${UID}`), { deleted_at: 1000 }, 'nothing written after the deletion');
  }
  ok('after deletion the node is { deleted_at } only; completeProfile and setMyName are refused (deleted)');

  // ── 5. the HTTP surface: completeProfile carries given_name / family_name; setMyName (customer ID token) — strict body ──
  {
    const db = seeded();
    const TOK = { 't-cust': { uid: UID, customer: true }, 't-staff': { uid: 'staff1' } };
    const h = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad'); return TOK[t]; } }),
      resolveRid: (raw) => (raw === 'x_pizza' ? { restaurantId: 'x_pizza' } : { error: 'unknown' }), checkRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }), now: () => 100 });
    const call = async (fn, body, tok = 't-cust', method = 'POST') => {
      const headers = tok ? { 'x-firebase-id-token': tok } : {};
      const res = { set() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
      await h[fn]({ method, body, headers: { 'x-forwarded-for': '1.1.1.1' }, get: (k) => headers[String(k).toLowerCase()] }, res); return res;
    };
    const cp = await call('completeProfile', { restaurant_id: 'x_pizza', email: 'ana@x.hn', accept_terms: true, promos: false, given_name: 'Ana', family_name: 'Pérez' });
    assert.deepStrictEqual([cp.code, db.get(`user_private/${UID}/given_name`), db.get(`user_private/${UID}/family_name`)], [200, 'Ana', 'Pérez'], 'completeProfile endpoint: given_name / family_name reach the transaction');
    assert.strictEqual((await call('completeProfile', { restaurant_id: 'x_pizza', email: 'ana@x.hn', accept_terms: true, promos: false, given_name: 'Ana' })).code, 400, 'completeProfile endpoint: one field alone ⇒ 400');
    const sm = await call('setMyName', { given_name: 'Bea', family_name: 'Zúñiga' });
    assert.deepStrictEqual([sm.code, sm.body, db.get(`user_private/${UID}/given_name`)], [200, { ok: true }, 'Bea'], 'setMyName endpoint: 200 and stored');
    assert.strictEqual((await call('setMyName', { given_name: 'Bea', family_name: 'Zúñiga', context: 'platform' })).code, 200, 'setMyName: the app\'s context:platform is accepted');
    for (const [why, body, tok, want] of [['no token', { given_name: 'A', family_name: 'B' }, null, 401], ['a staff token', { given_name: 'A', family_name: 'B' }, 't-staff', 401],
      ['an extra key', { given_name: 'A', family_name: 'B', uid: UID }, 't-cust', 400], ['one field', { given_name: 'A' }, 't-cust', 400], ['another context', { given_name: 'A', family_name: 'B', context: 'x_pizza' }, 't-cust', 400]])
      assert.strictEqual((await call('setMyName', body, tok)).code, want, `setMyName: ${why} ⇒ ${want}`);
    assert.strictEqual((await call('setMyName', { given_name: 'A', family_name: 'B' }, 't-cust', 'GET')).code, 405, 'setMyName: POST only');
    assert.strictEqual(db.get(`user_private/${UID}/given_name`), 'Bea', 'refused calls wrote nothing');
    const lim = SE.makeSignup({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async () => TOK['t-cust'] }), resolveRid: () => ({ error: 'unknown' }),
      checkRateLimit: async (_d, bucket) => ({ allowed: bucket !== 'signup_profile', retryAfterSec: 9 }), now: () => 100 });
    const lr = { set() { return lr; }, status(c) { lr.code = c; return lr; }, json(b) { lr.body = b; return lr; } };
    await lim.setMyName({ method: 'POST', body: { given_name: 'Zoe', family_name: 'Q' }, headers: {}, get: (k) => ({ 'x-firebase-id-token': 't-cust' })[String(k).toLowerCase()] }, lr);
    assert.deepStrictEqual([lr.code, db.get(`user_private/${UID}/given_name`)], [429, 'Bea'], 'setMyName is rate-limited (the profile family): 429, nothing written');
  }
  ok('HTTP: completeProfile carries the two fields; setMyName = customer token + exactly { given_name, family_name } (+ context:platform)');

  FINISHED = true;
  console.log(`signup-name: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); process.stderr.write(`signup-name: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
