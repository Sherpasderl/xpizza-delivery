// S2-checkout — the SDK card placement INSIDE capp-api's placement machinery (advisor design A–D, 11-08; CONTRACT-sdk-checkout r3):
// the durable record is written BEFORE any dispatch and never holds a token / PAN / CVV (card_ref is display only; no sent_body);
// a placement whose answer is unknown is resolved by placeSdkStatus — never a new attempt; a live 'sdk' record goes to the status
// first (place() included); «Probar otra tarjeta» = the same order_id, a new attempt_id, only after a definitive decline; the cash
// switch = cancelSdkPending ⇒ safe_to_switch ⇒ createOrder with a NEW order_id and replaces_order_id. Server bodies come from the
// strict test fake (exact keys per outcome). Every call records the stored placement AT CALL TIME. Every cell across a RELOAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { placeResp, cancelPending, noSdkOrder, namespaceRefusal, SDK_ORDER_ID_RE } from './test/fake-sdk-checkout.mjs';
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
    { const nr = namespaceRefusal(ep, calls[calls.length - 1].body); if (nr) return { status: nr.status, ok: false, json: async () => nr.json }; }   // the server's namespace, before the script
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
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL, sdkCheckout: true, ...(guestCardOnly ? { guestCardOnly: true } : {}) },   // the app's setting under the SDK checkout
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
// the server answers with THE attempt it was asked about (a made-up id would be laxer than the server — and is refused as stale)
const DECLINED = (oid, b = 'retryable', att) => R('declined', { order_id: oid, attempt_id: att, decline: b, pay_deadline_at: at(12, 15) });
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
  const { api, reload, srv, storage } = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id, 'retryable', c.body.attempt_id), (c) => PLACED(c.body.order_id)] } });
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
  const s = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id, 'hard', c.body.attempt_id)], cancelSdkPending: [{ status: 200, json: cancelPending(true, true) }], createOrder: [(c) => ({ status: 200, json: { ok: true, order_id: c.body.order_id, tracking_token: 'tt' } })] } });
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  const sw = await s.api.sdkSwitchToCash(old);
  assert.deepEqual([sw.kind, sw.replaces], ['sdk_switched', old], '🔴 SDK-switch: safe ⇒ switched'); assert.equal(rec(s.storage), null, 'released');
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old });
  const co = s.srv.of('createOrder')[0].body;
  assert.ok(co.order_id !== old && co.replaces_order_id === old, `🔴 SDK-switch: a NEW order replacing the old one (${co.order_id} / ${co.replaces_order_id})`);
  assert.equal(out.kind, 'placed');
  const n = rig({ script: { placeSdkOrder: [(c) => DECLINED(c.body.order_id, 'hard', c.body.attempt_id)], cancelSdkPending: [{ status: 200, json: cancelPending(true, false) }] } });
  await n.api.placeSdk(args(SAVED));
  const sw2 = await n.api.sdkSwitchToCash(n.srv.of('placeSdkOrder')[0].body.order_id);
  assert.equal(sw2.kind, 'sdk_pending', '🔴 SDK-switch: not yet safe ⇒ poll, never cash'); assert.ok(rec(n.storage), 'kept');
});

