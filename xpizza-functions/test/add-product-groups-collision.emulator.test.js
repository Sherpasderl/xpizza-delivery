'use strict';
// 1D add-product PHASE B (codex PB-1 r2 P1) — a DISH KEY THAT SHADOWS AN EXTRA, through the REAL createOrder /
// chargeOnlineOrder / quoteRedemption handlers on the emulator (part of `npm run test:add-product`).
//   la_musa carries a group "Rice White" whose launcher key is rice_white — the key of the extra "Arroz Blanco". (The
//   allocator now refuses to mint such a key — defence in depth — so the catalog is published directly, as a pre-existing
//   or externally authored state would be.) The reward calculator resolves rice_white DISH-first, so:
//   • the gate POINTER read FAILING (the code fallback snapshot: rice_white known only as an extra) → the reward is
//     UNCLASSIFIABLE → 503 menu_updating on cash AND a fresh card, quoteRedemption answers menu_updating — never accepted;
//   • a HEALTHY gate snapshot → the reward is the bare LAUNCHER → 409 choice_required (cash, fresh card, quote).
// A fresh process, so the handlers' pricing reader first reads la_musa AFTER this catalog is published.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'apc-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const CAPS = { render: true, authoring: false };
let FAIL_GATE_POINTER = false;
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../catalog/platform-groups', (r) => ({ ...r, groupCapabilities: () => ({ ...CAPS }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
// the REAL gate reader, whose active-pointer read can be made to FAIL on demand (the reproduced condition), never cached
stub('../catalog/menu-gates', (r) => ({ ...r, createGateReader: (opts = {}) => r.createGateReader({ ...opts, pointerTtlMs: 0,
  getVersionId: opts.getVersionId ? async (rid) => { if (FAIL_GATE_POINTER) throw new Error('gate pointer read failed'); return opts.getVersionId(rid); } : null }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const realPublish = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { getActivePointer } = require('../catalog/catalog-firestore');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-groups-collision: FAILED — exited without completing'); process.exitCode = 1; } });
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
let PH = 0;
const phone = () => `9955${String(PH += 1).padStart(4, '0')}`;
const PAID = [{ id: 'dimsum_01', name: 'dimsum_01', qty: 1, price: 225, extras: [] }];
const RD = { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Rice White' }] };
const send = async (oid, method) => {
  await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove();
  return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, { restaurant_id: 'la_musa', order_id: oid, customer_name: 'Collision', customer_phone: phone(),
    customer_email: 'c@example.com', items_text: '1x dimsum_01', order_type: 'pickup', payment_method: method, items: PAID, redeem: RD }, { 'x-firebase-id-token': 'u_la_musa' });
};
const quote = () => post(app.quoteRedemption, { restaurant_id: 'la_musa', items: PAID, redeem: RD }, { 'x-firebase-id-token': 'u_la_musa' });
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  const rid = 'la_musa';
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'apc-seed' });
  await realPublish.publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  await rtdb.ref('config/redemption_enabled').set(true);
  await rtdb.ref(`user_rewards/u_la_musa/${rid}`).set({ balance: 100000, reserved: 0 });
  // the shadowing group, published as-is (rice category is redeem-eligible today)
  const src = canonicalize(buildSourceFromCode(rid));
  const disp = (id, name, price, extra = {}) => ({ id, cat: 'rice', name, price, ...extra });
  src.items.push({ key: 'rice_white', price: 600, display: disp('rice_white', 'Rice White', 600) });
  src.items.push({ key: 'rice_white_a', price: 600, display: disp('rice_white_a', 'Rice White - A', 600, { variantOf: 'rice_white', choice: 'A' }) });
  src.items.push({ key: 'rice_white_b', price: 650, display: disp('rice_white_b', 'Rice White - B', 650, { variantOf: 'rice_white', choice: 'B' }) });
  src.structure.item_order.push('rice_white', 'rice_white_a', 'rice_white_b');
  src.structure.variant_items = { ...src.structure.variant_items, rice_white: { label: 'Opción', variantIds: ['rice_white_a', 'rice_white_b'] } };
  const { inputs, built } = buildSourceCandidate(rid, src);
  assert.ok(built.items.some((i) => i.key === 'rice_white') && built.extras.some((e) => e.key === 'rice_white'), 'premise: rice_white is BOTH a dish (the launcher) and an extra');
  const active = await getActivePointer(fs, rid);
  await realPublish.publishVersion(fs, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'apc' },
    { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: active.version } });

  // ── the gate POINTER read failing: the code fallback snapshot knows rice_white only as an extra ──
  {
    FAIL_GATE_POINTER = true;
    const cash = await send('apc_cash_fb', 'cash');
    assert.deepStrictEqual([cash.status, cash.json && cash.json.error], [503, 'menu_updating'], `🔴 cash: the shadowing launcher reward is UNCLASSIFIABLE, never accepted — ${cash.text.slice(0, 200)}`);
    assert.strictEqual(((await rtdb.ref(`orders/apc_cash_fb`).get()).val()), null, 'nothing written');
    const card = await send('apc_card_fb', 'online');
    assert.deepStrictEqual([card.status, card.json && card.json.error], [503, 'menu_updating'], `🔴 fresh card: unclassifiable — ${card.text.slice(0, 200)}`);
    assert.strictEqual((Number(((await rtdb.ref('user_rewards/u_la_musa/la_musa').get()).val() || {}).reserved) || 0), 0, 'no reward hold taken');
    const q = await quote();
    assert.strictEqual(q.json && q.json.error, 'menu_updating', `🔴 quoteRedemption: menu_updating — ${q.text.slice(0, 200)}`);
    FAIL_GATE_POINTER = false;
  }
  ok('gate pointer read FAILING + a dish key shadowing an extra: cash and a fresh card answer 503 menu_updating (nothing written, no hold) and quoteRedemption menu_updating — the extra\'s membership never admits the dish');

  // ── a HEALTHY gate snapshot: rice_white is the bare LAUNCHER ──
  {
    const cash = await send('apc_cash_ok', 'cash');
    assert.deepStrictEqual([cash.status, cash.json && cash.json.error], [409, 'choice_required'], `🔴 cash: the bare launcher reward — ${cash.text.slice(0, 200)}`);
    const card = await send('apc_card_ok', 'online');
    assert.deepStrictEqual([card.status, card.json && card.json.error], [409, 'choice_required'], `🔴 fresh card: choice_required — ${card.text.slice(0, 200)}`);
    const q = await quote();
    assert.deepStrictEqual([q.status, q.json && q.json.error], [409, 'choice_required'], `🔴 quoteRedemption: choice_required — ${q.text.slice(0, 200)}`);
  }
  ok('a healthy gate snapshot: the shadowing key is classified as the DISH — the bare launcher reward is refused (choice_required) on cash, a fresh card and the quote');

  FINISHED = true;
  console.log(`\nadd-product-groups-collision: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-groups-collision FAILED:', e && (e.stack || e)); process.exit(1); });
