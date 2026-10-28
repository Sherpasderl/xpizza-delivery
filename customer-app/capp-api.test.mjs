// Customer app S2a (PLAN-capp-S2-r4 §5.2, §7 Transport / Idempotency) — the transport against a SCRIPTED server: the placement
// identity (persisted before the first send; last_send before EVERY send; a failed write ⇒ no send), the 7 clearing outcomes
// and the never-cleared ones — every cell across a RELOAD (a fresh api instance booting from the same storage), the hard expiry
// on a frozen clock (closing wins / 12 h / last_send + 60 min), 202 ⇒ same-identity resend, Already paid ⇒ poll or
// paid_unverified (zero further calls), order_exists (every reason) / order_context_changed ⇒ no mint, the one proven-safe
// cash mint, the card creds persisted BEFORE the redirect, newer-quote-wins, and the return states. The pin test reads the
// REAL server export. The same flows run against the REAL handlers in test/capp-s2a.emulator.test.js. Light: no emulator.
// Run: node --test customer-app/capp-api.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = require('./capp-checkout.js');
const A = require('./capp-api.js');
const { HOSTED_TTL_MS } = require(join(ROOT, 'xpizza-functions/pixelpay-hosted-charge.js'));

const E = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus' };
const OPEN_ALL = Array.from({ length: 7 }, () => [11, 0, 22, 0]);
const at = (h, m = 0, s = 0) => new Date(2026, 9, 26, h, m, s, 0).getTime();   // a Monday, device-local
function memStorage() {
  const m = new Map(); let failWrites = false;
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (failWrites) throw new Error('quota'); m.set(k, String(v)); }, removeItem: (k) => m.delete(k),
    _m: m, set failWrites(v) { failWrites = v; } };
}
// script: url-key → array of responses (status/json or 'network'); every call is recorded with the stored placement AT CALL TIME
function server(script, storage) {
  const calls = [];
  const fetch = async (url, init) => {
    const key = url.startsWith(EV) ? 'verifyCheckoutCode' : Object.keys(E).find((k) => url.startsWith(E[k]));
    calls.push({ ep: key, body: init && init.body ? JSON.parse(init.body) : null, url, headers: (init && init.headers) || {}, placeAtCall: storage.getItem(`capp:rid_a:pending_place`) });
    const q = script[key] || [];
    const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${key}`);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? await r(calls[calls.length - 1]) : r;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => { if (res.badBody) throw new TypeError('body stream lost'); return res.json; } };
  };
  return { fetch, calls, script, of: (ep) => calls.filter((c) => c.ep === ep) };
}
let RNG = 0;   // process-wide: a reloaded page must NOT mint the same id by accident of a restarted counter
function rig({ script, storage = memStorage(), clock = { t: at(12) }, hours = OPEN_ALL, sheet, lock } = {}) {
  const srv = server(script, storage);
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours },
    fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256),
    setInterval: () => 0, clearInterval: () => {}, ...(typeof lock === 'boolean' ? { lockInterruptedCard: lock } : {}) });
  return { api: make(), reload: make, srv, storage, clock, sheet };
}
const ITEMS = [{ id: 'margherita', name: 'Margherita', dish_id: 'd_1', qty: 1, price: 250, subtotal: 250, extras: [], extrasTotal: 0 }];
const CTX = { restaurantId: 'rid_a', items: ITEMS, itemsText: '1x Margherita (L250)', member: null };
const flowOf = (pay = 'cash') => { const f = C.freshFlow(null); C.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay }); C.chooseTip(f, 20); return f; };
const placeArgs = (pay, sheet) => ({ flow: flowOf(pay), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, sheet });
const placeRec = (s) => JSON.parse(s.getItem('capp:rid_a:pending_place') || 'null');
const OK_CASH = { status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } };
const CHECKOUT = { status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } };
const PS = (state, extra = {}) => ({ status: 200, json: { ok: true, state, ...extra } });

test('the send grace is pinned against the REAL server hosted-checkout window (+ 15 min)', () => {
  assert.ok(A.CAPP_SEND_GRACE_MS >= HOSTED_TTL_MS + 15 * 60 * 1000, `CAPP_SEND_GRACE_MS ${A.CAPP_SEND_GRACE_MS} < HOSTED_TTL_MS ${HOSTED_TTL_MS} + 15 min`);
  assert.equal(A.HOSTED_CHECKOUT_MS, HOSTED_TTL_MS, 'the resume window == the server\'s hosted-checkout window');
});

test('the placement record is persisted BEFORE the first send; last_send before EVERY send; a failed write ⇒ no send; money writes are sent ONCE', async () => {
  const R = rig({ script: { createOrder: ['network'] } });
  const out = await R.api.place(placeArgs('cash'));
  assert.equal(out.kind, 'offline');
  const sends = R.srv.of('createOrder');
  assert.equal(sends.length, 1, '🔴 createOrder is NEVER auto-retried (DECISIONS 2026-10-24)');
  assert.ok(sends[0].placeAtCall && JSON.parse(sends[0].placeAtCall).order_id === sends[0].body.order_id, 'the record existed when the request left');
  const W = rig({ script: { createOrder: [OK_CASH] } });
  W.storage.failWrites = true;
  assert.equal((await W.api.place(placeArgs('cash'))).kind, 'stash_failed', 'a failed record write ⇒ stash_failed');
  assert.equal(W.srv.calls.length, 0, '🔴 a failed record write ⇒ NO request');
  // the last_send re-write before a 202 RE-SEND fails ⇒ that re-send is not sent (and the placement resolves, never throws)
  const IP = { status: 202, json: { ok: true, status: 'in_progress' } };
  const M = rig({ script: { chargeOnlineOrder: [IP, CHECKOUT] } });
  let writes = 0; const real = M.storage.setItem;
  M.storage.setItem = (k, v) => { if (k.endsWith(':pending_place') && ++writes > 2) throw new Error('quota'); real(k, v); };
  const mo = await M.api.place(placeArgs('online'));
  assert.deepEqual([mo.kind, M.srv.of('chargeOnlineOrder').length], ['stash_failed', 1], '🔴 no send without a persisted last_send');
});

test('a network drop after the write ⇒ «Reintentar» resends the SAME id — also after a reload', async () => {
  const R = rig({ script: { createOrder: ['network'] } });
  const a = await R.api.place(placeArgs('cash'));
  assert.equal(a.kind, 'offline');
  const id = a.order_id;
  assert.equal(placeRec(R.storage).order_id, id, 'kept on a network failure');
  R.srv.calls.length = 0;
  const after = rig({ script: { createOrder: [OK_CASH] }, storage: R.storage, clock: R.clock });
  const b = await after.api.place(placeArgs('cash'));
  assert.equal(b.kind, 'placed'); assert.equal(after.srv.of('createOrder')[0].body.order_id, id, '🔴 the reloaded page resends the SAME order_id');
});

test('order_exists (EVERY reason) and order_context_changed NEVER mint — the recovery sheet, the identity kept, across a reload', async () => {
  for (const reason of ['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'tip', 'conflict']) {
    for (const pay of ['cash', 'online']) {
      const ep = pay === 'cash' ? 'createOrder' : 'chargeOnlineOrder';
      const R = rig({ script: { [ep]: [{ status: 409, json: { error: 'order_exists', reason, order_id: 'Q' } }] } });
      const out = await R.api.place(placeArgs(pay));
      const id = R.srv.of(ep)[0].body.order_id;
      assert.deepEqual([out.kind, out.reference], ['existing_order', id.slice(-4).toUpperCase()], `${pay} ${reason}: the recovery sheet («Referencia #ABCD»)`);
      assert.equal(placeRec(R.storage).order_id, id, `🔴 ${pay} ${reason}: no mint — the identity is kept`);
      const again = R.reload();
      const R2 = rig({ script: { [ep]: [{ status: 409, json: { error: 'order_exists', reason } }] }, storage: R.storage, clock: R.clock });
      await R2.api.place(placeArgs(pay)); void again;
      assert.equal(R2.srv.of(ep)[0].body.order_id, id, `${pay} ${reason}: after a reload, still the SAME id`);
    }
  }
  const X = rig({ script: { createOrder: [{ status: 409, json: { error: 'order_context_changed' } }] } });
  const ox = await X.api.place(placeArgs('cash'));
  assert.equal(ox.kind, 'existing_order'); assert.ok(placeRec(X.storage), 'order_context_changed: kept');
});

