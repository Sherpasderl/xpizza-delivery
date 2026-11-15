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

  FINISHED = true;
  console.log(`merchant-reviews: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); process.stderr.write(`merchant-reviews: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
