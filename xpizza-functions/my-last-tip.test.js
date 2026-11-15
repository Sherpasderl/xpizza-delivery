'use strict';
// PLAN-3a-capp-member-reads r4 — (2) getMyLastTip: the header-token replacement for the capp's `?auth=<ID token>` RTDB REST read of
// user_private/{uid}/last_tip (rule 20). The stored value comes from the REAL writer (tip-pref.recordLastTip). Run: node my-last-tip.test.js
const assert = require('assert');
const { makeMyLastTip, CENTS_MAX } = require('./my-last-tip');
const TP = require('./tip-pref');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-last-tip: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });

function fakeDb(init = {}) {
  const tree = JSON.parse(JSON.stringify(init)); const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v == null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = v; };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : JSON.parse(JSON.stringify(v))) });
  return { tree, reads, get, set, ref: (p) => ({
    once: async () => { reads.push(p); return snap(get(p)); },
    transaction: async (fn) => { const cur = get(p) === undefined ? null : JSON.parse(JSON.stringify(get(p))); const next = fn(cur); if (next === undefined) return { committed: false }; set(p, next); return { committed: true }; },
  }) };
}
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-hh': { uid: A, customer: true, handheld: true }, 'tok-staff': { uid: 'staff1' } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
function harness(db, { limited = false } = {}) {
  const rl = [];
  const { getMyLastTip } = makeMyLastTip({ getDatabase: () => db, getAuth: () => auth,
    checkRateLimit: async (_db, bucket, key, policy) => { assert.ok(policy && policy.windowMs > 0 && policy.max > 0, '🔴 an explicit limiter policy'); rl.push(`${bucket}:${key}`); return limited ? { allowed: false, retryAfterSec: 4 } : { allowed: true, retryAfterSec: 0 }; } });
  const call = async ({ method = 'GET', token, query = { context: 'platform' }, body, rawBody } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query, body, rawBody, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await getMyLastTip(req, res); return res;
  };
  return { call, rl };
}
const record = (db, uid, cents, at, id = `XP-${at}`) => { db.set(`orders/${id}/created_at`, at); return TP.recordLastTip(db, { uid, body: { tip_choice: true, tip_cents: cents }, orderType: 'delivery', orderId: id }); };