test('guests (§1.2): the checkout ticket as X-Sherpa-Order-Ticket, bound to the order; no ticket ⇒ nothing sent; a saved card ⇒ refused locally; adjust_grant returned only on placement', async () => {
  const g = rig({ member: null, guestCardOnly: true, script: { placeSdkOrder: [(c) => ({ status: 200, json: placeResp('placed', { order_id: c.body.order_id, tracking_token: 'tok_abcdefgh12', card: { brand: 'visa', last4: '4242' }, adjust_grant: 'grant-1' }) })] } });
  const none = await g.api.placeSdk(args(NEW));
  assert.equal(none.kind, 'guest_ticket_invalid', '🔴 SDK-guest: no ticket ⇒ nothing sent'); assert.equal(g.srv.calls.length, 0);
  const id = g.api.orderIdForCode({ flow: flowOf('online'), sdk: true });   // D4 F1: the SDK card's ticket is bound to an sdk_ id
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

// ── Codex HIGH r1 on S2-checkout (codex-capp-s2-checkout-r1.txt): every finding reproduced first ──
const DECL_OF = (oid, att, b = 'retryable') => R('declined', { order_id: oid, attempt_id: att, decline: b, pay_deadline_at: at(12, 15) });
const slowMember = () => { let rel = []; const m = { uid: 'u_ana', idToken: null, getIdToken: () => new Promise((r) => rel.push(() => r(JWT))) }; return { m, release: () => { const x = rel; rel = []; x.forEach((f) => f()); } }; };

test('Codex r1 P1-1: two concurrent SDK placements ⇒ ONE dispatch (the placement lock; the attempt re-checked right before the POST)', async () => {
  const { api, srv } = rig({ script: { placeSdkOrder: ['network'], placeSdkStatus: ['network'] } });
  await Promise.all([api.placeSdk(args(SAVED)), api.placeSdk(args(NEW))]);
  assert.equal(srv.of('placeSdkOrder').length, 1, '🔴 SDK-race: one POST for one order, never two attempts in flight');
});

test('Codex r1 P1-1: a cash placement and an SDK placement racing never both reach the server for the same order', async () => {
  const { api, srv } = rig({ script: { createOrder: ['network'], placeSdkOrder: ['network'], placeSdkStatus: ['network'], paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  await Promise.all([api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 }), api.placeSdk(args(SAVED))]);
  const ids = (ep) => srv.of(ep).map((c) => c.body.order_id);
  const both = ids('createOrder').filter((id) => ids('placeSdkOrder').includes(id));
  assert.deepEqual(both, [], '🔴 SDK-race: never cash AND card for one order');
});

test('Codex r1 P1-1: a torn-down page (alive() false by dispatch time) never POSTs', async () => {
  const { m, release } = slowMember();
  const { api, srv } = rig({ member: m, script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)] } });
  let alive = true; const p = api.placeSdk(args(SAVED, { alive: () => alive }));
  await new Promise((r) => setImmediate(r)); alive = false; release();
  const out = await p;
  assert.equal(srv.of('placeSdkOrder').length, 0, '🔴 SDK-alive: no POST after teardown'); assert.equal(out.kind, 'superseded');
});

test('Codex r1 P1-2: a delayed answer about attempt A never settles attempt B (settlement bound to the current attempt)', async () => {
  let aId = null;
  const { api, srv, storage } = rig({ script: { placeSdkOrder: [(c) => { aId = c.body.attempt_id; return DECL_OF(c.body.order_id, aId); }, 'network'], placeSdkStatus: [(c) => DECL_OF(new URL(c.url).searchParams.get('order_id'), aId)] } });
  await api.placeSdk(args(SAVED));                       // A declined
  const out = await api.placeSdk(args(NEW));             // B dispatched, unknown ⇒ the status says «declined» — about A
  const b = srv.of('placeSdkOrder')[1].body.attempt_id;
  assert.notEqual(b, aId, 'premise: B is a new attempt');
  const r = rec(storage);
  assert.ok(r && r.attempt_id === b && r.attempt_state === 'sent' && r.unresolved === true, `🔴 SDK-stale: B stays in flight (${JSON.stringify(r && { a: r.attempt_id, s: r.attempt_state })})`);
  assert.equal(out.kind, 'sdk_pending', '🔴 SDK-stale: a stale answer is not B\'s outcome');
});

test('Codex r1 P1-3: cash over a DISPATCHED SDK order, from ANY entry point (place()), goes through the switch — cancelSdkPending ⇒ safe ⇒ a NEW id with replaces_order_id; not safe ⇒ no cash', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], cancelSdkPending: [{ status: 200, json: cancelPending(true, true) }], createOrder: [(c) => ({ status: 200, json: { ok: true, order_id: c.body.order_id, tracking_token: 'tt' } })] } });
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(s.srv.of('cancelSdkPending').length, 1, '🔴 SDK-cash-fence: the switch first');
  const co = s.srv.of('createOrder')[0];
  assert.ok(co && co.body.order_id !== old && co.body.replaces_order_id === old, '🔴 SDK-cash-fence: a NEW order replacing the SDK one');
  assert.equal(out.kind, 'placed');
  const n = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], cancelSdkPending: [{ status: 200, json: cancelPending(true, false) }] } });
  await n.api.placeSdk(args(SAVED));
  const o2 = await n.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(n.srv.of('createOrder').length, 0, '🔴 SDK-cash-fence: not yet safe ⇒ never cash'); assert.equal(o2.kind, 'sdk_pending');
});