test('order_exists WITH creds ⇒ ONE paymentStatus first (paid ⇒ placed for THAT order; 403 ⇒ the sheet)', async () => {
  const R = rig({ script: { chargeOnlineOrder: [CHECKOUT, { status: 409, json: { error: 'order_exists', reason: 'cart' } }], paymentStatus: [PS('paid', { tracking_token: 'tk' })] } });
  const first = await R.api.place(placeArgs('online'));
  assert.equal(first.kind, 'redirect');
  const out = await R.api.place(placeArgs('online'));
  assert.deepEqual([out.kind, out.order_id, R.srv.of('paymentStatus').length], ['placed', first.order_id, 1]);
  assert.equal(placeRec(R.storage), null, 'paid ⇒ cleared (outcome 2)');
  const F = rig({ script: { chargeOnlineOrder: [CHECKOUT, { status: 409, json: { error: 'order_exists', reason: 'cart' } }], paymentStatus: [{ status: 403, json: { error: 'forbidden' } }] } });
  await F.api.place(placeArgs('online'));
  assert.equal((await F.api.place(placeArgs('online'))).kind, 'existing_order', 'a rejected token ⇒ the sheet');
  assert.ok(placeRec(F.storage), '403 never clears');
});

test('the proven-safe cash mint: legacy 409 order_conflict ⇒ cleared and ONE resend on a fresh id', async () => {
  const R = rig({ script: { createOrder: [{ status: 409, json: { error: 'order_conflict', reason: 'closed' } }, OK_CASH] } });
  const out = await R.api.place(placeArgs('cash'));
  const [a, b] = R.srv.of('createOrder').map((c) => c.body.order_id);
  assert.equal(out.kind, 'placed'); assert.notEqual(a, b, 'a FRESH id'); assert.equal(R.srv.of('createOrder').length, 2, 'exactly one resend');
  const T = rig({ script: { createOrder: [{ status: 409, json: { error: 'order_conflict' } }] } });
  assert.equal((await T.api.place(placeArgs('cash'))).kind, 'error'); assert.equal(T.srv.of('createOrder').length, 2, 'never a loop');
});

test('card: the creds are persisted AFTER the response and BEFORE the redirect; a stash failure ⇒ no redirect', async () => {
  const R = rig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  const out = await R.api.place(placeArgs('online'));
  assert.deepEqual([out.kind, out.url], ['redirect', 'https://pay.test/1']);
  const s = JSON.parse(R.storage.getItem('ta_pending_pay'));
  assert.deepEqual([s.order_id, s.t, Object.keys(s).sort()], [out.order_id, 'pt_1', ['form', 'order', 'order_id', 't', 'ts']], 'the minimal legacy shape');
  assert.equal(R.srv.of('chargeOnlineOrder')[0].body.entry_mode, 'app');
  assert.ok(placeRec(R.storage), 'a redirect does not clear the placement');
  const W = rig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  const real = W.storage.setItem; W.storage.setItem = (k, v) => { if (k === 'ta_pending_pay') throw new Error('quota'); real(k, v); };
  assert.equal((await W.api.place(placeArgs('online'))).kind, 'stash_failed', '🔴 no token persisted ⇒ no redirect');
});

test('202 in_progress ⇒ the SAME identity is re-sent until the checkout (never a poll, never a mint)', async () => {
  const IP = { status: 202, json: { ok: true, status: 'in_progress' } };
  const R = rig({ script: { chargeOnlineOrder: [IP, IP, CHECKOUT] } });
  const out = await R.api.place(placeArgs('online'));
  const ids = R.srv.of('chargeOnlineOrder').map((c) => c.body.order_id);
  assert.deepEqual([out.kind, ids.length, new Set(ids).size, R.srv.of('paymentStatus').length], ['redirect', 3, 1, 0]);
});

test('409 Already paid: a stashed token ⇒ poll recovery; NO token / a REJECTED token ⇒ paid_unverified with zero further calls', async () => {
  const AP = { status: 409, json: { error: 'Already paid' } };
  const R = rig({ script: { chargeOnlineOrder: [CHECKOUT, AP], paymentStatus: [PS('closed_refunded', { refunded_total_cents: 31500 })] } });
  await R.api.place(placeArgs('online'));
  const out = await R.api.place(placeArgs('online'));
  assert.deepEqual([out.kind, out.refunded_total_cents], ['refunded', 31500], 'with a token: polled faithfully (closed_refunded)');
  assert.equal(R.storage.getItem('ta_pending_pay'), null, 'the refund clears the stash'); assert.equal(placeRec(R.storage), null, 'and pending_place (outcome 4)');
  const N = rig({ script: { chargeOnlineOrder: [AP] } });
  const n = await N.api.place(placeArgs('online'));
  assert.equal(n.kind, 'paid_unverified', 'no token: Already paid ⇒ paid_unverified');
  assert.deepEqual([N.srv.of('chargeOnlineOrder').length, N.srv.of('paymentStatus').length], [1, 0], '🔴 no token: never polls, never re-sends');
  assert.equal(placeRec(N.storage), null, 'Already paid clears (outcome 3)');
  const X = rig({ script: { chargeOnlineOrder: [CHECKOUT, AP], paymentStatus: [{ status: 403, json: {} }] } });
  await X.api.place(placeArgs('online'));
  const x = await X.api.place(placeArgs('online'));
  // S2b r2 (advisor-approved): an issued card record is polled FIRST — a rejected token never learned «paid» ⇒ the recovery sheet
  assert.deepEqual([x.kind, X.srv.of('paymentStatus').length, X.srv.of('chargeOnlineOrder').length], ['existing_order', 1, 1], 'a rejected token ⇒ paid_unverified, nothing more');
});

test('the return: paid ⇒ placed (cleared); cancelled / failed ⇒ «Pago no completado» (S2: cleared); verifying / pending / timeout ⇒ confirming (KEPT) — across a reload', async () => {
  const cases = [
    ['paid', 'placed', false], ['scheduled_paid', 'placed', false], ['failed', 'payment_failed', false], ['cancelled', 'payment_failed', false],
    ['closed_refunded', 'refunded', false], ['verifying', 'confirming', true], ['scheduled_review', 'confirming', true],
  ];
  for (const [state, kind, kept] of cases) {
    const R = rig({ script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: [PS(state, { refunded_total_cents: 100 })] } });
    const r = await R.api.place(placeArgs('online'));
    const fresh = rig({ script: { paymentStatus: [PS(state, { refunded_total_cents: 100 })] }, storage: R.storage, clock: R.clock });   // the redirect = a new page
    const out = await fresh.api.handleReturn(`?pay=complete&order=${r.order_id}&t=pt_1`);
    assert.equal(out.kind, kind, `${state} ⇒ ${kind}`);
    assert.equal(!!placeRec(R.storage), kept, `${state}: pending_place ${kept ? 'KEPT' : 'cleared'}`);
  }
  const P = rig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  const r = await P.api.place(placeArgs('online'));
  const clock = { t: P.clock.t };
  const pend = rig({ script: { paymentStatus: [(c) => { clock.t += 3000; return PS('pending'); }] }, storage: P.storage, clock });
  const out = await pend.api.handleReturn(`?pay=complete&order=${r.order_id}&t=pt_1`);
  assert.deepEqual([out.kind, out.state], ['confirming', 'timeout'], 'pending past 90 s ⇒ «Estamos confirmando tu pago», NOT failure');
  assert.ok(placeRec(P.storage), 'the poll timeout never clears');
  const c = rig({ script: { paymentStatus: [PS('pending')] }, storage: P.storage, clock: P.clock });
  assert.equal((await c.api.handleReturn(`?pay=cancel&order=${r.order_id}&t=pt_1`)).kind, 'payment_failed', 'a genuine cancel');
  const cp = rig({ script: { paymentStatus: [PS('paid')] }, storage: P.storage, clock: P.clock });
  assert.equal((await cp.api.handleReturn(`?pay=cancel&order=${r.order_id}&t=pt_1`)).kind, 'placed', 'a PAID order landing on cancel is placed');
});

test('the hard expiry on a frozen clock: closing wins; hours unreadable ⇒ 12 h; then the next send carries a NEW id', async () => {
  const H = Array.from({ length: 7 }, () => [11, 0, 22, 0]);
  const R = rig({ script: { createOrder: ['network'] }, hours: H, clock: { t: at(20) } });
  const a = await R.api.place(placeArgs('cash'));
  R.clock.t = at(21, 59, 59);
  assert.equal(R.reload().readPlace().order_id, a.order_id, 'still locked at 21:59:59');
  R.clock.t = at(22, 0, 0);
  assert.equal(R.reload().readPlace(), null, 'cleared at 22:00 (closing wins over ts + 12 h)');
  const n = rig({ script: { createOrder: [OK_CASH] }, storage: R.storage, clock: R.clock, hours: H });
  await n.api.place(placeArgs('cash'));
  assert.notEqual(n.srv.of('createOrder')[0].body.order_id, a.order_id, 'after the expiry: a NEW order_id');
  const U = rig({ script: { createOrder: ['network'] }, hours: null, clock: { t: at(9) } });
  const u = await U.api.place(placeArgs('cash'));
  U.clock.t = at(20, 59, 59); assert.equal(U.reload().readPlace().order_id, u.order_id, 'unreadable hours: locked before 21:00');
  U.clock.t = at(21); assert.equal(U.reload().readPlace(), null, 'unreadable hours: cleared at 21:00 (12 h)');
});

