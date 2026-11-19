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

(async () => {
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

  // ── 4. r1 (Codex #172 P1-a): the hosted ownership decision precedes EVERY order-dependent admission and bookkeeping write — the
  // probe is the SAME single read, hoisted to the first point the verified uid is known (no read added) ──
  const H0 = SRC.indexOf("chargeOnlineApp.all('*', async (req, res) => {"); const H1 = SRC.indexOf('exports.chargeOnlineOrder = onRequest(', H0);
  const H = SRC.slice(H0, H1);
  const PROBE = "probeOrder = (await db.ref(`orders/${orderId}`).once('value')).val();";
  assert.strictEqual(H.split(PROBE).length - 1, 1, '🔴 OWN-HOSTED-ONE-READ: the probe read occurs exactly once in the handler (moved, never duplicated)');
  const own = H.indexOf("require('./order-owner').ownerOf(probeOrder, customer_uid) === 'non_owner'");
  assert.ok(own > H.indexOf('if (cappGuest && cappGuest.refuse)'), 'premise: after the verified uid (and the capp-guest gate) are resolved');
  for (const [label, at] of [
    ['the bound-reuse probe', 'BR.probeBoundReuse(db'], ['the redemption prepare', 'prepareRedemption(db, {'], ['the delivery context (order_context_changed)', 'DW.chargeContext(db, orderId'],
    ['classify (binding_format_invalid)', 'classifyHostedAttempt(db, orderId, fingerprintG'], ['the pre-bookkeeping resume check', 'DW.preBookkeepingRefusal(db, orderId'],
    ['the content stamp', 'await cbase.child(ck).set('], ['the rate limits', 'checkRateLimit(db, bucket, key, cfg)'], ['the audience stamp', "require('./marketing/audience-place').stampCard(db"],
  ]) {
    const i = H.indexOf(at);
    assert.ok(i !== -1, `marker ${at}`);
    assert.ok(own < i, `🔴 OWN-HOSTED-FIRST: ownership is decided before ${label}`);
  }
  ok('chargeOnlineOrder: the ONE probe read, hoisted — ownership decided before bound reuse, the redemption prepare, the delivery context, classify, the resume check, the content stamp, the rate limits and the audience stamp');

  // ── 5. r1 (Codex #172 P1-b): acquireHostedAttempt applies the SAME ownerOf to every order record it observes — the pre-read, inside
  // the CAS, and the authoritative record after it — so the probe→acquire race never hands a foreign member the owner's checkout.
  // The REAL acquire over the honest RTDB model (rule 29). The pending record carries customer_uid exactly as the handler writes it
  // (`...(customer_uid ? { customer_uid } : {})`, index.js: not require-safe) ──
  const { makeHonestDb } = require('./_honest-rtdb-model');
  const { acquireHostedAttempt } = require('./pixelpay-hosted-charge');
  const T = 1.8e12, FPX = 'fp-own', OID = 'XPZ-OWN';
  const pend = (uid) => ({ order_id: OID, status: 'pending_payment', payment_status: 'pending', total_cents: 1000, created_at: 1, ...(uid ? { customer_uid: uid } : {}) });
  const FOREIGN = { outcome: 'conflict', reason: NON_OWNER_REASON };   // the handler maps it to the constant 409 (acquireRefusal)
  const liveUp = async (db, aid) => db.ref(`payment_attempts/${aid}`).update({ hosted_state: 'created', hosted_checkout_url: 'https://pay.test/A', hosted_expires_at: T + 3600e3 });
  // (a) Codex's race: B's probe saw NO order; A creates it (and its live checkout) while B is between its pre-read and its CAS
  {
    let inA = false, afterA = null, aRes = null;
    const db = makeHonestDb({}, { beforeTx: async (p, api) => {
      if (p !== `orders/${OID}` || inA || afterA) return;
      inA = true; aRes = await acquireHostedAttempt(api, OID, pend(U1), FPX, T); await liveUp(api, aRes.attempt_id); inA = false;
      afterA = JSON.stringify(api.root);
    } });
    const b = await acquireHostedAttempt(db, OID, pend(U2), FPX, T + 1);
    assert.strictEqual(aRes && aRes.outcome, 'claimed', 'premise: A created the order inside B\'s window');
    assert.deepStrictEqual(b, FOREIGN, '🔴 OWN-ACQ-RACE: B (another verified member) whose probe saw no order is refused at the re-read — never A\'s checkout_url / poll_token');
    assert.strictEqual(JSON.stringify(db.root), afterA, '🔴 OWN-ACQ-RACE: B wrote nothing (A\'s order and attempt byte-identical)');
  }
  // (b) the pre-read: B learns nothing about A's order in ANY state, and touches nothing (no install / recover / rotate)
  for (const [state, set] of [
    ['a live checkout (reuse)', async () => {}], ['in flight', async (db, aid) => db.ref(`payment_attempts/${aid}/hosted_state`).set('creating')],
    ['paid', async (db) => db.ref(`orders/${OID}/payment_status`).set('confirmed')], ['a failed attempt (rotate)', async (db, aid) => db.ref(`payment_attempts/${aid}/hosted_state`).set('failed_create')],
    ['a missing attempt (recover)', async (db, aid) => db.ref(`payment_attempts/${aid}`).remove()], ['no attempt pointer (install)', async (db) => db.ref(`orders/${OID}/active_attempt_id`).remove()],
  ]) {
    const db = makeHonestDb({});
    const a = await acquireHostedAttempt(db, OID, pend(U1), FPX, T); await liveUp(db, a.attempt_id); await set(db, a.attempt_id);
    const before = JSON.stringify(db.root);
    assert.deepStrictEqual(await acquireHostedAttempt(db, OID, pend(U2), FPX, T + 1), FOREIGN, `🔴 OWN-ACQ-PREREAD: ${state} — B is refused before any answer about A's order`);
    assert.strictEqual(JSON.stringify(db.root), before, `🔴 OWN-ACQ-PREREAD: ${state} — B wrote nothing`);
  }
  // (c) INSIDE the CAS: B's pre-read showed B's own order (a failed attempt ⇒ rotate / a missing one ⇒ recover); the server record is
  // A's when the transaction runs — the CAS is a no-op and the authoritative record refuses, no payment_attempts row written
  for (const [kind, prep] of [['rotate', async (db, aid) => db.ref(`payment_attempts/${aid}/hosted_state`).set('failed_create')], ['recover', async (db, aid) => db.ref(`payment_attempts/${aid}`).remove()]]) {
    let flipped = false, before = null;
    const db = makeHonestDb({}, { beforeTx: async (p, api) => {
      if (p !== `orders/${OID}` || flipped || !before) return;
      flipped = true; await api.ref(`orders/${OID}/customer_uid`).set(U1); before = JSON.stringify(api.root);
    } });
    const a = await acquireHostedAttempt(db, OID, pend(U2), FPX, T); await prep(db, a.attempt_id); before = 'armed';
    const got = await acquireHostedAttempt(db, OID, pend(U2), FPX, T + 1);
    assert.ok(flipped, `premise (${kind}): the server record became A's between B's pre-read and its CAS`);
    assert.deepStrictEqual(got, FOREIGN, `🔴 OWN-ACQ-CAS: ${kind} — the authoritative record refuses B`);
    assert.strictEqual(JSON.stringify(db.root), before, `🔴 OWN-ACQ-CAS: ${kind} — nothing rotated, recovered or claimed inside the CAS`);
  }
  // (d) unchanged: the owner reuses; no identity / a form order ⇒ today's reuse (owner §5 = A); a member on a VERIFIED guest's order ⇒ refused
  {
    const db = makeHonestDb({});
    const a = await acquireHostedAttempt(db, OID, pend(U1), FPX, T); await liveUp(db, a.attempt_id);
    const r = await acquireHostedAttempt(db, OID, pend(U1), FPX, T + 1);
    assert.deepStrictEqual([r.outcome, r.checkout_url], ['reuse', 'https://pay.test/A'], 'OWN-ACQ-OWNER: the owner reuses its live checkout');
    assert.strictEqual((await acquireHostedAttempt(db, OID, pend(null), FPX, T + 2)).outcome, 'reuse', 'OWN-ACQ-NOIDENTITY: no identity presented ⇒ today\'s reuse (unverifiable)');
    const f = makeHonestDb({});
    const fa = await acquireHostedAttempt(f, OID, pend(null), FPX, T); await liveUp(f, fa.attempt_id);
    assert.strictEqual((await acquireHostedAttempt(f, OID, pend(U2), FPX, T + 1)).outcome, 'reuse', 'OWN-ACQ-FORMGUEST: a form order (no identity ever verified) ⇒ unverifiable ⇒ today\'s reuse (owner §5 = A)');
    const g = makeHonestDb({});
    const ga = await acquireHostedAttempt(g, OID, { ...pend(null), guest_verified: { phone: '50499990000', phone_hash: 'ph' } }, FPX, T); await liveUp(g, ga.attempt_id);
    assert.deepStrictEqual(await acquireHostedAttempt(g, OID, pend(U2), FPX, T + 1), FOREIGN, '🔴 OWN-ACQ-GUESTORDER: a member replaying a VERIFIED guest\'s order is refused');
  }
  ok('acquireHostedAttempt: ownerOf on every observed record — Codex\'s probe→acquire race, every state at the pre-read (reuse / in flight / paid / rotate / recover / install), inside the CAS (rotate / recover) — a foreign member gets the constant conflict, nothing written; owner and unverifiable unchanged');

  console.log(`\norder-owner: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
