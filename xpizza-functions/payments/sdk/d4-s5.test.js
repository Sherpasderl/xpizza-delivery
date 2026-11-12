'use strict';
// D4 S5 (PLAN-sdk-d4-r4 S5, r3 #9, r4) — guest «recover my order»: a WhatsApp code to the ORDER's stored phone (never one the caller
// supplies), the shared otp_ip + otp_budget limits, single-use / 5-minute / 5-attempt codes, then a 30-minute ORDER ticket scoped to
// status / cancel of THAT order (never a placement). The send runs the REAL sendPlatformOtp + the REAL whatsapp.isSendConfirmed
// against a loopback provider. Run: node payments/sdk/d4-s5.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-d4-s5-0123456789abcdef0123456789';   // test value (otp-lib fails closed < 32 chars)
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const OTP = require('../../otp-lib');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const REC = () => require('./recovery');
const T0 = 1_000_000;
const GUEST_PHONE = '50499990000';
const PH = OTP.phoneHash(GUEST_PHONE);
const SENDER = { instance_id: 'inst_test', token: 'tok_test_sender' };
function world({ sender = SENDER, reply = { sent: 'true', id: 'msg-1' }, extra = {}, hooks = {}, hang = false } = {}) {
  let t = T0;
  const sends = [];
  const db = makeHonestDb({ orders: {
    ord_guest: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', guest_verified: { phone: GUEST_PHONE, phone_hash: PH }, pay_deadline_at: T0 + 9e5 },
    ord_member: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', customer_uid: 'uid_A', pay_deadline_at: T0 + 9e5 },
  }, ...extra }, { now: () => t, ...hooks });
  const fetchImpl = async (url, init) => { sends.push({ url, body: new URLSearchParams(init.body) }); if (hang) await new Promise(() => {}); return { ok: true, json: async () => reply }; };
  const deps = { db, clock: () => t, OTP, fetchImpl, senderConfig: () => sender };
  return { db, deps, sends, tick: (ms) => { t += ms; } };
}
// the bare request (uniform by design: no target work) …
const REQ = (w, body, ip = '10.0.0.1') => REC().recoverOrderAccessCore(w.deps, { ip, body });
// … and a request followed by the background processor (as the queue trigger runs it), for the end-to-end cells
const ASK = async (w, body, ip = '10.0.0.1') => { const r = await REQ(w, body, ip); if (body && body.code === undefined) await REC().processRecoveryQueue(w.deps); return r; };
const codeOf = (w) => { const s = w.sends[w.sends.length - 1]; const m = s && s.body.get('body').match(/(\d{6})/); return m && m[1]; };

