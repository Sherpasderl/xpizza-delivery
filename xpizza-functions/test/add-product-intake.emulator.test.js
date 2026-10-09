'use strict';
// 1D add-product PHASE A §0b.1 — the absent-key refusal at intake, through the REAL createOrder / chargeOnlineOrder
// handlers on the emulator (part of `npm run test:add-product`).
//   A product added in the portal is a key the gate snapshot must KNOW before an order may carry it. While the gate
//   cannot classify it (its catalog read fails → fallback = code-known dishes; or a stale snapshot), the request is
//   refused with a typed, RETRYABLE 503 menu_updating — cash after the existing-order dedupe and before any write;
//   card only on FRESH issuance (genuine reuse is honoured; a reuse→fresh drift is refused by the guard inside
//   acquireHostedAttempt). Keys the gate knows behave exactly as today, including in fallback mode.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'ap-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
// the same stubs as the c4 suite: no WhatsApp, PixelPay's HTTP stubbed, a fake customer token
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
let DRIFT = null;
stub('../pixelpay-hosted-charge', (r) => ({ ...r, classifyHostedAttempt: async (...a) => { const c = await r.classifyHostedAttempt(...a); if (DRIFT) await DRIFT(a[1]); return c; } }));
// THE GATE OUTAGE: only the gate's catalog read (previewVersion) fails; pricing keeps working
let FAIL_GATE = false;
stub('../catalog/catalog-publish', (r) => ({ ...r, previewVersion: async (...a) => { if (FAIL_GATE) throw new Error('injected gate read failure'); return r.previewVersion(...a); } }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const realPublish = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize, sourceToBuildInputs } = require('../catalog/source-store');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { getActivePointer } = require('../catalog/catalog-firestore');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-intake: FAILED — exited without completing'); process.exitCode = 1; } });

const RID = 'x_pizza';
const NEW = 'Portal Slice';
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };

async function publishSource(src) {
  const inputs = sourceToBuildInputs(src);
  const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable });
  const active = await getActivePointer(fs, RID);
  await realPublish.publishVersion(fs, RID, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'ap-intake' },
    { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: active.version } });
}
function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, 'x-firebase-id-token': 'u_ap' }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t, retryAfter: r.headers.get('retry-after') }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
let PH = 0;
const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
// the next day-of-week (0 = Sunday) at 12:00 Honduras time (UTC−6): ≥ 2 h ahead and inside the 7-day horizon
function nextDay(dow) {
  const now = Date.now();
  const hnNow = new Date(now - 6 * 3600000);
  for (let d = 0; d <= 7; d += 1) {
    const t = Date.UTC(hnNow.getUTCFullYear(), hnNow.getUTCMonth(), hnNow.getUTCDate() + d, 18, 0, 0);   // 12:00 HN = 18:00 UTC
    if (new Date(t - 6 * 3600000).getUTCDay() === dow && t > now + 2 * 3600000 && t < now + 160 * 3600000) return t;
  }
  throw new Error(`no ${dow} within the horizon`);
}
const SAT = nextDay(6); const MON = nextDay(1);
const body = (oid, method, name, price, scheduledFor, ph) => ({ restaurant_id: RID, order_id: oid, customer_name: 'Add Product', customer_phone: ph,
  customer_email: 'ap@example.com', items_text: `1x ${name}`, order_type: 'pickup', payment_method: method, items: [{ name, qty: 1, price, extras: [] }],
  ...(scheduledFor ? { scheduled_for: scheduledFor } : {}) });
const send = async (oid, method, name, price, when, ph) => {
  await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
  return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, body(oid, method, name, price, when, ph));
};
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();

