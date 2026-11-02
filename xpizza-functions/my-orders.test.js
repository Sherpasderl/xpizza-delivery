'use strict';
// NOTE-getMyOrders (approved 2026-11-01) — the capp «Pedidos» history read, getMyOrders. History entries come from the REAL writers
// (create-order-build.attachCustomerAttribution at intake, materialize.buildMaterializeUpdates at confirm, claim-order.claimOrderCore)
// and statuses from the REAL status-mirror decision; the handler runs over an in-memory RTDB whose ordered queries match production
// (orderByChild sorts by the child then the key; endBefore(value, key) is strict; limitToLast). Every read is logged, so "ONE
// bounded query, no fan-out" is asserted, not assumed. Run: node my-orders.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'my-orders-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const { makeMyOrders } = require('./my-orders');
const { attachCustomerAttribution } = require('./create-order-build');
const { buildMaterializeUpdates } = require('./materialize');
const { claimOrderCore } = require('./claim-order');
const { decideStatusMirror } = require('./status-mirror');
const { MENU_BY_RESTAURANT } = require('./menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-orders: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeDb() {
  const tree = {}; const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const snapOf = (v, ordered = null) => { const c = clone(v); return {
    exists: () => c != null, val: () => (c == null ? null : clone(c)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(c || {}))) { if (cb({ key: k, val: () => clone(x) }) === true) return true; } return false; },
  }; };
  // RTDB orderByChild ordering: null/absent < false < true < numbers < strings < objects, ties by key (lexicographic)
  const rank = (v) => (v == null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : 5);
  const cmp = (a, b) => (rank(a.v) - rank(b.v)) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const query = (p, child) => {
    const q = { end: null, last: null, ops: [] };
    const api = {
      endBefore: (v, k) => { q.end = { v: v === undefined ? null : v, k }; q.ops.push('endBefore'); return api; },
      limitToLast: (m) => { q.last = m; q.ops.push('limitToLast'); return api; },
      once: async () => {
        reads.push({ kind: 'query', path: p, child, end: q.end, last: q.last, ops: q.ops.slice() });
        let rows = Object.entries(get(p) || {}).map(([k, x]) => ({ k, x, v: x && typeof x === 'object' ? x[child] : undefined }));
        rows.sort((a, b) => cmp({ v: a.v, k: a.k }, { v: b.v, k: b.k }));
        if (q.end) rows = rows.filter((r) => cmp({ v: r.v, k: r.k }, { v: q.end.v, k: q.end.k }) < 0);
        if (q.last != null) rows = rows.slice(Math.max(0, rows.length - q.last));
        return snapOf(Object.fromEntries(rows.map((r) => [r.k, r.x])), rows.map((r) => [r.k, r.x]));
      },
    };
    return api;
  };
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    once: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    set: async (v) => set(p, v), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); },
    transaction: async (fn) => { const next = fn(clone(get(p)) ?? null); if (next === undefined) return { committed: false, snapshot: snapOf(get(p)) }; set(p, next); return { committed: true, snapshot: snapOf(get(p)) }; },
    orderByChild: (c) => query(p, c),
  });
  return { tree, reads, get, set, ref };
}

const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-staff': { uid: 'staff1' } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
// the D4-a context, in the shape the context source produces, whose legacyKeys are each brand's REAL menu keys (itemPricingKey:
// the dish NAME for x_pizza, the dish ID for la_musa) — so the per-brand key shape is exercised, never hand-guessed
const cidOf = (rid, k) => `${rid}-dish-${Object.keys(MENU_BY_RESTAURANT[rid]).indexOf(k)}`;
const usableCtx = (rid) => ({ availability: 'available', attached: true, usableAsIdentity: true,
  objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k) => ({ kind: 'dish', legacyKey: k, canonicalId: cidOf(rid, k) })) });
