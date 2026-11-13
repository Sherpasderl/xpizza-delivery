// P-1 «Calificaciones» (PLAN-portal-p1-calificaciones-r0, advisor rulings 2026-11-13) — the PURE half: the fetch layer, the cursor
// paging and the list rows. The server is the REAL getMerchantRatingComments core (xpizza-functions/ratings/merchant-comments.js)
// over an in-memory RTDB (the server test's own query-faithful fake): orders from the REAL intake writer, the REAL fulfilment stamp
// (which writes rating_index), the REAL rateOrderCore (comment, edit, withdraw), the REAL deletion updater, authorization through the
// REAL access/membership. The portal side is the REAL api.js (buildRequest + apiFetch + readResponse) over a fetch that hands the
// request, URL, headers and all, to that core — so it is never laxer than production: a `restaurantId=` query or a missing Bearer
// fails exactly as it does in prod.
// Run: node --test calificaciones.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const FN = join(DIR, '..', 'xpizza-functions');
const require = createRequire(join(FN, 'package.json'));
process.env.OTP_SALT = process.env.OTP_SALT || 'calificaciones-test-salt-'.padEnd(40, 'x');
const V2 = require('./ratings/rating-v2.js');
const { rateOrderCore } = require('./ratings/rate-order.js');
const { stampRatingFulfilment } = require('./ratings/rating-fulfilment.js');
const MC = require('./ratings/merchant-comments.js');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('./create-order-build.js');
const { MENU_BY_RESTAURANT } = require('./menu-pricing.js');
const { JSDOM } = require('jsdom');

const { fetchRatingComments, apiFetch, ApiError } = await import('./api.js');
const { commentRow, createCommentList, renderCommentRows, FOLLOW_MAX } = await import('./calificaciones-logic.js');

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

test('contract: GET ?rid=<rid> (+ cursor), the Bearer in a header; the restaurantId= spelling is REFUSED by the real endpoint (400)', async () => {
  const db = fakeDb(SEED); await order(db, 'XPZ-1', { at: 1000, comment: 'Muy rica' });
  const srv = server(db);
  globalThis.fetch = srv.fetch;
  const body = await fetchRatingComments({ rid: 'x_pizza', token: tokenOf('ownerX') })
    .catch((e) => assert.fail(`🔴 the real endpoint refused fetchRatingComments' request: ${e.status} ${JSON.stringify(e.body)}`));
  assert.deepEqual(body.comments, [{ comment: 'Muy rica', store: 5 }]);
  assert.deepEqual(srv.calls[0].query, { rid: 'x_pizza' }, 'exactly rid on page 1 (no cursor key)');
  assert.equal(srv.calls[0].headers.authorization, 'Bearer ownerX', 'the token rides in the header');
  assert.ok(!srv.calls[0].url.includes('ownerX'), 'never in the URL');
  // the pin: buildRequest's own rid argument spells it restaurantId= — the endpoint answers 400, so P-1 must never use it
  await assert.rejects(apiFetch('getMerchantRatingComments', { rid: 'x_pizza', token: tokenOf('ownerX') }),
    (e) => e instanceof ApiError && e.status === 400 && e.body && e.body.reason === 'bad_request');
});

test('rows: ONLY { comment, stars } reach the list and the DOM — no order id, identity, phone, dish or delivery thumb, even if the server sent more', async () => {
  const db = fakeDb(SEED);
  await order(db, 'XPZ-11', { at: 1000, comment: 'Llegó caliente', store: 4 });
  await order(db, 'XPZ-12', { at: 2000, comment: 'Faltó la salsa', store: 2 });
  // a future server field must not leak: every comment arrives with extra keys the list has to drop
  const extra = (b) => ({ ...b, comments: b.comments.map((c) => ({ ...c, orderId: 'XPZ-11', owner_uid: A, delivery: 1, dishes: { Margherita: 1 }, customer_phone: PHONE, rated_at: 1700000000000 })) });
  const list = visit(server(db), { extra });
  const st = await list.load();
  assert.deepEqual(texts(st), ['Faltó la salsa', 'Llegó caliente'], 'newest fulfilment first');
  for (const r of st.rows) assert.deepEqual(Object.keys(r).sort(), ['comment', 'stars'], `🔴 the row carries ONLY comment + stars: ${JSON.stringify(r)}`);
  const doc = dom(); doc.getElementById('l').append(renderCommentRows(doc, st.rows));
  const html = doc.getElementById('l').outerHTML;
  assert.ok(html.includes('Llegó caliente') && html.includes('Faltó la salsa'));
  assert.ok(!/XPZ|u_a{6}|5049999|Margherita|delivery|entrega|repartidor|1700000000000/i.test(html), `🔴 no order id / identity / phone / dish / delivery thumb / date in the DOM: ${html}`);
});

