'use strict';
require('./_no-secrets');   // R3 P1-a (codex r2 P1-1c): no real credential in a test process
// R3 P0 — PAGE BOOT R1 KDS, R2 dispatch, R3 dispatch-lite, R4 driver, R7 dashboard, R8 tracker (PLAN-R3 rev 4.1 §5a, §9):
// the REAL pages in jsdom over the §5a adapter, fed ONLY by real writers (createOrder, chargeOnlineOrder, the real
// auto-assigner through the scheduler). Each page: boots with no script error, opens its subscriptions, renders the
// order after the acknowledged barrier + settled rendering; the pending online order (S6) is ABSENT where it must be.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-pages
require('../test/_emulator-required')('database', 'firestore');
// R3 P1 §3a differential: R3_TRACE=1 runs this suite with the site-hit tracer installed (before any census unit loads)
const R3_TRACE = process.env.R3_TRACE === '1' ? (() => { const t = require('./tracer'); const rec = t.createRecorder(); const srv = t.installServer(rec); return { rec, srv }; })() : null;

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
  // F2 Q2 (PLAN-F2-query-rules §2; reviewed with 2e): the KDS reads its location's orders through ONE location query — the live
  // view and Programados both on orderByChild('restaurant_id').equalTo(<this KDS's rid>) — never the whole /orders collection
  ['R1', 'xpizza-kitchen', 'https://xpizzakitchen.netlify.app/', ['orders', 'menus/x_pizza'], [Q('orders', [['orderByChild', 'restaurant_id'], ['equalTo', 'x_pizza']]), Q('orders', [['orderByChild', 'restaurant_id'], ['equalTo', 'x_pizza']])]],
  ['R2', 'xpizza-dispatch', 'https://xpizzadispatch.netlify.app/', ['orders', 'tasks', 'drivers', 'driver_cash'], [Q('drivers'), Q('tasks'), Q('orders'), Q('driver_cash'), Q('orders'), Q('orders', [['orderByChild', 'status'], ['equalTo', 'pending_payment']])]],
  ['R3', 'xpizza-dispatch-mobile', 'https://xpizzadispatchlite.netlify.app/', ['orders', 'tasks', 'drivers'], [Q('orders'), Q('orders'), Q('drivers'), Q('tasks')]],
  // F2(b) driver query-rules (PLAN-F2-query-rules; reviewed with 2e): the driver narrows the whole /tasks, /orders and
  // /drivers reads to its own-assignment query + the two delivered-by history queries + per-assigned-order point listeners
  // + its own drivers/{uid} record (no whole-node read, no cross-driver data). STAFF is the page's driver; pg_cash is the
  // one order assigned to it.
  ['R4', 'xpizza-driver', 'https://xpizzadriver.netlify.app/', ['orders', 'tasks', `drivers/${STAFF}`], [
    Q('tasks', [['orderByChild', 'assigned_driver_id'], ['equalTo', STAFF]]),
    Q('orders', [['orderByChild', 'delivered_by_driver_uid'], ['equalTo', STAFF]]),
    Q('orders', [['orderByChild', 'delivered_by_uid'], ['equalTo', STAFF]]),
    Q('orders/pg_cash'),
    Q(`drivers/${STAFF}`),
  ]],
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

  // A listen awaiting its INITIAL snapshot is IN FLIGHT. The snapshot is HELD behind a test latch (the adapter's
  // initialLatch seam: data arrival is held for the page listener and the in-flight tracking alike, as a slow network
  // would), so the check does not depend on how fast the emulator answers: while it is held, settle() must stay pending —
  // otherwise virtual time certifies a page that has not rendered its data — and after release the first render is shown.
  {
    await rtdb.ref('__r3probe/initial').set({ v: 3 });
    let release; const initialLatch = new Promise((r) => { release = r; });
    const host = createFirebaseHost({ pageId: 'INITIAL', user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture, initialLatch });
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js'; onValue(ref(getDatabase(), '__r3probe/initial'), (s) => { document.getElementById('app').textContent = 'v:' + s.val().v; });</script></body></html>`;
    const p = await bootPage('xpizza-kitchen', { host, html });
    try {
      const sp = p.settle();
      const early = await Promise.race([sp.then((v) => ({ returned: true, v })), new Promise((r) => setTimeout(() => r({ returned: false }), 1500))]);
      assert.ok(!early.returned, FAIL('INITIAL', `a listen awaiting its INITIAL snapshot was not in flight — settle() returned (${JSON.stringify(early)}) while the snapshot was still HELD, text: ${JSON.stringify(p.doc.getElementById('app').textContent)}`));
      assert.strictEqual(p.doc.getElementById('app').textContent, '', FAIL('INITIAL', 'premise — nothing rendered while the snapshot is held'));
      release();
      const settled = await sp;
      assert.ok(settled && p.doc.getElementById('app').textContent === 'v:3', FAIL('INITIAL', `after release, settle() returned before the first render (${JSON.stringify({ settled, text: p.doc.getElementById('app').textContent })})`));
    } finally { release(); p.close(); await host.close(); }
    ok('a listen awaiting its INITIAL snapshot is in flight: with the snapshot HELD, settle() stays pending; after release it returns with the first render');
  }

  // R4 identity (driver slice 1): the page's own label helper over the real orders, and the catalogue's item name (as body())
  const { displayOrderLabel } = await import(require('url').pathToFileURL(require('path').join(__dirname, '..', '..', 'xpizza-driver', 'order-helpers.js')).href);
  const LABEL = { cash: displayOrderLabel((await rtdb.ref('orders/pg_cash').get()).val()), pend: displayOrderLabel((await rtdb.ref('orders/pg_pend').get()).val()) };
  const ITEM = catalogSnapshot('x_pizza').items.find((i) => i.key === 'Carnivora').display.name;
  assert.ok(LABEL.cash && LABEL.pend && LABEL.cash !== LABEL.pend, FAIL('P0', `premise — pg_cash and pg_pend have distinct display labels (${JSON.stringify(LABEL)})`));
  const labelIn = (s, l) => new RegExp(`${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(s);

  const OBS = {}; const SKEW = {};
  for (const [cell, dir, url, wantSubs, wantQueries] of PAGES) {
    const host = createFirebaseHost({ pageId: cell, user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
    let maps = null;
    const p = await bootPage(dir, { host, url, beforeScripts: (w) => { maps = installGoogleMaps(w); }, tracer: R3_TRACE ? R3_TRACE.rec : null });
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
      assert.strictEqual(settled, true, FAIL(cell, `${dir}: rendering never SETTLED after the barrier (in flight: ${p.inflight()}; timers due within the horizon:\n    ${p.dueSites().join('\n    ')})`));
      SKEW[dir] = p.clock.virtualMs();
      const got = host.subs.filter((x) => ORDER_ROOTS.test(x.path)).map((x) => `${x.kind}:${x.path}${(x.constraints || []).length ? JSON.stringify(x.constraints) : ''}`).sort();
      assert.deepStrictEqual(got, [...wantQueries].sort(), FAIL(cell, `${dir}: the order-data QUERIES differ from the reviewed set`));
      assert.ok(host.subs.every((s) => !s.error), FAIL(cell, `${dir}: a subscription was cancelled (${JSON.stringify(host.subs.filter((s) => s.error))})`));
      // R4: pg_cash is still in the OFFER phase (its pickup task 'assigned', not accepted), and the single-order offer card
      // deliberately shows NO customer name or contact (approved design; xpizza-driver/single-order-view.js
      // awaiting_acceptance). So R4 identifies the order by its label + item line, and checks the offer's privacy as a negative.
      if (cell === 'R4') {
        const vis = text.replace(/\s+/g, ' ').trim().slice(0, 700);
        assert.strictEqual((await rtdb.ref('tasks/pg_cash_pickup/status').get()).val(), 'assigned', FAIL(cell, 'premise — pg_cash is still in the offer phase (pickup task assigned, not accepted)'));
        const slot = p.doc.getElementById('active-order-slot');
        const offer = slot && slot.querySelector('.sv-offer');
        assert.ok(offer, FAIL(cell, `${dir}: the real order is rendered after the barrier (the single-order OFFER card in #active-order-slot) — visible text: ${vis}`));
        const onum = offer.querySelector('.sv-onum');
        assert.strictEqual(onum && onum.textContent.trim(), LABEL.cash, FAIL(cell, `${dir}: the offer card names pg_cash by its display label ${JSON.stringify(LABEL.cash)} — visible text: ${vis}`));
        assert.ok(offer.textContent.includes(ITEM), FAIL(cell, `${dir}: the offer card shows pg_cash's item line (${ITEM}) — visible text: ${vis}`));
        assert.ok(!text.includes('Pages Cash'), FAIL(cell, `${dir}: PRIVACY — the customer's name is rendered while pg_cash is still an OFFER — visible text: ${vis}`));
        // the phone as PLAIN TEXT in any display form (spaces, dashes, dots, parens, +504): its last 8 digits (the local
        // number) must not appear in any number-like run of ≥ 8 digits — prices, the countdown and the label are shorter
        const phone8 = String((await rtdb.ref('orders/pg_cash/customer_phone').get()).val() || '').replace(/\D/g, '').slice(-8);
        assert.strictEqual(phone8.length, 8, FAIL(cell, `premise — pg_cash carries a customer phone (${JSON.stringify(phone8)})`));
        const runs = (slot.textContent.match(/\+?\d[\d\s().-]*\d/g) || []).map((r) => r.replace(/\D/g, '')).filter((d) => d.length >= 8);
        assert.ok(!runs.some((d) => d.includes(phone8)), FAIL(cell, `${dir}: PRIVACY — the customer's phone is rendered while pg_cash is still an OFFER (digit runs: ${JSON.stringify(runs)})`));
        const contact = [...slot.querySelectorAll('a[href^="tel:"], a[href*="wa.me"]')].map((a) => a.getAttribute('href'));
        assert.deepStrictEqual(contact, [], FAIL(cell, `${dir}: PRIVACY — a customer contact link is rendered while pg_cash is still an OFFER`));
        // S6 without the name: the offer card never shows one, so the pending order's absence is proven by its LABEL too
        const nums = [...p.doc.querySelectorAll('.sv-onum, .order-num')].map((e) => e.textContent.trim());
        assert.ok(!nums.includes(LABEL.pend) && !labelIn(text, LABEL.pend), FAIL(cell, `${dir}: the PENDING online order (S6) is rendered by its label ${JSON.stringify(LABEL.pend)} (order labels: ${JSON.stringify(nums)})`));
      } else assert.ok(text.includes('Pages Cash'), FAIL(cell, `${dir}: the real order is rendered after the barrier (customer name) — visible text: ${text.replace(/\s+/g, ' ').trim().slice(0, 700)}`));
      if (['R1', 'R4'].includes(cell)) assert.ok(!OBS[cell].pendShown, FAIL(cell, `${dir}: the PENDING online order (S6) is rendered — it must be absent`));
    } finally { p.close(); await host.close(); }
    ok(`${cell} ${dir}: booted (no script error), ${host.subs.length} subscriptions incl. the reviewed order-data queries (${wantQueries.length}), SETTLED after the barrier, the order rendered${cell === 'R4' ? ` (OFFER card: label ${LABEL.cash} + ${ITEM}; no customer name, no phone digits, no tel:/wa.me)` : ''}${['R1', 'R4'].includes(cell) ? `, the S6 pending order ABSENT${cell === 'R4' ? ` (by name AND by label ${LABEL.pend})` : ''}` : ''}${maps && maps.maps ? ` (maps double: ${maps.markers.length} markers, ${maps.infoWindows.length} info window)` : ''}`);
  }
  console.log(`\nP0-OBS ${JSON.stringify(OBS)}`);

  S.assertClean(['monitorAssignmentTimeout']);
  console.log(`  virtual TIMER time advanced by settle() per page (ms; every timer due within the 10 s horizon fired as normal code; wall clock real): ${JSON.stringify(SKEW)}`);

  // codex r6 P1-2: a ROUTED CALLABLE invoked from a page timer is tracked work (the REAL adapter): settle() awaits its
  // handler — the effect is visible before settle() returns
  {
    let done = 0;
    const host = createFirebaseHost({ pageId: 'CALL', user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture, callables: { setOrderStatus: async (d) => { await new Promise((r) => setTimeout(r, 150)); done += 1; return { ok: true, id: d.orderId }; } } });
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js'; setTimeout(function tick() { httpsCallable(getFunctions(), 'setOrderStatus')({ orderId: 'probe', status: 'completed' }).then((r) => { document.getElementById('app').textContent = 'called:' + r.data.id; }); }, 1000);</script></body></html>`;
    const p = await bootPage('xpizza-kitchen', { host, html });
    try {
      const settled = await p.settle();
      assert.ok(settled && done === 1 && p.doc.getElementById('app').textContent === 'called:probe', FAIL('CALL', `a page timer's routed callable was not awaited (${JSON.stringify({ settled, done, text: p.doc.getElementById('app').textContent })})`));
    } finally { p.close(); await host.close(); }
    ok('codex r6 P1-2: a page timer invoking a routed callable (real adapter): the handler ran AND its result rendered before settle() returned');
  }
  // codex r7 P1-2 / P2 on the REAL adapter: an UNAWAITED push(value) from a page timer, the INITIAL auth delivery (+ the
  // work its callback returns), and an async onValue callback awaiting a page timer — each complete before settle() is true
  const CDN = (m) => `https://www.gstatic.com/firebasejs/10.13.2/firebase-${m}.js`;
  {
    const host = createFirebaseHost({ pageId: 'PUSH', user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getDatabase, ref, push } from '${CDN('database')}'; const db = getDatabase(); setTimeout(() => { push(ref(db, '__r3probe/pushes'), { total: 100 }); }, 1000);</script></body></html>`;
    const p = await bootPage('xpizza-kitchen', { host, html });
    try {
      const settled = await p.settle();
      const landed = (await rtdb.ref('__r3probe/pushes').get()).numChildren();
      assert.ok(settled && landed === 1 && host.ioInflight() === 0, FAIL('PUSH', `an unawaited push(value) from a timer was not acknowledged before settle() returned (${JSON.stringify({ settled, landed, io: host.ioInflight() })})`));
    } finally { p.close(); await host.close(); }
    ok('codex r7 P1-2: an UNAWAITED push(ref, {total: 100}) from a page timer — acknowledged (in the database) before settle() returned');
  }
  {
    let good = 0;
    for (let i = 0; i < 10; i++) {
      const host = createFirebaseHost({ pageId: `AUTH${i}`, user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
      const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getAuth, onAuthStateChanged } from '${CDN('auth')}'; onAuthStateChanged(getAuth(), async (u) => { document.getElementById('app').textContent = 'auth:' + (u && u.uid); await new Promise((r) => setTimeout(r, 50)); document.getElementById('app').textContent += ':done'; });</script></body></html>`;
      const p = await bootPage('xpizza-kitchen', { host, html });
      try { const settled = await p.settle(); if (settled && p.doc.getElementById('app').textContent === `auth:${STAFF}:done`) good += 1; } finally { p.close(); await host.close(); }
    }
    assert.strictEqual(good, 10, FAIL('AUTH', `the initial auth delivery (+ its callback's work) was not awaited in ${10 - good}/10 runs (settle() immediately after boot — no subscription polling, no barrier)`));
    ok('codex r7 P1-2: the INITIAL onAuthStateChanged delivery and the work its callback returns (a 50 ms page timer) — awaited 10/10, settle() called immediately after boot');
  }
  {
    await rtdb.ref('__r3probe/async_cb').set({ v: 7 });
    const host = createFirebaseHost({ pageId: 'ASYNCCB', user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
    const html = `<!doctype html><html><body><div id="app"></div><script type="module">import { getDatabase, ref, onValue } from '${CDN('database')}'; onValue(ref(getDatabase(), '__r3probe/async_cb'), async (s) => { await new Promise((r) => setTimeout(r, 30)); document.getElementById('app').textContent = 'v:' + s.val().v; });</script></body></html>`;
    const p = await bootPage('xpizza-kitchen', { host, html });
    try {
      const settled = await p.settle();
      assert.ok(settled && p.doc.getElementById('app').textContent === 'v:7', FAIL('ASYNCCB', `an async onValue callback awaiting a page timer deadlocked (${JSON.stringify({ settled, text: p.doc.getElementById('app').textContent })})`));
    } finally { p.close(); await host.close(); }
    ok('codex r7 P2: an async onValue callback awaiting a 30 ms page timer — the timer fires (a continuation, not I/O) and the render completes');
  }
  if (R3_TRACE) { const h = R3_TRACE.rec.hitsByContext(); console.log(`  R3_TRACE: ${Object.values(h).reduce((a, x) => a + x.size, 0)} distinct site hits; server units transformed ${R3_TRACE.srv.manifest.length}`); }
  console.log(`\nr3-p0-pages: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-pages FAILED:', e && e.stack || e); process.exit(1); });
