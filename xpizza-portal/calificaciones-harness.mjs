// P-1 «Calificaciones» — the shared REAL-server harness (moved verbatim from calificaciones.test.mjs; used by it and by
// calificaciones-view.test.mjs): the REAL getMerchantRatingComments core over the server test's query-faithful RTDB fake, orders from
// the REAL writers (intake, fulfilment stamp, rateOrderCore), the portal's REAL api.js through a fetch that hands the request to it.
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRatingComments, apiFetch, ApiError } from './api.js';
import { createCommentList } from './calificaciones-logic.js';
const DIR = dirname(fileURLToPath(import.meta.url));
const FN = join(DIR, '..', 'xpizza-functions');
const require = createRequire(join(FN, 'package.json'));
process.env.OTP_SALT = process.env.OTP_SALT || 'calificaciones-test-salt-'.padEnd(40, 'x');
const V2 = require('./ratings/rating-v2.js');
const { rateOrderCore } = require('./ratings/rate-order.js');
const { stampRatingFulfilment } = require('./ratings/rating-fulfilment.js');
// 3a's getMerchantRatingComments WITH the first-page stats (06a236c2 on feat/member-reads-3a, not merged yet): loaded READ-ONLY from its
// ref — never taken by path into this branch. Its requires (rating-v2, access/membership, directory) are byte-equal here. When 3a's
// commit merges, this falls back to the file on disk (the ref is then an ancestor and the bytes match).
const MC_REF = '06a236c23';
const MC = (() => {
  const file = join(FN, 'ratings', 'merchant-comments.js');
  let src;
  try { src = execFileSync('git', ['show', `${MC_REF}:xpizza-functions/ratings/merchant-comments.js`], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return require(file); }
  const m = new Module(file, null); m.filename = file; m.paths = Module._nodeModulePaths(dirname(file));
  m._compile(src, file);
  return m.exports;
})();
const AG = require('./ratings/aggregate.js');
const { ratingsOf } = require('./directory/directory.js');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('./create-order-build.js');
const { MENU_BY_RESTAURANT } = require('./menu-pricing.js');
const { JSDOM } = require('jsdom');


const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ── the server: the merchant-comments test's in-memory RTDB (orderByKey / startAfter / limitToFirst, Admin-SDK transactions) ──
function fakeDb(seed = {}) {
  const tree = clone(seed);
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v === null || v === undefined) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v); };
  const prune = (v) => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(prune); const o = {}; for (const [k, x] of Object.entries(v)) { const p = prune(x); if (p !== null && p !== undefined && !(typeof p === 'object' && !Object.keys(p).length)) o[k] = p; } return o; };
  const snap = (v, ordered) => ({ exists: () => v != null, val: () => (v == null ? null : clone(v)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(v || {}))) if (cb({ key: k, val: () => clone(x) }) === true) return true; return false; } });
  const ref = (p = '') => ({
    get: async () => snap(get(p)), once: async () => snap(get(p)),
    set: async (v) => set(p, prune(v)), update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, prune(v)); },
    child: (c) => ref(p ? `${p}/${c}` : c),
    orderByKey: () => { const q = {}; const api = {
      startAfter: (k) => { q.after = k; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      once: async () => {
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
  return { tree, get, set, ref };
}

// two tenants (the membership facts resolveAccess reads): separate brands, each with its own owner; x_pizza also has a manager
const g = { granted_at: 1, granted_by: 'x' };
const SEED = {
  brands: { x_pizza: { name: 'X', active: true, locations: { x_pizza: 'member' }, activation: { state: 'legacy', since: 1 } },
    la_musa: { name: 'M', active: true, locations: { la_musa: 'member' }, activation: { state: 'legacy', since: 1 } } },
  restaurants: { x_pizza: { identity: { brand_id: 'x_pizza' } }, la_musa: { identity: { brand_id: 'la_musa' } } },
  brand_members: { x_pizza: { owners: { ownerX: g }, managers: { x_pizza: { mgrX: g } } }, la_musa: { owners: { ownerM: g } } },
};
const A = 'u_' + 'a'.repeat(24);
const PHONE = '50499990000';
const verifyIdToken = async (t) => {
  if (t === `tok-${A}`) return { uid: A, customer: true };
  if (/^[a-zA-Z0-9]+$/.test(t) && t !== 'bad') return { uid: t };
  throw new Error('bad token');
};
const usableCtx = (rid) => ({ usableAsIdentity: true, objects: Object.keys(MENU_BY_RESTAURANT[rid]).map((k, i) => ({ kind: 'dish', legacyKey: k, canonicalId: `${rid}-dish-${i}` })) });
const DISH = { x_pizza: 'Margherita', la_musa: null };
async function place(db, id, rid = 'x_pizza') {
  const body = rid === 'x_pizza' ? [{ name: DISH.x_pizza, qty: 1 }] : [{ id: Object.keys(MENU_BY_RESTAURANT.la_musa)[0], name: 'x', qty: 1 }];
  const u = buildCreateOrderUpdates({ orderId: id, orderType: 'pickup', now: 1, trackingToken: 'tk' + id.slice(-4), total: 300, lat: null, lng: null,
    fields: { customer_name: 'Ana Pérez', customer_phone: PHONE, items_text: '1x', notes: '', payment_method: 'cash' }, hubSnap: { hub_lat: 1, hub_lng: 2, restaurant_name: 'R', restaurant_phone: '1' },
    restaurantId: rid, priceBreakdown: { total_cents: 30000, subtotal_cents: 26087, tax_cents: 3913 }, facturaPriced: { items: null }, cashTenderedCents: 30000 });
  attachCustomerAttribution(u, id, A, { now: 1, total: 300, orderType: 'pickup', items_text: '1x', restaurantId: rid, items: body });
  await db.ref().update(u);
}
const fulfil = async (db, id, at) => { db.set(`orders/${id}/status`, 'delivered'); await stampRatingFulfilment(db, { orderId: id, status: 'delivered', now: at }); };
const rate = (db, body, now) => rateOrderCore(db, { body, idToken: `tok-${A}`, now, verifyIdToken, resolveContext: async (rid) => usableCtx(rid) });
// a fulfilled order, rated (or not) — all through the real writers; a delivery thumb on every rating
async function order(db, id, { rid = 'x_pizza', at, comment, store = 5 } = {}) {
  await place(db, id, rid); await fulfil(db, id, at);
  if (comment === undefined) return;
  const r = await rate(db, { order_id: id, store, delivery: 1, comment }, at + 1000);
  assert.equal(r.httpStatus, 200, `premise: rated ${id} — ${JSON.stringify(r.body)}`);
}

// ── the wire: api.js's real request → the real core (URL, method and headers as sent) → a Response-shaped answer ──
const ENDPOINT = 'https://us-central1-xpizza-delivery.cloudfunctions.net/getMerchantRatingComments';
function server(db, { limited = false, salt = () => process.env.OTP_SALT } = {}) {
  const h = MC.makeMerchantRatingComments({ getDatabase: () => db, getAuth: () => ({ verifyIdToken }),
    checkRateLimit: async () => (limited ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 }), salt }).getMerchantRatingComments;
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, ENDPOINT, 'the request goes to getMerchantRatingComments');
    const query = {};
    for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;   // repeated keys → an array (express)
    const headers = {}; for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    calls.push({ url, query, headers });
    const req = { method: opts.method || 'GET', query, body: opts.body, headers, get: (k) => headers[String(k).toLowerCase()] };
    const res = { set() { return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = JSON.stringify(b); return res; } };
    await h(req, res);
    return { ok: res.code >= 200 && res.code < 300, status: res.code, json: async () => JSON.parse(res.body) };
  };
  return { fetch, calls };
}
const tokenOf = (t) => async () => t;
// one visit to the page: a fresh list over the real api.js (the view binds rid + token the same way)
function visit(srv, { rid = 'x_pizza', who = 'ownerX', extra } = {}) {
  globalThis.fetch = srv.fetch;
  return createCommentList({ rid, fetchPage: async ({ rid: r, cursor }) => {
    const body = await fetchRatingComments({ rid: r, cursor, token: tokenOf(who) });
    return extra ? extra(body) : body;
  } });
}
const texts = (st) => st.rows.map((r) => r.comment);
const dom = () => new JSDOM('<!doctype html><ul id="l"></ul>').window.document;

export { V2, MC, MC_REF, AG, ratingsOf, SEED, A, PHONE, fakeDb, order, rate, server, tokenOf, visit, texts, dom, clone, ENDPOINT, JSDOM, fetchRatingComments, apiFetch, ApiError, createCommentList };
