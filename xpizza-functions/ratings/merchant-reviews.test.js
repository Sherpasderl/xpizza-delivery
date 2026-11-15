'use strict';
// Calificaciones v2 S3 — getMerchantReviews, the portal's NAMED reviews list (PLAN-3a-merchant-reviews-v2 r1 §1–§3, r2 + rulings,
// r3 §5–§7, r4.2 §1–§2 + §7, r5 §1, r6.1 §3). Every input through the REAL writers: orders by the real intake builders + the real
// dish snapshot (dish-qty), the delivered status mirrored into the history by the real status-mirror core, the real fulfilment stamp,
// ratings by the real rateOrderCore, disclosure enabled by the real config writer, the structured name by the real setMyName,
// deletion by the real deletion updater + tombstone; authorization by the real resolveAccess + can. The in-memory RTDB runs the
// Admin SDK's transaction semantics and logs every read, so the read budget is asserted, not assumed.
// Run: node ratings/merchant-reviews.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'merchant-reviews-test-salt-'.padEnd(40, 'x');
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const FN = path.join(__dirname, '..');
const V2 = require('./rating-v2');
const RC = require('./ratings-config');
const MR = require('./merchant-reviews');
const { rateOrderCore } = require('./rate-order');
const { stampRatingFulfilment } = require('./rating-fulfilment');
const { dishQtyOf } = require('./dish-qty');
const S = require('../signup-core');
const { decideStatusMirror } = require('../status-mirror');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require(path.join(FN, 'create-order-build'));
const { MENU_BY_RESTAURANT } = require(path.join(FN, 'menu-pricing'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 merchant-reviews: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeDb(seed = {}) {
  const tree = clone(seed); const reads = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Array.isArray(p) && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, ordered) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    once: async () => { reads.push({ kind: 'get', path: p }); return snap(get(p)); },
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
    // orderByKey: startAt / startAfter / endAt / limitToFirst (RTDB key order = string order for these keys)
    orderByKey: () => { const q = {}; const api = {
      startAt: (k) => { q.from = k; q.incl = true; return api; }, startAfter: (k) => { q.from = k; q.incl = false; return api; },
      endAt: (k) => { q.to = k; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      once: async () => {
        let rows = Object.entries(get(p) || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (q.from !== undefined) rows = rows.filter(([k]) => (q.incl ? k >= q.from : k > q.from));
        if (q.to !== undefined) rows = rows.filter(([k]) => k <= q.to);
        if (q.first !== undefined) rows = rows.slice(0, q.first);
        reads.push({ kind: 'query', path: p, n: rows.length, first: q.first });
        return snap(rows.length ? Object.fromEntries(rows) : null, rows);
      } }; return api; },
    // orderByChild: equalTo (the owner_uid index) | endBefore + limitToLast (the history query)
    orderByChild: (c) => { const q = {}; const api = {
      equalTo: (v) => { q.eq = v; return api; }, endBefore: (v) => { q.before = v; return api; }, limitToLast: (m) => { q.last = m; return api; },
      once: async () => {
        let rows = Object.entries(get(p) || {}).filter(([, r]) => r && typeof r === 'object');
        if (q.eq !== undefined) rows = rows.filter(([, r]) => r[c] === q.eq);
        if (q.before !== undefined) rows = rows.filter(([, r]) => r[c] != null && r[c] < q.before);
        rows.sort(([ka, a], [kb, b]) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : ka < kb ? -1 : 1));
        if (q.last !== undefined) rows = rows.slice(-q.last);
        reads.push({ kind: 'childQuery', path: p, n: rows.length, last: q.last });
        return snap(rows.length ? Object.fromEntries(rows) : null);
      } }; return api; },
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

// two brands: x_pizza (branches x_pizza + xp_sur, the x_pizza menu) and la_musa
const g = { granted_at: 1, granted_by: 'x' };
const SEED = {
  brands: { x_pizza: { name: 'X', active: true, locations: { x_pizza: 'member', xp_sur: 'member' }, activation: { state: 'on', since: 1 } },   // two branches ⇒ 'on' (legacy = one location)
    la_musa: { name: 'M', active: true, locations: { la_musa: 'member' }, activation: { state: 'legacy', since: 1 } } },
  restaurants: { x_pizza: { identity: { brand_id: 'x_pizza' } }, xp_sur: { identity: { brand_id: 'x_pizza' } }, la_musa: { identity: { brand_id: 'la_musa' } } },
  brand_members: { x_pizza: { owners: { ownerX: g }, managers: { x_pizza: { mgrX: g } } }, la_musa: { owners: { ownerM: g } } },
};
const UIDS = Array.from({ length: 12 }, (_, i) => `u_${String.fromCharCode(97 + i).repeat(24)}`);
const [A, B, C2] = UIDS;
const CUST = Object.fromEntries(UIDS.map((u) => [`tok-${u}`, { uid: u, customer: true }]));
const verifyIdToken = async (t) => {
  if (CUST[t]) return CUST[t];
  if (t === 'hh') return { uid: 'dev1', handheld: true };
  if (/^[a-zA-Z0-9]+$/.test(t) && t !== 'bad') return { uid: t };
  throw new Error('bad token');
};
const menuOf = (rid) => MENU_BY_RESTAURANT[rid === 'xp_sur' ? 'x_pizza' : rid];
const DISHES = Object.keys(MENU_BY_RESTAURANT.x_pizza);
const ctxOf = (rid, { drop = [] } = {}) => ({ usableAsIdentity: true, objects: Object.keys(menuOf(rid)).filter((k) => !drop.includes(k)).map((k) => ({ kind: 'dish', legacyKey: k, canonicalId: `x_pizza-dish-${Object.keys(menuOf(rid)).indexOf(k)}`, label: k })) });
const cid = (name) => `x_pizza-dish-${DISHES.indexOf(name)}`;

// a member's order at `rid`, placed at `at` (the history ts), with its real dish snapshot
async function place(db, uid, id, { rid = 'x_pizza', at, items } = {}) {
  const body = items || [{ name: DISHES[0], qty: 1 }];
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: at, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana Pérez', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: rid, priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: at, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: body });
  const dq = dishQtyOf(body, 'x_pizza', ctxOf('x_pizza'));
  if (dq) u[`orders/${id}`].dish_qty = dq;
  await db.ref().update(u);
}
// the terminal status, mirrored into the history (the real mirror core), then the real fulfilment stamp at the event time `at`
async function finish(db, id, at, status = 'delivered') {
  db.set(`orders/${id}/status`, status);
  const uid = db.get(`orders/${id}/customer_uid`);
  const d = decideStatusMirror(id, uid, db.get(`user_orders/${uid}/${id}`) != null, status);
  if (d) db.set(d.path, d.value);
  if (V2.FULFILLED.has(status)) await stampRatingFulfilment(db, { orderId: id, status, eventTime: at });
}
const rate = (db, uid, body, now) => rateOrderCore(db, { body, idToken: `tok-${uid}`, now, verifyIdToken, resolveContext: async (rid) => ctxOf(rid) });
const H = 3600e3, DAY = 24 * H;
const NOW = Date.UTC(2026, 10, 18, 18);          // Wed 18 Nov 2026 12:00 HN
const MON = (y, m, d) => Date.UTC(y, m, d, 6);   // a Monday 00:00 HN
const W1_START = MON(2026, 10, 2);               // weeks=1: the closed week Mon 2 – Sun 8 Nov
const CUT = Date.UTC(2026, 6, 1);                // the cut-over: 1 Jul 2026, before every rating here
const ACK = { at: 1_700_000_000_000, by: 'owner', policy_url: 'https://sherpa.example/privacidad' };
async function world() {
  const db = fakeDb(SEED);
  assert.strictEqual((await RC.writeRatingsConfig(db, { payload: { disclosure_v: 1, policy_ack: ACK }, stamp: CUT })).ok, true, 'premise: disclosure enabled by the real writer');
  return db;
}
// an order fulfilled at `at` and first rated an hour later through the real writers
async function rated(db, uid, id, { rid = 'x_pizza', at, store = 5, comment = 'Rica', disclosure = 1, dishes, delivery } = {}) {
  await place(db, uid, id, { rid, at: at - H });
  await finish(db, id, at);
  const body = { order_id: id, ...(store !== undefined ? { store } : {}), ...(comment !== undefined ? { comment } : {}), ...(dishes ? { dishes } : {}), ...(delivery !== undefined ? { delivery } : {}), ...(disclosure !== undefined ? { disclosure } : {}) };
  const r = await rate(db, uid, body, at + H);
  assert.strictEqual(r.httpStatus, 200, `premise: rated ${id} — ${JSON.stringify(r.body)}`);
}
const named = async (db, uid, given = 'Ana', family = 'Pérez') => assert.deepStrictEqual(await S.setMyName(db, { uid, givenName: given, familyName: family }), { ok: true }, 'premise: the real setMyName');

const rl = [];
const handler = (db, { now = NOW, resolveContext = async (rid) => ctxOf(rid), salt } = {}) => MR.makeMerchantReviews({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }),
  checkRateLimit: async (_d, bucket, key, cfg) => { rl.push({ bucket, key, cfg }); return { allowed: true, retryAfterSec: 0 }; }, resolveContext,
  salt: salt || (() => process.env.OTP_SALT), now: () => now }).getMerchantReviews;
async function call(h, { token = 'ownerX', query, method = 'GET' } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const req = { method, query: query || {}, headers, get: (k) => headers[String(k).toLowerCase()] };
  const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
  await h(req, res); return res;
}
const list = async (h, query, token = 'ownerX') => { const r = await call(h, { token, query }); assert.strictEqual(r.code, 200, `premise: 200 (${JSON.stringify(r.body)})`); return r.body; };
const all = async (h, query, token) => { const out = []; let cursor; let pages = 0; do { const b = await list(h, { ...query, ...(cursor ? { cursor } : {}) }, token); out.push(...b.reviews); cursor = b.cursor; pages += 1; assert.ok(pages < 50, 'paging terminates'); } while (cursor); return { rows: out, pages }; };
// the frozen v2 first page (cell §24): copied from the code's own output, then pinned — a shape change fails here first
const FROZEN = {"ok": true, "reviews": [{"rid": "x_pizza", "stars": 4, "comment": null, "rated_on": "2026-11-02", "edited": false}, {"rid": "x_pizza", "stars": 5, "comment": "Excelente", "rated_on": "2026-11-02", "edited": false, "customer": "Ana P.", "tone": 3, "customer_kind": "new", "dishes": [{"name": "Sopressatta Chili Honey", "thumb": 1}, {"name": "Carnivora", "thumb": null}], "total_cents": 30000}], "cursor": null, "overview": {"public": {"count": 12, "average": 4.2}, "stars": {"1": 0, "2": 0, "3": 8, "4": 1, "5": 1}, "stars_n": 10, "overview_state": "fresh"}};
const deepValues = (v, acc = []) => { if (v && typeof v === 'object') for (const x of Object.values(v)) deepValues(x, acc); else acc.push(v); return acc; };
const deepKeys = (v, acc = []) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!Array.isArray(v)) acc.push(k); deepKeys(x, acc); } return acc; };

