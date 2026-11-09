// S2-checkout — the SDK card placement INSIDE capp-api's placement machinery (advisor design A–D, 11-08; CONTRACT-sdk-checkout r3):
// the durable record is written BEFORE any dispatch and never holds a token / PAN / CVV (card_ref is display only; no sent_body);
// a placement whose answer is unknown is resolved by placeSdkStatus — never a new attempt; a live 'sdk' record goes to the status
// first (place() included); «Probar otra tarjeta» = the same order_id, a new attempt_id, only after a definitive decline; the cash
// switch = cancelSdkPending ⇒ safe_to_switch ⇒ createOrder with a NEW order_id and replaces_order_id. Server bodies come from the
// strict test fake (exact keys per outcome). Every call records the stored placement AT CALL TIME. Every cell across a RELOAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { placeResp, cancelPending } from './test/fake-sdk-checkout.mjs';
const require = createRequire(import.meta.url);
const C = require('./capp-checkout.js');
const A = require('./capp-api.js');

const E = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus',
  placeSdkOrder: 'https://fn.test/placeSdkOrder', placeSdkStatus: 'https://fn.test/placeSdkStatus', cancelSdkPending: 'https://fn.test/cancelSdkPending', listCards: 'https://fn.test/listCards', sdkPayStatus: 'https://fn.test/sdkPayStatus' };
const OPEN_ALL = Array.from({ length: 7 }, () => [11, 0, 22, 0]);
const at = (h, m = 0) => new Date(2026, 9, 26, h, m, 0, 0).getTime();
const KEY = 'capp:rid_a:pending_place';
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; }
function server(script, storage) {
  const calls = [];
  const fetch = async (url, init) => {
    const ep = Object.keys(E).filter((k) => url.startsWith(E[k])).sort((a, b) => E[b].length - E[a].length)[0];
    calls.push({ ep, url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null, headers: (init && init.headers) || {}, placeAtCall: storage.getItem(KEY) });
    const q = script[ep] || []; const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${ep}`);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? await r(calls[calls.length - 1]) : r;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
  };
  return { fetch, calls, of: (ep) => calls.filter((c) => c.ep === ep) };
}
let RNG = 0;
const ANA = { uid: 'u_ana', idToken: null, getIdToken: async () => JWT };
const JWT = (() => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'RS256' })}.${b({ exp: Math.floor(at(23) / 1000) })}.sig`; })();
function rig({ script, storage = memStorage(), member = ANA, guestCardOnly = false } = {}) {
  const srv = server(script, storage); const clock = { t: at(12) };
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL, ...(guestCardOnly ? { guestCardOnly: true } : {}) },
    fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => { RNG = (RNG * 1103515245 + 12345) >>> 0; return (RNG >>> 16) & 255; }),
    setInterval: () => 0, clearInterval: () => {}, member: () => member });
  return { api: make(), reload: make, srv, storage, clock };
}
const ITEMS = [{ id: 'margherita', name: 'Margherita', dish_id: 'd_1', qty: 1, price: 250, subtotal: 250, extras: [], extrasTotal: 0 }];
const CTX = { restaurantId: 'rid_a', items: ITEMS, itemsText: '1x Margherita (L250)', member: null };
const flowOf = (pay = 'online') => { const f = C.freshFlow(null); C.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay }); C.chooseTip(f, 20); return f; };
const SAVED = { kind: 'saved', card_id: 'c_v' };
const NEW = { kind: 'new', sdk_token: 'SDK-TOKEN-SECRET', save: true, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028 } };
const args = (card = SAVED, extra = {}) => ({ flow: flowOf('online'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, card, ...extra });
const rec = (s) => JSON.parse(s.getItem(KEY) || 'null');
const R = (outcome, f) => ({ status: 200, json: placeResp(outcome, f) });
const PLACED = (oid) => R('placed', { order_id: oid, tracking_token: 'tok_abcdefgh12', card: { brand: 'visa', last4: '4242' } });
const DECLINED = (oid, b = 'retryable') => R('declined', { order_id: oid, attempt_id: 'x'.repeat(16), decline: b, pay_deadline_at: at(12, 15) });
const PENDING = (oid) => R('bank_pending', { order_id: oid, attempt_id: 'x'.repeat(16) });

test('the durable record BEFORE the dispatch: sdk, the attempt, dispatched + unresolved — and never the token, never a body', async () => {
  const { api, srv } = rig({ script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)] } });
  const out = await api.placeSdk(args(NEW));
  const call = srv.of('placeSdkOrder')[0];
  assert.ok(call, 'premise: one placement');
  const at0 = JSON.parse(call.placeAtCall || 'null');
  assert.ok(at0 && at0.sdk === true && at0.attempt_id === call.body.attempt_id && at0.attempt_state === 'sent' && at0.dispatched === 1 && at0.unresolved === true, `🔴 SDK-rec: recorded before the dispatch (${call.placeAtCall})`);
  assert.ok(!/SDK-TOKEN-SECRET|sdk_token|sent_body/.test(call.placeAtCall), '🔴 SDK-rec: the record never holds a token or a body');
  assert.deepEqual(at0.card_ref, { kind: 'new', brand: 'visa', last4: '4242' }, 'card_ref is display only');
  assert.equal(call.body.card.sdk_token, 'SDK-TOKEN-SECRET', 'the token goes to the server, once');
  assert.equal(out.kind, 'placed', 'premise');
});

