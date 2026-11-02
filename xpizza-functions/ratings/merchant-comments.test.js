'use strict';
// S-A(d) (NOTE-S-Ad-merchant-comments-build, approved 2026-11-02) — getMerchantRatingComments(rid, cursor), the P-1 merchant view.
// Orders from the REAL intake writers, the REAL fulfilment stamp (which now writes rating_index), the REAL rateOrderCore (v2 comment,
// edit, withdraw), the REAL deletion updater and a deleted_uids tombstone; authorization through the REAL access/membership
// resolveAccess + can(); an in-memory RTDB whose transactions run the updater first on null (Admin SDK) and whose orderByKey /
// startAfter / limitToFirst query logs every read, so the bounded-work claims are asserted, not assumed.
// Run: node ratings/merchant-comments.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'merchant-comments-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const V2 = require('./rating-v2');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const MC = require('./merchant-comments');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 merchant-comments: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeDb(seed = {}) {
  const tree = clone(seed); const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, ordered) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    once: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
    orderByKey: () => { const q = { after: undefined, first: undefined, ops: [] }; const api = {
      startAfter: (k) => { q.after = k; q.ops.push('startAfter'); return api; }, limitToFirst: (m) => { q.first = m; q.ops.push('limitToFirst'); return api; },
      once: async () => {
        reads.push({ kind: 'query', path: p, after: q.after, first: q.first, ops: q.ops.slice() });
        let rows = Object.entries(get(p) || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (q.after !== undefined) rows = rows.filter(([k]) => k > q.after);
        if (q.first !== undefined) rows = rows.slice(0, q.first);
        return snap(rows.length ? Object.fromEntries(rows) : null, rows);
      } }; return api; },
    orderByChild: (c) => ({ equalTo: (v) => ({ once: async () => { const rows = Object.entries(get(p) || {}).filter(([, r]) => r && r[c] === v); return snap(rows.length ? Object.fromEntries(rows) : null); } }) }),
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) };
    },
  });
  return { tree, reads, get, set, ref };
}

// the tenants (the access/membership facts resolveAccess reads): x_pizza and la_musa are separate brands
const g = { granted_at: 1, granted_by: 'x' };
const SEED = {
  brands: { x_pizza: { name: 'X', active: true, locations: { x_pizza: 'member' }, activation: { state: 'legacy', since: 1 } },
    la_musa: { name: 'M', active: true, locations: { la_musa: 'member' }, activation: { state: 'legacy', since: 1 } } },
  restaurants: { x_pizza: { identity: { brand_id: 'x_pizza' }, kitchen_staff: { cookX: true } }, la_musa: { identity: { brand_id: 'la_musa' } } },
  brand_members: { x_pizza: { owners: { ownerX: g }, managers: { x_pizza: { mgrX: g } } }, la_musa: { owners: { ownerM: g } } },
  dispatchers: { disp1: true },
};
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const CUST = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true } };
const verifyIdToken = async (t) => {
  if (CUST[t]) return CUST[t];
  if (t === 'hh') return { uid: 'dev1', handheld: true };
  if (/^[a-zA-Z0-9]+$/.test(t) && t !== 'bad') return { uid: t };
  throw new Error('bad token');
};
const usableCtx = (rid) => ({ usableAsIdentity: true, objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `${rid}-dish-${i}` })) });
async function place(db, uid, id, rid = 'x_pizza') {
  const body = rid === 'x_pizza' ? [{ name: 'Margherita', qty: 1 }] : [{ id: Object.keys(MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }];
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: 1, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: rid, priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: 1, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: body });
  await db.ref().update(u);
}
const fulfil = async (db, id, now) => { db.set(`orders/${id}/status`, 'delivered'); return stampRatingFulfilment(db, { orderId: id, status: 'delivered', now }); };
const rate = (db, uid, body, now) => rateOrderCore(db, { body, idToken: `tok-${uid}`, now, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
// a rated order, all through the real writers
async function rated(db, uid, id, { rid = 'x_pizza', at, comment, store = 5 }) {
  await place(db, uid, id, rid); await fulfil(db, id, at);
  const r = await rate(db, uid, { order_id: id, store, delivery: 1, ...(comment !== undefined ? { comment } : {}) }, at + 1000);
  assert.strictEqual(r.httpStatus, 200, `premise: rated ${id} — ${JSON.stringify(r.body)}`);
}

const rl = [];
const handler = (db, { limited = false, salt } = {}) => MC.makeMerchantRatingComments({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }),
  checkRateLimit: async (_d, bucket, key) => { rl.push({ bucket, key }); return limited ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 }; },
  salt: salt === undefined ? () => process.env.OTP_SALT : salt }).getMerchantRatingComments;