test('Codex r1 P2-6: a quote refusal (quote_invalid / quote_required / price_increased) is pre-admission — the attempt released, a requote; never a bank poll', async () => {
  for (const err of ['quote_invalid', 'quote_required', 'price_increased']) {
    const s = rig({ script: { placeSdkOrder: [{ status: 409, json: { error: err } }], placeSdkStatus: [{ status: 404, json: {} }] } });
    const out = await s.api.placeSdk(args(SAVED));
    assert.equal(s.srv.of('placeSdkStatus').length, 0, `🔴 SDK-quote: no status poll (${err})`);
    assert.equal(out.kind, 'replay_requote', `🔴 SDK-quote: a requote (${err})`);
    const r = rec(s.storage); assert.ok(r && r.attempt_state === 'none' && r.unresolved === false, `the attempt released (${err})`);
  }
});

test('Codex r1 P2-7: the legacy recovery of a retained SDK order (resolveExisting / resolveStatus) asks the SDK resolver — a declined one included', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], placeSdkStatus: [(c) => DECL_OF(new URL(c.url).searchParams.get('order_id'), JSON.parse(s.storage.getItem(KEY)).attempt_id)] } });
  await s.api.placeSdk(args(SAVED));
  const id = s.srv.of('placeSdkOrder')[0].body.order_id;
  const out = await s.reload().resolveStatus(id);
  assert.equal(s.srv.of('placeSdkStatus').length, 1, '🔴 SDK-recover: the SDK resolver');
  assert.equal(out.kind, 'sdk_declined', '🔴 SDK-recover: its outcome, never the generic recovery sheet');
});

test('Codex r1 P2-8: the legacy closing / 12-h expiry never deletes an UNRESOLVED SDK attempt', async () => {
  const s = rig({ script: { placeSdkOrder: ['network'], placeSdkStatus: ['network'] } });
  await s.api.placeSdk(args(SAVED));
  s.clock.t += 30 * 3600e3;
  const api2 = s.reload();
  assert.ok(api2.sdkLive(), '🔴 SDK-expiry: the attempt is still live');
  assert.ok(rec(s.storage), '🔴 SDK-expiry: the record is kept');
});

test('Codex r1 P2-9: a cash switch that was not yet safe is REMEMBERED — a later status «expired, safe» completes the switch (sdk_switched + the old id)', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], cancelSdkPending: [{ status: 200, json: cancelPending(true, false) }], placeSdkStatus: [(c) => R('expired', { order_id: new URL(c.url).searchParams.get('order_id'), safe_to_switch: true })] } });
  await s.api.placeSdk(args(SAVED));
  const id = s.srv.of('placeSdkOrder')[0].body.order_id;
  assert.equal((await s.api.sdkSwitchToCash(id)).kind, 'sdk_pending', 'premise: not yet safe');
  const out = await s.reload().sdkStatus(id);
  assert.deepEqual([out.kind, out.replaces], ['sdk_switched', id], '🔴 SDK-switch-intent: the switch completes once safe');
});

test('Codex r1 P1-1: a placement racing a cash switch whose cancel is still in flight waits for it — never an attempt on the order being cancelled', async () => {
  let releaseCancel = null;
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id), (c) => PLACED(c.body.order_id)],
    cancelSdkPending: [() => new Promise((r) => { releaseCancel = () => r({ status: 200, json: cancelPending(true, true) }); })] } });
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  const sw = s.api.sdkSwitchToCash(old);
  await new Promise((r) => setImmediate(r));
  const pl = s.api.placeSdk(args(NEW));
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(s.srv.of('placeSdkOrder').length, 1, '🔴 SDK-lock: no attempt while the switch is in flight');
  releaseCancel(); await sw; await pl;
  assert.ok(s.srv.of('placeSdkOrder').slice(1).every((c) => c.body.order_id !== old), '🔴 SDK-lock: never an attempt on the order being cancelled');
});

// ── Codex narrow r2 (codex-capp-s2-checkout-r2.txt) ──
const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const OK_CASH_FN = (c) => ({ status: 200, json: { ok: true, order_id: c.body.order_id, tracking_token: 'tt' } });

test('Codex r2 P1: a place() WAITING behind an SDK operation is registered at once — a later queued SDK retry never POSTs while that place()\'s cancelSdkPending is in flight', async () => {
  let relPost = null, relCancel = null;
  const s = rig({ script: { placeSdkOrder: [(c) => new Promise((r) => { relPost = () => r(DECL_OF(c.body.order_id, c.body.attempt_id)); }), (c) => PLACED(c.body.order_id)],
    cancelSdkPending: [() => new Promise((r) => { relCancel = () => r({ status: 200, json: cancelPending(true, true) }); })], createOrder: [OK_CASH_FN] } });
  const a = s.api.placeSdk(args(SAVED)); await ticks();
  const b = s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  const c = s.api.placeSdk(args(NEW));
  await ticks(); relPost(); await a; await ticks(12);
  assert.ok(relCancel, 'premise: the cash switch\'s cancel is in flight');
  assert.equal(s.srv.of('placeSdkOrder').length, 1, '🔴 SDK-queue: no SDK retry while the cancel is in flight');
  relCancel(); await b; await c;
});

