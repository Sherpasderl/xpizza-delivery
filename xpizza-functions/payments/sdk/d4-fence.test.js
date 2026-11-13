'use strict';
// THE SDK cancel fence (PLAN-sdk-fence-r1, APPROVED 2026-11-13; Codex plan r1 + r2) — cancelSdkPending on an ABSENT order stores
// sdk_fence/{sha256(id \n owner)} BEFORE it re-reads the order; finishSdk reads the fence before its first write and again right after
// its create-once order. Guarantee (§0a): once cancelSdkPending(X) answered safe_to_switch:true, no X authorization is ever STARTED —
// a late original, a same-attempt resend, a second device, a re-issued guest ticket, at any later time (the fence is PERMANENT).
// Everything through the REAL cores: finishSdk (create-once, the C6 subject, placeOriginal), cancelSdkPendingCore + authorizeExistingOrder,
// the coordinator, the honest RTDB model, the fake PSP that COUNTS authorizations; guest tickets from the REAL ticketRecord writer.
// Run: node payments/sdk/d4-fence.test.js
const assert = require('assert');
const crypto = require('crypto');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const G = require('../../checkout-guest-lib');
const DW = require('../../delivery/delivery-wire');
const C = require('./coordinator');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const FIN = () => require('./finish');
const SW = () => require('./switch-endpoint');
const T0 = 1_000_000;
const HOUR = 3600e3;
const RID = 'tb_r1';
const X = 'sdk_261113-120000-FENCEXAA';
const Y = 'sdk_261113-120500-FENCEYBB';
const H = crypto.createHash('sha256').update('+50499990000').digest('hex');   // a guest's verified phone hash (64 hex)
const NO_SDK = { status: 200, body: { cancelled: false, safe_to_switch: true, reason: 'no_sdk_order' } };
const NEW_CARD = (tok = 'tok_new') => ({ kind: 'new', sdk_token: tok, save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } });
const NO_FLAGS = { controlRefuseFresh: false, menuRefuseFresh: false, choiceRefuseFresh: false, extrasRefuseFresh: null, cartBlocked: [], refuseFresh: false, payerRefuseFresh: false };
const pending = (id, o = {}) => ({ order_id: id, restaurant_id: RID, status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'pickup',
  customer_name: 'Ana Pérez', customer_phone: '+50499990000', items_text: '1x Pizza', total: 150, total_cents: 15000, subtotal_cents: 13044, tax_cents: 1956, created_at: T0, ...o });

