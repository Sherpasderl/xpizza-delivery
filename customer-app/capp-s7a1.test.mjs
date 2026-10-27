// Customer app S7a-1 client foundation (PLAN-capp-S7a r1 → r3.1, APPROVED as a plan): the HOSTED transport (verified freeze before
// the first dispatch, the completion marker, ordered reconciliation, the expired-frozen recovery) and the pure shell module
// (config split, exact-record return ownership, the persisted handoff). Every case runs the REAL createApi / place().
// Run: node --test customer-app/capp-s7a1.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
    const q = script[ep] || []; const r = q.length > 1 ? q.shift() : q[0];
    if (!r) throw new Error(`unscripted ${ep}`); if (r === 'network') throw new TypeError('Failed to fetch');
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
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
const SNAP = { v: 1, lines: [{ key: 'd_1', qty: 1, ex: [{}] }] };
const args = (pay = 'cash') => ({ flow: flowOf(pay), ctx: CTX, sig: 'sig1', expectedNetCents: 31500, cartSnapshot: SNAP });
const OK_CASH = { status: 200, json: { ok: true, order_id: 'X', tracking_token: 'tt' } };
const seedCart = (st, extra = {}) => st.setItem(K.cart, JSON.stringify({ v: 1, rid: 'rid_a', mode: 'delivery', lines: SNAP.lines, cart_gen: 'GEN_A', ...extra }));

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
test('S7a-1 N1: cash success ⇒ the VERIFIED marker, then the guarded clear; reconcile removes the purchased cart and the marker; A is never re-purchasable', async () => {
  const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
  const a = await R.api.place(args());
  assert.equal(a.kind, 'placed');
  const sent = R.srv.calls[0].body.order_id;
  assert.deepEqual([J(R.storage, K.placed).order_id, J(R.storage, K.placed).outcome, J(R.storage, K.place)], [sent, 'placed', null]);
  const rc = R.api.reconcile();
  assert.deepEqual([rc.ok, rc.done, J(R.storage, K.cart), J(R.storage, K.placed)], [true, 'placed', null, null], '🔴 purchased A removed');
  assert.notEqual(R.srv.calls.length && J(R.storage, K.place) && J(R.storage, K.place).order_id, sent);
  const R3 = rig({ script: { createOrder: [OK_CASH] }, storage: R.storage }); seedCart(R.storage, { cart_gen: 'GEN_N' }); await R3.api.place(args());
  assert.notEqual(R3.srv.calls[0].body.order_id, sent, '🔴 purchased A is not re-purchasable (a new identity)');
});

test('S7a-1 N1: a marker write that FAILS (or keeps different bytes) ⇒ the lock is HELD (pending_place kept); recovery completes later', async () => {
  for (const how of ['write', 'corrupt']) {
    const R = rig({ script: { createOrder: [OK_CASH] } }); seedCart(R.storage);
    R.storage.fail[how].add(K.placed);
    const a = await R.api.place(args());
    assert.equal(a.kind, 'placed');
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
  const st = memStorage(); st.setItem(SH.RETURN_KEY, JSON.stringify({ pay: 'cancel', order: 'TA261026-120000-AAAAAAAA', t: 'pt', owner: 'rid_a' }));
  for (const nt of [{ kind: 'payment_failed', clearable: false }, { kind: 'confirming' }, { kind: 'existing_order' }, { kind: 'offline' }]) {
    assert.equal(SH.settleHandoff(st, nt), false, `🔴 ${JSON.stringify(nt)} keeps the handoff (not terminal)`); assert.ok(J(st, SH.RETURN_KEY), `🔴 ${JSON.stringify(nt)} keeps the handoff`);
  }
  assert.equal(SH.settleHandoff(st, { kind: 'payment_failed', state: 'cancelled' }), true, 'a definitive failure is terminal');
  st.setItem(SH.RETURN_KEY, JSON.stringify({ pay: 'cancel', order: 'TA261026-120000-AAAAAAAA', t: 'pt', owner: 'rid_a' }));
  st.fail.write.add(K.pay);
  assert.equal(SH.transferHandoff(st, J(st, SH.RETURN_KEY), 'GEN_A'), false); assert.ok(J(st, SH.RETURN_KEY), 'an unverified transfer keeps it');
  st.fail.write.delete(K.pay);
  assert.equal(SH.transferHandoff(st, J(st, SH.RETURN_KEY), 'GEN_A'), true);
  assert.deepEqual([J(st, SH.RETURN_KEY), J(st, K.pay).t, J(st, K.pay).cart_gen, J(st, K.pay).rid], [null, 'pt', 'GEN_A', 'rid_a']);
  for (const t of [{ kind: 'placed' }, { kind: 'refunded' }, { kind: 'scheduled_review' }, { kind: 'paid_unverified' }]) assert.equal(SH.isTerminal(t), true);
});
