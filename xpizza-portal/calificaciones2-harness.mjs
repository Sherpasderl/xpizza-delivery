// «Calificaciones» step 2 (PLAN-portal-calificaciones-step2 r0.1, advisor-approved 11-15) — the shared REAL-server harness: 3a's
// reviews v2 at its PINNED ref (REF), read-only, the whole functions tree as `git archive` writes it (ref-tree.mjs) — getMerchantReviews,
// the v1 getMerchantRatingComments, the bucket builder and the public_stats producer, AND every writer they read: the real intake
// builders + the dish snapshot, the real status mirror + fulfilment stamp, rateOrderCore, the ratings config writer (disclosure + the
// cut-over), setMyName. The RTDB is the reviews test's own query-faithful fake (merchant-reviews.test.js: orderByKey startAt/
// startAfter/endAt/limitToFirst, orderByChild equalTo/endBefore/limitToLast, Admin-SDK transactions). The portal side is the REAL api.js
// over a fetch that hands the request — URL, method, headers — to the core, so it is never laxer than production.
import assert from 'node:assert/strict';
import { refTree } from './ref-tree.mjs';
import { fetchMerchantReviews, fetchRatingComments } from './api.js';

// ── the pin ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const REF = '4adde46e4927e9cea8febff5f18f04868c18c2d5';   // 3a feat/merchant-reviews-v2-3a 4adde46e4 — reviews v2 APPROVED (advisor 11-15)
const require = refTree(REF);
process.env.OTP_SALT = process.env.OTP_SALT || 'calificaciones2-test-salt-'.padEnd(40, 'x');
export const MR = require('./ratings/merchant-reviews.js');
export const MC = require('./ratings/merchant-comments.js');
export const RW = require('./ratings/review-window.js');
export const RB = require('./ratings/review-buckets.js');
export const V2 = require('./ratings/rating-v2.js');
const RC = require('./ratings/ratings-config.js');
const AG = require('./ratings/aggregate.js');
const { rateOrderCore } = require('./ratings/rate-order.js');
const { stampRatingFulfilment } = require('./ratings/rating-fulfilment.js');
const { dishQtyOf } = require('./ratings/dish-qty.js');
const S = require('./signup-core.js');
const { decideStatusMirror } = require('./status-mirror.js');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('./create-order-build.js');
const { MENU_BY_RESTAURANT } = require('./menu-pricing.js');
const { createFakeDb } = require('./merchant/_fake-db.js');
const R = require('./access/roster.js');
const OPS = require('./portal/ops-core.js');
export const { JSDOM } = require('jsdom');   // the functions' own (the step-1 harness's source)

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// the reviews test's in-memory RTDB (merchant-reviews.test.js @ REF), verbatim in behaviour; every read is logged
export function fakeDb(seed = {}) {
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
    child: (c) => ref(p ? `${p}/${c}` : c),
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

// two brands: x_pizza (branches x_pizza «Centro» + xp_sur «Sur») and la_musa — the reviews test's own membership facts
const g = { granted_at: 1, granted_by: 'x' };
export const SEED = {
  brands: { x_pizza: { name: 'X', active: true, locations: { x_pizza: 'member', xp_sur: 'member' }, activation: { state: 'on', since: 1 } },
    la_musa: { name: 'M', active: true, locations: { la_musa: 'member' }, activation: { state: 'legacy', since: 1 } } },
  restaurants: { x_pizza: { identity: { brand_id: 'x_pizza' } }, xp_sur: { identity: { brand_id: 'x_pizza' } }, la_musa: { identity: { brand_id: 'la_musa' } } },
  brand_members: { x_pizza: { owners: { ownerX: g }, managers: { x_pizza: { mgrX: g } } }, la_musa: { owners: { ownerM: g } } },
};
export const UIDS = Array.from({ length: 26 }, (_, i) => `u_${String.fromCharCode(97 + i).repeat(24)}`);
const CUST = Object.fromEntries(UIDS.map((u) => [`tok-${u}`, { uid: u, customer: true }]));
const verifyIdToken = async (t) => {
  if (CUST[t]) return CUST[t];
  if (/^[a-zA-Z0-9]+$/.test(t) && t !== 'bad') return { uid: t };
  throw new Error('bad token');
};
const menuOf = (rid) => MENU_BY_RESTAURANT[rid === 'xp_sur' ? 'x_pizza' : rid];
const DISHES = Object.keys(MENU_BY_RESTAURANT.x_pizza);
const ctxOf = (rid) => ({ usableAsIdentity: true, objects: Object.keys(menuOf(rid)).map((k) => ({ kind: 'dish', legacyKey: k, canonicalId: `x_pizza-dish-${Object.keys(menuOf(rid)).indexOf(k)}` })) });

export const H = 3600e3, DAY = 24 * H;
// the mockup's example day: Sun 15 Nov 2026, 18:00 HN (UTC−6) — the newest CLOSED week is 26 oct – 1 nov (review-window.windowOf)
export const NOW = Date.UTC(2026, 10, 16, 0);
export const CUT = Date.UTC(2026, 6, 1);   // the cut-over: 1 Jul 2026
const ACK = { at: 1_700_000_000_000, by: 'owner', policy_url: 'https://sherpa.example/privacidad' };

// a member's order at `rid`, placed at `at`, with its real dish snapshot (the reviews test's own builder)
async function place(db, uid, id, { rid = 'x_pizza', at } = {}) {
  const body = [{ name: DISHES[0], qty: 1 }];
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: at, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana Pérez', customer_phone: '50499990000', items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: rid, priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  if (uid) attachCustomerAttribution(u, id, uid, { now: at, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: body });
  const dq = dishQtyOf(body, 'x_pizza', ctxOf('x_pizza'));
  if (dq) u[`orders/${id}`].dish_qty = dq;
  await db.ref().update(u);
}
async function finish(db, id, at) {
  db.set(`orders/${id}/status`, 'delivered');
  const uid = db.get(`orders/${id}/customer_uid`);
  const d = decideStatusMirror(id, uid, db.get(`user_orders/${uid}/${id}`) != null, 'delivered');
  if (d) db.set(d.path, d.value);
  await stampRatingFulfilment(db, { orderId: id, status: 'delivered', eventTime: at });
}
export const rate = (db, uid, body, now) => rateOrderCore(db, { body, idToken: `tok-${uid}`, now, verifyIdToken, resolveContext: async (rid) => ctxOf(rid) });
// a world: the membership facts, then (unless `live: false`) the owner's ONE config write — disclosure + the cut-over (the real writer)
export async function world({ live = true } = {}) {
  const db = fakeDb(SEED);
  if (live) await goLive(db);
  return db;
}
// the owner's ONE config write (disclosure + the cut-over), the real writer. Every rating first written AFTER it is stamped post_cutover
// (r6.2: no clock trust) ⇒ an EARLIER (v1) rating is one written BEFORE it: world({ live: false }) → rated(…) → goLive(db)
export const goLive = async (db) => assert.equal((await RC.writeRatingsConfig(db, { payload: { disclosure_v: 1, policy_ack: ACK }, stamp: CUT })).ok, true, 'premise: disclosure enabled by the real writer');
// an order fulfilled at `at`, first rated an hour later through the real writers (disclosure: 1 ⇒ a NAMED rating when the customer has a name)
export async function rated(db, uid, id, o = {}) {
  const { rid = 'x_pizza', at, store = 5 } = o; const comment = 'comment' in o ? o.comment : 'Rica'; const disclosure = 'disclosure' in o ? o.disclosure : 1;   // undefined ⇒ absent
  await place(db, uid, id, { rid, at: at - H });
  await finish(db, id, at);
  const body = { order_id: id, store, ...(comment !== undefined ? { comment } : {}), ...(disclosure !== undefined ? { disclosure } : {}) };
  const r = await rate(db, uid, body, at + H);
  assert.equal(r.httpStatus, 200, `premise: rated ${id} — ${JSON.stringify(r.body)}`);
}
export const named = async (db, uid, given = 'Ana', family = 'Pérez') => assert.deepEqual(await S.setMyName(db, { uid, givenName: given, familyName: family }), { ok: true }, 'premise: the real setMyName');
// the nightly producers, run «now»: the review buckets (bars) and public_stats (the all-time figures) — both the real code
export const buildBuckets = (db, rid = 'x_pizza', now = NOW) => RB.buildReviewBuckets({ db, nowMs: now }, rid);
export async function publishStats(db, rid = 'x_pizza', now = NOW) {
  const ids = Object.keys(db.get('ratings_v2') || {});
  const ratings = []; for (const id of ids) { const r = await V2.readCountable(db, id); if (r && r.restaurant_id === rid) ratings.push(r); }
  db.set(`public_stats/${rid}`, AG.publish({ rid, nowMs: now, buckets: {}, ratings, priceOf: () => null, firstServedAt: 1000 }));
}

// the shell's discovery (getMyBranches) for the page's branch pill: 5f's REAL getMyBranchesCore over the merchant fake, the owner
// bootstrapped by the REAL roster writer — the slot backends' own pattern. Branch names: «Centro» (x_pizza) and «Sur» (xp_sur).
const ALL_DAY = { open: true, start: '00:00', end: '23:59' };
const idOf = (name) => ({ brand_id: 'x_pizza', name, active: true, prep_default_min: 20, version: 1, hub_lat: 15.5, hub_lng: -88.03, delivery_radius_km: 4,
  phone: '+50497128830', hours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, ALL_DAY])) });