test('advisor r3 A: after a PRE-ADMISSION refusal the order is still an SDK order — cash ALWAYS goes through cancelSdkPending; the server\'s «never admitted» answer (safe_to_switch:true, nothing cancelled) ⇒ a NEW cash order with replaces_order_id', async () => {
  const s = rig({ script: { placeSdkOrder: [{ status: 409, json: { error: 'quote_invalid' } }], cancelSdkPending: [{ status: 200, json: noSdkOrder() }], createOrder: [OK_CASH_FN] } });   // r3b A1: the server's «no SDK order» answer
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(s.srv.of('cancelSdkPending').length, 1, '🔴 SDK-server-decides: the switch, always (no client-side admission guess)');
  const co = s.srv.of('createOrder')[0];
  assert.ok(co && co.body.order_id !== old && co.body.replaces_order_id === old, '🔴 SDK-server-decides: a NEW cash order replacing it');
  assert.equal(out.kind, 'placed');
});

test('Codex r3 P1-1 repro: quote_invalid → cash (switched) whose answer is LOST → reload: the cash retry re-sends ITS order (no second cancel); a card tap never pays over that dispatched cash order', async () => {
  const s = rig({ script: { placeSdkOrder: [{ status: 409, json: { error: 'quote_invalid' } }], cancelSdkPending: [{ status: 200, json: noSdkOrder() }], createOrder: ['network', OK_CASH_FN] } });
  await s.api.placeSdk(args(SAVED));
  await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });   // the cash send's answer is lost
  const cashId = s.srv.of('createOrder')[0].body.order_id;
  const card = await s.reload().placeSdk(args(NEW));
  assert.equal(s.srv.of('placeSdkOrder').length, 1, '🔴 SDK-r3: no card attempt over the dispatched cash order');
  void card;
  const again = await s.reload().place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(s.srv.of('cancelSdkPending').length, 1, '🔴 SDK-r3: the cash retry never cancels again (it is a cash order now)');
  assert.equal(s.srv.of('createOrder')[1] && s.srv.of('createOrder')[1].body.order_id, cashId, '🔴 SDK-r3: the retry re-sends THE SAME cash order (idempotent)');
  assert.equal(again.kind, 'placed');
});

test('Codex r3 P2-3 repro: SDK A in flight, SDK B queued, then place() C — ONE FIFO queue: A, B, C all finish, in order (no deadlock)', async () => {
  let relA = null; const order = [];
  const s = rig({ script: { placeSdkOrder: [(c) => new Promise((r) => { relA = () => r(DECL_OF(c.body.order_id, c.body.attempt_id)); }), (c) => { order.push('B'); return DECL_OF(c.body.order_id, c.body.attempt_id); }],
    cancelSdkPending: [() => { order.push('C-cancel'); return { status: 200, json: cancelPending(true, true) }; }], createOrder: [(c) => { order.push('C-cash'); return OK_CASH_FN(c); }] } });
  const a = s.api.placeSdk(args(SAVED)); await ticks();
  const b = s.api.placeSdk(args(NEW)); const c = s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  await ticks(); relA();
  const done = await Promise.race([Promise.all([a, b, c]).then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 2000))]);
  assert.equal(done, 'done', '🔴 SDK-fifo: no deadlock — every queued operation completes');
  assert.deepEqual(order, ['B', 'C-cancel', 'C-cash'], '🔴 SDK-fifo: first in, first out');
});

test('Codex r2 P2 (guard): once an attempt WAS admitted (declined), a later pre-admission refusal keeps the server order — cash still goes through the switch', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id), { status: 409, json: { error: 'quote_invalid' } }], cancelSdkPending: [{ status: 200, json: cancelPending(true, true) }], createOrder: [OK_CASH_FN] } });
  await s.api.placeSdk(args(SAVED)); await s.api.placeSdk(args(NEW));
  await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(s.srv.of('cancelSdkPending').length, 1, '🔴 SDK-preadmit: an admitted order is always switched');
});