// a one-shot pause: the first matching call parks until release()
function pauseAt(match) {
  let armed = true; let rel; let mark;
  const parked = new Promise((r) => { mark = r; }); const gate = new Promise((r) => { rel = r; });
  return { parked, release: () => rel(), hook: async (p) => { if (armed && match(p)) { armed = false; mark(); await gate; } } };
}
function world({ script = {}, beforeTx = null } = {}) {
  const clock = { t: T0 };
  const db = makeHonestDb({ platform_config: { sdk_pay: { available: true, restaurants: { [RID]: true } } } }, { now: () => clock.t, ...(beforeTx ? { beforeTx } : {}) });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), clock: () => clock.t, voidEligible: () => false, ppNamespace: 'sandbox', releaseResources: async () => {},
    goLive: async (dp, id) => { await db.ref(`orders/${id}/tracking_token`).set(`tok_${id.slice(-8)}`); },   // the one field the status answer reads before «placed»
    verifyIdToken: async (x) => (x === 'idt_A' || x === 'idt_A2' ? { uid: 'uid_A' } : x === 'idt_B' ? { uid: 'uid_B' } : (() => { throw new Error('bad'); })()) };
  return { db, fake, deps, clock, auths: () => fake.callCount('authorize'), authsFor: (id) => { const atts = Object.keys(((db.getAt(`payment_sdk/${id}`) || {}).attempts) || {}); const refs = new Set(atts.map((a) => C.ppRef('sandbox', id, a))); return fake.calls.filter((c) => c.action === 'authorize' && refs.has(c.ref)).length; } };
}
// production's B4 ctx (index.js): a member, or a capp guest (guest_verified on the pending record + its phone hash)
const ctx = (w, id, o = {}) => {
  const guest = o.guest === true; const uid = o.uid || 'uid_A';
  return { orderId: id, kind: guest ? 'guest' : 'member', uid: guest ? null : uid, guestPhoneHash: guest ? H : null, attemptId: o.attemptId || 'att_fence_cell_000001', card: o.card || NEW_CARD(),
    replacesOrderId: null, pendingOrderRecord: pending(id, guest ? { guest_verified: { phone_hash: H } } : { customer_uid: uid }), fingerprint: `fp_${id}`, tipCents: 0,
    flags: o.flags || NO_FLAGS, nowTs: w.clock.t, runGate: o.runGate || (async () => ({ refuse: null, provenance: null })),
    answerRefusal: (r) => ({ status: 'REFUSAL', body: r }), deliveryResume: (ord) => DW.deliveryResumeRefusal(w.db, ord, DW.loadPricing(w.db)) };
};
const FINISH = (w, id, o) => FIN().finishSdk(w.deps, ctx(w, id, o));
const CANCEL = (w, id, h = { authorization: 'Bearer idt_A' }) => SW().cancelSdkPendingCore(w.deps, { headers: h, body: { order_id: id } });
const CLOSED = { status: 'REFUSAL', body: { outcome: 'closed', reason: 'fenced' } };
const fences = (w) => Object.values(w.db.getAt('sdk_fence') || {}).map((r) => [r.order_id, r.owner]).sort();
const cancelledX = (w, L) => {
  const o = w.db.getAt(`orders/${X}`);
  assert.ok(o && o.status === 'cancelled' && o.payment_cancel && o.payment_cancel.kind === 'cancel', `${L}: X EXISTS cancelled — marker + status (${JSON.stringify(o && { s: o.status, c: o.payment_cancel })})`);
  assert.strictEqual((w.db.getAt(`payment_sdk/${X}`) || {}).phase, 'cancelled', `${L}: X's payment record is cancelled`);
};
// the REAL ticket writer (checkout-otp's verify step): a guest's checkout ticket bound to `id`
function ticketFor(w, id, phoneHash = H) {
  const ticket = G.newTicketId();
  w.db.setAt(`checkout_tickets/${G.ticketKey(ticket)}`, G.ticketRecord({ phone: '50499990000', phoneHash, rid: RID, cartFp: 'c'.repeat(64), orderId: id, now: w.clock.t }));
  return { 'x-sherpa-order-ticket': ticket };
}
const OK_GATE = { refuse: null, provenance: null };