(async () => {
  // 1. the value the REAL writer stored, for the token's own uid only; no-store
  {
    const db = fakeDb(); await record(db, A, 4000, 1000); await record(db, B, 0, 1000);
    const { call } = harness(db);
    let r = await call({ token: `tok-${A}` });
    assert.deepStrictEqual([r.code, r.body], [200, { ok: true, cents: 4000 }]); assert.strictEqual(r.h['Cache-Control'], 'no-store');
    r = await call({ token: `tok-${B}` }); assert.deepStrictEqual(r.body, { ok: true, cents: 0 }, '«Sin propina» (0) is a real choice, not null');
    await record(db, A, 2500, 2000); r = await call({ token: `tok-${A}` }); assert.deepStrictEqual(r.body.cents, 2500, 'the newer choice');
    const d2 = fakeDb(); r = await harness(d2).call({ token: `tok-${A}` }); assert.deepStrictEqual(r.body, { ok: true, cents: null }, 'nothing stored ⇒ null');
  }
  ok('the last tip the REAL recorder stored, for the token\'s own uid only (0 is a real choice; nothing stored ⇒ null); no-store');

  // 2. the member predicate: 401 / 403 — and no last_tip read for either
  {
    for (const t of [undefined, 'nope', 'tok-staff', 'tok-hh']) {
      const db = fakeDb(); await record(db, A, 4000, 1000); db.reads.length = 0;
      const r = await harness(db).call({ token: t });
      assert.deepStrictEqual([r.code, r.body], [401, { ok: false, reason: 'unauthenticated' }], `🔴 ${t} ⇒ 401`);
      assert.ok(!db.reads.some((p) => p.endsWith('/last_tip')), `${t}: no last_tip read`);
    }
    for (const tomb of [`deleted_uids/${A}`, `user_profiles/${A}/deleting_at`]) {
      const db = fakeDb(); await record(db, A, 4000, 1000); db.set(tomb, 5); db.reads.length = 0;
      const r = await harness(db).call({ token: `tok-${A}` });
      assert.deepStrictEqual([r.code, r.body], [403, { ok: false, reason: 'deleted' }], `🔴 ${tomb} ⇒ 403`);
      assert.ok(!db.reads.some((p) => p.endsWith('/last_tip')), `${tomb}: no last_tip read`);
    }
    const db = fakeDb({ user_private: { [A]: { deleted_at: 5 } } });
    assert.deepStrictEqual((await harness(db).call({ token: `tok-${A}` })).code, 403, '🔴 user_private/deleted_at ⇒ 403');
  }
  ok('no / bad / non-customer / HANDHELD token ⇒ 401; each tombstone ⇒ 403 — neither reads last_tip');

  // 3. strict: GET ?context=platform only, no body; the token is never read from the query or the body
  {
    const db = fakeDb(); await record(db, A, 4000, 1000); const { call } = harness(db);
    for (const [why, o] of [['a POST', { method: 'POST' }], ['no context', { query: {} }], ['an extra key', { query: { context: 'platform', uid: B } }],
      ['the token in the query', { query: { context: 'platform', auth: `tok-${A}` } }], ['a body', { body: { a: 1 } }], ['a raw body', { rawBody: Buffer.from('{}') }]]) {
      const r = await call({ token: `tok-${A}`, ...o }); assert.ok(r.code === 400 || r.code === 405, `🔴 ${why} ⇒ ${r.code}`);
    }
    const r = await call({ query: { context: 'platform', auth: `tok-${A}` } });
    assert.ok(r.code === 400 || r.code === 401, '🔴 a token in the URL is never honoured');
  }
  ok('strict: GET ?context=platform, nothing else, no body; a token in the URL is never honoured (rule 20)');

  // 4. an out-of-range / malformed stored value ⇒ null (the capp's own bound, never passed through)
  {
    for (const bad of [{ cents: CENTS_MAX + 1, at: 1 }, { cents: -1, at: 1 }, { cents: 1.5, at: 1 }, { cents: '4000', at: 1 }, 'x', { at: 1 }]) {
      const db = fakeDb({ user_private: { [A]: { last_tip: bad } } });
      assert.deepStrictEqual((await harness(db).call({ token: `tok-${A}` })).body, { ok: true, cents: null }, `🔴 ${JSON.stringify(bad)} ⇒ null`);
    }
    const db = fakeDb({ user_private: { [A]: { last_tip: { cents: CENTS_MAX, at: 1 } } } });
    assert.deepStrictEqual((await harness(db).call({ token: `tok-${A}` })).body.cents, CENTS_MAX, 'the bound itself is served');
  }
  ok(`an out-of-range (> ${CENTS_MAX} or < 0), non-integer or malformed stored value ⇒ null — never passed through`);

  // 5. rate limit: an explicit policy, per verified uid, before the read
  {
    const db = fakeDb(); await record(db, A, 4000, 1000); db.reads.length = 0;
    const h = harness(db, { limited: true }); const r = await h.call({ token: `tok-${A}` });
    assert.deepStrictEqual([r.code, r.body, r.h['Retry-After']], [429, { ok: false, reason: 'rate_limited' }, '4']);
    assert.deepStrictEqual(h.rl, [`get_my_last_tip:${A}`]); assert.ok(!db.reads.some((p) => p.endsWith('/last_tip')), 'no read when limited');
  }
  ok('rate limit: an explicit policy, keyed by the verified uid (get_my_last_tip) ⇒ 429 + Retry-After before any read');

  // 6. a failure ⇒ a sanitized 503
  {
    const db = fakeDb(); const orig = db.ref; db.ref = (p) => (String(p).endsWith('/last_tip') ? { once: async () => { throw new Error('boom secret'); } } : orig(p));
    const e = console.error; console.error = () => {};
    try { const r = await harness(db).call({ token: `tok-${A}` }); assert.deepStrictEqual([r.code, r.body], [503, { ok: false, reason: 'unavailable', retryable: true }]); } finally { console.error = e; }
  }
  ok('an unexpected failure ⇒ 503 { reason: unavailable, retryable } — no message leaves');

  FINISHED = true;
  console.log(`\nmy-last-tip: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmy-last-tip: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
