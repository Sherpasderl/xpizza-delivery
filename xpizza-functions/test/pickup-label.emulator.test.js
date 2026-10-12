'use strict';
// R3-FIX D12 — the pickup line through the REAL createOrder handler (index.js) on the emulator, both shipped brands, read
// back from order_tracking (what the tracker shows). A third, synthetic restaurant cannot be ordered through HTTP without a
// full onboarding fixture; it is covered through the same real builders (pickup-label.test.js) and the real materialize
// paths (resolve-manual / scheduled-release emulator suites).
//   x_pizza, identity WITHOUT display_name (today's prod)   → "Recoger en X Pizza"  (why the OWNER seeds it BEFORE deploy)
//   x_pizza, identity WITH display_name "X. Pizza" (seeded)  → "Recoger en X. Pizza" (today's text, now from config)
//   la_musa, identity name "La Musa", no display_name        → "Recoger en La Musa"  (the bug: it read "X. Pizza")
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'pl-secret';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const realPublish = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { IDENTITIES } = require('../seed_identity');
const { _cache: identityCache } = require('../restaurant-config');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pickup-label(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
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
let PH = 0;
const ITEM = { x_pizza: { name: 'Carnivora', qty: 1, price: 340, extras: [] }, la_musa: { id: 'dimsum_01', name: 'dimsum_01', qty: 1, price: 223, extras: [] } };
async function pickup(rid, oid) {
  await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
  const it = ITEM[rid];
  const r = await post(app.createOrder, { restaurant_id: rid, order_id: oid, customer_name: 'Pick', customer_phone: `9977${String(PH += 1).padStart(4, '0')}`,
    customer_email: 'p@example.com', items_text: `1x ${it.name}`, order_type: 'pickup', pickup_time: 'standard', payment_method: 'cash', items: [it] });
  assert.strictEqual(r.status, 200, `${rid} ${oid}: createOrder — ${r.text.slice(0, 200)}`);
  const order = (await rtdb.ref(`orders/${oid}`).get()).val();
  const tracking = (await rtdb.ref(`order_tracking/${order.tracking_token}`).get()).val();
  return { order, tracking, line: tracking.address_short };
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const setIdentity = async (rid, extra = {}) => {
  await rtdb.ref(`restaurants/${rid}/identity`).set({ ...IDENTITIES[rid], whatsapp_instance: 'test-instance', active: true, whatsapp_enabled: false, hours: HOURS, ...extra });
  identityCache.clear();   // the reader caches identity for its TTL; each cell states the identity it is about
};

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'pl-seed' });
    await realPublish.publishVersion(fs, rid, input, { expected: { activeVersionId: null } });
  }

  await setIdentity('x_pizza');
  const before = await pickup('x_pizza', 'pl_x_before');
  assert.strictEqual(before.line, 'Recoger en X Pizza', 'x_pizza before the seed: its config name (the OWNER step comes first)');
  assert.ok(!('restaurant_display_name' in before.order), 'no display name configured → no snapshot key');
  assert.strictEqual(before.tracking.restaurant_display_name, 'X Pizza', 'D12b: the public record carries the brand the pickup line names (the config name, pre-seed)');

  await setIdentity('x_pizza', { display_name: 'X. Pizza' });
  const after = await pickup('x_pizza', 'pl_x_after');
  assert.strictEqual(after.line, 'Recoger en X. Pizza', '🔴 x_pizza after the seed: exactly today\'s text, now from config');
  assert.strictEqual(after.order.restaurant_display_name, 'X. Pizza', 'the order carries the snapshot');
  assert.strictEqual(after.tracking.restaurant_display_name, 'X. Pizza', 'D12b: the PUBLIC tracking record carries "X. Pizza" for the tracker banner');
  ok('x_pizza through the REAL createOrder: "Recoger en X Pizza" before the owner\'s display-name seed, "Recoger en X. Pizza" (today\'s text) after it');

  await setIdentity('la_musa');
  const lm = await pickup('la_musa', 'pl_lm');
  assert.strictEqual(lm.line, 'Recoger en La Musa', '🔴 La Musa names La Musa (it read "Recoger en X. Pizza")');
  assert.strictEqual(lm.tracking.restaurant_display_name, 'La Musa', 'D12b: the PUBLIC tracking record names La Musa');
  assert.ok(!/X\.? ?Pizza/.test(JSON.stringify(lm.order)) && !('restaurant_display_name' in lm.order), 'no trace of the other brand; no display name → no snapshot key');
  ok('la_musa through the REAL createOrder: "Recoger en La Musa" (the D12 bug), no X. Pizza anywhere on the order');

  FINISHED = true;
  console.log(`\npickup-label(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('pickup-label(emulator) FAILED:', e); process.exit(1); });
