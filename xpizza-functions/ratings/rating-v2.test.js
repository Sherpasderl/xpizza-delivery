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
const { rateOrderCore, touchRedactJournal } = require('./rate-order');
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
    orderByChild: (c) => { const q = { eq: undefined, start: undefined, end: undefined }; const api = {
      equalTo: (v) => { q.eq = v; return api; }, startAt: (v) => { q.start = v; return api; }, endAt: (v) => { q.end = v; return api; }, limitToFirst: () => api,
      once: async () => { const out = {}; for (const [k, row] of Object.entries(get(p) || {})) { const v = row && row[c]; if (q.eq !== undefined && v !== q.eq) continue; if (q.start !== undefined && !(v != null && v >= q.start)) continue; if (q.end !== undefined && !(v != null && v <= q.end)) continue; out[k] = row; } return snap(Object.keys(out).length ? out : null); } }; return api; },
    // RTDB's EXACT Admin-SDK semantics (Codex S-A1 r1 P1-1): the updater runs FIRST on the (uncached) local value null; returning
    // undefined there ABORTS with NO server round-trip and NO retry. Otherwise the server compares: an actual value ≠ the assumed
    // null ⇒ the updater re-runs on the actual value (undefined then aborts). Never laxer than production.
    transaction: async (fn) => {
      const actual = clone(get(p)) ?? null;
      let next = fn(null);
      if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
      if (actual !== null) { next = fn(actual); if (next === undefined) return { committed: false, snapshot: snap(get(p)) }; }
      set(p, prune(next)); return { committed: true, snapshot: snap(get(p)) };
    },
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
    await db.ref('ratings_v2/XPZ-8').transaction(pausedEdit);   // an identity no-op commit at most (never undefined: P1-1)
    assert.deepStrictEqual([node(db, 'XPZ-8').state, node(db, 'XPZ-8').comment, node(db, 'XPZ-8').owner_uid], ['deleted', null, null], '🔴 a paused edit resuming after the deletion is REFUSED (no restore)');
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

  // ── 9. Codex r1 P1-2 (its exact repro): a LEGACY rateOrder that passed auth is paused, the account is deleted COMPLETELY (no node existed,
  //    so the redaction scan found nothing), then the paused write commits — the post-commit fence (deleted_uids) redacts it ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-p'); db.set('orders/XPZ-p/status', 'delivered');
    let paused = false;
    const pdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'orders/XPZ-p') return r; return { ...r, get: async () => {
      if (!paused) { paused = true; assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: 3000, revoke: async () => {} }), true); db.set(`ratings_redact_pending/${A}`, null); }   // as if already drained
      return r.get(); } }; } };
    assert.strictEqual(db.get('ratings_v2/XPZ-p'), undefined, 'premise: no node at the start');
    const r = await rateOrderCore(pdb, { body: { order_id: 'XPZ-p', thumb: 'up' }, idToken: `tok-${A}`, now: 2000, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
    assert.ok(paused, 'premise: the deletion ran between the auth and the write');
    assert.strictEqual(r.httpStatus, 403, 'the paused write answers the generic refusal');
    const x = node(db, 'XPZ-p');
    assert.deepStrictEqual([x.state, x.owner_uid, x.comment], ['deleted', null, null], '🔴 a paused legacy write after a COMPLETE deletion leaves NO live rating with the deleted uid');
    assert.ok(db.get(`ratings_redact_pending/${A}`), '🔴 the fence RE-CREATES the durable journal entry (a failed inline redaction is still drained)');
  }
  ok('Codex r1 P1-2: a legacy rateOrder paused across a COMPLETE account deletion (no node existed) commits and is redacted by the post-commit fence (deleted_uids) — no live rating carries the deleted uid');

  // ── 10. Codex r1 P1-3: the history write FAILED (claim-order writes it best-effort) — the owner_uid index still finds the rating ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-h'); await fulfil(db, 'XPZ-h');
    await rate(db, A, { order_id: 'XPZ-h', store: 4, comment: 'privado' });
    db.set(`user_orders/${A}/XPZ-h`, null);   // the best-effort history entry is missing
    assert.strictEqual(await SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: 3000, revoke: async () => {} }), true);
    const x = node(db, 'XPZ-h');
    assert.deepStrictEqual([x.state, x.owner_uid, x.comment], ['deleted', null, null], '🔴 a rating outside the history is found by the owner_uid index and redacted');
  }
  ok('Codex r1 P1-3: deletion discovers ratings by the server-only owner_uid index ∪ the history — a rating whose history write failed is still redacted');

  // ── 11. Codex r1 P2: a fulfilment stamp that FAILS propagates (the trigger retries); the retry stamps it once ──
  {
    const db = fakeDb(); await place(db, null, 'XPZ-r'); db.set('orders/XPZ-r/status', 'completed');
    let fail = true;
    const fdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'ratings_v2/XPZ-r') return r; return { ...r, transaction: async (fn) => { if (fail) { fail = false; throw new Error('injected'); } return r.transaction(fn); } }; } };
    await assert.rejects(stampRatingFulfilment(fdb, { orderId: 'XPZ-r', status: 'completed', now: 1000 }), /injected/, '🔴 a failed stamp PROPAGATES (never swallowed)');
    assert.strictEqual(db.get('ratings_v2/XPZ-r'), undefined, 'nothing written by the failed attempt');
    assert.strictEqual(await stampRatingFulfilment(fdb, { orderId: 'XPZ-r', status: 'completed', now: 1100 }), 'stamped', 'the retry stamps');
    assert.strictEqual(await stampRatingFulfilment(fdb, { orderId: 'XPZ-r', status: 'completed', now: 1200 }), 'kept', 'a further retry is a no-op (set-once)');
    assert.strictEqual(node(db, 'XPZ-r').fulfilled_at, 1100);
  }
  ok('Codex r1 P2: a failed fulfilment stamp propagates (the trigger retries it); the retry stamps once; further retries are no-ops');

  // ── 12. the v2 path's fence: a fulfilled, UNRATED node (owner_uid null ⇒ invisible to the index) whose history write failed (invisible to
  //    the history) — a v2 rating paused across the deletion commits after the scan and the post-commit fence redacts it ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-v'); await fulfil(db, 'XPZ-v'); db.set(`user_orders/${A}/XPZ-v`, null);
    let paused = false;
    const pdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'orders/XPZ-v') return r; return { ...r, get: async () => {
      if (!paused) { paused = true; await SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: 3000, revoke: async () => {} }); }
      return r.get(); } }; } };
    const r = await rateOrderCore(pdb, { body: { order_id: 'XPZ-v', store: 5, comment: 'tarde' }, idToken: `tok-${A}`, now: 2000, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
    assert.strictEqual(r.httpStatus, 403);
    const x = node(db, 'XPZ-v');
    assert.deepStrictEqual([x.state, x.owner_uid, x.comment], ['deleted', null, null], '🔴 a paused v2 write after the deletion\'s scan is redacted by the post-commit fence');
  }
  ok('the v2 fence: a fulfilled unrated node (owner_uid null) with a failed history write, rated by a v2 write paused across the deletion, is redacted after its commit');

  // ── 13. Codex r2 repro A: a paused legacy write commits after a COMPLETE deletion and its OWN fence read FAILS — the rating is live,
  //    but the deletion's journal entry (kept past the grace) is drained by pruneResidual through the owner_uid index ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-a'); db.set('orders/XPZ-a/status', 'delivered');
    let paused = false;
    const pdb = { ...db, ref: (p) => { const r = db.ref(p);
      if (p === `deleted_uids/${A}` && paused) return { ...r, get: async () => { throw new Error('fence read failed'); } };
      if (p !== 'orders/XPZ-a') return r;
      return { ...r, get: async () => { if (!paused) { paused = true; await SE.deleteAccountCore(db, ACCOUNT, { uid: A, phoneHash: null, now: 3000, revoke: async () => {} }); } return r.get(); } }; } };
    await assert.rejects(rateOrderCore(pdb, { body: { order_id: 'XPZ-a', thumb: 'up' }, idToken: `tok-${A}`, now: 3005, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) }), /fence read failed/);
    assert.deepStrictEqual([node(db, 'XPZ-a').state, node(db, 'XPZ-a').owner_uid], ['live', A], 'premise: the failed fence left a LIVE rating with the deleted uid');
    assert.deepStrictEqual(db.get(`ratings_redact_pending/${A}`), { at: 3000 }, 'the deletion wrote the durable journal entry in its atomic update');
    const early = await SE.drainRatingRedactions(db, 3000 + 60e3);
    assert.deepStrictEqual([node(db, 'XPZ-a').state, node(db, 'XPZ-a').owner_uid], ['deleted', null], '🔴 the drain redacts the live rating (found by the owner_uid index)');
    assert.ok(db.get(`ratings_redact_pending/${A}`), 'inside the grace the entry is KEPT (a paused write may still land)'); assert.strictEqual(early.cleared, 0);
    const late = await SE.drainRatingRedactions(db, 3000 + SE.REDACT_GRACE_MS);
    assert.strictEqual(db.get(`ratings_redact_pending/${A}`), undefined, 'clean AND past the grace ⇒ the entry is removed'); assert.strictEqual(late.cleared, 1);
  }
  ok('Codex r2 repro A: a paused legacy write commits after a COMPLETE deletion and its own fence read fails — the deletion\'s durable journal entry is drained via the owner_uid index; the entry is removed only once clean AND past the grace');

  // ── 14. Codex r2 repro B: the deletion's inline redaction FAILS after the profile is removed — deletion completes, the journal drains it ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-b'); await fulfil(db, 'XPZ-b'); await rate(db, A, { order_id: 'XPZ-b', store: 2, comment: 'malo' });
    let fail = true;
    const fdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'ratings_v2/XPZ-b') return r; return { ...r, transaction: async (fn) => { if (fail) { fail = false; throw new Error('redaction failed'); } return r.transaction(fn); } }; } };
    const logs = []; const e = console.error; console.error = (...a) => logs.push(a.join(' '));
    let done; try { done = await SE.deleteAccountCore(fdb, ACCOUNT, { uid: A, phoneHash: null, now: 4000, revoke: async () => {} }).catch((err) => `threw: ${err.message}`); } finally { console.error = e; }
    assert.strictEqual(done, true, '🔴 the deletion completes when its inline redaction fails (the journal drains it)');
    assert.strictEqual(db.get(`user_profiles/${A}`), undefined, 'premise: the profile is removed'); assert.ok(logs.some((l) => /inline rating redaction/.test(l)), 'the failure is logged');
    assert.deepStrictEqual([node(db, 'XPZ-b').state, node(db, 'XPZ-b').comment, node(db, 'XPZ-b').owner_uid], ['live', 'malo', A], 'premise: the comment + uid are still live');
    await SE.pruneResidual(db, 4000 + SE.REDACT_GRACE_MS);
    assert.deepStrictEqual([node(db, 'XPZ-b').state, node(db, 'XPZ-b').comment, node(db, 'XPZ-b').owner_uid], ['deleted', null, null], '🔴 pruneResidual drains the journal: redacted');
    assert.strictEqual(db.get(`ratings_redact_pending/${A}`), undefined, 'then the entry is removed');
  }
  ok('Codex r2 repro B: the inline redaction fails after the profile is removed — the deletion completes (logged), and pruneResidual drains the durable journal (comment + uid redacted, the entry then removed)');

  // ── 15. the drain: idempotent; a failing uid keeps its entry; removed only when clean AND past the grace; an empty journal is a no-op ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-c'); await fulfil(db, 'XPZ-c'); await rate(db, A, { order_id: 'XPZ-c', store: 4 });
    db.set(`deleted_uids/${A}`, 1); db.set(`ratings_redact_pending/${A}`, { at: 5000 });
    let fail = true;
    const fdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'ratings_v2/XPZ-c') return r; return { ...r, transaction: async (fn) => { if (fail) { fail = false; throw new Error('x'); } return r.transaction(fn); } }; } };
    const q = console.error; console.error = () => {};
    let r; try { r = await SE.drainRatingRedactions(fdb, 5000 + SE.REDACT_GRACE_MS); } finally { console.error = q; }
    assert.deepStrictEqual([r.failed, r.cleared], [1, 0]); assert.ok(db.get(`ratings_redact_pending/${A}`), '🔴 a failing uid keeps its entry (retried next run)');
    r = await SE.drainRatingRedactions(fdb, 5000 + SE.REDACT_GRACE_MS);
    assert.deepStrictEqual([r.redacted >= 1, r.cleared], [true, 1]); assert.strictEqual(node(db, 'XPZ-c').state, 'deleted');
    r = await SE.drainRatingRedactions(fdb, 5000 + SE.REDACT_GRACE_MS + 1);
    assert.deepStrictEqual(r, { pending: 0, redacted: 0, cleared: 0, failed: 0 }, 'a re-run on an empty journal is a no-op');
  }
  ok('drain: a failing uid keeps its entry (retried next run); the next run redacts and clears it; a re-run on an empty journal is a no-op');

  // ── 15b. the race the "none left" check exists for: a rating lands AFTER the drain's redaction pass and BEFORE its check — even past the
  //     grace, the entry is KEPT (the next run redacts it) ──
  {
    const db = fakeDb(); db.set(`deleted_uids/${A}`, 1); db.set(`ratings_redact_pending/${A}`, { at: 6000 });
    let calls = 0;
    const rdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== 'ratings_v2') return r; return { ...r, orderByChild: (c) => { const q = r.orderByChild(c); return { ...q, equalTo: (v) => { const e = q.equalTo(v); return { ...e, once: async () => {
      calls += 1; if (calls === 2) db.set('ratings_v2/XPZ-late', { rating_format: 2, state: 'live', owner_uid: A, comment: 'late', restaurant_id: 'x_pizza', rev: 1 });
      return e.once(); } }; } }; } }; } };
    const r = await SE.drainRatingRedactions(rdb, 6000 + SE.REDACT_GRACE_MS);
    assert.strictEqual(r.cleared, 0); assert.ok(db.get(`ratings_redact_pending/${A}`), '🔴 a rating still live at the check ⇒ the entry is KEPT, even past the grace');
    await SE.drainRatingRedactions(db, 6000 + SE.REDACT_GRACE_MS);
    assert.deepStrictEqual([node(db, 'XPZ-late').state, db.get(`ratings_redact_pending/${A}`)], ['deleted', undefined], 'the next run redacts it and clears the entry');
  }
  ok('drain race: a rating landing between the redaction pass and the "none left" check keeps the entry (even past the grace); the next run redacts and clears');

  // ── 16b. Codex r3 P1-2 — its EXACT interleaving: the drain's empty check passes → a late commit lands → its fence TOUCHES the journal
  //     (v + 1) → its inline redaction FAILS → the drain's removal (judged on v before) is REFUSED; the next run redacts and clears ──
  {
    const db = fakeDb(); db.set(`deleted_uids/${A}`, 1); db.set(`ratings_redact_pending/${A}`, { at: 7000 });
    let late = false;
    const rdb = { ...db, ref: (p) => { const r = db.ref(p); if (p !== `ratings_redact_pending/${A}`) return r; return { ...r, transaction: async (fn) => {
      if (!late) {
        late = true;
        db.set('ratings_v2/XPZ-late2', { rating_format: 2, state: 'live', owner_uid: A, comment: 'tarde', restaurant_id: 'x_pizza', rev: 1 });   // the late commit
        await touchRedactJournal(db, A, 7000 + SE.REDACT_GRACE_MS + 5);                                                                       // its fence's touch
        // … and its inline redaction FAILS (nothing redacts XPZ-late2 here)
      }
      return r.transaction(fn); } }; } };
    const r = await SE.drainRatingRedactions(rdb, 7000 + SE.REDACT_GRACE_MS + 10);
    assert.ok(late, 'premise: the late commit + touch happened between the empty check and the removal');
    assert.strictEqual(r.cleared, 0, '🔴 the removal is REFUSED: the entry moved (v) since the drain judged it');
    assert.deepStrictEqual(db.get(`ratings_redact_pending/${A}`), { at: 7000, v: 1 }, 'the entry is kept, touched (v = 1), its at unchanged');
    assert.strictEqual(node(db, 'XPZ-late2').state, 'live', 'premise: the failed inline redaction left it live');
    const r2 = await SE.drainRatingRedactions(db, 7000 + SE.REDACT_GRACE_MS + 20);
    assert.deepStrictEqual([node(db, 'XPZ-late2').state, node(db, 'XPZ-late2').owner_uid, db.get(`ratings_redact_pending/${A}`), r2.cleared], ['deleted', null, undefined, 1], 'the next run redacts it and clears the (unchanged) entry');
  }
  ok('Codex r3 P1-2 exact interleaving: empty check → late commit → its fence touches (v+1) → its inline redaction fails ⇒ the drain\'s removal is REFUSED (v moved); the next run redacts and clears');

  // ── 17. Codex r3 P2: the drain runs FIRST and ISOLATED in pruneResidual — a failing link cleanup cannot starve it ──
  {
    const db = fakeDb(); await place(db, A, 'XPZ-i'); await fulfil(db, 'XPZ-i'); await rate(db, A, { order_id: 'XPZ-i', store: 3, comment: 'x' });
    db.set(`deleted_uids/${A}`, 1); db.set(`ratings_redact_pending/${A}`, { at: 8000 });
    const fdb = { ...db, ref: (p) => { const r = db.ref(p); if (!String(p).startsWith('auth_links')) return r; return { ...r, once: async () => { throw new Error('link cleanup failed'); } }; } };
    await assert.rejects(SE.pruneResidual(fdb, 8000 + SE.REDACT_GRACE_MS), /link cleanup failed/, 'premise: the link cleanup failed');
    assert.deepStrictEqual([node(db, 'XPZ-i').state, db.get(`ratings_redact_pending/${A}`)], ['deleted', undefined], '🔴 the drain still ran (FIRST, isolated): redacted and cleared');
  }
  ok('Codex r3 P2: pruneResidual runs the drain FIRST and isolated — a failing link cleanup still leaves the journal drained');

  FINISHED = true;
  console.log(`\nrating-v2: OK (${n})`);
})().catch((e) => { process.stderr.write(`rating-v2: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
