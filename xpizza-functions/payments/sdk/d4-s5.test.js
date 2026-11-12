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
function world({ sender = SENDER, reply = { sent: 'true', id: 'msg-1' }, extra = {} } = {}) {
  let t = T0;
  const sends = [];
  const db = makeHonestDb({ orders: {
    ord_guest: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', guest_verified: { phone: GUEST_PHONE, phone_hash: PH }, pay_deadline_at: T0 + 9e5 },
    ord_member: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', customer_uid: 'uid_A', pay_deadline_at: T0 + 9e5 },
  }, ...extra }, { now: () => t });
  const fetchImpl = async (url, init) => { sends.push({ url, body: new URLSearchParams(init.body) }); return { ok: true, json: async () => reply }; };
  const deps = { db, clock: () => t, OTP, fetchImpl, senderConfig: () => sender };
  return { db, deps, sends, tick: (ms) => { t += ms; } };
}
const ASK = (w, body, ip = '10.0.0.1') => REC().recoverOrderAccessCore(w.deps, { ip, body });
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
    // the per-phone budget is the SAME otp_budget checkout uses (3 sends / 10 min)
    const w = world({ extra: { otp_budget: { [PH]: { sends: [T0 - 120000, T0 - 90000, T0 - 60000] } } } });
    const r = await ASK(w, { order_id: 'ord_guest' });
    assert.ok(r.status === 429 && w.sends.length === 0, `${L}: the checkout sends count — the 4th in the window is refused, nothing sent (got ${JSON.stringify(r)})`);
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
    assert.deepStrictEqual(await ASK(w, { order_id: 'ord_guest', code: late }), { status: 400, body: { error: 'code_expired' } }, `${L}: after 5 minutes the code is expired`);
  });

  await cell('SDK-D4-REC-SIXTH-ATTEMPT', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    const code = codeOf(w);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) assert.strictEqual((await ASK(w, { order_id: 'ord_guest', code: wrong })).status, 400, `${L}: wrong attempt ${i + 1}`);
    assert.strictEqual((await ASK(w, { order_id: 'ord_guest', code: wrong })).status, 429, `${L}: the 5th wrong attempt locks`);
    assert.strictEqual((await ASK(w, { order_id: 'ord_guest', code })).status, 429, `${L}: the 6th attempt is refused even with the right code`);
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
      assert.ok(r.status === 503 && w.sends.length === 0 && w.db.getAt(`otp_budget/${PH}`) == null && w.db.getAt('order_recovery_otp/ord_guest') == null, `${L}: ${JSON.stringify(sender)} ⇒ 503 BEFORE any reservation or code write (got ${JSON.stringify(r)})`);
    }
  });

  await cell('SDK-D4-REC-SEND-CONFIRMED', async (L) => {
    const ok = world({ reply: { sent: 'true', id: 'msg-9' } });
    assert.strictEqual((await ASK(ok, { order_id: 'ord_guest' })).status, 200, `${L}: a confirmed provider body (the REAL isSendConfirmed) ⇒ ok: true`);
    assert.ok(ok.db.getAt('order_recovery_otp/ord_guest/code_hash'), `${L}: a code is stored`);
    const bad = world({ reply: {} });
    assert.strictEqual((await ASK(bad, { order_id: 'ord_guest' })).status, 502, `${L}: an UNCONFIRMED body ⇒ fail closed (502)`);
  });

  await cell('SDK-D4-REC-SENDER-INJECTED', async (L) => {
    const w = world();
    await ASK(w, { order_id: 'ord_guest' });
    assert.ok(w.sends[0].url === 'https://api.ultramsg.com/inst_test/messages/chat' && w.sends[0].body.get('token') === 'tok_test_sender', `${L}: the sender comes from the SDK_OTP_SENDER secret's values`);
    const src = require('fs').readFileSync(require('path').join(__dirname, 'recovery.js'), 'utf8');
    assert.ok(!/process\.env/.test(src), `${L}: recovery.js never reads process.env`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-s5: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