test('placed: the order goes live; the record is cleared; the card label comes back (frame 8); a member sends Authorization: Bearer', async () => {
  const { api, srv, storage } = rig({ script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)] } });
  const out = await api.placeSdk(args(SAVED));
  assert.deepEqual([out.kind, out.tracking_token, out.card && out.card.last4], ['placed', 'tok_abcdefgh12', '4242'], '🔴 SDK-placed');
  assert.equal(rec(storage), null, '🔴 SDK-placed: the record is cleared');
  assert.match(srv.of('placeSdkOrder')[0].headers.Authorization || '', /^Bearer \S+/, '🔴 SDK-auth: member Bearer (contract §1.1)');
  assert.deepEqual(srv.of('placeSdkOrder')[0].body.card, { kind: 'saved', card_id: 'c_v' }, 'the saved card by id');
});

test('declined: the sheet\'s bucket; the record stays, the attempt FINAL; «Probar otra tarjeta» = the SAME order_id, a NEW attempt_id — across a reload', async () => {
  const { api, reload, srv, storage } = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id), (c) => PLACED(c.body.order_id)] } });
  const d = await api.placeSdk(args(SAVED));
  assert.deepEqual([d.kind, d.bucket], ['sdk_declined', 'retryable'], '🔴 SDK-decl: the bucket');
  const r1 = rec(storage);
  assert.ok(r1 && r1.attempt_state === 'declined' && r1.unresolved === false, '🔴 SDK-decl: the attempt is final, the order kept');
  const out = await reload().placeSdk(args(NEW));
  const [a, b] = srv.of('placeSdkOrder').map((c) => c.body);
  assert.equal(b.order_id, a.order_id, '🔴 SDK-retry: the SAME order');
  assert.notEqual(b.attempt_id, a.attempt_id, '🔴 SDK-retry: a NEW attempt');
  assert.equal(out.kind, 'placed');
});

test('unknown (a network error, an unreadable body, a 5xx): NEVER a new attempt — the status decides; still unknown ⇒ sdk_pending, the record unresolved', async () => {
  for (const bad of ['network', { status: 200, json: { outcome: 'approved' } }, { status: 503, json: {} }]) {
    const { api, srv, storage } = rig({ script: { placeSdkOrder: [bad], placeSdkStatus: ['network'] } });
    const out = await api.placeSdk(args(SAVED));
    assert.equal(srv.of('placeSdkOrder').length, 1, `🔴 SDK-unknown: one dispatch only (${JSON.stringify(bad)})`);
    assert.equal(srv.of('placeSdkStatus').length, 1, '🔴 SDK-unknown: the status is asked');
    assert.equal(out.kind, 'sdk_pending', '🔴 SDK-unknown: pending, never declined, never placed');
    const r = rec(storage); assert.ok(r && r.unresolved === true && r.attempt_state === 'sent', 'the record stays unresolved');
  }
});

