'use strict';
// PLAN-3a-addr r0 S-ADDR-2 — useMyAddress, the «en uso» selection persisted as default_address (advisor Q1).
// The BOOK is written by the REAL writer (the frozen form's own saveAddress, lifted from xpizza-orders/account.js); the sweep's
// claim by the REAL signup-core.sweepClaim; the purge by the REAL account-lib.accountDeleteUpdates. The in-memory RTDB is
// my-favorites.test.js's model of production TRANSACTION semantics (a cold first null, re-run on a moved server, `undefined` aborts,
// a pause hook before the commit for an interleaving). Run: node my-address.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeMyAddress, RATE } = require('./my-address');
const { sweepClaim } = require('./signup-core');
const ACCOUNT = require('./account-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-address: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function fakeDb() {
  const tree = {}; const reads = []; const writes = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => {
    const ks = parts(p); if (!ks.length) throw new Error('root set');
    let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v);
  };
  const snapOf = (v, ordered = null) => { const c = clone(v); return {
    exists: () => c != null, val: () => (c == null ? null : clone(c)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(c || {}))) { if (cb({ key: k, val: () => clone(x) }) === true) return true; } return false; },
  }; };
  const rank = (v) => (v == null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : 5);
  const cmp = (a, b) => (rank(a.v) - rank(b.v)) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const query = (p, child) => {
    const q = { eq: undefined, last: null, first: null };
    const api = {
      equalTo: (v) => { q.eq = v; return api; }, limitToLast: (m) => { q.last = m; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      startAt: () => api, endAt: () => api,
      once: async () => {
        reads.push({ kind: 'query', path: p, child, last: q.last });
        let rows = Object.entries(get(p) || {}).map(([k, x]) => ({ k, x, v: x && typeof x === 'object' ? x[child] : undefined }));
        if (q.eq !== undefined) rows = rows.filter((r) => r.v === q.eq);
        rows.sort((a, b) => cmp({ v: a.v, k: a.k }, { v: b.v, k: b.k }));
        if (q.last != null) rows = rows.slice(Math.max(0, rows.length - q.last));
        if (q.first != null) rows = rows.slice(0, q.first);
        return snapOf(rows.length ? Object.fromEntries(rows.map((r) => [r.k, r.x])) : null, rows.map((r) => [r.k, r.x]));
      },
    };
    return api;
  };
  const T = { cold: new Set(), pause: new Map(), txs: [] };   // txs: every transaction ATTEMPT (path), committed or not   // cold: a path whose NEXT transaction first sees null; pause: path → async fn run before the commit
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    once: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    set: async (v) => { writes.push(p); set(p, v); }, remove: async () => { writes.push(p); set(p, null); },
    update: async (m) => { for (const [k, v] of Object.entries(m)) { writes.push(p ? `${p}/${k}` : k); set(p ? `${p}/${k}` : k, v); } },
    orderByChild: (c) => query(p, c),
    transaction: async (fn) => {
      T.txs.push(p);
      let seen = T.cold.has(p) ? null : (clone(get(p)) ?? null); T.cold.delete(p);
      for (let i = 0; i < 25; i++) {
        const next = fn(clone(seen));
        if (next === undefined) return { committed: false, snapshot: snapOf(get(p)) };
        if (T.pause.has(p)) { const f = T.pause.get(p); T.pause.delete(p); await f(); }
        const server = clone(get(p)) ?? null;
        if (!same(server, seen)) { seen = server; continue; }   // the server moved (or the cache was cold): RE-RUN with the real node
        writes.push(p); set(p, next); return { committed: true, snapshot: snapOf(get(p)) };
      }
      throw new Error('transaction: too many retries');
    },
  });
  return { tree, reads, writes, get, set, ref, T };
}

const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-hh': { uid: A, customer: true, handheld: true }, 'tok-staff': { uid: 'staff1' } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
let CLOCK = 1_800_000_000_000;
const quietly = async (f) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };

function harness(db, { limited = false, getDatabase } = {}) {
  const rl = [];
  const h = makeMyAddress({ getDatabase: getDatabase || (() => db), getAuth: () => auth, now: () => CLOCK,
    checkRateLimit: async (_db, bucket, key, policy) => { assert.ok(policy && policy.windowMs > 0 && policy.max > 0, `🔴 ${bucket}: an explicit limiter policy`); rl.push({ bucket, key }); return limited ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 }; } });
  const use = async (token, body, { method = 'POST', query = { context: 'platform' }, rawBody } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query, body, rawBody, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await h.useMyAddress(req, res); return res;
  };
  return { rl, use };
}

// the frozen form's OWN saveAddress (account.js), run against this db for uid
const ACC = fs.readFileSync(path.join(__dirname, '..', 'xpizza-orders', 'account.js'), 'utf8');
const liftFn = (head) => { const at = ACC.indexOf(head); assert.ok(at > 0, `premise: account.js defines ${head}`); return ACC.slice(at, ACC.indexOf('\n  }\n', at) + 4); };
const formSaveAddress = (db, uid) => new Function('ensureFirebase', 'heal', 'MAX_ADDRESSES', 'window', `${liftFn('function newAddrId()')}\n${liftFn('async function saveAddress(')}\nreturn saveAddress;`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid } }, db: null,
    dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {}, 10, { crypto: require('crypto').webcrypto });
// a member A with a profile and a two-entry book (Casa = default, Trabajo), both through the real writer
async function bookOf(db) {
  db.set(`user_profiles/${A}`, { phone: '50499990000', phone_hash: 'ph', created_at: 5, last_login: 6, name: 'Ana' });
  const save = formSaveAddress(db, A);
  const casa = await save({ label: 'Casa', detected: 'Col. Palmira, Tegucigalpa', details: 'Casa azul, portón negro', lat: 14.09, lng: -87.18, makeDefault: true });
  await new Promise((r) => setTimeout(r, 2));
  const trab = await save({ label: 'Trabajo', detected: 'Blvd. Morazán', details: 'Torre 2, piso 5', lat: 14.1, lng: -87.19 });
  assert.ok(casa.ok && trab.ok, `premise: the form's own saveAddress wrote the book (${JSON.stringify([casa, trab])})`);
  db.writes.length = 0;
  return { casa: casa.addrId, trab: trab.addrId };
}
// exactly the two changes: default_address = id and addresses[id].last_used_at = now; every other byte kept
const expectUsed = (before, id, now) => ({ ...before, default_address: id, addresses: { ...before.addresses, [id]: { ...before.addresses[id], last_used_at: now } } });

