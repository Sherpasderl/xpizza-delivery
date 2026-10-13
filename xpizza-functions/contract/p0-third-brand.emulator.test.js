'use strict';
require('./_no-secrets');   // R3 P1-a (codex r2 P1-1c): no real credential in a test process
// R3 P0 — THE THIRD SYNTHETIC BRAND through the real publish path, then the real createOrder (PLAN-R3 rev 4.1 §5c).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-third-brand
require('../test/_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'r3-p0-secret';
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;

require('../test/_catalog-clock').install();
require('./version-witness').install();
const admin = require('firebase-admin');
const app = require('../index.js');
const D = require('./discovery');
const { createScheduler } = require('./scheduler');
const S = createScheduler({ admin, triggers: D.dbTriggers(D.runtimeInventory(app)), run: new Set() }).install();
const T = require('./third-brand');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const fs = admin.firestore(); const rtdb = admin.database();

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
const H = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2' };
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identity = { name: 'R3 Synthetic', phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } };

(async () => {
  await S.fixture(async () => {
    await rtdb.ref().set(null);
    await rtdb.ref(`restaurants/${T.THIRD}/identity`).set(identity);
    await rtdb.ref('restaurants/r3_unpublished/identity').set(identity);
  });
  const pub = await S.fixture(() => T.publishThirdBrand(fs, { mirror: makeRtdbMirror(rtdb) }));
  assert.ok(pub.versionId, FAIL('T1', 'the third brand published through publishVersion'));
  assert.ok(Object.keys(pub.renamed).length >= 10 && pub.source.items.every((i) => /^R3 /.test(i.key)), FAIL('T1', 'every dish key renamed (no x_pizza literal can match by accident)'));
  ok(`T1 ${T.THIRD} published through the real path (source store → shared builder → publishVersion): ${pub.versionId}, ${pub.source.items.length} dishes, every key renamed`);

  const it = pub.source.items[0];
  for (const shape of ['name', 'id']) {
    const oid = `r3o_${shape}`;
    const item = shape === 'name' ? { name: it.display.name, qty: 2, price: it.price, extras: [] } : { id: it.key, name: it.display.name, qty: 2, price: it.price, extras: [] };
    const w = await S.writer(`createOrder ${oid}`, () => post(app.createOrder, { restaurant_id: T.THIRD, order_id: oid, customer_name: 'R3', customer_phone: shape === 'id' ? '99770011' : '99770010', customer_email: 'r@example.com',
      items_text: `2x ${it.display.name}`, order_type: 'pickup', payment_method: 'cash', items: [item] }, H), { served: [] });
    assert.strictEqual(w.r.status, 200, FAIL('T2', `createOrder ${oid} (${shape}-keyed) HTTP 200 (${w.r.status} ${w.r.text.slice(0, 200)})`));
    const o = (await rtdb.ref(`orders/${oid}`).get()).val();
    assert.ok(o && o.restaurant_id === T.THIRD, FAIL('T2', `order ${oid} persisted under ${T.THIRD}`));
    assert.strictEqual(o.total_cents, it.price * 2 * 100, FAIL('T2', `${oid} priced from the THIRD brand's catalog: ${o.total_cents} (want ${it.price * 2 * 100})`));
    const sl = o.summary_lines || [];
    assert.ok(sl.length === 1 && sl[0].name === it.display.name && sl[0].qty === 2, FAIL('T2', `summary_lines carry the third brand's dish: ${JSON.stringify(sl)}`));
    const s = w.store.served.filter((x) => x.rid === T.THIRD);
    assert.ok(s.length >= 1 && s.every((x) => x.versionId === pub.versionId && x.source === 'live'), FAIL('T2', `served {V1, live} for ${T.THIRD}: ${JSON.stringify(w.store.served)}`));
  }
  ok(`T2 the real createOrder accepts ${T.THIRD} orders (name- and id-keyed): HTTP 200, priced from its own catalog (2 × L${it.price}), summary_lines = "${it.display.name}", served {V1, live}`);

  // sensitivity: a rid with an identity but NO published catalog is refused — acceptance comes from the publish
  const bad = await post(app.createOrder, { restaurant_id: 'r3_unpublished', order_id: 'r3o_bad', customer_name: 'R3', customer_phone: '99770012', customer_email: 'r@example.com',
    items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: 'cash', items: [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] }, H);
  assert.ok(bad.status >= 400, FAIL('T3', `an UNPUBLISHED rid was accepted (${bad.status} ${bad.text.slice(0, 160)})`));
  assert.ok(!(await rtdb.ref('orders/r3o_bad').get()).exists(), FAIL('T3', 'the refused order was not written'));
  ok(`T3 sensitivity: r3_unpublished (identity, no catalog) is refused (${bad.status} ${(bad.json && (bad.json.error || bad.json.reason)) || ''}) and nothing is written`);

  S.assertClean();
  console.log(`\nr3-p0-third-brand: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-third-brand FAILED:', e && e.stack || e); process.exit(1); });