test('cross-tenant: another brand\'s owner is DENIED (403 → denied, no rows, one call); a tenant never sees another rid\'s comment', async () => {
  const db = fakeDb(SEED);
  await order(db, 'XPZ-21', { at: 1000, comment: 'De X' });
  await order(db, 'LMS-21', { rid: 'la_musa', at: 1500, comment: 'De La Musa' });
  // the one way a foreign comment can sit under this tenant's index: a stale / corrupt entry (the server re-verifies restaurant_id)
  db.set(`rating_index/x_pizza/${V2.indexKey(1500, 'LMS-21')}`, 'LMS-21');
  const srv = server(db);
  const denied = await visit(srv, { who: 'ownerM' }).load();
  assert.equal(denied.phase, 'denied'); assert.deepEqual(denied.rows, []); assert.equal(srv.calls.length, 1, 'no retry loop on a 403');
  const own = await visit(srv).load();
  assert.deepEqual(texts(own), ['De X'], '🔴 another rid\'s comment is never shown');
  const mgr = await visit(srv, { who: 'mgrX' }).load();
  assert.deepEqual(texts(mgr), ['De X'], 'a manager of the rid reads it too');
  const theirs = await visit(srv, { rid: 'la_musa', who: 'ownerM' }).load();
  assert.deepEqual(texts(theirs), ['De La Musa']);
});

test('the next visit re-reads: an EDITED comment shows its new text, a WITHDRAWN and a DELETED rating are gone', async () => {
  const db = fakeDb(SEED);
  await order(db, 'XPZ-31', { at: 1000, comment: 'Muy rica' });
  await order(db, 'XPZ-32', { at: 2000, comment: 'Tardó un poco' });
  await order(db, 'XPZ-33', { at: 3000, comment: 'Perfecta' });
  const srv = server(db);
  assert.deepEqual(texts(await visit(srv).load()), ['Perfecta', 'Tardó un poco', 'Muy rica']);
  assert.equal((await rate(db, { order_id: 'XPZ-31', store: 3, delivery: 1, comment: 'Llegó fría' }, 5000)).httpStatus, 200, 'premise: edited');
  const edited = await visit(srv).load();
  assert.deepEqual(texts(edited), ['Perfecta', 'Tardó un poco', 'Llegó fría'], '🔴 the edited text on the next visit');
  assert.equal(edited.rows[2].stars, 3);
  assert.equal((await rate(db, { order_id: 'XPZ-32', action: 'withdraw' }, 6000)).httpStatus, 200, 'premise: withdrawn');
  assert.deepEqual(texts(await visit(srv).load()), ['Perfecta', 'Llegó fría'], '🔴 a withdrawn rating is gone');
  await V2.ratingRef(db, 'XPZ-33').transaction(V2.deletionUpdater({}));   // account deletion: redacted in place, state=deleted
  assert.deepEqual(texts(await visit(srv).load()), ['Llegó fría'], '🔴 a deleted rating is gone');
});

test('paging: 45 comments → 20 + more → 40 → 45, newest first, no duplicates; then no more', async () => {
  const db = fakeDb(SEED);
  for (let i = 0; i < 45; i++) await order(db, `XPZ-p${i}`, { at: 10000 + i * 10, comment: `c${i}` });
  const srv = server(db);
  const list = visit(srv);
  const s1 = await list.load(); assert.equal(s1.rows.length, 20); assert.equal(s1.more, true); assert.equal(s1.rows[0].comment, 'c44');
  assert.ok(srv.calls[0].query.cursor === undefined);
  const s2 = await list.load(); assert.equal(s2.rows.length, 40); assert.equal(s2.more, true);
  assert.equal(typeof srv.calls[1].query.cursor, 'string', 'page 2 follows the cursor');
  const s3 = await list.load(); assert.equal(s3.rows.length, 45); assert.equal(s3.more, false, 'cursor null ⇒ the end');
  assert.deepEqual(texts(s3), Array.from({ length: 45 }, (_, i) => `c${44 - i}`), 'every comment once, newest first');
  const n = srv.calls.length; const s4 = await list.load();
  assert.equal(srv.calls.length, n, 'at the end a load sends nothing'); assert.equal(s4.rows.length, 45);
});