(async () => {
  // ── 1. authorization: EVERY rid authorized (resolveAccess + can 'stats.read'); any failure ⇒ 403 for the whole call ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-a1', { at: NOW - 2 * DAY }); await rated(db, B, 'XPZ-a2', { rid: 'xp_sur', at: NOW - 2 * DAY });
    const h = handler(db);
    assert.strictEqual((await call(h, { query: { rids: 'x_pizza,xp_sur', weeks: '1' } })).code, 200, 'an owner sees both branches');
    assert.strictEqual((await call(h, { token: 'mgrX', query: { rids: 'x_pizza', weeks: '1' } })).code, 200, 'a manager sees their own branch');
    for (const [who, tok, q, want] of [['a manager asking for the sibling branch', 'mgrX', 'x_pizza,xp_sur', 403], ['another brand\'s rid in rids', 'ownerX', 'x_pizza,la_musa', 403],
      ['the other brand\'s owner', 'ownerM', 'x_pizza', 403], ['a customer', `tok-${A}`, 'x_pizza', 403], ['a handheld', 'hh', 'x_pizza', 403], ['a bad token', 'bad', 'x_pizza', 401], ['no token', null, 'x_pizza', 401]]) {
      const before = db.reads.filter((r) => /^(rating_index|ratings_v2|user_private|user_orders|orders)/.test(r.path)).length;
      const r = await call(h, { token: tok, query: { rids: q, weeks: '1' } });
      assert.strictEqual(r.code, want, `authorization: ${who} ⇒ ${want} (got ${r.code})`);
      assert.strictEqual(db.reads.filter((x) => /^(rating_index|ratings_v2|user_private|user_orders|orders)/.test(x.path)).length, before, `${who}: refused BEFORE any rating read`);
    }
    const out = fakeDb(SEED); const real = out.ref.bind(out); out.ref = (p) => (String(p).startsWith('brand_members') ? { once: async () => { throw new Error('outage'); }, get: async () => { throw new Error('outage'); } } : real(p));
    assert.strictEqual((await call(handler(out), { query: { rids: 'x_pizza', weeks: '1' } })).code, 503, 'a membership outage ⇒ 503');
  }
  ok('authorization: owner ⇒ both branches; manager ⇒ own branch; a sibling / another brand in rids / customer / handheld ⇒ 403 with no rating read; bad token 401; outage 503');

  // ── 2. strict query ──
  {
    const db = await world(); const h = handler(db);
    for (const q of [{}, { rids: 'x_pizza' }, { rids: 'x_pizza', weeks: '2' }, { rids: 'x_pizza', weeks: '4', extra: '1' }, { rids: 'x_pizza,x_pizza', weeks: '4' },
      { rids: Array.from({ length: 11 }, (_, i) => `r${i}x`).join(','), weeks: '4' }, { rids: 'X Pizza', weeks: '4' }, { rids: 'x_pizza', weeks: '4', stars: '6' },
      { rids: 'x_pizza', weeks: '4', stars: '1,1' }, { rids: 'x_pizza', weeks: '4', comment: 'maybe' }, { rids: ['x_pizza'], weeks: '4' }, { rids: 'x_pizza', weeks: '4', cursor: '!!' }])
      assert.strictEqual((await call(h, { query: q })).code, 400, `strict query: ${JSON.stringify(q)} ⇒ 400`);
    assert.strictEqual((await call(h, { query: { rids: 'x_pizza', weeks: '4' }, method: 'POST' })).code, 405);
    assert.ok(rl.some((x) => x.bucket === 'merchant_reviews' && x.key === 'ownerX' && x.cfg.max === 30), 'rate-limited per caller, 30/min');
    assert.strictEqual((await call(handler(db, { salt: () => 'short' }), { query: { rids: 'x_pizza', weeks: '4' } })).code, 503, 'no usable OTP_SALT ⇒ 503');
  }
  ok('strict query: rids (≤ 10, distinct), weeks 1|4|13, stars 1..5 set, comment any|with|without, cursor shape; else 400; 405; per-uid limit; no secret ⇒ 503');

  // ── 3. DISCLOSED rows only (r5 §1): 10 anonymous + 3 disclosed interleaved ⇒ exactly the 3, on every page ──
  {
    const db = await world();
    for (let i = 0; i < 13; i++) await rated(db, UIDS[i % 12], `XPZ-d${i}`, { at: NOW - (i + 1) * H, comment: `c${i}${i % 4 === 0 ? 'NAMED' : 'ANON'}`, disclosure: i % 4 === 0 ? 1 : 0 });
    const { rows } = await all(handler(db), { rids: 'x_pizza', weeks: '1' });
    assert.deepStrictEqual(rows.map((r) => r.comment), ['c0NAMED', 'c4NAMED', 'c8NAMED', 'c12NAMED'].slice(0, 4), 'v2 never returns an anonymous row: exactly the disclosed rows, newest first');
    assert.ok(!JSON.stringify(rows).includes('ANON'), 'no anonymous comment text anywhere in the bodies');
  }
  ok('r5 §1: only disclosed ratings are returned; anonymous ones never appear on any page');

  // ── 4. the row allowlist (r4.2 §1) + date precision (r3 §6): named / unnamed; nothing else is ever served ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-n1', { at: NOW - 5 * H, store: 4, comment: '  Muy rica  ', dishes: { [cid(DISHES[0])]: 1 }, delivery: -1 });
    await named(db, A, 'Ana', 'pérez Lagos');
    await rated(db, B, 'XPZ-u1', { at: NOW - 6 * H, store: 2, comment: 'Fría' });   // disclosed, no structured name
    db.set(`user_profiles/${B}/name`, 'Beto Ruiz');
    const { reviews } = await list(handler(db), { rids: 'x_pizza', weeks: '1' });
    const [a, b] = reviews;
    assert.deepStrictEqual(Object.keys(a).sort(), ['comment', 'customer', 'customer_kind', 'dishes', 'edited', 'rated_on', 'rid', 'stars', 'tone', 'total_cents'], 'a named row: exactly the allowlisted keys');
    assert.deepStrictEqual([a.rid, a.stars, a.comment, a.customer, a.edited, a.total_cents, a.customer_kind], ['x_pizza', 4, 'Muy rica', 'Ana P.', false, 30000, 'new'], 'the named row\'s values');
    assert.strictEqual(a.rated_on, '2026-11-18', 'rated_on is the HN date of rated_at');
    assert.deepStrictEqual(Object.keys(b).sort(), ['comment', 'edited', 'rated_on', 'rid', 'stars'], 'a disclosed row WITHOUT a structured name: no customer / tone / kind / dishes / total (the profile name is never used)');
    const body = JSON.stringify(reviews);
    for (const secret of ['XPZ-n1', 'XPZ-u1', A, B, 'Lagos', 'pérez', 'Beto', 'Ruiz', '50499990000', 'Ana Pérez', 'ana@'])
      assert.ok(!body.includes(secret), `never served: ${secret}`);
    assert.ok(!deepKeys(reviews).some((k) => /delivery|legacy|owner|uid|state|rev|order|key|_at$|token/.test(k)), `no forbidden key (${deepKeys(reviews)})`);
    assert.ok(!deepValues(reviews).some((v) => typeof v === 'number' && /^\d{10,13}$/.test(String(v))), 'date precision: no 10–13-digit integer anywhere');
  }
  ok('the row: named ⇒ { rid, stars, comment, rated_on, edited, customer, tone, customer_kind, dishes, total_cents }; unnamed ⇒ the first five; no id, uid, surname, profile name, phone, delivery thumb or ms time');

  // ── 5. the name is read LIVE: a customer who adds it later appears by name on their earlier DISCLOSED rating ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-l1', { at: NOW - 3 * H, comment: 'Antes sin nombre' });
    const h = handler(db);
    assert.strictEqual((await list(h, { rids: 'x_pizza', weeks: '1' })).reviews[0].customer, undefined, 'premise: no name yet');
    await named(db, A, 'Ana', 'Pérez');
    assert.strictEqual((await list(h, { rids: 'x_pizza', weeks: '1' })).reviews[0].customer, 'Ana P.', 'a name added after a disclosed rating ⇒ shown');
  }
  ok('the structured name is read live: added later ⇒ the earlier disclosed rating shows «Ana P.»');

  // ── 6. tone (r2 §2): keyed per customer, deterministic across rids and calls; pinned against a fixed salt vector ──
  {
    const db = await world();
    await named(db, A, 'Ana', 'Pérez'); await named(db, B, 'Beto', 'Ruiz');
    await rated(db, A, 'XPZ-t1', { at: NOW - 3 * H }); await rated(db, A, 'XPZ-t2', { rid: 'xp_sur', at: NOW - 4 * H }); await rated(db, B, 'XPZ-t3', { at: NOW - 5 * H });
    const h = handler(db);
    const r1 = (await list(h, { rids: 'x_pizza,xp_sur', weeks: '1' })).reviews; const r2 = (await list(h, { rids: 'x_pizza,xp_sur', weeks: '1' })).reviews;
    const toneOfUid = (rows, name) => [...new Set(rows.filter((r) => r.customer === name).map((r) => r.tone))];
    assert.strictEqual(toneOfUid([...r1, ...r2], 'Ana P.').length, 1, 'tone: the same customer ⇒ the same tone across 2 rids and 2 calls');
    const live = MR.avatarKey(process.env.OTP_SALT);
    for (const r of [...r1, ...r2]) assert.strictEqual(r.tone, MR.toneOf(live, r.customer === 'Ana P.' ? A : B), `tone: the same customer ⇒ the same tone — keyed by the CUSTOMER (${r.customer})`);
    const vec = MR.avatarKey('fixed-vector-salt-'.padEnd(40, 'v'));
    const ref = (uid) => crypto.createHmac('sha256', crypto.hkdfSync('sha256', Buffer.from('fixed-vector-salt-'.padEnd(40, 'v')), Buffer.alloc(0), 'sherpa/review-avatar/v1', 32)).update(uid).digest().readUInt32BE(0) % 5;
    assert.deepStrictEqual([MR.toneOf(vec, A), MR.toneOf(vec, B)], [ref(A), ref(B)], 'tone: keyed HMAC-SHA256 under HKDF(OTP_SALT, sherpa/review-avatar/v1), u32 BE mod 5');
    assert.deepStrictEqual([MR.toneOf(vec, A), MR.toneOf(vec, B)], [1, 0], 'tone: the fixed vector');   // computed by an independent HKDF + HMAC run
  }
  ok('tone: one keyed value per customer across rids and calls; the fixed vector pins the derivation');

  // ── 7. customer_kind (r2 Q-D): 1st order ⇒ new; 2nd ⇒ absent; 3rd ⇒ frequent; 2 earlier with one cancelled ⇒ absent ──
  {
    const db = await world(); await named(db, A, 'Ana', 'Pérez'); await named(db, B, 'Beto', 'Ruiz');
    await rated(db, A, 'XPZ-k1', { at: NOW - 30 * H, comment: 'k1' });
    await rated(db, A, 'XPZ-k2', { at: NOW - 20 * H, comment: 'k2' });
    await rated(db, A, 'XPZ-k3', { at: NOW - 10 * H, comment: 'k3' });
    await place(db, B, 'XPZ-kx', { at: NOW - 40 * H }); await finish(db, 'XPZ-kx', NOW - 39 * H, 'cancelled');
    await rated(db, B, 'XPZ-ky', { at: NOW - 35 * H, comment: 'ky' });
    await rated(db, B, 'XPZ-kz', { at: NOW - 9 * H, comment: 'kz' });
    const rows = (await list(handler(db), { rids: 'x_pizza', weeks: '1' })).reviews;
    const kind = (c) => rows.find((r) => r.comment === c).customer_kind;
    assert.deepStrictEqual([kind('k1'), kind('k2'), kind('k3')], ['new', undefined, 'frequent'], 'customer_kind: 1st ⇒ new, 2nd ⇒ no tag, 3rd ⇒ frequent');
    assert.strictEqual(kind('kz'), undefined, 'customer_kind: 2 earlier orders, one cancelled ⇒ no tag (only fulfilled ones count)');
  }
  ok('customer_kind: new / (none) / frequent by earlier FULFILLED orders here; a cancelled one never counts');

  // ── 8. dishes (r2 §4): one entry per purchased dish, the vote or null; a dish that left the menu ⇒ name null ──
  {
    const db = await world(); await named(db, A, 'Ana', 'Pérez');
    const items = [{ name: DISHES[0], qty: 1 }, { name: DISHES[1], qty: 2 }, { name: DISHES[2], qty: 1 }];
    await place(db, A, 'XPZ-ds', { at: NOW - 6 * H, items }); await finish(db, 'XPZ-ds', NOW - 5 * H);
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-ds', store: 4, dishes: { [cid(DISHES[0])]: 1, [cid(DISHES[1])]: -1 }, disclosure: 1 }, NOW - 4 * H)).httpStatus, 200, 'premise: rated with dish votes');
    const rows = (await list(handler(db, { resolveContext: async (rid) => ctxOf(rid, { drop: [DISHES[2]] }) }), { rids: 'x_pizza', weeks: '1' })).reviews;
    assert.strictEqual(rows[0].dishes.length, 3, 'premise: three purchased dishes');
    const byThumb = Object.fromEntries(rows[0].dishes.map((d) => [String(d.name), d.thumb]));
    assert.deepStrictEqual(byThumb, { [DISHES[0]]: 1, [DISHES[1]]: -1, null: null }, 'dishes: +1, −1, and a purchased dish that left the menu (name null, unvoted null)');
  }
  ok('dishes: one per purchased dish with its thumb (or null); a dish no longer on the menu has name null');

  // ── 9. freshness: a withdrawal disappears, an edit shows (edited: true), a deleted account disappears — on the next call ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-f1', { at: NOW - 5 * H, store: 3, comment: 'uno' }); await rated(db, B, 'XPZ-f2', { at: NOW - 6 * H, comment: 'dos' }); await rated(db, C2, 'XPZ-f3', { at: NOW - 7 * H, comment: 'tres' });
    const h = handler(db);
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-f1', store: 5 }, NOW - H)).httpStatus, 200, 'premise: edited');
    assert.strictEqual((await rate(db, B, { order_id: 'XPZ-f2', action: 'withdraw' }, NOW - H)).httpStatus, 200, 'premise: withdrawn');
    await V2.ratingRef(db, 'XPZ-f3').transaction(V2.deletionUpdater({})); db.set(`deleted_uids/${C2}`, 1);
    const rows = (await list(h, { rids: 'x_pizza', weeks: '1' })).reviews;
    assert.deepStrictEqual(rows.map((r) => [r.comment, r.stars, r.edited]), [['uno', 5, true]], 'freshness: edit shown (edited true); withdrawn and deleted gone');
  }
  ok('freshness: an edit shows with edited: true; a withdrawal and a deleted account vanish on the next call');

  // ── 10. the window (r4.2 §2 + r5 §1): START = the oldest closed week's Monday; END = now ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-w0', { at: W1_START - 1, comment: 'domingo antes' });
    await rated(db, A, 'XPZ-w1', { at: W1_START, comment: 'lunes inicio' });
    await rated(db, B, 'XPZ-w2', { at: NOW - H, comment: 'hoy' });
    await rated(db, B, 'XPZ-w3', { at: MON(2026, 10, 9) + DAY, comment: 'semana no cerrada' });
    const h = handler(db);
    const rows = (await all(h, { rids: 'x_pizza', weeks: '1' })).rows.map((r) => r.comment);
    assert.strictEqual(rows[0], 'hoy', 'the list END = now: today\'s disclosed rating is the first row under weeks=1');
    assert.ok(rows.includes('lunes inicio') && rows.includes('semana no cerrada'), 'START: the oldest window week\'s Monday is included, and so is every later day');
    assert.ok(!rows.includes('domingo antes'), 'START: the Sunday before the oldest window week is excluded');
    assert.ok((await all(h, { rids: 'x_pizza', weeks: '4' })).rows.some((r) => r.comment === 'domingo antes'), 'weeks=4 reaches further back');
  }
  ok('window: weeks=N lists from the oldest of the N closed weeks\' Monday to NOW (this week\'s named ratings on top)');

  // ── 11. filters: stars (a set) and comment with / without ──
  {
    const db = await world();
    await rated(db, A, 'XPZ-s1', { at: NOW - 2 * H, store: 1, comment: 'mala' }); await rated(db, B, 'XPZ-s2', { at: NOW - 3 * H, store: 5, comment: null });
    await rated(db, C2, 'XPZ-s3', { at: NOW - 4 * H, store: 3, comment: 'normal' });
    const h = handler(db);
    const q = async (extra) => (await all(h, { rids: 'x_pizza', weeks: '1', ...extra })).rows.map((r) => r.stars);
    assert.deepStrictEqual(await q({ stars: '1,3' }), [1, 3], 'stars filter');
    assert.deepStrictEqual(await q({ comment: 'without' }), [5], 'comment=without');
    assert.deepStrictEqual(await q({ comment: 'with', stars: '5,3' }), [3], 'filters combine');
  }
  ok('filters: a stars set and comment with / without narrow the list');

  // ── 12. r3 §5 eligibility: a fulfilment placeholder, delivery-only feedback and a legacy thumb alone are never rows and never take a slot ──
  {
    const db = await world();
    for (let i = 0; i < 25; i++) { await place(db, A, `XPZ-p${i}`, { at: NOW - (i + 2) * H }); await finish(db, `XPZ-p${i}`, NOW - (i + 1) * H); }   // placeholders
    for (let i = 0; i < 5; i++) await rated(db, B, `XPZ-dv${i}`, { at: NOW - (30 + i) * H, store: null, comment: null, delivery: 1 });
    await place(db, C2, 'XPZ-lt', { at: NOW - 40 * H }); db.set('orders/XPZ-lt/status', 'delivered'); await rate(db, C2, { order_id: 'XPZ-lt', thumb: 'up' }, NOW - 39 * H);
    await rated(db, C2, 'XPZ-real', { at: NOW - 45 * H, comment: 'la de verdad' });
    const { rows } = await all(handler(db), { rids: 'x_pizza', weeks: '1' });
    assert.deepStrictEqual(rows.map((r) => r.comment), ['la de verdad'], 'eligibility: placeholders, delivery-only and legacy-thumb-only are never rows (and never fill a page)');
  }
  ok('r3 §5: only reviewEligible nodes become rows; the rest never take a page slot');

  // ── 13. the k-way merge (r3 §7): two branches interleaved ⇒ newest fulfilment first across them, each exactly once ──
  {
    const db = await world();
    for (let i = 0; i < 80; i++) await rated(db, UIDS[i % 12], `XPZ-m${String(i).padStart(2, '0')}`, { rid: i % 3 === 0 ? 'xp_sur' : 'x_pizza', at: NOW - (i + 1) * H, comment: `m${i}` });   // x_pizza holds more than its 30-key share
    const { rows, pages } = await all(handler(db), { rids: 'x_pizza,xp_sur', weeks: '1' });
    assert.deepStrictEqual(rows.map((r) => r.comment), Array.from({ length: 80 }, (_, i) => `m${i}`), 'k-way merge: newest fulfilment first across branches, each row exactly once');
    assert.ok(pages >= 2, 'premise: more than one page');
  }
  ok('the k-way merge orders two branches exactly (newest first, none repeated or skipped) across pages');

  // ── 13b. the merge FRONTIER: one branch's share is all undisclosed (skipped, the page never fills); an OLDER named row of the other
  //         branch must not jump ahead of a NEWER named row the first branch has not fetched yet ──
  {
    const db = await world();
    for (let i = 1; i <= 40; i++) await rated(db, UIDS[i % 12], `XPZ-fu${String(i).padStart(2, '0')}`, { at: NOW - i * H, comment: `u${i}`, disclosure: 0 });
    await rated(db, A, 'XPZ-fx', { at: NOW - 41 * H, comment: 'X newer' });
    await rated(db, B, 'XPZ-fs', { rid: 'xp_sur', at: NOW - 50 * H, comment: 'S older' });
    const { rows } = await all(handler(db), { rids: 'x_pizza,xp_sur', weeks: '1' });
    assert.deepStrictEqual(rows.map((r) => r.comment), ['X newer', 'S older'], 'merge frontier: newest first even when a branch\'s fetched share is all skipped');
  }
  ok('the merge frontier holds the order when one branch\'s share is all skipped (no older row jumps ahead)');

  // ── 14. the cursor: bound to caller, rid set and filters (400 bad_cursor, v1's body); an EMPTY page still advances ──
  {
    const db = await world();
    for (let i = 0; i < 70; i++) await rated(db, UIDS[i % 12], `XPZ-c${String(i).padStart(2, '0')}`, { at: NOW - (i + 1) * H, comment: `cc${i}`, disclosure: i === 69 ? 1 : 0 });
    const h = handler(db);
    const p1 = await list(h, { rids: 'x_pizza', weeks: '1' });
    assert.deepStrictEqual([p1.reviews.length, typeof p1.cursor], [0, 'string'], 'an empty page (60 undisclosed candidates) still returns a cursor');
    const p2 = await list(h, { rids: 'x_pizza', weeks: '1', cursor: p1.cursor });
    assert.deepStrictEqual([p2.reviews.map((r) => r.comment), p2.cursor], [['cc69'], null], 'the cursor advanced past the empty page; the end ⇒ null');
    for (const [why, q, tok] of [['another rid set', { rids: 'x_pizza,xp_sur', weeks: '1' }, 'ownerX'], ['other filters', { rids: 'x_pizza', weeks: '4' }, 'ownerX'],
      ['another stars filter', { rids: 'x_pizza', weeks: '1', stars: '5' }, 'ownerX'], ['another caller', { rids: 'x_pizza', weeks: '1' }, 'mgrX']]) {
      const r = await call(h, { token: tok, query: { ...q, cursor: p1.cursor } });
      assert.deepStrictEqual([r.code, r.body], [400, { ok: false, reason: 'bad_cursor' }], `a cursor replayed with ${why} ⇒ 400 bad_cursor`);
    }
    const t = p1.cursor; const flip = t.slice(0, 20) + (t[20] === 'A' ? 'B' : 'A') + t.slice(21);
    assert.deepStrictEqual((await call(h, { query: { rids: 'x_pizza', weeks: '1', cursor: flip } })).body, { ok: false, reason: 'bad_cursor' }, 'a tampered cursor ⇒ bad_cursor');
  }
  ok('cursor: sealed to caller + rids + filters (else 400 bad_cursor); an empty page advances it; the last page ⇒ null');

  // ── 15. the read budget (r3 §7): 10 rids × full pages ⇒ ≤ 60 index entries IN TOTAL, ≤ 60 nodes + ≤ 60 tombstone leaves; undisclosed
  //        rows cost nothing beyond node + tombstone (no user_private / order / history read) ──
  {
    const RIDS = Array.from({ length: 10 }, (_, i) => `xb_${i}`);
    const seed = clone(SEED);
    seed.brands.xb = { name: 'XB', active: true, locations: Object.fromEntries(RIDS.map((r) => [r, 'member'])), activation: { state: 'on', since: 1 } };
    for (const r of RIDS) seed.restaurants[r] = { identity: { brand_id: 'xb' } };
    seed.brand_members.xb = { owners: { ownerB: g } };
    const db = fakeDb(seed);
    assert.strictEqual((await RC.writeRatingsConfig(db, { payload: { disclosure_v: 1, policy_ack: ACK }, stamp: CUT })).ok, true);
    await named(db, A, 'Ana', 'Pérez');
    for (let i = 0; i < 100; i++) await rated(db, i % 2 ? A : B, `XB-${String(i).padStart(3, '0')}`, { rid: RIDS[i % 10], at: NOW - (i + 1) * H, comment: `b${i}`, disclosure: i % 2 });
    db.reads.length = 0;
    const b1 = await list(handler(db, { resolveContext: async () => null }), { rids: RIDS.join(','), weeks: '1' }, 'ownerB');
    const idx = db.reads.filter((r) => r.kind === 'query' && r.path.startsWith('rating_index/'));
    assert.ok(idx.every((r) => r.first === 6), `read budget: ⌊60/10⌋ = 6 keys per rid (${idx.map((r) => r.first)})`);
    assert.ok(idx.reduce((a, r) => a + r.n, 0) <= 60, 'read budget: ≤ 60 index entries in total');
    assert.ok(db.reads.filter((r) => r.path.startsWith('ratings_v2/')).length <= 60, 'read budget: ≤ 60 rating nodes');
    assert.ok(db.reads.filter((r) => r.path.startsWith('deleted_uids/')).length <= 60, 'read budget: ≤ 60 tombstone leaves');
    const privateReads = db.reads.filter((r) => r.path.startsWith('user_private/'));
    assert.strictEqual(privateReads.length, 2 * b1.reviews.length, 'read budget: the name read only for returned rows (2 leaves each), never for an undisclosed candidate');
    assert.ok(!privateReads.some((r) => r.path.includes(B)), 'an undisclosed rating\'s owner is never read');
    assert.ok(db.reads.filter((r) => r.kind === 'childQuery').length <= 1, 'read budget: ONE history query per owner');
  }
  ok('read budget: ≤ 60 index entries in total (6 per rid at 10 rids), ≤ 60 nodes + tombstones, name / order / history reads only for returned named rows');

  // ════ S4 (r5 §3–§4, r3 §2, r4.2 §2): rating_buckets/{rid}/{day} = { n1..n5, at } — DISCLOSED eligible 1..5 ratings by FULFILMENT
  // day, built by RB.buildReviewBuckets over the ≤ 105-day aligned range; the Overview on the first page only. ════
  const RB = require('./review-buckets');
  const RW = require('./review-window');
  const W1 = RW.windowOf(1, NOW);                       // the closed week Mon 2 – Sun 8 Nov
  const inW1 = (k) => W1.start + 12 * H + k * 37 * 60e3; // distinct fulfilment times inside that week
  const build = (db, rid = 'x_pizza', { now = NOW, budget } = {}) => RB.buildReviewBuckets({ db, nowMs: now, ...(budget ? { budget } : {}) }, rid);
  const ov = async (db, query = { rids: 'x_pizza', weeks: '1' }, { now = NOW } = {}) => (await list(handler(db, { now }), query)).overview;
  const publish = (db, rid = 'x_pizza') => { const doc = { v: 1, rating_count: 12, rating_avg: 4.2, rating_count_30d: 3 }; db.set(`public_stats/${rid}`, doc); return doc; };

  // ── 16. buckets count DISCLOSED ratings only, by fulfilment day ──
  {
    const db = await world();
    for (let i = 0; i < 5; i++) await rated(db, UIDS[i], `XPZ-b${i}`, { at: inW1(i), store: 4, disclosure: 0 });
    for (let i = 5; i < 7; i++) await rated(db, UIDS[i], `XPZ-b${i}`, { at: inW1(i), store: 4 });
    await build(db);
    const day = RW.hnDate(inW1(0));
    assert.deepStrictEqual([db.get(`rating_buckets/x_pizza/${day}`).n4, db.get(`rating_buckets/x_pizza/${day}`).at], [2, NOW], 'buckets exclude anonymous: 5 anonymous + 2 disclosed 4★ ⇒ n4 = 2, stamped with the run');
    assert.deepStrictEqual(db.get(`rating_buckets/x_pizza/${RW.hnDate(W1.start + 3 * RW.DAY)}`), { at: NOW }, 'an empty day is written { at } (absent ≠ zero)');
  }
  ok('S4 buckets: disclosed eligible 1..5 only, by fulfilment day; empty days are { at }');

  // ── 17. the Overview: the ≥ 10 floor over the window's DISCLOSED count; public = public_stats as published ──
  {
    const db = await world(); const pub = publish(db);
    for (let i = 0; i < 12; i++) await rated(db, UIDS[i], `XPZ-o${i}`, { at: inW1(i), store: 2, disclosure: 0 });
    for (let i = 0; i < 9; i++) await rated(db, UIDS[i], `XPZ-od${i}`, { at: inW1(20 + i), store: 1 + (i % 5) });
    await build(db);
    let o = await ov(db);
    assert.deepStrictEqual(o, { public: { count: 12, average: 4.2 }, stars: null, stars_n: null, overview_state: 'fresh' }, 'the floor: 12 anonymous + 9 disclosed ⇒ stars null AND stars_n null (no count under the floor); public = public_stats');
    await rated(db, A, 'XPZ-od9', { at: inW1(30), store: 5 });
    await build(db);
    o = await ov(db);
    assert.deepStrictEqual([o.stars, o.stars_n], [{ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 }, 10], 'a 10th disclosed ⇒ stars served with stars_n 10');
    assert.deepStrictEqual(o.public, { count: pub.rating_count, average: pub.rating_avg }, 'public is never recomputed from the buckets');
    // an ANONYMOUS withdrawal ⇒ the Overview is byte-identical
    assert.strictEqual((await rate(db, UIDS[3], { order_id: 'XPZ-o3', action: 'withdraw' }, NOW - H)).httpStatus, 200, 'premise: an anonymous rating withdrawn');
    await build(db);
    assert.deepStrictEqual(await ov(db), o, 'an anonymous withdrawal ⇒ the Overview is byte-identical');
  }
  ok('S4 Overview: stars (and stars_n) only at ≥ 10 disclosed in the window; public read from public_stats; anonymous changes never move it');

  // ── 18. every day of one week answers the SAME bars (closed weeks, never rolling); a late rating waits for its week to close ──
  {
    const db = await world(); publish(db);
    for (let i = 0; i < 10; i++) await rated(db, UIDS[i], `XPZ-r${i}`, { at: inW1(i), store: 5 });
    const thisMon = RW.hnMonday(NOW);
    const late = { at: thisMon - 2 * RW.DAY + 12 * H };   // fulfilled Saturday noon of LAST week (not yet closed) …
    await place(db, A, 'XPZ-late', { at: late.at - H }); await finish(db, 'XPZ-late', late.at);
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-late', store: 1, disclosure: 1 }, thisMon + 2 * RW.DAY)).httpStatus, 200, 'premise: … rated on Wednesday of THIS week');
    const seen = [];
    for (let d = 0; d <= 6; d++) { const t = thisMon + d * RW.DAY + H; await build(db, 'x_pizza', { now: t }); const o = await ov(db, undefined, { now: t }); seen.push(JSON.stringify([o.stars, o.stars_n])); }
    assert.strictEqual(new Set(seen).size, 1, `the bars on every day Mon→Sun of one week are byte-identical (${seen[0]})`);
    assert.ok(!seen[0].includes('"1":1'), 'the late 1★ is invisible until its week closes');
    const after = thisMon + 7 * RW.DAY + 2 * H;   // the late rating's week has now closed
    await build(db, 'x_pizza', { now: after });
    const o2 = await ov(db, undefined, { now: after });
    assert.strictEqual(db.get(`rating_buckets/x_pizza/${RW.hnDate(late.at)}`).n1, 1, 'the late rating counts in its FULFILMENT day (Saturday), not its rating day');
    assert.deepStrictEqual([o2.stars, o2.stars_n], [null, null], 'after it closes, the late rating\'s week is the window: 1 disclosed rating there ⇒ under the floor ⇒ null');
  }
  ok('S4: the bars change only when a week closes (never daily); a late rating appears only with its own closed week');

  // ── 19. the builder range: the oldest weeks=13 Monday is built and counted; the Sunday before it is retained out ──
  {
    const db = await world(); publish(db);
    const W13 = RW.windowOf(13, NOW);
    db.set(`rating_buckets/x_pizza/${RW.hnDate(W13.start - RW.DAY)}`, { n5: 3, at: NOW - H });   // a stale day outside the range
    await rated(db, A, 'XPZ-old0', { at: W13.start - H, store: 1 });          // the Sunday before
    await rated(db, A, 'XPZ-old1', { at: W13.start + H, store: 5 });          // the oldest window Monday
    for (let i = 0; i < 9; i++) await rated(db, UIDS[i], `XPZ-mid${i}`, { at: W13.start + (10 + i) * RW.DAY, store: 5 });
    const r = await build(db);
    assert.strictEqual(db.get(`rating_buckets/x_pizza/${RW.hnDate(W13.start - RW.DAY)}`), undefined, 'retention: a day before the range is deleted');
    assert.strictEqual((db.get(`rating_buckets/x_pizza/${RW.hnDate(W13.start)}`) || {}).n5, 1, 'the oldest window week\'s Monday is built');
    assert.ok(r.dropped >= 1, 'premise: the retention dropped it');
    const o = await ov(db, { rids: 'x_pizza', weeks: '13' });
    assert.deepStrictEqual([o.stars && o.stars[5], o.stars && o.stars[1], o.stars_n], [10, 0, 10], 'oldest-week boundary: the Monday counted in weeks=13; the Sunday before is not');
  }
  ok('S4: the builder covers the ≤ 105-day aligned range — the oldest weeks=13 Monday counted, the Sunday before retained out');

  // ── 19b. retention runs FIRST and alone: a scan that fails still leaves no day outside the range ──
  {
    const db = await world();
    const W13 = RW.windowOf(13, NOW);
    db.set(`rating_buckets/x_pizza/${RW.hnDate(W13.start - 3 * RW.DAY)}`, { n2: 1, at: NOW - 30 * RW.DAY });
    const real = db.ref.bind(db);
    const down = { ...db, ref: (p) => (String(p).startsWith('rating_index/') ? { orderByKey: () => { throw new Error('index down'); } } : real(p)) };
    await assert.rejects(() => build(down), /index down/, 'premise: the scan failed');
    assert.strictEqual(db.get(`rating_buckets/x_pizza/${RW.hnDate(W13.start - 3 * RW.DAY)}`), undefined, 'retention first: a failed scan never keeps an out-of-range day');
  }
  ok('S4: retention runs first in its own try — a failed scan still drops every day outside the range');

  // ── 20. the budget: a store above it is refreshed in rotation (newest 8 days first, then from _resume), never aborted ──
  {
    const db = await world();
    for (let i = 0; i < 40; i++) await rated(db, UIDS[i % 12], `XPZ-bg${String(i).padStart(2, '0')}`, { at: NOW - (i * 2 + 1) * RW.DAY, store: 3 });
    const logs = []; const log = console.log; console.log = (...a) => logs.push(a.join(' '));
    let runs = 0;
    try {
      for (; runs < 10; runs++) {
        const r = await build(db, 'x_pizza', { budget: 12 }).catch((e) => ({ error: e.message }));
        assert.ok(!r.error, `budget: never an abort (${r.error})`);
        if (!r.resume) break;
      }
    } finally { console.log = log; }
    assert.ok(runs >= 1, 'budget: the refresh rotated across more than one run');
    assert.ok(logs.some((l) => /review buckets: budget reached/.test(l)), 'budget: one loud log line when it rotates');
    const days = RW.daysOf(RW.builderRange(NOW).start, NOW);
    assert.ok(days.every((d) => { const b = db.get(`rating_buckets/x_pizza/${d}`); return b && b.at === NOW; }), 'budget: after the rotation every day of the range is refreshed');
  }
  ok('S4: above the budget the builder rotates (newest 8 days, then _resume) with a loud line, never an abort; every day refreshed within a few runs');

  // ── 21. freshness: a day not rebuilt within its band ⇒ overview_state stale (never served stale); a deleted account leaves the bars ──
  {
    const db = await world(); publish(db);
    for (let i = 0; i < 10; i++) await rated(db, UIDS[i], `XPZ-fr${i}`, { at: inW1(i), store: 4 });
    await build(db);
    assert.strictEqual((await ov(db)).stars_n, 10, 'premise: 10 served');
    await V2.ratingRef(db, 'XPZ-fr3').transaction(V2.deletionUpdater({})); db.set(`deleted_uids/${UIDS[3]}`, 1);
    await build(db, 'x_pizza', { now: NOW + H });
    assert.deepStrictEqual([(await ov(db, undefined, { now: NOW + H })).stars, (await ov(db, undefined, { now: NOW + H })).stars_n], [null, null], 'an account deleted ⇒ 10 → 9 at the next run ⇒ the bars go null');
    const later = NOW + 9 * RW.DAY;   // no run since: every window day's bucket is older than 8 days
    assert.deepStrictEqual(await ov(db, undefined, { now: later }), { public: { count: 12, average: 4.2 }, stars: null, stars_n: null, overview_state: 'stale' }, 'freshness: no run within the band ⇒ overview_state stale, the bars never served');
  }
  ok('S4 freshness: a stale window is reported stale (bars null); a deletion leaves the bars at the next run');

  // ── 22. a foreign restaurant_id in the index is never counted; the serve reads ≤ 91 bucket keys per rid (never the whole node) ──
  {
    const db = await world(); publish(db);
    await rated(db, A, 'XPZ-fo', { rid: 'xp_sur', at: inW1(1), store: 5 });
    db.set(`rating_index/x_pizza/${V2.indexKey(inW1(1), 'XPZ-fo')}`, 'XPZ-fo');   // a stray entry naming another branch's rating
    await build(db);
    assert.strictEqual(db.get(`rating_buckets/x_pizza/${RW.hnDate(inW1(1))}`).n5, undefined, 'a foreign restaurant_id node is not counted');
    const R = RW.daysOf(RW.builderRange(NOW).start, NOW);
    for (const d of R) db.set(`rating_buckets/x_pizza/${d}`, { n5: 1, at: NOW });
    db.set('rating_buckets/x_pizza/_resume', R[20]);
    db.reads.length = 0;
    await ov(db, { rids: 'x_pizza', weeks: '13' });
    const q = db.reads.filter((r) => r.path.startsWith('rating_buckets/'));
    assert.ok(q.length === 1 && q[0].kind === 'query' && q[0].n <= 91 && q[0].first === 91, `the bucket query reads ≤ 91 keys, never the whole node (${JSON.stringify(q)})`);
  }
  ok('S4: a foreign restaurant_id is never counted; the Overview reads one bounded bucket query per rid (≤ 91 keys, never _resume)');

  // ── 23. the shape: public for one rid; public_by_rid beside it for several; the Overview on the FIRST page only ──
  {
    const db = await world(); publish(db, 'x_pizza'); db.set('public_stats/xp_sur', { v: 1, rating_count: 3 });
    for (let i = 0; i < 25; i++) await rated(db, UIDS[i % 12], `XPZ-sh${String(i).padStart(2, '0')}`, { at: NOW - (i + 1) * H, store: 5 });
    await build(db); await build(db, 'xp_sur');
    const one = await list(handler(db), { rids: 'x_pizza', weeks: '1' });
    assert.ok(!('public_by_rid' in one.overview) && one.overview.public.count === 12, 'one rid: public, no public_by_rid');
    const two = await list(handler(db), { rids: 'x_pizza,xp_sur', weeks: '1' });
    assert.deepStrictEqual([two.overview.public, two.overview.public_by_rid], [null, { x_pizza: { count: 12, average: 4.2 }, xp_sur: null }], 'several rids: public null (never combined) + public_by_rid (null under the published threshold)');
    assert.strictEqual((await list(handler(db), { rids: 'x_pizza', weeks: '1', cursor: one.cursor })).overview, null, 'a cursor page carries overview: null');
  }
  ok('S4 shape: overview.public for one rid, public_by_rid for several; null on cursor pages');

  // ── 24. THE FROZEN RESPONSE (advisor: the v2 shape stays stable for portal-ui) — one first page, every field kind, pinned whole ──
  {
    const db = await world(); publish(db);
    await named(db, A, 'Ana', 'Pérez');
    await place(db, A, 'XPZ-fz1', { at: inW1(1) - H, items: [{ name: DISHES[0], qty: 1 }, { name: DISHES[1], qty: 1 }] }); await finish(db, 'XPZ-fz1', inW1(1));
    assert.strictEqual((await rate(db, A, { order_id: 'XPZ-fz1', store: 5, comment: 'Excelente', dishes: { [cid(DISHES[0])]: 1 }, disclosure: 1 }, inW1(1) + H)).httpStatus, 200);
    await rated(db, B, 'XPZ-fz2', { at: inW1(2), store: 4, comment: null });
    for (let i = 2; i < 10; i++) await rated(db, UIDS[i], `XPZ-fz${i + 1}`, { at: inW1(i + 1), store: 3, comment: null });
    await build(db);
    const body = await list(handler(db), { rids: 'x_pizza', weeks: '1' });
    if (process.env.PRINT_FROZEN) console.log(JSON.stringify({ ...body, reviews: body.reviews.slice(-2) }, null, 2));
    assert.deepStrictEqual({ ...body, reviews: body.reviews.slice(-2) }, FROZEN, 'the frozen v2 response (first page): the last two rows + the overview, byte for byte');
    assert.strictEqual(body.reviews.length, 10, 'premise: ten rows on the page');
  }
  ok('the frozen v2 response: rows (named / unnamed), cursor and overview pinned whole');

  FINISHED = true;
  console.log(`merchant-reviews: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); process.stderr.write(`merchant-reviews: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
