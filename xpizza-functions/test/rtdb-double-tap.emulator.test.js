'use strict';
// RG-DOUBLE-TAP SDK on the EMULATOR (PLAN-rtdb-get-once-race r9, Codex #404 P3): real server semantics (listener updates, transaction
// retries) instead of the in-process harness. Two concurrent IDENTICAL placeSdkOrder requests (one order id, one attempt id, the real
// client body capp-pay-card.placeBody) through the REAL export; the PSP is the contract fake (productionDeps stub, as sdk-envlim) and its
// first authorization is HELD until the other request has answered (or 3 s), so the two overlap on the order. Required:
//   • exactly ONE provider authorization;
//   • neither answer is a 5xx («listen() called twice» surfaces as the handler's 500 internal), both are real answers (200 with an
//     outcome, or a 4xx refusal with an error code — the replay / in-progress rules);
//   • a DIGEST line (both answers as a sorted pair + the normalized persisted tree) that the slot compares with the SAME file run in the
//     base worktree (production eb177fe58): persisted-state parity with base (rtdb-build/r9/slot.sh step DT-PARITY).
// Run: npm run test:rtdb-double-tap
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'rtdb-dt-secret';
process.env.OTP_SALT = process.env.OTP_SALT || 'test-salt-rtdb-double-tap-0123456789abcdef0123';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async () => { throw new Error('rtdb-dt: no hosted step may run'); } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => {
  if (/^idt_m\d+$/.test(t)) return { uid: `uid_dt_${t.slice(5)}`, customer: true };
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
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('rtdb-double-tap: FAILED — exited without completing'); process.exitCode = 1; } });

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
// the persisted tree, normalized for a base ↔ candidate comparison: clock values (ms epochs) and generated tokens are masked; the shape,
// every status / state / count / amount and every key the request wrote stay
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [/^-[A-Za-z0-9_-]{19}$/.test(k) ? '<push>' : k, norm(v[k])]));
  if (typeof v === 'number' && v > 1e12) return '<T>';
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return '<ISO>';
  if (typeof v === 'string' && v.length >= 24 && /^[A-Za-z0-9_\-.=+/]+$/.test(v) && !/^(att|sdk|uid)_/.test(v)) return '<TOKEN>';
  return v;
};

const DAYS7 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OPEN7 = Object.fromEntries(DAYS7.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
const HUB = { lat: 14.1, lng: -87.2 };
const RID = 'x_pizza';
const LINE = { name: 'Margherita', qty: 1, price: 0 };
const W = { Authorization: 'Bearer adminowner' };
const NEW_CARD = { kind: 'new', sdk_token: 'tok_rtdb_dt', save: false, authentication_identifier: null, display: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } };
const PH = '99772001';
const sdkBody = (orderId, attemptId) => {
  const p = { lat: +(HUB.lat + 3 / 111.195).toFixed(6), lng: HUB.lng };
  const base = { restaurant_id: RID, order_id: orderId, customer_name: 'Doble Toque', customer_phone: PH, customer_email: 'dt@example.com', items_text: `1x ${LINE.name}`,
    order_type: 'delivery', payment_method: 'online', items: [LINE], lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true };
  const b = PC.placeBody(base, NEW_CARD, attemptId, { guest: false }, null);
  assert.ok(b, 'premise — the client builds the SDK body');
  return b;
};
const SDK = (b) => post(app.placeSdkOrder, b, { Authorization: `Bearer idt_m${PH}` });

(async () => {
  await wipe();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'rtdb-dt-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, location_name: `Sucursal ${RID}`, hours: OPEN7 });
  await rtdb.ref('platform_admins/adminowner').set(true);
  await rtdb.ref('platform_config/sdk_pay').set({ available: true, restaurants: { [RID]: true } });
  const pr = await post(app.setDeliveryPricing, { expected_policy_version: 0, bands: [{ max_km: 2, cents: 3000 }, { max_km: 5.5, cents: 5000 }, { max_km: 7, cents: 7000 }], limits: [{ rid: RID, km: 7 }] }, W);
  assert.deepStrictEqual([pr.status, pr.json && pr.json.ok], [200, true], `premise: the real pricing writer saved (${pr.text.slice(0, 200)})`);
  require('../restaurant-config')._cache.clear();

  // DT-SDK-EMU: the first authorization is HELD until the other request answered (or 3 s), so both requests overlap on the order
  {
    const id = 'sdk_261125-130001-RTDBDTAB'; const attemptId = 'att_rtdbdt_0000000001';
    let release; const held = new Promise((r) => { release = r; }); const guard = setTimeout(() => release(), 3000);
    FAKE = makeFakePsp({ authorize: [{ pause: held, outcome: 'approved' }, { outcome: 'approved' }] });
    const body = sdkBody(id, attemptId);
    const ra = SDK(body); await new Promise((r) => setTimeout(r, 40));   // A first (its intake owns the order), B lands while A is in flight
    const rb = SDK(body).then((x) => { release(); return x; });
    const [a, b] = await Promise.all([ra, rb]); clearTimeout(guard);
    const answers = [a, b].map((x) => ({ status: x.status, body: norm(x.json) }));
    console.log(`    DT-SDK-EMU answers: ${a.status} ${a.text.slice(0, 160)} / ${b.status} ${b.text.slice(0, 160)}; authorize=${FAKE.callCount('authorize')}`);
    // the DIGEST first, so a base run that fails the assertions below still yields its state for the parity step
    const tree = norm((await rtdb.ref().once('value')).val());
    for (const k of ['catalog', 'catalog_versions', 'menus', 'restaurants', 'platform_admins', 'platform_config', 'delivery_pricing']) delete tree[k];   // the seed, identical by construction
    console.log(`DIGEST DT-SDK-EMU ${JSON.stringify({ answers: answers.map((x) => JSON.stringify(x)).sort(), tree })}`);
    for (const x of [a, b]) {
      assert.ok(x.status < 500, `🔴 DT-SDK-EMU: no 5xx («listen() called twice» answers 500 internal): ${x.status} ${x.text.slice(0, 200)}`);
      assert.ok(x.json && ((x.status === 200 && typeof x.json.outcome === 'string') || (x.status >= 400 && typeof x.json.error === 'string')), `🔴 DT-SDK-EMU: a real answer (an outcome, or a refusal code): ${x.status} ${x.text.slice(0, 200)}`);
    }
    assert.ok([a, b].some((x) => x.status === 200 && ['placed', 'bank_pending'].includes(x.json.outcome)), `DT-SDK-EMU premise: one request placed the order (${a.text.slice(0, 120)} / ${b.text.slice(0, 120)})`);
    assert.strictEqual(FAKE.callCount('authorize'), 1, '🔴 DT-SDK-EMU: exactly ONE provider authorization');
  }
  ok('DT-SDK-EMU: two concurrent identical placeSdkOrder requests (real export, emulator) ⇒ one authorization, two real answers (no 5xx), DIGEST printed for the base parity step');

  FINISHED = true;
  console.log(`rtdb-double-tap: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('rtdb-double-tap FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