test(`an EMPTY page with a non-null cursor is followed — at most ${3} calls per load, then «more» stays offered`, async () => {
  assert.equal(FOLLOW_MAX, 3);
  const db = fakeDb(SEED);
  await order(db, 'XPZ-old', { at: 1000, comment: 'La más vieja' });
  for (let i = 0; i < 130; i++) await order(db, `XPZ-n${i}`, { at: 5000 + i });          // fulfilled, never commented: index keys only
  const srv = server(db);
  const st = await visit(srv).load();
  assert.deepEqual(texts(st), ['La más vieja'], 'two empty pages (60 + 60 keys) followed to the comment on the third');
  assert.equal(srv.calls.length, 3); assert.equal(st.more, false);

  const db2 = fakeDb(SEED);
  await order(db2, 'XPZ-old', { at: 1000, comment: 'Abajo de todo' });
  for (let i = 0; i < 200; i++) await order(db2, `XPZ-m${i}`, { at: 5000 + i });
  const srv2 = server(db2);
  const list = visit(srv2);
  const a = await list.load();
  assert.equal(srv2.calls.length, FOLLOW_MAX, 'one load never sends more than FOLLOW_MAX calls');
  assert.deepEqual(a.rows, []); assert.equal(a.more, true); assert.equal(a.phase, 'ready', 'not «empty»: more history exists');
  const b = await list.load();
  assert.deepEqual(texts(b), ['Abajo de todo']); assert.equal(b.more, false); assert.equal(srv2.calls.length, FOLLOW_MAX + 1);
});

test('a refused cursor (bad_cursor, e.g. a rotated key) restarts ONCE from page 1 without duplicates; a second refusal is an error', async () => {
  const db = fakeDb(SEED);
  for (let i = 0; i < 45; i++) await order(db, `XPZ-r${i}`, { at: 10000 + i * 10, comment: `c${i}` });
  let salt = process.env.OTP_SALT;
  const srv = server(db, { salt: () => salt });
  const list = visit(srv);
  assert.equal((await list.load()).rows.length, 20);
  salt = 'rotated-salt-'.padEnd(40, 'y');
  const r = await list.load();
  assert.equal(r.phase, 'ready'); assert.equal(r.rows.length, 20, 'restarted: page 1 again, the old rows dropped');
  assert.deepEqual(texts(r), Array.from({ length: 20 }, (_, i) => `c${44 - i}`));
  assert.equal(srv.calls.at(-2).query.cursor !== undefined, true); assert.equal(srv.calls.at(-1).query.cursor, undefined);
  salt = 'rotated-again-'.padEnd(40, 'z');
  const e = await list.load();
  assert.equal(e.phase, 'error', 'only one restart per list'); assert.equal(e.rows.length, 20, 'what is shown stays');
});

test('states: empty (no comments), signed out (no call), 401, 429, 503, a network failure, a malformed body', async () => {
  const db = fakeDb(SEED); await order(db, 'XPZ-e', { at: 1000 });   // fulfilled, no comment
  const srv = server(db);
  const empty = await visit(srv).load();
  assert.deepEqual([empty.phase, empty.rows.length, empty.more], ['empty', 0, false]);
  globalThis.fetch = srv.fetch;
  const n = srv.calls.length;
  const out = await createCommentList({ rid: 'x_pizza', fetchPage: ({ rid, cursor }) => fetchRatingComments({ rid, cursor, token: async () => null }) }).load();
  assert.equal(out.phase, 'signin'); assert.equal(srv.calls.length, n, 'no request without a token');
  assert.equal((await visit(srv, { who: 'bad' }).load()).phase, 'signin', '401 → sign in again');
  assert.equal((await visit(server(db, { limited: true })).load()).phase, 'error', '429');
  assert.equal((await visit(server(db, { salt: () => '' })).load()).phase, 'error', '503');
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await createCommentList({ rid: 'x_pizza', fetchPage: ({ rid, cursor }) => fetchRatingComments({ rid, cursor, token: tokenOf('ownerX') }) }).load()).phase, 'error', 'network');
  for (const bad of [null, {}, { ok: true }, { ok: true, comments: 'x', cursor: null }, { ok: true, comments: [], cursor: 7 }, { ok: true, comments: [] }]) {
    const st = await createCommentList({ rid: 'x_pizza', fetchPage: async () => bad }).load();
    assert.equal(st.phase, 'error', `malformed ${JSON.stringify(bad)} is an error, never «empty»`);
  }
});