export async function discovery({ branches = { x_pizza: 'Centro', xp_sur: 'Sur' } } = {}) {
  const e1db = createFakeDb({
    brands: { x_pizza: { name: 'Pizzería Del Valle', active: true, locations: Object.fromEntries(Object.keys(branches).map((r) => [r, 'member'])), activation: { state: 'on', since: 1 } } },
    restaurants: Object.fromEntries(Object.entries(branches).map(([r, n]) => [r, { identity: idOf(n) }])),
  });
  const boot = await R.mutateRoster({ db: e1db, now: () => 1 }, 'x_pizza', { kind: 'cli', operator: 'test' }, { type: 'bootstrap_owner', uid: 'ownerX', profile: { name: 'Marcela Pineda', email: 'duena@pv.hn' } });
  assert.ok(boot && boot.ok !== false, `premise: the roster writer bootstrapped the owner (${JSON.stringify(boot)})`);
  return { ref: (p) => { const r = e1db.ref(p); return { ...r, get: () => r.once() }; } };
}

// ── the wire: api.js's real request → the real core (URL, method and headers as sent) → a Response-shaped answer ──────────────────
const BASE = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';
export function server(db, { now = NOW, limited = false, down = false, e1 = null } = {}) {
  const rl = async () => (limited ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 });
  const H2 = {
    getMerchantReviews: MR.makeMerchantReviews({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }), checkRateLimit: rl, resolveContext: async (rid) => ctxOf(rid),
      salt: () => process.env.OTP_SALT, now: () => now }).getMerchantReviews,
    ...(e1 ? { getMyBranches: async (req, res) => { const r = await OPS.getMyBranchesCore({ db: e1, verifyIdToken, log: { warn() {} } }, req); res.status(r.status).json(r.body); } } : {}),
    getMerchantRatingComments: MC.makeMerchantRatingComments({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }), checkRateLimit: rl, salt: () => process.env.OTP_SALT }).getMerchantRatingComments,
  };
  const calls = []; const hold = {};   // hold[fn] = Promise: that call's answer waits (one shot)
  const fetch = async (url, opts = {}) => {
    if (down) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const fn = u.pathname.split('/').pop();
    assert.ok(H2[fn] && `${u.origin}${u.pathname}` === `${BASE}${fn}`, `a known endpoint: ${url}`);
    const query = {};
    for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
    const headers = {}; for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    calls.push({ fn, url, query, headers });
    const req = { method: opts.method || 'GET', query, body: opts.body, headers, get: (k) => headers[String(k).toLowerCase()] };
    const res = { set() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = JSON.stringify(b); return res; } };
    await H2[fn](req, res);
    calls[calls.length - 1].status = res.code;
    if (hold[fn]) { const h = hold[fn]; delete hold[fn]; await h; }
    return { ok: res.code >= 200 && res.code < 300, status: res.code, json: async () => JSON.parse(res.body) };
  };
  return { fetch, calls, hold };
}
export const tokenOf = (t) => async () => t;
export { fetchMerchantReviews, fetchRatingComments };