(async () => {
  await cell('SDK-D4-REC-ONLY-STORED-PHONE', async (L) => {
    const w = world();
    const r = await ASK(w, { order_id: 'ord_guest', phone: '50411112222', phone_e164: '+50411112222' });
    assert.deepStrictEqual(r, { status: 200, body: { ok: true } }, `${L}: the request answer (got ${JSON.stringify(r)})`);
    assert.ok(w.sends.length === 1 && w.sends[0].body.get('to') === GUEST_PHONE, `${L}: the code goes ONLY to the order's stored phone — a caller-supplied phone is ignored`);
    assert.strictEqual(w.sends[0].body.get('body'), `El código para ver tu pedido en Sherpa es ${codeOf(w)}. Vence en 5 minutos.`, `${L}: the owner-approved template, verbatim`);
  });

  await cell('SDK-D4-REC-FOREIGN-INDISTINGUISHABLE', async (L) => {
    const w = world();
    const absent = await ASK(w, { order_id: 'no_such_order' });
    const member = await ASK(w, { order_id: 'ord_member' });
    const guest = await ASK(w, { order_id: 'ord_guest' });
    assert.deepStrictEqual([absent, member, guest], [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }, { status: 200, body: { ok: true } }], `${L}: absent ≡ a member's order ≡ a guest order — the same answer`);
    assert.strictEqual(w.sends.length, 1, `${L}: only the guest order's stored phone gets a code`);
  });

  await cell('SDK-D4-REC-BUDGET-SHARED', async (L) => {
    // the recovery's OWN per-phone budget (Codex r5: never checkout's otp_budget), the same 3 sends / 10 min
    const w = world({ extra: { recovery_phone_budget: { [PH]: { sends: [T0 - 120000, T0 - 90000, T0 - 60000] } } } });
    const r = await ASK(w, { order_id: 'ord_guest' });
    assert.ok(r.status === 200 && JSON.stringify(r.body) === '{"ok":true}' && w.sends.length === 0, `${L}: the checkout sends count — the 4th in the window sends NOTHING, and the answer is the same 200 as for any target (Codex r5) (got ${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-REC-SINGLE-USE-EXPIRY', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    const code = codeOf(w);
    const ok = await ASK(w, { order_id: 'ord_guest', code });
    assert.ok(ok.status === 200 && /^ot_[0-9a-f]{32}$/.test(ok.body.order_ticket) && Object.keys(ok.body).length === 1, `${L}: a correct code ⇒ { order_ticket } (got ${JSON.stringify(ok)})`);
    const again = await ASK(w, { order_id: 'ord_guest', code });
    assert.ok(again.status === 400, `${L}: the code is single-use (got ${JSON.stringify(again)})`);
    w.tick(31000);
    await ASK(w, { order_id: 'ord_guest' });
    const late = codeOf(w);
    w.tick(5 * 60 * 1000);
    assert.deepStrictEqual(await ASK(w, { order_id: 'ord_guest', code: late }), { status: 400, body: { error: 'code_invalid' } }, `${L}: after 5 minutes the code no longer works (the one generic failure)`);
  });

  await cell('SDK-D4-REC-SIXTH-ATTEMPT', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    const code = codeOf(w);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(await ASK(w, { order_id: 'ord_guest', code: wrong }), { status: 400, body: { error: 'code_invalid' } }, `${L}: wrong attempt ${i + 1} ⇒ the generic failure`);
    assert.deepStrictEqual(await ASK(w, { order_id: 'ord_guest', code }), { status: 400, body: { error: 'code_invalid' } }, `${L}: the 6th attempt is refused even with the right code (locked; the same generic answer)`);
    assert.strictEqual(w.db.getAt('order_access_tickets'), null, `${L}: no ticket minted after the lock`);
  });

  await cell('SDK-D4-REC-TICKET-SCOPE', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    const { order_ticket } = (await ASK(w, { order_id: 'ord_guest', code: codeOf(w) })).body;
    const A = (id) => require('./order-auth').authorizeExistingOrder({ ...w.deps, verifyIdToken: async () => { throw new Error('x'); } }, { ticket: order_ticket }, id);
    assert.deepStrictEqual(await A('ord_guest'), { ok: true, guest: true }, `${L}: the order ticket authorizes status / cancel of THAT order`);
    assert.strictEqual((await A('ord_member')).ok, false, `${L}: never another order`);
    const G = require('../../checkout-guest-lib');
    const rec = (await w.db.ref(`checkout_tickets/${G.ticketKey(order_ticket)}`).once('value')).val();
    assert.strictEqual(rec, null, `${L}: an order ticket is NEVER a checkout ticket — placement (B1's ticketValid on checkout_tickets) refuses it`);
    w.tick(30 * 60 * 1000);
    assert.strictEqual((await A('ord_guest')).ok, false, `${L}: it expires after 30 minutes`);
  });

  await cell('SDK-D4-REC-SALT-PARITY', async (L) => {
    // the stored guest_verified.phone_hash was computed by checkout with the SAME OTP_SALT: recovery binds to it
    const w = world();
    assert.strictEqual(OTP.phoneHash(GUEST_PHONE), w.db.getAt('orders/ord_guest/guest_verified/phone_hash'), `${L}: premise — the same salt`);
    await ASK(w, { order_id: 'ord_guest' });
    assert.strictEqual(w.db.getAt('order_recovery_otp/ord_guest/phone_hash'), PH, `${L}: the code is bound to the order's stored phone hash`);
  });

  await cell('SDK-D4-REC-SENDER-UNCONFIGURED', async (L) => {
    for (const sender of [null, { instance_id: '', token: '' }]) {
      const w = world({ sender });
      const r = await ASK(w, { order_id: 'ord_guest' });
      assert.ok(r.status === 503 && w.sends.length === 0 && w.db.getAt(`recovery_phone_budget/${PH}`) == null && w.db.getAt('sdk_recovery_queue') == null && w.db.getAt('order_recovery_otp/ord_guest') == null, `${L}: ${JSON.stringify(sender)} ⇒ 503 BEFORE any reservation or code write (got ${JSON.stringify(r)})`);
    }
  });

  await cell('SDK-D4-REC-SEND-CONFIRMED', async (L) => {
    const ok = world({ reply: { sent: 'true', id: 'msg-9' } });
    assert.strictEqual((await ASK(ok, { order_id: 'ord_guest' })).status, 200, `${L}: a confirmed provider body (the REAL isSendConfirmed) ⇒ ok: true`);
    assert.ok(ok.db.getAt('order_recovery_otp/ord_guest/code_hash'), `${L}: a code is stored`);
    const bad = world({ reply: {} });
    const warned = []; const ow = console.warn; console.warn = (...a) => warned.push(a.join(' '));
    let r; try { r = await ASK(bad, { order_id: 'ord_guest' }); } finally { console.warn = ow; }
    assert.ok(warned.includes('sdk_recovery_suppressed {"reason":"send_unconfirmed"}'), `${L}: an unconfirmed send is RECORDED internally (the real isSendConfirmed decided it) — ${JSON.stringify(warned)}`);
    assert.ok(r.status === 200 && JSON.stringify(r.body) === '{"ok":true}', `${L}: an UNCONFIRMED send fails closed internally (no ticket path opens) but answers the same 200 as any target (Codex r5) (got ${JSON.stringify(r)})`);
  });

  await cell('SDK-D4-REC-SENDER-INJECTED', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    assert.ok(w.sends[0].url === 'https://api.ultramsg.com/inst_test/messages/chat' && w.sends[0].body.get('token') === 'tok_test_sender', `${L}: the sender comes from the SDK_OTP_SENDER secret's values`);
    const src = require('fs').readFileSync(require('path').join(__dirname, 'recovery.js'), 'utf8');
    assert.ok(!/process\.env/.test(src), `${L}: recovery.js never reads process.env`);
  });


  // ── Codex S5 r5: UNAUTHENTICATED answers are target-independent; a claimed (member) order is never guest-recoverable ──
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  await cell('SDK-D4-REC-TARGET-INDEPENDENT-REQUEST', async (L) => {
    // an immediate repeat: absent vs a real guest order (the guest's phone budget refuses the 2nd within 30 s)
    const w1 = world(); await ASK(w1, { order_id: 'ord_guest' }); const g2 = await ASK(w1, { order_id: 'ord_guest' }, '10.0.0.2');
    const w2 = world(); await ASK(w2, { order_id: 'no_such_order' }); const a2 = await ASK(w2, { order_id: 'no_such_order' }, '10.0.0.2');
    assert.ok(same(g2, a2), `${L}: an immediate repeat ⇒ identical bytes for a guest order and an absent one (${JSON.stringify(g2)} vs ${JSON.stringify(a2)})`);
    // an unconfirmed send
    const w3 = world({ reply: {} }); const g3 = await ASK(w3, { order_id: 'ord_guest' }); const a3 = await ASK(w3, { order_id: 'no_such_order' });
    assert.ok(same(g3, a3), `${L}: an unconfirmed send ⇒ identical bytes (${JSON.stringify(g3)} vs ${JSON.stringify(a3)})`);
  });
  await cell('SDK-D4-REC-TARGET-INDEPENDENT-VERIFY', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    const real = codeOf(w); const wrong = real === '000000' ? '111111' : '000000';
    const outs = [await ASK(w, { order_id: 'ord_guest', code: wrong }), await ASK(w, { order_id: 'no_such_order', code: wrong }), await ASK(w, { order_id: 'ord_member', code: wrong })];
    assert.ok(outs.every((o) => same(o, { status: 400, body: { error: 'code_invalid' } })), `${L}: a wrong code on a guest order ≡ any code on an absent or a member order — ONE generic failure (${JSON.stringify(outs)})`);
  });
  await cell('SDK-D4-REC-CALLER-RATE-LIMIT', async (L) => {
    // the per-CALLER (IP) limit may answer 429, but identically for every target
    const w = world({ extra: { otp_ip: {} } });
    const ipHash = require('crypto').createHash('sha256').update('10.9.9.9').digest('hex');
    w.db.setAt(`otp_ip/${ipHash}`, { window_start: T0, count: 10 });   // otp-lib ipReserve: IP_MAX_PER_HR reached
    const g = await ASK(w, { order_id: 'ord_guest' }, '10.9.9.9'); const a = await ASK(w, { order_id: 'no_such_order' }, '10.9.9.9');
    assert.ok(g.status === 429 && same(g, a), `${L}: a caller over its IP budget ⇒ the same 429 for a guest and an absent target (${JSON.stringify(g)} vs ${JSON.stringify(a)})`);
  });
  await cell('SDK-D4-REC-CLAIMED-NOT-RECOVERABLE', async (L) => {
    // the REAL claim: a member with the same phone binds the guest order (claim-order.js keeps guest_verified)
    const w = world({ extra: { user_profiles: { uid_M: { phone_hash: PH } } } });
    w.db.setAt('orders/ord_guest/customer_phone', GUEST_PHONE);
    await ASK(w, { order_id: 'ord_guest' });
    const { order_ticket } = (await ASK(w, { order_id: 'ord_guest', code: codeOf(w) })).body;   // a ticket minted BEFORE the claim
    const claim = await require('../../claim-order').claimOrderCore(w.db, { uid: 'uid_M', orderId: 'ord_guest', now: T0 });
    assert.ok(w.db.getAt('orders/ord_guest/customer_uid') === 'uid_M', `${L}: premise — the real claim bound the member (${JSON.stringify(claim)})`);
    const sendsBefore = w.sends.length;
    w.tick(31000);
    const req = await ASK(w, { order_id: 'ord_guest' });
    assert.ok(same(req, { status: 200, body: { ok: true } }) && w.sends.length === sendsBefore, `${L}: a claimed order never gets a recovery code (the same 200, nothing sent)`);
    const A = await require('./order-auth').authorizeExistingOrder({ ...w.deps, verifyIdToken: async () => { throw new Error('x'); } }, { ticket: order_ticket }, 'ord_guest');
    assert.strictEqual(A.ok, false, `${L}: a guest ticket minted BEFORE the claim is refused once the order is a member's (order-auth checks the CURRENT order)`);
  });

  // ── Codex build r5: the request path is UNIFORM by design (a queue entry; the target work in the background processor) ──
  await cell('SDK-D4-REC-REQUEST-UNIFORM', async (L) => {
    const reads = [];
    const w = world({ hang: true, hooks: { beforeRead: async (p) => { if (p.startsWith('orders/')) reads.push(p); } } });
    const t0 = Date.now();
    const g = await REQ(w, { order_id: 'ord_guest' }); const a = await REQ(w, { order_id: 'no_such_order' }, '10.0.0.3');
    assert.ok(Date.now() - t0 < 1000 && JSON.stringify(g) === JSON.stringify(a) && JSON.stringify(g) === '{"status":200,"body":{"ok":true}}', `${L}: a provider that never answers does not delay the request (no awaited send); identical bytes`);
    assert.deepStrictEqual([reads.length, w.sends.length, Object.keys(w.db.getAt('sdk_recovery_queue') || {}).length], [0, 0, 2], `${L}: ZERO reads of orders/*, ZERO sends, ONE queue entry each on the request path`);
  });
  await cell('SDK-D4-REC-PROCESSOR-DROPS', async (L) => {
    const w = world({ extra: { user_profiles: { uid_M: { phone_hash: PH } } } });
    w.db.setAt('orders/ord_claimed', { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', customer_uid: 'uid_M', guest_verified: { phone: '50499990001', phone_hash: OTP.phoneHash('50499990001') }, pay_deadline_at: T0 + 9e5 });
    for (const id of ['no_such_order', 'ord_member', 'ord_claimed']) await REQ(w, { order_id: id });
    await REC().processRecoveryQueue(w.deps);
    assert.deepStrictEqual([w.sends.length, w.db.getAt('sdk_recovery_queue')], [0, null], `${L}: absent / member / claimed ⇒ dropped silently, nothing sent, the queue drained`);
    await REQ(w, { order_id: 'ord_guest' }); await REC().processRecoveryQueue(w.deps);
    assert.ok(w.sends.length === 1 && w.sends[0].body.get('to') === GUEST_PHONE, `${L}: a guest ⇒ one send to the stored phone`);
  });
  await cell('SDK-D4-REC-PROCESSOR-STORAGE-FAILURE', async (L) => {
    const w = world({ hooks: { beforeTx: async (p) => { if (p.startsWith('recovery_phone_budget/')) throw new Error('injected storage failure'); } } });
    const r = await REQ(w, { order_id: 'ord_guest' });
    const warned = []; const ow = console.warn; console.warn = (...x) => warned.push(x.join(' '));
    try { await REC().processRecoveryQueue(w.deps); } finally { console.warn = ow; }
    assert.ok(JSON.stringify(r) === '{"status":200,"body":{"ok":true}}' && warned.some((x) => x.startsWith('sdk_recovery_suppressed')), `${L}: a processor storage failure ⇒ the request had already answered 200; the processor records it, never throws (${JSON.stringify(warned)})`);
  });
  await cell('SDK-D4-REC-OWN-BUDGET', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    assert.ok(w.db.getAt(`otp_budget/${PH}`) == null && w.db.getAt(`recovery_phone_budget/${PH}`), `${L}: a recovery spends ONLY its own budget — checkout's otp_budget is untouched, so a checkout-OTP follow-up is identical for every target`);
  });
  await cell('SDK-D4-REC-SINGLE-PROCESSOR', async (L) => {
    const w = world();
    await REQ(w, { order_id: 'ord_guest' });
    await Promise.all([REC().processRecoveryQueue(w.deps), REC().processRecoveryQueue(w.deps)]);
    assert.strictEqual(w.sends.length, 1, `${L}: two concurrent processors ⇒ ONE send`);
  });
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-s5: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