(async () => {
  await cell('SDK-FENCE-CANCEL-BEFORE-CREATE', async (L) => {
    // the cancel lands before the original's pre-check ⇒ the ONLY "no order, no writes" cell
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    assert.deepStrictEqual(await CANCEL(w, X), NO_SDK, `${L}: the absent answer stays the byte-identical NO_SDK_ORDER`);
    assert.deepStrictEqual(fences(w), [[X, 'u_uid_A']], `${L}: the fence (X, u_uid_A) is stored`);
    const before = JSON.stringify(w.db.root);
    const r = await FINISH(w, X);
    assert.deepStrictEqual(r, CLOSED, `${L}: the late original is refused closed (${JSON.stringify(r)})`);
    assert.strictEqual(JSON.stringify(w.db.root), before, `${L}: ZERO finishSdk writes (no payment_sdk_due, order, subject, record)`);
    assert.strictEqual(w.auths(), 0, `${L}: ZERO authorizations`);
  });

  for (const variant of ['card', 'cash']) {
    await cell(`SDK-FENCE-TWO-HOLD-${variant.toUpperCase()}`, async (L) => {
      // Codex's sequence: A parked at its create-once txn (AFTER its pre-check and enrol); the resend B refused pre-admission; the cancel
      // (absent ⇒ fenced); the switch (card: Y placed; cash: nothing SDK-side); A resumes ⇒ X EXISTS cancelled, never authorized
      const pz = pauseAt((p) => p === `orders/${X}`);
      const w = world({ script: { authorize: [{ outcome: 'approved' }] }, beforeTx: pz.hook });
      const a = FINISH(w, X, { attemptId: 'att_fence_A_00000001' });
      await pz.parked;
      const b = await FINISH(w, X, { attemptId: 'att_fence_B_00000001', flags: { ...NO_FLAGS, extrasRefuseFresh: 'extra_not_allowed' } });
      assert.ok(b.status === 'REFUSAL' && b.body.reason === 'extra_not_allowed', `premise: B refused pre-admission (${JSON.stringify(b)})`);
      assert.deepStrictEqual(await CANCEL(w, X), NO_SDK, `${L}: X absent ⇒ NO_SDK_ORDER (fenced)`);
      if (variant === 'card') {
        const y = await FINISH(w, Y, { attemptId: 'att_fence_Y_00000001' });
        assert.ok(y.status === 200 && y.body.outcome === 'placed', `premise: Y placed (${JSON.stringify(y.body)})`);
      }
      pz.release();
      assert.deepStrictEqual(await a, CLOSED, `${L}: A answers closed`);
      cancelledX(w, L);
      assert.strictEqual(w.authsFor(X), 0, `${L}: NO X authorization`);
      assert.strictEqual(w.auths(), variant === 'card' ? 1 : 0, `${L}: exactly ${variant === 'card' ? 'ONE authorization (Y\'s)' : 'ZERO authorizations'} (${w.auths()})`);
      assert.strictEqual(w.db.getAt('sdk_checkout_subject/u_uid_A'), null, `${L}: the subject is null (${variant === 'card' ? 'Y released it; ' : ''}A never claimed)`);
    });
  }

  await cell('SDK-FENCE-AFTER-24H', async (L) => {
    // Codex plan r1 P1: a pruned fence reopened the id ⇒ PERMANENT. Fence X, place Y, +72 h: the SAME attempt resent, a second device
    // (another token of the same member, another card, a new attempt) — refused, zero authorizations, the fence still there
    const w = world({ script: { authorize: [{ outcome: 'approved' }, { outcome: 'approved' }, { outcome: 'approved' }] } });
    assert.deepStrictEqual(await CANCEL(w, X), NO_SDK, 'premise: X fenced');
    const y = await FINISH(w, Y, { attemptId: 'att_fence_Y_00000001' });
    assert.ok(y.status === 200 && y.body.outcome === 'placed', 'premise: Y placed');
    w.clock.t += 72 * HOUR;
    assert.deepStrictEqual(await FINISH(w, X, { attemptId: 'att_fence_A_00000001' }), CLOSED, `${L}: +72 h, the SAME attempt_id ⇒ refused`);
    assert.deepStrictEqual(await FINISH(w, X, { attemptId: 'att_fence_D2_0000001', card: NEW_CARD('tok_device_2') }), CLOSED, `${L}: +72 h, a second device ⇒ refused`);
    assert.strictEqual(w.authsFor(X), 0, `${L}: zero X authorizations`);
    assert.strictEqual(w.auths(), 1, `${L}: only Y's`);
    assert.deepStrictEqual(fences(w), [[X, 'u_uid_A']], `${L}: the fence is still there (never pruned)`);
    assert.strictEqual(w.db.getAt(`orders/${X}`), null, `${L}: and X was never created`);
  });

  await cell('SDK-FENCE-AFTER-24H-GUEST', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    assert.deepStrictEqual(await CANCEL(w, X, ticketFor(w, X)), NO_SDK, 'premise: the guest fenced X');
    w.clock.t += 72 * HOUR;
    ticketFor(w, X);   // the same phone re-issues a ticket for X
    assert.deepStrictEqual(await FINISH(w, X, { guest: true, attemptId: 'att_fence_G_00000001' }), CLOSED, `${L}: a re-ticketed guest at +72 h ⇒ refused`);
    assert.strictEqual(w.auths(), 0, `${L}: zero authorizations`);
  });

  await cell('SDK-FENCE-JUST-BEFORE-CREATE', async (L) => {
    // RACE-a: the fence lands after A's pre-check, right before A's create-once; the cancel's re-read sees no order ⇒ NO_SDK_ORDER; A's
    // post-check sees the fence ⇒ A cancels its own pending order before the claim / any attempt
    let w; let cancelAnswer = null; let done = false;
    w = world({ script: { authorize: [{ outcome: 'approved' }] }, beforeTx: async (p) => { if (!done && p === `orders/${X}`) { done = true; cancelAnswer = await CANCEL(w, X); } } });
    const r = await FINISH(w, X);
    assert.deepStrictEqual(cancelAnswer, NO_SDK, `premise: the cancel ran before A's txn and saw no order`);
    assert.deepStrictEqual(r, CLOSED, `${L}: A's post-check refuses (${JSON.stringify(r)})`);
    cancelledX(w, L);
    assert.strictEqual(w.auths(), 0, `${L}: zero authorizations`);
    assert.strictEqual(w.db.getAt('sdk_checkout_subject/u_uid_A'), null, `${L}: no subject claimed`);
    assert.deepStrictEqual(await CANCEL(w, X), { status: 200, body: { cancelled: true, safe_to_switch: true } }, `${L}: a later cancel ⇒ cancelled, safe`);
  });

  await cell('SDK-FENCE-STORE-THEN-CHECK', async (L) => {
    // the cancel saw X absent, and its fence write is delayed until A created X, passed its post-check and authorized ⇒ the cancel's
    // re-read AFTER its write sees the placed order ⇒ already_placed — never a safe answer while X holds money
    const pz = pauseAt((p) => p.startsWith('sdk_fence/'));
    const w = world({ script: { authorize: [{ outcome: 'approved' }] }, beforeTx: pz.hook });
    const c = CANCEL(w, X);
    await pz.parked;
    const a = await FINISH(w, X);
    assert.ok(a.status === 200 && a.body.outcome === 'placed' && w.auths() === 1, `premise: A placed X before the fence landed (${JSON.stringify(a.body)})`);
    pz.release();
    assert.deepStrictEqual(await c, { status: 409, body: { error: 'already_placed' } }, `${L}: the re-read after the fence write sees the placed order ⇒ never safe_to_switch:true`);
  });

  await cell('SDK-FENCE-RACE-B-BEFORE-READ', async (L) => {
    // RACE-b: A's txn AND post-check run BEFORE the fence write; the cancel's re-read sees the OWNED order ⇒ today's pendingOnly cancel,
    // committed before placeOriginal's order read (A parked at its gate) ⇒ refused order_state, zero authorizations
    const g = pauseAt(() => true);
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    const a = FINISH(w, X, { runGate: async () => { await g.hook('gate'); return OK_GATE; } });
    await g.parked;
    assert.deepStrictEqual(await CANCEL(w, X), { status: 200, body: { cancelled: true, safe_to_switch: true } }, `${L}: the re-read saw the owned order ⇒ cancelled, safe`);
    g.release(); await a;
    assert.strictEqual(w.auths(), 0, `${L}: zero authorizations`);
    cancelledX(w, L);
    assert.strictEqual(w.db.getAt('sdk_checkout_subject/u_uid_A'), null, `${L}: the subject released`);
  });

  await cell('SDK-FENCE-RACE-B-BEFORE-DISPATCH', async (L) => {
    // RACE-b: the cancel commits after placeOriginal's order read, before its dispatch (A parked at its record create) ⇒ the record is
    // cancelled first ⇒ the dispatch's pre (phase 'open' only) never sends
    const pz = pauseAt((p) => p === `payment_sdk/${X}`);
    const w = world({ script: { authorize: [{ outcome: 'approved' }] }, beforeTx: pz.hook });
    const a = FINISH(w, X);
    await pz.parked;
    assert.deepStrictEqual(await CANCEL(w, X), { status: 200, body: { cancelled: true, safe_to_switch: true } }, `${L}: cancelled, safe`);
    pz.release(); await a;
    assert.strictEqual(w.auths(), 0, `${L}: zero authorizations`);
    cancelledX(w, L);
  });

  await cell('SDK-FENCE-RACE-B-JOURNALED', async (L) => {
    // RACE-b: A had already dispatched (the PSP acted, its answer lost ⇒ unknown) before the cancel ⇒ cancelled but NOT safe — the
    // client may not release while that hold may be live; no further authorization
    const w = world({ script: { authorize: [{ outcome: 'approved', lost: true }] } });
    await FINISH(w, X);
    assert.strictEqual(w.auths(), 1, 'premise: A dispatched once');
    assert.deepStrictEqual(await CANCEL(w, X), { status: 200, body: { cancelled: true, safe_to_switch: false } }, `${L}: a live / unknown hold ⇒ safe_to_switch:false`);
    assert.deepStrictEqual(fences(w), [], `${L}: an existing order is fenced by its own marker — no fence row`);
    assert.strictEqual(w.auths(), 1, `${L}: no further authorization`);
  });

  await cell('SDK-FENCE-FOREIGN', async (L) => {
    // B's fence is B's: it never refuses A's create, and absent ≡ foreign for B (byte-identical, no existence oracle)
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    const absent = await CANCEL(w, X, { authorization: 'Bearer idt_B' });
    const r = await FINISH(w, X);
    assert.ok(r.status === 200 && r.body.outcome === 'placed', `${L}: B's fence never refuses A (${JSON.stringify(r.body)})`);
    const foreign = await CANCEL(w, X, { authorization: 'Bearer idt_B' });
    assert.deepStrictEqual([absent, foreign], [NO_SDK, NO_SDK], `${L}: absent ≡ foreign ⇒ the identical NO_SDK_ORDER`);
    assert.deepStrictEqual(fences(w), [[X, 'u_uid_B']], `${L}: only B's own fence`);
    assert.strictEqual(w.auths(), 1, `${L}: A's one authorization`);
    assert.strictEqual(w.db.getAt(`orders/${X}`).status, 'pending_payment', `${L}: A's order untouched by B`);
  });

  await cell('SDK-FENCE-GUEST', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved' }] } });
    // a ticket bound to ANOTHER id ⇒ today's 401, nothing written; an EXPIRED ticket ⇒ 401, nothing written
    assert.deepStrictEqual(await CANCEL(w, X, ticketFor(w, Y)), { status: 401, body: { error: 'guest_auth_required' } }, `${L}: a ticket for another id ⇒ 401`);
    const old = ticketFor(w, X); w.clock.t += 16 * 60e3;
    assert.deepStrictEqual(await CANCEL(w, X, old), { status: 401, body: { error: 'guest_auth_required' } }, `${L}: an expired ticket ⇒ 401`);
    assert.deepStrictEqual(fences(w), [], `${L}: neither fenced`);
    // the ticket bound to X ⇒ the guest's own fence
    assert.deepStrictEqual(await CANCEL(w, X, ticketFor(w, X)), NO_SDK, `${L}: absent + an X-bound ticket ⇒ NO_SDK_ORDER`);
    assert.deepStrictEqual(fences(w), [[X, `p_${H}`]], `${L}: the guest's fence (p_<phone_hash>)`);
    assert.deepStrictEqual(await FINISH(w, X, { guest: true }), CLOSED, `${L}: the guest's late original ⇒ refused`);
    assert.strictEqual(w.auths(), 0, `${L}: zero authorizations`);
  });

  await cell('SDK-FENCE-FAIL-CLOSED', async (L) => {
    const w = world({ beforeTx: async (p) => { if (p.startsWith('sdk_fence/')) throw new Error('UNAVAILABLE'); } });
    assert.deepStrictEqual(await CANCEL(w, X), { status: 503, body: { error: 'unavailable', retryable: true } }, `${L}: a fence-write failure ⇒ 503 retryable, never safe_to_switch:true`);
    assert.strictEqual((await CANCEL(w, X, { authorization: 'Bearer junk' })).status, 401, `${L}: a bad token ⇒ 401 before any fence`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-fence: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
