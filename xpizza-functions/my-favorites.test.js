'use strict';
// PLAN-3a-capp-member-reads r4 — (1) getMyFavorites + setFavorite (§1.2, R2.2, R3.1, R4.1, R4.2) and the deletion FENCE.
// History rows come from the REAL intake writer (create-order-build.attachCustomerAttribution); deletion is the REAL
// signup-endpoints.deleteAccountCore; the in-memory RTDB models production TRANSACTION semantics that the cells depend on:
//   · an optional COLD first call — the updater sees `null` while the server holds a value; a result that is not `undefined`
//     commits ONLY if the server value equals the value the updater saw, else the updater RE-RUNS with the real node;
//   · `undefined` aborts; a pause hook before the commit (an interleaving: a deletion + a drain running meanwhile).
// Every read is logged, so the bounded reads are asserted, not assumed. Run: node my-favorites.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'my-favorites-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const { makeMyFavorites, FAV_MAX, RECENT_ROWS } = require('./my-favorites');
const { attachCustomerAttribution } = require('./create-order-build');
const SE = require('./signup-endpoints');
const ACCOUNT = require('./account-lib');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-favorites: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
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
const RIDS = ['x_pizza', 'la_musa', 'merch_a', 'merch_b'];
function seedRestaurants(db, rids = RIDS) { for (const r of rids) db.set(`restaurants/${r}/identity`, { name: r, active: true }); }
let CLOCK = 1_700_000_000_000;
function harness(db, { limited = () => false } = {}) {
  const rl = [];
  const h = makeMyFavorites({ getDatabase: () => db, getAuth: () => auth, now: () => CLOCK,
    checkRateLimit: async (_db, bucket, key, policy) => { assert.ok(policy && policy.windowMs > 0 && policy.max > 0, `🔴 ${bucket}: an explicit limiter policy`); rl.push({ bucket, key }); return limited(bucket) ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 }; } });
  const mk = (handler) => async ({ method, token, query, body, rawBody } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query: query || {}, body, rawBody, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await handler(req, res); return res;
  };
  const get = mk(h.getMyFavorites), post = mk(h.setFavorite);
  return {
    rl,
    read: (token, o = {}) => get({ method: 'GET', token, query: { context: 'platform' }, ...o }),
    fav: (token, rid, on, o = {}) => post({ method: 'POST', token, body: { context: 'platform', rid, on }, ...o }),
  };
}
// a history row through the REAL intake writer (the attribution builder), at a chosen ts / restaurant / status
function order(db, uid, id, { rid = 'x_pizza', ts, status = 'new' } = {}) {
  const updates = { [`orders/${id}`]: { order_id: id, restaurant_id: rid, status } };
  attachCustomerAttribution(updates, id, uid, { now: ts, total: 100, orderType: 'pickup', items_text: '1x X', restaurantId: rid, status, items: [] });
  for (const [k, v] of Object.entries(updates)) db.set(k, v);
}
const quietly = async (f) => { const e = console.error, w = console.warn, l = console.log; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; console.log = l; } };
const deleteA = (db, at) => quietly(() => SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: at, revoke: async () => {} }));

