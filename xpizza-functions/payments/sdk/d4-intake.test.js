'use strict';
// D4 §A2 B1 + B2 (PLAN-sdk-d4-r11) — the SDK intake's two request-facing steps, as ONE module the handler's `if (SDK_MODE)`
// branches call (payments/sdk/intake.js):
//   B1 authorize(req, deps): the deployment forced to orders-app FIRST; exactly ONE credential kind (member Bearer ID token |
//      guest checkout ticket); the caller's x-firebase-id-token stripped; the member verified with NO fail-open (timeout ⇒ 503);
//      the guest ticket validated HERE with checkout-guest-lib.ticketValid; entry_mode forced 'app'; redeem refused.
//   B2 replay(deps, …): a KNOWN attempt of THIS caller's SDK order answers through the §4 resolver and returns, before any gate,
//      reserve or claim; anything else falls through (null).
// Tickets come from the REAL ticketRecord; records from the REAL coordinator / record writers.
// Run: node payments/sdk/d4-intake.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-d4-intake-0123456789abcdef01234567';
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const G = require('../../checkout-guest-lib');
const OTP = require('../../otp-lib');
const { normalizePhone } = require('../../whatsapp');
const { attributionUid } = require('../../create-order-build');
const C = require('./coordinator');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const I = () => require('./intake');
const T0 = 1_000_000;
const OID = 'sdk_261112-101500-ABCDEFGH';   // the SDK order-id namespace (B1 refuses any other id)
const RID = 'tb_rest';
const PHONE = '+504 9999-0000';
const ATT = 'att_intake_cell_0001';
const baseBody = (o = {}) => ({ order_id: OID, restaurant_id: RID, customer_phone: PHONE, customer_name: 'Ana Pérez', order_type: 'pickup', payment_method: 'online',
  items: [{ id: 'tb_pizza', name: 'Pizza', qty: 1, price: 100 }], items_text: '1x Pizza',
  attempt_id: 'att_intake_default_0001', card: { kind: 'new', sdk_token: 'tok_d', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } }, ...o });

async function world({ hang = false, tomb = false, nonCustomer = false, extra = {} } = {}) {
  let t = T0;
  const db = makeHonestDb({ ...extra }, { now: () => t });
  const reads = [];
  const deps = {
    db, clock: () => t, deadlineMs: 50, attributionUid, normalizePhone, phoneHash: (d) => OTP.phoneHash(d), cartFpFromBody: G.cartFpFromBody,
    isTombstoned: async () => tomb,
    verifyIdToken: async (x) => { if (hang) await new Promise(() => {}); if (x === 'idt_A') return { uid: 'uid_A', customer: !nonCustomer }; throw new Error('bad token'); },
    psp: makeAdapter(makeFakePsp({}).impl), voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, releaseResources: async () => {},
  };
  return { db, deps, reads, tick: (ms) => { t += ms; } };
}
// the REAL guest ticket for a body: the record checkout's verify step writes (checkout_tickets/{sha256(ticket)})
async function mintTicket(w, body) {
  const ticket = G.newTicketId();
  const digits = normalizePhone(body.customer_phone);
  const rec = G.ticketRecord({ phone: digits, phoneHash: OTP.phoneHash(digits), rid: body.restaurant_id, cartFp: await G.cartFpFromBody(body), orderId: body.order_id, now: T0 });
  w.db.setAt(`checkout_tickets/${G.ticketKey(ticket)}`, rec);
  return ticket;
}
const req = (headers, body) => ({ headers: { ...headers }, body });
const AUTH = (w, r) => I().authorize(r, w.deps);