test('a late retry spans the old expiry: placed 18:00, closing 21:00, «Reintentar» at 20:59 ⇒ the same id at 21:01, new at 21:59 (r4)', async () => {
  const H = Array.from({ length: 7 }, () => [11, 0, 21, 0]);
  const R = rig({ script: { createOrder: ['network'] }, hours: H, clock: { t: at(18) } });
  const a = await R.api.place(placeArgs('cash'));
  R.clock.t = at(20, 59);
  const retry = rig({ script: { createOrder: ['network'] }, storage: R.storage, clock: R.clock, hours: H });
  const r = await retry.api.place(placeArgs('cash'));
  assert.equal(r.order_id, a.order_id, 'the retry before closing is the same id');
  R.clock.t = at(21, 1);
  assert.equal((R.reload().readPlace() || {}).order_id, a.order_id, '🔴 21:01: last_send + 60 governs — STILL the same id (the 20:59 send may still land)');
  R.clock.t = at(21, 59);
  assert.equal(R.reload().readPlace(), null, '21:59: cleared');
});

test('newer quote wins; refusals map to the gates (out-of-zone / pin / try again / generic)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const storage = memStorage();
  const calls = [];
  const fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(b); if (b.tip_cents === 2000) await gate; return { status: 200, ok: true, json: async () => ({ ok: true, total_cents: 25000, net_total_cents: b.tip_cents === 2000 ? 31500 : 33500, quote_token: `tok_${b.tip_cents}` }) }; };
  const api = A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'k', endpoints: E, hours: OPEN_ALL }, fetch, storage, sleep: async () => {}, setInterval: () => 0, clearInterval: () => {} });
  const f1 = flowOf(); const p1 = api.quote(f1, CTX);
  const f2 = flowOf(); C.chooseTip(f2, 40); const r2 = await api.quote(f2, CTX);
  release(); const r1 = await p1;
  assert.deepEqual([r1.kind, r2.kind, api.latestQuote().resp.net_total_cents], ['superseded', 'ok', 33500], '🔴 an older response never overwrites a newer one');
  assert.ok(calls.every((b) => b.entry_mode === 'app'), 'entry_mode on every quote');
  const map = async (resp) => A.createApi({ config: { restaurantId: 'rid_a', endpoints: E }, fetch: async () => ({ status: resp.status, ok: false, json: async () => resp.json }), storage, sleep: async () => {}, setInterval: () => 0, clearInterval: () => {} }).quote(flowOf(), CTX);
  assert.equal((await map({ status: 200, json: { ok: false, error: 'outside_delivery_bands' } })).kind, 'out_of_zone');
  assert.equal((await map({ status: 200, json: { ok: false, error: 'pin_required' } })).kind, 'pin');
  assert.equal((await map({ status: 503, json: { ok: false, error: 'delivery_pricing_unavailable' } })).kind, 'try_again');
  assert.equal((await map({ status: 429, json: { ok: false, error: 'rate_limited' } })).kind, 'try_again');
  assert.equal((await map({ status: 200, json: { ok: false, error: 'delivery_pricing_invalid' } })).kind, 'refused');
  assert.equal((await map({ status: 400, json: { ok: false, error: 'tip_invalid' } })).kind, 'refused');
});

test('order refusals: both closure refusals ⇒ G0; the radius 400 ⇒ out-of-zone; price_increased ⇒ the sheet, agreed ⇒ the SAME id stands behind the new ceiling', async () => {
  for (const json of [{ error: 'Restaurant closed', detail: 'Not accepting orders right now' }, { error: 'Bad Request', detail: 'Cerrado — programá tu pedido' }]) {
    const R = rig({ script: { createOrder: [{ status: 400, json }] } });
    assert.equal((await R.api.place(placeArgs('cash'))).kind, 'closed', json.error);
  }
  const Z = rig({ script: { createOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'Outside delivery zone (9.0km from restaurant, max 8km)' } }] } });
  assert.equal((await Z.api.place(placeArgs('cash'))).kind, 'out_of_zone');
  const seen = [];
  const P = rig({ script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 32500 } }, OK_CASH] } });
  const out = await P.api.place(placeArgs('cash', async (o) => { seen.push(o); return true; }));
  const [a, b] = P.srv.of('createOrder').map((c) => c.body);
  assert.deepEqual([out.kind, seen[0], a.order_id === b.order_id, b.expected_net_cents, 'quote_token' in b], ['placed', { oldCents: 31500, newCents: 32500 }, true, 32500, false]);
  const D = rig({ script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 32500 } }] } });
  assert.equal((await D.api.place(placeArgs('cash', async () => false))).kind, 'price_declined');
  assert.ok(placeRec(D.storage), 'declined: the identity is kept');
  const S = rig({ script: { createOrder: [{ status: 409, json: { error: 'quote_invalid' } }, OK_CASH] } });
  assert.equal((await S.api.place(placeArgs('cash'))).kind, 'placed', 'quote_invalid: recovered silently, one attempt');
});

test('the expiry with a frozen clock that replaces the WHOLE Date on the page global (no injected now): the default path', async () => {
  const vm = await import('node:vm');
  const { webcrypto } = await import('node:crypto');
  let FROZEN = at(20);
  const Real = Date;
  class FrozenDate extends Real { constructor(...a) { if (a.length === 0) super(FROZEN); else super(...a); } static now() { return FROZEN; } }
  const ctx = { Date: FrozenDate, URLSearchParams, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, console, JSON, Math, Promise, Uint8Array };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['capp-checkout.js', 'capp-confirm-quote.js', 'capp-api.js']) vm.runInContext(readFileSync(join(ROOT, 'customer-app', f), 'utf8'), ctx, { filename: f });
  const storage = memStorage();
  const srv = server({ createOrder: ['network'] }, storage);
  const mk = () => ctx.CappApi.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'k', endpoints: E, hours: Array.from({ length: 7 }, () => [11, 0, 22, 0]) },
    fetch: srv.fetch, storage, sleep: async () => {} });   // NO now: the page's own Date
  const a = await mk().place(placeArgs('cash'));
  assert.match(a.order_id, /^TA261026-200000-[0-9A-Z]{8}$/, 'the id is minted on the frozen instant (argument-less new Date())');
  FROZEN = at(21, 59, 59); assert.equal((mk().readPlace() || {}).order_id, a.order_id, 'still locked at 21:59:59 (Date.now() frozen)');
  FROZEN = at(22); assert.equal(mk().readPlace(), null, 'cleared at 22:00 — closing wins');
});

test('the identity endpoints are reached ONLY through the injected SherpaClient.fetch (no direct fetch); no brand literal', () => {
  const WRAPPER = "function sherpaFetch(u, o){ var S = root && root.SherpaClient; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }";
  const raw = readFileSync(join(ROOT, 'customer-app/capp-api.js'), 'utf8');
  assert.equal(raw.split(WRAPPER).length - 1, 1, 'the forms\' canonical sherpaFetch wrapper, exactly once');
  const src = raw.replace(WRAPPER, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(src.match(/(^|[^.\w])fetch\s*\(|window\.fetch|globalThis\.fetch|XMLHttpRequest/g), null, '🔴 a direct fetch in capp-api.js outside the wrapper\'s dead fallback');
  assert.match(src, /const sfetch = o\.fetch \|\| sherpaFetch;/, 'the default transport is the wrapper');
  assert.equal(src.match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});

test('in the app page the default transport routes through SherpaClient.fetch — the wrapper\'s fallback is never the live path', async () => {
  const vm = await import('node:vm');
  const { webcrypto } = await import('node:crypto');
  const html = readFileSync(join(ROOT, 'customer-app/index.html'), 'utf8');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('sherpa-client.js') !== -1 && order.indexOf('sherpa-client.js') < order.indexOf('capp-api.js'), 'the page loads sherpa-client.js before capp-api.js');
  const storage = memStorage();
  const srv = server({ createOrder: [OK_CASH] }, storage);
  const via = [];
  const ctx = { Date, URLSearchParams, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, console, JSON, Math, Promise, Uint8Array,
    fetch: () => { throw new Error('🔴 the bare fetch fallback was taken'); },
    SherpaClient: { fetch: (u, i) => { via.push(u); return srv.fetch(u, i); } } };
  ctx.self = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['capp-checkout.js', 'capp-confirm-quote.js', 'capp-api.js']) vm.runInContext(readFileSync(join(ROOT, 'customer-app', f), 'utf8'), ctx, { filename: f });
  const api = ctx.CappApi.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'k', endpoints: E, hours: null }, storage, sleep: async () => {} });   // NO injected fetch
  const out = await api.place(placeArgs('cash'));
  assert.equal(out.kind, 'placed', `🔴 the default transport must reach SherpaClient.fetch (${JSON.stringify(out)})`);
  assert.deepEqual(via, [E.createOrder], '🔴 the createOrder send went through SherpaClient.fetch');
});