(async () => {
  // a published catalog that already carries a portal-added NY product (allocated id above the live max)
  const src = canonicalize(buildSourceFromCode(RID));
  await sourceRefOf(fs, RID).set(src);
  const { input } = buildPublishCandidate(RID, { activeVersionId: null }, { source_sha: 'ap-seed' });
  await realPublish.publishVersion(fs, RID, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  const added = JSON.parse(JSON.stringify(src));
  const maxId = Math.max(...added.items.map((i) => i.display.id));
  added.items.push({ key: NEW, price: 624, display: { id: maxId + 1, cat: 'ny', name: NEW, price: 624, desc: '6 slices' } });
  added.structure.item_order.push(NEW);
  await publishSource(added);
  await rtdb.ref(`restaurants/${RID}/identity`).set({ name: 'X', phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  const MNY = added.items.find((i) => i.key === 'Margherita NY');

  // ── healthy gate (this process's first read is of the version that carries the product) ──
  {
    const a = await send('ap_c_sat', 'cash', NEW, 624, SAT, phone());
    assert.strictEqual(a.status, 200, `the added product on a weekend: ${a.text.slice(0, 200)}`);
    const m = await send('ap_c_mon', 'cash', NEW, 624, MON, phone());
    assert.strictEqual(m.status, 400); assert.strictEqual(m.json.error, 'weekend_only', 'it INHERITS its category\'s weekend rule');
    const e1 = await send('ap_c_ex_sat', 'cash', MNY.key, MNY.price, SAT, phone());
    const e2 = await send('ap_c_ex_mon', 'cash', MNY.key, MNY.price, MON, phone());
    assert.deepStrictEqual([e1.status, e2.status, e2.json.error], [200, 400, 'weekend_only'], 'an existing NY product: exactly today');
    ok('healthy gate: the added NY product is accepted on a weekend, refused weekend_only on a Monday (inherited); an existing NY product is unchanged');
  }
  // a live card checkout for the added product, made while the gate is healthy (for the reuse cells)
  const cph = phone();
  const card = await send('ap_card_reuse', 'online', NEW, 624, SAT, cph);
  assert.strictEqual(card.status, 200, `setup card: ${card.text.slice(0, 200)}`);
  const drifted = phone();
  const card2 = await send('ap_card_drift', 'online', NEW, 624, SAT, drifted);
  assert.strictEqual(card2.status, 200);

  // ── the gate's read FAILS → fallback (known = code dishes) ──
  // The gate caches each version's snapshot for good and its pointer for 45 s, so a failure can only bite on a NEW
  // read: publish a new version (a price change, the product still in it), let the pointer TTL lapse, then fail it.
  const v3 = JSON.parse(JSON.stringify(added)); const p3 = v3.items.find((i) => i.key === 'Pepperoni'); p3.price += 1; p3.display.price = p3.price;
  await publishSource(v3);
  await new Promise((r) => setTimeout(r, 46000));
  FAIL_GATE = true;
  {
    const c = await send('ap_c_out', 'cash', NEW, 624, SAT, phone());
    assert.strictEqual(c.status, 503, `cash: ${c.text.slice(0, 200)}`);
    assert.deepStrictEqual(c.json, { error: 'menu_updating', detail: 'El menú se está actualizando — probá de nuevo en un momento', retryable: true });
    assert.strictEqual(c.retryAfter, '2');
    assert.strictEqual(await order('ap_c_out'), null, 'nothing written');
    const ok1 = await send('ap_c_out_ex', 'cash', MNY.key, MNY.price, SAT, phone());
    const no1 = await send('ap_c_out_ex_mon', 'cash', MNY.key, MNY.price, MON, phone());
    assert.deepStrictEqual([ok1.status, no1.status, no1.json.error], [200, 400, 'weekend_only'], 'an existing item in fallback: exactly today (static weekend set)');
    ok('gate outage, cash: the added product → 503 menu_updating (retryable, Retry-After 2), nothing written; an existing product behaves exactly as today');
  }
  {
    const f = await send('ap_card_out', 'online', NEW, 624, SAT, phone());
    assert.strictEqual(f.status, 503); assert.strictEqual(f.json.error, 'menu_updating');
    assert.strictEqual(await order('ap_card_out'), null, 'a FRESH checkout: no order, no attempt');
    const r = await send('ap_card_reuse', 'online', NEW, 624, SAT, cph);
    assert.strictEqual(r.status, 200, `genuine reuse during the outage is honoured: ${r.text.slice(0, 200)}`);
    assert.strictEqual(r.json.checkout_url, card.json.checkout_url, 'the SAME checkout');
    // reuse → ROTATE drift (the checkout expires between classify and acquire): the armed guard refuses the fresh URL
    const before = (await order('ap_card_drift')).active_attempt_id;
    DRIFT = async () => { DRIFT = null; await rtdb.ref(`payment_attempts/${before}/hosted_expires_at`).set(1); };
    const d = await send('ap_card_drift', 'online', NEW, 624, SAT, drifted);
    DRIFT = null;
    assert.strictEqual(d.status, 503, `drift: ${d.text.slice(0, 200)}`); assert.strictEqual(d.json.error, 'menu_updating');
    assert.strictEqual((await order('ap_card_drift')).active_attempt_id, before, 'no fresh attempt was issued');
    ok('gate outage, card: a FRESH checkout → 503 with nothing created; genuine REUSE is honoured (same checkout); a reuse→rotate drift is refused by the guard, no new attempt');
  }
  FAIL_GATE = false;

  FINISHED = true;
  console.log(`\nadd-product-intake: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-intake FAILED:', e && (e.stack || e)); process.exit(1); });