test('a live SDK attempt: placeSdk AND place() go to placeSdkStatus first — no dispatch of any kind (a reload, a new tap, cash)', async () => {
  const { api, reload, srv } = rig({ script: { placeSdkOrder: ['network'], placeSdkStatus: ['network'] } });
  await api.placeSdk(args(SAVED));
  const n = srv.calls.length;
  const a = await reload().placeSdk(args(NEW));
  const b = await reload().place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(srv.of('placeSdkOrder').length, 1, '🔴 SDK-live: placeSdk never dispatches over a live attempt');
  assert.equal(srv.of('createOrder').length + srv.of('chargeOnlineOrder').length, 0, '🔴 SDK-live: place() never dispatches over a live SDK attempt');
  assert.ok(srv.calls.length > n && srv.calls.slice(n).every((c) => c.ep === 'placeSdkStatus'), '🔴 SDK-live: only status reads');
  assert.deepEqual([a.kind, b.kind], ['sdk_pending', 'sdk_pending'], '🔴 SDK-live: both answer from the status (still unknown ⇒ pending)');
});

test('a live SDK attempt the status answers: placed ⇒ placed (no dispatch), across a reload', async () => {
  const { api, reload, srv } = rig({ script: { placeSdkOrder: ['network'], placeSdkStatus: ['network', (c) => PLACED(new URL(c.url).searchParams.get('order_id'))] } });
  await api.placeSdk(args(SAVED));
  const out = await reload().placeSdk(args(SAVED));
  assert.equal(out.kind, 'placed', '🔴 SDK-live: the status\'s placed is the outcome');
  assert.equal(srv.of('placeSdkOrder').length, 1, 'no second dispatch');
});

test('expired: safe_to_switch ⇒ released (back to checkout); not safe ⇒ kept, keep polling', async () => {
  const s1 = rig({ script: { placeSdkOrder: [(c) => R('expired', { order_id: c.body.order_id, safe_to_switch: true })] } });
  const o1 = await s1.api.placeSdk(args(SAVED));
  assert.deepEqual([o1.kind, o1.safe], ['sdk_expired', true], '🔴 SDK-exp: safe'); assert.equal(rec(s1.storage), null, '🔴 SDK-exp: released');
  const s2 = rig({ script: { placeSdkOrder: [(c) => R('expired', { order_id: c.body.order_id, safe_to_switch: false })] } });
  const o2 = await s2.api.placeSdk(args(SAVED));
  assert.deepEqual([o2.kind, o2.safe], ['sdk_expired', false], '🔴 SDK-exp: not yet safe'); assert.ok(rec(s2.storage), '🔴 SDK-exp: kept');
});

test('the cash switch (§5): cancelSdkPending ⇒ safe ⇒ released, then createOrder with a NEW order_id and replaces_order_id; not safe ⇒ no cash', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id, 'hard')], cancelSdkPending: [{ status: 200, json: cancelPending(true, true) }], createOrder: [(c) => ({ status: 200, json: { ok: true, order_id: c.body.order_id, tracking_token: 'tt' } })] } });
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  const sw = await s.api.sdkSwitchToCash(old);
  assert.deepEqual([sw.kind, sw.replaces], ['sdk_switched', old], '🔴 SDK-switch: safe ⇒ switched'); assert.equal(rec(s.storage), null, 'released');
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old });
  const co = s.srv.of('createOrder')[0].body;
  assert.ok(co.order_id !== old && co.replaces_order_id === old, `🔴 SDK-switch: a NEW order replacing the old one (${co.order_id} / ${co.replaces_order_id})`);
  assert.equal(out.kind, 'placed');
  const n = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id, 'hard')], cancelSdkPending: [{ status: 200, json: cancelPending(true, false) }] } });
  await n.api.placeSdk(args(SAVED));
  const sw2 = await n.api.sdkSwitchToCash(n.srv.of('placeSdkOrder')[0].body.order_id);
  assert.equal(sw2.kind, 'sdk_pending', '🔴 SDK-switch: not yet safe ⇒ poll, never cash'); assert.ok(rec(n.storage), 'kept');
});