// ── Codex narrow r4 ──
test('Codex r4 P2-1: a LOST cancelSdkPending reply never strands the switch — the resolver re-sends the idempotent cancel (through the money queue, the stored inputs kept) until safe; across a reload', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], cancelSdkPending: ['network', { status: 200, json: cancelPending(true, true) }], placeSdkStatus: [{ status: 404, json: {} }] } });
  await s.api.placeSdk(args(SAVED));
  const id = s.srv.of('placeSdkOrder')[0].body.order_id;
  const first = await s.api.sdkSwitchToCash(id, { flow: flowOf('cash'), ctx: CTX });
  assert.equal(first.kind, 'sdk_pending', 'premise: the cancel reply was lost');
  const body0 = rec(s.storage).switch_body;
  const out = await s.reload().sdkResolve(id);
  assert.equal(s.srv.of('cancelSdkPending').length, 2, '🔴 SDK-cancel-retry: the cancel is re-sent (never a status that cannot answer)');
  assert.deepEqual([out.kind, out.replaces], ['sdk_switched', id], '🔴 SDK-cancel-retry: the switch completes once safe');
  assert.ok(out.body && body0 && JSON.stringify(out.body) === body0, '🔴 SDK-cancel-retry: the stored cash inputs kept');
});

test('Codex r3 P1-2 regression: a settlement write that FAILS, a reload, a later quote refusal — cash is still the switch (cancel + a NEW replacement order), never a direct createOrder', async () => {
  const storage = memStorage(); let failOnce = true;
  const set = storage.setItem; storage.setItem = (k, v) => { if (failOnce && k === KEY && /"attempt_state":"declined"/.test(v)) { failOnce = false; throw new Error('quota'); } return set(k, v); };
  const s = rig({ storage, script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id), { status: 409, json: { error: 'quote_invalid' } }],
    placeSdkStatus: [(c) => DECL_OF(new URL(c.url).searchParams.get('order_id'), JSON.parse(storage.getItem(KEY)).attempt_id)],
    cancelSdkPending: [{ status: 200, json: cancelPending(true, true) }], createOrder: [OK_CASH_FN] } });
  await s.api.placeSdk(args(SAVED));
  assert.equal(failOnce, false, 'premise: the settlement write failed once');
  const id = s.srv.of('placeSdkOrder')[0].body.order_id;
  const api2 = s.reload();
  await api2.placeSdk(args(NEW));                       // the attempt still «sent» ⇒ its status (declined) settles it
  await api2.placeSdk(args(NEW));                       // a new attempt ⇒ 409 quote_invalid (pre-admission)
  const out = await api2.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  assert.equal(s.srv.of('cancelSdkPending').length, 1, '🔴 SDK-r3-p12: the cancellation');
  const co = s.srv.of('createOrder')[0];
  assert.ok(co && co.body.order_id !== id && co.body.replaces_order_id === id, '🔴 SDK-r3-p12: a NEW replacement order');
  assert.equal(out.kind, 'placed');
});

