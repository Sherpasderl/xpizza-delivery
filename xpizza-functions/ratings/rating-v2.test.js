'use strict';
// S-A1 — ratings v2 (NOTE-S-A-ratings-v2-build, approved 2026-11-01). Orders from the REAL intake writers (buildCreateOrderUpdates +
// attachCustomerAttribution), the REAL fulfilment stamp core, the REAL rateOrderCore and the REAL deleteAccountCore, over an
// in-memory RTDB whose transactions run the updater FIRST on null (the Admin SDK's uncached run) like production.
// Run: node ratings/rating-v2.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'rating-v2-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const path = require('path');
const FN = path.join(__dirname, '..');
const V2 = require('./rating-v2');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));
const SE = require(path.join(FN, 'signup-endpoints'));
const ACCOUNT = require(path.join(FN, 'account-lib'));
const { guard } = require(path.join(FN, 'tools', 'ratings-v1-guard'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 rating-v2: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function fakeDb() {
  const tree = {};
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  // RTDB drops nulls and empty objects on write
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)) });
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
    orderByChild: (c) => { const q = { eq: undefined, start: undefined }; const api = {
      equalTo: (v) => { q.eq = v; return api; }, startAt: (v) => { q.start = v; return api; }, limitToFirst: () => api,
      once: async () => { const out = {}; for (const [k, row] of Object.entries(get(p) || {})) { const v = row && row[c]; if (q.eq !== undefined && v !== q.eq) continue; if (q.start !== undefined && !(v != null && v >= q.start)) continue; out[k] = row; } return snap(Object.keys(out).length ? out : null); } }; return api; },
    transaction: async (fn) => { fn(null); const next = fn(clone(get(p)) ?? null); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) }; },
  });
  return { tree, get, set, ref };
}
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true } };
const verifyIdToken = async (t) => { if (!TOK[t]) throw new Error('bad'); return TOK[t]; };
const cidOf = (rid, k) => `${rid}-dish-${Object.keys(MENU_BY_RESTAURANT[rid]).indexOf(k)}`;
const usableCtx = (rid) => ({ usableAsIdentity: true, objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k) => ({ kind: 'dish', legacyKey: k, canonicalId: cidOf(rid, k) })) });
// the REAL intake: a member's (or a guest's, uid null) order + its history entry
async function place(db, uid, id, { rid = 'x_pizza', items } = {}) {
  const body = items || (rid === 'x_pizza' ? [{ name: 'Margherita', qty: 1 }] : [{ id: Object.keys(MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }]);
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: 1, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: rid, priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: 1, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: body });
  await db.ref().update(u);
}
const fulfil = async (db, id, status = 'delivered', now = 1000) => { db.set(`orders/${id}/status`, status); return stampRatingFulfilment(db, { orderId: id, status, now }); };
const rate = (db, uid, body, { now = 2000, resolveContext = async (rid) => usableCtx(rid) } = {}) => rateOrderCore(db, { body, idToken: `tok-${uid}`, now, verifyIdToken, resolveContext });
const node = (db, id) => V2.normalize(db.get(`ratings_v2/${id}`));

