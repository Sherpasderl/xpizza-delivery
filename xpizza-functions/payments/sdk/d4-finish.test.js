'use strict';
// D4 §A2 B4 + §A4 (PLAN-sdk-d4-r11) — the SDK finish (payments/sdk/finish.js), called by chargeOnlineOrder's handler in SDK mode
// right where hosted calls acquireHostedAttempt, with the SAME intake snapshot:
//   1. freshIssueRefusal over hosted's captured flags ⇒ hosted's answer for that outcome (answerRefusal, shared with hosted);
//   2. replaces_order_id / the saved card ⇒ refused BEFORE any write;  3. enrol-first;  4. the create-once order transaction with
//   hosted acquisition's checks (flow, owner / guest phone, tip, fingerprint, open) + the post-commit re-check;  5. re-enrol;
//   6. the hosted gate (runGate) at the STORED total;  7. the C6 subject claim;  8. placeOriginal at the STORED total;  9. the §2.4
//   answer (status-endpoint.answerOrder).
// The pending record is the handler's (index.js) input; the emulator suite drives it through the real export.
// Run: node payments/sdk/d4-finish.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const C = require('./coordinator');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const FIN = () => require('./finish');
const T0 = 1_000_000;
const OID = 'tb_finish_1';
const RID = 'tb_rest';
const ATT = 'att_finish_cell_00001';
const NEW_CARD = { kind: 'new', sdk_token: 'tok_new', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } };
const pending = (o = {}) => ({ order_id: OID, restaurant_id: RID, status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'pickup',
  customer_name: 'Ana Pérez', customer_phone: '+50499990000', items_text: '1x Pizza', total: 100, total_cents: 10000, subtotal_cents: 8696, tax_cents: 1304, created_at: T0, ...o });
const NO_FLAGS = { controlRefuseFresh: false, menuRefuseFresh: false, choiceRefuseFresh: false, extrasRefuseFresh: null, cartBlocked: [], refuseFresh: false, payerRefuseFresh: false };

