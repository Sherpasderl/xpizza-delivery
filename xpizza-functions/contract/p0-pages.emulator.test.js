'use strict';
// R3 P0 — PAGE BOOT R1 KDS, R2 dispatch, R3 dispatch-lite, R4 driver, R7 dashboard, R8 tracker (PLAN-R3 rev 4.1 §5a, §9):
// the REAL pages in jsdom over the §5a adapter, fed ONLY by real writers (createOrder, chargeOnlineOrder, the real
// auto-assigner through the scheduler). Each page: boots with no script error, opens its subscriptions, renders the
// order after the acknowledged barrier + settled rendering; the pending online order (S6) is ABSENT where it must be.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-pages
require('../test/_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'r3-p0-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';

// send boundaries (as the trace suites): WhatsApp, Firebase Auth token verification, the PixelPay hosted charge
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;

require('../test/_catalog-clock').install();
require('./version-witness').install();
const admin = require('firebase-admin');
const app = require('../index.js');
const D = require('./discovery');
const { createScheduler } = require('./scheduler');
const S = createScheduler({ admin, triggers: D.dbTriggers(D.runtimeInventory(app)), run: new Set(['autoAssignOnOrderCreate']) }).install();
const { createFirebaseHost } = require('./rtdb-adapter');
const { bootPage } = require('./page-harness');
const { installGoogleMaps } = require('./maps-stub');
const rtdb = admin.database(); const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');

function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const H = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2', 'x-firebase-id-token': 'u_pages' };
const OPEN = { open: true, start: '00:00', end: '24:00' };
const STAFF = 'staff_r3';
const CSS_NOISE = /Could not parse CSS stylesheet/;

function body(oid, name, method) {
  const it = catalogSnapshot('x_pizza').items.find((i) => i.key === 'Carnivora');
  return { restaurant_id: 'x_pizza', order_id: oid, customer_name: name, customer_phone: method === 'online' ? '99880002' : '99880001', customer_email: 'pages@example.com',
    items_text: `1x ${it.display.name}`, order_type: 'delivery', payment_method: method, address_detected: 'Col. Pages', lat: 14.1, lng: -87.2,
    items: [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] };
}

// [cell, dir, url, the subscription paths that must open, the EXACT queries on the order-data roots]
// codex r1 P1-5: the QUERY (path + constraints) is verified, not just the path — an absence cell is only meaningful if the
// page's order query is the one reviewed (KDS / driver: the whole /orders node, filtered client-side; dispatch: + its
// pending_payment window). Exact multiset over orders / tasks / drivers / driver_cash / order_tracking.
const Q = (path, constraints = []) => `value:${path}${constraints.length ? JSON.stringify(constraints) : ''}`;
const PAGES = [
  ['R1', 'xpizza-kitchen', 'https://xpizzakitchen.netlify.app/', ['orders', 'menus/x_pizza'], [Q('orders'), Q('orders')]],
  ['R2', 'xpizza-dispatch', 'https://xpizzadispatch.netlify.app/', ['orders', 'tasks', 'drivers', 'driver_cash'], [Q('drivers'), Q('tasks'), Q('orders'), Q('driver_cash'), Q('orders'), Q('orders', [['orderByChild', 'status'], ['equalTo', 'pending_payment']])]],
  ['R3', 'xpizza-dispatch-mobile', 'https://xpizzadispatchlite.netlify.app/', ['orders', 'tasks', 'drivers'], [Q('orders'), Q('orders'), Q('drivers'), Q('tasks')]],
  ['R4', 'xpizza-driver', 'https://xpizzadriver.netlify.app/', ['orders', 'tasks', 'drivers'], [Q('drivers'), Q('tasks'), Q('orders')]],
  ['R7', 'xpizza-dashboard', 'https://xpizzadashboard.netlify.app/', ['orders', 'tasks', 'drivers'], [Q('orders'), Q('tasks'), Q('drivers')]],
  ['R8', 'xpizza-track', null, null, null],
];
const ORDER_ROOTS = /^(orders|tasks|drivers|driver_cash|order_tracking)(\/|$)/;

(async () => {
  await S.fixture(async () => {
    await rtdb.ref().set(null);
    for (const rid of ['x_pizza', 'la_musa']) {
      await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
      const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `pages-${rid}` });
      await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
      await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
      await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
    }
    for (const role of ['kitchen', 'dispatchers']) await rtdb.ref(`${role}/${STAFF}`).set(true);
    await rtdb.ref(`drivers/${STAFF}`).set({ name: 'Drv Pages', status: 'available', active: true, push_reachable: true, lat: 14.1, lng: -87.2 });   // on shift (driver state is a fixture, not an order fact)
    await rtdb.ref('config/auto_assign_enabled').set(true);
  });

  // the real writers: a cash delivery (auto-assigned to the one eligible driver) and a PENDING online order (S6)
  const cash = await S.writer('createOrder pg_cash', () => post(app.createOrder, body('pg_cash', 'Pages Cash', 'cash'), H), { served: [] });
  assert.strictEqual(cash.r.status, 200, FAIL('P0', `createOrder pg_cash (${cash.r.text.slice(0, 160)})`));
  const pend = await S.writer('chargeOnlineOrder pg_pend', () => post(app.chargeOnlineOrder, body('pg_pend', 'Pages Pending', 'online'), H), { served: [] });
  assert.strictEqual(pend.r.status, 200, FAIL('P0', `chargeOnlineOrder pg_pend (${pend.r.text.slice(0, 160)})`));
  assert.strictEqual((await rtdb.ref('orders/pg_pend/status').get()).val(), 'pending_payment', FAIL('P0', 'premise — the online order stays pending_payment (no callback)'));
  await S.drain('orders');
  await S.advance(30000, 'auto-assign grace');
  const pickup = (await rtdb.ref('tasks/pg_cash_pickup').get()).val() || {};
  assert.strictEqual(pickup.assigned_driver_id, STAFF, FAIL('P0', `the real auto-assigner assigned pg_cash to the page's driver (${pickup.assigned_driver_id})`));
  const token = cash.r.json.tracking_token;
  PAGES[5][2] = `https://xpizzatrack.netlify.app/${token}`; PAGES[5][3] = [`order_tracking/${token}`]; PAGES[5][4] = [Q(`order_tracking/${token}`)];
  ok(`real writers: createOrder pg_cash (HTTP 200) → auto-assigned to ${STAFF} by the real auto-assigner after advance(30 s); chargeOnlineOrder pg_pend stays pending_payment (S6)`);

  const OBS = {};
  for (const [cell, dir, url, wantSubs, wantQueries] of PAGES) {
    const host = createFirebaseHost({ pageId: cell, user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
    let maps = null;
    const p = await bootPage(dir, { host, url, beforeScripts: (w) => { maps = installGoogleMaps(w); } });
    // settled: the auth callback → role check → subscriptions → first render; then the acknowledged barrier + settle
    for (let i = 0; i < 50 && !host.subs.length; i += 1) await new Promise((r) => setTimeout(r, 50));
    await host.barrier();
    const settled = await p.settle();
    const errs = [...p.errors.filter((e) => !CSS_NOISE.test(e)), ...host.callbackErrors.map((e) => `callback on ${e.path}: ${e.error}`)];
    const text = p.doc.body.textContent;
    const paths = new Set(host.subs.map((s) => s.path));
    OBS[cell] = { subs: host.subs.length, pendShown: text.includes('Pages Pending'), maps: maps && { markers: maps.markers.length, infoWindows: maps.infoWindows.length }, skipped: p.skipped, refused: p.refused };
    try {
      assert.deepStrictEqual(errs, [], FAIL(cell, `${dir} boot errors:\n  ${errs.join('\n  ')}`));
      assert.ok(p.evaluated.includes('inline module') || p.evaluated.some((x) => /module/.test(x)), FAIL(cell, `${dir}: its module script ran (${JSON.stringify(p.evaluated)})`));
      for (const w of wantSubs) assert.ok(paths.has(w), FAIL(cell, `${dir}: subscription on ${w} opened (${[...paths].join(', ')})`));
      assert.strictEqual(settled, true, FAIL(cell, `${dir}: rendering never SETTLED after the barrier (in flight: ${p.inflight()}; blocking timers:\n    ${p.pendingSites().join('\n    ')})`));
      const got = host.subs.filter((x) => ORDER_ROOTS.test(x.path)).map((x) => `${x.kind}:${x.path}${(x.constraints || []).length ? JSON.stringify(x.constraints) : ''}`).sort();
      assert.deepStrictEqual(got, [...wantQueries].sort(), FAIL(cell, `${dir}: the order-data QUERIES differ from the reviewed set`));
      assert.ok(host.subs.every((s) => !s.error), FAIL(cell, `${dir}: a subscription was cancelled (${JSON.stringify(host.subs.filter((s) => s.error))})`));
      assert.ok(text.includes('Pages Cash'), FAIL(cell, `${dir}: the real order is rendered after the barrier (customer name) — visible text: ${text.replace(/\s+/g, ' ').trim().slice(0, 700)}`));
      if (['R1', 'R4'].includes(cell)) assert.ok(!OBS[cell].pendShown, FAIL(cell, `${dir}: the PENDING online order (S6) is rendered — it must be absent`));
    } finally { p.close(); await host.close(); }
    ok(`${cell} ${dir}: booted (no script error), ${host.subs.length} subscriptions incl. the reviewed order-data queries (${wantQueries.length}), SETTLED after the barrier, the order rendered${['R1', 'R4'].includes(cell) ? ', the S6 pending order ABSENT' : ''}${maps && maps.maps ? ` (maps double: ${maps.markers.length} markers, ${maps.infoWindows.length} info window)` : ''}`);
  }
  console.log(`\nP0-OBS ${JSON.stringify(OBS)}`);
  S.assertClean(['monitorAssignmentTimeout']);
  console.log(`\nr3-p0-pages: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-pages FAILED:', e && e.stack || e); process.exit(1); });