(async () => {
  // ── 1. the request shapes: legacy v1, rich v2, withdraw — anything else ⇒ invalid ──
  {
    assert.deepStrictEqual(V2.parseRequest({ order_id: 'O1', thumb: 'up' }), { ok: true, kind: 'v1', orderId: 'O1', thumb: 1 });
    assert.deepStrictEqual(V2.parseRequest({ order_id: 'O1', thumb: 'down' }).thumb, -1);
    assert.deepStrictEqual(V2.parseRequest({ order_id: 'O1', action: 'withdraw' }), { ok: true, kind: 'withdraw', orderId: 'O1' });
    assert.deepStrictEqual(V2.parseRequest({ order_id: 'O1', store: 4, delivery: -1, comment: '  rico  ' }), { ok: true, kind: 'v2', orderId: 'O1', fields: { store: 4, delivery: -1, comment: 'rico' } });
    for (const bad of [null, [], {}, { order_id: '../x', thumb: 'up' }, { order_id: 'O1' }, { order_id: 'O1', thumb: 'meh' }, { order_id: 'O1', thumb: 'up', store: 5 },
      { order_id: 'O1', store: 0 }, { order_id: 'O1', store: 6 }, { order_id: 'O1', store: 2.5 }, { order_id: 'O1', delivery: 2 }, { order_id: 'O1', comment: 'x'.repeat(501) },
      { order_id: 'O1', dishes: [] }, { order_id: 'O1', dishes: { 'a.b': 1 } }, { order_id: 'O1', dishes: { 'a$b': 1 } }, { order_id: 'O1', dishes: { 'a#b': 1 } }, { order_id: 'O1', dishes: { 'a[0]': 1 } }, { order_id: 'O1', dishes: { '__x__': 1 } }, { order_id: 'O1', dishes: { 'x_pizza-dish-1': 2 } }, { order_id: 'O1', action: 'delete' },
      { order_id: 'O1', dishes: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`d${i}`, 1])) }, { order_id: 'O1', uid: A }])
      assert.strictEqual(V2.parseRequest(bad).ok, false, `🔴 accepted ${JSON.stringify(bad).slice(0, 80)}`);
  }
  ok('request shapes: legacy v1 {thumb} → ±1, v2 {store 1..5|null, dishes {id:±1} ≤30, delivery ±1|null, comment ≤500}, {action:withdraw}; mixed / unknown / out-of-range ⇒ invalid');

  // ── 2. legacy v1: the order's customer, status-based eligibility, ONE ratings_v2 node, legacy_thumb WRITE-ONCE; order_ratings never written ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-1'); await place(db, null, 'XPZ-g');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-1', thumb: 'up' })).body, { ok: false, error: 'not_fulfilled' }, 'not yet fulfilled ⇒ 409');
    db.set('orders/XPZ-1/status', 'delivered');   // v1 is status-based (no fulfilment stamp required), exactly as before
    const r = await rate(db, A, { order_id: 'XPZ-1', thumb: 'up' });
    assert.deepStrictEqual([r.httpStatus, r.body], [200, { ok: true }]);
    const n1 = node(db, 'XPZ-1');
    assert.strictEqual(n1.legacy_thumb, 1); assert.strictEqual(n1.owner_uid, A); assert.strictEqual(n1.state, 'live'); assert.strictEqual(n1.rating_format, 2);
    for (const again of [{ thumb: 'up' }, { thumb: 'down' }]) assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-1', ...again })).body, { ok: true }, 'a retry answers the same 200');
    assert.strictEqual(node(db, 'XPZ-1').legacy_thumb, 1, '🔴 legacy_thumb is WRITE-ONCE (an opposite retry changes nothing)');
    assert.strictEqual(db.get('order_ratings'), undefined, '🔴 order_ratings is never written again');
    for (const [who, id] of [[B, 'XPZ-1'], [A, 'XPZ-g'], [A, 'XPZ-none']]) assert.strictEqual((await rate(db, who, { order_id: id, thumb: 'up' })).httpStatus, 403, `not theirs ⇒ the generic refusal (${who === B ? 'another account' : id})`);
  }
  ok('legacy v1: the order\'s own customer once fulfilled ⇒ ONE ratings_v2 node (legacy_thumb, owner_uid); any retry is the same 200 and legacy_thumb never changes; order_ratings never written; another account / a guest order / an unknown order ⇒ 403');

  // ── 3. the fulfilment stamp: ONLY delivered / completed, set-if-absent, members AND guests, the node created; deleted never touched ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-2'); await place(db, null, 'XPZ-gst');
    assert.strictEqual(await fulfil(db, 'XPZ-2', 'preparing'), 'skip'); assert.strictEqual(db.get('ratings_v2/XPZ-2'), undefined, 'a non-terminal status stamps nothing');
    assert.strictEqual(await fulfil(db, 'XPZ-2', 'delivered', 1000), 'stamped');
    assert.deepStrictEqual([node(db, 'XPZ-2').fulfilled_at, node(db, 'XPZ-2').restaurant_id, node(db, 'XPZ-2').state], [1000, 'x_pizza', 'live']);
    assert.strictEqual(await fulfil(db, 'XPZ-2', 'completed', 5000), 'kept'); assert.strictEqual(node(db, 'XPZ-2').fulfilled_at, 1000, '🔴 set ONCE');
    assert.strictEqual(await fulfil(db, 'XPZ-gst', 'completed', 1500), 'stamped', 'a GUEST order is stamped too (S-A2 rates it)');
    db.set('ratings_v2/XPZ-dead', { rating_format: 2, state: 'deleted', restaurant_id: 'x_pizza', rev: 3 }); db.set('orders/XPZ-dead/restaurant_id', 'x_pizza');
    assert.strictEqual(await fulfil(db, 'XPZ-dead', 'delivered'), 'kept'); assert.ok(!('fulfilled_at' in db.get('ratings_v2/XPZ-dead')), 'a deleted node is never touched');
  }
  ok('fulfilment stamp: only delivered / completed; set ONCE (a later completed keeps the first); members AND guests; the node created live; a deleted node never touched');

  // ── 4. v2 rich rating: needs the stamp; within fulfilled_at + 7 d; edits keep legacy_thumb; out of window / unstamped ⇒ 409 ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-3');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-3', store: 5 })).body, { ok: false, error: 'not_fulfilled' }, '🔴 no fulfilment stamp ⇒ closed to v2');
    db.set('orders/XPZ-3/status', 'delivered'); await rate(db, A, { order_id: 'XPZ-3', thumb: 'down' });   // a legacy thumb first (status-based)
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-3', store: 5 })).body, { ok: false, error: 'not_fulfilled' }, '🔴 a node from a legacy thumb alone (no stamp) is still closed to v2');
    assert.strictEqual((await rate(db, B, { order_id: 'XPZ-3', store: 1 })).httpStatus, 403, '🔴 another account\'s v2 rating ⇒ the generic refusal');
    await fulfil(db, 'XPZ-3', 'delivered', 1000);
    const r = await rate(db, A, { order_id: 'XPZ-3', store: 5, delivery: 1, comment: 'rico' }, { now: 2000 });
    assert.deepStrictEqual([r.httpStatus, r.body], [200, { ok: true }]);
    let x = node(db, 'XPZ-3');
    assert.deepStrictEqual([x.store, x.delivery, x.comment, x.legacy_thumb, x.rev], [5, 1, 'rico', -1, 1], 'the rich fields added; legacy_thumb KEPT');
    await rate(db, A, { order_id: 'XPZ-3', store: 3 }, { now: 3000 });
    x = node(db, 'XPZ-3');
    assert.deepStrictEqual([x.store, x.delivery, x.comment, x.edited_at, x.rev], [3, 1, 'rico', 3000, 2], 'an edit changes only its fields, stamps edited_at, bumps rev');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-3', store: 1 }, { now: 1000 + V2.WINDOW_MS + 1 })).body, { ok: false, error: 'window_closed' }, '🔴 7 days after fulfilment ⇒ closed');
    assert.strictEqual(node(db, 'XPZ-3').store, 3, 'nothing written out of window');
  }
  ok('v2: closed until the fulfilment stamp; inside fulfilled_at + 7 d the rich fields are added (legacy_thumb kept), edits touch only their fields + edited_at + rev; after the window ⇒ 409 window_closed, nothing written');

  // ── 5. dish votes: canonical ids validated against the member's OWN recipe via the ONE resolver, both brands; unusable ⇒ dropped + typed ──
  {
    const db = fakeDb();
    await place(db, A, 'XPZ-4', { items: [{ name: 'Margherita', qty: 1 }, { name: 'Pepperoni', qty: 2 }] }); await fulfil(db, 'XPZ-4');
    await place(db, A, 'LMS-4', { rid: 'la_musa' }); await fulfil(db, 'LMS-4');
    const mar = cidOf('x_pizza', 'Margherita'), pep = cidOf('x_pizza', 'Pepperoni'), lm = cidOf('la_musa', Object.keys(MENU_BY_RESTAURANT.la_musa)[0]);
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-4', dishes: { [mar]: 1, [pep]: -1 } })).body, { ok: true });
    assert.deepStrictEqual(node(db, 'XPZ-4').dishes, { [mar]: 1, [pep]: -1 }, 'stored by CANONICAL id (x_pizza name-keyed recipe)');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'LMS-4', dishes: { [lm]: 1 } })).body, { ok: true }); assert.deepStrictEqual(node(db, 'LMS-4').dishes, { [lm]: 1 }, 'la_musa id-keyed recipe');
    const other = cidOf('x_pizza', Object.keys(MENU_BY_RESTAURANT.x_pizza)[0]);
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-4', dishes: { [other]: 1 } })).body, { ok: false, error: 'dish_not_purchased' }, '🔴 a dish not in the purchased set ⇒ refused');
    assert.deepStrictEqual(node(db, 'XPZ-4').dishes, { [mar]: 1, [pep]: -1 }, 'nothing written on a refusal');
    for (const resolveContext of [async () => ({ usableAsIdentity: false }), async () => { throw new Error('x'); }, undefined]) {
      const r = await rateOrderCore(db, { body: { order_id: 'XPZ-4', dishes: { [mar]: -1 }, store: 4 }, idToken: `tok-${A}`, now: 2500, verifyIdToken, resolveContext });
      assert.deepStrictEqual(r.body, { ok: true, dishes: 'unavailable' }, '🔴 an unusable context ⇒ the dish votes DROPPED, typed');
      assert.strictEqual(node(db, 'XPZ-4').dishes[mar], 1, 'the stored dish vote untouched'); assert.strictEqual(node(db, 'XPZ-4').store, 4, 'the rest recorded');
    }
  }
  ok('dish votes: CANONICAL ids validated against the member\'s own recipe through the one resolver (x_pizza name-keyed + la_musa id-keyed); a non-purchased dish ⇒ 400; an unusable / failing / unwired context ⇒ dish votes dropped with dishes:"unavailable", the rest recorded');

  // ── 6. withdraw: live → withdrawn (node kept); a v2 re-rating re-opens it (withdrawn → live); nothing to withdraw ⇒ 409 ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-5'); await fulfil(db, 'XPZ-5');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-6', action: 'withdraw' })).httpStatus, 403, 'an unknown order ⇒ generic');
    await rate(db, A, { order_id: 'XPZ-5', store: 4 });
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-5', action: 'withdraw' })).body, { ok: true });
    assert.strictEqual(node(db, 'XPZ-5').state, 'withdrawn'); assert.strictEqual(node(db, 'XPZ-5').store, 4, 'the node is kept (excluded from aggregates by state)');
    assert.deepStrictEqual((await rate(db, A, { order_id: 'XPZ-5', action: 'withdraw' })).body, { ok: true }, 'withdrawing twice is the same 200');
    await rate(db, A, { order_id: 'XPZ-5', store: 5 }); assert.strictEqual(node(db, 'XPZ-5').state, 'live', 'a re-rating within the window: withdrawn → live');
    const db2 = fakeDb(); await place(db2, A, 'XPZ-7');
    assert.deepStrictEqual((await rate(db2, A, { order_id: 'XPZ-7', action: 'withdraw' })).body, { ok: false, error: 'not_rated' });
  }
  ok('withdraw: live → withdrawn with the node kept; twice is the same 200; a v2 re-rating re-opens it (withdrawn → live); nothing to withdraw ⇒ 409 not_rated');

  // ── 7. deletion: the REAL deleteAccountCore redacts every rating IN PLACE (state deleted, comment + owner_uid nulled), terminal ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-8'); await place(db, A, 'XPZ-9'); await fulfil(db, 'XPZ-8'); await fulfil(db, 'XPZ-9');
    await rate(db, A, { order_id: 'XPZ-8', store: 5, comment: 'secreto' }); await rate(db, A, { order_id: 'XPZ-9', store: 2 }); await rate(db, A, { order_id: 'XPZ-9', action: 'withdraw' });
    // a paused edit: its transaction is prepared BEFORE the deletion and resumes after it — the ONE-node model must refuse it
    const out = {}; const pausedEdit = V2.v2Updater({ fields: { comment: 'resucitado' }, uid: A, now: 2100 }, out);
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: 3000, revoke: async () => {} }), true);
    for (const id of ['XPZ-8', 'XPZ-9']) {
      const x = node(db, id);
      assert.deepStrictEqual([x.state, x.comment, x.owner_uid], ['deleted', null, null], `🔴 ${id}: redacted in place (comment + identity) and state deleted`);
    }
    assert.strictEqual(node(db, 'XPZ-8').store, 5, 'the fence keeps no identity; the vote leaves every aggregate by state');
    assert.strictEqual(await db.ref('ratings_v2/XPZ-8').transaction(pausedEdit).then((t) => t.committed), false, '🔴 a paused edit resuming after the deletion is REFUSED (no restore)');
    assert.strictEqual(out.outcome, 'closed');
    assert.strictEqual(await SE.redactRatings(db, A), 0, 'a re-run is a no-op (the history is gone; already-deleted nodes untouched)');
    assert.strictEqual(await fulfil(db, 'XPZ-8', 'completed'), 'kept', 'the fence is never re-stamped');
  }
  ok('deletion: the real deleteAccountCore redacts every rating of the account IN PLACE (state deleted, comment + owner_uid nulled; live AND withdrawn), terminal; a paused edit resuming after it is refused; a re-run and a late fulfilment stamp are no-ops');

  // ── 8. the deploy-order guard: 0 legacy order_ratings ⇒ OK; any ⇒ REFUSE ──
  {
    const db = fakeDb();
    assert.deepStrictEqual(await guard({ rtdb: db }), { ok: true, count: 0 });
    db.set('order_ratings/XPZ-old', { thumb: 'up', rated_at: 1, restaurant_id: 'x_pizza' });
    assert.deepStrictEqual(await guard({ rtdb: db }), { ok: false, count: 1 }, '🔴 a v1 record ⇒ REFUSE enabling v2-only reads');
  }
  ok('deploy-order guard: 0 legacy order_ratings ⇒ OK; any ⇒ REFUSE (v2-only reads must wait)');

  FINISHED = true;
  console.log(`\nrating-v2: OK (${n})`);
})().catch((e) => { process.stderr.write(`rating-v2: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