test('an error after rows keeps them and offers the retry; a retry continues from the same cursor', async () => {
  const db = fakeDb(SEED);
  for (let i = 0; i < 45; i++) await order(db, `XPZ-k${i}`, { at: 10000 + i * 10, comment: `c${i}` });
  const srv = server(db);
  let fail = false;
  globalThis.fetch = srv.fetch;
  const list = createCommentList({ rid: 'x_pizza', fetchPage: async (q) => { if (fail) throw new ApiError('Unavailable', 503, null); return fetchRatingComments({ ...q, token: tokenOf('ownerX') }); } });
  await list.load(); fail = true;
  const e = await list.load(); assert.equal(e.phase, 'error'); assert.equal(e.rows.length, 20); assert.equal(e.more, true);
  fail = false;
  const r = await list.load(); assert.equal(r.phase, 'ready'); assert.equal(r.rows.length, 40);
  assert.deepEqual(texts(r), Array.from({ length: 40 }, (_, i) => `c${44 - i}`));
});

test('a double click never sends twice: concurrent loads share one request', async () => {
  const db = fakeDb(SEED);
  for (let i = 0; i < 25; i++) await order(db, `XPZ-d${i}`, { at: 10000 + i * 10, comment: `c${i}` });
  const srv = server(db);
  const list = visit(srv);
  const [a, b] = await Promise.all([list.load(), list.load()]);
  assert.equal(srv.calls.length, 1); assert.equal(a.rows.length, 20); assert.deepEqual(a, b);
});

test('commentRow: a comment string (trimmed, non-empty) and stars 1..5 or null — anything else is dropped or nulled', () => {
  assert.deepEqual(commentRow({ comment: '  Rica  ', store: 5 }), { comment: 'Rica', stars: 5 });
  assert.deepEqual(commentRow({ comment: 'x', store: null }), { comment: 'x', stars: null });
  for (const s of [0, 6, 4.5, '5', undefined]) assert.equal(commentRow({ comment: 'x', store: s }).stars, null, `store ${s}`);
  for (const c of [null, undefined, '', '   ', 5, {}]) assert.equal(commentRow({ comment: c, store: 5 }), null);
  assert.equal(commentRow(null), null);
});

test('renderCommentRows: the mockup\'s stars (N filled, the rest empty, «N de 5 estrellas»), the comment as TEXT; no stars when the store is unknown', () => {
  const doc = dom();
  const frag = renderCommentRows(doc, [{ comment: '<b>Rica</b> & caliente', stars: 3 }, { comment: 'Sin estrellas', stars: null }]);
  const ul = doc.getElementById('l'); ul.append(frag);
  const rows = ul.querySelectorAll('li.crow');
  assert.equal(rows.length, 2);
  const st = rows[0].querySelector('.stars');
  assert.equal(st.getAttribute('role'), 'img'); assert.equal(st.getAttribute('aria-label'), '3 de 5 estrellas');
  const svgs = st.querySelectorAll('svg');
  assert.equal(svgs.length, 5);
  assert.deepEqual([...svgs].map((s) => s.classList.contains('e')), [false, false, false, true, true]);
  for (const s of svgs) { assert.equal(s.getAttribute('aria-hidden'), 'true'); assert.equal(s.querySelector('use').getAttribute('href'), '#i-starf'); }
  const p = rows[0].querySelector('.ctxt');
  assert.equal(p.textContent, '<b>Rica</b> & caliente'); assert.equal(p.querySelector('b'), null, 'text, never markup');
  assert.equal(rows[1].querySelector('.stars'), null, 'no guessed stars');
  assert.equal(rows[1].querySelector('.ctxt').textContent, 'Sin estrellas');
});
