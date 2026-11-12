'use strict';
// ENVÍO — each restaurant's own maximum delivery distance, end to end on the emulator through the REAL index.js handlers, the REAL
// owner-only writer (setDeliveryPricing over HTTP — every limit is set ONLY through it) and the real Admin SDK
// (PLAN-envio-restaurant-limit-r5 §2, §7). The WRITE-TRACE cells compare the WHOLE RTDB tree before and after a refused resume:
// nothing may differ outside the dispatcher_alerts allowlist (r5 §2.4). Run: npm run test:envlim
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'envlim-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'envlim-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.PIXELPAY_MERCHANT_EMAIL = 'merchant@example.com';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => (String(t).startsWith('admin') ? { uid: String(t) } : { uid: String(t), customer: true }) }) }));
const CAPS = { render: false, authoring: false };
stub('../catalog/platform-groups', (r) => ({ ...r, groupCapabilities: () => ({ ...CAPS }) }));
// the catalog-fallback row (r5 §2.4): a switch that makes the Firestore catalog unreadable, so the resolver alarms
// (dispatcher_alerts) and prices from the warm ladder — the ONE write the allowlist admits before a limit refusal
const CATALOG = { fail: false };
stub('../catalog/catalog-firestore', (r) => ({ ...r,
  getRestaurantDocs: (...a) => (CATALOG.fail ? Promise.reject(new Error('envlim: catalog down')) : r.getRestaurantDocs(...a)),
  getActiveVersionId: (...a) => (CATALOG.fail ? Promise.reject(new Error('envlim: catalog down')) : r.getActiveVersionId(...a)) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const DW = require('../delivery/delivery-wire');
const { releaseRedemption } = require('../rewards-reserve');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('envlim: FAILED — exited without completing'); process.exitCode = 1; } });

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
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const DAYS7 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOSED7 = Object.fromEntries(DAYS7.map((d) => [d, { open: false }]));
const OPEN7 = Object.fromEntries(DAYS7.map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
const setHours = async (h) => { for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity/hours`).set(h); require('../restaurant-config')._cache.clear(); };
const HUB = { lat: 14.1, lng: -87.2 };
const north = (km) => ({ lat: +(HUB.lat + km / 111.195).toFixed(6), lng: HUB.lng });
const BANDS = [{ max_km: 2, cents: 3000 }, { max_km: 5, cents: 5000 }, { max_km: 7, cents: 7000 }];
const ZERO = [{ max_km: 7, cents: 0 }];   // RESUME-NULL-DQ: a writer-created ZERO-fee band (the dark total equals the app total)
const PATH = 'platform_config/delivery_pricing';
const LINES = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'dimsum_01', name: 'dimsum_01', qty: 1, price: 225, extras: [] } };
const MEMBER = 'u_envlim_member';
const REDEEM = { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };
const W = { Authorization: 'Bearer adminowner' };
let PHONE = 0;
const phone = () => `9977${String(++PHONE).padStart(4, '0')}`;
const formBody = (id, { rid = 'x_pizza', type = 'delivery', method = 'cash', km = 4, ph, extra = {} } = {}) => {
  const p = north(km);
  return { restaurant_id: rid, order_id: `el_${id}`, customer_name: 'Envlim', customer_phone: ph || phone(), customer_email: 'envlim@example.com',
    items_text: `1x ${LINES[rid].name}`, order_type: type, payment_method: method, items: [LINES[rid]],
    ...(type === 'delivery' ? { lat: p.lat, lng: p.lng, address_detected: 'Col. Prueba', address_details: 'Casa 1' } : {}), ...extra };
};
const appBody = (id, o = {}) => formBody(id, { ...o, extra: { pin_confirmed: true, entry_mode: 'app', ...(o.extra || {}) } });
const recOf = async (id) => (await rtdb.ref(`orders/el_${id}`).get()).val();
const attemptsOf = async (id) => Object.values((await rtdb.ref('payment_attempts').get()).val() || {}).filter((a) => a && a.order_id === `el_${id}`);
const holdOf = async (id) => ((await rtdb.ref(`user_rewards/${MEMBER}/x_pizza/reservations/el_${id}`).get()).val());
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
// the WHOLE tree outside the dispatcher_alerts allowlist (r5 §2.4)
const tree = async () => { const v = (await rtdb.ref().get()).val() || {}; delete v.dispatcher_alerts; return JSON.stringify(canon(v)); };
const alertsN = async () => Object.keys((await rtdb.ref('dispatcher_alerts').get()).val() || {}).length;
const stampsNaming = async (oid) => { const all = (await rtdb.ref('recent_order_content').get()).val() || {}; let k = 0; for (const ph of Object.values(all)) for (const s of Object.values(ph || {})) if (s && s.order_id === oid) k++; return k; };
let PV = 0;
async function save(over) {
  const r = await post(app.setDeliveryPricing, { expected_policy_version: PV, bands: BANDS, ...over }, W);
  assert.deepStrictEqual([r.status, r.json && r.json.ok], [200, true], `premise: the writer saved (${r.text.slice(0, 200)})`);
  PV = r.json.policy_version; return r;
}
const limit = (km, bands = BANDS) => save({ bands, limits: [{ rid: 'x_pizza', km }, { rid: 'la_musa', km }] });
const REFUSED = (r, err = 'outside_delivery_bands') => [r.status, r.json && r.json.error, r.json && 'checkout_url' in r.json];

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'envlim-seed' });
    const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
    await publishVersion(fs, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, location_name: `Sucursal ${rid}`, hours: OPEN7 });
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  await rtdb.ref(`user_rewards/${MEMBER}/x_pizza`).set({ balance: 50, reserved: 0 });
  await rtdb.ref('platform_admins/adminowner').set(true);

  // ── L1 QUOTE-ORDER-SAME: the REAL writer's limit → the REAL quote, createOrder and charge, both brands, limit ± 0.01 ──
  await limit(4);
  for (const rid of ['x_pizza', 'la_musa']) {
    const q = await post(app.quoteOrder, { restaurant_id: rid, items: [LINES[rid]], mode: 'delivery', pin: { ...north(3.99), confirmed: true }, entry_mode: 'app' });
    assert.deepStrictEqual([q.status, q.json && q.json.delivery && q.json.delivery.max_km], [200, 4], `L1 ${rid}: quote inside, reporting the effective limit (${q.text.slice(0, 200)})`);
    const qf = await post(app.quoteOrder, { restaurant_id: rid, items: [LINES[rid]], mode: 'delivery', pin: { ...north(4.01), confirmed: true }, entry_mode: 'app' });
    assert.deepStrictEqual([qf.status, qf.json && qf.json.error], [200, 'outside_delivery_bands'], `L1 ${rid}: quote beyond (fail-soft 200) (${qf.text.slice(0, 200)})`);
    const c = await post(app.createOrder, appBody(`q1_${rid}`, { rid, km: 3.99 }));
    assert.strictEqual(c.status, 200, `L1 ${rid}: cash order inside (${c.text.slice(0, 200)})`);
    const cf = await post(app.createOrder, appBody(`q2_${rid}`, { rid, km: 4.01 }));
    assert.deepStrictEqual([cf.status, cf.json && cf.json.error, await recOf(`q2_${rid}`)], [409, 'outside_delivery_bands', null], `L1 ${rid}: cash order beyond — never quoted, still refused (F3) (${cf.text.slice(0, 200)})`);
    CHARGED.length = 0;
    const k = await post(app.chargeOnlineOrder, appBody(`q3_${rid}`, { rid, km: 4.01, method: 'online' }));
    assert.deepStrictEqual([k.status, k.json && k.json.error, CHARGED.length, (await attemptsOf(`q3_${rid}`)).length], [409, 'outside_delivery_bands', 0, 0], `L1 ${rid}: card beyond (${k.text.slice(0, 200)})`);
  }
  ok('L1 QUOTE-ORDER-SAME: the writer\'s 4 km limit — both brands quote / order / charge at 3.99 km, and refuse at 4.01 km (the order even unquoted)');

  // ── L2 RESUME-GRANDFATHERED + WRITE-TRACE (dq, no redemption) ──
  await limit(6);
  CHARGED.length = 0;
  const g = await post(app.chargeOnlineOrder, appBody('g1', { km: 5, method: 'online', ph: '99770900' }));
  assert.ok(g.status === 200 && g.json.checkout_url && CHARGED.length === 1, `premise: a live app checkout at 5 km under 6 (${g.text.slice(0, 200)})`);
  await limit(4);
  {
    const before = await tree(); CHARGED.length = 0;
    const r = await post(app.chargeOnlineOrder, appBody('g1', { km: 5, method: 'online', ph: '99770900' }));
    assert.deepStrictEqual([...REFUSED(r), CHARGED.length], [409, 'outside_delivery_bands', false, 0], `L2 (${r.text.slice(0, 200)})`);
    assert.strictEqual(await tree(), before, 'L2 WRITE-TRACE: zero writes outside dispatcher_alerts (no stamp, prune, rate token, attempt or order change)');
  }
  ok('L2 RESUME-GRANDFATHERED: the owner lowers the limit under a live checkout → its resume is refused, no URL, nothing charged; WRITE-TRACE: zero writes');

  // ── L3 RESUME-BOUND + WRITE-TRACE (dq, the reward-BOUND reuse) ──
  await limit(6);
  CAPS.render = true; CHARGED.length = 0;
  const b = await post(app.chargeOnlineOrder, appBody('b1', { km: 5, method: 'online', ph: '99770901', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  assert.ok(b.status === 200 && b.json.checkout_url, `premise: a reward-bound checkout (${b.text.slice(0, 200)})`);
  await limit(4);
  {
    const before = await tree();
    const r = await post(app.chargeOnlineOrder, appBody('b1', { km: 5, method: 'online', ph: '99770901', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
    assert.deepStrictEqual(REFUSED(r), [409, 'outside_delivery_bands', false], `L3 (${r.text.slice(0, 200)})`);
    assert.strictEqual(await tree(), before, 'L3 WRITE-TRACE: zero writes (the hold, attempt and order untouched)');
  }
  CAPS.render = false;
  ok('L3 RESUME-BOUND: the reward-bound reuse is refused the same way; WRITE-TRACE: zero writes');

  // ── L4 WRITE-TRACE (dq, redeeming, render OFF): reservation reused / released / none ──
  await limit(6);
  const rr = await post(app.chargeOnlineOrder, appBody('r1', { km: 5, method: 'online', ph: '99770902', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  assert.ok(rr.status === 200 && rr.json.checkout_url && (await holdOf('r1')).state === 'reserved', `premise: a reward checkout holding its reservation (${rr.text.slice(0, 200)})`);
  await limit(4);
  for (const state of ['reused', 'released', 'none']) {
    if (state === 'released') await releaseRedemption(rtdb, { uid: MEMBER, rid: 'x_pizza', orderId: 'el_r1', now: Date.now() });
    if (state === 'none') await rtdb.ref(`user_rewards/${MEMBER}/x_pizza/reservations/el_r1`).remove();
    const before = await tree();
    const r = await post(app.chargeOnlineOrder, appBody('r1', { km: 5, method: 'online', ph: '99770902', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
    assert.deepStrictEqual(REFUSED(r), [409, 'outside_delivery_bands', false], `L4 ${state} (${r.text.slice(0, 200)})`);
    assert.strictEqual(await tree(), before, `L4 WRITE-TRACE (${state}): zero writes — no reserve, no stamp, no rate token`);
  }
  ok('L4 dq + redemption (reservation reused / released / none): refused before the reserve; WRITE-TRACE: zero writes each');

  // ── L5 RESUME-NULL-DQ + WRITE-TRACE: a zero-fee band, an app checkout, the retry WITHOUT the app marker ──
  await limit(6, ZERO);
  const z = await post(app.chargeOnlineOrder, appBody('n1', { km: 5, method: 'online', ph: '99770903' }));
  assert.ok(z.status === 200 && z.json.checkout_url && (await recOf('n1')).delivery_snapshot.mode === 'delivery', `premise: an app checkout on the zero-fee band (${z.text.slice(0, 200)})`);
  const zr = await post(app.chargeOnlineOrder, appBody('n2', { km: 5, method: 'online', ph: '99770904', extra: { redeem: REDEEM } }), { 'x-firebase-id-token': MEMBER });
  assert.ok(zr.status === 200 && zr.json.checkout_url, `premise: a reward app checkout on the zero-fee band (${zr.text.slice(0, 200)})`);
  await limit(4, ZERO);
  for (const mode of [undefined, 'direct']) {
    const nb = (id, ph, extra = {}) => { const x = formBody(id, { km: 5, method: 'online', ph, extra: { pin_confirmed: true, ...(mode ? { entry_mode: mode } : {}), ...extra } }); return x; };
    let before = await tree(); CHARGED.length = 0;
    const r = await post(app.chargeOnlineOrder, nb('n1', '99770903'));
    assert.deepStrictEqual([...REFUSED(r), CHARGED.length], [409, 'outside_delivery_bands', false, 0], `L5 entry_mode ${mode}: refused (${r.text.slice(0, 200)})`);
    assert.strictEqual(await tree(), before, `L5 WRITE-TRACE (null-dq, entry_mode ${mode}): zero writes (m15: only the acquire would have caught it, after the stamps)`);
    for (const state of ['reused', 'released', 'none']) {
      if (mode === undefined && state === 'released') await releaseRedemption(rtdb, { uid: MEMBER, rid: 'x_pizza', orderId: 'el_n2', now: Date.now() });
      if (mode === undefined && state === 'none') await rtdb.ref(`user_rewards/${MEMBER}/x_pizza/reservations/el_n2`).remove();
      before = await tree();
      const rq = await post(app.chargeOnlineOrder, nb('n2', '99770904', { redeem: REDEEM }), { 'x-firebase-id-token': MEMBER });
      assert.deepStrictEqual(REFUSED(rq), [409, 'outside_delivery_bands', false], `L5 redeeming ${state} entry_mode ${mode} (${rq.text.slice(0, 200)})`);
      assert.strictEqual(await tree(), before, `L5 WRITE-TRACE (null-dq + redemption ${state}, entry_mode ${mode}): zero writes`);
    }
  }
  ok('L5 RESUME-NULL-DQ: a retry without the app marker (omitted / direct) is refused by the pre-bookkeeping check, with or without a redemption; WRITE-TRACE: zero writes');

  // ── L6 the catalog-fallback row: pricing via the ladder writes its alert — the ONE allowed write — then the refusal ──
  {
    const before = await tree(); const a0 = await alertsN();
    CATALOG.fail = true;
    await new Promise((r) => setTimeout(r, 46000));   // the catalog reader serves its cached active-version pointer for 45 s (catalog/catalog.js pointerTtlMs): wait it out so THIS request probes the (down) catalog
    const r = await post(app.chargeOnlineOrder, appBody('g1', { km: 5, method: 'online', ph: '99770900' }));
    CATALOG.fail = false;
    assert.deepStrictEqual(REFUSED(r), [409, 'outside_delivery_bands', false], `L6 (${r.text.slice(0, 200)})`);
    assert.ok((await alertsN()) > a0, 'L6 premise: the catalog fallback wrote its dispatcher alert');
    assert.strictEqual(await tree(), before, 'L6 WRITE-TRACE: the alert is the ONLY write');
  }
  ok('L6 catalog-fallback row: the ladder\'s dispatcher_alerts write precedes the refusal and is the only write');

  // ── L7 BACKSTOP-ORDER-RACE: A's pre-check finds no order; B (its earlier snapshot) creates the live checkout; A's guarded reuse refuses ──
  // the ZERO-fee table: B's total (food + 0 envío) equals A's (food, its own dq refused) — so A's reserve REUSES B's hold, and the
  // cart is two pizzas (one free), never a $0 order refused before the pre-check
  await limit(4, ZERO);
  {
    const realPre = DW.preBookkeepingRefusal; let raced = false; const PH = '99770905';
    const bodyA = appBody('x1', { km: 5, method: 'online', ph: PH, extra: { redeem: REDEEM, items: [{ ...LINES.x_pizza, qty: 2 }], items_text: `2x ${LINES.x_pizza.name}` } });
    DW.preBookkeepingRefusal = async (db, oid, dq, pp) => {
      const out = await realPre(db, oid, dq, pp);
      if (oid === 'el_x1' && !raced && out === null) {
        raced = true;
        await limit(6, ZERO);   // B started BEFORE the owner lowered the limit: its snapshot allows 5 km
        CHARGED.length = 0;
        const B = await post(app.chargeOnlineOrder, bodyA, { 'x-firebase-id-token': MEMBER });
        assert.ok(B.status === 200 && B.json.checkout_url && CHARGED.length === 1, `L7 premise: B created the live checkout (${B.text.slice(0, 200)})`);
        await limit(4, ZERO);
      }
      return out;
    };
    const holdB = () => holdOf('x1');
    let A;
    try { A = await post(app.chargeOnlineOrder, bodyA, { 'x-firebase-id-token': MEMBER }); } finally { DW.preBookkeepingRefusal = realPre; }
    assert.ok(raced, `L7 premise: the race ran inside A (after its pre-check) — A answered ${A.status} ${A.text.slice(0, 240)}`);
    assert.deepStrictEqual([...REFUSED(A), CHARGED.length], [409, 'outside_delivery_bands', false, 1], `L7 A answers the refusal — no 503, no URL, B's single charge only (m25) (${A.text.slice(0, 200)})`);
    assert.strictEqual((await holdB()).state, 'reserved', 'L7 B\'s hold (reused from A\'s view) is untouched (m26)');
    assert.strictEqual(await stampsNaming('el_x1'), 0, 'L7 the content stamps naming the order (bookkeeping + A8) are removed (m28, m29)');
    assert.strictEqual(await stampsNaming('el_x2'), 0, 'L7 premise: the next order is new');
    const next = await post(app.createOrder, appBody('x2', { km: 3, ph: PH, extra: { items: [{ ...LINES.x_pizza, qty: 2 }], items_text: `2x ${LINES.x_pizza.name}` } }));
    assert.strictEqual(next.status, 200, `L7 the next legitimate same-cart order passes as fresh (${next.text.slice(0, 200)})`);
  }
  ok('L7 BACKSTOP-ORDER-RACE: B\'s live checkout under its earlier snapshot is refused for A (delivery_refused → 409), only owned holds released, A\'s stamps removed, the next order fresh');

  // ── L8 order_context_changed: an app order whose hub snapshot is missing is never reused (the capp's existing-order path) ──
  await limit(6);
  const h = await post(app.chargeOnlineOrder, appBody('h1', { km: 3, method: 'online', ph: '99770906' }));
  assert.ok(h.status === 200 && h.json.checkout_url, `premise (${h.text.slice(0, 200)})`);
  await rtdb.ref('orders/el_h1/hub_lat').remove();
  {
    const before = await tree();
    const r = await post(app.chargeOnlineOrder, appBody('h1', { km: 3, method: 'online', ph: '99770906' }));
    assert.deepStrictEqual([r.status, r.json, await tree() === before], [409, { error: 'order_context_changed', order_id: 'el_h1' }, true],
      `L8 the server answer the capp maps to existing_order (capp-api.test.mjs «order_context_changed: kept») (${r.text.slice(0, 200)})`);
  }
  ok('L8 HUB-MISSING: a missing hub snapshot → 409 {error: order_context_changed, order_id} (the capp keeps the id and shows the existing order), zero writes');

  // ── L9 LIMITS-ZONES-INTERLEAVE: a limits save and a zones save racing on the real SDK — one winner, one superseded, nothing lost ──
  {
    const zone = { id: 'z_aaaaaaaa', name: 'Sector A', points: [{ lat: 14.13, lng: -87.21 }, { lat: 14.13, lng: -87.19 }, { lat: 14.14, lng: -87.19 }, { lat: 14.14, lng: -87.21 }] };
    await setHours(CLOSED7);
    const [a, z2] = await Promise.all([post(app.setDeliveryPricing, { expected_policy_version: PV, bands: BANDS, limits: [{ rid: 'x_pizza', km: 5 }] }, W),
      post(app.setDeliveryPricing, { expected_policy_version: PV, bands: BANDS, no_delivery_zones: [zone] }, W)]);
    assert.deepStrictEqual([a.status, z2.status].sort(), [200, 409], `L9 one winner (${a.text.slice(0, 120)} | ${z2.text.slice(0, 120)})`);
    const loser = a.status === 409 ? a : z2;
    assert.strictEqual(loser.json.error, 'superseded', 'L9 the loser is superseded');
    PV = (a.status === 200 ? a : z2).json.policy_version;
    const node = (await rtdb.ref(PATH).get()).val();
    assert.ok(node.restaurants && node.restaurants.x_pizza && node.history[0].new_version === PV, 'L9 the map and the history survive whichever won');
    if (a.status === 200) await save({ no_delivery_zones: [zone] }); else await save({ limits: [{ rid: 'x_pizza', km: 5 }] });
    const after = (await rtdb.ref(PATH).get()).val();
    assert.deepStrictEqual([after.restaurants.x_pizza.max_km, after.no_delivery_zones.length], [5, 1], 'L9 the retried loser lands; both kept (m19)');
    await setHours(OPEN7);
  }
  ok('L9 LIMITS-ZONES-INTERLEAVE: concurrent limits and zones saves → exactly one 200 and one superseded; retried, both maps intact');

  // ── L10 FORMS-UNCHANGED: a FORM order beyond every limit is placed exactly as today (dark: no delivery fields) ──
  {
    const f = await post(app.createOrder, formBody('f1', { km: 6.5 }));
    const fr = await recOf('f1');
    assert.ok(f.status === 200 && fr && !('delivery_cents' in fr) && !('delivery_snapshot' in fr), `L10 (${f.text.slice(0, 200)})`);
  }
  ok('L10 FORMS-UNCHANGED: a form order at 6.5 km (beyond the 5 km limit) is placed dark, exactly as today (m14)');

  FINISHED = true;
  console.log(`\nenvlim: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('envlim FAILED:', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); process.exit(1); });