function world({ seed = {}, script = {}, hooks = {} } = {}) {
  let t = T0;
  const db = makeHonestDb({ platform_config: { sdk_pay: { available: true, restaurants: { [RID]: true } } }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script);
  const golive = [];
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', releaseResources: async () => {}, goLive: async (dp, id) => { golive.push(id); } };
  return { db, fake, deps, golive, tick: (ms) => { t += ms; }, ord: () => db.getAt(`orders/${OID}`) };
}
const answers = [];
const answerRefusal = (r) => { answers.push(r); return { status: 'REFUSAL', body: r }; };
const ctx = (w, o = {}) => ({ orderId: OID, kind: 'member', uid: 'uid_A', guestPhoneHash: null, attemptId: ATT, card: NEW_CARD, replacesOrderId: null,
  pendingOrderRecord: pending({ customer_uid: 'uid_A' }), fingerprint: 'fp_cart_1', tipCents: 0, flags: NO_FLAGS, nowTs: T0,
  runGate: async () => ({ refuse: null, provenance: null }), answerRefusal, ...o });
const FINISH = (w, o) => FIN().finishSdk(w.deps, ctx(w, o));
const snap = (w) => JSON.stringify(w.db.root);

(async () => {
  await cell('SDK-D4-DEFERRED-GATES', async (L) => {
    // each deferred refusal ⇒ hosted's answer (answerRefusal) for THAT outcome; zero writes, zero PSP calls
    for (const [k, v, want] of [['controlRefuseFresh', true, 'order_control'], ['menuRefuseFresh', true, 'menu_updating'], ['choiceRefuseFresh', true, 'choice_required'],
      ['extrasRefuseFresh', 'extra_not_allowed', 'extra_not_allowed'], ['cartBlocked', ['tb_86'], 'item_unavailable'], ['refuseFresh', true, 'client_update_race'], ['payerRefuseFresh', true, 'payer_email_unconfigured']]) {
      const w = world(); const before = snap(w);
      const r = await FINISH(w, { flags: { ...NO_FLAGS, [k]: v } });
      const got = r.body && (r.body.reason || r.body.outcome);
      assert.ok(r.status === 'REFUSAL' && got === want && r.body.outcome === require('../../pixelpay-hosted-charge').freshIssueRefusal({ ...NO_FLAGS, [k]: v }).outcome, `${L}: ${k} ⇒ hosted's ${want} answer (got ${JSON.stringify(r)})`);
      assert.ok(snap(w) === before && w.fake.callCount('authorize') === 0, `${L}: ${k}: zero writes, zero PSP calls`);
    }
  });

  await cell('SDK-D4-FINISH-PLACES', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    const r = await FINISH(w);
    const o = w.ord();
    assert.ok(o && o.payment_flow === 'sdk_auth_v1' && o.pay_deadline_at === T0 + 15 * 60 * 1000 && o.payment_fingerprint === 'fp_cart_1' && o.customer_uid === 'uid_A', `${L}: the create-once order (flow, deadline, fingerprint, owner) (${JSON.stringify(o)})`);
    assert.ok(o.payment_placed && w.golive.length === 1 && r.status === 200 && ['placed', 'bank_pending'].includes(r.body.outcome), `${L}: approved ⇒ placed, go-live driven, the §2.4 answer (${JSON.stringify(r)})`);
    assert.strictEqual(w.fake.calls.find((c) => c.action === 'authorize').amount_cents, 10000, `${L}: placeOriginal charged the STORED total`);
    assert.strictEqual(w.db.getAt('sdk_checkout_subject/u_uid_A'), null, `${L}: a placed answer releases the C6 subject`);
  });

  await cell('SDK-D4-REENROL-AFTER-COMMIT', async (L) => {
    // a sweep RETIRES the enrol-first entry while the create is delayed (Codex r10's W1 shape): only the re-enrol right after the
    // commit can put it back before the gate refuses
    let retired = false;
    const w = world({ hooks: { beforeTx: async (p, api) => { if (p === `orders/${OID}` && !retired) { retired = true; api.setAt(`payment_sdk_due/${OID}`, null); } } } });
    const r = await FINISH(w, { runGate: async () => ({ refuse: { status: 409, body: { error: 'quote_stale' } } }) });
    assert.ok(retired, `${L}: premise — the entry was retired during the create`);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'quote_stale' } }, `${L}: a gate refusal ⇒ hosted's gate answer`);
    assert.ok(w.ord() && w.ord().status === 'pending_payment' && w.db.getAt(`payment_sdk_due/${OID}`) != null, `${L}: the due entry is present (re-enrolled BEFORE the gate); the order stays pending`);
    assert.ok(w.fake.callCount('authorize') === 0 && w.db.getAt(`payment_sdk/${OID}`) == null, `${L}: no attempt, no record, no money`);
  });

  await cell('SDK-D4-GATE-AT-STORED-TOTAL', async (L) => {
    let gated = null;
    const w = world({ seed: { orders: { [OID]: { ...pending({ customer_uid: 'uid_A', total_cents: 10000 }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_cart_1' } } }, script: { authorize: [{ outcome: 'approved' }] } });
    await FINISH(w, { pendingOrderRecord: pending({ customer_uid: 'uid_A', total_cents: 12345 }), runGate: async (cents) => { gated = cents; return { refuse: null, provenance: null }; } });
    assert.strictEqual(gated, 10000, `${L}: the gate runs at the STORED order's total (a reused order keeps its stored economics)`);
    const auth = w.fake.calls.find((c) => c.action === 'authorize');
    assert.ok(auth && auth.amount_cents === 10000, `${L}: the attempt is charged the STORED total, never the request's (${JSON.stringify(auth)})`);
  });

  await cell('SDK-D4-CREATE-ONCE-CONFLICTS', async (L) => {
    const sdk = (o) => ({ ...pending({ customer_uid: 'uid_A' }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_cart_1', ...o });
    for (const [label, existing, extra, want] of [
      ['a hosted / cash order under the id', { ...pending({ customer_uid: 'uid_A' }), payment_fingerprint: 'fp_cart_1' }, {}, 'conflict'],
      ['another member\'s SDK order', sdk({ customer_uid: 'uid_B' }), {}, 'conflict'],
      ['a changed cart (fingerprint ⇒ hosted\'s neutral conflict)', sdk({ payment_fingerprint: 'fp_other' }), {}, 'conflict'],
      ['a changed tip', sdk({ tip_cents: 500 }), {}, 'tip'],
      ['a placed SDK order', sdk({ payment_placed: { leg_id: 'L1', at: T0 }, status: 'new' }), {}, 'closed'],
      ['a cancelled SDK order', sdk({ payment_cancel: { kind: 'cancel', at: T0 } }), {}, 'closed'],
    ]) {
      const w = world({ seed: { orders: { [OID]: existing } } }); const before = JSON.stringify(w.ord());
      const r = await FINISH(w, extra);
      const reason = r.body && (want === 'closed' ? r.body.outcome : (r.body.reason || r.body.outcome));   // a closed answer carries the order's state as its reason (as hosted's)
      assert.ok(r.status === 'REFUSAL' && (reason === want || (want === 'conflict' && r.body.outcome === 'conflict')), `${L}: ${label} ⇒ the ${want} answer (got ${JSON.stringify(r)})`);
      assert.ok(JSON.stringify(w.ord()) === before && w.fake.callCount('authorize') === 0, `${L}: ${label}: the existing order untouched, zero PSP calls`);
    }
    // a guest: a foreign verified phone never mutates or answers about the order
    const gv = (h) => ({ phone: '50499990000', phone_hash: h });
    const w = world({ seed: { orders: { [OID]: { ...pending({ guest_verified: gv('h_other') }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_cart_1' } } } });
    const r = await FINISH(w, { kind: 'guest', uid: null, guestPhoneHash: 'h_me', pendingOrderRecord: pending({ guest_verified: gv('h_me') }) });
    assert.ok(r.status === 'REFUSAL' && r.body.reason === 'guest_phone', `${L}: a guest on another guest's order ⇒ guest_phone (got ${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-FINISH-REUSE', async (L) => {
    // the caller's own pending SDK order, same cart ⇒ reused with NO order write; a new attempt places
    const existing = { ...pending({ customer_uid: 'uid_A' }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_cart_1' };
    const w = world({ seed: { orders: { [OID]: existing } }, script: { authorize: [{ outcome: 'approved' }] } });
    const r = await FINISH(w);
    const o = w.ord();
    assert.ok(o.pay_deadline_at === T0 + 9e5 && o.payment_placed && r.status === 200, `${L}: reused (its own deadline kept) and placed (${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-SAVED-CARD-BEFORE-WRITES', async (L) => {
    for (const label of ['absent', 'foreign']) {
      const w = world({ seed: label === 'foreign' ? { customer_cards: { uid_B: { cards: { ['c'.repeat(20)]: { token: 'T-B', token_hash: 'h', brand: 'visa', last4: '1111', exp_month: 12, exp_year: 2030 } } } } } : {} });
      const before = snap(w);
      const r = await FINISH(w, { card: { kind: 'saved', card_id: 'c'.repeat(20) } });
      assert.deepStrictEqual(r, { status: 409, body: { error: 'saved_card_unavailable' } }, `${L}: ${label} ⇒ 409 saved_card_unavailable`);
      assert.ok(snap(w) === before && w.fake.callCount('authorize') === 0, `${L}: ${label}: BEFORE any write or PSP call`);
    }
    const w = world({ seed: { customer_cards: { uid_A: { cards: { ['d'.repeat(20)]: { token: 'T-A', token_hash: 'hA', brand: 'mastercard', last4: '5555', exp_month: 11, exp_year: 2031 } } } } }, script: { authorize: [{ outcome: 'approved' }] } });
    await FINISH(w, { card: { kind: 'saved', card_id: 'd'.repeat(20) } });
    const a = w.fake.calls.find((c) => c.action === 'authorize');
    const att = w.db.getAt(`payment_sdk/${OID}/attempts/${ATT}`);
    assert.ok(a && a.token === 'T-A' && att.card_ref === `saved:${'d'.repeat(20)}` && att.display.last4 === '5555', `${L}: the caller's saved card is resolved SERVER-side (token, card_ref, display)`);
  });

  await cell('SDK-D4-REPLACES-UNRESOLVED', async (L) => {
    const other = { order_id: 'tb_prev_1', ...pending({ customer_uid: 'uid_A' }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_prev' };
    const w = world({ seed: { orders: { tb_prev_1: other } } }); const before = snap(w);
    const r = await FINISH(w, { replacesOrderId: 'tb_prev_1' });
    assert.ok(r.status === 409 && r.body.error === 'previous_payment_unresolved' && snap(w) === before, `${L}: the caller's UNRESOLVED SDK order ⇒ 409, before any write (${JSON.stringify(r)})`);
    const w2 = world({ seed: { orders: { tb_prev_1: { ...other, customer_uid: 'uid_B' } } }, script: { authorize: [{ outcome: 'approved' }] } });
    const r2 = await FINISH(w2, { replacesOrderId: 'tb_prev_1' });
    assert.ok(r2.status === 200 && w2.db.getAt('orders/tb_prev_1/customer_uid') === 'uid_B', `${L}: a foreign order named ⇒ ignored (A2): an ordinary new order, nothing changed (${JSON.stringify(r2)})`);
  });

  await cell('SDK-D4-SUBJECT-CONFLICT', async (L) => {
    const other = { ...pending({ customer_uid: 'uid_A', order_id: 'tb_prev_2' }), payment_flow: 'sdk_auth_v1', pay_deadline_at: T0 + 9e5, payment_fingerprint: 'fp_prev' };
    const w = world({ seed: { orders: { tb_prev_2: other }, sdk_checkout_subject: { u_uid_A: { order_id: 'tb_prev_2', at: T0 } } } });
    const r = await FINISH(w);
    assert.ok(r.status === 409 && r.body.error === 'previous_payment_unresolved', `${L}: another UNRESOLVED checkout holds the subject ⇒ 409 (${JSON.stringify(r)})`);
    assert.ok(w.db.getAt(`orders/${OID}/payment_cancel/kind`) === 'cancel' && w.fake.callCount('authorize') === 0, `${L}: THIS request's own fresh pending order is cancelled pending-only; no money asked`);
  });

  await cell('SDK-D4-CONCURRENT-SAME-ID', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved' }, { outcome: 'approved' }] } });
    const [a, b] = await Promise.all([FINISH(w), FINISH(w)]);
    assert.ok(w.fake.callCount('authorize') <= 1 && w.ord().payment_placed, `${L}: one order, at most ONE authorization dispatched (${JSON.stringify([a, b])})`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-finish: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
