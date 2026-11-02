'use strict';
// S-A (d) customer read — getMyRating(order_id): the C-2 rating sheet's ONE read of the caller's own rating, under the SAME predicate as
// the writer (rateOrderCore): a verified customer token, the uid NOT tombstoned, and the order's customer_uid === that uid — any failure
// is ONE generic 403 (never revealing whether the order or a rating exists). The payload comes ONLY through rating-v2.readCountable
// (live, owner not tombstoned) AND only when the node's owner_uid is the caller; the window comes from rating-v2.readRatingWindow
// (fulfilled_at + state, never a payload field). Orders, ratings and deletions through the REAL writers.
// Run: node ratings/my-rating.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'my-rating-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const V2 = require('./rating-v2');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const MR = require('./my-rating');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-rating: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {}; const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const ref = (p = '') => ({
    get: async () => { reads.push(p); return snap(get(p)); }, once: async () => { reads.push(p); return snap(get(p)); },
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
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
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-staff': { uid: 'staff1' }, 'tok-hh': { uid: A, customer: true, handheld: true } };
const verifyIdToken = async (t) => { if (!TOK[t]) throw new Error('bad'); return TOK[t]; };
const usableCtx = (rid) => ({ usableAsIdentity: true, objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `${rid}-dish-${i}` })) });
async function place(db, uid, id) {
  const body = [{ name: 'Margherita', qty: 1 }];
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: 1, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: 'x_pizza', priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: 1, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: 'x_pizza', items: body });
  await db.ref().update(u);
}
const fulfil = async (db, id, now) => { db.set(`orders/${id}/status`, 'delivered'); return stampRatingFulfilment(db, { orderId: id, status: 'delivered', now }); };
const rate = (db, uid, body, now) => rateOrderCore(db, { body, idToken: `tok-${uid}`, now, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
const DISH = 'x_pizza-dish-' + Object.keys(MENU_BY_RESTAURANT.x_pizza).indexOf('Margherita');
const rl = [];
const policyOk = (cfg) => !!cfg && Number.isSafeInteger(cfg.windowMs) && cfg.windowMs > 0 && Number.isSafeInteger(cfg.max) && cfg.max > 0;
const h = (db, { limited = false, now = 10_000 } = {}) => MR.makeMyRating({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }), now: () => now,
  checkRateLimit: async (_d, bucket, key, cfg) => { assert.ok(policyOk(cfg), `🔴 checkRateLimit(${bucket}) called without a valid policy — production fails OPEN there`); rl.push({ bucket, key, cfg }); return limited ? { allowed: false, retryAfterSec: 5 } : { allowed: true, retryAfterSec: 0 }; } }).getMyRating;
async function call(fn, { token, query, method = 'GET' } = {}) {
  const headers = token ? { 'x-firebase-id-token': token } : {};
  const req = { method, query: query || {}, headers, get: (k) => headers[String(k).toLowerCase()] };
  const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  await fn(req, res); return res;
}
const GENERIC = { ok: false, error: 'not_allowed' };
const W = V2.WINDOW_MS;

