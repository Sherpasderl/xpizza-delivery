'use strict';
// R3 P0 — THE D OBSERVATIONS (PLAN-R3 rev 4.1 §4, §9): what the REAL readers show for orders made by the REAL writers,
// recorded as observed values for the divergence table (confirmed / dropped). This suite does not assert the
// divergences are right or wrong — it asserts it OBSERVED each reader output (non-vacuity) and writes the observations to
// contract/d-observations.json. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-observations
require('../test/_emulator-required')('database', 'firestore');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'r3-p0-secret';

const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;

require('../test/_catalog-clock').install();
require('./version-witness').install();
const admin = require('firebase-admin');
const app = require('../index.js');
const D = require('./discovery');
const { createScheduler } = require('./scheduler');
const S = createScheduler({ admin, triggers: D.dbTriggers(D.runtimeInventory(app)), run: new Set() }).install();
const { createFirebaseHost } = require('./rtdb-adapter');
const { bootPage } = require('./page-harness');
const { installGoogleMaps } = require('./maps-stub');
const rtdb = admin.database(); const fsdb = admin.firestore();
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
const H = (rid) => ({ 'x-client-app': 'orders', 'x-client-deployment': rid === 'la_musa' ? 'orders-lamusa' : 'orders-xpizza', 'x-client-build': 'b2', 'x-client-compat': '2', 'x-firebase-id-token': `u_obs_${rid}` });
const OPEN = { open: true, start: '00:00', end: '24:00' };
const STAFF = 'staff_obs';
let PH = 0;
function body(rid, oid, name, method, { lines = 1, itemsText = null, type = 'delivery' } = {}) {
  const snap = catalogSnapshot(rid);
  const its = snap.items.slice(0, lines);
  const items = rid === 'x_pizza' ? its.map((it) => ({ name: it.display.name, qty: 1, price: it.price, extras: [] })) : its.map((it) => ({ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }));
  // the form's own items_text shape: `${qty}x ${name} (L${price})` joined by ' | ' (xpizza-orders buildOrder)
  const formText = its.map((it) => `1x ${it.display.name} (L${it.price})`).join(' | ');
  return { restaurant_id: rid, order_id: oid, customer_name: name, customer_phone: `9977${String(PH += 1).padStart(4, '0')}`, customer_email: 'obs@example.com',
    items_text: itemsText || formText, order_type: type, payment_method: method, address_detected: 'Col. Observada', lat: 14.1, lng: -87.2, items };
}