// ── D4 client follow-ups F1 (PLAN-capp-d4-client-followups r0): the order-id NAMESPACE — the server's own regex, imported ──
const CASH = (x = {}) => ({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, ...x });
test('F1: an SDK placement POSTs an id in the server\'s sdk_ namespace; cash and the hosted card never send one', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)], createOrder: [OK_CASH_FN], chargeOnlineOrder: ['network'], paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  const o0 = await s.api.placeSdk(args(SAVED));
  const posted = s.srv.of('placeSdkOrder').map((c) => c.body.order_id);
  assert.ok(posted.length === 1 && SDK_ORDER_ID_RE.test(posted[0]), `🔴 F1-NS-SDK: ONE SDK POST, its id in the sdk_ namespace (the server regex) (${posted})`);
  assert.equal(o0.kind, 'placed', 'the server admits it');
  await s.api.place(CASH());
  await s.reload().place({ flow: flowOf('online'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  const std = [...s.srv.of('createOrder'), ...s.srv.of('chargeOnlineOrder')].map((c) => c.body.order_id);
  assert.equal(std.length, 2, 'premise: a cash send and a hosted card send');
  assert.ok(std.every((id) => /^TA\d{6}-\d{6}-/.test(id)), `🔴 F1-NS-STD: cash / hosted send the restaurant prefix, never sdk_ (${std})`);
});
test('F1: a namespace MISMATCH on an UNDISPATCHED record re-mints in the tender\'s namespace (both directions); the old id is never sent', async () => {
  const s = rig({ script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)] } });
  const std = s.api.orderIdForCode({ flow: flowOf('cash') });
  assert.ok(std && !std.startsWith('sdk_') && rec(s.storage).dispatched === 0, 'premise: an undispatched std identity');
  await s.api.placeSdk(args(SAVED));
  const sent = s.srv.of('placeSdkOrder')[0].body.order_id;
  assert.ok(sent !== std && SDK_ORDER_ID_RE.test(sent), `🔴 F1-REMINT: std → sdk_ before the dispatch (${std} → ${sent})`);
  const g = rig({ member: null, guestCardOnly: true, script: { chargeOnlineOrder: [(c) => ({ status: 200, json: { checkout_url: 'https://pay.test/x', poll_token: 'pt' } })] } });
  const id0 = g.api.orderIdForCode({ flow: flowOf('online'), sdk: true });
  assert.match(id0, SDK_ORDER_ID_RE, 'premise: an undispatched sdk_ identity');
  const tk = { ticket: 'tk_1', order_id: id0, expires_at: at(12, 10) };
  const out = await g.api.place({ flow: flowOf('online'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, checkoutTicket: tk });
  assert.equal(g.srv.of('chargeOnlineOrder').length, 0, '🔴 F1-REMINT: the sdk_ id is never sent to the hosted charge');
  assert.equal(out.kind, 'guest_ticket_invalid', '🔴 F1-REMINT: the guest\'s ticket was bound to the old id ⇒ the existing re-ask (no new mechanism)');
  assert.ok(!rec(g.storage).order_id.startsWith('sdk_'), '🔴 F1-REMINT: the record now holds a std id');
});
test('F1: a DISPATCHED record is never re-minted — its id is kept and it is resolved first', async () => {
  const s = rig({ script: { chargeOnlineOrder: ['network'], paymentStatus: [{ status: 200, json: { ok: true, state: 'pending' } }] } });
  await s.api.place({ flow: flowOf('online'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500 });
  const id = rec(s.storage).order_id;
  await s.api.placeSdk(args(SAVED));
  assert.equal(rec(s.storage) && rec(s.storage).order_id, id, '🔴 F1-NEVER-REMINT: a dispatched std record keeps its id');
  assert.equal(s.api.orderIdForCode({ flow: flowOf('online'), sdk: true }), id, '🔴 F1-NEVER-REMINT: the guest code binds to the dispatched order, never a re-mint over it');
  assert.equal(rec(s.storage).order_id, id, '🔴 F1-NEVER-REMINT: the dispatched record is untouched');
  const d = rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id), (c) => PLACED(c.body.order_id)] } });
  await d.api.placeSdk(args(SAVED));
  const sid = rec(d.storage).order_id;
  await d.api.placeSdk(args(NEW));
  assert.deepEqual(d.srv.of('placeSdkOrder').map((c) => c.body.order_id), [sid, sid], '🔴 F1-NEVER-REMINT: «Probar otra tarjeta» stays on the dispatched sdk_ order');
});
test('F1: the guest\'s ticket id IS the dispatched id (orderIdForCode mints in the SDK namespace for the SDK card)', async () => {
  const g = rig({ member: null, guestCardOnly: true, script: { placeSdkOrder: [(c) => PLACED(c.body.order_id)] } });
  const id = g.api.orderIdForCode({ flow: flowOf('online'), sdk: true });
  const out = await g.api.placeSdk(args(NEW, { checkoutTicket: { ticket: 'tk_1', order_id: id, expires_at: at(12, 10) } }));
  assert.equal(out.kind, 'placed', 'premise: placed');
  assert.equal(g.srv.of('placeSdkOrder')[0].body.order_id, id, '🔴 F1-TICKET: the ticket-bound id is the one dispatched');
  assert.match(id, SDK_ORDER_ID_RE, '🔴 F1-TICKET: in the sdk_ namespace');
});