(async () => {
  // ── 1. the writer's predicate: a verified, non-tombstoned customer who IS the order's customer — else ONE generic 403 ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-1'); await place(db, null, 'XPZ-g'); await fulfil(db, 'XPZ-1', 1000); await fulfil(db, 'XPZ-g', 1000);
    for (const [why, o] of [['no token', {}], ['a bad token', { token: 'nope' }], ['a staff (non-customer) token', { token: 'tok-staff' }], ['a handheld token', { token: 'tok-hh' }],
      ['ANOTHER customer', { token: `tok-${B}` }], ['a guest order (no customer_uid)', { token: `tok-${A}`, query: { order_id: 'XPZ-g' } }],
      ['an unknown order', { token: `tok-${A}`, query: { order_id: 'XPZ-none' } }]]) {
      const r = await call(h(db), { query: { order_id: 'XPZ-1' }, ...o });
      assert.strictEqual(r.code, 403, `🔴 ${why} ⇒ ${r.code}`); assert.deepStrictEqual(r.body, GENERIC, `${why}: the ONE generic refusal`);
    }
    // the SHARED predicate (customerUidOf) also refuses a handheld token on the WRITER (tightened with this read)
    const hw = await rateOrderCore(db, { body: { order_id: 'XPZ-1', store: 5 }, idToken: 'tok-hh', now: 2000, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
    assert.strictEqual(hw.httpStatus, 403, '🔴 a handheld token never rates as a customer either');
    db.set(`deleted_uids/${A}`, 5);
    const t = await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-1' } });
    assert.strictEqual(t.code, 403, '🔴 a tombstoned caller ⇒ 403'); assert.deepStrictEqual(t.body, GENERIC);
  }
  ok('the writer\'s predicate: no / bad / staff / handheld token, another customer, a guest order, an unknown order and a tombstoned caller ⇒ the ONE generic 403');

  // ── 2. strict request ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-1');
    for (const q of [{}, { order_id: '../x' }, { order_id: 'XPZ-1', uid: B }, { order_id: ['XPZ-1'] }])
      assert.strictEqual((await call(h(db), { token: `tok-${A}`, query: q })).code, 400, `🔴 ${JSON.stringify(q)} ⇒ 400`);
    assert.strictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-1' }, method: 'POST' })).code, 405);
    const r = await call(h(db, { limited: true }), { token: `tok-${A}`, query: { order_id: 'XPZ-1' } });
    assert.strictEqual(r.code, 429); assert.ok(rl.some((x) => x.bucket === 'get_my_rating' && x.key === A), 'limited per verified uid');
  }
  ok('strict request: GET only, exactly order_id (the ORDER_ID shape); anything else ⇒ 400; per-uid rate limit ⇒ 429');

  // ── 3. the states the C-2 sheet renders — all through the real writers ──
  {
    const db = fakeDb();
    // not fulfilled yet ⇒ nothing to rate
    await place(db, A, 'XPZ-nf');
    assert.deepStrictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-nf' } })).body, { ok: true, rating: null, can_rate: false, editable_until: null }, 'not fulfilled');
    // fulfilled, unrated ⇒ can rate until fulfilled_at + 7 d
    await place(db, A, 'XPZ-u'); await fulfil(db, 'XPZ-u', 1000);
    assert.deepStrictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-u' } })).body, { ok: true, rating: null, can_rate: true, editable_until: 1000 + W }, 'fulfilled, unrated');
    // rated (v2: store, dish, delivery, comment) ⇒ the caller's OWN payload, editable
    { const rr = await rate(db, A, { order_id: 'XPZ-u', store: 4, dishes: { [DISH]: 1 }, delivery: -1, comment: 'Rica' }, 2000); assert.strictEqual(rr.httpStatus, 200, JSON.stringify(rr.body)); }
    const r = await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-u' } });
    assert.deepStrictEqual(r.body, { ok: true, rating: { store: 4, dishes: { [DISH]: 1 }, delivery: -1, comment: 'Rica', legacy_thumb: null, rated_at: 2000, edited_at: null }, can_rate: true, editable_until: 1000 + W });
    assert.strictEqual(r.h['Cache-Control'], 'no-store');
    assert.ok(!/owner_uid|token_hash|revoked|restaurant_id|"state"|"rev"|fulfilled_at/.test(JSON.stringify(r.body)), '🔴 no authority / identity field leaves the server');
    // edited ⇒ the new text + edited_at
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-u', comment: 'Riquísima' }, 3000)).httpStatus, 200);
    const e = (await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-u' } })).body.rating;
    assert.strictEqual(e.comment, 'Riquísima'); assert.strictEqual(e.edited_at, 3000); assert.strictEqual(e.store, 4, 'fields absent from the edit are kept');
    // past the window ⇒ still shown, no longer editable
    const late = (await call(h(db, { now: 1000 + W + 1 }), { token: `tok-${A}`, query: { order_id: 'XPZ-u' } })).body;
    assert.strictEqual(late.can_rate, false); assert.strictEqual(late.rating.comment, 'Riquísima');
    // withdrawn ⇒ no payload (the sheet shows «Calificar» again inside the window: a withdrawn → live re-rating is allowed)
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-u', action: 'withdraw' }, 4000)).httpStatus, 200);
    assert.deepStrictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-u' } })).body, { ok: true, rating: null, can_rate: true, editable_until: 1000 + W }, '🔴 withdrawn ⇒ no payload, re-ratable');
    // deleted (terminal; the account-deletion redaction) ⇒ closed for good
    await place(db, A, 'XPZ-d'); await fulfil(db, 'XPZ-d', 1000);
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-d', store: 5, comment: 'x' }, 2000)).httpStatus, 200);
    await V2.ratingRef(db, 'XPZ-d').transaction(V2.deletionUpdater({}));
    assert.deepStrictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-d' } })).body, { ok: true, rating: null, can_rate: false, editable_until: null }, '🔴 a deleted node ⇒ closed, no payload');
    // legacy v1 thumb only ⇒ shown as legacy_thumb, no stars
    await place(db, A, 'XPZ-v1'); db.set('orders/XPZ-v1/status', 'delivered');
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-v1', thumb: 'up' }, 2000)).httpStatus, 200);
    const v1 = (await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-v1' } })).body;
    assert.deepStrictEqual(v1.rating, { store: null, dishes: {}, delivery: null, comment: null, legacy_thumb: 1, rated_at: 2000, edited_at: null }); assert.strictEqual(v1.can_rate, false, 'no fulfilment stamp ⇒ v2 closed');
  }
  ok('states: not fulfilled ⇒ nothing; fulfilled + unrated ⇒ can_rate until fulfilled_at + 7 d; rated ⇒ the caller\'s own payload (store / dishes / delivery / comment / legacy_thumb / rated_at / edited_at) and nothing of the authority; edited ⇒ the new text; past the window ⇒ shown, not editable; withdrawn ⇒ no payload, re-ratable; deleted ⇒ closed; a v1 thumb ⇒ legacy_thumb only');

  // ── 4. the payload ONLY via the reader contract, and ONLY the caller's own node ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-o'); await fulfil(db, 'XPZ-o', 1000);
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-o', store: 3, comment: 'mío' }, 2000)).httpStatus, 200);
    // the node names ANOTHER owner (a re-attribution the caller doesn't hold) ⇒ no payload, even though the order is the caller's
    db.set('ratings_v2/XPZ-o/owner_uid', B);
    assert.strictEqual((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-o' } })).body.rating, null, '🔴 a node owned by someone else never leaves the server');
    // the node's owner tombstoned (readCountable) ⇒ no payload
    db.set('ratings_v2/XPZ-o/owner_uid', A); db.reads.length = 0;
    assert.ok((await call(h(db), { token: `tok-${A}`, query: { order_id: 'XPZ-o' } })).body.rating, 'premise: shown');
    assert.ok(db.reads.includes(`deleted_uids/${A}`), 'the tombstone is checked');
  }
  ok('the payload leaves ONLY through readCountable (live, owner not tombstoned) AND only when the node\'s owner_uid is the caller');

  FINISHED = true;
  console.log(`my-rating: OK (${n})`);
})().catch((e) => { process.stderr.write(`my-rating: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