// ── S2a r2 (Codex FULL r1, advisor rulings 2026-10-26) ──
const IP = { status: 202, json: { ok: true, status: 'in_progress' } };
const argsWith = (o) => ({ ...placeArgs('online'), ...o });

test('r2 P1 #1: a CHANGED issued card placement is resolved first; still live ⇒ RESUMED through the stored URL with the ORIGINAL economics, nothing re-sent', async () => {
  for (const [what, change] of [['pin', { sig: 'sig_pin2' }], ['mode', { sig: 'sig_pickup' }], ['delivery price / promo', { expectedNetCents: 28000 }]]) {
    const R = rig({ script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: [PS('pending')] } });
    const first = await R.api.place(argsWith({ totals: { total: 31500, envio: 5000 } }));
    assert.equal(first.kind, 'redirect');
    const stashBefore = R.storage.getItem('ta_pending_pay');
    R.clock.t += 10 * 60 * 1000;
    const out = await R.reload().place(argsWith({ ...change, totals: { total: 28000, envio: 1500 } }));
    assert.deepEqual([out.kind, out.order_id, out.url, out.resumed], ['redirect', first.order_id, 'https://pay.test/1', true], `🔴 ${what}: the SAME live checkout, resumed (${JSON.stringify(out)})`);
    assert.deepEqual([out.expected_net_cents, out.totals], [31500, { total: 31500, envio: 5000 }], `🔴 ${what}: the ORIGINAL economics, never the new quote`);
    assert.deepEqual([R.srv.of('chargeOnlineOrder').length, R.srv.of('paymentStatus').length], [1, 1], `🔴 ${what}: one poll, ZERO re-sends`);
    assert.equal(R.storage.getItem('ta_pending_pay'), stashBefore, `${what}: the stash is untouched (never overwritten with the new cart)`);
  }
  // the stored URL past its hosted window ⇒ the recovery sheet (never a re-send that could mint at the old pin)
  const X = rig({ script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: [PS('pending')] } });
  const x1 = await X.api.place(placeArgs('online'));
  X.clock.t += A.HOSTED_CHECKOUT_MS;
  const x2 = await X.reload().place(argsWith({ sig: 'sig_pin2' }));
  assert.deepEqual([x2.kind, x2.order_id, X.srv.of('chargeOnlineOrder').length], ['existing_order', x1.order_id, 1], '🔴 an expired stored checkout ⇒ the sheet, zero re-sends');
  // the resolution's other states
  for (const [state, kind, sends] of [['paid', 'placed', 1], ['verifying', 'confirming', 1], ['scheduled_review', 'confirming', 1], ['cancelled', 'redirect', 2]]) {
    const S = rig({ script: { chargeOnlineOrder: [CHECKOUT, { status: 200, json: { checkout_url: 'https://pay.test/2', poll_token: 'pt_2' } }], paymentStatus: [PS(state)] } });
    const s1 = await S.api.place(placeArgs('online'));
    const s2 = await S.reload().place(argsWith({ sig: 'sig_pin2' }));
    assert.equal(s2.kind, kind, `${state} ⇒ ${kind}`);
    assert.equal(S.srv.of('chargeOnlineOrder').length, sends, `${state}: ${sends - 1} new charge(s)`);
    if (state === 'paid') assert.equal(s2.order_id, s1.order_id, 'paid ⇒ placed for THAT order');
    if (state === 'cancelled') assert.notEqual(s2.order_id, s1.order_id, 'cancelled ⇒ cleared ⇒ the changed cart mints a NEW id');
  }
  // no creds / a rejected token ⇒ the sheet, zero sends
  for (const [what, mut, ps] of [['no creds', (st) => st.removeItem('ta_pending_pay'), []], ['a 403', () => {}, [{ status: 403, json: {} }]]]) {
    const N = rig({ script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: ps } });
    const n1 = await N.api.place(placeArgs('online'));
    mut(N.storage);
    const n2 = await N.reload().place(argsWith({ sig: 'sig_pin2' }));
    assert.deepEqual([n2.kind, n2.order_id, N.srv.of('chargeOnlineOrder').length], ['existing_order', n1.order_id, 1], `🔴 ${what} ⇒ the recovery sheet, zero re-sends`);
  }
  // an UN-issued identity (refused before any write) with a changed pin ⇒ the same id, the NEW body (server-authoritative)
  const U = rig({ script: { chargeOnlineOrder: [{ status: 400, json: { error: 'Bad Request', detail: 'Outside delivery zone (9 km)' } }, CHECKOUT] } });
  const u1 = await U.api.place(placeArgs('online'));
  const u2 = await U.api.place(argsWith({ sig: 'sig_pin2' }));
  assert.deepEqual([u1.kind, u2.kind, u2.order_id, U.srv.of('paymentStatus').length], ['out_of_zone', 'redirect', u1.order_id, 0], 'un-issued: no resolve-first');
  assert.equal(placeRec(U.storage).body_sig, 'sig_pin2', 'the un-issued record carries the economics actually sent');
  // a cash ↔ card switch never strips the issued card record's identity
  const W = rig({ script: { chargeOnlineOrder: [CHECKOUT], createOrder: [{ status: 409, json: { error: 'order_exists', reason: 'method' } }], paymentStatus: [PS('pending')] } });
  await W.api.place(placeArgs('online'));
  await W.api.place(placeArgs('cash'));
  assert.deepEqual([placeRec(W.storage).method, placeRec(W.storage).issued], ['online', true], 'the issued record keeps its method across a cash attempt');
  const w3 = await W.api.place(argsWith({ sig: 'sig_pin2' }));
  assert.equal(w3.resumed, true, 'back to card with a changed cart ⇒ still resolved first');
});

test('r2 P1 #2: clearing is CONDITIONAL on the resolved order — an old return / a delayed response never deletes a newer placement', async () => {
  // order A paid; B unresolved; A's valid return URL reopened ⇒ B kept, and B's retry keeps B's id
  const R = rig({ script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: [PS('paid')] } });
  const a = await R.api.place(placeArgs('online'));
  await R.reload().handleReturn(`?pay=complete&order=${a.order_id}&t=pt_1`);
  const B = rig({ script: { createOrder: ['network', OK_CASH] }, storage: R.storage, clock: R.clock });
  const b = await B.api.place(placeArgs('cash'));
  assert.equal(b.kind, 'offline');
  R.storage.setItem('ta_pending_pay', JSON.stringify({ order_id: a.order_id, t: 'pt_1', order: {}, form: null, ts: 1 }));
  const old = rig({ script: { paymentStatus: [PS('paid')] }, storage: R.storage, clock: R.clock });
  assert.equal((await old.api.handleReturn(`?pay=complete&order=${a.order_id}&t=pt_1`)).kind, 'placed');
  assert.equal((placeRec(R.storage) || {}).order_id, b.order_id, '🔴 A\'s old return left B\'s record');
  for (const [state] of [['closed_refunded'], ['cancelled'], ['failed']]) {
    const o2 = rig({ script: { paymentStatus: [PS(state)] }, storage: R.storage, clock: R.clock });
    await o2.api.handleReturn(`?pay=complete&order=${a.order_id}&t=pt_1`);
    assert.equal((placeRec(R.storage) || {}).order_id, b.order_id, `🔴 an old ${state} return left B`);
  }
  const b2 = await B.reload().place(placeArgs('cash'));
  assert.equal(B.srv.of('createOrder')[1].body.order_id, b.order_id, '🔴 B\'s retry keeps B\'s id (no mint)');
  assert.equal(b2.kind, 'placed');
  // a delayed cash 200 for A arriving after A expired and B was minted ⇒ B kept
  let land; const held = new Promise((r) => { land = r; });
  const D = rig({ script: { createOrder: [() => held] } });   // the response lands later
  const pa = D.api.place(placeArgs('cash'));
  await new Promise((r) => setImmediate(r));
  const aId = placeRec(D.storage).order_id;
  D.clock.t += 13 * 60 * 60 * 1000;                     // A's record expires while its response is in flight
  const N = rig({ script: { createOrder: ['network'] }, storage: D.storage, clock: D.clock });
  const bn = await N.api.place(placeArgs('cash'));
  assert.notEqual(bn.order_id, aId, 'premise: B minted after A expired');
  land({ status: 200, json: { ok: true, order_id: aId, tracking_token: 'tt' } });
  const late = await pa;
  assert.deepEqual([late.kind, late.order_id], ['placed', aId], 'A resolves as placed');
  assert.equal((placeRec(D.storage) || {}).order_id, bn.order_id, '🔴 A\'s delayed 200 did not delete B');
});