// ── D4 F2: 409 attempt_unknown — the REAL placeSdkStatus core (status-endpoint.js) over the honest RTDB model answers it: the order
// exists as an SDK order, no attempt and no PSP-call record (the server journals both BEFORE any PixelPay call) ⇒ proven «no money moved» ──
const { makeHonestDb } = require('../xpizza-functions/_honest-rtdb-model.js');
const { placeSdkStatusCore } = require('../xpizza-functions/payments/sdk/status-endpoint.js');
function realStatus(clock) {
  const db = makeHonestDb({}, { now: () => clock.t });
  const deps = { db, clock: () => clock.t, verifyIdToken: async (t) => { if (t === JWT) return { uid: 'u_ana' }; throw new Error('bad token'); } };
  // the order the server created before the attempt was journaled (the attempt_unknown window)
  const create = (oid) => db.ref(`orders/${oid}`).set({ payment_flow: 'sdk_auth_v1', status: 'pending_payment', customer_uid: 'u_ana', restaurant_id: 'rid_a', total_cents: 31500, pay_deadline_at: clock.t + 15 * 60e3 });
  const answer = async (c) => { const h = c.headers || {}; const r = await placeSdkStatusCore(deps, { headers: { authorization: h.Authorization, 'x-sherpa-order-ticket': h['X-Sherpa-Order-Ticket'] }, query: { order_id: new URL(c.url).searchParams.get('order_id') } }); return { status: r.status, json: r.body }; };
  return { db, create, answer };
}
test('F2: attempt_unknown (the real status core) ⇒ the SAME attempt re-sent ONCE, body identical (saved card); never a decline, never a new attempt', async () => {
  let st = null;
  const s = rig({ script: { placeSdkOrder: [async (c) => { await st.create(c.body.order_id); throw new TypeError('Failed to fetch'); }, (c) => PLACED(c.body.order_id)], placeSdkStatus: [(c) => st.answer(c)] } });
  st = realStatus(s.clock);
  const first = await s.api.placeSdk(args(SAVED));
  assert.equal(s.srv.of('placeSdkStatus').length, 1, 'premise: the status was asked');
  assert.deepEqual([first.kind, first.order_id], ['sdk_resend', s.srv.of('placeSdkOrder')[0].body.order_id], '🔴 F2-RESEND-KIND: attempt_unknown ⇒ sdk_resend (never pending forever, never a decline)');
  const out = await s.api.sdkResend(args(SAVED));
  const [a, b] = s.srv.of('placeSdkOrder').map((c) => c.body);
  assert.equal(s.srv.of('placeSdkOrder').length, 2, '🔴 F2-RESEND-ONCE: exactly one re-send');
  assert.deepEqual([b.order_id, b.attempt_id], [a.order_id, a.attempt_id], '🔴 F2-SAME-ATTEMPT: the same order AND the same attempt_id');
  assert.deepEqual(b, a, '🔴 F2-SAME-BODY: the re-sent body is the first one, byte for byte (saved card)');
  assert.equal(out.kind, 'placed');
});
test('F2: attempt_unknown forever ⇒ at most 3 re-sends, then the normal pending poll; a re-send without a fresh 409 sends nothing', async () => {
  let st = null;
  const s = rig({ script: { placeSdkOrder: [async (c) => { await st.create(c.body.order_id); throw new TypeError('Failed to fetch'); }, 'network'], placeSdkStatus: [(c) => st.answer(c)] } });
  st = realStatus(s.clock);
  let out = await s.api.placeSdk(args(SAVED));
  for (let i = 0; i < 6 && out.kind === 'sdk_resend'; i++) out = await s.api.sdkResend(args(SAVED));
  assert.equal(s.srv.of('placeSdkOrder').length, 4, '🔴 F2-BOUNDED: the first send + 3 re-sends, never more');
  assert.equal(out.kind, 'sdk_pending', '🔴 F2-BOUNDED: then pending (the poll), never a decline');
  const n = s.srv.of('placeSdkOrder').length;
  await s.api.sdkResend(args(SAVED));
  assert.equal(s.srv.of('placeSdkOrder').length, n, '🔴 F2-ONLY-ON-409: no fresh attempt_unknown ⇒ nothing sent');
});
test('F2: a 409 with any OTHER error stays the unknown it was (pending) — no re-send', async () => {
  const s = rig({ script: { placeSdkOrder: ['network'], placeSdkStatus: [{ status: 409, json: { error: 'conflict' } }] } });
  const out = await s.api.placeSdk(args(SAVED));
  assert.equal(out.kind, 'sdk_pending', '🔴 F2-OTHER-409: unchanged behaviour');
  await s.api.sdkResend(args(SAVED));
  assert.equal(s.srv.of('placeSdkOrder').length, 1, '🔴 F2-OTHER-409: nothing re-sent');
});
test('F2 / Q-B (advisor 11-12): a NEW card whose token is gone (reload) ⇒ the attempt settled none, the SAME sdk_ order, the card sheet — the next card a NEW attempt_id', async () => {
  let st = null;
  const s = rig({ script: { placeSdkOrder: [async (c) => { await st.create(c.body.order_id); throw new TypeError('Failed to fetch'); }, (c) => PLACED(c.body.order_id)], placeSdkStatus: [(c) => st.answer(c)] } });
  st = realStatus(s.clock);
  assert.equal((await s.api.placeSdk(args(NEW))).kind, 'sdk_resend', 'premise: attempt_unknown');
  const a = s.srv.of('placeSdkOrder')[0].body;
  const api2 = s.reload();
  assert.equal((await api2.sdkStatus(a.order_id)).kind, 'sdk_resend', 'premise: the reloaded page hears the same 409');
  const out = await api2.sdkResend({});   // the token lived in the old page only
  assert.deepEqual([out.kind, out.order_id], ['sdk_reenter_card', a.order_id], '🔴 F2-QB: the card sheet again, on the same order');
  assert.equal(s.srv.of('placeSdkOrder').length, 1, '🔴 F2-QB: nothing re-sent without the card');
  const r = rec(s.storage); assert.ok(r && r.order_id === a.order_id && r.attempt_state === 'none' && r.unresolved === false, '🔴 F2-QB: the attempt settled none, the order kept');
  assert.equal((await api2.placeSdk(args(NEW))).kind, 'placed');
  const b = s.srv.of('placeSdkOrder')[1].body;
  assert.ok(b.order_id === a.order_id && b.attempt_id !== a.attempt_id, '🔴 F2-QB: the same sdk_ order, a NEW attempt_id');
});