(async () => {
  // ── 1. the member predicate: guests / bad / non-customer / handheld ⇒ 401; each tombstone ⇒ 403; nothing written ──
  {
    for (const t of [undefined, 'nope', 'tok-staff', 'tok-hh']) {
      const db = fakeDb(); const { casa } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
      const r = await harness(db).use(t, { id: casa });
      assert.strictEqual(r.code, 401, `🔴 ${t} ⇒ 401`); assert.deepStrictEqual(r.body, { ok: false, reason: 'unauthenticated' });
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, `🔴 ${t}: nothing written`);
    }
    for (const tomb of [`deleted_uids/${A}`, `user_private/${A}/deleted_at`, 'sweep']) {
      const db = fakeDb(); const { trab } = await bookOf(db);
      if (tomb === 'sweep') assert.strictEqual(await sweepClaim(db, A, CLOCK, 77), 'claimed', 'premise: the REAL sweep claimed the profile'); else db.set(tomb, 5);
      const before = clone(db.get(`user_profiles/${A}`));
      const r = await harness(db).use(`tok-${A}`, { id: trab });
      assert.strictEqual(r.code, 403, `🔴 ${tomb} ⇒ 403`); assert.deepStrictEqual(r.body, { ok: false, reason: 'deleted' });
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, `🔴 ${tomb}: nothing written`);
    }
  }
  ok('no / bad / non-customer / HANDHELD token ⇒ 401; each of the three tombstones (deleted_uids, user_private/deleted_at, the REAL sweep claim) ⇒ 403 deleted; nothing written');

  // ── 2. the request is STRICT: POST ?context=platform, body EXACTLY { id } with an address id; a uid or address content never accepted ──
  {
    const db = fakeDb(); const { trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`)); const { use } = harness(db);
    const r405 = await use(`tok-${A}`, { id: trab }, { method: 'GET' });
    assert.strictEqual(r405.code, 405, '🔴 GET ⇒ 405');
    const bad = [
      [{ id: trab }, { query: {} }], [{ id: trab }, { query: { context: 'web' } }], [{ id: trab }, { query: { context: 'platform', uid: B } }],
      [undefined], [null], [[trab]], ['a_x'], [{}], [{ id: 'a_XYZ' }], [{ id: 'a_12345' }], [{ id: `b_${trab.slice(2)}` }], [{ id: 7 }],
      [{ id: trab, uid: B }], [{ id: trab, context: 'platform' }], [{ id: trab, label: 'Casa' }], [{ id: trab, lat: 1, lng: 1 }],
    ];
    for (const [body, o] of bad) {
      const r = await use(`tok-${A}`, body, o);
      assert.strictEqual(r.code, 400, `🔴 ${JSON.stringify(body)} ${JSON.stringify(o || {})} ⇒ 400`); assert.deepStrictEqual(r.body, { ok: false, reason: 'bad_request' });
    }
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 a refused request writes nothing');
    assert.strictEqual(db.T.txs.length, 0, 'a refused request never opens the transaction');
  }
  ok('strict request: GET ⇒ 405; no / other / extra query, a non-object body, a missing or malformed id, any extra key (uid, context, address content) ⇒ 400; nothing written');

  // ── 3. the happy path: exactly default_address + that entry's last_used_at change; the profile is otherwise byte-equal ──
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use, rl } = harness(db);
    const before = clone(db.get(`user_profiles/${A}`));
    assert.strictEqual(before.default_address, casa, 'premise: Casa is the default (the real writer\'s makeDefault)');
    CLOCK += 1000;
    const r = await use(`tok-${A}`, { id: trab });
    assert.strictEqual(r.code, 200, `🔴 use ⇒ 200 (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(r.body, { ok: true, default_address: trab }, '🔴 the response is { ok, default_address } only');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(before, trab, CLOCK), '🔴 ONLY default_address and that entry\'s last_used_at change');
    assert.deepStrictEqual(db.writes, [`user_profiles/${A}`], 'ONE write: the parent transaction');
    assert.strictEqual(r.h['Cache-Control'], 'no-store', 'no-store');
    assert.deepStrictEqual(rl, [{ bucket: 'use_address', key: A }], '🔴 its own rate-limit bucket, keyed by the VERIFIED uid');
    assert.ok(RATE.windowMs > 0 && RATE.max > 0, 'an explicit policy');
    // idempotent re-use of the default: same two fields, a newer last_used_at
    CLOCK += 1000; const mid = clone(db.get(`user_profiles/${A}`));
    assert.strictEqual((await use(`tok-${A}`, { id: trab })).code, 200);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(mid, trab, CLOCK), 'a re-use only bumps last_used_at');
  }
  ok('happy path (a book from the REAL writer): 200 { ok, default_address }; exactly default_address + that entry\'s last_used_at change, every other byte kept; one parent-transaction write; own bucket use_address by the verified uid; no-store');

  // ── 4. an unknown id, another member's id, or a malformed stored entry ⇒ 404 not_found, nothing written ──
  {
    const db = fakeDb(); const { trab } = await bookOf(db); const { use } = harness(db);
    const before = clone(db.get(`user_profiles/${A}`));
    for (const id of ['a_' + 'f'.repeat(12)]) {
      const r = await use(`tok-${A}`, { id });
      assert.strictEqual(r.code, 404, `🔴 unknown ${id} ⇒ 404`); assert.deepStrictEqual(r.body, { ok: false, reason: 'not_found' });
    }
    const rb = await use(`tok-${B}`, { id: trab });
    assert.strictEqual(db.get(`user_profiles/${B}`), undefined, '🔴 B (no profile) naming A\'s address id: B\'s profile is never created');
    assert.strictEqual(rb.code, 404, '🔴 B naming A\'s address id ⇒ 404 (B has no such entry)');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 nothing written to A');
    for (const bad of [{ label: '' }, { lat: 91 }, { secret: 1 }, { last_used_at: 'x' }]) {
      db.set(`user_profiles/${A}/addresses/${trab}`, { ...before.addresses[trab], ...bad });
      const mal = clone(db.get(`user_profiles/${A}`));
      const r = await use(`tok-${A}`, { id: trab });
      assert.strictEqual(r.code, 404, `🔴 a stored entry off the rules' shape (${JSON.stringify(bad)}) ⇒ 404`);
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), mal, `🔴 ${JSON.stringify(bad)}: never repaired, never selected`);
    }
  }
  ok('an unknown id, another member\'s id (B\'s profile never created) or a stored entry off the rules\' shape ⇒ 404 not_found; nothing written, never repaired');

  // ── 5. the transaction: a COLD null never aborts; a purge during it never resurrects; a sweep claim during it ⇒ 403 ──
  {
    // cold: the SDK's uncached first run sees null while the server holds the profile ⇒ re-run with the real node ⇒ committed
    const db = fakeDb(); const { trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
    db.T.cold.add(`user_profiles/${A}`);
    const r = await harness(db).use(`tok-${A}`, { id: trab });
    assert.strictEqual(r.code, 200, `🔴 a COLD first null never aborts (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(before, trab, CLOCK), '🔴 cold: committed on the re-run, exactly the two fields');
  }
  {
    // purge: the REAL deletion's update lands between the transaction's read and its commit ⇒ re-run on null ⇒ nothing written
    const db = fakeDb(); const { trab } = await bookOf(db);
    db.T.pause.set(`user_profiles/${A}`, async () => { await db.ref().update(ACCOUNT.accountDeleteUpdates(A, 'ph', 4242)); });
    const r = await harness(db).use(`tok-${A}`, { id: trab });
    assert.strictEqual(db.get(`user_profiles/${A}`), undefined, '🔴 a purged profile is NEVER resurrected');
    assert.strictEqual(r.code, 404, `a purged profile ⇒ 404 (${r.code})`);
  }
  {
    // the sweep's claim (REAL sweepClaim) between the read and the commit ⇒ the fence is observed ⇒ abort ⇒ 403
    const db = fakeDb(); const { trab } = await bookOf(db);
    db.T.pause.set(`user_profiles/${A}`, async () => { assert.strictEqual(await sweepClaim(db, A, CLOCK, 99), 'claimed', 'premise: the sweep claimed mid-transaction'); });
    const mid = clone(db.get(`user_profiles/${A}`));
    const r = await harness(db).use(`tok-${A}`, { id: trab });
    assert.strictEqual(r.code, 403, `🔴 deleting_at observed inside the transaction ⇒ 403 (${r.code})`);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), { ...mid, deleting_at: 99 }, '🔴 … and the claimed profile keeps its default (only the sweep wrote)');
  }
  ok('the parent transaction: a COLD first null re-runs and commits exactly the two fields; the REAL purge mid-transaction ⇒ nothing resurrected (404); the REAL sweep claim mid-transaction ⇒ abort, 403, the profile untouched');

  // ── 6. 429 and 503 ──
  {
    const db = fakeDb(); const { trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
    const r = await harness(db, { limited: true }).use(`tok-${A}`, { id: trab });
    assert.strictEqual(r.code, 429, '🔴 limited ⇒ 429'); assert.strictEqual(r.h['Retry-After'], '9', 'Retry-After');
    assert.deepStrictEqual(r.body, { ok: false, reason: 'rate_limited' });
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, 'nothing written');
    const boom = await quietly(() => harness(db, { getDatabase: () => { throw new Error('secret detail /path'); } }).use(`tok-${A}`, { id: trab }));
    assert.strictEqual(boom.code, 503, '🔴 an unexpected failure ⇒ 503');
    assert.deepStrictEqual(boom.body, { ok: false, reason: 'unavailable', retryable: true }, '🔴 no message or stack leaves');
    const orig = db.ref; db.ref = (p) => (String(p).startsWith('user_profiles/') && !String(p).endsWith('deleting_at') ? { ...orig(p), transaction: async () => { throw new Error('tx'); } } : orig(p));
    const tx = await quietly(() => harness(db).use(`tok-${A}`, { id: trab }));
    assert.strictEqual(tx.code, 503, '🔴 a failed transaction ⇒ 503');
  }
  ok('rate-limited ⇒ 429 + Retry-After, nothing written; an unexpected failure (database or transaction) ⇒ 503 { reason: unavailable, retryable } with no message or stack');

  FINISHED = true;
  console.log(`\nmy-address: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmy-address: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