test('r2 P1 #3: EVERY send is gated by a confirmed write of THAT identity — suspension across expiry or a replaced record STOPS the send', async () => {
  // a 202, then the tab is suspended past the expiry during the backoff ⇒ no further send; recovery
  const clock = { t: at(12) };
  const storage = memStorage();
  const srv = server({ chargeOnlineOrder: [IP, CHECKOUT] }, storage);
  const api = A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL },
    fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => { clock.t += 13 * 60 * 60 * 1000; }, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256),
    setInterval: () => 0, clearInterval: () => {} });
  const out = await api.place(placeArgs('online'));
  assert.equal(srv.of('chargeOnlineOrder').length, 1, '🔴 the expired identity is NOT re-sent');
  assert.equal(out.kind, 'existing_order', `recovery, not a send (${JSON.stringify(out)})`);
  assert.equal(placeRec(storage), null, 'and nothing re-created the record');
  // replaced during the backoff (another tab minted a different identity) ⇒ STOP
  const s2 = memStorage(); let other = null;
  const srv2 = server({ chargeOnlineOrder: [IP, CHECKOUT] }, s2);
  const api2 = A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL },
    fetch: srv2.fetch, storage: s2, now: () => clock.t, sleep: async () => { const r = placeRec(s2); s2.setItem('capp:rid_a:pending_place', JSON.stringify({ ...r, order_id: 'TA-OTHER', last_send: 1 })); other = s2.getItem('capp:rid_a:pending_place'); },
    randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} });
  const o2 = await api2.place(placeArgs('online'));
  assert.equal(srv2.of('chargeOnlineOrder').length, 1, '🔴 a replaced record ⇒ the re-send is stopped');
  assert.equal(s2.getItem('capp:rid_a:pending_place'), other, '🔴 the newer record is untouched (byte-identical)');
  assert.equal(o2.kind, 'existing_order');
});

test('r2 P1 #4: NO automatic retry on a money write — an ambiguous card result is recovery, never a re-send; cash re-sends only on «Reintentar»', async () => {
  for (const [what, resp] of [['network (browser-response loss)', 'network'], ['502 (provider-response loss)', { status: 502, json: { error: 'Payment gateway error' } }], ['503', { status: 503, json: { error: 'Could not start payment' } }]]) {
    const R = rig({ script: { chargeOnlineOrder: [resp, CHECKOUT] } });
    const a = await R.api.place(placeArgs('online'));
    assert.deepEqual([a.kind, R.srv.of('chargeOnlineOrder').length], ['existing_order', 1], `🔴 ${what}: ONE send, the recovery sheet`);
    assert.deepEqual([placeRec(R.storage).unresolved, placeRec(R.storage).order_id], [true, a.order_id], `${what}: the placement is AMBIGUOUS (unresolved)`);
    const b = await R.reload().place(placeArgs('online'));
    assert.deepEqual([b.kind, b.order_id, R.srv.of('chargeOnlineOrder').length], ['existing_order', a.order_id, 1], `🔴 ${what}: a later card tap never re-sends`);
  }
  // a 202 re-send that comes back ambiguous ⇒ AMBIGUOUS at once, no further sends
  const P = rig({ script: { chargeOnlineOrder: [IP, 'network', CHECKOUT] } });
  const p = await P.api.place(placeArgs('online'));
  assert.deepEqual([p.kind, P.srv.of('chargeOnlineOrder').length, placeRec(P.storage).unresolved], ['existing_order', 2, true], '🔴 a 202 then an ambiguous re-send ⇒ stop');
  // creds from an earlier issuance ⇒ the recovery is ONE poll
  const K = rig({ script: { chargeOnlineOrder: [CHECKOUT, 'network'], paymentStatus: [PS('pending')] } });
  await K.api.place(placeArgs('online'));
  const k = await K.api.place(placeArgs('online'));
  // S2b r2 (advisor-approved): poll FIRST — still pending ⇒ resume ITS stored checkout (inside the window); no second charge
  assert.deepEqual([k.kind, K.srv.of('chargeOnlineOrder').length, K.srv.of('paymentStatus').length], ['redirect', 1, 1], 'with creds: one poll, no further send');
  // 500 'Payment not configured' is definitive, not ambiguous
  const NC = rig({ script: { chargeOnlineOrder: [{ status: 500, json: { error: 'Payment not configured' } }] } });
  assert.equal((await NC.api.place(placeArgs('online'))).kind, 'payment_not_completed');
  assert.equal(placeRec(NC.storage).unresolved, false, 'a definitive answer settles the send');
  // cash: one send per tap; a 5xx ⇒ offline; «Reintentar» re-sends the SAME id
  const CS = rig({ script: { createOrder: [{ status: 503, json: {} }, OK_CASH] } });
  const c1 = await CS.api.place(placeArgs('cash'));
  assert.deepEqual([c1.kind, CS.srv.of('createOrder').length], ['offline', 1], '🔴 a cash 5xx is not auto-retried');
  const c2 = await CS.api.place(placeArgs('cash'));
  assert.deepEqual([c2.kind, CS.srv.of('createOrder')[1].body.order_id], ['placed', c1.order_id], '«Reintentar» re-sends the SAME id');
  // quotes (read-only) still retry
  const Q = rig({ script: { quoteOrder: ['network', { status: 200, json: { ok: true, total_cents: 25000, net_total_cents: 25000 } }] } });
  assert.equal((await Q.api.quote(flowOf('cash'), CTX)).kind, 'ok', 'the quote retries');
  assert.equal(Q.srv.of('quoteOrder').length, 2);
});

test('r2 P2 #5: a CANCEL return applies the authoritative poll state — verifying / scheduled_review are kept; cancelled / failed clear', async () => {
  for (const [state, kind, kept] of [['verifying', 'confirming', true], ['scheduled_review', 'confirming', true], ['cancelled', 'payment_failed', false], ['failed', 'payment_failed', false], ['pending', 'payment_failed', true], ['closed_refunded', 'refunded', false]]) {
    const R = rig({ script: { chargeOnlineOrder: [CHECKOUT] } });
    const r = await R.api.place(placeArgs('online'));
    const back = rig({ script: { paymentStatus: [PS(state)] }, storage: R.storage, clock: R.clock });
    const out = await back.api.handleReturn(`?pay=cancel&order=${r.order_id}&t=pt_1`);
    assert.equal(out.kind, kind, `cancel + ${state} ⇒ ${kind}`);
    if (kind === 'confirming') assert.equal(out.state, state, `${state} preserved`);
    assert.equal(!!placeRec(R.storage), kept, `cancel + ${state}: pending_place ${kept ? 'KEPT' : 'cleared'}`);
  }
});

test('r2 P2 #6: a 426 on the FIRST send of a just-minted identity clears it (self-update can reload); an unresolved EARLIER send keeps blocking', async () => {
  const U = { status: 426, json: { error: 'client_update_required' } };
  for (const pay of ['cash', 'online']) {
    const R = rig({ script: { createOrder: [U], chargeOnlineOrder: [U] } });
    const out = await R.api.place(placeArgs(pay));
    assert.equal(out.kind, 'update_required');
    assert.equal(placeRec(R.storage), null, `🔴 ${pay}: the refused first send leaves no record`);
  }
  const K = rig({ script: { createOrder: ['network', U] } });
  const k1 = await K.api.place(placeArgs('cash'));
  const k2 = await K.reload().place(placeArgs('cash'));
  assert.deepEqual([k2.update_required, k2.order_id], [true, k1.order_id], 'a 426 on a SECOND dispatch ⇒ recovery for the kept identity');
  assert.equal((placeRec(K.storage) || {}).order_id, k1.order_id, '🔴 an unresolved EARLIER send keeps its record (it may have landed)');
  // the adapter: no record ⇒ the 426 transition may reload
  const SU = require('./capp-self-update.js');
  const R2 = rig({ script: { createOrder: [U] } });
  await R2.api.place(placeArgs('cash'));
  const ad = SU.createAdapter({ state: () => ({ screen: 'checkout', placing: false, sheetOpen: false }), unresolved: () => !!R2.api.readPlace(), search: () => '' });
  assert.equal(ad.canReload({ mode: 'checkout' }), true, 'canReload after a refused first placement');
});

