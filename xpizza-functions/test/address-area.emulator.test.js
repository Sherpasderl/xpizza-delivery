'use strict';
// Order colonia (PLAN-colonia-address-area r1 §3–§4, Codex r2 APPROVED) — orders/{oid}/address_area end to end on the emulator
// through the REAL handlers (createOrder = cash, chargeOnlineOrder = card) and the REAL edge writers (confirm + materialize, the
// scheduled release). Both brands.
//   1. PERSISTENCE: a street-free label is stored exactly; a forged / street-bearing / digit-bearing / over-long / non-string
//      value, a PICKUP order carrying one, and a request without one leave the key ABSENT (hasChild false) — never ''.
//   2. NO FREE-TEXT DERIVATION: «Col. Trejo, …» in address_detected or address_details with no address_area → absent.
//   3. PAIRED NON-INTERFERENCE (P2-4): per brand, cash / card / scheduled-release pairs IDENTICAL except address_area (absent vs
//      'Colonia Trejo') → equal responses, totals / breakdown, content keys + stamps, payment binding (each fingerprint = the area-free formula over
//      its own order id, recomputed) and the PixelPay amount, tasks, tracking, the WhatsApp message and the factura record; the ONLY order diff is address_area.
//      A retry of the same order with a CHANGED area → the same idempotent answer, the stored area unchanged.
// Run: npm run test:address-area
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'aa-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const WA = []; const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => true, sendMessage: async (to, body, rid) => { WA.push({ to, body, rid }); return { ok: true }; } }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push({ amount: q.amountLempiras }); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { confirmAndMaterialize } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { buildFacturaRecord } = require('../factura/build-record');
const SCHED = require('../scheduled-orders');
const REL = require('../scheduled-release-core');
const { orderFingerprint } = require('../pixelpay-charge');
const { orderContentKey, rateLimitKey } = require('../order-dedup');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('address-area(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}` }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const LINE = { x_pizza: { name: 'Margherita', qty: 1, price: 0 }, la_musa: { id: 'rice_02', name: 'rice_02', qty: 1, price: 0 } };
let SEQ = 0;
const bodyFor = (rid, oid, method, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Area Test', customer_phone: `9966${String(SEQ += 1).padStart(4, '0')}`,
  customer_email: 'aa@example.com', items_text: `1x ${LINE[rid].name}`, order_type: 'delivery', payment_method: method, items: [LINE[rid]],
  lat: HUB.lat + 0.01, lng: HUB.lng + 0.01, address_detected: 'Calle Principal, Tegucigalpa', address_details: 'portón negro', ...extra });
const getOrder = async (oid) => (await rtdb.ref(`orders/${oid}`).get());
const send = async (rid, oid, method, extra) => { await clean(); return post(method === 'cash' ? app.createOrder : app.chargeOnlineOrder, bodyFor(rid, oid, method, extra)); };
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}

// a record with its request-local identity normalised: the order id, the phone, tokens and timestamps. address_area is NOT
// stripped here (codex r1 P2-1): only the ORDER's own key is excluded, by sameBut below, so a copy anywhere else fails
function norm(v, ids) {
  const s = JSON.stringify(v === undefined ? null : v, (k, x) => {
    if (/(^|_)(at|ts|timestamp)$|_at_|token|^created|^updated|expires/.test(k)) return typeof x === 'object' ? x : '<t>';
    return x;
  });
  let out = s;
  for (const [from, to] of ids) out = out.split(from).join(to);
  return JSON.parse(out);
}
const FACTURA_CONFIG = { restaurant_name: 'R', legal_name: 'R SA', rtn: '08011999123456', address_1: 'A', address_2: 'B', email: 'f@x.hn', phone: '+504',
  cai_code: 'ABC-123-CAI', prefix: '000-001-01', range_start: 1, range_end: 100000, fecha_limite: '2027-12-31', is_temp: false };
const edgeDeps = (rid) => ({ db: rtdb, restaurant: { lat: HUB.lat, lng: HUB.lng, name: rid, phone: '+504' }, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {},
  client: { voidTransaction: async () => ({ ok: true }) }, getIdentity: async () => ({ active: true, hours: HOURS }), sanitizeText: (x) => String(x || ''), serverTimestamp: 1,
  voidOrRefund: async () => ({ ok: true, outcome: 'voided' }) });