const withIds = (rid, items) => items.map((l) => ({ ...l, dish_id: cidOf(rid, l.key) }));
function harness(db, { limitedFor = () => false, contextFor = usableCtx } = {}) {
  const rl = []; const ctxCalls = [];
  const { getMyOrders } = makeMyOrders({ getDatabase: () => db, getAuth: () => auth,
    checkRateLimit: async (_db, bucket, key) => { rl.push({ bucket, key }); return limitedFor(key) ? { allowed: false, retryAfterSec: 7 } : { allowed: true, retryAfterSec: 0 }; },
    resolveContext: async (rid) => { ctxCalls.push(rid); return contextFor(rid); } });
  const call = async ({ method = 'GET', token, query = { context: 'platform' }, body, rawBody } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query, body, rawBody, headers, ip: '9.9.9.9', get: (h) => headers[String(h).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await getMyOrders(req, res); return res;
  };
  return { call, rl, ctxCalls };
}
// the REAL writers
const intake = async (db, uid, id, { now, items = [{ name: 'Margherita', qty: 1 }], status = 'new', rid = 'x_pizza', total = 250 } = {}) => {
  const u = { [`orders/${id}`]: { status, restaurant_id: rid } };
  attachCustomerAttribution(u, id, uid, { now, total, orderType: 'delivery', items_text: `${items.length}x Pizza`, restaurantId: rid, items });
  await db.ref().update(u);
};
const confirm = async (db, uid, id, { now }) => {
  const order = { customer_uid: uid, total: 410, order_type: 'pickup', items_text: '1x Hawaiana', restaurant_id: 'x_pizza', payment_method: 'online',
    reorder_items: [{ key: 'Margherita', qty: 2 }], status: 'pending_payment' };
  const u = buildMaterializeUpdates({ orderId: id, order, trackingToken: 'trk' + id.slice(-6), now, restaurant: 'x_pizza', paymentMethod: 'online' });
  await db.ref().update(Object.fromEntries(Object.entries(u).filter(([k]) => k.startsWith('user_orders/'))));
};
const mirror = async (db, uid, id, status) => { const d = decideStatusMirror(id, uid, db.get(`user_orders/${uid}/${id}`) != null, status); if (d) await db.ref(d.path).set(d.value); };

(async () => {
  // ── 1. member-only: token in the x-firebase-id-token HEADER; non-customer / bad / missing ⇒ 401; a tombstone ⇒ 403 ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-1', { now: 1000 });
    for (const [why, o] of [['no token', {}], ['a bad token', { token: 'nope' }], ['a non-customer (staff) token', { token: 'tok-staff' }],
      ['the token in the QUERY, not the header', { query: { context: 'platform', token: `tok-${A}` } }]]) {
      const r = await call(o); assert.ok(r.code === 401 || r.code === 400, `🔴 ${why} ⇒ ${r.code}`); assert.ok(!r.body.active, `${why}: no data`);
    }
    assert.strictEqual((await call({})).code, 401, 'no token ⇒ 401');
    assert.strictEqual((await call({ token: 'tok-staff' })).code, 401, '🔴 a non-customer token ⇒ 401');
    for (const tomb of [`deleted_uids/${A}`, `user_private/${A}/deleted_at`]) {
      const d2 = fakeDb(); await intake(d2, A, 'XPZ-1', { now: 1000 }); d2.set(tomb, 5);
      const r = await harness(d2).call({ token: `tok-${A}` });
      assert.strictEqual(r.code, 403, `🔴 ${tomb} ⇒ 403`); assert.deepStrictEqual(r.body, { ok: false, reason: 'deleted' });
    }
    const r = await call({ token: `tok-${A}` }); assert.strictEqual(r.code, 200); assert.strictEqual(r.h['Cache-Control'], 'no-store');
  }
  ok('member-only: the ID token is read from the x-firebase-id-token header; missing / bad / non-customer ⇒ 401; either tombstone ⇒ 403 deleted; no-store');

  // ── 2. strict request: exactly ?context=platform[&limit][&cursor], GET, no body ──
  {
    const db = fakeDb(); const { call } = harness(db); const t = `tok-${A}`;
    const bad = [{ query: {} }, { query: { context: 'x_pizza' } }, { query: { context: 'platform', uid: B } }, { query: { context: 'platform', phone: '1' } },
      { body: { uid: B } }, { query: { context: 'platform', limit: '0' } }, { query: { context: 'platform', limit: '51' } }, { query: { context: 'platform', limit: '2.5' } },
      { query: { context: 'platform', limit: 'abc' } }, { query: { context: 'platform', limit: ['5', '6'] } }, { query: { context: 'platform', cursor: '!!' } },
      { query: { context: 'platform', cursor: Buffer.from('[1,"../x"]').toString('base64url') } }, { query: { context: 'platform', cursor: Buffer.from('{"ts":1}').toString('base64url') } },
      { query: { context: 'platform', cursor: Buffer.from('["1","XPZ-1"]').toString('base64url') } }];
    for (const o of bad) { const r = await call({ token: t, ...o }); assert.strictEqual(r.code, 400, `🔴 ${JSON.stringify(o)} ⇒ ${r.code}`); assert.deepStrictEqual(r.body, { ok: false, reason: 'bad_request' }); }
    assert.strictEqual((await call({ token: t, method: 'POST' })).code, 405);
    // Codex r1 P2: ANY non-empty raw body is refused — `{}` / `[]` included (they parse to an empty object / array)
    for (const [why, o] of [['{}', { body: {}, rawBody: Buffer.from('{}') }], ['[]', { body: [], rawBody: Buffer.from('[]') }], ['a parsed [] alone', { body: [] }],
      ['whitespace', { body: {}, rawBody: Buffer.from(' ') }], ['a string body', { body: 'x' }]]) {
      const r = await call({ token: t, ...o }); assert.strictEqual(r.code, 400, `🔴 a ${why} body ⇒ ${r.code}`);
    }
    assert.strictEqual(db.reads.filter((x) => x.kind === 'query').length, 0, 'a refused request never queries');
    for (const o of [{}, { body: {} }, { body: {}, rawBody: Buffer.alloc(0) }, { body: undefined }]) assert.strictEqual((await call({ token: t, ...o })).code, 200, `a body-less GET passes (${JSON.stringify(o)})`);
  }
  ok('strict request: GET only; exactly context=platform plus optional limit (integer 1..50) and a well-formed cursor; any other key, a body or a malformed value ⇒ 400 with ZERO queries');

  // ── 3. the REAL writers + the status mirror ⇒ the active / past split, newest first, the exact projection ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-new', { now: 1100 });                                  // cash intake: status new ⇒ active
    await confirm(db, A, 'XPZ-onl', { now: 1200 }); await mirror(db, A, 'XPZ-onl', 'preparing');   // online at confirm ⇒ preparing ⇒ active
    await intake(db, A, 'XPZ-sch', { now: 1300, status: 'scheduled' });           // scheduled ⇒ active
    await intake(db, A, 'XPZ-del', { now: 1050 }); await mirror(db, A, 'XPZ-del', 'delivered');   // delivered ⇒ past
    await intake(db, A, 'XPZ-can', { now: 1010 }); await mirror(db, A, 'XPZ-can', 'cancelled');   // cancelled ⇒ past
    await intake(db, A, 'XPZ-cmp', { now: 1001 }); await mirror(db, A, 'XPZ-cmp', 'completed');   // completed ⇒ past
    // claim-order: a guest order bound to A by the phone match (non-terminal ⇒ no credit) writes its entry
    const OTP = require('./otp-lib');
    db.set(`user_profiles/${A}`, { phone: '50499990000', phone_hash: OTP.phoneHash('50499990000') });
    db.set('orders/XPZ-clm', { customer_phone: '50499990000', status: 'out_for_delivery', total: 99, order_type: 'delivery', items_text: '1x Agua', restaurant_id: 'la_musa', reorder_items: [], created_at: 1 });
    const cl = await claimOrderCore(db, { uid: A, orderId: 'XPZ-clm', now: 1250 });
    assert.ok(cl && cl.status !== 403, `premise: the claim binds (${JSON.stringify(cl)})`);
    assert.ok(db.get(`user_orders/${A}/XPZ-clm`), 'premise: claim-order wrote the entry');
    const r = await call({ token: `tok-${A}` });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.active.map((x) => x.order_id), ['XPZ-sch', 'XPZ-clm', 'XPZ-onl', 'XPZ-new'], '🔴 active = non-terminal, newest first');
    assert.deepStrictEqual(r.body.past.map((x) => x.order_id), ['XPZ-del', 'XPZ-can', 'XPZ-cmp'], '🔴 past = delivered / cancelled / completed, newest first');
    assert.strictEqual(r.body.next_cursor, null);
    const KEYS = ['items', 'items_text', 'order_id', 'order_type', 'restaurant', 'status', 'total', 'ts'];
    for (const row of [...r.body.active, ...r.body.past]) {
      const e = db.get(`user_orders/${A}/${row.order_id}`);
      assert.deepStrictEqual(Object.keys(row).sort(), KEYS, `🔴 ${row.order_id}: the projection is exactly the whitelist`);
      assert.deepStrictEqual(row, { order_id: row.order_id, ts: e.ts, total: e.total, order_type: e.order_type, restaurant: e.restaurant, status: e.status, items_text: e.items_text, items: withIds(e.restaurant, e.items || []) }, `${row.order_id}: the stored values (+ each line's dish_id)`);
    }
    assert.deepStrictEqual(r.body.active.find((x) => x.order_id === 'XPZ-onl').items, [{ key: 'Margherita', qty: 2, dish_id: cidOf('x_pizza', 'Margherita') }], 'the confirm-time recipe');
    assert.strictEqual(r.body.active.find((x) => x.order_id === 'XPZ-clm').restaurant, 'la_musa', 'each row names its store (multi-restaurant)');
  }
  ok('real writers (intake / confirm / claim + the status mirror): active = new / preparing / scheduled / out_for_delivery, past = delivered / cancelled / completed, newest first; each row is EXACTLY the whitelist with the stored values');

  // ── 4. isolation: the uid comes ONLY from the token; another account's history is unreachable ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-a', { now: 10 }); await intake(db, B, 'XPZ-b', { now: 20 });
    const r = await call({ token: `tok-${A}` });
    assert.deepStrictEqual([...r.body.active, ...r.body.past].map((x) => x.order_id), ['XPZ-a'], '🔴 only the caller\'s own entries');
    assert.deepStrictEqual(db.reads.filter((x) => x.kind === 'query').map((x) => x.path), [`user_orders/${A}`]);
  }
  ok('isolation: the caller\'s own node only (the uid comes from the verified token, never a parameter)');

  // ── 5. paging: 45 entries (ties on ts), limit 20 ⇒ 20 + 20 + 5, no duplicate, no gap, the RTDB order; a stable cursor ──
  {
    const db = fakeDb(); const { call } = harness(db);
    const ids = [];
    for (let i = 0; i < 45; i += 1) { const id = `XPZ-p${String(i).padStart(2, '0')}`; ids.push(id); await intake(db, A, id, { now: 5000 + Math.floor(i / 3) }); await mirror(db, A, id, 'delivered'); }
    const expected = ids.slice().sort((a, b) => (db.get(`user_orders/${A}/${b}`).ts - db.get(`user_orders/${A}/${a}`).ts) || (a < b ? 1 : -1));
    const got = []; let cursor; let pages = 0;
    do {
      const r = await call({ token: `tok-${A}`, query: { context: 'platform', limit: '20', ...(cursor ? { cursor } : {}) } });
      assert.strictEqual(r.code, 200, JSON.stringify(r.body));
      got.push(...r.body.past.map((x) => x.order_id)); cursor = r.body.next_cursor; pages += 1;
      assert.ok(pages <= 3, 'bounded');
    } while (cursor);
    assert.strictEqual(pages, 3); assert.deepStrictEqual(got, expected, '🔴 every entry exactly once, newest first (ts desc, key desc on ties)');
    const first = await call({ token: `tok-${A}` });
    assert.strictEqual(first.body.past.length, 20, 'default limit 20');
    const fifty = await call({ token: `tok-${A}`, query: { context: 'platform', limit: '50' } });
    assert.strictEqual(fifty.body.past.length, 45); assert.strictEqual(fifty.body.next_cursor, null, 'no cursor past the end');
  }
  ok('paging: 45 entries with tied timestamps ⇒ 20 + 20 + 5 via the opaque cursor, every entry exactly once in RTDB order; default 20, max 50; null cursor at the end');

  // ── 6. ONE bounded query, no fan-out: the only reads are the tombstone checks and ONE user_orders query (limit + 1) ──
  {
    const db = fakeDb(); const { call } = harness(db);
    for (let i = 0; i < 30; i += 1) await intake(db, A, `XPZ-q${i}`, { now: 100 + i });
    db.reads.length = 0;
    await call({ token: `tok-${A}`, query: { context: 'platform', limit: '10' } });
    const qs = db.reads.filter((x) => x.kind === 'query');
    assert.strictEqual(qs.length, 1, '🔴 exactly one query');
    assert.deepStrictEqual({ path: qs[0].path, child: qs[0].child, last: qs[0].last }, { path: `user_orders/${A}`, child: 'ts', last: 11 }, '🔴 orderByChild(ts).limitToLast(limit + 1)');
    const gets = db.reads.filter((x) => x.kind === 'get').map((x) => x.path).sort();
    const rows = Array.from({ length: 10 }, (_, i) => `orders/XPZ-q${29 - i}/display_number`);
    assert.deepStrictEqual(gets, [`deleted_uids/${A}`, `user_private/${A}/deleted_at`, ...rows].sort(), '🔴 no other read: the tombstone checks + ONE display_number point read per RETURNED row (never the probe row, never a whole order)');
  }
  ok('bounded reads: ONE orderByChild(ts).limitToLast(limit + 1) query on the caller\'s node; then only the two tombstone checks and one display_number point read per returned row (≤ limit)');

  // ── 7. the projection is a WHITELIST (an internal field never leaves); S-D forward-compat: additive recipe fields pass through ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-w', { now: 1 });
    db.set(`user_orders/${A}/XPZ-w/customer_phone`, '50499990000'); db.set(`user_orders/${A}/XPZ-w/internal_note`, 'x');
    db.set(`user_orders/${A}/XPZ-w/recipe_format`, 2); db.set(`user_orders/${A}/XPZ-w/items/0/unit_cents`, 15000); db.set(`user_orders/${A}/XPZ-w/items/0/priced`, true);
    const row = (await call({ token: `tok-${A}` })).body.active[0];
    assert.ok(!('customer_phone' in row) && !('internal_note' in row), '🔴 an internal field leaked');
    assert.strictEqual(row.recipe_format, 2, 'recipe_format passes through when present');
    assert.deepStrictEqual(row.items[0], { key: 'Margherita', qty: 1, unit_cents: 15000, priced: true, dish_id: cidOf('x_pizza', 'Margherita') }, 'S-D: an additive per-line field reaches the capp unchanged');
    db.set(`user_orders/${A}/XPZ-w/items`, 'not-an-array'); db.set(`user_orders/${A}/XPZ-w/items_text`, 7);
    const r2 = (await call({ token: `tok-${A}` })).body.active[0];
    assert.deepStrictEqual(r2.items, []); assert.strictEqual(r2.items_text, null, 'malformed fields normalize, never pass through');
  }
  ok('the projection is a whitelist (customer_phone / any internal field never leaves); S-D forward-compat: recipe_format and additive per-line recipe fields pass through as stored; malformed items / items_text normalize');

  // ── 8. DOCUMENTED current behaviour (advisor 2026-11-01, backlog): status-mirror is fail-open, so a stale non-terminal status stays
  //    ACTIVE — the server returns the stored truth, no time cutoff; a reconciler fixes it at the source later ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-stale', { now: 1 }); await mirror(db, A, 'XPZ-stale', 'out_for_delivery');
    db.set(`user_orders/${A}/XPZ-null`, { ts: 2, total: 1, order_type: 'delivery', restaurant: 'x_pizza', status: null, items: [] });
    const r = await call({ token: `tok-${A}` });
    assert.deepStrictEqual(r.body.active.map((x) => x.order_id), ['XPZ-stale'], 'a stale non-terminal status is reported ACTIVE (no time cutoff at launch)');
    assert.deepStrictEqual(r.body.past.map((x) => x.order_id), ['XPZ-null'], 'a null / unknown status is past');
  }
  ok('documented: a stale non-terminal status (status-mirror fail-open) stays ACTIVE — the stored truth, no time cutoff (backlog: a source reconciler); a null status is past');

  // ── 9. rate limit: per VERIFIED uid (unspoofable), its own bucket ⇒ 429 with Retry-After, before any history read ──
  {
    const db = fakeDb(); const { call, rl } = harness(db, { limitedFor: (k) => k === A });
    await intake(db, A, 'XPZ-r', { now: 1 }); db.reads.length = 0;
    const r = await call({ token: `tok-${A}` });
    assert.strictEqual(r.code, 429); assert.strictEqual(r.h['Retry-After'], '7'); assert.deepStrictEqual(r.body, { ok: false, reason: 'rate_limited' });
    assert.deepStrictEqual(rl.at(-1), { bucket: 'my_orders', key: A }, '🔴 the limiter keys on the verified uid, its own bucket');
    assert.strictEqual(db.reads.filter((x) => x.kind === 'query').length, 0, 'no history read when limited');
    assert.strictEqual((await harness(fakeDb(), { limitedFor: () => true }).call({})).code, 401, 'auth first: an unauthenticated call is 401, never charged to a bucket');
  }
  ok('rate limit: per verified uid in its own my_orders bucket ⇒ 429 + Retry-After with no history read; unauthenticated calls are 401 first');

  // ── 10. approved delta (1): each line's CANONICAL dish id, from the server's one resolver, for BOTH brands (name-keyed / id-keyed) ──
  {
    const db = fakeDb(); const { call, ctxCalls } = harness(db);
    const xKey = Object.keys(MENU_BY_RESTAURANT.x_pizza)[1], lKey = Object.keys(MENU_BY_RESTAURANT.la_musa)[1];
    await intake(db, A, 'XPZ-x', { now: 20, rid: 'x_pizza', items: [{ name: xKey, qty: 2 }] });
    await intake(db, A, 'LMS-l', { now: 30, rid: 'la_musa', items: [{ id: lKey, name: 'anything', qty: 1 }] });
    await intake(db, A, 'XPZ-y', { now: 10, rid: 'x_pizza', items: [{ name: 'Margherita', qty: 1 }] });
    const r = (await call({ token: `tok-${A}` })).body;
    const by = Object.fromEntries(r.active.map((x) => [x.order_id, x]));
    assert.deepStrictEqual(by['XPZ-x'].items, [{ key: xKey, qty: 2, dish_id: cidOf('x_pizza', xKey) }], '🔴 x_pizza (name-keyed): the canonical id, the stored key kept');
    assert.deepStrictEqual(by['LMS-l'].items, [{ key: lKey, qty: 1, dish_id: cidOf('la_musa', lKey) }], '🔴 la_musa (id-keyed): the canonical id, the stored key kept');
    assert.deepStrictEqual(ctxCalls.slice().sort(), ['la_musa', 'x_pizza'], 'ONE context resolution per DISTINCT restaurant on the page');
    // a key the context does not map ⇒ null; an unusable context / a throwing resolver ⇒ every line null (never guessed, never the key)
    db.set(`user_orders/${A}/XPZ-y/items/0/key`, 'Gone From The Menu');
    const r2 = (await harness(db).call({ token: `tok-${A}` })).body.active.find((x) => x.order_id === 'XPZ-y');
    assert.strictEqual(r2.items[0].dish_id, null, '🔴 an unmapped key ⇒ dish_id null');
    for (const contextFor of [(rid) => ({ ...usableCtx(rid), usableAsIdentity: false }), () => { throw new Error('ctx'); }, () => undefined]) {
      const r3 = (await harness(db, { contextFor }).call({ token: `tok-${A}` })).body;
      assert.ok([...r3.active, ...r3.past].every((x) => x.items.every((l) => l.dish_id === null)), '🔴 an unusable / failing context ⇒ dish_id null on every line');
    }
  }
  ok('canonical dish ids (approved delta): x_pizza name-keys and la_musa id-keys both resolve through the ONE identity map to the store\'s canonical id, the stored key kept; unmapped key / unusable / throwing context ⇒ null; one resolution per restaurant');

  // ── 11. approved delta (2): display_number from orders/{id}, only when stamped (a finite number) — never the long id ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await intake(db, A, 'XPZ-d1', { now: 3 }); await intake(db, A, 'XPZ-d2', { now: 2 }); await intake(db, A, 'XPZ-d3', { now: 1 });
    db.set('orders/XPZ-d1/display_number', 47); db.set('orders/XPZ-d3/display_number', '48');
    const rows = Object.fromEntries((await call({ token: `tok-${A}` })).body.active.map((x) => [x.order_id, x]));
    assert.strictEqual(rows['XPZ-d1'].display_number, 47, 'a stamped number');
    assert.ok(!('display_number' in rows['XPZ-d2']), '🔴 unstamped ⇒ absent (never the long id)');
    assert.ok(!('display_number' in rows['XPZ-d3']), 'a non-number stamp ⇒ absent');
  }
  ok('display_number (approved delta): present only when orders/{id}/display_number is a finite number; absent when unstamped or malformed — never the long id');

  // ══ RECEIPT detail mode (NOTE-getMyOrders-receipt, approved 2026-11-01): ?context=platform&order_id=X ══
  // Orders come from the REAL intake chain: storedCtx (a minted server envío ctx) → DW.withDelivery (the breakdown with envío + tip)
  // → pricedLineItems (x_pizza's factura-priced lines) → buildCreateOrderUpdates → attachCustomerAttribution — exactly createOrder's
  // order. The online-card case uses the same builder with payment_method 'online' (chargeOnlineOrder's pending record shares these
  // field names; its builder is inline in index.js) + the REAL confirm patch (buildMaterializeUpdates).
  const P = require('./delivery/delivery-pricing'); const DW = require('./delivery/delivery-wire');
  const { pricedLineItems } = require('./factura/pricing'); const { EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
  const { buildCreateOrderUpdates } = require('./create-order-build');
  const place = async (db, uid, id, { rid = 'x_pizza', type = 'delivery', pay = 'cash', tip = 0, now = 100, items } = {}) => {
    const ctx = type === 'delivery' ? P.storedCtx({ delivery_snapshot: { mode: 'delivery', policy_version: 1, km: 3.2, band: 1, promo: null }, delivery_cents: 4000, promo_discount_cents: 500, ...(tip ? { tip_cents: tip } : {}) }) : null;
    const bd = DW.withDelivery({ ctx }, { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 });
    const body = items || (rid === 'x_pizza' ? [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }] : [{ id: Object.keys(MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }]);
    const fp = rid === 'x_pizza' ? pricedLineItems(body, MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza) : { items: null, error: null };
    const u = buildCreateOrderUpdates({ orderId: id, orderType: type, now, trackingToken: 'tk' + id.slice(-4), total: bd.total_cents / 100, lat: type === 'delivery' ? 14.07 : null, lng: type === 'delivery' ? -87.19 : null,
      fields: { customer_name: 'Ana', customer_phone: '50499990000', items_text: '2x Margherita', notes: 'sin cebolla', payment_method: pay, ...(type === 'delivery' ? { address_detected: 'Col. Palmira', address_details: 'casa azul', address_area: 'Palmira' } : {}) },
      hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' }, restaurantId: rid, priceBreakdown: bd, facturaPriced: fp, cashTenderedCents: pay === 'cash' ? 50000 : null });
    attachCustomerAttribution(u, id, uid, { now, total: bd.total_cents / 100, orderType: type, items_text: '2x Margherita', restaurantId: rid, items: body });
    await db.ref().update(u);
    if (pay === 'online') await db.ref().update(buildMaterializeUpdates({ orderId: id, order: { ...db.get(`orders/${id}`), customer_uid: uid }, trackingToken: 'tk' + id.slice(-4), now: now + 1, restaurant: rid, paymentMethod: 'online' }));
    return u;
  };
  const rcpt = (call, token, id, extra = {}) => call({ token, query: { context: 'platform', order_id: id, ...extra } });

  // ── R1. x_pizza delivery, cash, tip + envío: priced lines, the full breakdown, the cash tender, the OWN address (never coordinates) ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await place(db, A, 'XPZ-r1', { tip: 2000 }); db.set('orders/XPZ-r1/display_number', 47);
    const r = await rcpt(call, `tok-${A}`, 'XPZ-r1');
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const o = db.get('orders/XPZ-r1');
    assert.deepStrictEqual(r.body.receipt, {
      order_id: 'XPZ-r1', display_number: 47, ts: 100, restaurant: 'x_pizza', order_type: 'delivery', status: 'new',
      lines: o.items.map((l) => ({ qty: l.qty, description: l.description, line_cents: l.line_gross_cents })), items_text: '2x Margherita',
      totals: { subtotal_cents: 26087, tax_cents: 3913, delivery_cents: 4000, promo_discount_cents: 500, tip_cents: 2000, total_cents: o.total_cents },
      tender: { method: 'cash', cash_tendered_cents: 50000 },
      address: { detected: 'Col. Palmira', details: 'casa azul', area: 'Palmira' },
    }, '🔴 the x_pizza delivery cash receipt');
    assert.strictEqual(o.total_cents, 30000 + 4000 - 500 + 2000, 'premise: the REAL breakdown (food + net envío + tip)');
  }
  ok('receipt R1: x_pizza delivery cash with tip + envío ⇒ factura-priced lines, the full breakdown (present keys), the cash tender, the own address — never coordinates');

  // ── R2. la_musa pickup, card on delivery: NO priced lines (lines null ⇒ the capp shows items_text), food totals only, «Tarjeta», no address ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await place(db, A, 'LMS-r2', { rid: 'la_musa', type: 'pickup', pay: 'card_delivery' });
    const rc = (await rcpt(call, `tok-${A}`, 'LMS-r2')).body.receipt;
    assert.strictEqual(rc.lines, null, '🔴 no platform factura ⇒ lines null (brand-agnostic BY DATA)');
    assert.strictEqual(rc.items_text, '2x Margherita');
    assert.deepStrictEqual(rc.totals, { subtotal_cents: 26087, tax_cents: 3913, total_cents: 30000 }, 'absent envío / tip are omitted, never 0-filled');
    assert.deepStrictEqual(rc.tender, { method: 'card' }, '🔴 card ⇒ «Tarjeta» only, no digits, no reference');
    assert.ok(!('address' in rc), 'pickup ⇒ no address'); assert.ok(!('display_number' in rc), 'unstamped ⇒ absent');
  }
  ok('receipt R2: la_musa pickup card-on-delivery ⇒ lines null + items_text, food totals only (absent keys omitted), tender card with no digits, no address');

  // ── R3. online card (confirm patch): tender card; the receipt reads the CONFIRMED order ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await place(db, A, 'XPZ-r3', { type: 'pickup', pay: 'online' });
    const rc = (await rcpt(call, `tok-${A}`, 'XPZ-r3')).body.receipt;
    assert.deepStrictEqual(rc.tender, { method: 'card' }); assert.strictEqual(rc.lines.length, 1);
  }
  ok('receipt R3: an online card order (the real confirm patch) ⇒ tender card, priced lines');

  // ── R4. ownership: another account's id, a missing history entry, a missing order, a mismatched customer_uid ⇒ ONE uniform 404 ──
  {
    const db = fakeDb(); const { call } = harness(db);
    await place(db, B, 'XPZ-b');                                                    // B's order
    await place(db, A, 'XPZ-noentry'); db.set(`user_orders/${A}/XPZ-noentry`, null);   // A's order, no history entry
    await place(db, A, 'XPZ-noorder'); db.set('orders/XPZ-noorder', null);             // the entry, no order
    await place(db, A, 'XPZ-mism'); db.set('orders/XPZ-mism/customer_uid', B);         // the entry, but the order names B
    const bodies = [];
    for (const id of ['XPZ-b', 'XPZ-noentry', 'XPZ-noorder', 'XPZ-mism', 'XPZ-never']) {
      const r = await rcpt(call, `tok-${A}`, id); assert.strictEqual(r.code, 404, `🔴 ${id} ⇒ ${r.code}`); bodies.push(JSON.stringify(r.body));
    }
    assert.strictEqual(new Set(bodies).size, 1, '🔴 one uniform 404 body (no existence oracle)'); assert.deepStrictEqual(JSON.parse(bodies[0]), { ok: false, reason: 'not_found' });
    assert.strictEqual((await rcpt(call, `tok-${B}`, 'XPZ-b')).code, 200, 'the owner reads it');
  }
  ok('receipt R4: another account\'s order, a missing history entry, a missing order, a customer_uid mismatch and an unknown id ⇒ ONE uniform 404; the owner gets 200');

  // ── R5. strict: order_id validated; order_id excludes limit / cursor; the auth gates apply ──
  {
    const db = fakeDb(); const { call } = harness(db); await place(db, A, 'XPZ-s');
    for (const extra of [{ order_id: '../x' }, { order_id: '' }, { order_id: 'a'.repeat(65) }, { order_id: 'XPZ-s', limit: '5' }, { order_id: 'XPZ-s', cursor: Buffer.from('[1,"XPZ-s"]').toString('base64url') }]) {
      const r = await call({ token: `tok-${A}`, query: { context: 'platform', ...extra } }); assert.strictEqual(r.code, 400, `🔴 ${JSON.stringify(extra)} ⇒ ${r.code}`);
    }
    assert.strictEqual((await call({ query: { context: 'platform', order_id: 'XPZ-s' } })).code, 401);
    db.set(`deleted_uids/${A}`, 1); assert.strictEqual((await rcpt(call, `tok-${A}`, 'XPZ-s')).code, 403);
  }
  ok('receipt R5: a malformed order_id, or order_id with limit / cursor ⇒ 400; no token ⇒ 401; a tombstone ⇒ 403');

  // ── R6. exactly TWO point reads (the entry + the order) beyond the tombstone checks; no query ──
  {
    const db = fakeDb(); const { call } = harness(db); await place(db, A, 'XPZ-c'); db.reads.length = 0;
    await rcpt(call, `tok-${A}`, 'XPZ-c');
    assert.strictEqual(db.reads.filter((x) => x.kind === 'query').length, 0, 'no query');
    assert.deepStrictEqual(db.reads.filter((x) => x.kind === 'get').map((x) => x.path).sort(), [`deleted_uids/${A}`, `orders/XPZ-c`, `user_orders/${A}/XPZ-c`, `user_private/${A}/deleted_at`].sort(), '🔴 exactly the entry + the order');
  }
  ok('receipt R6: exactly two point reads (user_orders/{uid}/{id} + orders/{id}) beyond the tombstone checks — no query, no fan-out');

  // ── R7. the whitelist: no PII / token / payment reference / coordinate ever leaves; malformed lines ⇒ null ──
  {
    const db = fakeDb(); const { call } = harness(db); await place(db, A, 'XPZ-w2');
    db.set('orders/XPZ-w2/payment_reference', 'PX-123'); db.set('orders/XPZ-w2/card_last4', '4242'); db.set('orders/XPZ-w2/guest_verified', { phone: '1' });
    const rc = (await rcpt(call, `tok-${A}`, 'XPZ-w2')).body.receipt;
    const flat = JSON.stringify(rc);
    for (const leak of ['50499990000', 'Ana', 'tk', 'PX-123', '4242', '14.07', '-87.19', 'sin cebolla', 'factura', 'hub_', 'guest_verified', 'customer_uid', 'maps_link'])
      assert.ok(!flat.includes(leak), `🔴 the receipt leaked ${leak}`);
    assert.deepStrictEqual(Object.keys(rc).sort(), ['address', 'items_text', 'lines', 'order_id', 'order_type', 'restaurant', 'status', 'tender', 'totals', 'ts']);
    db.set('orders/XPZ-w2/items', [{ qty: 'two', description: 5 }]);
    assert.strictEqual((await rcpt(call, `tok-${A}`, 'XPZ-w2')).body.receipt.lines, null, 'malformed priced lines ⇒ null (never passed through)');
  }
  ok('receipt R7: a whitelist — no phone, name, tracking token, payment reference, card digits, coordinates, notes, factura or hub field; malformed lines ⇒ null');

  FINISHED = true;
  console.log(`\nmy-orders: OK (${n})`);
})().catch((e) => { process.stderr.write(`my-orders: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
