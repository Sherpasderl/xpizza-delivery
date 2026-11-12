'use strict';
// D4 S7 (a) (NOTE-sdk-d4-S7-plan.md) — payments/sdk/endpoints.js: the THIN HTTP / trigger wrappers over the existing cores. Every
// decision stays in the core: a wrapper only checks the method, hands the core exactly its inputs, and answers the core's
// { status, body }. A core that THROWS answers 500 { error: 'internal' } — never the error text. The recovery sender comes from the
// SDK_OTP_SENDER secret's JSON ({ instance_id, token }); anything unparsable ⇒ null ⇒ the core's 503. makeHandlers(depsOf) is
// the testable seam; the onRequest / trigger exports bind it to productionDeps. Run: node payments/sdk/d4-endpoints.test.js
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-d4-endpoints-0123456789abcdef01234';
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const OTP = require('../../otp-lib');

let pass = 0; const fails = [];
const cell = async (L, fn) => { try { await fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const EP = () => require('./endpoints');
const T0 = 1_000_000;
const OID = 'sdk_261112-101500-ABCDEFGH';
const GUEST_PHONE = '50499990000';
function world({ sender = { instance_id: 'inst', token: 'tok' }, extra = {} } = {}) {
  let t = T0;
  const sends = [];
  const db = makeHonestDb({ orders: { [OID]: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', customer_uid: 'uid_A', total_cents: 10000, pay_deadline_at: T0 + 9e5 },
    sdk_guest: { payment_flow: 'sdk_auth_v1', status: 'pending_payment', restaurant_id: 'tb_rest', guest_verified: { phone: GUEST_PHONE, phone_hash: OTP.phoneHash(GUEST_PHONE) }, pay_deadline_at: T0 + 9e5 } },
    platform_config: { sdk_pay: { available: true, restaurants: { tb_rest: true } } }, ...extra }, { now: () => t });
  const deps = { db, psp: makeAdapter(makeFakePsp({}).impl), clock: () => t, voidEligible: () => false, ppNamespace: 'sandbox', goLive: async () => {}, releaseResources: async () => {}, OTP,
    verifyIdToken: async (x) => (x === 'idt_A' ? { uid: 'uid_A' } : (() => { throw new Error('bad'); })()),
    senderConfig: () => sender, fetchImpl: async (url, init) => { sends.push({ url, body: new URLSearchParams(init.body) }); return { ok: true, json: async () => ({ sent: 'true', id: 'm1' }) }; } };
  return { db, deps, sends, tick: (ms) => { t += ms; } };
}
// a minimal express-shaped req / res
const req = (method, { headers = {}, query = {}, body = {}, ip = '10.0.0.1' } = {}) => ({ method, headers, query, body, ip, get: (k) => headers[String(k).toLowerCase()] });
function res() { const r = { statusCode: 200, headers: {}, payload: undefined, status(c) { r.statusCode = c; return r; }, set(k, v) { r.headers[k] = v; return r; }, json(b) { r.payload = b; return r; } }; return r; }
const call = async (h, rq) => { const r = res(); await h(rq, r); return r; };

(async () => {
  await cell('SDK-D4-EP-METHODS', async (L) => {
    const w = world(); const H = EP().makeHandlers(() => w.deps);
    for (const [name, allow] of [['placeSdkStatus', 'GET'], ['cancelSdkPending', 'POST'], ['listCards', 'GET'], ['removeCard', 'POST'], ['sdkPayStatus', 'GET'], ['recoverOrderAccess', 'POST']]) {
      const wrong = allow === 'GET' ? 'POST' : 'GET';
      const r = await call(H[name], req(wrong));
      assert.ok(r.statusCode === 405 && r.headers.Allow === allow && r.payload && r.payload.error === 'method_not_allowed', `${L}: ${name} ${wrong} ⇒ 405 Allow: ${allow} (got ${r.statusCode} ${JSON.stringify(r.payload)})`);
    }
  });

  await cell('SDK-D4-EP-DELEGATION', async (L) => {
    // each wrapper answers EXACTLY what its core answers for the same inputs (two identical worlds)
    const pairs = [
      ['placeSdkStatus', req('GET', { headers: { authorization: 'Bearer idt_A' }, query: { order_id: OID } }), (d) => require('./status-endpoint').placeSdkStatusCore(d, { headers: { authorization: 'Bearer idt_A' }, query: { order_id: OID } })],
      ['cancelSdkPending', req('POST', { headers: { authorization: 'Bearer idt_A' }, body: { order_id: OID } }), (d) => require('./switch-endpoint').cancelSdkPendingCore(d, { headers: { authorization: 'Bearer idt_A' }, body: { order_id: OID } })],
      ['listCards', req('GET', { headers: { authorization: 'Bearer idt_A' } }), (d) => require('./cards').listCardsCore(d, { headers: { authorization: 'Bearer idt_A' } })],
      ['removeCard', req('POST', { headers: { authorization: 'Bearer idt_A' }, body: { card_id: 'c'.repeat(20) } }), (d) => require('./cards').removeCardCore(d, { headers: { authorization: 'Bearer idt_A' }, body: { card_id: 'c'.repeat(20) } })],
      ['sdkPayStatus', req('GET'), async (d) => ({ status: 200, body: await require('./sdk-pay-flag').sdkPayStatusCore(d.db) })],
      ['recoverOrderAccess', req('POST', { body: { order_id: 'sdk_guest' }, ip: '10.0.0.7' }), (d) => require('./recovery').recoverOrderAccessCore(d, { ip: '10.0.0.7', body: { order_id: 'sdk_guest' } })],
    ];
    for (const [name, rq, core] of pairs) {
      const a = world(); const b = world();
      const r = await call(EP().makeHandlers(() => a.deps)[name], rq);
      const want = await core(b.deps);
      assert.deepStrictEqual({ status: r.statusCode, body: r.payload }, { status: want.status, body: want.body }, `${L}: ${name} answers exactly its core`);
      assert.strictEqual(JSON.stringify(a.db.root), JSON.stringify(b.db.root), `${L}: ${name} writes exactly what its core writes`);
    }
  });

  await cell('SDK-D4-EP-NO-LEAK', async (L) => {
    const w = world();
    const H = EP().makeHandlers(() => ({ ...w.deps, db: { ref: () => { throw new Error('secret internal detail'); } } }));
    const warned = []; const oe = console.error; console.error = (...x) => warned.push(x.join(' '));
    try {
      const r = await call(H.placeSdkStatus, req('GET', { headers: { authorization: 'Bearer idt_A' }, query: { order_id: OID } }));
      assert.ok(r.statusCode === 500 && JSON.stringify(r.payload) === '{"error":"internal"}', `${L}: a core throw ⇒ 500 { error: internal }, never the message (${JSON.stringify(r.payload)})`);
    } finally { console.error = oe; }
    assert.ok(warned.some((x) => /placeSdkStatus/.test(x)), `${L}: the failure is logged (by name) for a person`);
  });

  await cell('SDK-D4-EP-SENDER', async (L) => {
    const P = EP().parseSender;
    assert.deepStrictEqual(P('{"instance_id":"inst","token":"tok"}'), { instance_id: 'inst', token: 'tok' }, `${L}: the secret JSON ⇒ the sender`);
    for (const bad of ['', 'not json', '{"instance_id":"","token":""}', '{"instance_id":"x"}', '[]', 'null', null, undefined]) assert.strictEqual(P(bad), null, `${L}: ${JSON.stringify(bad)} ⇒ null (the core answers 503)`);
    const w = world({ sender: null });
    const r = await call(EP().makeHandlers(() => w.deps).recoverOrderAccess, req('POST', { body: { order_id: 'sdk_guest' } }));
    assert.deepStrictEqual([r.statusCode, r.payload], [503, { error: 'recovery_unavailable' }], `${L}: no sender ⇒ 503 before any write`);
  });

  await cell('SDK-D4-EP-RECOVERY-TRIGGER', async (L) => {
    const w = world(); const H = EP().makeHandlers(() => w.deps);
    await call(H.recoverOrderAccess, req('POST', { body: { order_id: 'sdk_guest' } }));
    const [id] = Object.keys(w.db.getAt('sdk_recovery_queue') || {});
    assert.ok(id, `${L}: premise — the request queued an entry`);
    await H.processSdkRecovery({ params: { id } });
    assert.ok(w.sends.length === 1 && w.db.getAt(`sdk_recovery_queue/${id}`) == null, `${L}: the create trigger processes the entry (one send, the entry claimed)`);
    await call(H.recoverOrderAccess, req('POST', { body: { order_id: 'sdk_guest' }, ip: '10.0.0.8' }));
    w.tick(3 * 60 * 1000);
    await H.sweepSdkRecovery();
    assert.ok(w.db.getAt('sdk_recovery_queue') == null, `${L}: the fallback sweep drains an entry the trigger missed`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nd4-endpoints: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
