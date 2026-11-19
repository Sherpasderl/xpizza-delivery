'use strict';
// PLAN-3a-order-owner r0 (advisor APPROVED 2026-11-18; owner §5 = A; rule 6c) — a replayed order_id never hands a DIFFERENT verified
// identity the order's capabilities. The orders here are written by the REAL create builders (buildCreateOrderUpdates +
// attachCustomerAttribution — the member stamp); the capp guest's `guest_verified` is the field chargeOnlineOrder writes in the same
// CAS (index.js, §2.3). index.js is not require-safe (initializeApp at load), so the two call sites are pinned structurally (the
// createorder-idempotent pattern); the over-HTTP cells run in test/order-owner.emulator.test.js at the slot.
// Run: node order-owner.test.js
const fs = require('fs');
const assert = require('assert');
const { ownerOf, NON_OWNER_REASON } = require('./order-owner');
const { buildCreateOrderUpdates, attachCustomerAttribution } = require('./create-order-build');
const { orderBreakdownCents } = require('./order-money');
const OE = require('./order-exists');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const U1 = 'u_' + 'a'.repeat(24), U2 = 'u_' + 'b'.repeat(24);
const ID = 'XP-261118-120000-ABCDEFGH';

// a cash order exactly as createOrder writes it; `uid` ⇒ the REAL attribution stamp (a member order)
function realOrder(uid) {
  const updates = buildCreateOrderUpdates({
    orderId: ID, orderType: 'delivery', now: 1, trackingToken: 'trk_secret', total: 250,
    lat: 14.09, lng: -87.18, fields: { customer_name: 'Ana', customer_phone: '+50499990000', items_text: '1x Pizza', notes: '—', payment_method: 'cash', address_detected: 'a', address_details: 'b' },
    hubSnap: { hub_lat: 0, hub_lng: 0, restaurant_name: 'R', restaurant_phone: 'p' },
    restaurantId: 'x_pizza', priceBreakdown: orderBreakdownCents(250, 'x_pizza'),
    facturaPriced: { items: null, factura_items: null }, cashTenderedCents: 0, freeOrder: false, rewardStamp: {},
  });
  attachCustomerAttribution(updates, ID, uid || null, { now: 1, total: 250, orderType: 'delivery', items_text: '1x Pizza', restaurantId: 'x_pizza', items: [], tables: null });
  return updates[`orders/${ID}`];
}

