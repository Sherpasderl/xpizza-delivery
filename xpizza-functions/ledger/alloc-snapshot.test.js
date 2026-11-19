'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1, APPROVED 11-16) — the frozen allocation snapshot, PURE: pricing mode + evidence +
// mismatch, normalize + validate, the fixed fallback. Records come from the REAL record writer (create-order-build.js
// buildCreateOrderUpdates — the cash ASAP / held / hosted pending shape). The handler paths (the snapshot riding the existing
// write, no divergence, a forms order with every optional absent through the real Firebase writer) are test/ledger-s1.emulator.
// Run: node ledger/alloc-snapshot.test.js
const assert = require('assert');
const LA = require('./alloc-snapshot');
const { buildCreateOrderUpdates } = require('../create-order-build');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const cell = (label, fn) => { try { fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); };

const OID = 'xpz_s1_1';
const TS = require('firebase-admin/database').ServerValue.TIMESTAMP;   // what the cash + hosted writers pass as `now` (index.js:1094, :1981)
const FIELDS = { customer_name: 'Ana', customer_phone: '99990000', items_text: '1x Margherita', notes: '—', payment_method: 'cash',
  address_detected: '', address_details: '', address_area: null, pickup_time: 'standard' };
const recordOf = (over = {}, fields = {}) => {
  const u = buildCreateOrderUpdates({ orderId: OID, orderType: 'pickup', now: 1763300000000, trackingToken: 'tok', total: 230, lat: null, lng: null,
    fields: { ...FIELDS, ...fields }, hubSnap: { hub_lat: 14.1, hub_lng: -87.2 }, restaurantId: 'x_pizza', priceBreakdown: { total_cents: 23000, subtotal_cents: 20000, tax_cents: 3000 },
    facturaPriced: false, cashTenderedCents: null, freeOrder: false, rewardStamp: null });
  return { ...u[`orders/${OID}`], ...over };
};
// the Firebase-validity a multi-path update enforces: no undefined / NaN / Infinity / function anywhere, no forbidden key chars
function firebaseValid(v, at = '$') {
  if (at === '$.created_at' && v && typeof v === 'object' && JSON.stringify(v) === JSON.stringify(TS)) return;   // the server-timestamp sentinel, resolved by the same write
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number') { assert.ok(Number.isFinite(v), `${at}: non-finite number`); return; }
  assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${at}: ${v === undefined ? 'undefined' : typeof v}`);
  for (const [k, x] of Object.entries(v)) { assert.ok(!/[.$#[\]/]/.test(k) && k.length > 0, `${at}: bad key ${k}`); firebaseValid(x, `${at}.${k}`); }
}
const HDR_APP = { app: 'capp', deployment: 'orders-app', build: '1', compat: 1, headerless: false };
const HDR_FORM = { app: null, deployment: null, build: null, compat: null, headerless: true };

cell('S1-MODE: the pricing MODE is the server\'s own decision — sdk (forced, trusted), app (entry_mode:app), direct (everything else)', () => {
  assert.deepStrictEqual(LA.modeOf({ sdk: true, body: {}, clientHdr: HDR_FORM }).mode, 'sdk');
  assert.deepStrictEqual(LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: HDR_APP }).mode, 'app');
  assert.deepStrictEqual(LA.modeOf({ body: {}, clientHdr: HDR_FORM }).mode, 'direct');
  assert.deepStrictEqual(LA.modeOf({ body: { entry_mode: 'direct' }, clientHdr: HDR_FORM }).mode, 'direct');
});

cell('S1-EVIDENCE: the client headers are kept as EVIDENCE (app, deployment), bounded and key-safe, never trusted', () => {
  assert.deepStrictEqual(LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: HDR_APP }).evidence, { client_app: 'capp', client_deployment: 'orders-app' });
  assert.deepStrictEqual(LA.modeOf({ body: {}, clientHdr: HDR_FORM }).evidence, { client_app: null, client_deployment: null });
  assert.deepStrictEqual(LA.modeOf({ body: {}, clientHdr: undefined }).evidence, { client_app: null, client_deployment: null });
});

cell('S1-MISMATCH: app mode with a non-app deployment, or direct mode with the app deployment ⇒ mismatch (a hand-made request); sdk never', () => {
  assert.strictEqual(LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: HDR_APP }).mismatch, false, 'app + orders-app');
  assert.strictEqual(LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { ...HDR_APP, deployment: 'orders-xpizza' } }).mismatch, true, '🔴 app + a form deployment');
  assert.strictEqual(LA.modeOf({ body: {}, clientHdr: HDR_APP }).mismatch, true, '🔴 direct + orders-app');
  assert.strictEqual(LA.modeOf({ body: {}, clientHdr: HDR_FORM }).mismatch, false, 'direct + no headers');
  assert.strictEqual(LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: HDR_FORM }).mismatch, false, 'app with NO deployment header is not a contradiction');
  assert.strictEqual(LA.modeOf({ sdk: true, body: {}, clientHdr: HDR_FORM }).mismatch, false, 'sdk is forced server-side');
});

cell('S1-COPY: the snapshot copies the money components of the record it rides with (the real writer\'s record)', () => {
  const rec = recordOf({ delivery_cents: 5000, promo_discount_cents: 1000, delivery_discount_funder: 'sherpa', tip_cents: 2000, total_cents: 29000,
    offer: { offer_id: 'of_1', rev: 2, type: 'pct', name: 'Martes 20 %', discount_cents: 4000, waived_envio_cents: 0, funded_by: 'restaurant' },
    redemption: { discount_cents: 0, model: 'add_free' }, desc_rebaja_cents: 4000 });
  const s = LA.snapshotOf(rec, LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: HDR_APP }));
  assert.deepStrictEqual(s, { v: 1, mode: 'app', mismatch: false, evidence: { client_app: 'capp', client_deployment: 'orders-app' }, rid: 'x_pizza',
    created_at: 1763300000000, payment_method: 'cash', order_type: 'pickup', total_cents: 29000,
    food: { subtotal_cents: 20000, tax_cents: 3000, desc_rebaja_cents: 4000 },
    envio: { delivery_cents: 5000, promo_discount_cents: 1000, delivery_discount_funder: 'sherpa' }, tip_cents: 2000,
    offer: { offer_id: 'of_1', rev: 2, type: 'pct', name: 'Martes 20 %', discount_cents: 4000, waived_envio_cents: 0 },
    reward_discount_cents: 0 });
});

// chore/drop-funded-by-5f (BACKLOG B; the PRE-REQ for the audience switch ON): WHO funds a discount is answered ONLY by marketing/offer-price
// offerFunder (offer_reconcile decides an audience-'new' grant), so the frozen snapshot never carries the order's funded_by — a ledger reader
// can't pay a mis-granted «nuevo» from the restaurant off it. The record DOES carry it (the real writer's frozen offer); the snapshot drops it.
cell('S1-NO-FUNDER: the snapshot never copies the offer\'s funded_by (offerFunder is the one funder reader)', () => {
  for (const funded_by of ['restaurant', 'sherpa']) {
    const s = LA.snapshotOf(recordOf({ offer: { offer_id: 'of_1', rev: 2, type: 'pct', name: 'x', discount_cents: 4000, waived_envio_cents: 0, funded_by, audience: 'new', audience_kind: 'new' } }), LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
    assert.ok(s.offer && s.offer.offer_id === 'of_1', 'premise: the offer is snapshotted');
    assert.ok(!('funded_by' in s.offer), `🔴 S1-NO-FUNDER: the snapshot copied funded_by=${funded_by}`);
    assert.ok(!JSON.stringify(s).includes('funded_by'), '🔴 S1-NO-FUNDER: no funded_by anywhere in the snapshot');
  }
});

cell('S1-FORMS-ABSENT: a plain FORM order (no envío, no tip, no offer, no reward, no rebaja) ⇒ every optional is null, the whole snapshot is Firebase-valid', () => {
  const s = LA.snapshotOf(recordOf(), LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  firebaseValid(s);
  assert.deepStrictEqual([s.food.desc_rebaja_cents, s.envio.delivery_cents, s.envio.promo_discount_cents, s.envio.delivery_discount_funder, s.tip_cents, s.offer, s.reward_discount_cents],
    [null, null, null, null, null, null, null], '🔴 S1-FORMS-ABSENT: absent optionals are null, never undefined');
  assert.ok(!JSON.stringify(s).includes('undefined'));
});

cell('S1-NORMALIZE: malformed record values never reach the write — non-integers ⇒ 0 (required) / null (optional); unsafe strings ⇒ null; unknown offer keys dropped', () => {
  const s = LA.snapshotOf(recordOf({ total_cents: '23000', tip_cents: 12.5, delivery_cents: NaN, restaurant_id: 'x/pizza', delivery_discount_funder: { x: 1 },
    offer: { offer_id: 'of_1', rev: 1, type: 'pct', name: 'x', discount_cents: Infinity, waived_envio_cents: 0, funded_by: 'restaurant', extra: { evil: undefined } } }),
  LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  firebaseValid(s);
  assert.deepStrictEqual([s.total_cents, s.tip_cents, s.envio.delivery_cents, s.rid, s.envio.delivery_discount_funder, s.offer.discount_cents, 'extra' in s.offer],
    [0, null, null, null, null, 0, false]);
});

cell('S1-FALLBACK: a builder throw (a hostile getter) ⇒ the fixed valid { v:1, mode:"unknown" } — the order write can never fail because of the snapshot', () => {
  const evil = recordOf(); Object.defineProperty(evil, 'total_cents', { get() { throw new Error('boom'); }, enumerable: true });
  const s = LA.snapshotOf(evil, LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  assert.deepStrictEqual(s, { v: 1, mode: 'unknown' }, '🔴 S1-FALLBACK');
  assert.deepStrictEqual(LA.snapshotOf(null, null), { v: 1, mode: 'unknown' });
  firebaseValid(LA.FALLBACK);
});

cell('S1-TIMESTAMP (Codex #110): the REAL writers pass created_at = ServerValue.TIMESTAMP — the snapshot carries the SAME sentinel (the same atomic write resolves it), never 0', () => {
  const rec = recordOf({ created_at: TS });
  const s = LA.snapshotOf(rec, LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  assert.deepStrictEqual(s.created_at, { '.sv': 'timestamp' }, '🔴 S1-TIMESTAMP: the sentinel is carried, not normalized to a number');
  assert.notStrictEqual(s.mode, 'unknown', 'S1-TIMESTAMP: a valid snapshot, not the fallback');
  firebaseValid(s);
  for (const bad of [0, -5, 1.5, '1763300000000', { '.sv': 'increment' }, { '.sv': 'timestamp', x: 1 }, null, undefined]) {
    assert.deepStrictEqual(LA.snapshotOf(recordOf({ created_at: bad }), LA.modeOf({ body: {}, clientHdr: HDR_FORM })), LA.FALLBACK, `🔴 S1-TIMESTAMP: created_at ${JSON.stringify(bad)} ⇒ the quarantined fallback`);
  }
});

cell('S1-COMMITTED-AT (Codex #110): withCommittedCreatedAt swaps the sentinel for the committed order timestamp the hosted claim already has; a missing one ⇒ the fallback', () => {
  const s = LA.snapshotOf(recordOf({ created_at: TS }), LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  assert.strictEqual(LA.withCommittedCreatedAt(s, 1763300000123).created_at, 1763300000123, '🔴 S1-COMMITTED-AT');
  assert.deepStrictEqual(LA.withCommittedCreatedAt(s, undefined), LA.FALLBACK, '🔴 S1-COMMITTED-AT: no committed time ⇒ fallback');
  const num = LA.snapshotOf(recordOf(), LA.modeOf({ body: {}, clientHdr: HDR_FORM }));
  assert.strictEqual(LA.withCommittedCreatedAt(num, 1), num, 'a numeric created_at is kept as is');
  assert.strictEqual(LA.withCommittedCreatedAt(null, 1), null);
});

cell('S1-VALIDATE: validate() rejects undefined, NaN, Infinity, functions and arrays anywhere', () => {
  for (const bad of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: () => 1 }, { a: [1] }, { a: { b: undefined } }]) assert.throws(() => LA.validate(bad), /ledger snapshot/);
  LA.validate({ a: null, b: 1, c: 'x', d: { e: true } });
});

cell('S1-SIZE: the largest real snapshot (offer + envío + tip + reward + evidence) is ≤ 1 KiB', () => {
  const s = LA.snapshotOf(recordOf({ delivery_cents: 70000, promo_discount_cents: 70000, delivery_discount_funder: 'sherpa', tip_cents: 200000, total_cents: 999999999,
    offer: { offer_id: 'of_' + 'x'.repeat(60), rev: 999, type: 'nuevos', name: 'N'.repeat(80), discount_cents: 999999, waived_envio_cents: 70000, funded_by: 'restaurant', audience: 'new', audience_kind: 'new' },
    redemption: { discount_cents: 99999 }, desc_rebaja_cents: 999999 }), LA.modeOf({ body: { entry_mode: 'app' }, clientHdr: { ...HDR_APP, app: 'a'.repeat(32), deployment: 'd'.repeat(32) } }));
  const bytes = Buffer.byteLength(JSON.stringify(s));
  assert.ok(bytes <= 1024, `🔴 S1-SIZE: ${bytes} bytes`);
});

cell('S1-PATH: the private path is ledger_alloc/{orderId} (server-only: no rule, the root grants nothing)', () => {
  assert.strictEqual(LA.allocPath('xpz_1'), 'ledger_alloc/xpz_1');
});
console.log(`alloc-snapshot: OK (${n})`);