// ── S2a r3 (Codex scoped r2, the advisor's DISPATCH RULE) ──
test('r3 rule (i): the send is recorded UNRESOLVED before it leaves — a reload mid-flight, or storage failing when the 502 lands, never re-charges', async () => {
  // reload mid-flight: the first charge is still in the air; the reloaded page's card tap must not send
  let land; const held = new Promise((r) => { land = r; });
  const R = rig({ script: { chargeOnlineOrder: [() => held, CHECKOUT] } });
  const first = R.api.place(placeArgs('online'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([placeRec(R.storage).unresolved, placeRec(R.storage).dispatched, placeRec(R.storage).card], [true, 1, true], '🔴 the in-flight send is on record (unresolved, dispatched 1, card)');
  const mid = await R.reload().place(placeArgs('online'));
  assert.deepEqual([mid.kind, R.srv.of('chargeOnlineOrder').length], ['existing_order', 1], '🔴 a reload mid-flight never re-charges the identity');
  land({ status: 502, json: { error: 'Payment gateway error' } });
  await first;
  // storage fails exactly when the 502 lands (no post-response write can succeed) ⇒ the pre-send record already says unresolved
  const S = rig({ script: { chargeOnlineOrder: [() => { S.storage.failWrites = true; return { status: 502, json: { error: 'Payment gateway error' } }; }, CHECKOUT] } });
  const s1 = await S.api.place(placeArgs('online'));
  S.storage.failWrites = false;
  const s2 = await S.reload().place(placeArgs('online'));
  assert.deepEqual([s2.kind, s2.order_id, S.srv.of('chargeOnlineOrder').length], ['existing_order', s1.order_id, 1], '🔴 storage failing at the 502 ⇒ still ONE charge');
  // the pre-send write fails ⇒ no send at all
  const W = rig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  let n = 0; const real = W.storage.setItem; W.storage.setItem = (k, v) => { if (k.endsWith(':pending_place') && ++n === 2) throw new Error('quota'); real(k, v); };
  assert.deepEqual([(await W.api.place(placeArgs('online'))).kind, W.srv.calls.length], ['stash_failed', 0], 'a failed dispatch write ⇒ no send');
});

test('r3 rule (ii): only a FULLY parsed definitive answer settles a send — a 200 with an unreadable body or missing fields is unresolved, never re-sent, the economics never overwritten', async () => {
  for (const [what, resp] of [['an unreadable 200 body', { status: 200, badBody: true, json: null }], ['a 200 without its poll token', { status: 200, json: { checkout_url: 'https://pay.test/1' } }], ['a 202 with an unreadable body', { status: 202, badBody: true, json: null }]]) {
    const R = rig({ script: { chargeOnlineOrder: [resp, CHECKOUT] } });
    const a = await R.api.place(argsWith({ expectedNetCents: 32000 }));
    assert.deepEqual([a.kind, R.srv.of('chargeOnlineOrder').length, placeRec(R.storage).unresolved], ['existing_order', 1, true], `🔴 ${what} ⇒ unresolved, the recovery sheet`);
    const b = await R.reload().place(argsWith({ expectedNetCents: 28000, sig: 'sig_pin2' }));
    assert.deepEqual([b.kind, R.srv.of('chargeOnlineOrder').length], ['existing_order', 1], `🔴 ${what}: the changed cart is NOT re-sent (no L280 → L320 divergence)`);
    assert.equal(placeRec(R.storage).expected_net_cents, 32000, `${what}: the stored economics are not overwritten`);
  }
  // cash: an unreadable 200 ⇒ offline; «Reintentar» re-sends the SAME id (idempotent)
  const C2 = rig({ script: { createOrder: [{ status: 200, badBody: true, json: null }, OK_CASH] } });
  const c1 = await C2.api.place(placeArgs('cash'));
  const c2 = await C2.api.place(placeArgs('cash'));
  assert.deepEqual([c1.kind, c2.kind, C2.srv.of('createOrder')[1].body.order_id], ['offline', 'placed', c1.order_id], 'cash: unreadable ⇒ offline, the same id on «Reintentar»');
});

test('r3 rule (iii): a 426 clears ONLY the first dispatch with no admission — a 426 after a 202 keeps the identity and goes to recovery', async () => {
  const U = { status: 426, json: { error: 'client_update_required' } };
  const R = rig({ script: { chargeOnlineOrder: [IP, U, CHECKOUT] } });
  const out = await R.api.place(placeArgs('online'));
  const rec = placeRec(R.storage);
  assert.ok(rec, '🔴 a 426 after a 202 keeps the identity (a concurrent request may be creating its checkout)');
  assert.deepEqual([rec.dispatched, rec.admitted, out.update_required, out.order_id], [2, true, true, rec.order_id], 'recovery for the kept identity, flagged for the update');
  const again = await R.reload().place(placeArgs('online'));
  assert.deepEqual([again.order_id, R.srv.of('chargeOnlineOrder').length], [rec.order_id, 2], '🔴 the updated client never mints a second identity, never re-charges');
  const F = rig({ script: { chargeOnlineOrder: [U] } });
  await F.api.place(placeArgs('online'));
  assert.equal(placeRec(F.storage), null, 'the first dispatch, no admission ⇒ cleared');
});

// ── S2a r4 (Codex scoped r3): `unresolved` and the economics belong to the CARD send ──
test('r4 (lock OFF — for the day the server exclusion lands): a cash answer never settles an unresolved card send nor overwrites its economics — back to card ⇒ still recovery, zero re-charges', async () => {
  const EXISTS = { status: 409, json: { error: 'order_exists', reason: 'method' } };
  for (const [what, first] of [['provider-loss 502', { status: 502, json: { error: 'Payment gateway error' } }], ['a lost 200 body', { status: 200, badBody: true, json: null }]]) {
    const R = rig({ script: { chargeOnlineOrder: [first, CHECKOUT], createOrder: [EXISTS] }, lock: false });
    const a = await R.api.place(argsWith({ expectedNetCents: 32000 }));
    assert.equal(placeRec(R.storage).unresolved, true, `premise (${what}): the card send is unresolved`);
    const c = await R.reload().place({ ...placeArgs('cash'), sig: 'sig_pin2', expectedNetCents: 28000 });
    assert.equal(c.order_id, a.order_id, `${what}: the cash attempt rides the same identity`);
    assert.deepEqual([placeRec(R.storage).unresolved, placeRec(R.storage).expected_net_cents, placeRec(R.storage).body_sig], [true, 32000, 'sig1'], `🔴 ${what}: the cash answer left the card send unresolved and its economics untouched`);
    const b = await R.reload().place(argsWith({ sig: 'sig_pin2', expectedNetCents: 28000 }));
    assert.deepEqual([b.kind, R.srv.of('chargeOnlineOrder').length], ['existing_order', 1], `🔴 ${what}: back to card ⇒ recovery, ONE gateway attempt`);
  }
});

test('r4: the policy LOCK_INTERRUPTED_CARD — ON (shipped) ⇒ an interrupted card order refuses cash too (recovery only); off ⇒ cash is sent', async () => {
  assert.equal(readFileSync(join(ROOT, 'customer-app/capp-api.js'), 'utf8').match(/const LOCK_INTERRUPTED_CARD = (true|false);/)[1], 'true', '🔴 the shipped policy: the lock is ON (advisor ruling, Codex r4)');
  assert.equal(A.LOCK_INTERRUPTED_CARD, true);
  const mk = (lock) => {
    const storage = memStorage(); const clock = { t: at(12) };
    const srv = server({ chargeOnlineOrder: ['network'], createOrder: [OK_CASH] }, storage);
    const api = A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL },
      fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256),
      setInterval: () => 0, clearInterval: () => {}, lockInterruptedCard: lock });
    return { api, srv };
  };
  const L = mk(true);
  const l1 = await L.api.place(placeArgs('online'));
  const l2 = await L.api.place(placeArgs('cash'));
  assert.deepEqual([l2.kind, l2.order_id, L.srv.of('createOrder').length], ['existing_order', l1.order_id, 0], '🔴 lock on: the interrupted card order refuses cash (recovery only)');
  const O = mk(false);
  await O.api.place(placeArgs('online'));
  const o2 = await O.api.place(placeArgs('cash'));
  assert.deepEqual([o2.kind, O.srv.of('createOrder').length], ['placed', 1], 'lock off: cash is sent (the server decides)');
});