(async () => {
  // ── 1. the member predicate on BOTH endpoints: guests / bad / non-customer / handheld ⇒ 401; any tombstone ⇒ 403; nothing written ──
  {
    const db = fakeDb(); seedRestaurants(db); const { read, fav } = harness(db);
    for (const t of [undefined, 'nope', 'tok-staff', 'tok-hh']) {
      for (const r of [await read(t), await fav(t, 'x_pizza', true)]) { assert.strictEqual(r.code, 401, `🔴 ${t} ⇒ 401`); assert.deepStrictEqual(r.body, { ok: false, reason: 'unauthenticated' }); }
    }
    for (const tomb of [`deleted_uids/${A}`, `user_private/${A}/deleted_at`, `user_profiles/${A}/deleting_at`]) {
      const d = fakeDb(); seedRestaurants(d); d.set(tomb, 5); const hh = harness(d);
      for (const r of [await hh.read(`tok-${A}`), await hh.fav(`tok-${A}`, 'x_pizza', true), await hh.fav(`tok-${A}`, 'x_pizza', false)]) {
        assert.strictEqual(r.code, 403, `🔴 ${tomb} ⇒ 403`); assert.deepStrictEqual(r.body, { ok: false, reason: 'deleted' });
      }
      assert.strictEqual(d.get(`user_favorites/${A}`), undefined, `🔴 ${tomb}: nothing written`);
    }
    assert.strictEqual(db.writes.length, 0, 'no write for a refused caller');
  }
  ok('both endpoints: no / bad / non-customer / HANDHELD token ⇒ 401; each of the three tombstones ⇒ 403 deleted; nothing written');

  // ── 2. the advisor's condition: a LEGACY-deleted account (tombstone, NO fence — deleted before the fence shipped) ⇒ 403, nothing written ──
  {
    const db = fakeDb(); seedRestaurants(db);
    db.set(`deleted_uids/${A}`, 9); db.set(`user_private/${A}`, { deleted_at: 9 });   // user_favorites/{uid} is null: no _deleted
    const { fav } = harness(db);
    db.T.cold.add(`user_favorites/${A}`);
    const r = await fav(`tok-${A}`, 'x_pizza', true);
    assert.strictEqual(r.code, 403); assert.deepStrictEqual(r.body, { ok: false, reason: 'deleted' });
    assert.strictEqual(db.get(`user_favorites/${A}`), undefined, '🔴 a cold `on` on a legacy-deleted account must never create the node');
    assert.ok(!db.writes.some((w) => w.startsWith('user_favorites/')), 'no favorites write at all');
  }
  ok('a LEGACY-deleted account (tombstone, no fence) ⇒ 403 BEFORE the transaction, nothing written (the entry tombstone check is the guard)');

  // ── 3. strict requests ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db); const T = `tok-${A}`;
    for (const [why, o] of [['a POST to the read', { method: 'POST' }], ['an extra key', { query: { context: 'platform', x: '1' } }], ['no context', { query: {} }],
      ['a body on the GET', { body: { a: 1 } }], ['a raw body on the GET', { rawBody: Buffer.from('{}') }], ['the token in the query', { query: { context: 'platform', token: T } }]]) {
      const r = await h.read(T, o); assert.ok(r.code === 400 || r.code === 405, `🔴 read: ${why} ⇒ ${r.code}`);
    }
    for (const [why, body] of [['no context', { rid: 'x_pizza', on: true }], ['a bad rid', { context: 'platform', rid: 'X Pizza', on: true }], ['an underscore rid', { context: 'platform', rid: '_deleted', on: false }],
      ['on not boolean', { context: 'platform', rid: 'x_pizza', on: 'yes' }], ['an extra key', { context: 'platform', rid: 'x_pizza', on: true, uid: B }], ['not an object', ['x_pizza']]]) {
      const r = await h.fav(T, null, null, { body }); assert.strictEqual(r.code, 400, `🔴 set: ${why} ⇒ 400`); assert.deepStrictEqual(r.body, { ok: false, reason: 'bad_request' });
    }
    const r = await h.fav(T, null, null, { method: 'GET', body: undefined }); assert.strictEqual(r.code, 405);
    assert.strictEqual(db.get(`user_favorites/${A}`), undefined);
  }
  ok('strict: the read is GET ?context=platform, nothing else, no body; the write is POST {context, rid, on} exactly (an underscore rid like `_deleted` is refused) — else 400 / 405');

  // ── 4. on / off, idempotent; exactly { createdAt }; the uid ONLY from the token; read newest-first, no createdAt served ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    CLOCK += 1000; let r = await h.fav(`tok-${A}`, 'x_pizza', true); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: true }]);
    const first = db.get(`user_favorites/${A}/x_pizza`); assert.deepStrictEqual(Object.keys(first), ['createdAt']);
    CLOCK += 1000; r = await h.fav(`tok-${A}`, 'x_pizza', true); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: true }]);
    assert.deepStrictEqual(db.get(`user_favorites/${A}/x_pizza`), first, 'on/on keeps the FIRST createdAt');
    CLOCK += 1000; await h.fav(`tok-${A}`, 'la_musa', true);
    r = await h.read(`tok-${A}`);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.h['Cache-Control'], 'no-store');
    assert.deepStrictEqual(r.body, { ok: true, favorites: ['la_musa', 'x_pizza'], more: false, recent: [] }, 'newest first, rids only — never createdAt');
    assert.deepStrictEqual((await h.read(`tok-${B}`)).body.favorites, [], '🔴 another member sees none of A\'s');
    r = await h.fav(`tok-${A}`, 'x_pizza', false); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: false }]);
    r = await h.fav(`tok-${A}`, 'x_pizza', false); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: false }], 'off/off is a 200 no-op');
    assert.deepStrictEqual(Object.keys(db.get(`user_favorites/${A}`)), ['la_musa']);
    await h.fav(`tok-${A}`, 'la_musa', false); assert.strictEqual(db.get(`user_favorites/${A}`), undefined, 'the last off removes the node');
  }
  ok('on / off idempotent (on keeps the first createdAt; off/off is a no-op); a favorite is exactly { createdAt }; the read is rids newest-first, per token uid only');

  // ── 5. identity on ADD only (R2.2 #8): an unknown restaurant ⇒ 404 on `on`; a REMOVED restaurant's favorite is still removable ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    let r = await h.fav(`tok-${A}`, 'nowhere_rest', true); assert.deepStrictEqual([r.code, r.body], [404, { ok: false, reason: 'unknown_restaurant' }], '🔴 an unknown restaurant ⇒ 404 on `on`');
    assert.strictEqual(db.get(`user_favorites/${A}`), undefined);
    await h.fav(`tok-${A}`, 'merch_a', true);
    db.set('restaurants/merch_a/identity', null);   // the restaurant left the platform
    r = await h.fav(`tok-${A}`, 'merch_a', true); assert.strictEqual(r.code, 404, 'no NEW favorite of a removed restaurant');
    r = await h.fav(`tok-${A}`, 'merch_a', false); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: false }], '🔴 a removed restaurant\'s favorite stays removable');
    assert.strictEqual(db.get(`user_favorites/${A}`), undefined);
  }
  ok('identity is checked on ADD only: an unknown restaurant ⇒ 404; a removed restaurant\'s favorite is always removable (off needs only a path-valid rid)');

  // ── 5b. the existence check is a LEAF read (advisor 2026-11-13, hours-tripwire R4): restaurants/<rid>/identity/name — never the whole
  // identity node (it carries hours; a heart tap must not download it). identity/name is required of every routable restaurant
  // (restaurant-config.isRoutingValid; brand-model.validateBranchIdentity ⇒ branch-ops.readinessOf gates activation; rules .validate
  // hasChildren name), so a name-less identity is not a restaurant a customer can order from ⇒ 404 like an unknown one ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    db.reads.length = 0;
    let r = await h.fav(`tok-${A}`, 'merch_a', true); assert.strictEqual(r.code, 200, 'premise: a known restaurant ⇒ 200');
    const idReads = db.reads.filter((x) => x.path.startsWith('restaurants/')).map((x) => x.path);
    assert.deepStrictEqual(idReads, ['restaurants/merch_a/identity/name'], `🔴 the existence check reads ONLY the identity/name leaf (${idReads.join(', ')})`);
    db.set('restaurants/merch_b/identity', { active: true, hours: { mon: { open: true, start: '10:00', end: '22:00' } } });   // no name
    r = await h.fav(`tok-${A}`, 'merch_b', true); assert.deepStrictEqual([r.code, r.body], [404, { ok: false, reason: 'unknown_restaurant' }], '🔴 an identity without a name ⇒ 404 (not a routable restaurant)');
    db.set('restaurants/merch_b/identity/name', '');
    r = await h.fav(`tok-${A}`, 'merch_b', true); assert.strictEqual(r.code, 404, '🔴 an EMPTY name ⇒ 404 (isRoutingValid: a non-empty string)');
    for (const bad of [7, { length: 3 }]) { db.set('restaurants/merch_b/identity/name', bad); r = await h.fav(`tok-${A}`, 'merch_b', true); assert.strictEqual(r.code, 404, `🔴 a non-string name (${JSON.stringify(bad)}) ⇒ 404`); }
  }
  ok('the add-time existence check reads ONLY restaurants/<rid>/identity/name (never the whole identity, hours included); a name-less identity ⇒ 404');

  // ── 6. the cap: FAV_MAX exactly, a bounded pre-check (never reads past FAV_MAX + 1), exact under concurrency; a legacy oversized node ──
  {
    const db = fakeDb(); const many = Array.from({ length: FAV_MAX + 2 }, (_, i) => `r${String(i).padStart(3, '0')}`); seedRestaurants(db, many);
    for (let i = 0; i < FAV_MAX - 1; i++) db.set(`user_favorites/${A}/${many[i]}`, { createdAt: 1000 + i });
    const h = harness(db);
    // two concurrent adds at FAV_MAX - 1: exactly one wins
    db.T.pause.set(`user_favorites/${A}`, async () => { const r2 = await h.fav(`tok-${A}`, many[FAV_MAX], true); assert.strictEqual(r2.code, 200, 'the overtaking add'); });
    const r1 = await h.fav(`tok-${A}`, many[FAV_MAX - 1], true);
    assert.deepStrictEqual([r1.code, r1.body], [409, { ok: false, reason: 'too_many' }], '🔴 the re-run INSIDE the transaction refuses past the cap');
    assert.strictEqual(Object.keys(db.get(`user_favorites/${A}`)).length, FAV_MAX, 'exactly FAV_MAX under concurrency');
    db.reads.length = 0;
    const r = await h.fav(`tok-${A}`, many[FAV_MAX + 1], true); assert.strictEqual(r.code, 409);
    const q = db.reads.filter((x) => x.kind === 'query' && x.path === `user_favorites/${A}`);
    assert.ok(q.length === 1 && q[0].child === 'createdAt' && q[0].last === FAV_MAX + 1, '🔴 the pre-check is ONE orderByChild(createdAt).limitToLast(FAV_MAX + 1)');
    assert.ok(!db.reads.some((x) => x.kind === 'get' && x.path === `user_favorites/${A}`), 'the full node is never read by the refused add');
    assert.strictEqual((await h.fav(`tok-${A}`, many[0], true)).code, 200, 'an on/on of an EXISTING favorite at the cap is still a 200 no-op');
    // a LEGACY oversized node (written owner-direct before the rules change)
    const d2 = fakeDb(); seedRestaurants(d2, [...many, 'x_pizza']); for (let i = 0; i < FAV_MAX + 2; i++) d2.set(`user_favorites/${A}/${many[i]}`, { createdAt: 1000 + i });
    const h2 = harness(d2); const rd = await h2.read(`tok-${A}`);
    assert.strictEqual(rd.body.favorites.length, FAV_MAX); assert.strictEqual(rd.body.more, true); assert.strictEqual(rd.body.favorites[0], many[FAV_MAX + 1], 'the newest first');
    assert.strictEqual((await h2.fav(`tok-${A}`, 'x_pizza', true)).code, 409, 'a legacy oversized node refuses an add');
    // Codex build r1 P2: a rid AMONG the newest FAV_MAX + 1 must not exempt an oversized node — a repeated `on` is refused BEFORE the
    // parent transaction (which would download every child)
    d2.T.txs.length = 0;
    const again = await h2.fav(`tok-${A}`, many[FAV_MAX + 1], true);
    assert.deepStrictEqual([again.code, again.body], [409, { ok: false, reason: 'too_many' }], '🔴 an oversized node refuses even an on of a favorite it holds (no exemption by `has`)');
    assert.deepStrictEqual(d2.T.txs, [], '🔴 the oversized node is never handed to the parent transaction');
    assert.strictEqual((await h2.fav(`tok-${A}`, many[0], false)).code, 200, 'and can shrink');
  }
  ok(`the cap: exactly FAV_MAX (${FAV_MAX}) even under two concurrent adds; the refusal pre-check is ONE bounded createdAt query; a legacy oversized node reads the newest ${FAV_MAX} + more:true, refuses adds, can shrink`);

  // ── 7. the ATOMIC deletion fence (R3.1): deleteAccountCore replaces the node with { _deleted }; every write aborts on it ──
  {
    // 7a. the advisor's pause-past-retention schedule: admitted → paused at its transaction → the deletion commits → the journal drain
    //     runs past retention and retires its entry → resume ⇒ abort, 403, the node is exactly the fence
    const db = fakeDb(); seedRestaurants(db); db.set(`user_profiles/${A}`, { phone: '1', created_at: 1, last_login: 1 });
    await harness(db).fav(`tok-${A}`, 'la_musa', true);
    const h = harness(db);
    let drained = null;
    db.T.pause.set(`user_favorites/${A}`, async () => {
      await deleteA(db, 5000);
      drained = await quietly(() => SE.drainRatingRedactions(db, 5000 + 400 * 24 * 3600 * 1000));
    });
    const r = await h.fav(`tok-${A}`, 'x_pizza', true);
    assert.deepStrictEqual([r.code, r.body], [403, { ok: false, reason: 'deleted' }], '🔴 the resumed write aborts on the fence');
    assert.deepStrictEqual(db.get(`user_favorites/${A}`), { _deleted: 5000 }, '🔴 the node is EXACTLY the fence — no favorite survives the deletion');
    assert.ok(drained && drained.cleared >= 0, 'the drain ran meanwhile');
    // 7b. an `off` racing the deletion never removes the fence
    const d2 = fakeDb(); seedRestaurants(d2); await harness(d2).fav(`tok-${A}`, 'x_pizza', true);
    d2.T.pause.set(`user_favorites/${A}`, async () => { await deleteA(d2, 6000); });
    const r2 = await harness(d2).fav(`tok-${A}`, 'x_pizza', false);
    assert.strictEqual(r2.code, 403); assert.deepStrictEqual(d2.get(`user_favorites/${A}`), { _deleted: 6000 }, '🔴 the fence survives an off');
    // 7c. a write that commits BEFORE the deletion: the deletion then replaces the whole node
    const d3 = fakeDb(); seedRestaurants(d3); await harness(d3).fav(`tok-${A}`, 'x_pizza', true); await deleteA(d3, 7000);
    assert.deepStrictEqual(d3.get(`user_favorites/${A}`), { _deleted: 7000 });
    // 7d. BOTH deletion entry points fence (the user's deleteAccount and the inactivity sweep)
    const d4 = fakeDb(); seedRestaurants(d4); d4.set(`user_profiles/${A}`, { phone: '1', created_at: 1, last_login: 1 }); await harness(d4).fav(`tok-${A}`, 'x_pizza', true);
    await quietly(() => SE.deleteAccountCore(d4, ACCOUNT, { uid: A, phoneHash: null, now: 8000, sweepCutoff: 50, revoke: async () => {} }));
    assert.deepStrictEqual(d4.get(`user_favorites/${A}`), { _deleted: 8000 }, '🔴 the inactivity sweep fences too');
    // 7e. accountDeleteUpdates itself is unchanged (its own tests pin the subtree-root null)
    assert.strictEqual(ACCOUNT.accountDeleteUpdates(A, null, 1)[`user_favorites/${A}`], null);
  }
  ok('the atomic fence: pause-past-retention (deletion + a drain past retention while the write waits) ⇒ abort, 403, node = {_deleted}; an off never removes it; a prior commit is replaced; both deletion paths fence');

  // ── 8. COLD cache (R4.1): the updater first sees null — on and off never abort on it; only an OBSERVED fence aborts ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    db.set(`user_favorites/${A}`, { x_pizza: { createdAt: 1 }, la_musa: { createdAt: 2 } });
    db.T.cold.add(`user_favorites/${A}`);
    let r = await h.fav(`tok-${A}`, 'x_pizza', false);
    assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: false }]);
    assert.deepStrictEqual(Object.keys(db.get(`user_favorites/${A}`)), ['la_musa'], '🔴 a cold `off` RE-RAN against the server and removed the favorite');
    db.T.cold.add(`user_favorites/${A}`);
    r = await h.fav(`tok-${A}`, 'merch_b', true);
    assert.strictEqual(r.code, 200); assert.deepStrictEqual(Object.keys(db.get(`user_favorites/${A}`)).sort(), ['la_musa', 'merch_b'], 'a cold `on` keeps the siblings it did not see');
    const d2 = fakeDb(); seedRestaurants(d2); const h2 = harness(d2);
    d2.T.cold.add(`user_favorites/${A}`);
    r = await h2.fav(`tok-${A}`, 'x_pizza', true); assert.strictEqual(r.code, 200); assert.deepStrictEqual(Object.keys(d2.get(`user_favorites/${A}/x_pizza`)), ['createdAt'], 'an absent node: on creates exactly {rid:{createdAt}}');
    const d3 = fakeDb(); seedRestaurants(d3); const h3 = harness(d3);
    d3.T.cold.add(`user_favorites/${A}`);
    r = await h3.fav(`tok-${A}`, 'x_pizza', false); assert.deepStrictEqual([r.code, r.body], [200, { ok: true, on: false }], 'an absent node: off is a no-op');
    assert.strictEqual(d3.get(`user_favorites/${A}`), undefined);
    // a fenced node seen cold: the re-run observes the fence and aborts (and the entry check still guards first)
    const d4 = fakeDb(); seedRestaurants(d4); d4.set(`user_favorites/${A}`, { _deleted: 1 });
    const out = {}; const { favUpdater } = require('./my-favorites');
    const up = favUpdater({ op: 'off', rid: 'x_pizza', now: 1 }, out);
    assert.strictEqual(up(null), null, 'cold null ⇒ a no-op VALUE, never an abort'); assert.strictEqual(up({ _deleted: 1 }), undefined, 'an OBSERVED fence ⇒ abort');
    assert.strictEqual(out.outcome, 'fenced');
    // a MALFORMED non-object node (a legacy scalar) is normalized to {} — an `on` writes exactly { rid: { createdAt } }, never a spread
    const d5 = fakeDb(); seedRestaurants(d5); d5.set(`user_favorites/${A}`, 'legacy-scalar');
    r = await harness(d5).fav(`tok-${A}`, 'x_pizza', true);
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual(Object.keys(d5.get(`user_favorites/${A}`)), ['x_pizza'], '🔴 a malformed (non-object) node is normalized to {} — exactly { x_pizza }, nothing spread from the old value');
  }
  ok('cold cache: off and on never abort on a cold null — off re-runs and removes, on keeps unseen siblings; an absent node: on creates, off no-ops; an OBSERVED fence aborts');

  // ── 9. recent (R4.2): ≤ RECENT_ROWS stored rows read, distinct rids newest-first, cancelled skipped, ≤ 10; a tiny response ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    order(db, A, 'o1', { rid: 'x_pizza', ts: 100 }); order(db, A, 'o2', { rid: 'la_musa', ts: 200, status: 'cancelled' });
    order(db, A, 'o3', { rid: 'merch_a', ts: 300, status: 'delivered' }); order(db, A, 'o4', { rid: 'x_pizza', ts: 400, status: 'completed' });
    order(db, B, 'o5', { rid: 'merch_b', ts: 500 });
    db.reads.length = 0;
    const r = await h.read(`tok-${A}`);
    assert.deepStrictEqual(r.body.recent, [{ rid: 'x_pizza', last_at: 400 }, { rid: 'merch_a', last_at: 300 }], 'distinct, newest first, the cancelled one skipped, only A\'s');
    const q = db.reads.filter((x) => x.kind === 'query' && x.path === `user_orders/${A}`);
    assert.ok(q.length === 1 && q[0].child === 'ts' && q[0].last === RECENT_ROWS, `🔴 ONE orderByChild(ts).limitToLast(${RECENT_ROWS}) — the row-count budget`);
    const d2 = fakeDb(); seedRestaurants(d2); for (let i = 0; i < 30; i++) order(d2, A, `p${i}`, { rid: `rest_${String(i).padStart(2, '0')}`, ts: 1000 + i });
    const r2 = await harness(d2).read(`tok-${A}`);
    assert.strictEqual(r2.body.recent.length, RECENT_ROWS, 'never more than the rows read'); assert.strictEqual(r2.body.recent[0].rid, 'rest_29');
    assert.ok(Buffer.byteLength(JSON.stringify(r2.body)) <= 1024, '🔴 the response stays ≤ 1 KB');
    for (const leak of ['total', 'items', 'items_text', 'status', 'order']) assert.ok(!JSON.stringify(r.body.recent).includes(leak), `recent carries rids and dates only (${leak})`);
  }
  ok(`recent: ONE bounded query (≤ ${RECENT_ROWS} rows), distinct rids newest first with their last date, cancelled skipped, only the caller's — a ≤ 1 KB response of rids and dates only`);

  // ── 10. rate limits: explicit policies, per VERIFIED uid, their own buckets, before any favorites / history read or write ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db, { limited: (b) => b === 'get_my_favorites' || b === 'set_favorite' });
    const r1 = await h.read(`tok-${A}`), r2 = await h.fav(`tok-${A}`, 'x_pizza', true);
    for (const r of [r1, r2]) { assert.strictEqual(r.code, 429); assert.deepStrictEqual(r.body, { ok: false, reason: 'rate_limited' }); assert.strictEqual(r.h['Retry-After'], '9'); }
    assert.deepStrictEqual(h.rl.map((x) => `${x.bucket}:${x.key}`), [`get_my_favorites:${A}`, `set_favorite:${A}`]);
    assert.ok(!db.reads.some((x) => /^user_(favorites|orders)\//.test(x.path)), 'no favorites / history read when limited');
    assert.strictEqual(db.get(`user_favorites/${A}`), undefined);
  }
  ok('rate limits: explicit policies, keyed by the verified uid, own buckets (get_my_favorites / set_favorite) ⇒ 429 + Retry-After, before any read or write');

  // ── 11. a failure ⇒ a sanitized 503, never a stack ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    const orig = db.ref; db.ref = (p) => { const r = orig(p); if (String(p).startsWith('user_favorites/')) r.transaction = async () => { throw new Error('boom secret-path'); }; return r; };
    const r = await quietly(() => h.fav(`tok-${A}`, 'x_pizza', true));
    assert.deepStrictEqual([r.code, r.body], [503, { ok: false, reason: 'unavailable', retryable: true }]);
  }
  ok('an unexpected failure ⇒ 503 { reason: unavailable, retryable } — no message or stack leaves');

  // ── 11b. Codex asm9b r1 P2: the add-time identity/name READ rejected (an outage) ⇒ refused 503, no favorite data, no write ──
  {
    const db = fakeDb(); seedRestaurants(db); const h = harness(db);
    const before = JSON.stringify(db.get(`user_favorites/${A}`) ?? null);
    let tx = 0;
    const orig = db.ref;
    db.ref = (p) => { const r = orig(p);
      if (String(p) === 'restaurants/x_pizza/identity/name') r.once = async () => { throw new Error('rtdb unavailable'); };
      if (String(p).startsWith('user_favorites/')) { const t = r.transaction; r.transaction = (...a) => { tx += 1; return t.apply(r, a); }; }
      return r; };
    const r = await quietly(() => h.fav(`tok-${A}`, 'x_pizza', true));
    assert.deepStrictEqual([r.code, r.body], [503, { ok: false, reason: 'unavailable', retryable: true }], '🔴 a rejected identity/name read ⇒ 503 (refused; no favorite data)');
    assert.strictEqual(tx, 0, '🔴 a rejected identity/name read ⇒ no favorites transaction');
    assert.strictEqual(JSON.stringify(db.get(`user_favorites/${A}`) ?? null), before, '🔴 a rejected identity/name read ⇒ nothing written');
  }
  ok('a rejected identity/name read on add ⇒ 503 unavailable; no favorites transaction, nothing written');

  FINISHED = true;
  console.log(`\nmy-favorites: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmy-favorites: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