// the pair's snapshots are equal except for the ORDER's own address_area (tasks / tracking / factura / any nested copy compared)
const ownless = (snap) => { const c = JSON.parse(JSON.stringify(snap)); if (c.o) delete c.o.address_area; return c; };
const sameBut = (sb, idsB, sa, idsA, label) => assert.deepStrictEqual(norm(ownless(sb), idsB), norm(ownless(sa), idsA), label);
let FACTURA_COMPARED = 0;   // non-vacuity: the platform-factura restaurant's pairs really compare a factura record
async function snapshotOf(oid) {
  const o = (await getOrder(oid)).val() || {};
  const tasks = {};
  for (const t of ['pickup', 'delivery']) tasks[t] = (await rtdb.ref(`tasks/${oid}_${t}`).get()).val();
  const tracking = o.tracking_token ? (await rtdb.ref(`order_tracking/${o.tracking_token}`).get()).val() : null;
  // the factura record only where the order carries a factura line set (the platform-factura restaurant; others have none)
  const factura = !(Array.isArray(o.factura_items) || Array.isArray(o.items)) ? null : buildFacturaRecord({ order: { ...o, orderId: oid, razon_social: o.razon_social || '', rtn_cliente: o.rtn_cliente || '' }, config: FACTURA_CONFIG, reserved: 1, now: 1760000000000 });
  // payment_fingerprint hashes the ORDER ID by design (pixelpay-charge.js orderFingerprint), so a pair can never share it: each
  // order's is RECOMPUTED from its own id + total + items text (+ the scheduled slot) — area-free — and then normalised
  if (o.payment_fingerprint !== undefined) {
    const extra = o.scheduled_for != null ? SCHED.fingerprintExtra({ scheduled_for: o.scheduled_for, order_type: o.order_type }) : '';
    assert.strictEqual(o.payment_fingerprint, orderFingerprint(oid, o.total_cents, o.items_text, extra), `🔴 ${oid}: payment_fingerprint is not the area-free formula over its own order id`);
    o.payment_fingerprint = '<fp: the area-free formula, verified>';
  }
  // content_key hashes the customer PHONE by design (order-dedup.js orderContentKey) — recomputed per order, area-free, likewise
  if (o.content_key !== undefined) {
    assert.strictEqual(o.content_key, orderContentKey({ phone: o.customer_phone, itemsText: o.items_text, orderType: o.order_type, scheduledFor: o.scheduled_for != null ? o.scheduled_for : null }), `🔴 ${oid}: content_key is not the area-free formula over its own phone`);
    o.content_key = '<content key: the area-free formula, verified>';
  }
  if (factura) FACTURA_COMPARED += 1;
  return { o, tasks, tracking, factura };
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'aa-seed' });
    await publishVersion(db, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
  }

  // ── 1 + 2. persistence, refusals, no free-text derivation ──
  const FORGED = ['Casa 14, Calle 3', 'Col. Trejo 12', 'Avenida La Paz', '<b>Trejo</b>', '#Trejo', 'x'.repeat(41), { toString: () => 'Colonia Trejo' }, ['Colonia Trejo'], 7, ''];
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const method of ['cash', 'online']) {
      const kept = `aa_keep_${rid}_${method}`;
      const r = await send(rid, kept, method, { address_area: '  Colonia   Trejo ' });
      assert.strictEqual(r.status, 200, `setup ${kept}: ${r.text.slice(0, 200)}`);
      assert.strictEqual((await getOrder(kept)).val().address_area, 'Colonia Trejo', `${rid} ${method}: a street-free label is stored, normalised`);
      let i = 0;
      for (const v of FORGED) {
        const oid = `aa_forged_${rid}_${method}_${i += 1}`;
        const f = await send(rid, oid, method, { address_area: v });
        assert.strictEqual(f.status, 200, `${oid}: the order itself is accepted (${f.text.slice(0, 160)})`);
        assert.strictEqual((await getOrder(oid)).hasChild('address_area'), false, `🔴 ${rid} ${method}: ${JSON.stringify(String(v)).slice(0, 40)} → address_area ABSENT`);
      }
      const pk = `aa_pickup_${rid}_${method}`;
      assert.strictEqual((await send(rid, pk, method, { order_type: 'pickup', address_area: 'Colonia Trejo', lat: undefined, lng: undefined })).status, 200, `setup ${pk}`);
      assert.strictEqual((await getOrder(pk)).hasChild('address_area'), false, `🔴 ${rid} ${method}: a PICKUP order never stores an area`);
      const none = `aa_none_${rid}_${method}`;
      assert.strictEqual((await send(rid, none, method, {})).status, 200, `setup ${none}`);
      assert.strictEqual((await getOrder(none)).hasChild('address_area'), false, `${rid} ${method}: no address_area sent → absent`);
      for (const [k, txt] of [['address_detected', 'Col. Trejo, Tegucigalpa'], ['address_details', 'Col. Trejo, portón negro']]) {
        const oid = `aa_free_${rid}_${method}_${k}`;
        assert.strictEqual((await send(rid, oid, method, { [k]: txt })).status, 200, `setup ${oid}`);
        const o = await getOrder(oid);
        assert.ok(String(o.val()[k]).startsWith('Col. Trejo'), 'premise: the free text is stored');
        assert.strictEqual(o.hasChild('address_area'), false, `🔴 ${rid} ${method}: never derived from ${k}`);
      }
    }
  }
  ok(`persistence (both brands, cash + card): a street-free label stored normalised; ${FORGED.length} forged / street / digit / long / non-string / empty values, a pickup order and a missing field → the key ABSENT; «Col. Trejo» in address_detected / address_details never derives one`);

  // ── 3. paired non-interference ──
  for (const rid of ['x_pizza', 'la_musa']) {
    // cash
    {
      const [a, b] = [`aa_pc_${rid}_A`, `aa_pc_${rid}_B`];
      WA.length = 0;
      const ra = await send(rid, a, 'cash', {}); const waA = WA.splice(0);
      const rb = await send(rid, b, 'cash', { address_area: 'Colonia Trejo' }); const waB = WA.splice(0);
      assert.ok(ra.status === 200 && rb.status === 200, `setup cash pair: ${ra.text.slice(0, 120)} / ${rb.text.slice(0, 120)}`);
      const [sa, sb] = [await snapshotOf(a), await snapshotOf(b)];
      const ids = (s, oid) => [[oid, '<oid>'], [s.o.customer_phone, '<phone>'], ...(s.o.tracking_token ? [[s.o.tracking_token, '<tok>']] : [])];
      assert.strictEqual(sb.o.address_area, 'Colonia Trejo', 'premise: B carries the area');
      assert.strictEqual(sa.o.address_area, undefined, 'premise: A does not');
      assert.deepStrictEqual(norm(rb.json, ids(sb, b)), norm(ra.json, ids(sa, a)), `🔴 ${rid} cash: the response differs`);
      assert.deepStrictEqual(Object.keys(sb.o).filter((k) => !(k in sa.o)), ['address_area'], `🔴 ${rid} cash: the ONLY new order key is address_area`);
      sameBut(sb, ids(sb, b), sa, ids(sa, a), `🔴 ${rid} cash: order / tasks / tracking / factura differ beyond the order's address_area`);
      // NEGATIVE (codex r1 P2-1): a copy of the area ANYWHERE else — the delivery task, the tracking record, the factura — fails
      const leaks = [['tasks.delivery', (c) => { c.tasks.delivery.address_area = 'Colonia Trejo'; }], ['tracking', (c) => { c.tracking.address_area = 'Colonia Trejo'; }]];
      if (sb.factura) leaks.push(['factura', (c) => { c.factura.address_area = 'Colonia Trejo'; }]);
      assert.ok(sb.tasks.delivery && sb.tracking, 'premise: the delivery task and the tracking record exist');
      for (const [where, plant] of leaks) {
        const leaked = JSON.parse(JSON.stringify(sb)); plant(leaked);
        assert.throws(() => sameBut(leaked, ids(sb, b), sa, ids(sa, a), 'x'), assert.AssertionError, `🔴 ${rid}: an area leaked into ${where} must FAIL the comparison`);
      }
      assert.ok(waA.length === 1 && waB.length === 1, 'premise: one WhatsApp each');
      assert.deepStrictEqual(norm(waB[0], ids(sb, b)), norm(waA[0], ids(sa, a)), `🔴 ${rid} cash: the WhatsApp message differs`);
      // a retry of B with a CHANGED area → the same answer as a control retry with the SAME area (the idempotent return);
      // the stored area is not rewritten
      const retry = async (area) => { await clean(); return post(app.createOrder, { ...bodyFor(rid, b, 'cash', { address_area: area }), customer_phone: sb.o.customer_phone }); };
      const control = await retry('Colonia Trejo');
      assert.ok(control.status === 200 && control.json && control.json.idempotent === true, `premise: a same-area retry is the idempotent return — ${control.text.slice(0, 160)}`);
      const again = await retry('Res. Los Castaños');
      assert.deepStrictEqual([again.status, again.json], [control.status, control.json], `🔴 ${rid} cash: a retry with a changed area is the same idempotent answer — ${again.text.slice(0, 160)}`);
      assert.strictEqual((await getOrder(b)).val().address_area, 'Colonia Trejo', `${rid} cash: the retry never rewrites the stored area`);
    }
    // card: issuance + confirm/materialize
    {
      const [a, b] = [`aa_pk_${rid}_A`, `aa_pk_${rid}_B`];
      CHARGED.length = 0;
      const ra = await send(rid, a, 'online', {}); const rb = await send(rid, b, 'online', { address_area: 'Colonia Trejo' });
      assert.ok(ra.status === 200 && rb.status === 200 && CHARGED.length === 2, `setup card pair: ${ra.text.slice(0, 120)} / ${rb.text.slice(0, 120)}`);
      assert.strictEqual(CHARGED[1].amount, CHARGED[0].amount, `🔴 ${rid} card: the PixelPay amount differs`);
      const [pa, pb] = [(await getOrder(a)).val(), (await getOrder(b)).val()];
      assert.strictEqual(pb.address_area, 'Colonia Trejo', 'premise: the pending order carries the area');
      for (const k of ['total', 'total_cents', 'subtotal_cents', 'tax_cents', 'charge_inputs_fp']) assert.deepStrictEqual(pb[k], pa[k], `🔴 ${rid} card: ${k} differs`);
      // (payment_fingerprint hashes the order id — verified per order by recomputation in snapshotOf below)
      const idsP = (o, oid) => [[oid, '<oid>'], [o.customer_phone, '<phone>'], ...(o.active_attempt_id ? [[o.active_attempt_id, '<att>']] : [])];
      assert.deepStrictEqual(norm(rb.json, idsP(pb, b)), norm(ra.json, idsP(pa, a)), `🔴 ${rid} card: the response differs`);
      WA.length = 0;
      await confirmAndMaterialize(edgeDeps(rid), { orderId: a, attemptId: pa.active_attempt_id, now: Date.now(), trackingToken: `TTA${rid}` });
      await confirmAndMaterialize(edgeDeps(rid), { orderId: b, attemptId: pb.active_attempt_id, now: Date.now(), trackingToken: `TTB${rid}` });
      const [sa, sb] = [await snapshotOf(a), await snapshotOf(b)];
      assert.ok(sa.o.payment_status === 'confirmed' && sb.o.payment_status === 'confirmed', 'premise: both materialized');
      assert.strictEqual(sb.o.address_area, 'Colonia Trejo', `${rid} card: materialize preserves the area`);
      const ids = (s, oid, t) => [[oid, '<oid>'], [s.o.customer_phone, '<phone>'], [t, '<tok>'], ...(s.o.active_attempt_id ? [[s.o.active_attempt_id, '<att>']] : [])];
      assert.deepStrictEqual(Object.keys(sb.o).filter((k) => !(k in sa.o)), ['address_area'], `🔴 ${rid} card: the ONLY new order key is address_area`);
      sameBut(sb, ids(sb, b, `TTB${rid}`), sa, ids(sa, a, `TTA${rid}`), `🔴 ${rid} card: order / tasks / tracking / factura differ beyond the order's address_area`);
    }
    // scheduled (cash): held → the REAL release
    {
      const slot = (() => { const now = Date.now(); for (let k = 2; k < 400; k += 1) { const t = Math.ceil((now + k * 15 * 60000) / (15 * 60000)) * 15 * 60000; if (SCHED.validateScheduledFor(HOURS, t, now, 'delivery').valid) return t; } throw new Error('no valid slot'); })();
      const [a, b] = [`aa_ps_${rid}_A`, `aa_ps_${rid}_B`];
      const ra = await send(rid, a, 'cash', { scheduled_for: slot }); const rb = await send(rid, b, 'cash', { scheduled_for: slot, address_area: 'Colonia Trejo' });
      assert.ok(ra.status === 200 && rb.status === 200, `setup scheduled pair: ${ra.text.slice(0, 120)} / ${rb.text.slice(0, 120)}`);
      assert.strictEqual((await getOrder(b)).val().status, 'scheduled', 'premise: held');
      assert.strictEqual((await getOrder(b)).val().address_area, 'Colonia Trejo', `${rid} scheduled: the held order carries the area`);
      for (const oid of [a, b]) {
        const rel = await REL.releaseOne({ db: rtdb, alert: async () => {}, genToken: () => `RT${oid}` }, { orderId: oid, now: slot, claimId: `rel-${oid}` });
        assert.ok(rel.released, `premise — released (${JSON.stringify(rel)})`);
      }
      const [sa, sb] = [await snapshotOf(a), await snapshotOf(b)];
      assert.strictEqual(sb.o.address_area, 'Colonia Trejo', `${rid} scheduled: the release preserves the area`);
      const ids = (s, oid) => [[oid, '<oid>'], [s.o.customer_phone, '<phone>'], [`RT${oid}`, '<tok>']];
      assert.deepStrictEqual(Object.keys(sb.o).filter((k) => !(k in sa.o)), ['address_area'], `🔴 ${rid} scheduled: the ONLY new order key is address_area`);
      sameBut(sb, ids(sb, b), sa, ids(sa, a), `🔴 ${rid} scheduled: order / tasks / tracking / factura differ beyond the order's address_area`);
    }
  }
  // ── content dedup (codex r1 P2-3): a DIFFERENT order id, the SAME customer + content, the stamp KEPT — a live card order, then
  // a cash re-order (create-side retap + the duplicate-sibling alert), then the card's confirm (the confirm-side guard) — has
  // the SAME outcome whether the area is absent, present on both, or present on one only
  const dedupScenario = async (rid, tag, areaFirst, areaSecond) => {
    for (const p of ['rate_limits', 'recent_order_content', 'dispatcher_alerts']) await rtdb.ref(p).remove();
    const ph = `9977${String(SEQ += 1).padStart(4, '0')}`;
    const [p1, p2] = [`aa_dd_${rid}_${tag}_1`, `aa_dd_${rid}_${tag}_2`];
    const r1 = await post(app.chargeOnlineOrder, { ...bodyFor(rid, p1, 'online', areaFirst ? { address_area: areaFirst } : {}), customer_phone: ph });
    const r2 = await post(app.createOrder, { ...bodyFor(rid, p2, 'cash', areaSecond ? { address_area: areaSecond } : {}), customer_phone: ph });   // the stamp is NOT cleared
    const stamps = (await rtdb.ref(`recent_order_content/${rateLimitKey(ph)}`).get()).val();
    const alerts = (await rtdb.ref('dispatcher_alerts').get()).val();
    const p1o = (await getOrder(p1)).val() || {};
    const conf = await confirmAndMaterialize(edgeDeps(rid), { orderId: p1, attemptId: p1o.active_attempt_id, now: Date.now(), trackingToken: `TTD${tag}${rid}` });
    const p1after = (await getOrder(p1)).val() || {};
    // the stamp is keyed by the content key, which hashes the PHONE — normalised through its RECOMPUTED area-free value (an
    // area folded into the key would not match and the scenario would differ)
    const ck = orderContentKey({ phone: ph, itemsText: `1x ${LINE[rid].name}`, orderType: 'delivery', scheduledFor: null });
    const ids = [[p1, '<p1>'], [p2, '<p2>'], [ph, '<phone>'], [rateLimitKey(ph), '<phk>'], [ck, '<ck>'], [`TTD${tag}${rid}`, '<tok>'], ...(p1o.active_attempt_id ? [[p1o.active_attempt_id, '<att>']] : [])];
    return norm({ r1: [r1.status, r1.json], r2: [r2.status, r2.json], stamps, alerts, conf, p1: [p1after.status, p1after.payment_status] }, ids);
  };
  for (const rid of ['x_pizza', 'la_musa']) {
    const base = await dedupScenario(rid, 'X', null, null);
    assert.ok(base.stamps && base.stamps['<ck>'] && base.stamps['<ck>'].order_id === '<p2>', `premise: the re-order kept the SAME content stamp, now naming the cash order (${JSON.stringify(base.stamps)})`);
    assert.ok(base.alerts && Object.keys(base.alerts).length === 1, `premise: the create-side duplicate-sibling alert fired (${JSON.stringify(base.alerts)})`);
    assert.deepStrictEqual(await dedupScenario(rid, 'Y', 'Colonia Trejo', 'Res. Los Castaños'), base, `🔴 ${rid}: the duplicate outcome changes when BOTH orders carry (different) areas`);
    assert.deepStrictEqual(await dedupScenario(rid, 'Z', null, 'Colonia Trejo'), base, `🔴 ${rid}: the duplicate outcome changes when only the re-order carries an area`);
  }
  ok('content dedup (both brands): a different order id with the same customer + content and the stamp KEPT — the create-side stamp, the duplicate-sibling alert and the card confirm\'s duplicate guard — give the SAME outcome with the area absent, on both, or on one only');

  assert.ok(FACTURA_COMPARED >= 6, `non-vacuity: factura records were built and compared (${FACTURA_COMPARED})`);
  ok('paired non-interference (both brands): cash, card (issuance + confirm/materialize) and scheduled release differing ONLY in address_area → equal responses, totals / breakdown / payment + charge-input fingerprints / PixelPay amount, tasks, tracking, WhatsApp and factura; the only order diff is address_area; a cash retry with a changed area is the same idempotent answer and never rewrites it');

  FINISHED = true;
  console.log(`\naddress-area(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