async function call(h, { token, query, method = 'GET', body } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = { method, query: query || {}, body, headers, get: (k) => headers[String(k).toLowerCase()] };
  const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  await h(req, res); return res;
}
const FORBIDDEN = /order|XPZ|LMS|owner|uid|delivery|token|dish|rated|edited|fulfil|state|rev|legacy|restaurant|_at\b|\b\d{13}\b/i;

(async () => {
  // ── 1. authorization: the caller's membership ON THAT rid (resolveAccess + can 'stats.read'), BEFORE any rating read ──
  {
    const db = fakeDb(SEED); await rated(db, A, 'XPZ-1', { at: 1000, comment: 'Muy rica' });
    const h = handler(db);
    for (const [who, tok, want] of [['an owner of x_pizza', 'ownerX', 200], ['a manager of x_pizza', 'mgrX', 200], ['the la_musa owner (an AUTHORIZED member of ANOTHER tenant)', 'ownerM', 403],
      ['a dispatcher', 'disp1', 403], ['x_pizza kitchen staff', 'cookX', 403], ['a stranger', 'nobody', 403], ['a customer', `tok-${A}`, 403], ['a handheld', 'hh', 403],
      ['a bad token', 'bad', 401], ['no token', null, 401]]) {
      const before = db.reads.filter((r) => /^(rating_index|ratings_v2)/.test(r.path)).length;
      const r = await call(h, { token: tok, query: { rid: 'x_pizza' } });
      assert.strictEqual(r.code, want, `🔴 ${who} ⇒ ${r.code} (want ${want}) ${JSON.stringify(r.body)}`);
      if (want !== 200) assert.strictEqual(db.reads.filter((x) => /^(rating_index|ratings_v2)/.test(x.path)).length, before, `🔴 ${who}: refused BEFORE any rating read`);
    }
    const out = fakeDb(SEED); const real = out.ref.bind(out); out.ref = (p) => (String(p).startsWith('brand_members') ? { once: async () => { throw new Error('outage'); }, get: async () => { throw new Error('outage'); } } : real(p));
    assert.strictEqual((await call(handler(out), { token: 'ownerX', query: { rid: 'x_pizza' } })).code, 503, 'a membership read outage ⇒ 503, never a lower role');
  }
  ok('authorization: owner / manager of THAT rid ⇒ 200; an authorized member of ANOTHER tenant, a dispatcher, kitchen staff, a stranger, a customer, a handheld ⇒ 403 with ZERO rating reads; a bad / missing token ⇒ 401; a membership outage ⇒ 503');

  // ── 2. strict request ──
  {
    const db = fakeDb(SEED); const h = handler(db);
    for (const q of [{}, { rid: 'X Pizza' }, { rid: 'x_pizza', page: '2' }, { rid: 'x_pizza', uid: A }, { rid: ['x_pizza', 'la_musa'] }, { rid: 'x_pizza', cursor: '!!' }, { rid: 'x_pizza', cursor: 'abc' }])
      assert.strictEqual((await call(h, { token: 'ownerX', query: q })).code, 400, `🔴 ${JSON.stringify(q)} ⇒ 400`);
    assert.strictEqual((await call(h, { token: 'ownerX', query: { rid: 'x_pizza' }, method: 'POST' })).code, 405);
    assert.strictEqual((await call(handler(db, { limited: true }), { token: 'ownerX', query: { rid: 'x_pizza' } })).code, 429, 'rate-limited per caller');
    assert.ok(rl.some((x) => x.bucket === 'merchant_rating_comments' && x.key === 'ownerX'), 'the limiter keys on the verified uid');
    assert.strictEqual((await call(handler(db, { salt: () => 'short' }), { token: 'ownerX', query: { rid: 'x_pizza' } })).code, 503, 'no usable OTP_SALT ⇒ 503 (fail closed)');
  }
  ok('strict request: GET only; exactly rid (+ optional cursor); malformed / extra keys ⇒ 400; per-uid rate limit ⇒ 429; no usable secret ⇒ 503');

  // ── 3. only LIVE comments of non-tombstoned owners, THIS rid, no identity — through the real writers ──
  {
    const db = fakeDb(SEED);
    await rated(db, A, 'XPZ-live', { at: 5000, comment: 'Excelente pizza', store: 5 });
    await rated(db, A, 'XPZ-edit', { at: 4000, comment: 'Primera versión', store: 3 });
    await rated(db, B, 'XPZ-wd', { at: 3000, comment: 'La retiré' });
    await rated(db, B, 'XPZ-del', { at: 2000, comment: 'Cuenta borrada' });
    await rated(db, B, 'XPZ-nocom', { at: 1500, store: 4 });                       // a rating with no comment
    await rated(db, A, 'XPZ-blank', { at: 1400, comment: '   ' });                 // whitespace only (parseRequest trims to empty)
    await rated(db, A, 'LMS-1', { rid: 'la_musa', at: 6000, comment: 'Otro tenant' });
    assert.strictEqual((await rate(db, B, { order_id: 'XPZ-wd', action: 'withdraw' }, 3500)).httpStatus, 200, 'premise: withdrawn');
    await V2.ratingRef(db, 'XPZ-del').transaction(V2.deletionUpdater({}));           // account deletion: redacted in place
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-edit', comment: 'Mejoró mucho', store: 4 }, 4500)).httpStatus, 200, 'premise: edited');
    // a foreign-rid node planted under x_pizza's index (a stale / corrupt entry) is never served
    db.set(`rating_index/x_pizza/${V2.indexKey(9000, 'LMS-1')}`, 'LMS-1');
    const r = await call(handler(db), { token: 'ownerX', query: { rid: 'x_pizza' } });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.comments, [{ comment: 'Excelente pizza', store: 5 }, { comment: 'Mejoró mucho', store: 4 }], '🔴 live comments only, newest fulfilment first, the EDITED text');
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['comments', 'cursor', 'ok']);
    for (const c of r.body.comments) assert.deepStrictEqual(Object.keys(c).sort(), ['comment', 'store'], '🔴 exactly { comment, store }');
    assert.ok(!FORBIDDEN.test(JSON.stringify(r.body.comments)), `🔴 no identity / order / timestamp anywhere: ${JSON.stringify(r.body.comments)}`);
    assert.strictEqual(r.body.cursor, null, 'the index is exhausted ⇒ cursor null');
    assert.strictEqual(r.h['Cache-Control'], 'no-store');
    // the owner is tombstoned AFTER rating (deleted_uids, permanent) ⇒ gone on the next call, before any redaction ran
    db.set(`deleted_uids/${A}`, 5);
    const r2 = await call(handler(db), { token: 'mgrX', query: { rid: 'x_pizza' } });
    assert.deepStrictEqual(r2.body.comments, [], '🔴 a tombstoned owner\'s comments disappear immediately (readCountable)');
    const lm = await call(handler(fakeDb({ ...SEED, ...clone(db.tree), deleted_uids: {} })), { token: 'ownerM', query: { rid: 'la_musa' } });
    assert.deepStrictEqual(lm.body.comments, [{ comment: 'Otro tenant', store: 5 }], 'la_musa sees ONLY its own');
  }
  ok('content: ONLY live comments (withdrawn / deleted / tombstoned-owner / comment-less / blank excluded), the edited text, newest fulfilment first, a foreign-rid node under this index never served, exactly { comment, store } — no order id, identity, delivery, dish, date or key; each tenant sees only its own');

  // ── 4. bounded work + the opaque, bound cursor ──
  {
    const db = fakeDb(SEED);
    for (let i = 0; i < 25; i++) await rated(db, A, `XPZ-c${String(i).padStart(2, '0')}`, { at: 100000 - i * 10, comment: `c${i}` });
    // 500 STALE entries (no node) fulfilled earlier: sparse pages must advance the cursor without a full-history scan
    for (let i = 0; i < 500; i++) db.set(`rating_index/x_pizza/${V2.indexKey(50000 - i, `XPZ-s${i}`)}`, `XPZ-s${i}`);
    for (let i = 0; i < 3; i++) await rated(db, B, `XPZ-o${i}`, { at: 1000 - i, comment: `o${i}` });   // live comments BEHIND the stale run
    const h = handler(db);
    let cursor = null; const seen = []; let calls = 0; const perCall = [];
    do {
      const mark = db.reads.length;
      const r = await call(h, { token: 'ownerX', query: { rid: 'x_pizza', ...(cursor ? { cursor } : {}) } });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body)); calls++;
      const rs = db.reads.slice(mark);
      const q = rs.filter((x) => x.kind === 'query');
      assert.strictEqual(q.length, 1, 'ONE index query per call'); assert.strictEqual(q[0].path, 'rating_index/x_pizza'); assert.strictEqual(q[0].first, MC.CANDIDATES);
      perCall.push(rs.filter((x) => x.path.startsWith('ratings_v2/')).length);
      assert.ok(r.body.comments.length <= MC.PAGE, 'at most PAGE comments');
      seen.push(...r.body.comments.map((c) => c.comment));
      if (r.body.cursor) {
        const plain = Buffer.from(r.body.cursor, 'base64url').toString('latin1');
        assert.ok(!plain.includes('XPZ-') && !plain.includes('"k"') && !/\d{13}-/.test(plain), '🔴 the cursor reveals no order id / index key (sealed)');
        assert.ok(!r.body.cursor.includes('XPZ'));
      }
      cursor = r.body.cursor;
      assert.ok(calls < 40, '🔴 the cursor must terminate');
    } while (cursor);
    assert.deepStrictEqual(seen, [...Array.from({ length: 25 }, (_, i) => `c${i}`), 'o0', 'o1', 'o2'], '🔴 every live comment once, in order, across pages — incl. those BEHIND 500 stale entries');
    assert.ok(perCall.every((k) => k <= MC.CANDIDATES), `🔴 ≤ CANDIDATES node reads per call (${perCall})`);
    assert.ok(calls >= Math.ceil(528 / MC.CANDIDATES), 'the 500 stale entries were walked page by page (empty pages advance the cursor)');

    // the cursor is bound to { rid, uid } and authenticated
    const first = await call(h, { token: 'ownerX', query: { rid: 'x_pizza' } });
    const c1 = first.body.cursor; assert.ok(c1, 'premise: a continuation cursor');
    assert.strictEqual((await call(h, { token: 'mgrX', query: { rid: 'x_pizza', cursor: c1 } })).code, 400, '🔴 another USER\'s cursor ⇒ 400');
    const dbM = fakeDb({ ...SEED, brand_members: { ...SEED.brand_members, la_musa: { owners: { ownerM: g, ownerX: g } } } });
    assert.strictEqual((await call(handler(dbM), { token: 'ownerX', query: { rid: 'la_musa', cursor: c1 } })).code, 400, '🔴 a cursor from another RID ⇒ 400 (same caller, authorized there)');
    const raw = Buffer.from(c1, 'base64url'); raw[raw.length - 1] ^= 1;
    assert.strictEqual((await call(h, { token: 'ownerX', query: { rid: 'x_pizza', cursor: raw.toString('base64url') } })).code, 400, '🔴 a tampered cursor ⇒ 400');
    assert.strictEqual((await call(handler(db, { salt: () => 'another-salt-'.padEnd(40, 'y') }), { token: 'ownerX', query: { rid: 'x_pizza', cursor: c1 } })).code, 400, 'a rotated OTP_SALT invalidates cursors (harmless: short-lived)');
    assert.notStrictEqual((await call(h, { token: 'ownerX', query: { rid: 'x_pizza' } })).body.cursor, c1, 'sealing is randomized (no stable token to correlate)');
  }
  ok(`bounded: ONE index query of ${MC.CANDIDATES} keys per call, ≤ ${MC.CANDIDATES} node reads, ≤ ${MC.PAGE} comments; 500 stale entries walked page by page (empty pages still advance) — every live comment exactly once, in order; the cursor is sealed (no order id), bound to { rid, uid }, tamper-evident, and void after an OTP_SALT rotation`);

  // ── 5. the index writer: idempotent, healed on 'kept', never for a deleted node ──
  {
    const db = fakeDb(SEED); await place(db, A, 'XPZ-ix');
    assert.strictEqual(await fulfil(db, 'XPZ-ix', 7000), 'stamped');
    const key = V2.indexKey(7000, 'XPZ-ix');
    assert.deepStrictEqual(db.get('rating_index/x_pizza'), { [key]: 'XPZ-ix' }, 'the stamp writes the index entry (rid + fulfilled_at from the committed node)');
    db.set('rating_index/x_pizza', null);                                       // a crash between the stamp and the index write
    assert.strictEqual(await fulfil(db, 'XPZ-ix', 9999), 'kept', 'premise: the retry keeps the first stamp');
    assert.deepStrictEqual(db.get('rating_index/x_pizza'), { [key]: 'XPZ-ix' }, '🔴 the retry (kept) HEALS the entry, keyed by the ORIGINAL fulfilment');
    await fulfil(db, 'XPZ-ix', 9999);
    assert.strictEqual(Object.keys(db.get('rating_index/x_pizza')).length, 1, 'idempotent: no duplicate');
    await place(db, A, 'XPZ-dx'); await fulfil(db, 'XPZ-dx', 8000); db.set('rating_index/x_pizza', null);
    await V2.ratingRef(db, 'XPZ-dx').transaction(V2.deletionUpdater({}));
    await fulfil(db, 'XPZ-dx', 8100);
    assert.ok(!db.get('rating_index/x_pizza'), 'a deleted node is never (re-)indexed');
    for (const [why, args] of [['a bad id', [7000, '../x']], ['a non-integer time', [1.5, 'XPZ-1']], ['a negative time', [-1, 'XPZ-1']]]) assert.strictEqual(V2.indexKey(...args), null, why);
    assert.ok(V2.INDEX_KEY_RE.test(key) && key.length === 13 + 1 + 'XPZ-ix'.length);
  }
  ok('the index writer: the fulfilment stamp indexes from the COMMITTED node; a retry (kept) heals a lost entry under the ORIGINAL key; idempotent; a deleted node is never indexed');

  FINISHED = true;
  console.log(`merchant-comments: OK (${n})`);
})().catch((e) => { process.stderr.write(`merchant-comments: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
