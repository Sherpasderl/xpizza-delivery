'use strict';
// D4 post-merge (asm7 HIGH gate P1 + P2, advisor 2026-11-12) — an SDK request that REUSES an existing SDK order (a new attempt after a
// decline) is admitted on the order's STORED delivery facts by Envío's resume guard, BEFORE chargeOnlineApp's content stamp / prune /
// rate-limit writes (P2) — the request's fresh context alone measures from the CURRENT hub, which a moved hub can pass. The REAL exports
// on the emulator: exports.placeSdkOrder, Envío's exports.setDeliveryPricing (the real limit writer), the real identity. External effects
// stubbed: WhatsApp, the hosted create, the ID-token verifier, the PSP (the contract fake via productionDeps).
// WRITE-TRACE (Envío's envlim pattern): every actual Admin-SDK write op, by path; only dispatcher_alerts/* is allowed before a refusal.
// Run: npm run test:sdk-envlim
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sdk-envlim-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-sdk-envlim-0123456789abcdef01234567';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async () => { throw new Error('sdk-envlim: no hosted step may run'); } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => {
  if (/^idt_m\d+$/.test(t)) return { uid: `uid_envlim_${t.slice(5)}`, customer: true };   // one member per cell (C6: one unresolved SDK checkout per member)
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
const PC = require('../../customer-app/capp-pay-card.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sdk-envlim: FAILED — exited without completing'); process.exitCode = 1; } });

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
// ── WRITE-TRACE (test/envlim.emulator.test.js's recorder, verbatim shape) ──
const refProto = (() => { let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'update')) p = Object.getPrototypeOf(p); return p; })();
const pathOf = (r) => decodeURIComponent(new URL(r.toString()).pathname).replace(/^\/+/, '').replace(/\/+$/, '');
const WRITES = { on: false, list: [], start() { this.list = []; this.on = true; }, stop() { this.on = false; return this.list.filter((p) => !/^dispatcher_alerts(\/|$)/.test(p)); } };
for (const m of ['set', 'update', 'remove', 'transaction', 'setWithPriority', 'setPriority']) {
  const orig = refProto[m]; if (typeof orig !== 'function') continue;
  refProto[m] = async function (...a) {
    const p = pathOf(this);
    if (m === 'transaction') { const r = await orig.apply(this, a); if (WRITES.on && r && r.committed) WRITES.list.push(p); return r; }
    if (WRITES.on) { if (m === 'update' && a[0] && typeof a[0] === 'object') for (const k of Object.keys(a[0])) WRITES.list.push(p ? `${p}/${k}` : k); else WRITES.list.push(p); }
    return orig.apply(this, a);
  };
}
{ const origPush = refProto.push; refProto.push = function (v, ...r) { if (WRITES.on && v !== undefined) WRITES.list.push(`${pathOf(this)}/<push>`); return origPush.call(this, v, ...r); }; }

const DAYS7 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OPEN7 = Object.fromEntries(DAYS7.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5.5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const RID = 'x_pizza';
const LINE = { name: 'Margherita', qty: 1, price: 0 };
const W = { Authorization: 'Bearer adminowner' };
const NEW_CARD = { kind: 'new', sdk_token: 'tok_envlim', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } };
let PV = 0;
async function limit(km) {
  const r = await post(app.setDeliveryPricing, { expected_policy_version: PV, bands: BANDS, limits: [{ rid: RID, km }] }, W);
  assert.deepStrictEqual([r.status, r.json && r.json.ok], [200, true], `premise: the real pricing writer saved (${r.text.slice(0, 200)})`);
  PV = r.json.policy_version;
}
const setHub = async (hub) => { await rtdb.ref(`restaurants/${RID}/identity`).update({ hub_lat: hub.lat, hub_lng: hub.lng }); require('../restaurant-config')._cache.clear(); };
let NSN = 0; const sdkId = () => `sdk_261112-${String(120000 + (NSN += 1)).padStart(6, '0')}-ENVXMABC`;
let ATT = 0; const att = () => `att_envlim_${String(ATT += 1).padStart(10, '0')}`;
// the CLIENT's body (the real capp-pay-card placeBody), an app delivery pinned `km` north of the ORIGINAL hub
const sdkBody = (orderId, km, attemptId, ph) => {
  const p = north(km);
  const base = { restaurant_id: RID, order_id: orderId, customer_name: 'Envlim SDK', customer_phone: ph, customer_email: 'envlim@example.com', items_text: `1x ${LINE.name}`,
    order_type: 'delivery', payment_method: 'online', items: [LINE], lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true };
  const b = PC.placeBody(base, NEW_CARD, attemptId, { guest: false }, null);
  assert.ok(b, 'premise — the client builds the SDK body');
  return b;
};
const fresh = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const SDK = async (b) => post(app.placeSdkOrder, b, { Authorization: `Bearer idt_m${b.customer_phone}` });   // the member keyed by the cell's phone
const val = async (p) => (await rtdb.ref(p).once('value')).val();
// an existing SDK order at `km` (limit `under` km), attempt 1 DECLINED — the real create-once through the real export
async function existing(km, under, ph) {
  await setHub(HUB); await limit(under); await fresh();
  const id = sdkId();
  FAKE = makeFakePsp({ authorize: [{ outcome: 'definitive_decline', code: '05' }] });
  const r = await SDK(sdkBody(id, km, att(), ph));
  assert.ok(r.status === 200 && r.json && r.json.outcome === 'declined', `premise: attempt 1 created the SDK order and was declined (${r.text.slice(0, 200)})`);
  const o = await val(`orders/${id}`);
  assert.ok(o && o.payment_flow === 'sdk_auth_v1' && o.hub_lat === HUB.lat && o.delivery_snapshot && o.delivery_snapshot.mode === 'delivery', `premise: the stored app delivery with its hub snapshot (${JSON.stringify(o && { hub: o.hub_lat, ds: o.delivery_snapshot })})`);
  return id;
}

