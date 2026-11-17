'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1) — the CASH sites end to end through the REAL createOrder on the emulator (the real Firebase
// writer: an invalid value would reject the whole multi-path update):
//   S1-FORMS-ABSENT  a plain FORM pickup in cash (every optional absent) is written exactly as today AND carries ledger_alloc/{id}
//   S1-CASH          an APP delivery in cash: ledger_alloc carries mode app, the envío components and the order's totals
//   S1-NO-DIVERGE    two CONCURRENT creates for one order id (different carts): the stored ledger_alloc is the snapshot of the STORED order
//                    (they ride one multi-path update — last writer wins for both together; concurrent create = the demoted backlog item)
//   S1-MISMATCH      a request priced as direct but carrying the app deployment header ⇒ mismatch true (a hand-made request)
//   S1-RULES         no client role reads or writes ledger_alloc
// The card sites run over the honest model (ledger/ledger-s1-sites.test.js). Run: npm run test:ledger-s1
require('./_emulator-required')('database', 'firestore');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'ls1-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'ls1-quote-secret';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const LA = require('../ledger/alloc-snapshot');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function post(handler, body, hdr = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...hdr }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe: not the RTDB emulator');
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const RID = 'x_pizza';
let PH = 0; const phone = () => `9955${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const LINE = { name: 'Margherita', qty: 1, price: 0 };
const body = ({ type = 'pickup', app: isApp = false, id = null, qty = 1, method = 'cash' } = {}) => ({
  restaurant_id: RID, order_id: id || `ls1_${PH}_${Date.now()}`, customer_name: 'Ledger S1', customer_phone: phone(), customer_email: 'ls1@example.com',
  items_text: `${qty}x ${LINE.name}`, order_type: type, payment_method: method, items: [{ ...LINE, qty }],
  ...(type === 'delivery' ? { lat: HUB.lat + 1 / 111.195, lng: HUB.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1', pin_confirmed: true } : {}),
  ...(isApp ? { entry_mode: 'app' } : {}) });
const APP_HDR = { 'x-client-app': 'capp', 'x-client-deployment': 'orders-app', 'x-client-build': '1', 'x-client-compat': '1' };
const read = async (p) => (await rtdb.ref(p).get()).val();
// RTDB keeps no null leaf (and no empty object): the stored form of a snapshot
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return o; };

(async () => {
  await wipe();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const seed = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'ls1-seed' });
  await publishVersion(fs, RID, seed.input, { expected: { activeVersionId: null }, mirror: require('../catalog/mirror-rtdb').makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: RID, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });

  {   // S1-FORMS-ABSENT
    await clean(); const b = body();
    const r = await post(app.createOrder, b);
    assert.strictEqual(r.status, 200, `🔴 S1-FORMS-ABSENT: the plain form order succeeds (${r.text.slice(0, 200)})`);
    const o = await read(`orders/${b.order_id}`); const a = await read(`ledger_alloc/${b.order_id}`);
    assert.ok(o && a, '🔴 S1-FORMS-ABSENT: order and snapshot both written');
    assert.deepStrictEqual(a, stored(LA.snapshotOf(o, LA.modeOf({ body: b, clientHdr: {} }))), '🔴 S1-FORMS-ABSENT: the snapshot is the stored order\'s');
    assert.deepStrictEqual([a.mode, a.mismatch, a.order_type, a.payment_method, 'tip_cents' in a, 'offer' in a], ['direct', false, 'pickup', 'cash', false, false]);
  }
  ok('S1-FORMS-ABSENT: a plain form pickup in cash is accepted as today and carries ledger_alloc (absent optionals not stored)');

  {   // S1-CASH (app delivery, priced)
    await rtdb.ref('platform_config/delivery_pricing').set({ policy_version: 1, bands: [{ max_km: 7, cents: 3000 }], restaurants: {} });
    await clean(); const b = body({ type: 'delivery', app: true });
    const r = await post(app.createOrder, b, APP_HDR);
    assert.strictEqual(r.status, 200, `🔴 S1-CASH (${r.text.slice(0, 200)})`);
    const o = await read(`orders/${b.order_id}`); const a = await read(`ledger_alloc/${b.order_id}`);
    assert.deepStrictEqual(a, stored(LA.snapshotOf(o, LA.modeOf({ body: b, clientHdr: { app: 'capp', deployment: 'orders-app' } }))), '🔴 S1-CASH: the snapshot is the stored order\'s');
    assert.deepStrictEqual([a.mode, a.mismatch, a.envio.delivery_cents, a.total_cents, a.evidence.client_deployment], ['app', false, 3000, o.total_cents, 'orders-app']);
    await rtdb.ref('platform_config/delivery_pricing').remove();
  }
  ok('S1-CASH: an app delivery in cash — ledger_alloc mode app, the envío and the totals of the stored order, the header evidence');

  {   // S1-NO-DIVERGE
    await clean(); const id = `ls1_nd_${Date.now()}`;
    const [r1, r2] = await Promise.all([post(app.createOrder, body({ id, qty: 1 })), post(app.createOrder, body({ id, qty: 3 }))]);
    assert.ok([r1.status, r2.status].includes(200), `premise: at least one create landed (${r1.status} ${r2.status})`);
    const o = await read(`orders/${id}`); const a = await read(`ledger_alloc/${id}`);
    assert.strictEqual(a.total_cents, o.total_cents, '🔴 S1-NO-DIVERGE: the stored snapshot is the stored order\'s, whichever write landed last');
    assert.deepStrictEqual([a.food.subtotal_cents, a.food.tax_cents], [o.subtotal_cents, o.tax_cents], '🔴 S1-NO-DIVERGE: components too');
  }
  ok('S1-NO-DIVERGE: two concurrent creates for one id — ledger_alloc always equals the stored order (one multi-path update)');

  {   // S1-MISMATCH
    await clean(); const b = body();
    const r = await post(app.createOrder, b, APP_HDR);
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    const a = await read(`ledger_alloc/${b.order_id}`);
    assert.deepStrictEqual([a.mode, a.mismatch], ['direct', true], '🔴 S1-MISMATCH: direct pricing with the app deployment header');
  }
  ok('S1-MISMATCH: a direct-priced request carrying the app deployment header is marked mismatch (the ledger quarantines it)');

  {   // S1-RULES
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const RULES = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
    const env = await initializeTestEnvironment({ projectId: 'demo-ls1', database: { rules: RULES } });
    try {
      await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('ledger_alloc/o1').set({ v: 1, mode: 'direct' }); await c.database().ref('dispatchers/d1').set(true); });
      for (const c of [env.unauthenticatedContext(), env.authenticatedContext('u1', { customer: true }), env.authenticatedContext('d1'), env.authenticatedContext('h1', { handheld: true })]) {
        await assertFails(c.database().ref('ledger_alloc/o1').get()); await assertFails(c.database().ref('ledger_alloc').get());
        await assertFails(c.database().ref('ledger_alloc/o1').set({ v: 1 })); await assertFails(c.database().ref('ledger_alloc/o2').set({ v: 1 }));
      }
    } finally { await env.cleanup(); }
  }
  ok('S1-RULES: anonymous, a customer, a dispatcher and a handheld are denied read / write / create on ledger_alloc');
  console.log(`ledger-s1(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`ledger-s1(emulator): FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