// ── PLAN-capp-signin-required r5.4 / Codex guest r1 #1 + #5: the guest rules hold at EVERY dispatch; existing payments resolve first ──
function grig({ script, storage = memStorage(), member = { cur: null }, clock = { t: at(12) }, sleep = async () => {} } = {}) {
  const srv = server(script, storage);
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: { ...E, verifyCheckoutCode: EV }, hours: OPEN_ALL, guestCardOnly: true },
    member: () => member.cur, fetch: srv.fetch, storage, now: () => clock.t, sleep, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} });
  return { api: make(), reload: make, srv, storage, member };
}
// a ticket from the REAL writer: the id place() will send (orderIdForCode) → verifyCheckoutCode (contract amendment 2026-10-27)
const EV = 'https://fn.test/verifyCheckoutCode';
async function ticketFor(R, args) {
  const orderId = R.api.orderIdForCode(args);
  R.srv.script.verifyCheckoutCode = [{ status: 200, json: { ok: true, checkout_ticket: 'tk_1' } }];
  const v = await R.api.verifyCheckoutCode({ phone: '+50499990000', cartFp: 'sig1', code: '123456', orderId });
  assert.equal(v.ok, true, 'premise: verified'); return v.ticket;
}
const MEMBER = { uid: 'u1', idToken: 'tok' };
test('Codex guest r1 #1: a member signs out while confirming a price increase ⇒ the resend is REFUSED (no ticketless / tokenless cash, no ticketless card)', async () => {
  const m = { cur: MEMBER };
  const R = grig({ member: m, script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 32500 } }, OK_CASH] } });
  const out = await R.api.place(placeArgs('cash', async () => { m.cur = null; return true; }));
  assert.deepEqual([out.kind, R.srv.of('createOrder').length], ['guest_cash_not_allowed', 1], '🔴 the resend re-checks identity + tender: no cash for the now-guest');
  const m2 = { cur: MEMBER };
  const O = grig({ member: m2, script: { chargeOnlineOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 32500 } }, CHECKOUT] } });
  const out2 = await O.api.place(placeArgs('online', async () => { m2.cur = null; return true; }));
  assert.deepEqual([out2.kind, O.srv.of('chargeOnlineOrder').length], ['guest_ticket_invalid', 1], '🔴 the resend re-checks the ticket: no ticketless card for the now-guest');
});
test('Codex guest r1 #5: a guest whose card checkout was already ISSUED resolves it first (a status poll / resume) — no ticket needed to recover, no new send', async () => {
  const storage = memStorage();
  const R = grig({ storage, script: { chargeOnlineOrder: [CHECKOUT], paymentStatus: [PS('pending')] } });
  const a1 = placeArgs('online');
  const first = await R.api.place({ ...a1, checkoutTicket: await ticketFor(R, a1) });
  assert.equal(first.kind, 'redirect', 'premise: issued');
  const again = await R.reload().place(placeArgs('online'));   // the in-memory ticket is gone (a reload)
  assert.notEqual(again.kind, 'guest_ticket_invalid', '🔴 recovery never requires a ticket');
  assert.ok(R.srv.of('paymentStatus').length >= 1, 'the existing payment was read'); assert.equal(R.srv.of('chargeOnlineOrder').length, 1, 'never charged again');
  assert.deepEqual([again.kind, again.resumed], ['redirect', true], 'back to ITS checkout');
});

test('Codex guest r2 #1: sendCard\'s in-progress RE-SENDS pass the guest gate at the wire — sign-out, an expired ticket or a cash tender during the backoff ⇒ refused', async () => {
  const IP = { status: 202, json: { status: 'in_progress' } };
  const m = { cur: MEMBER };
  const A1 = grig({ member: m, sleep: async () => { m.cur = null; }, script: { chargeOnlineOrder: [IP, CHECKOUT] } });
  const o1 = await A1.api.place(placeArgs('online'));
  assert.deepEqual([o1.kind, A1.srv.of('chargeOnlineOrder').length], ['guest_ticket_invalid', 1], '🔴 202 → sign-out → the re-send is refused');
  const clock = { t: at(12) };
  let tk2 = null;
  const A2 = grig({ clock, sleep: async () => { clock.t = tk2.expires_at + 1; }, script: { chargeOnlineOrder: [IP, CHECKOUT] } });
  const a2 = placeArgs('online'); tk2 = await ticketFor(A2, a2);
  const o2 = await A2.api.place({ ...a2, checkoutTicket: tk2 });
  assert.deepEqual([o2.kind, A2.srv.of('chargeOnlineOrder').length], ['guest_ticket_invalid', 1], '🔴 the ticket expired during the backoff ⇒ refused');
  let args = null;
  const A3 = grig({ sleep: async () => { args.flow.pay = 'cash'; }, script: { chargeOnlineOrder: [IP, CHECKOUT] } });
  const a3 = placeArgs('online'); args = { ...a3, checkoutTicket: await ticketFor(A3, a3) };
  const o3 = await A3.api.place(args);
  assert.deepEqual([o3.kind, A3.srv.of('chargeOnlineOrder').length], ['guest_cash_not_allowed', 1], '🔴 the tender changed during the backoff ⇒ refused');
});

// advisor 2026-10-27: the server gates the checkout-code calls on X-Client-Deployment; SherpaClient adds the identity only on ITS
// identity endpoints (createOrder / chargeOnlineOrder / quotes), so capp-api attaches SherpaClient.headers() on these two — loaded
// the way the page loads it (a window global beside SherpaClient), never a test seam
test('identity: the checkout-code calls carry SherpaClient.headers() (X-Client-Deployment) — stamped ⇒ sent, unstamped (inert) ⇒ none', async () => {
  const vm = await import('node:vm');
  for (const [what, ident] of [['stamped', { 'X-Client-App': 'orders', 'X-Client-Deployment': 'orders-app', 'X-Client-Build': 'b1', 'X-Client-Compat': '1' }], ['inert', {}]]) {
    const sent = [];
    const SherpaClient = { headers: () => ident, fetch: async (u, i) => { sent.push({ u, h: i.headers }); return { status: 200, json: async () => (u.endsWith('/vc') ? { ok: true, checkout_ticket: 'tk' } : { ok: true, resend_in_s: 30 }) }; } };
    const win = { SherpaClient, crypto: globalThis.crypto }; win.self = win;
    vm.runInNewContext(readFileSync(join(ROOT, 'customer-app/capp-api.js'), 'utf8'), win);
    const api = win.CappApi.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: { ...E, requestCheckoutCode: 'https://fn.test/x/rc', verifyCheckoutCode: 'https://fn.test/x/vc' } },
      CappCheckout: C, createConfirmQuote: require('./capp-confirm-quote.js').createConfirmQuote, storage: null, now: () => at(12) });
    assert.equal((await api.requestCheckoutCode({ phone: '+50499990000', cartFp: 'fp' })).ok, true, `${what}: premise`);
    assert.equal((await api.verifyCheckoutCode({ phone: '+50499990000', cartFp: 'fp', code: '123456', orderId: 'TA261026-120000-AAAAAAAA' })).ok, true);
    assert.equal(sent.length, 2, 'both through SherpaClient.fetch');
    for (const s of sent) {
      for (const [k, v] of Object.entries(ident)) assert.equal(s.h[k], v, `🔴 ${what}: ${s.u} carries ${k}`);
      if (what === 'inert') assert.deepEqual(Object.keys(s.h).filter((k) => /^x-client/i.test(k)), [], 'unstamped: no identity header');
      assert.equal(s.h['Content-Type'], 'application/json');
    }
  }
});

// contract amendment 2026-10-27 (anti-spiral): verifyCheckoutCode takes the client-minted order id; the ticket is bound to it, the
// order placed with it uses THAT id (a retry keeps it), and another identity needs a new code
test('amendment: the code is verified FOR the order id place() will send — the same id on a re-verify and on the order; another identity ⇒ refused, nothing sent', async () => {
  const R = grig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  const args = placeArgs('online');
  const id = R.api.orderIdForCode(args);
  assert.equal(R.api.orderIdForCode(args), id, 'a re-verify (a retry) keeps the SAME id');
  const tk = await ticketFor(R, args);
  assert.equal(R.srv.of('verifyCheckoutCode')[0].body.order_id, id, '🔴 the verify carries the order id');
  assert.equal(tk.order_id, id, 'the ticket remembers it');
  const out = await R.api.place({ ...args, checkoutTicket: tk });
  assert.equal(out.kind, 'redirect', 'premise: sent');
  assert.equal(R.srv.of('chargeOnlineOrder')[0].body.order_id, id, '🔴 the order goes out under the id its code was verified for');
  // another identity (the record cleared and re-minted) ⇒ the gate refuses before any send
  const S = grig({ script: { chargeOnlineOrder: [CHECKOUT] } });
  const a2 = placeArgs('online'); const t2 = await ticketFor(S, a2);
  S.api.clearPlace(t2.order_id);
  const o2 = await S.api.place({ ...a2, checkoutTicket: t2 });
  assert.deepEqual([o2.kind, S.srv.of('chargeOnlineOrder').length], ['guest_ticket_invalid', 0], '🔴 a ticket for another order id is never sent');
  // Codex amendment r1 P2 — the RECOVERY: the refused attempt recorded nothing for the new identity B, so a re-verify binds to B and
  // the next place() sends exactly ONE charge, under B, with B's ticket
  const recB = placeRec(S.storage);
  assert.ok(recB && recB.order_id !== t2.order_id, 'premise: a new identity B');
  assert.deepEqual([Number(recB.dispatched) || 0, !!recB.unresolved, !!recB.card], [0, false, false], '🔴 the refused attempt left B un-dispatched (no unresolved mark)');
  const tB = await ticketFor(S, a2);
  assert.equal(tB.order_id, recB.order_id, 'the re-verify binds to B');
  const o3 = await S.api.place({ ...a2, checkoutTicket: tB });
  assert.equal(o3.kind, 'redirect', '🔴 recovered: B is sent (never stuck on existing_order)');
  assert.deepEqual(S.srv.of('chargeOnlineOrder').map((c) => [c.body.order_id, c.body.checkout_ticket]), [[recB.order_id, 'tk_1']], '🔴 exactly ONE charge, under B, with B\'s ticket');
  // no order id ⇒ nothing to bind: never sent
  const before = S.srv.calls.length;
  assert.equal((await S.api.verifyCheckoutCode({ phone: '+50499990000', cartFp: 'sig1', code: '123456' })).kind, 'offline');
  assert.equal(S.srv.calls.length, before, 'an unbound verify is never sent');
});

