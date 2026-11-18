'use strict';
// THE SDK cancel fence on the emulator (PLAN-sdk-fence-r1 §6) — the REAL exports: exports.cancelSdkPending (an ABSENT order ⇒ the fence,
// the byte-identical no_sdk_order answer) and exports.placeSdkOrder (a fenced id ⇒ 409 order_exists 'closed', before any finish write,
// no authorization) — the late original, the SAME attempt resent after another order was paid, a second device of the same member; an
// owner-bound fence never refuses another customer. External effects stubbed: WhatsApp, the hosted create, the ID-token verifier, the
// PSP (the contract fake via productionDeps). Run: npm run test:sdk-fence
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sdk-fence-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-sdk-fence-0123456789abcdef0123456789';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async () => { throw new Error('sdk-fence: no hosted step may run'); } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => {
  const m = /^idt_(m|d2)(\d+)$/.exec(String(t));   // a member per cell, keyed by its phone; d2 = the SAME member's second device
  if (m) return { uid: `uid_fence_${m[2]}`, customer: true };
  if (String(t).startsWith('admin')) return { uid: String(t) };
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
const OE = require('../order-exists');
const PC = require('../../customer-app/capp-pay-card.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sdk-fence: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', () => {
      const payload = JSON.stringify(body);
      const rq = http.request({ host: '127.0.0.1', port: s.address().port, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (r) => {
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

const DAYS7 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OPEN7 = Object.fromEntries(DAYS7.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5.5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const RID = 'x_pizza';
const LINE = { name: 'Margherita', qty: 1, price: 0 };
const W = { Authorization: 'Bearer adminowner' };
const CARD = (tok) => ({ kind: 'new', sdk_token: tok, save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } });
let NSN = 0; const sdkId = () => `sdk_261113-${String(120000 + (NSN += 1)).padStart(6, '0')}-FENXMABC`;
let ATT = 0; const att = () => `att_fence_${String(ATT += 1).padStart(11, '0')}`;
// the CLIENT's body (the real capp-pay-card placeBody): an app delivery 3 km north, inside the 7 km limit
const sdkBody = (orderId, attemptId, ph, tok = 'tok_fence') => {
  const p = north(3);
  const base = { restaurant_id: RID, order_id: orderId, customer_name: 'Fence SDK', customer_phone: ph, customer_email: 'fence@example.com', items_text: `1x ${LINE.name}`,
    order_type: 'delivery', payment_method: 'online', items: [LINE], lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true };
  const b = PC.placeBody(base, CARD(tok), attemptId, { guest: false }, null);
  assert.ok(b, 'premise — the client builds the SDK body');
  return b;
};
const fresh = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const SDK = (b, dev = 'm') => post(app.placeSdkOrder, b, { Authorization: `Bearer idt_${dev}${b.customer_phone}` });
const CANCEL = (id, ph, dev = 'm') => post(app.cancelSdkPending, { order_id: id }, { Authorization: `Bearer idt_${dev}${ph}` });
const val = async (p) => (await rtdb.ref(p).once('value')).val();
const NO_SDK = { cancelled: false, safe_to_switch: true, reason: 'no_sdk_order' };
const fencesFor = async (id) => Object.values((await val('sdk_fence')) || {}).filter((r) => r.order_id === id).map((r) => r.owner).sort();

(async () => {
  await wipe();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'sdk-fence-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, location_name: `Sucursal ${RID}`, hours: OPEN7 });
  await rtdb.ref('platform_admins/adminowner').set(true);
  await rtdb.ref('platform_config/sdk_pay').set({ available: true, restaurants: { [RID]: true } });
  { const r = await post(app.setDeliveryPricing, { expected_policy_version: 0, bands: BANDS, limits: [{ rid: RID, km: 7 }] }, W); assert.strictEqual(r.status, 200, `premise: pricing (${r.text.slice(0, 200)})`); }

  // 1. CANCEL-BEFORE-CREATE: the app's cancel of an order that never reached the server ⇒ the fence; the late original ⇒ refused
  //    closed, nothing created, no authorization
  {
    const ph = '99772001'; const X = sdkId(); const A = att();
    const c = await CANCEL(X, ph);
    assert.deepStrictEqual([c.status, c.json], [200, NO_SDK], `CANCEL-BEFORE-CREATE: the byte-identical no_sdk_order (${c.text.slice(0, 200)})`);
    assert.deepStrictEqual(await fencesFor(X), [`u_uid_fence_${ph}`], 'CANCEL-BEFORE-CREATE: the caller\'s fence is stored');
    await fresh(); FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    const r = await SDK(sdkBody(X, A, ph));
    assert.deepStrictEqual([r.status, r.json], [409, OE.orderExistsBody('closed', X)], `CANCEL-BEFORE-CREATE: the late original ⇒ 409 order_exists closed (${r.text.slice(0, 200)})`);
    assert.strictEqual(FAKE.callCount('authorize'), 0, 'CANCEL-BEFORE-CREATE: zero authorizations');
    assert.deepStrictEqual([await val(`orders/${X}`), await val(`payment_sdk_due/${X}`), await val(`payment_sdk/${X}`)], [null, null, null], 'CANCEL-BEFORE-CREATE: no order, no due entry, no record');

    // 2. PERMANENT: the customer pays with a NEW id; then the SAME attempt of X resent, and X from a second device ⇒ refused
    const Y = sdkId();
    await fresh(); FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }, { outcome: 'approved' }, { outcome: 'approved' }] });
    const y = await SDK(sdkBody(Y, att(), ph));
    assert.ok(y.status === 200 && ['placed', 'bank_pending'].includes(y.json && y.json.outcome), `premise: Y authorized (${y.text.slice(0, 200)})`);
    await fresh();
    const again = await SDK(sdkBody(X, A, ph));
    await fresh();
    const dev2 = await SDK(sdkBody(X, att(), ph, 'tok_device_2'), 'd2');
    assert.deepStrictEqual([again.status, dev2.status], [409, 409], `PERMANENT: the same attempt and a second device ⇒ refused (${again.text.slice(0, 120)} | ${dev2.text.slice(0, 120)})`);
    assert.strictEqual(FAKE.callCount('authorize'), 1, 'PERMANENT: only Y\'s authorization');
    assert.strictEqual(await val(`orders/${X}`), null, 'PERMANENT: X never created');
  }
  ok('CANCEL-BEFORE-CREATE + PERMANENT: an absent order\'s cancel fences the id; the late original, the same attempt after another order, and a second device are refused (409 closed) with zero authorizations');

  // 3. FOREIGN: another customer's cancel of X fences only THAT customer; the owner places X normally
  {
    const owner = '99772003'; const other = '99772004'; const X = sdkId();
    const c = await CANCEL(X, other);
    assert.deepStrictEqual([c.status, c.json], [200, NO_SDK], 'FOREIGN: the other customer\'s cancel ⇒ no_sdk_order');
    await fresh(); FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    const r = await SDK(sdkBody(X, att(), owner));
    assert.ok(r.status === 200 && FAKE.callCount('authorize') === 1, `FOREIGN: the owner's order proceeds (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual(await fencesFor(X), [`u_uid_fence_${other}`], 'FOREIGN: only the other customer\'s fence');
  }
  ok('FOREIGN: a fence is owner-bound — another customer\'s cancel never refuses the owner\'s order');

  FINISHED = true;
  console.log(`\nsdk-fence: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('sdk-fence: FAILED —', e && e.stack || e); process.exit(1); });
