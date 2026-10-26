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
    const key = Object.keys(E).find((k) => url.startsWith(E[k]));
    calls.push({ ep: key, body: init && init.body ? JSON.parse(init.body) : null, url, placeAtCall: storage.getItem(`capp:rid_a:pending_place`) });
    const q = script[key] || [];
    const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${key}`);
    if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? r(calls[calls.length - 1]) : r;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
  };
  return { fetch, calls, of: (ep) => calls.filter((c) => c.ep === ep) };
}
function rig({ script, storage = memStorage(), clock = { t: at(12) }, hours = OPEN_ALL, sheet } = {}) {
  const srv = server(script, storage);
  let n = 0;
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: 'ta_pending_pay', endpoints: E, hours },
    fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {}, randomBytes: (k) => Uint8Array.from({ length: k }, () => (n++ * 7) % 256),
    setInterval: () => 0, clearInterval: () => {} });
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
});

test('the placement record is persisted BEFORE the first send; last_send before EVERY attempt; a failed write ⇒ no send', async () => {
  const R = rig({ script: { createOrder: ['network', 'network', OK_CASH] } });
  R.clock.t = at(12);
  const out = await R.api.place(placeArgs('cash'));
  assert.equal(out.kind, 'placed');
  const sends = R.srv.of('createOrder');
  assert.equal(sends.length, 3, 'two retries on network failure');
  for (const c of sends) assert.ok(c.placeAtCall && JSON.parse(c.placeAtCall).order_id === c.body.order_id, 'the record existed when the request left');
  assert.equal(new Set(sends.map((c) => c.body.order_id)).size, 1, '🔴 every retry carries the SAME order_id');
  assert.equal(placeRec(R.storage), null, 'cash 200 ⇒ cleared');
  const W = rig({ script: { createOrder: [OK_CASH] } });
  W.storage.failWrites = true;
  assert.equal((await W.api.place(placeArgs('cash'))).kind, 'stash_failed');
  assert.equal(W.srv.calls.length, 0, '🔴 a failed record write ⇒ NO request');
  // the last_send re-write before a RETRY fails ⇒ that retry is not sent (and the placement resolves, never throws)
  const M = rig({ script: { createOrder: ['network', OK_CASH] } });
  let writes = 0; const real = M.storage.setItem;
  M.storage.setItem = (k, v) => { if (k.endsWith(':pending_place') && ++writes > 2) throw new Error('quota'); real(k, v); };
  const mo = await M.api.place(placeArgs('cash'));
  assert.deepEqual([mo.kind, M.srv.of('createOrder').length], ['stash_failed', 1], '🔴 no send without a persisted last_send');
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
  assert.equal(n.kind, 'paid_unverified');
  assert.deepEqual([N.srv.of('chargeOnlineOrder').length, N.srv.of('paymentStatus').length], [1, 0], '🔴 no token: never polls, never re-sends');
  assert.equal(placeRec(N.storage), null, 'Already paid clears (outcome 3)');
  const X = rig({ script: { chargeOnlineOrder: [CHECKOUT, AP], paymentStatus: [{ status: 403, json: {} }] } });
  await X.api.place(placeArgs('online'));
  const x = await X.api.place(placeArgs('online'));
  assert.deepEqual([x.kind, X.srv.of('paymentStatus').length, X.srv.of('chargeOnlineOrder').length], ['paid_unverified', 1, 2], 'a rejected token ⇒ paid_unverified, nothing more');
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
  const R = rig({ script: { chargeOnlineOrder: ['network'] }, hours: H, clock: { t: at(18) } });
  const a = await R.api.place(placeArgs('online'));
  R.clock.t = at(20, 59);
  const retry = rig({ script: { chargeOnlineOrder: [CHECKOUT] }, storage: R.storage, clock: R.clock, hours: H });
  const r = await retry.api.place(placeArgs('online'));
  assert.equal(r.order_id, a.order_id, 'the retry before closing is the same id');
  R.clock.t = at(21, 1);
  assert.equal(R.reload().readPlace().order_id, a.order_id, '🔴 21:01: last_send + 60 governs — STILL the same id (the checkout is live to 21:44)');
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

test('the identity endpoints are reached ONLY through the injected SherpaClient.fetch (no direct fetch); no brand literal', () => {
  const src = readFileSync(join(ROOT, 'customer-app/capp-api.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.equal(src.match(/(^|[^.\w])fetch\s*\(|window\.fetch|globalThis\.fetch|XMLHttpRequest/g), null, '🔴 a direct fetch in capp-api.js');
  assert.match(src, /root\.SherpaClient\.fetch\(/, 'the default transport is SherpaClient.fetch');
  assert.equal(src.match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