(async () => {
  await cell('SDK-D4-AUTH-MIXED', async (L) => {
    const w = await world();
    const body = baseBody(); const ticket = await mintTicket(w, body);
    for (const [label, r] of [
      ['Bearer + ticket header', req({ authorization: 'Bearer idt_A', 'x-sherpa-order-ticket': ticket }, baseBody())],
      ['Bearer + body ticket', req({ authorization: 'Bearer idt_A' }, baseBody({ checkout_ticket: ticket }))],
      ['an INVALID Bearer + a valid ticket (no fallback)', req({ authorization: 'Bearer junk' }, baseBody({ checkout_ticket: ticket }))],
    ]) assert.deepStrictEqual((await AUTH(w, r)).refuse, { status: 401, body: { error: 'mixed_credentials' } }, `${L}: ${label} ⇒ 401 mixed_credentials`);
    assert.deepStrictEqual((await AUTH(w, req({}, baseBody()))).refuse, { status: 401, body: { error: 'guest_auth_required' } }, `${L}: neither ⇒ 401 guest_auth_required`);
    // the caller's identity header: stripped on the guest path; replaced by the Bearer's on the member path
    const g = req({ 'x-sherpa-order-ticket': ticket, 'x-firebase-id-token': 'idt_A' }, baseBody());
    const gr = await AUTH(w, g);
    assert.ok(gr.ok && gr.kind === 'guest' && g.headers['x-firebase-id-token'] === undefined, `${L}: a caller x-firebase-id-token on the GUEST path is stripped (${JSON.stringify(gr)})`);
    const m = req({ authorization: 'Bearer idt_A', 'x-firebase-id-token': 'idt_OTHER' }, baseBody());
    const mr = await AUTH(w, m);
    assert.ok(mr.ok && mr.kind === 'member' && mr.uid === 'uid_A' && m.headers['x-firebase-id-token'] === 'idt_A', `${L}: a conflicting identity header beside a valid Bearer ⇒ the Bearer's token only (${JSON.stringify(mr)})`);
  });

  await cell('SDK-D4-AUTH-MALFORMED', async (L) => {
    // Codex handler r1 P2: credential PRESENCE is decided by the header, not by a successful parse — a malformed Authorization is
    // a member credential that failed (401), never a fall-through to the guest path
    const w = await world();
    const body = baseBody(); const ticket = await mintTicket(w, body);
    for (const a of ['Bearer invalid extra', 'Basic dXNlcjpwdw==', 'Bearer', 'bearer idt_A', '']) {
      assert.deepStrictEqual((await AUTH(w, req({ authorization: a, 'x-sherpa-order-ticket': ticket }, baseBody()))).refuse, { status: 401, body: { error: 'mixed_credentials' } }, `${L}: Authorization ${JSON.stringify(a)} + a valid ticket ⇒ 401 mixed_credentials, never guest`);
      assert.deepStrictEqual((await AUTH(w, req({ authorization: a }, baseBody()))).refuse, { status: 401, body: { error: 'auth_invalid' } }, `${L}: a malformed Authorization ${JSON.stringify(a)} alone ⇒ 401 auth_invalid`);
    }
  });

  await cell('SDK-D4-NAMESPACE-B1', async (L) => {
    // advisor ruling (gate 0 replaced): placeSdkOrder admits ONLY the reserved SDK namespace — any other id ⇒ 400
    const w = await world();
    const BAD = { status: 400, body: { error: 'order_id_namespace' } };
    for (const id of ['XPZ261112-1015-ABCDEFGH', 'tb_intake_1', 'sdk_', 'sdk_261112-101500-abcdefgh', 'sdk_261112-101500-ABCDEFGI', 'SDK_261112-101500-ABCDEFGH', 'sdk_261112-1015-ABCDEFGH', 'xsdk_261112-101500-ABCDEFGH'])
      assert.deepStrictEqual((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody({ order_id: id })))).refuse, BAD, `${L}: ${id} ⇒ 400 order_id_namespace`);
    for (const id of [['sdk_261112-101500-ABCDEFGH'], [['sdk_261112-101500-ABCDEFGH']], 261112, { id: 'sdk_261112-101500-ABCDEFGH' }])
      assert.deepStrictEqual((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody({ order_id: id })))).refuse, BAD, `${L}: a NON-STRING id ${JSON.stringify(id)} ⇒ 400 (Codex r2 P1)`);
    assert.ok((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody()))).ok, `${L}: a namespaced id is admitted`);
  });

  await cell('SDK-D4-DEPLOYMENT-FORCED', async (L) => {
    const w = await world();
    for (const dep of [undefined, 'forms', 'orders-app', 'whatever']) {
      const r = req({ authorization: 'Bearer idt_A', ...(dep ? { 'x-client-deployment': dep } : {}) }, baseBody());
      await AUTH(w, r);
      assert.strictEqual(r.headers['x-client-deployment'], 'orders-app', `${L}: deployment ${dep} ⇒ forced to orders-app (member path)`);
      const r2 = req({ 'x-sherpa-order-ticket': 'ct_' + '0'.repeat(32), ...(dep ? { 'x-client-deployment': dep } : {}) }, baseBody());
      await AUTH(w, r2);
      assert.strictEqual(r2.headers['x-client-deployment'], 'orders-app', `${L}: deployment ${dep} ⇒ forced to orders-app (guest path, even when refused)`);
    }
  });

  await cell('SDK-D4-GUEST-FORGED', async (L) => {
    const w = await world();
    const body = baseBody(); const ticket = await mintTicket(w, body);
    const bad = { status: 401, body: { error: 'guest_ticket_invalid' } };
    for (const [label, r] of [
      ['a forged ticket', req({ 'x-sherpa-order-ticket': 'ct_' + 'a'.repeat(32) }, baseBody())],
      ['a malformed ticket', req({ 'x-sherpa-order-ticket': 'not-a-ticket' }, baseBody())],
      ['another phone', req({ 'x-sherpa-order-ticket': ticket }, baseBody({ customer_phone: '+504 9999-0001' }))],
      ['another cart', req({ 'x-sherpa-order-ticket': ticket }, baseBody({ items: [{ id: 'tb_pizza', name: 'Pizza', qty: 2, price: 100 }], items_text: '2x Pizza' }))],
      ['another order id', req({ 'x-sherpa-order-ticket': ticket }, baseBody({ order_id: 'sdk_261112-101500-ABCDEFGJ' }))],
      ['another restaurant', req({ 'x-sherpa-order-ticket': ticket }, baseBody({ restaurant_id: 'tb_other' }))],
    ]) assert.deepStrictEqual((await AUTH(w, r)).refuse, bad, `${L}: ${label} ⇒ 401 guest_ticket_invalid`);
    // CONTRACT-Δ C2: a header and a body ticket must be EQUAL, else 401 guest_auth_required
    assert.deepStrictEqual((await AUTH(w, req({ 'x-sherpa-order-ticket': ticket }, baseBody({ checkout_ticket: 'ct_' + 'b'.repeat(32) })))).refuse, { status: 401, body: { error: 'guest_auth_required' } }, `${L}: header ≠ body ⇒ 401 guest_auth_required (C2)`);
    w.tick(G.TICKET_TTL_MS + 1);
    assert.deepStrictEqual((await AUTH(w, req({ 'x-sherpa-order-ticket': ticket }, baseBody()))).refuse, bad, `${L}: an expired ticket ⇒ 401`);
    const w2 = await world(); const t2 = await mintTicket(w2, body);
    const ok = req({ 'x-sherpa-order-ticket': t2 }, baseBody());
    const r = await AUTH(w2, ok);
    assert.ok(r.ok && r.kind === 'guest' && ok.body.checkout_ticket === t2, `${L}: the REAL ticket ⇒ guest, and body.checkout_ticket carries the validated ticket (${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-VERIFY-TIMEOUT', async (L) => {
    const w = await world({ hang: true });
    assert.deepStrictEqual((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody()))).refuse, { status: 503, body: { error: 'auth_unavailable' } }, `${L}: a hung verification ⇒ 503 auth_unavailable, never a guest`);
  });

  await cell('SDK-D4-AUTH-MEMBER-CHECKS', async (L) => {
    const bad = { status: 401, body: { error: 'auth_invalid' } };
    assert.deepStrictEqual((await AUTH(await world(), req({ authorization: 'Bearer junk' }, baseBody()))).refuse, bad, `${L}: an invalid token ⇒ 401 auth_invalid`);
    assert.deepStrictEqual((await AUTH(await world({ tomb: true }), req({ authorization: 'Bearer idt_A' }, baseBody()))).refuse, bad, `${L}: a tombstoned account ⇒ 401 auth_invalid (attributionUid)`);
    assert.deepStrictEqual((await AUTH(await world({ nonCustomer: true }), req({ authorization: 'Bearer idt_A' }, baseBody()))).refuse, bad, `${L}: a non-customer token ⇒ 401 auth_invalid`);
  });

  await cell('SDK-D4-APP-SEMANTICS', async (L) => {
    const w = await world();
    const r = req({ authorization: 'Bearer idt_A' }, baseBody());
    assert.ok((await AUTH(w, r)).ok && r.body.entry_mode === 'app', `${L}: entry_mode omitted ⇒ forced 'app'`);
    const r2 = req({ authorization: 'Bearer idt_A' }, baseBody({ entry_mode: 'app' }));
    assert.ok((await AUTH(w, r2)).ok, `${L}: 'app' accepted`);
    for (const em of ['direct', '', 'APP', 0]) assert.deepStrictEqual((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody({ entry_mode: em })))).refuse, { status: 400, body: { error: 'entry_mode' } }, `${L}: entry_mode ${JSON.stringify(em)} ⇒ 400 entry_mode`);
  });

  await cell('SDK-D4-NO-REDEEM', async (L) => {
    const reads = [];
    const w = await world();
    const db0 = w.db; w.deps.db = { ...db0, ref: (p) => { reads.push(p); return db0.ref(p); } };
    for (const redeem of [0, {}, false, 'x', { reward_id: 'rw' }]) {
      assert.deepStrictEqual((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody({ redeem })))).refuse, { status: 400, body: { error: 'redeem_not_available' } }, `${L}: redeem ${JSON.stringify(redeem)} ⇒ 400 redeem_not_available`);
    }
    assert.ok(!reads.some((p) => p.startsWith('user_rewards')), `${L}: zero user_rewards reads (${JSON.stringify(reads)})`);
    assert.ok((await AUTH(w, req({ authorization: 'Bearer idt_A' }, baseBody({ redeem: null })))).ok, `${L}: redeem null ≡ absent`);
  });

  await cell('SDK-D4-ENVELOPE-EXACT', async (L) => {
    // CONTRACT-Δ C1: the SDK envelope (attempt_id, replaces_order_id, card + its display) is exact-keyed; the priced body is not
    const w = await world();
    const NEW = { kind: 'new', sdk_token: 'tok_1', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 } };
    const ok = (o) => req({ authorization: 'Bearer idt_A' }, baseBody({ attempt_id: 'att_envelope_00000001', card: NEW, ...o }));
    assert.ok((await AUTH(w, ok({}))).ok, `${L}: a well-formed new card`);
    assert.ok((await AUTH(w, ok({ card: { kind: 'saved', card_id: 'c'.repeat(20) }, replaces_order_id: null, some_order_field: 1 }))).ok, `${L}: a saved card (member), replaces null, an unknown ORDER key ignored`);
    const BAD = { status: 400, body: { error: 'bad_request' } };
    for (const [label, o] of [
      ['no attempt_id', { attempt_id: undefined }], ['a short attempt_id', { attempt_id: 'short' }], ['a bad attempt_id char', { attempt_id: 'att envelope 00000001' }],
      ['no card', { card: undefined }], ['an unknown card kind', { card: { kind: 'other' } }], ['an extra card key', { card: { ...NEW, cvv: '123' } }],
      ['an extra display key', { card: { ...NEW, display: { ...NEW.display, bin: '411111' } } }], ['a bad last4', { card: { ...NEW, display: { ...NEW.display, last4: '42' } } }],
      ['an expired display year', { card: { ...NEW, display: { ...NEW.display, exp_year: 1969 } } }], ['save not boolean', { card: { ...NEW, save: 'yes' } }],
      ['an empty sdk_token', { card: { ...NEW, sdk_token: '' } }], ['a bad identifier', { card: { ...NEW, authentication_identifier: 5 } }],
      ['a saved card with an extra key', { card: { kind: 'saved', card_id: 'c'.repeat(20), token: 'x' } }], ['a malformed replaces_order_id', { replaces_order_id: 'bad id!' }],
    ]) assert.deepStrictEqual((await AUTH(w, ok(o))).refuse, BAD, `${L}: ${label} ⇒ 400 bad_request`);
    // a GUEST may not name a saved card (members only)
    const body = baseBody({ attempt_id: 'att_envelope_00000001', card: { kind: 'saved', card_id: 'c'.repeat(20) } }); const ticket = await mintTicket(w, body);
    assert.deepStrictEqual((await AUTH(w, req({ 'x-sherpa-order-ticket': ticket }, body))).refuse, BAD, `${L}: a guest with a saved card ⇒ 400 bad_request`);
  });
  await cell('SDK-D4-ADMIT-BEFORE-WRITES', async (L) => {
    // B2's pre-write gates, after the replay lookup falls through: scheduled ⇒ not_allowed; the availability flag ⇒ unavailable
    const w = await world();
    const writes = []; const db0 = w.db; w.deps.db = { ...db0, ref: (p) => { const r = db0.ref(p); return { ...r, set: async (v) => { writes.push(p); return r.set(v); }, update: async (v) => { writes.push(p); return r.update(v); }, transaction: async (f) => { writes.push(p); return r.transaction(f); } }; } };
    const sch = await I().admit(w.deps, { restaurantId: RID, scheduledFor: T0 + 3600e3 });
    assert.deepStrictEqual(sch, { status: 200, body: { outcome: 'not_allowed', reason: 'scheduled' } }, `${L}: a scheduled order ⇒ not_allowed / scheduled`);
    const off = await I().admit(w.deps, { restaurantId: RID, scheduledFor: null });
    assert.deepStrictEqual(off, { status: 200, body: { outcome: 'unavailable', retry_after_s: 300 } }, `${L}: the flag absent ⇒ unavailable (fail-closed)`);
    db0.setAt('platform_config/sdk_pay', { available: true, restaurants: { [RID]: true } });
    assert.strictEqual(await I().admit(w.deps, { restaurantId: RID, scheduledFor: null }), null, `${L}: available for this restaurant ⇒ admitted`);
    assert.deepStrictEqual((await I().admit(w.deps, { restaurantId: 'tb_other', scheduledFor: null })).body.outcome, 'unavailable', `${L}: another restaurant ⇒ unavailable`);
    assert.deepStrictEqual(writes, [], `${L}: zero writes`);
  });

  // ── B2: the authenticated replay lookup ──
  await cell('SDK-D4-REPLAY-KNOWN', async (L) => {
    // (a) a SETTLED attempt (declined by the real coordinator) ⇒ the §4 resolver's answer; ZERO writes; no reserve, no claim
    const mk = async (ord, script) => {
      const w = await world({ extra: { orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', restaurant_id: RID, pay_deadline_at: T0 + 9e5, total_cents: 10000, ...ord } } } });
      w.fake = makeFakePsp(script); w.deps.psp = makeAdapter(w.fake.impl);
      return w;
    };
    const w = await mk({ customer_uid: 'uid_A' }, { authorize: [{ outcome: 'definitive_decline', code: '05' }] });
    await C.placeOriginal(w.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 10000 });
    const before = JSON.stringify(w.db.root);
    const r = await I().replay(w.deps, { orderId: OID, attemptId: ATT, uid: 'uid_A' });
    assert.ok(r && r.status === 200 && r.body.outcome === 'declined' && r.body.attempt_id === ATT, `${L}: (a) a settled attempt ⇒ its outcome (got ${JSON.stringify(r)})`);
    assert.strictEqual(JSON.stringify(w.db.root), before, `${L}: (a) ZERO writes`);
    // falls through: unknown attempt / foreign caller / guest phone mismatch / a non-SDK order
    assert.strictEqual(await I().replay(w.deps, { orderId: OID, attemptId: 'att_unknown_000000001', uid: 'uid_A' }), null, `${L}: an unknown attempt falls through`);
    assert.strictEqual(await I().replay(w.deps, { orderId: OID, attemptId: ATT, uid: 'uid_B' }), null, `${L}: another member's order falls through (refused later by the create-once flow / owner check)`);
    // a CLAIMED order (customer_uid + the guest's verified phone kept by the claim): the guest's phone no longer replays it
    w.db.setAt(`orders/${OID}/guest_verified`, { phone: normalizePhone(PHONE), phone_hash: OTP.phoneHash(normalizePhone(PHONE)) });
    assert.strictEqual(await I().replay(w.deps, { orderId: OID, attemptId: ATT, uid: null, guestPhoneHash: OTP.phoneHash(normalizePhone(PHONE)) }), null, `${L}: a guest never replays a member's order`);
    // a record carrying the attempt under an order that is NOT (or no longer reads as) SDK ⇒ falls through
    w.db.setAt(`orders/${OID}/payment_flow`, null);
    assert.strictEqual(await I().replay(w.deps, { orderId: OID, attemptId: ATT, uid: 'uid_A' }), null, `${L}: a non-SDK order falls through`);
    // (b) an APPROVED-but-unplaced attempt ⇒ the resolver places it (decidePlacement); no new authorization
    const wb = await mk({ customer_uid: 'uid_A' }, {});
    const golive = []; wb.deps.goLive = async (dp, id) => { golive.push(id); };
    await require('./record').createRecord(wb.db, OID, { flow: 'sdk_auth_v1', phase: 'open', committed_revision: 0, fulfillment_total_cents: 10000, created_at: T0, ttl_at: T0 + 9e5 });
    await require('./record').casRecord(wb.db, OID, (rr) => { rr.legs = { L1: { kind: 'original', amount_cents: 10000, role: 'committed', state: 'approved', pp_uuid: 'P-1', attempt_id: ATT, created_at: T0, hold_expires_at: T0 + 1e9 } };
      rr.attempts = { [ATT]: { leg_id: 'L1', token_hash: 'h', card_ref: 'new', display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 }, save: false, amount_cents: 10000, at: T0 } }; return rr; });
    const rb = await I().replay(wb.deps, { orderId: OID, attemptId: ATT, uid: 'uid_A' });
    assert.ok(rb && rb.status === 200 && wb.db.getAt(`orders/${OID}/payment_placed/leg_id`) === 'L1' && golive.length === 1, `${L}: (b) approved-unplaced ⇒ placed by decidePlacement (got ${JSON.stringify(rb)})`);
    assert.strictEqual(wb.fake.callCount('authorize'), 0, `${L}: (b) no new authorization`);
    // guest: the same phone hash replays its own guest order
    const wg = await mk({ guest_verified: { phone: normalizePhone(PHONE), phone_hash: OTP.phoneHash(normalizePhone(PHONE)) } }, { authorize: [{ outcome: 'definitive_decline', code: '05' }] });
    await C.placeOriginal(wg.deps, { orderId: OID, attempt_id: ATT, token: 'T', amount_cents: 10000 });
    const rg = await I().replay(wg.deps, { orderId: OID, attemptId: ATT, uid: null, guestPhoneHash: OTP.phoneHash(normalizePhone(PHONE)) });
    assert.ok(rg && rg.body.outcome === 'declined', `${L}: a guest replays ITS order by the verified phone hash (got ${JSON.stringify(rg)})`);
    assert.strictEqual(await I().replay(wg.deps, { orderId: OID, attemptId: ATT, uid: null, guestPhoneHash: OTP.phoneHash('50499990009') }), null, `${L}: another phone falls through`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-intake: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