(() => {
  // ── 1. the predicate: ONLY a different VERIFIED identity is non_owner ──
  const member = realOrder(U1); const formGuest = realOrder(null);
  assert.strictEqual(member.customer_uid, U1, 'premise: the REAL attribution stamped the member');
  assert.ok(!('customer_uid' in formGuest), 'premise: a form guest\'s order carries no identity');
  const cappGuest = { ...realOrder(null), guest_verified: { phone: '50499990000', phone_hash: 'ph' } };   // chargeOnlineOrder's §2.3 field
  assert.strictEqual(ownerOf(member, U1), 'owner', '🔴 OWN-MEMBER: the same verified uid ⇒ owner');
  assert.strictEqual(ownerOf(member, U2), 'non_owner', '🔴 OWN-FOREIGN: another verified uid ⇒ non_owner');
  for (const none of [null, undefined, '']) {
    assert.strictEqual(ownerOf(member, none), 'unverifiable', `🔴 OWN-NOIDENTITY: a member order replayed with no identity (${JSON.stringify(none)}) ⇒ unverifiable (the forms' 1.5 s token timeout — rule 27)`);
  }
  assert.strictEqual(ownerOf(cappGuest, U1), 'non_owner', '🔴 OWN-FOREIGN: a member replaying a VERIFIED guest\'s order ⇒ non_owner');
  assert.strictEqual(ownerOf(cappGuest, null), 'unverifiable', 'a verified guest\'s order, no identity presented (its ticket is checked by chargeGate) ⇒ unverifiable');
  assert.strictEqual(ownerOf(formGuest, U1), 'unverifiable', '🔴 OWN-FORMGUEST: a form guest\'s order (no identity ever verified) ⇒ unverifiable, whoever asks (owner §5 = A)');
  assert.strictEqual(ownerOf(formGuest, null), 'unverifiable', 'a form guest\'s order, no identity ⇒ unverifiable');
  ok('ownerOf: same verified uid ⇒ owner; another verified uid, or a member on a verified guest\'s order ⇒ non_owner; no identity presented, or a form guest\'s order ⇒ unverifiable');

  // ── 2. the refusal is ONE constant body, whatever the order's state ──
  assert.ok(OE.ORDER_EXISTS_REASONS.has(NON_OWNER_REASON) && NON_OWNER_REASON === 'conflict', 'premise: the neutral reason of the closed enum');
  ok('the non_owner refusal is the typed 409 order_exists with the neutral reason (the forms\' G2 screen; no state disclosed)');

  // ── 3. the two call sites (structural: index.js is not require-safe) ──
  const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const between = (a, b) => { const i = SRC.indexOf(a); const j = SRC.indexOf(b, i); assert.ok(i !== -1 && j !== -1, `markers ${a} … ${b}`); return SRC.slice(i, j); };
  // createOrder: the predicate runs on the existing order BEFORE the classifier; non_owner ⇒ the constant 409; the idempotent 200's
  // token is the OWNER's only
  const co = between("const existing = await db.ref(`orders/${orderId}`).once('value');", "return res.status(200).json({ ok: true, idempotent: true");
  const coOwn = co.indexOf("require('./order-owner').ownerOf(ev, customer_uid)");
  assert.ok(coOwn !== -1, '🔴 OWN-CASH: createOrder runs ownerOf(ev, customer_uid) on the existing order');
  assert.ok(coOwn < co.indexOf('computeCanonicalIncomingFingerprint(') && coOwn < co.indexOf('classifyExistingOrder('), '🔴 OWN-CASH-FIRST: before every recompute and the classifier (a non_owner learns no state)');
  assert.ok(/=== 'non_owner'\) return res\.status\(409\)\.json\(OE\.orderExistsBody\(require\('\.\/order-owner'\)\.NON_OWNER_REASON, orderId\)\)/.test(co), '🔴 OWN-CASH: non_owner ⇒ the constant 409');
  const idem = SRC.slice(SRC.indexOf("return res.status(200).json({ ok: true, idempotent: true"), SRC.indexOf("return res.status(200).json({ ok: true, idempotent: true") + 200);
  assert.ok(/tracking_token: own === 'owner' \? \(ev\.tracking_token \|\| null\) : null/.test(idem), '🔴 OWN-CASH-TOKEN: the idempotent 200 carries the token for the OWNER only (unverifiable ⇒ null)');
  // chargeOnlineOrder: on the order the probe already read (no added I/O), beside the cross-restaurant guard, BEFORE any reserve /
  // acquire (a non_owner never touches the owner's hold or attempt)
  const probeAt = SRC.indexOf("probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();");
  const hosted = SRC.indexOf("require('./order-owner').ownerOf(probeOrder, customer_uid)", probeAt);
  assert.ok(probeAt !== -1 && hosted !== -1, '🔴 OWN-HOSTED: chargeOnlineOrder runs ownerOf(probeOrder, customer_uid) on the probe\'s snapshot');
  assert.ok(hosted < SRC.indexOf('reserveRedemption(db, { uid: customer_uid', probeAt) && hosted < SRC.indexOf('acq = await acquireHostedAttempt(', probeAt), '🔴 OWN-HOSTED-FIRST: before every reserve and acquire');
  assert.ok(/ownerOf\(probeOrder, customer_uid\) === 'non_owner'\) return res\.status\(409\)\.json\(OE\.orderExistsBody\(require\('\.\/order-owner'\)\.NON_OWNER_REASON, orderId\)\)/.test(SRC), '🔴 OWN-HOSTED: non_owner ⇒ the same constant 409');
  ok('call sites: createOrder (before every recompute + the classifier; the token for the owner only) and chargeOnlineOrder (on the probe\'s snapshot, before every reserve + acquire) — non_owner ⇒ the constant 409');

  console.log(`\norder-owner: OK (${n})`);
})();