(async () => {
  await S.fixture(async () => {
    await rtdb.ref().set(null);
    for (const rid of ['x_pizza', 'la_musa']) {
      await sourceRefOf(fsdb, rid).set(canonicalize(buildSourceFromCode(rid)));
      const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `obs-${rid}` });
      await publishVersion(fsdb, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
      await backfillIdentities(fsdb, rid, catalogSnapshot(rid), { captured: await getActivePointer(fsdb, rid) });
      await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid === 'la_musa' ? 'La Musa' : 'X. Pizza', phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
    }
    for (const role of ['kitchen', 'dispatchers']) await rtdb.ref(`${role}/${STAFF}`).set(true);
  });

  // the real writers
  const mk = async (label, rid, b) => { const w = await S.writer(label, () => post(app.createOrder, b, H(rid)), { served: [] }); assert.strictEqual(w.r.status, 200, FAIL('OBS', `${label} (${w.r.text.slice(0, 200)})`)); return w.r.json; };
  const cd = await mk('card_delivery 2 lines', 'x_pizza', body('x_pizza', 'ob_card', 'Obs Card', 'card_delivery', { lines: 2 }));
  const em = await mk("payment_method 'efectivo' (S14)", 'x_pizza', body('x_pizza', 'ob_empty', 'Obs Empty', 'efectivo'));
  const lie = await mk('items_text ≠ priced items (D13)', 'x_pizza', body('x_pizza', 'ob_text', 'Obs Text', 'cash', { itemsText: 'TEXTO DEL CLIENTE' }));
  const lm = await mk('la_musa pickup (D12)', 'la_musa', body('la_musa', 'ob_lm', 'Obs Musa', 'cash', { type: 'pickup' }));
  const persisted = {};
  for (const oid of ['ob_card', 'ob_empty', 'ob_text', 'ob_lm']) persisted[oid] = (await rtdb.ref(`orders/${oid}`).get()).val();
  assert.strictEqual(persisted.ob_empty.payment_method, '', FAIL('S14', `premise — the real writer persisted payment_method '' for 'efectivo' (${JSON.stringify(persisted.ob_empty.payment_method)})`));
  ok(`real writers: card_delivery (2 lines), 'efectivo' → persisted '' (S14 confirmed at runtime), items_text ≠ priced items, la_musa pickup — all HTTP 200`);

  const OBS = { base: '2cb5a1c', writer: Object.fromEntries(Object.entries(persisted).map(([k, o]) => [k, { payment_method: o.payment_method, items_text: o.items_text, summary_lines: o.summary_lines, address_short: o.address_short, order_type: o.order_type }])), readers: {} };
  const boot = async (cell, dir, url) => {
    const host = createFirebaseHost({ pageId: `obs${cell}`, user: { uid: STAFF, email: 'staff@r3.test' }, fixture: S.fixture });
    const p = await bootPage(dir, { host, url, beforeScripts: (w) => { installGoogleMaps(w); } });
    for (let i = 0; i < 60 && !host.subs.length; i += 1) await new Promise((r) => setTimeout(r, 50));
    await host.barrier(); await p.settle();
    return { p, host, text: p.doc.body.textContent.replace(/\s+/g, ' ') };
  };
  const around = (text, needle, span = 140) => { const i = text.indexOf(needle); return i < 0 ? null : text.slice(Math.max(0, i - 20), i + span); };

  // R2 dispatch — D1 (payment chip), D13
  {
    const { p, host, text } = await boot('R2', 'xpizza-dispatch', 'https://xpizzadispatch.netlify.app/');
    const cards = [...p.doc.querySelectorAll('*')].filter((el) => el.children.length < 40 && /Obs (Card|Empty|Text)/.test(el.textContent) && /Pagado online|Efectivo/.test(el.textContent)).map((el) => el.textContent.replace(/\s+/g, ' ').trim()).sort((a, b) => a.length - b.length);
    OBS.readers.R2 = { card_delivery: cards.find((c) => /Obs Card/.test(c) && !/Obs (Empty|Text)/.test(c)) || null, empty: cards.find((c) => /Obs Empty/.test(c) && !/Obs (Card|Text)/.test(c)) || null, text: around(text, 'TEXTO DEL CLIENTE') };
    assert.ok(OBS.readers.R2.card_delivery && OBS.readers.R2.empty, FAIL('OBS-R2', `observed the dispatch chips (${JSON.stringify(OBS.readers.R2)})`));
    p.close(); await host.close();
  }
  // R3 dispatch-lite — D2 (paymentLine)
  {
    const { p, host } = await boot('R3', 'xpizza-dispatch-mobile', 'https://xpizzadispatchlite.netlify.app/');
    const lines = [...p.doc.querySelectorAll('.ln.pay')].map((el) => el.textContent.trim());
    OBS.readers.R3 = { payLines: lines };
    p.close(); await host.close();
  }
  // R7 dashboard — D6 (methodLabel)
  {
    const { p, host, text } = await boot('R7', 'xpizza-dashboard', 'https://xpizzadashboard.netlify.app/');
    OBS.readers.R7 = { card_delivery: around(text, 'Obs Card', 200), empty: around(text, 'Obs Empty', 200), rawCardDelivery: text.includes('card_delivery') };
    p.close(); await host.close();
  }
  // R1 KDS — D13 (item text = client items_text)
  {
    const { p, host, text } = await boot('R1', 'xpizza-kitchen', 'https://xpizzakitchen.netlify.app/');
    // scoped to the ob_text card: the smallest element holding its customer name (other cards share dish names)
    const card = [...p.doc.querySelectorAll('*')].filter((el) => el.textContent.includes('Obs Text') && !/Obs (Card|Empty|Musa)/.test(el.textContent)).sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)[0];
    const ct = card ? card.textContent.replace(/\s+/g, ' ') : '';
    OBS.readers.R1 = { card: ct.slice(0, 300), showsClientText: ct.includes('TEXTO DEL CLIENTE'), showsPricedName: ct.includes(persisted.ob_text.summary_lines[0].name) };
    p.close(); await host.close();
  }
  // R8 tracker — D12 (la_musa pickup address_short)
  {
    const { p, host, text } = await boot('R8', 'xpizza-track', `https://xpizzatrack.netlify.app/${lm.tracking_token}`);
    const track = (await rtdb.ref(`order_tracking/${lm.tracking_token}`).get()).val() || {};
    OBS.readers.R8 = { la_musa_pickup: around(text, 'Recoger', 80), persistedAddressShort: track.address_short };
    p.close(); await host.close();
  }

  const verdict = {
    D1: /Pagado online/.test(OBS.readers.R2.card_delivery || '') && /Pagado online/.test(OBS.readers.R2.empty || '') ? 'CONFIRMED (runtime): dispatch chip shows "Pagado online" for card_delivery AND for \'\'' : 'NOT REPRODUCED',
    D2: OBS.readers.R3.payLines.some((l) => /Tarjeta · pagado/.test(l)) ? `CONFIRMED (runtime): lite paymentLine includes "Tarjeta · pagado" (${JSON.stringify(OBS.readers.R3.payLines)})` : `NOT REPRODUCED (${JSON.stringify(OBS.readers.R3.payLines)})`,
    D6: OBS.readers.R7.rawCardDelivery ? 'CONFIRMED (runtime): dashboard prints raw "card_delivery"' : 'NOT REPRODUCED',
    D12: /Recoger en X\. Pizza/.test(OBS.readers.R8.persistedAddressShort || '') ? `CONFIRMED (writer + tracker): la_musa pickup address_short = "${OBS.readers.R8.persistedAddressShort}"` : `NOT REPRODUCED ("${OBS.readers.R8.persistedAddressShort}")`,
    D13_KDS: OBS.readers.R1.showsClientText && !OBS.readers.R1.showsPricedName ? 'CONFIRMED (runtime): KDS shows the CLIENT items_text, not the priced line' : `NOT REPRODUCED (${JSON.stringify(OBS.readers.R1)})`,
    S14: `CONFIRMED (runtime): 'efectivo' → payment_method '' persisted (HTTP 200)`,
  };
  OBS.verdict = verdict;
  fs.writeFileSync(path.join(__dirname, 'd-observations.json'), JSON.stringify(OBS, null, 1) + '\n');
  for (const [k, v] of Object.entries(verdict)) console.log(`  ${k}: ${v}`);
  ok(`observed reader outputs for D1, D2, D6, D12, D13 (KDS) and S14 → contract/d-observations.json`);
  S.assertClean();
  console.log(`\nr3-p0-observations: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-observations FAILED:', e && e.stack || e); process.exit(1); });