test('guests (§1.2): the checkout ticket as X-Sherpa-Order-Ticket, bound to the order; no ticket ⇒ nothing sent; a saved card ⇒ refused locally; adjust_grant returned only on placement', async () => {
  const g = rig({ member: null, guestCardOnly: true, script: { placeSdkOrder: [(c) => ({ status: 200, json: placeResp('placed', { order_id: c.body.order_id, tracking_token: 'tok_abcdefgh12', card: { brand: 'visa', last4: '4242' }, adjust_grant: 'grant-1' }) })] } });
  const none = await g.api.placeSdk(args(NEW));
  assert.equal(none.kind, 'guest_ticket_invalid', '🔴 SDK-guest: no ticket ⇒ nothing sent'); assert.equal(g.srv.calls.length, 0);
  const id = g.api.orderIdForCode({ flow: flowOf('online') });
  const tk = { ticket: 'tk_1', order_id: id, expires_at: at(12, 10) };
  assert.equal((await g.api.placeSdk(args(SAVED, { checkoutTicket: tk }))).kind, 'sdk_bad_card', '🔴 SDK-guest: a saved card is never a guest\'s');
  const out = await g.api.placeSdk(args(NEW, { checkoutTicket: tk }));
  assert.equal(g.srv.of('placeSdkOrder')[0].headers['X-Sherpa-Order-Ticket'], 'tk_1', '🔴 SDK-guest: the ticket header');
  assert.equal(g.srv.of('placeSdkOrder')[0].body.card.save, false, 'a guest never saves');
  assert.deepEqual([out.kind, out.adjust_grant], ['placed', 'grant-1'], '🔴 SDK-guest: the adjust grant from the placing request');
});

test('unavailable / not_allowed / a refusal before any attempt: nothing pending — the record is settled (no lock), the next tap may attempt again', async () => {
  const u = rig({ script: { placeSdkOrder: [(c) => R('unavailable', { retry_after_s: 120 }), (c) => PLACED(c.body.order_id)] } });
  const o = await u.api.placeSdk(args(SAVED));
  assert.deepEqual([o.kind, o.retry_after_s], ['sdk_unavailable', 120], '🔴 SDK-unavail');
  const r = rec(u.storage); assert.ok(r && r.unresolved === false && r.attempt_state === 'none', '🔴 SDK-unavail: no unresolved attempt');
  assert.equal((await u.api.placeSdk(args(SAVED))).kind, 'placed', 'a later tap places');
  const c = rig({ script: { placeSdkOrder: [{ status: 400, json: { error: 'Restaurant closed' } }] } });
  assert.equal((await c.api.placeSdk(args(SAVED))).kind, 'closed', 'the common refusals');
});

test('reads: listCards (members only, Bearer) and sdkPayStatus (no auth), validated', async () => {
  const s = rig({ script: { listCards: [{ status: 200, json: { cards: [{ card_id: 'c_v', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2028, expired: false }] } }], sdkPayStatus: [{ status: 200, json: { available: false, retry_after_s: 60 } }] } });
  assert.equal((await s.api.listCards()).cards.length, 1); assert.match(s.srv.of('listCards')[0].headers.Authorization || '', /^Bearer /, '🔴 SDK-cards: Bearer');
  assert.deepEqual(await s.api.sdkPayStatus(), { available: false, retry_after_s: 60 }, 'the availability');
  assert.equal(await rig({ member: null, script: {} }).api.listCards(), null, '🔴 SDK-cards: a guest has no saved cards (no call)');
});

test('a DISPATCHED placement of another tender (an unresolved hosted card / a cash send) is never paid over by the SDK — resolved first; an undispatched identity (the guest code\'s) is reused', async () => {
  const s = rig({ script: { chargeOnlineOrder: ['network'], paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  await s.api.place({ flow: flowOf('online'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.ok(rec(s.storage) && rec(s.storage).dispatched === 1 && rec(s.storage).sdk !== true, 'premise: a dispatched hosted card, unresolved');
  const out = await s.api.placeSdk(args(SAVED));
  assert.equal(s.srv.of('placeSdkOrder').length, 0, '🔴 SDK-legacy: never paid over a dispatched placement');
  assert.notEqual(out.kind, 'placed', 'resolved, not placed');
});
