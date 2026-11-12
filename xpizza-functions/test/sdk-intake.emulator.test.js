'use strict';
// D4 §A6 / §A3 / §A4 (PLAN-sdk-d4-r11) — the SDK intake through the REAL exports on the emulator: exports.placeSdkOrder (the
// SAME chargeOnlineOrder handler, mode set only by placeSdkApp) beside exports.chargeOnlineOrder. External effects only are
// stubbed: WhatsApp, the hosted checkout create (recorded), the ID-token verifier, and the PSP (the contract fake, injected
// through productionDeps — the coordinator, record, subject and every gate are real).
// Hosted no-regression is ALSO proven by the existing hosted suites, run unchanged (d4b-charge-trace's frozen golden, s3b-return,
// order-control, intake-availability, add-product-intake, rewards-redeem-intake, …).
// Run: npm run test:sdk-intake
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sdk-intake-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-sdk-intake-0123456789abcdef0123456';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const HOSTED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { HOSTED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
let FLAKY = 0;
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => {
  if (t === 'idt_member') return { uid: 'uid_member', customer: true };
  if (t === 'idt_hang') return new Promise(() => {});
  if (t === 'idt_flaky') { FLAKY += 1; if (FLAKY === 1) return { uid: 'uid_flaky', customer: true }; throw new Error('re-verification failed'); }
  throw new Error('bad token');
} }) }));
const { makeAdapter } = require('../payments/sdk/psp-adapter');
const { makeFakePsp } = require('../payments/sdk/fake-adapter');
let FAKE = makeFakePsp({});
stub('../payments/sdk/deps', (r) => ({ ...r, productionDeps: (db) => ({ ...r.productionDeps(db), psp: makeAdapter(FAKE.impl), ppNamespace: 'sandbox' }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const G = require('../checkout-guest-lib');
const OTP = require('../otp-lib');
const { normalizePhone } = require('../whatsapp');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sdk-intake: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body, headers = {}, query = '') {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const rq = http.request({ host: '127.0.0.1', port: s.address().port, path: `/${query}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (r) => {
        let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; });
        r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} s.close(() => resolve({ status: r.statusCode, json: j, text: t })); });
      });
      rq.on('error', (e) => s.close(() => reject(e)));
      rq.end(payload);
    });
  });
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
let PH = 0;
const orderBody = (rid, extra = {}) => ({ restaurant_id: rid, order_id: `sdkin_${rid}_${PH += 1}_${Date.now()}`, customer_name: 'Ana Pérez', customer_phone: `9977${String(PH).padStart(4, '0')}`,
  customer_email: 'ana.perez@gmail.com', items_text: `1x ${LINE[rid].name}`, order_type: 'pickup', payment_method: 'online', items: [LINE[rid]], ...extra });
const NEW_CARD = { kind: 'new', sdk_token: 'tok_emu', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } };
let ATT = 0;
const sdkBody = (rid, extra = {}) => orderBody(rid, { attempt_id: `att_emu_${String(ATT += 1).padStart(12, '0')}`, card: NEW_CARD, ...extra });
const MEMBER = { Authorization: 'Bearer idt_member' };
const fresh = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); HOSTED.length = 0; };
const SDK = async (b, h = MEMBER, q = '') => { await fresh(); return post(app.placeSdkOrder, b, h, q); };
const HOSTED_CALL = async (b, h = {}, q = '') => { await fresh(); return post(app.chargeOnlineOrder, b, { Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...h }, q); };
const val = async (p) => (await rtdb.ref(p).once('value')).val();
async function mintTicket(b) {
  const ticket = G.newTicketId(); const digits = normalizePhone(b.customer_phone);
  await rtdb.ref(`checkout_tickets/${G.ticketKey(ticket)}`).set(G.ticketRecord({ phone: digits, phoneHash: OTP.phoneHash(digits), rid: b.restaurant_id, cartFp: await G.cartFpFromBody(b), orderId: b.order_id, now: Date.now() }));
  return ticket;
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'sdk-intake-seed' });
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  }
  process.env.PIXELPAY_RETURN_URL_LA_MUSA = 'https://lm.example';
  await rtdb.ref('platform_config/sdk_pay').set({ available: true, restaurants: { x_pizza: true, la_musa: true } });

  // 1. SDK-D4-MODE-FROM-EXPORT — nothing in a request makes chargeOnlineOrder the SDK; placeSdkOrder never takes a hosted step
  for (const [label, extra, h, q] of [['body.sdk_mode', { sdk_mode: true }, {}, ''], ['?sdk=1', {}, {}, '?sdk=1'], ['a ticket header', {}, { 'X-Sherpa-Order-Ticket': 'ct_' + '0'.repeat(32) }, '']]) {
    const r = await HOSTED_CALL(orderBody('x_pizza', extra), h, q);
    assert.ok(r.status === 200 && r.json && r.json.checkout_url && HOSTED.length === 1, `MODE-FROM-EXPORT: chargeOnlineOrder with ${label} ⇒ hosted (${r.text.slice(0, 160)})`);
  }
  FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
  const sb = sdkBody('x_pizza');
  const s1 = await SDK(sb);
  const o1 = await val(`orders/${sb.order_id}`);
  assert.ok(s1.status === 200 && !('checkout_url' in (s1.json || {})) && !('poll_token' in (s1.json || {})) && HOSTED.length === 0, `MODE-FROM-EXPORT: placeSdkOrder never returns a hosted artifact (${s1.text.slice(0, 200)})`);
  assert.ok(o1 && o1.payment_flow === 'sdk_auth_v1' && !o1.active_attempt_id, `MODE-FROM-EXPORT: an SDK order (${JSON.stringify(o1 && { flow: o1.payment_flow, aaid: o1.active_attempt_id })})`);
  assert.ok(Object.values((await val('payment_attempts')) || {}).every((a) => a.order_id !== sb.order_id), 'MODE-FROM-EXPORT: never a payment_attempts row for the SDK order');
  ok('the mode comes only from the export: hosted stays hosted whatever the request says; the SDK never takes a hosted step');

  // 2. SDK-D4-PLACE-MEMBER — the stored total is charged; placed; no redemption on the order
  const auth = FAKE.calls.find((c) => c.action === 'authorize');
  assert.ok(o1.payment_placed && auth && auth.amount_cents === o1.total_cents && !('redemption' in o1) && o1.customer_uid === 'uid_member', `PLACE-MEMBER: placed at the STORED total, the verified member, no redemption (${JSON.stringify({ placed: o1.payment_placed, amt: auth && auth.amount_cents, total: o1.total_cents })})`);
  ok('a member placement through the real export: placed at the stored total, never a redemption');

  // 3. SDK-D4-REPLAY-KNOWN — the same attempt again ⇒ its outcome; no new authorization; no order write
  const before = JSON.stringify(await val(`orders/${sb.order_id}`));
  const s2 = await SDK(sb);
  assert.ok(s2.status === 200 && s2.json.outcome === s1.json.outcome && FAKE.callCount('authorize') === 1 && JSON.stringify(await val(`orders/${sb.order_id}`)) === before, `REPLAY-KNOWN: a known attempt answers, no gate / write / authorization (${s2.text.slice(0, 160)})`);
  ok('a replayed attempt answers its outcome without a new authorization or an order write');

  // 4. SDK-D4-HOSTED-BETWEEN / P1-4 — a hosted order under the id ⇒ 409, never its hosted URL / poll token
  const hb = orderBody('x_pizza');
  const h1 = await HOSTED_CALL(hb, { 'x-firebase-id-token': 'idt_member' });
  assert.strictEqual(h1.status, 200, `premise — the hosted checkout exists (${h1.text.slice(0, 120)})`);
  const s3 = await SDK({ ...sdkBody('x_pizza'), ...hb, attempt_id: 'att_emu_hostedbetween01', card: NEW_CARD });
  assert.ok(s3.status === 409 && !/pay\.test|poll_token|checkout_url/.test(s3.text), `HOSTED-BETWEEN: 409, no hosted artifact (${s3.text.slice(0, 200)})`);
  ok('a hosted checkout under the same id ⇒ 409; the SDK never echoes a hosted URL or poll token');

  // 5. SDK-D4-AUTH-MIXED / GUEST-FORGED / VERIFY-TIMEOUT / NO-REDEEM / APP-SEMANTICS through the export
  const st = async (b, h) => { const r = await SDK(b, h); return [r.status, r.json && r.json.error]; };
  assert.deepStrictEqual(await st(sdkBody('x_pizza'), { ...MEMBER, 'X-Sherpa-Order-Ticket': 'ct_' + '1'.repeat(32) }), [401, 'mixed_credentials'], 'AUTH-MIXED: Bearer + ticket ⇒ 401');
  assert.deepStrictEqual(await st(sdkBody('x_pizza'), { Authorization: 'Bearer junk', 'X-Sherpa-Order-Ticket': 'ct_' + '1'.repeat(32) }), [401, 'mixed_credentials'], 'AUTH-MIXED: an invalid Bearer + a ticket ⇒ 401 (no fallback)');
  for (const dep of [undefined, 'forms', 'orders-app']) assert.deepStrictEqual(await st(sdkBody('x_pizza'), { 'X-Sherpa-Order-Ticket': 'ct_' + 'a'.repeat(32), ...(dep ? { 'X-Client-Deployment': dep } : {}) }), [401, 'guest_ticket_invalid'], `GUEST-FORGED: deployment ${dep} ⇒ 401`);
  assert.deepStrictEqual(await st(sdkBody('x_pizza'), { Authorization: 'Bearer idt_hang' }), [503, 'auth_unavailable'], 'VERIFY-TIMEOUT: ⇒ 503, never a guest');
  assert.deepStrictEqual(await st(sdkBody('x_pizza', { redeem: { reward_id: 'rw' } }), MEMBER), [400, 'redeem_not_available'], 'NO-REDEEM: ⇒ 400');
  assert.deepStrictEqual(await st(sdkBody('x_pizza', { entry_mode: 'direct' }), MEMBER), [400, 'entry_mode'], 'APP-SEMANTICS: direct ⇒ 400');
  assert.strictEqual(await val('user_rewards'), null, 'NO-REDEEM: zero user_rewards writes');
  ok('one credential kind, the forged ticket, the verify timeout, no redeem and app semantics — through the real export');

  // 6. SDK-D4-MEMBER-REVERIFY-FAILS — verified at B1, the downstream re-verification fails ⇒ refused (the guest gate, deployment forced)
  FLAKY = 0;
  const fb = sdkBody('x_pizza');
  const fr = await SDK(fb, { Authorization: 'Bearer idt_flaky' });
  assert.ok(fr.status >= 400 && (await val(`orders/${fb.order_id}`)) === null && FLAKY >= 2, `MEMBER-REVERIFY-FAILS: refused, nothing written (${fr.text.slice(0, 160)})`);
  ok('a member whose downstream re-verification fails is refused by the guest gate — never a skipped gate, never placed');

  // 7. SDK-D4-PLACE-GUEST — the REAL ticket record; the order carries the verified phone
  FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
  const gb = sdkBody('x_pizza'); const ticket = await mintTicket(gb);
  const g1 = await SDK({ ...gb, checkout_ticket: ticket }, { 'X-Sherpa-Order-Ticket': ticket });
  const go = await val(`orders/${gb.order_id}`);
  assert.ok(g1.status === 200 && go && go.payment_placed && go.guest_verified && go.guest_verified.phone_hash === OTP.phoneHash(normalizePhone(gb.customer_phone)) && !go.customer_uid, `PLACE-GUEST: placed with the verified phone (${g1.text.slice(0, 200)})`);
  ok('a guest placement with the real ticket: placed, bound to the verified phone');

  // 8. SDK-D4-DEFERRED-GATES (pause) — the same refusal through BOTH handlers; the SDK writes no attempt and calls no PSP
  await rtdb.ref('order_control/la_musa/current').set({ paused: true });
  FAKE = makeFakePsp({});
  const hp = await HOSTED_CALL(orderBody('la_musa'));
  const sp = await SDK(sdkBody('la_musa'));
  assert.ok(hp.status === sp.status && JSON.stringify(hp.json && hp.json.error) === JSON.stringify(sp.json && sp.json.error) && FAKE.callCount('authorize') === 0, `DEFERRED-GATES: paused ⇒ the same refusal on both paths (${hp.status} ${hp.text.slice(0, 80)} | ${sp.status} ${sp.text.slice(0, 80)})`);
  await rtdb.ref('order_control/la_musa/current').set({ paused: false });
  ok('a paused restaurant refuses both handlers the same way; the SDK asks no money');

  // 9. SDK-D4-UNAVAILABLE / SCHEDULED — before any write
  await rtdb.ref('platform_config/sdk_pay/restaurants/x_pizza').remove();
  const ub = sdkBody('x_pizza'); const u = await SDK(ub);
  assert.ok(u.status === 200 && u.json.outcome === 'unavailable' && (await val(`orders/${ub.order_id}`)) === null, `UNAVAILABLE: the flag off ⇒ unavailable, nothing written (${u.text.slice(0, 120)})`);
  await rtdb.ref('platform_config/sdk_pay/restaurants/x_pizza').set(true);
  ok('the card flag gates a NEW attempt before any write');

  FINISHED = true;
  console.log(`\nsdk-intake (emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('sdk-intake FAILED:', e && (e.stack || e)); process.exit(1); });
