// Customer app S7a-1 client foundation (PLAN-capp-S7a r1 → r3.1, APPROVED as a plan): the HOSTED transport (verified freeze before
// the first dispatch, the completion marker, ordered reconciliation, the expired-frozen recovery) and the pure shell module
// (config split, exact-record return ownership, the persisted handoff). Every case runs the REAL createApi / place().
// Run: node --test customer-app/capp-s7a1.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { namespaceRefusal } from './test/fake-sdk-checkout.mjs';
const require = createRequire(import.meta.url);
const A = require('./capp-api.js');
const C = require('./capp-checkout.js');
const SH = require('./capp-shell.js');

const E = { quoteOrder: 'https://fn.test/quoteOrder', createOrder: 'https://fn.test/createOrder', chargeOnlineOrder: 'https://fn.test/chargeOnlineOrder', paymentStatus: 'https://fn.test/paymentStatus' };
const OPEN_ALL = Array.from({ length: 7 }, () => [0, 0, 23, 59]);
const K = SH.keysFor('rid_a');
const T0 = Date.UTC(2026, 9, 26, 18, 0);   // 12:00 HN
function memStorage() {
  const m = new Map(); const fail = { write: new Set(), corrupt: new Set(), remove: new Set(), read: new Set() };
  return { getItem: (k) => { if (fail.read.has(k)) throw new Error('read'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (fail.write.has(k)) throw new Error('quota'); m.set(k, fail.corrupt.has(k) ? String(v) + ' ' : String(v)); },
    removeItem: (k) => { if (fail.remove.has(k)) return; m.delete(k); }, _m: m, fail };
}
const J = (st, k) => JSON.parse(st._m.get(k) || 'null');
function server(script) {
  const calls = [];
  const fetch = async (url, init) => {
    const ep = Object.keys(E).find((k) => url.startsWith(E[k])); calls.push({ ep, body: init && init.body ? JSON.parse(init.body) : null });
    { const nr = namespaceRefusal(ep, calls[calls.length - 1].body); if (nr) return { status: nr.status, ok: false, json: async () => nr.json }; }   // the server's namespace, before the script
    const q = script[ep] || []; const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${ep}`); if (r === 'network') throw new TypeError('Failed to fetch');
    const res = typeof r === 'function' ? await r() : r;   // a function may defer its answer (an outstanding request)
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.json };
  };
  return { fetch, calls, sends: () => calls.filter((c) => c.ep === 'createOrder' || c.ep === 'chargeOnlineOrder').length };
}
let RNG = 0;
function rig({ script = {}, storage = memStorage(), clock = { t: T0 }, hosted = true } = {}) {
  const srv = server(script);
  const make = () => A.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: hosted ? K.pay : 'ta_pending_pay', endpoints: E, hours: OPEN_ALL,
    ...(hosted ? { cartKey: K.cart, placedKey: K.placed } : {}) }, fetch: srv.fetch, storage, now: () => clock.t, sleep: async () => {},
    randomBytes: (k) => Uint8Array.from({ length: k }, () => (RNG++ * 7) % 256), setInterval: () => 0, clearInterval: () => {} });
  return { api: make(), reload: make, srv, storage, clock };
}
const ITEMS = [{ id: 'margherita', name: 'Margherita', dish_id: 'd_1', qty: 1, price: 250, subtotal: 250, extras: [], extrasTotal: 0 }];
const CTX = { restaurantId: 'rid_a', items: ITEMS, itemsText: '1x Margherita (L250)', member: null };
const flowOf = (pay = 'cash') => { const f = C.freshFlow(null); C.setPin(f, 15.5, -88, true); Object.assign(f, { details: 'Portón', name: 'Ana', phone: '99990000', pay }); C.chooseTip(f, 20); return f; };
// the CappCart v2 snapshot shape (cart.snapshot(): { v: 2, lines: [{ key, qty, ex, added }] }); the real writer's own output is
// composed in capp-ui.test.mjs (Codex r1 P2-8)
const SNAP = { v: 2, lines: [{ key: 'd_1', qty: 1, ex: [{}], added: 1 }] };
// the hosted UI places with its cart's generation (r2 §1.4; Codex r2 New 1)
const args = (pay = 'cash', gen = 'GEN_A') => ({ flow: flowOf(pay), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, cartSnapshot: { ...SNAP, cart_gen: gen } });
const OK_CASH = { status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } };
const seedCart = (st, extra = {}) => st.setItem(K.cart, JSON.stringify({ v: 2, rid: 'rid_a', mode: 'delivery', lines: SNAP.lines, cart_gen: 'GEN_A', ...extra }));

// ── N7: the verified freeze is a precondition of the first dispatch ──
test('S7a-1 N7: a FAILED freeze write ⇒ ZERO sends, the drawn offline state; a retry reuses the SAME identity and sends once', async () => {
  for (const how of ['write', 'corrupt']) {   // throws · returns normally but keeps different bytes
    const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
    R.storage.fail[how].add(K.cart);
    const a = await R.api.place(args());
    assert.deepEqual([a.kind, a.freeze_failed, R.srv.sends()], ['offline', true, 0], `🔴 ${how}: failed freeze write ⇒ zero sends`);
    const id = a.order_id; assert.equal(J(R.storage, K.place).order_id, id, 'the minted identity is kept (dispatched 0)');
    R.storage.fail[how].delete(K.cart);
    const b = await R.api.place(args());
    assert.deepEqual([b.kind, R.srv.sends(), R.srv.calls[0].body.order_id], ['placed', 1, id], `${how}: the retry reuses the identity, one send`);
  }
});

test('S7a-1 N7: the freeze lands BEFORE the dispatch — frozen_for = the order, cart_gen on the record AND the snapshot; a non-hosted api never freezes', async () => {
  const R = rig({ script: { createOrder: ['network'] } }); seedCart(R.storage);
  const a = await R.api.place(args());
  assert.equal(a.kind, 'offline');
  const cart = J(R.storage, K.cart), rec = J(R.storage, K.place);
  assert.deepEqual([cart.frozen_for, cart.cart_gen, rec.cart_gen], [a.order_id, 'GEN_A', 'GEN_A']);
  const N = rig({ script: { createOrder: ['network'] }, hosted: false }); seedCart(N.storage);
  await N.api.place({ ...args(), cartSnapshot: SNAP });
  assert.equal(J(N.storage, K.cart).frozen_for, undefined, 'link mode: no freeze, the S2 path');
});

// ── N1: the marker, ordered reconciliation, generation binding ──
test('S7a-1 N1 (Codex r1 P1-1): cash success ⇒ the VERIFIED marker, then the guarded clear; placing the PURCHASED cart again on that page ⇒ reconciled and ZERO further sends — never a new identity', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
  const a = await R.api.place(args());
  assert.deepEqual([a.kind, a.unsettled], ['placed', undefined]);
  const sent = R.srv.calls[0].body.order_id;
  assert.deepEqual([J(R.storage, K.placed).order_id, J(R.storage, K.placed).cart_gen, J(R.storage, K.placed).outcome, J(R.storage, K.place)], [sent, 'GEN_A', 'placed', null]);
  for (let i = 0; i < 2; i++) {   // the page still holds the purchased cart's lines (p.cartSnapshot)
    const again = await R.api.place(args());
    assert.deepEqual([again.kind, again.order_id, R.srv.sends()], ['existing_order', sent, 1], '🔴 the purchased cart is never sent again');
  }
  assert.deepEqual([J(R.storage, K.cart), J(R.storage, K.placed), J(R.storage, K.place)], [null, null, null], 'purchased A removed, marker consumed, nothing minted');
});

test('S7a-1 Codex r1 P1-1: an UNVERIFIED marker whose removal ALSO fails ⇒ fail closed — this page places nothing more; a fresh mount reconciles it and never re-dispatches the purchased cart', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
  R.storage.fail.corrupt.add(K.placed); R.storage.fail.remove.add(K.placed);   // the marker keeps different bytes AND cannot be removed
  const a = await R.api.place(args());
  const id = R.srv.calls[0].body.order_id;
  assert.deepEqual([a.kind, a.unsettled, J(R.storage, K.place).order_id], ['placed', true, id], 'reported unsettled; the lock is held');
  R.storage.fail.corrupt.delete(K.placed); R.storage.fail.remove.delete(K.placed);
  const b = await R.api.place(args());
  assert.deepEqual([b.kind, b.reconcile, R.srv.sends()], ['offline', 'marker_unverified', 1], '🔴 an unremovable unverified marker latches the page: zero further sends');
  const c = await R.reload().place(args());
  assert.deepEqual([c.kind, c.order_id, R.srv.sends()], ['existing_order', id, 1], '🔴 a fresh mount reconciles the purchased cart and never re-dispatches it');
});

test('Codex r2 P1-1: a PARTIAL reconciliation (the purchased cart removed, the marker removal FAILED) never lets that cart be sent again — not in the mount, not after a restart', async () => {
  for (const restart of [false, true]) {
    const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
    const a = await R.api.place(args());
    const id = R.srv.calls[0].body.order_id; assert.equal(a.kind, 'placed');
    R.storage.fail.remove.add(K.placed);
    const b = await R.api.place(args());
    assert.deepEqual([b.kind, b.reconcile, J(R.storage, K.cart), J(R.storage, K.placed).order_id], ['offline', 'clear_marker', null, id], 'premise: cart removed, marker kept');
    R.storage.fail.remove.delete(K.placed);   // storage recovers
    const api = restart ? R.reload() : R.api;
    const c = await api.place(args());
    assert.deepEqual([c.kind, c.order_id, R.srv.sends()], ['existing_order', id, 1], `🔴 ${restart ? 'after a restart' : 'in the mount'}: the purchased cart is never re-sent under a new identity`);
  }
});

test('Codex r2 New 1: the purchase latch binds to the purchased GENERATION — a NEW cart (a new gen) in the same mount places normally; the purchased one stays refused', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
  await R.api.place(args());
  const idA = R.srv.calls[0].body.order_id;
  assert.equal((await R.api.place(args())).kind, 'existing_order', 'premise: the purchased cart is latched');
  const b = await R.api.place(args('cash', 'GEN_B'));
  assert.deepEqual([b.kind, R.srv.sends()], ['placed', 2], '🔴 a new cart places normally in the same mount');
  assert.notEqual(R.srv.calls[1].body.order_id, idA);
  assert.deepEqual([(await R.api.place(args())).kind, R.srv.sends()], ['existing_order', 2], 'the purchased generation is still refused');
});

test('Codex r2 New 2: on the ISSUED-card path an UNSETTLED end (a failed poll whose released marker did not land) is returned — never a second charge for the same id', async () => {
  const R = rig({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }], paymentStatus: [{ status: 200, json: { ok: true, state: 'failed' } }] } }); seedCart(R.storage);
  const a = await R.api.place(args('online')); assert.equal(a.kind, 'redirect');
  R.storage.fail.write.add(K.placed);
  const b = await R.api.place(args('online'));
  assert.deepEqual([b.kind, b.unsettled, b.order_id], ['payment_failed', true, a.order_id], 'the unsettled end is returned');
  assert.equal(R.srv.calls.filter((c) => c.ep === 'chargeOnlineOrder').length, 1, '🔴 never a second charge for the same id');
  assert.equal(J(R.storage, K.place).order_id, a.order_id, 'the lock is held');
});

test('S7a-1 Codex r1 P1-2: a paid poll whose marker write FAILS keeps the stash (the recovery credentials) and is UNSETTLED — never terminal for the shell; a later poll completes it', async () => {
  const R = rig({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] } }); seedCart(R.storage);
  const a = await R.api.place(args('online')); assert.equal(a.kind, 'redirect');
  const PAID = { paymentStatus: [{ status: 200, json: { ok: true, state: 'paid', tracking_token: 'tt' } }] };
  R.storage.fail.write.add(K.placed);
  const R2 = rig({ script: PAID, storage: R.storage });
  const out = await R2.api.handleReturn(`?pay=complete&order=${a.order_id}&t=pt_1`);
  assert.deepEqual([out.kind, out.unsettled, R2.api.credsFor(a.order_id)], ['placed', true, 'pt_1'], '🔴 a failed marker keeps the stash');
  assert.equal(J(R.storage, K.place).order_id, a.order_id, 'and the lock');
  assert.equal(SH.isTerminal(out), false, '🔴 the shell never settles an unsettled end');
  R.storage.fail.write.delete(K.placed);
  const R3 = rig({ script: PAID, storage: R.storage });
  const done = await R3.api.resolveExisting(a.order_id);
  assert.deepEqual([done.kind, done.unsettled, J(R.storage, K.pay), J(R.storage, K.placed).order_id, SH.isTerminal(done)], ['placed', undefined, null, a.order_id, true]);
});

test('S7a-1 Codex r1 P1-3: a cart READ error is not an unfrozen cart — one failing read ⇒ blocked, zero sends, nothing minted; healthy again ⇒ the recovery sheet', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage, { frozen_for: 'TA_OLD' });
  let n = 0; const g = R.storage.getItem; R.storage.getItem = (k) => { if (k === K.cart && n++ === 0) throw new Error('read'); return g(k); };
  const a = await R.api.place(args());
  assert.deepEqual([a.kind, R.srv.sends(), J(R.storage, K.place)], ['offline', 0, null], '🔴 unknown freeze state ⇒ blocked');
  const b = await R.api.place(args());
  assert.deepEqual([b.kind, b.order_id, R.srv.sends()], ['existing_order', 'TA_OLD', 0]);  // the freeze's OWN read of the cart fails (the freeze check read fine) ⇒ the freeze is not attempted: zero sends
  const F = rig({ script: { createOrder: [OK_CASH] } }); seedCart(F.storage);
  let m = 0; const gf = F.storage.getItem; F.storage.getItem = (k) => { if (k === K.cart && m++ === 1) throw new Error('read'); return gf(k); };
  const f = await F.api.place(args());
  assert.deepEqual([f.kind, f.freeze_failed, F.srv.sends(), J(F.storage, K.cart).frozen_for], ['offline', true, 0, undefined], '🔴 an unreadable cart at the freeze ⇒ no freeze, zero sends');
});

test('S7a-1 Codex r1 P1-4: a STALE late completion for A never replaces B\'s marker — A outstanding; A re-sent and reconciled; B placed; then the original A answers', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const R = rig({ script: { createOrder: [() => held.then(() => OK_CASH), OK_CASH] } }); seedCart(R.storage);
  const p1 = R.api.place(args());                       // page 1: A dispatched, its answer outstanding
  await new Promise((r) => setImmediate(r));
  const idA = R.srv.calls[0].body.order_id;
  const page2 = R.reload();
  assert.equal((await page2.place(args())).kind, 'placed');   // a reload re-sends the retained A ⇒ placed
  assert.equal(R.srv.calls[1].body.order_id, idA);
  assert.equal(page2.reconcile().cart, 'cleared', 'A reconciled: its purchased cart removed');
  seedCart(R.storage, { cart_gen: 'GEN_B' });
  const page3 = R.reload();
  assert.equal((await page3.place(args('cash', 'GEN_B'))).kind, 'placed');   // B (a new cart, a new identity)
  const idB = R.srv.calls[2].body.order_id; assert.notEqual(idB, idA);
  release(); const late = await p1;                    // the original A finally answers
  assert.equal(late.kind, 'placed');
  assert.deepEqual([J(R.storage, K.placed).order_id, J(R.storage, K.placed).cart_gen], [idB, 'GEN_B'], '🔴 the late A never overwrites B\'s marker');
  const rc = page3.reconcile();
  assert.deepEqual([rc.order_id, rc.cart, J(R.storage, K.cart)], [idB, 'cleared', null], 'B completes: never left frozen without its record');
});

test('S7a-1 Codex r1 P1-4: a completion for A WITH its own evidence while B\'s marker is pending ⇒ B is finished (reconciled) first, never overwritten', async () => {
  const R = rig({ script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'paid' } }] } });
  seedCart(R.storage, { cart_gen: 'GEN_B', frozen_for: 'TA_B' });
  R.storage.setItem(K.placed, JSON.stringify({ order_id: 'TA_B', cart_gen: 'GEN_B', outcome: 'placed', at: T0 }));
  R.storage.setItem(K.pay, JSON.stringify({ order_id: 'TA_A', t: 'pt_a', rid: 'rid_a', cart_gen: 'GEN_A' }));
  const out = await R.api.resolveExisting('TA_A');
  assert.deepEqual([out.kind, out.unsettled], ['placed', undefined]);
  assert.equal(J(R.storage, K.cart), null, '🔴 B\'s completion is applied (its purchased cart removed), not lost under A\'s marker');
  assert.deepEqual([J(R.storage, K.placed).order_id, J(R.storage, K.placed).cart_gen], ['TA_A', 'GEN_A']);
  R.storage.setItem(K.placed, JSON.stringify({ order_id: 'TA_A', cart_gen: null, outcome: 'placed', at: T0 }));
  seedCart(R.storage, { frozen_for: 'TA_A' });
  assert.deepEqual([R.api.reconcile().done, J(R.storage, K.cart).frozen_for], ['none', 'TA_A'], 'a marker WITHOUT a generation is never evidence: nothing cleared, frozen');
});

test('S7a-1 N1: a marker write that FAILS (or keeps different bytes) ⇒ the lock is HELD (pending_place kept); recovery completes later', async () => {
  for (const how of ['write', 'corrupt']) {
    const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
    R.storage.fail[how].add(K.placed);
    const a = await R.api.place(args());
    assert.deepEqual([a.kind, a.unsettled], ['placed', true], 'P1-2: reported unsettled');
    const id = R.srv.calls[0].body.order_id;
    assert.equal(J(R.storage, K.place).order_id, id, `🔴 ${how}: marker byte mismatch ⇒ lock held`);
    assert.equal(J(R.storage, K.cart).frozen_for, id, 'the cart stays frozen');
    R.storage.fail[how].delete(K.placed);
    await R.api.place(args());   // the retained cash identity re-sends ⇒ idempotent ⇒ placed again ⇒ the marker lands
    assert.deepEqual([R.srv.calls[1].body.order_id, J(R.storage, K.placed).order_id], [id, id]);
  }
});

test('S7a-1 N1: reconciliation is ORDERED — after a reload between the marker and clearPlace, A\'s record is removed BEFORE the marker is consumed', () => {
  const R = rig(); seedCart(R.storage, { frozen_for: 'TA_A' });
  R.storage.setItem(K.place, JSON.stringify({ order_id: 'TA_A', dispatched: 1, cart_gen: 'GEN_A', expires_at: T0 + 3600e3, ts: T0, last_send: T0 }));
  R.storage.setItem(K.placed, JSON.stringify({ order_id: 'TA_A', cart_gen: 'GEN_A', outcome: 'placed', at: T0 }));
  R.storage.fail.remove.add(K.place);
  assert.deepEqual(R.api.reconcile(), { ok: false, step: 'clear_place' }, 'a failed clear stops');
  assert.ok(J(R.storage, K.placed), '🔴 the marker is NOT consumed before the record is cleared');
  R.storage.fail.remove.delete(K.place);
  const rc = R.api.reconcile();
  assert.deepEqual([rc.ok, J(R.storage, K.place), J(R.storage, K.cart), J(R.storage, K.placed)], [true, null, null, null]);
  assert.deepEqual(R.api.reconcile(), { ok: true, done: 'none' }, 'idempotent');
});

test('S7a-1 N1: a late A success with a newer cart B ⇒ B untouched; a read error ⇒ blocked (zero sends)', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } });
  R.storage.setItem(K.cart, JSON.stringify({ v: 1, rid: 'rid_a', lines: [{ key: 'd_2', qty: 2, ex: [{}, {}] }], cart_gen: 'GEN_B' }));
  R.storage.setItem(K.placed, JSON.stringify({ order_id: 'TA_A', cart_gen: 'GEN_A', outcome: 'placed', at: T0 }));
  const rc = R.api.reconcile();
  assert.deepEqual([rc.ok, (J(R.storage, K.cart) || {}).cart_gen, J(R.storage, K.placed)], [true, 'GEN_B', null], '🔴 late A success leaves B intact');
  R.storage.setItem(K.placed, JSON.stringify({ order_id: 'TA_A', cart_gen: 'GEN_A', outcome: 'placed', at: T0 }));
  R.storage.fail.read.add(K.placed);
  const a = await R.api.place(args());
  assert.deepEqual([a.kind, R.srv.sends()], ['offline', 0], 'blocked until reconciliation completes');
});

test('S7a-1 r3 §1.4: a frozen cart whose lock EXPIRED with no marker NEVER unlocks — the drawn recovery sheet, no placement', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage, { frozen_for: 'TA_OLD' });
  const a = await R.api.place(args());
  assert.deepEqual([a.kind, a.order_id, R.srv.sends()], ['existing_order', 'TA_OLD', 0]);
  assert.deepEqual(R.api.cartFreeze(), { frozen: true, order_id: 'TA_OLD', live: false });
});

test('S7a-1: a RELEASED end (a cancelled card poll) unfreezes the matching cart without clearing it; the stash carries rid + cart_gen only when hosted', async () => {
  const R = rig({ script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] } }); seedCart(R.storage);
  const a = await R.api.place(args('online'));
  assert.equal(a.kind, 'redirect');
  assert.deepEqual([J(R.storage, K.pay).rid, J(R.storage, K.pay).cart_gen], ['rid_a', 'GEN_A']);
  const R2 = rig({ script: { paymentStatus: [{ status: 200, json: { ok: true, state: 'cancelled' } }] }, storage: R.storage });
  const out = await R2.api.handleReturn(`?pay=cancel&order=${a.order_id}&t=pt_1`);
  assert.equal(out.kind, 'payment_failed');
  assert.equal(J(R.storage, K.placed).outcome, 'released');
  R2.api.reconcile();
  const c = J(R.storage, K.cart);
  assert.deepEqual([c.frozen_for, c.lines.length, c.cart_gen], [undefined, 1, 'GEN_A'], 'unfrozen, kept');
  const N = rig({ hosted: false, script: { chargeOnlineOrder: [{ status: 200, json: { checkout_url: 'https://pay.test/1', poll_token: 'pt_1', attempt_id: 'a1' } }] } });
  await N.api.place(args('online'));
  assert.deepEqual(Object.keys(J(N.storage, 'ta_pending_pay')).sort(), ['form', 'order', 'order_id', 't', 'ts'], 'link mode: the legacy stash shape, unchanged');
});

// ── the shell module ──
test('S7a-1 config split: configFor maps the public entry + runtime (mapsKey) + the derived per-store keys; unavailable schedule ⇒ closed; only a priced fee', () => {
  const entry = { restaurant_id: 'rid_a', name: 'Uno', kicker: 'K', unit: ['pizza', 'pizzas'], logo_url: '/l.webp', hero_url: '/h.jpg', asset_base: '/a/', pickup_addr: 'Calle 1', branch: 'Centro',
    hub_lat: 15.5, hub_lng: -88, coverage_km: 6, eta_delivery_min: [30, 45], eta_pickup_min: [15, 20], order_id_prefix: 'TA',
    schedule: { hours: { sun: { open: false }, mon: { open: true, start: '11:00', end: '22:00' }, tue: { open: true, start: '11:00', end: '22:00' }, wed: { open: false }, thu: { open: false }, fri: { open: false }, sat: { open: false } } },
    fee: { state: 'priced', from_cents: 3000 } };
  const rt = { endpoints: E, intakeKey: 'k_test', mapsKey: 'm_test' };
  const c = SH.configFor(entry, rt);
  assert.deepEqual([c.restaurantId, c.mapsKey, c.intakeKey, c.endpoints, c.pendingPayKey, c.cartKey, c.placedKey, c.entry], ['rid_a', 'm_test', 'k_test', E, K.pay, K.cart, K.placed, 'app']);
  assert.deepEqual(c.hours, [null, [11, 0, 22, 0], [11, 0, 22, 0], null, null, null, null]);
  assert.deepEqual([c.feeFromCents, c.zoneKm, c.loc, c.assetBase, c.orderIdPrefix], [3000, 6, { lat: 15.5, lng: -88 }, '/a/', 'TA']);
  for (const st of ['none', 'invalid', 'unavailable']) assert.equal(SH.configFor({ ...entry, fee: { state: st } }, rt).feeFromCents, null, `${st} ⇒ no fee, never 0`);
  assert.deepEqual(SH.configFor({ ...entry, schedule: null }, rt).hours, Array(7).fill(null), 'schedule unavailable ⇒ closed, never assumed open');
  assert.equal(SH.configFor({ ...entry }, { endpoints: E }).mapsKey, undefined, 'no mapsKey ⇒ absent (the schematic map)');
  assert.equal(SH.configFor({}, rt), null);
});

test('S2-checkout: configFor turns the SDK checkout on ONLY for the installed app with runtime.sdkPay — its endpoints merged into the transport\'s; the web never', () => {
  const entry = { restaurant_id: 'rid_a', name: 'Uno', hub_lat: 15.5, hub_lng: -88, schedule: null };
  const SDK_EP = { getPayAdjust: 'https://fn.test/getPayAdjust', placeSdkOrder: 'https://fn.test/placeSdkOrder', listCards: 'https://fn.test/listCards' };
  const nat = SH.configFor(entry, { endpoints: E, native: true, sdkPay: { endpoints: SDK_EP } });
  assert.equal(nat.sdkCheckout, true, '🔴 SDKCFG: the installed app with sdkPay');
  assert.deepEqual(nat.endpoints, { ...E, ...SDK_EP }, '🔴 SDKCFG: the transport carries both sets of endpoints');
  const web = SH.configFor(entry, { endpoints: E, sdkPay: { endpoints: SDK_EP } });
  assert.deepEqual(['sdkCheckout' in web, web.endpoints], [false, E], '🔴 SDKCFG: the website keeps the hosted page (advisor Q7)');
  assert.equal('sdkCheckout' in SH.configFor(entry, { endpoints: E, native: true }), false, 'no sdkPay ⇒ dark');
});

test('S7a-1 return ownership: EXACT records only — one ⇒ owner; zero / several ⇒ null (neutral); a stash whose rid binding mismatches is ignored', () => {
  const st = memStorage();
  const ka = SH.keysFor('rid_a'), kb = SH.keysFor('rid_b');
  st.setItem(ka.pay, JSON.stringify({ order_id: 'PZX-261026-120000-AAAAAAAA', t: 'pt', rid: 'rid_a' }));
  assert.deepEqual(SH.resolveOwner(st, 'PZX-261026-120000-AAAAAAAA', ['rid_a', 'rid_b']), { owner: 'rid_a', matches: ['rid_a'] });
  st.setItem(kb.place, JSON.stringify({ order_id: 'PZX-261026-120000-AAAAAAAA' }));
  assert.equal(SH.resolveOwner(st, 'PZX-261026-120000-AAAAAAAA', ['rid_a', 'rid_b']).owner, null, '🔴 two stores hold the order ⇒ neutral');
  assert.equal(SH.resolveOwner(st, 'PZX-261026-120000-ZZZZZZZZ', ['rid_a', 'rid_b']).owner, null, 'unknown order ⇒ neutral (a forged cancel never reaches a store)');
  const s2 = memStorage(); s2.setItem(kb.pay, JSON.stringify({ order_id: 'PZX-261026-120000-CCCCCCCC', t: 'pt', rid: 'rid_a' }));
  assert.equal(SH.resolveOwner(s2, 'PZX-261026-120000-CCCCCCCC', ['rid_a', 'rid_b']).owner, null, 'a stash bound to another rid is not ownership');
});

test('S7a-1 N3: the handoff is persisted (verified) BEFORE stripping; a persist failure ⇒ in memory, URL kept, an older stored handoff IGNORED; boot resumes without pay=', () => {
  const st = memStorage(); const q = '?pay=cancel&order=TA261026-120000-AAAAAAAA&t=pt_1';
  const b = SH.bootReturn({ search: q, storage: st, rids: [], now: () => T0 });
  assert.deepEqual([b.mode, b.strip, J(st, SH.RETURN_KEY).t], ['persisted', true, 'pt_1']);
  assert.deepEqual([SH.bootReturn({ search: '', storage: st, rids: [] }).mode, SH.bootReturn({ search: '', storage: st, rids: [] }).handoff.t], ['resumed', 'pt_1'], 'reload during polling resumes with t');
  st.fail.write.add(SH.RETURN_KEY);
  const m = SH.bootReturn({ search: '?pay=complete&order=TA261026-130000-BBBBBBBB&t=pt_2', storage: st, rids: [] });
  assert.deepEqual([m.mode, m.strip, m.handoff.t, J(st, SH.RETURN_KEY).t], ['memory', false, 'pt_2', 'pt_1'], '🔴 persist failure keeps the URL; the current query is processed, the older handoff ignored');
  assert.equal(SH.bootReturn({ search: '?pay=bogus', storage: memStorage(), rids: [] }).mode, 'invalid');
});

test('S7a-1 N3/r3.1: the handoff is removed ONLY on an authoritative terminal (kind + clearable) or a VERIFIED transfer — never on the pending lock or local expiry', () => {
  const h = { pay: 'cancel', order: 'TA261026-120000-AAAAAAAA', t: 'pt', owner: 'rid_a' };
  const st = memStorage(); st.setItem(SH.RETURN_KEY, JSON.stringify(h));
  for (const nt of [{ kind: 'payment_failed', clearable: false }, { kind: 'confirming' }, { kind: 'existing_order' }, { kind: 'offline' }, { kind: 'placed', unsettled: true }]) {
    assert.equal(SH.settleHandoff(st, { ...nt, order_id: h.order }, h), false, `🔴 ${JSON.stringify(nt)} keeps the handoff (not terminal)`); assert.ok(J(st, SH.RETURN_KEY), `🔴 ${JSON.stringify(nt)} keeps the handoff`);
  }
  assert.equal(SH.settleHandoff(st, { kind: 'payment_failed', state: 'cancelled', order_id: h.order }, h), true, 'a definitive failure is terminal');
  st.setItem(SH.RETURN_KEY, JSON.stringify({ pay: 'cancel', order: 'TA261026-120000-AAAAAAAA', t: 'pt', owner: 'rid_a' }));
  st.fail.write.add(K.pay);
  assert.equal(SH.transferHandoff(st, J(st, SH.RETURN_KEY), 'GEN_A'), false); assert.ok(J(st, SH.RETURN_KEY), 'an unverified transfer keeps it');
  st.fail.write.delete(K.pay);
  assert.equal(SH.transferHandoff(st, J(st, SH.RETURN_KEY), 'GEN_A'), true);
  assert.deepEqual([J(st, SH.RETURN_KEY), J(st, K.pay).t, J(st, K.pay).cart_gen, J(st, K.pay).rid], [null, 'pt', 'GEN_A', 'rid_a']);
  for (const t of [{ kind: 'placed' }, { kind: 'refunded' }, { kind: 'scheduled_review' }, { kind: 'paid_unverified' }]) assert.equal(SH.isTerminal(t), true);
});

test('S7a-1 Codex r1 P1-5: a late terminal for A never deletes B\'s handoff; transferring A never overwrites B\'s stash nor borrows GEN_B', () => {
  const hA = { pay: 'complete', order: 'TA261026-120000-AAAAAAAA', t: 'pt_a', owner: 'rid_a', at: T0 };
  const hB = { pay: 'complete', order: 'TA261026-130000-BBBBBBBB', t: 'pt_b', owner: 'rid_a', at: T0 + 1 };
  const st = memStorage(); st.setItem(SH.RETURN_KEY, JSON.stringify(hB));
  assert.equal(SH.settleHandoff(st, { kind: 'placed', order_id: hA.order }, hA), false, '🔴 a late terminal for A leaves B\'s handoff (not settled)');
  assert.deepEqual(J(st, SH.RETURN_KEY), hB, '🔴 a late terminal for A leaves B\'s handoff');
  assert.equal(SH.settleHandoff(st, { kind: 'placed', order_id: hA.order }, hB), false, '🔴 an outcome for another order never settles B (refused)');
  assert.deepEqual(J(st, SH.RETURN_KEY), hB, '🔴 an outcome for another order never settles B');
  st.setItem(K.pay, JSON.stringify({ order_id: hB.order, t: 'pt_b', rid: 'rid_a', cart_gen: 'GEN_B' }));
  assert.equal(SH.transferHandoff(st, hA), false);
  assert.deepEqual([J(st, K.pay).order_id, J(st, K.pay).t, J(st, K.pay).cart_gen, J(st, SH.RETURN_KEY)], [hB.order, 'pt_b', 'GEN_B', hB], '🔴 B\'s stash and handoff intact');
  const s2 = memStorage(); s2.setItem(SH.RETURN_KEY, JSON.stringify(hA));
  assert.equal(SH.transferHandoff(s2, hA), true);
  assert.deepEqual([J(s2, K.pay).order_id, J(s2, K.pay).cart_gen, J(s2, SH.RETURN_KEY)], [hA.order, null, null], 'no generation given ⇒ null, never another order\'s');
  assert.equal(SH.settleHandoff(st, { kind: 'placed', order_id: hB.order }, hB), true, 'B\'s own terminal settles B');
});

test('Codex r3 #5: an UNREADABLE placement record is UNKNOWN in the lock and freeze path — placement reports offline (retryable, zero sends), holdsLock() holds; readPlace for S2 callers is unchanged', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage, { frozen_for: 'TA_A' });
  R.storage.setItem(K.place, JSON.stringify({ order_id: 'TA_A', method: 'cash', dispatched: 1, cart_gen: 'GEN_A', ts: T0, last_send: T0, expires_at: T0 + 3600e3 }));
  R.storage.fail.read.add(K.place);
  assert.deepEqual(R.api.cartFreeze(), { frozen: true, unknown: true, order_id: 'TA_A', live: false }, 'unknown, not «not live»');
  const a = await R.api.place(args());
  assert.deepEqual([a.kind, a.reconcile, R.srv.sends()], ['offline', 'read_cart', 0], '🔴 an unreadable record ⇒ unknown ⇒ offline, never the not-live recovery path');
  const N = rig(); N.storage.fail.read.add(K.place);
  assert.equal(N.api.holdsLock(), true, '🔴 an unreadable record holds the lock even with no frozen cart');
  assert.equal(N.api.readPlace(), null, 'readPlace (S2) still reads a failure as absence');
});

// «Volver a pedir» advisor ruling 2026-11-02: placement is the BASE (no cart lock). This cell PROVES it on behaviour: the
// base capp-api.js (blob 543d9d71~1, before any «Volver a pedir» change) is compiled here and both modules run the same scenarios on a
// TRACED storage — every read / write / remove, every request body, every outcome identical
async function baseApiModule() {
  const { execFileSync } = await import('node:child_process'); const Module = (await import('node:module')).default; const pathM = await import('node:path');
  const here = pathM.dirname(new URL(import.meta.url).pathname), file = pathM.join(here, 'capp-api.base-blob.js');
  const src = execFileSync('git', ['show', '543d9d71~1:customer-app/capp-api.js'], { cwd: here, encoding: 'utf8' });
  const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(here); m._compile(src, file); return { exports: m.exports, src };
}
test('placement = the BASE module (543d9d71~1): identical storage traces, request bodies and outcomes — success, failure + retry, refusal, overlap, expiry, an in-memory ABA, cash and card', async () => {
  const B = await baseApiModule();
  const { readFileSync } = await import('node:fs');
  // S2-checkout (advisor design A, 11-08) changed capp-api.js ON PURPOSE (placeSdk inside the placement machinery; the hosted gate and
  // the first-dispatch freeze factored into shared helpers): the byte-for-byte pin is retired, and THIS behavioural proof is the guard —
  // every legacy placement below still leaves the base's exact storage trace, request bodies and outcomes
  assert.notEqual(readFileSync(new URL('./capp-api.js', import.meta.url), 'utf8'), B.src, 'premise: the module differs from the base (S2-checkout)');
  const OK_CARD = { status: 200, json: { ok: true, order_id: 'X', checkout_url: 'https://pay.test/c', poll_token: 'pt' } };
  const run = async (Mod, scenario) => {
    const trace = [], st = memStorage(), clock = { t: T0 }; let rng = 0;
    const tr = { getItem: (k) => { const v = st.getItem(k); trace.push(['get', k, v]); return v; }, setItem: (k, v) => { trace.push(['set', k, v]); st.setItem(k, v); }, removeItem: (k) => { trace.push(['del', k]); st.removeItem(k); } };
    const srv = server(JSON.parse(JSON.stringify(scenario.script)));   // each run its own script (server() consumes it)
    const api = Mod.createApi({ config: { restaurantId: 'rid_a', orderIdPrefix: 'TA', pendingPayKey: K.pay, endpoints: E, hours: OPEN_ALL, cartKey: K.cart, placedKey: K.placed, ...(scenario.config || {}) }, ...(scenario.member ? { member: () => scenario.member } : {}), fetch: srv.fetch, storage: tr, now: () => clock.t, sleep: async () => {},
      randomBytes: (k) => Uint8Array.from({ length: k }, () => (rng++ * 13) % 256), setInterval: () => 0, clearInterval: () => {} });
    const out = await scenario.go(api, tr, clock);
    return { trace, bodies: srv.calls.map((c) => [c.ep, c.body]), out: JSON.parse(JSON.stringify(out)) };
  };
  const seed = (tr, extra) => tr.setItem(K.cart, JSON.stringify({ v: 2, rid: 'rid_a', mode: 'delivery', lines: SNAP.lines, cart_gen: 'GEN_A', ...(extra || {}) }));
  const SC = {
    'cash success': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); return a.place(args()); } },
    'cash network failure, then the retry': { script: { createOrder: ['network', OK_CASH] }, go: async (a, tr) => { seed(tr); return [await a.place(args()), await a.place(args())]; } },
    'card success (the checkout redirect)': { script: { chargeOnlineOrder: [OK_CARD] }, go: async (a, tr) => { seed(tr); return a.place(args('online')); } },
    'a refused freeze (the cart write fails)': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); const set = tr.setItem; tr.setItem = (k, v) => { if (k === K.cart && /frozen_for/.test(v)) throw new Error('quota'); return set(k, v); }; return a.place(args()); } },
    'a frozen cart from an expired lock (recovery, no send)': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr, { frozen_for: 'TA_OLD' }); return a.place(args()); } },
    'overlapping cash placements': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); return Promise.all([a.place(args()), a.place(args())]); } },
    'overlapping card placements': { script: { chargeOnlineOrder: [OK_CARD] }, go: async (a, tr) => { seed(tr); return Promise.all([a.place(args('online')), a.place(args('online'))]); } },
    'a retry after the record expired': { script: { createOrder: ['network', OK_CASH] }, go: async (a, tr, clock) => { seed(tr); const x = await a.place(args()); clock.t += 3 * 3600e3; return [x, await a.place(args())]; } },
    'an in-memory cart, no persisted cart (null → X → null)': { script: { createOrder: [OK_CASH] }, go: async (a) => Promise.all([a.place(args()), a.place(args())]) },
    // Codex S2-checkout r1: the differential extended — guest and scheduled placement, quote acceptance, storage failures
    'a guest card placement with its checkout ticket (guestCardOnly)': { config: { guestCardOnly: true }, script: { chargeOnlineOrder: [OK_CARD] }, go: async (a, tr) => { seed(tr); const id = a.orderIdForCode(args('online')); return a.place({ ...args('online'), checkoutTicket: { ticket: 'tk_1', order_id: id, expires_at: T0 + 600e3 } }); } },
    'a guest without a ticket, and a guest cash attempt (refused locally)': { config: { guestCardOnly: true }, script: {}, go: async (a, tr) => { seed(tr); return [await a.place(args('online')), await a.place(args('cash'))]; } },
    'a scheduled member cash order (schedulingLive)': { config: { schedulingLive: true }, member: { uid: 'u1', idToken: null }, script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); const p = args(); p.flow.time = 'schedule'; p.flow.slot = T0 + 3 * 3600e3; return a.place(p); } },
    'a scheduled send whose answer is lost, then the replay of the recorded bytes': { config: { schedulingLive: true }, member: { uid: 'u1', idToken: null }, script: { createOrder: ['network', OK_CASH] }, go: async (a, tr) => { seed(tr); const p = args(); p.flow.time = 'schedule'; p.flow.slot = T0 + 3 * 3600e3; return [await a.place(p), await a.place({ ...p, freshOk: false })]; } },
    'a price increase, accepted on the sheet': { script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 33000 } }, OK_CASH] }, go: async (a, tr) => { seed(tr); return a.place({ ...args(), sheet: async () => true }); } },
    'a price increase, declined on the sheet': { script: { createOrder: [{ status: 409, json: { error: 'price_increased', net_total_cents: 33000 } }] }, go: async (a, tr) => { seed(tr); return a.place({ ...args(), sheet: async () => false }); } },
    'a stale quote (quote_invalid) recovered once, silently': { script: { createOrder: [{ status: 409, json: { error: 'quote_invalid' } }, OK_CASH] }, go: async (a, tr) => { seed(tr); return a.place(args()); } },
    'the placement record cannot be written (quota)': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); const set = tr.setItem; tr.setItem = (k, v) => { if (k === K.place) throw new Error('quota'); return set(k, v); }; return a.place(args()); } },
    'the record write lands, its re-read is lost (a replaced record mid-send)': { script: { createOrder: [OK_CASH] }, go: async (a, tr) => { seed(tr); const get = tr.getItem; let n = 0; tr.getItem = (k) => (k === K.place && ++n === 3 ? null : get(k)); return a.place(args()); } },
  };
  for (const [name, sc] of Object.entries(SC)) {
    const base = await run(B.exports, sc), head = await run(A, sc);
    assert.deepEqual(head, base, `🔴 VP-base: «${name}» — storage trace, request bodies and outcome identical to the base`);
  }
});