// G6 (advisor 2026-10-27): the member token is read AT SEND TIME through the SDK's getIdToken (cached while valid, refreshed silently
// once expired); bounded — a hang falls back to the sign-in token; a guest never asks
test('G6 member token: a token past its expiry ⇒ the send carries the REFRESHED one; a hung refresh falls back (bounded); a guest never asks', async () => {
  const mk = ({ member, timeout }) => { const storage = memStorage(); const srv = server({ createOrder: [OK_CASH] }, storage);
    const api = A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL }, member: () => member, fetch: srv.fetch, storage,
      now: () => at(12), sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256), setInterval: () => 0, clearInterval: () => {}, ...(timeout ? { timeout } : {}) });
    return { api, srv }; };
  // the SDK's own rule: the cached token while valid, a refreshed one after its 1 h life
  let clock = 0; const sdk = { getIdToken: async () => (clock < 3600e3 ? 'id:signin' : 'id:refreshed') };
  const M = { uid: 'u1', idToken: 'id:signin', getIdToken: () => sdk.getIdToken() };
  clock = 3600e3 + 1;
  const R = mk({ member: M });
  assert.equal((await R.api.place(placeArgs('cash'))).kind, 'placed', 'premise');
  assert.equal(R.srv.of('createOrder')[0].headers['x-firebase-id-token'], 'id:refreshed', '🔴 an expired sign-in token is never sent: the refreshed one is');
  let asked = 0;
  const H = mk({ member: { uid: 'u1', idToken: 'id:signin', getIdToken: () => { asked++; return new Promise(() => {}); } }, timeout: async () => {} });
  assert.equal((await H.api.place(placeArgs('cash'))).kind, 'placed', 'a hung refresh never blocks the send');
  assert.equal(H.srv.of('createOrder')[0].headers['x-firebase-id-token'], 'id:signin', 'bounded ⇒ the sign-in token as the fallback'); assert.equal(asked, 1);
  const G = mk({ member: null });
  await G.api.place(placeArgs('cash'));
  assert.equal('x-firebase-id-token' in G.srv.of('createOrder')[0].headers, false, 'a guest sends no member token');
});

// ── S4 (Codex S4 r1 #1–#3): the scheduled send under schedulingLive — the account rule at the wire, the VERIFIED replay record, the
// exact outgoing bytes replayed, a definitive answer that holds even when storage does not ──
function srig({ script, storage = memStorage(), member = { cur: MEMBER }, clock = { t: at(12) } } = {}) {
  const srv = server(script, storage);
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours: OPEN_ALL, schedulingLive: true },
    member: () => member.cur, fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} });
  return { api: make(), reload: make, srv, storage, member, clock };
}
const SLOT = at(15), SLOT2 = at(16);
const sArgs = (slot = SLOT, x = {}) => { const f = flowOf('cash'); f.time = 'schedule'; f.slot = slot; return { flow: f, ctx: { ...CTX, appCash: true }, sig: 'sig1', expectedNetCents: 31500, ...x }; };
const SLOT_REFUSED = { status: 400, json: { error: 'Bad Request', detail: 'Invalid scheduled time (closed_at_slot)' } };
const failPlaceWrites = (s, pred) => { const real = s.setItem; s.setItem = (k, v) => { if (k.endsWith(':pending_place') && pred(String(v))) throw new Error('quota'); real(k, v); }; };

test('Codex S4 r1 #1 (owner G=B): a NON-member\'s body carrying scheduled_for is never sent — refused at the wire', async () => {
  const R = srig({ member: { cur: null }, script: { createOrder: [OK_CASH], chargeOnlineOrder: [CHECKOUT] } });
  const out = await R.api.place(sArgs());
  assert.deepEqual([out.kind, R.srv.calls.length], ['schedule_needs_account', 0], '🔴 S4-acct: no scheduled send without an account');
  const card = sArgs(); card.flow.pay = 'online';
  assert.equal((await R.reload().place(card)).kind, 'schedule_needs_account'); assert.equal(R.srv.calls.length, 0, '🔴 S4-acct: nor a scheduled charge');
  const M = srig({ script: { createOrder: [OK_CASH] } });
  assert.equal((await M.api.place(sArgs())).kind, 'placed', 'premise: a member places');
});
test('Codex S4 r1 #2: the replay record (sent_body) is VERIFIED before any dispatch — a failed write sends nothing', async () => {
  const R = srig({ script: { createOrder: [OK_CASH] } });
  failPlaceWrites(R.storage, (v) => v.includes('"sent_body"'));
  const out = await R.api.place(sArgs());
  assert.deepEqual([out.kind, R.srv.of('createOrder').length], ['offline', 0], '🔴 S4-persist: an unrecorded body is never sent');
});
test('Codex S4 r1 #2: a DEFINITIVE refusal ends the replay window even when its write fails — the next send carries the new slot, never the refused one', async () => {
  const R = srig({ script: { createOrder: [SLOT_REFUSED, OK_CASH] } });
  failPlaceWrites(R.storage, (v) => v.includes('"sched_pending":false'));
  assert.equal((await R.api.place(sArgs(SLOT))).kind, 'slot_refused', 'premise: N1');
  await R.api.place(sArgs(SLOT2));
  const s = R.srv.of('createOrder');
  assert.equal(s.length, 2); assert.equal(s[0].body.order_id, s[1].body.order_id, 'the same identity');
  assert.equal(s[1].body.scheduled_for, SLOT2, '🔴 S4-settled: the refused slot is never re-sent');
});
test('Codex S4 r1 #2: the UI reads a memory-held definitive answer as the window closed (row 10 never locks a refused slot)', async () => {
  const R = srig({ script: { createOrder: [SLOT_REFUSED] } });
  failPlaceWrites(R.storage, (v) => v.includes('"sched_pending":false'));
  assert.equal((await R.api.place(sArgs(SLOT))).kind, 'slot_refused', 'premise: N1');
  assert.equal(JSON.parse(R.storage.getItem('capp:rid_a:pending_place')).sched_pending, true, 'premise: the write failed');
  assert.equal(R.api.readPlace().sched_pending, false, 'the UI sees the window closed (no row 10 lock)');
});
test('Codex S4 r1 #3: an uncertain send replays the EXACT outgoing bytes (its quote token and ceiling) — a refreshed quote never rides it', async () => {
  let tok = 0;
  const QT = () => ({ status: 200, json: { ok: true, total_cents: 25000, net_total_cents: 31500 + tok * 1000, quote_token: `tok_${++tok}` } });
  const R = srig({ script: { quoteOrder: [QT], createOrder: ['network', OK_CASH] } });
  const a = sArgs(); const q1 = await R.api.quote(a.flow, a.ctx);
  assert.equal(q1.kind, 'ok', 'premise: quoted');
  assert.equal((await R.api.place({ ...a, sig: q1.record.sig, expectedNetCents: 31500 })).kind, 'offline', 'premise: the response lost');
  const first = R.srv.of('createOrder')[0].body;
  assert.equal(first.quote_token, 'tok_1', 'premise: the first send was signed');
  const api2 = R.reload(); const b = sArgs(SLOT2); const q2 = await api2.quote(b.flow, b.ctx);   // a refreshed quote (token B, another net) and an edited slot
  await api2.place({ ...b, sig: q2.record.sig, expectedNetCents: 32500 });
  assert.deepEqual(R.srv.of('createOrder')[1].body, first, '🔴 S4-bytes: the same token, ceiling and slot');
});