(async () => {
  await wipe();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'sdk-envlim-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, location_name: `Sucursal ${RID}`, hours: OPEN7 });
  await rtdb.ref('platform_admins/adminowner').set(true);
  await rtdb.ref('platform_config/sdk_pay').set({ available: true, restaurants: { [RID]: true } });

  // 1. SDK-ENVLIM-HUB-MOVED (Codex asm7 P1/P2 reproduction): stored pin 5 km from the STORED hub; the hub moves 2 km north and the limit
  //    drops to 4 ⇒ the fresh context (3 km from the CURRENT hub) passes, the stored order does not ⇒ refused with Envío's contract,
  //    before ANY write (no stamp, prune, rate token, due entry, subject, attempt), and no authorization
  {
    const id = await existing(5, 7, '99771001');
    await setHub(north(2)); await limit(4); await fresh();
    FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    const before = JSON.stringify(await val(`orders/${id}`));
    WRITES.start();
    const r = await SDK(sdkBody(id, 5, att(), '99771001'));
    const writes = WRITES.stop();
    assert.deepStrictEqual([r.status, r.json], [409, { error: 'outside_delivery_bands', order_id: id }], `HUB-MOVED: Envío's refusal contract (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual(writes, [], `HUB-MOVED WRITE-TRACE: zero writes outside dispatcher_alerts (${JSON.stringify(writes)})`);
    assert.strictEqual(FAKE.callCount('authorize'), 0, 'HUB-MOVED: zero authorizations');
    assert.strictEqual(JSON.stringify(await val(`orders/${id}`)), before, 'HUB-MOVED: the order is untouched');
  }
  ok('HUB-MOVED: a new attempt on an SDK order whose STORED pin is beyond the limit is refused (409 outside_delivery_bands), zero writes, no authorization — though the moved hub passes the fresh context');

  // 2. SDK-ENVLIM-HUB-MISSING — the stored hub snapshot gone ⇒ 409 order_context_changed (fail closed), zero writes
  {
    const id = await existing(3, 7, '99771002');
    await rtdb.ref(`orders/${id}/hub_lat`).remove();
    await limit(4); await fresh();
    FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    WRITES.start();
    const r = await SDK(sdkBody(id, 3, att(), '99771002'));
    const writes = WRITES.stop();
    assert.deepStrictEqual([r.status, r.json], [409, { error: 'order_context_changed', order_id: id }], `HUB-MISSING (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual(writes, [], `HUB-MISSING WRITE-TRACE: zero writes (${JSON.stringify(writes)})`);
    assert.strictEqual(FAKE.callCount('authorize'), 0, 'HUB-MISSING: zero authorizations');
  }
  ok('HUB-MISSING: a stored order with no hub snapshot fails closed (409 order_context_changed), zero writes, no authorization');

  // 3. SDK-ENVLIM-IN-RANGE — the same reuse inside the limit proceeds (the new attempt is authorised)
  {
    const id = await existing(3, 7, '99771003');
    await limit(4); await fresh();
    FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    const r = await SDK(sdkBody(id, 3, att(), '99771003'));
    assert.ok(r.status === 200 && ['placed', 'bank_pending'].includes(r.json && r.json.outcome) && FAKE.callCount('authorize') === 1, `IN-RANGE: the new attempt proceeds (${r.text.slice(0, 200)})`);
  }
  ok('IN-RANGE: a reuse inside the limit proceeds to its authorization');

  // 4. SDK-ENVLIM-FRESH — a FRESH SDK order beyond the limit is refused by the fresh context, unchanged (no order, no authorization)
  {
    await setHub(HUB); await limit(4); await fresh();
    FAKE = makeFakePsp({ authorize: [{ outcome: 'approved' }] });
    const id = sdkId();
    WRITES.start();
    const r = await SDK(sdkBody(id, 5, att(), '99771004'));
    const writes = WRITES.stop();
    assert.deepStrictEqual([r.status, r.json && r.json.error, await val(`orders/${id}`), FAKE.callCount('authorize')], [409, 'outside_delivery_bands', null, 0], `FRESH (${r.text.slice(0, 200)})`);
    assert.deepStrictEqual(writes, [], `FRESH WRITE-TRACE: zero writes (${JSON.stringify(writes)})`);
  }
  ok('FRESH: a new SDK order beyond the limit is refused by the fresh context as before, zero writes');

  FINISHED = true;
  console.log(`\nsdk-envlim: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('sdk-envlim: FAILED —', e && e.stack || e); process.exit(1); });