// ── D4 F3: the cash switch — a NEW std id + replaces_order_id; the stored inputs never carry the SDK id; the server's replaces answers ──
const switched = (cash) => rig({ script: { placeSdkOrder: [(c) => DECL_OF(c.body.order_id, c.body.attempt_id)], cancelSdkPending: ['network', { status: 200, json: cancelPending(true, true) }], placeSdkStatus: [{ status: 404, json: {} }], createOrder: cash } });
test('F3: after a switch (a reload mid-switch included) the cash order is a NEW std id replacing the sdk_ one; the stored switch inputs carry no order id', async () => {
  const s = switched([OK_CASH_FN]);
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  assert.equal((await s.api.sdkSwitchToCash(old, { flow: flowOf('cash'), ctx: CTX })).kind, 'sdk_pending', 'premise: the cancel reply was lost');
  const sb = JSON.parse(rec(s.storage).switch_body);
  assert.ok(!('order_id' in sb) && !('replaces_order_id' in sb), `🔴 F3-INPUTS: switch_body is inputs only (${Object.keys(sb).filter((k) => /order_id/.test(k))})`);
  const sw = await s.reload().sdkResolve(old);
  assert.deepEqual([sw.kind, sw.replaces], ['sdk_switched', old], 'premise: the switch completes after the reload');
  const out = await s.reload().place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old });
  const co = s.srv.of('createOrder')[0].body;
  assert.ok(co.order_id !== old && !co.order_id.startsWith('sdk_') && co.replaces_order_id === old, `🔴 F3-NEW-ID: a NEW std id replacing the sdk_ order (${co.order_id} / ${co.replaces_order_id})`);
  assert.equal(out.kind, 'placed');
});
test('F3: createOrder 409 previous_payment_unresolved ⇒ back to the SDK order\'s status (never an error sheet); the same cash id is sent again once it is safe', async () => {
  const s = switched([{ status: 409, json: { error: 'previous_payment_unresolved' } }, OK_CASH_FN]);
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  await s.api.sdkSwitchToCash(old, { flow: flowOf('cash'), ctx: CTX }); await s.api.sdkResolve(old);
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old });
  assert.deepEqual([out.kind, out.order_id], ['sdk_pending', old], '🔴 F3-UNRESOLVED: the SDK order\'s status again, never an error');
  const first = s.srv.of('createOrder')[0].body.order_id;
  assert.equal((await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old })).kind, 'placed');
  assert.equal(s.srv.of('createOrder')[1].body.order_id, first, '🔴 F3-UNRESOLVED: the SAME cash identity once safe (idempotent)');
});
test('F3: createOrder 503 replaces_unavailable (retryable) ⇒ the normal retry (offline), the same cash identity next', async () => {
  const s = switched([{ status: 503, json: { error: 'replaces_unavailable', retryable: true } }, OK_CASH_FN]);
  await s.api.placeSdk(args(SAVED));
  const old = s.srv.of('placeSdkOrder')[0].body.order_id;
  await s.api.sdkSwitchToCash(old, { flow: flowOf('cash'), ctx: CTX }); await s.api.sdkResolve(old);
  const out = await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old });
  assert.equal(out.kind, 'offline', '🔴 F3-503: the normal retry');
  assert.equal((await s.api.place({ flow: flowOf('cash'), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, replacesOrderId: old })).kind, 'placed');
  const [a, b] = s.srv.of('createOrder').map((c) => c.body.order_id);
  assert.equal(b, a, '🔴 F3-503: the same cash identity re-sent');
});
