'use strict';
// S1b (advisor ruling Q3) — an UNKNOWN or non-string reward item keeps today's refusal, byte for byte: this captures what
// createOrder and the charge answer for such a reward (and, advisor ruling option A, what all four endpoints answer for a
// malformed legacy key), from the functions dir S1B_FN (the base checkout or this one), into
// CAPTURE_OUT. Run once per checkout inside the emulator, then compare the two captures (identical status AND body).
// Run: S1B_FN=<functions dir> CAPTURE_OUT=<file> node tools/emulator-run.js --only firestore,database --project demo-xpizza "node test/s1b-reward-parity.capture.js"
const FN = require('path').resolve(process.env.S1B_FN || require('path').join(__dirname, '..'));
const OUT = process.env.CAPTURE_OUT;
if (!OUT) { console.error('s1b-reward-parity: CAPTURE_OUT is required'); process.exit(2); }
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's1b-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's1b-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub(require('path').join(FN, 'whatsapp'), (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub(require('path').join(FN, 'pixelpay-hosted'), (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require(require('path').join(FN, 'index.js'));
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require(require('path').join(FN, 'tools/publish-version'));
const { buildSourceFromCode } = require(require('path').join(FN, 'tools/seed-source-store'));
const { sourceRefOf, canonicalize } = require(require('path').join(FN, 'catalog/source-store'));
const { publishVersion } = require(require('path').join(FN, 'catalog/catalog-publish'));
const { backfillIdentities } = require(require('path').join(FN, 'catalog/identity-backfill'));
const { catalogSnapshot } = require(require('path').join(FN, 'catalog/generate-form-bundle'));
const { getActivePointer } = require(require('path').join(FN, 'catalog/catalog-firestore'));
const { makeRtdbMirror } = require(require('path').join(FN, 'catalog/mirror-rtdb'));
const { verifyQuoteToken } = require(require('path').join(FN, 'quote-token'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s1b-reward-parity(capture): FAILED — exited without completing'); process.exitCode = 1; } });

const MENU_CHANGED = { error: 'menu_changed', detail: 'El menú se actualizó, recargá la página', retryable: false };
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `s1b-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
}
const dish = (rid) => catalogSnapshot(rid).items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
const lineOf = (rid, over = {}) => { const it = dish(rid); return { ...(rid === 'x_pizza' ? { name: it.display.name } : { id: it.key, name: it.display.name, cat: it.display.cat }), qty: 1, price: it.price, extras: [], ...over }; };
const bodyFor = (rid, oid, phone, items, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'S1b Test', customer_phone: phone, customer_email: 's1b@example.com',
  items_text: '1x test', order_type: 'pickup', payment_method: 'cash', items, ...extra });
let seq = 0;
const fresh = async () => { await rtdb.ref('rate_limits').remove(); seq += 1; return { oid: `s1b_${seq}_${Date.now() % 100000}`, phone: `9945${String(1000 + seq).slice(-4)}` }; };
const written = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).exists();

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) await seed(rid);
  await rtdb.ref('config/redemption_enabled').set(true);
  const uid = 'u_s1b';
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
  const cases = {
    x_pizza_unknown: ['x_pizza', { type: 'free_pizza_choice', item_id: 'Pizza Que No Existe', name: 'Pizza Que No Existe' }],
    x_pizza_array: ['x_pizza', { type: 'free_pizza_choice', item_id: ['Margherita'], name: 'Margherita' }],
    la_musa_unknown: ['la_musa', { type: 'points_ala_carte', items: [{ id: 'nope_99', qty: 1, name: 'Nope' }] }],
    la_musa_array: ['la_musa', { type: 'points_ala_carte', items: [{ id: ['rice_white'], qty: 1, name: 'Arroz' }] }],
  };
  const out = {};
  for (const [k, [rid, redeem]] of Object.entries(cases)) {
    for (const [ep, handler, pm] of [['createOrder', app.createOrder, 'cash'], ['chargeOnlineOrder', app.chargeOnlineOrder, 'online']]) {
      const f = await fresh();
      const r = await post(handler, bodyFor(rid, `rwp_${k}_${ep}`, f.phone, [lineOf(rid)], { payment_method: pm, redeem }), { 'x-firebase-id-token': uid });
      out[`${k}/${ep}`] = { status: r.status, body: r.text, written: await written(`rwp_${k}_${ep}`) };
    }
  }
  // advisor ruling (option A): a malformed LEGACY key (array / null on the mode's own field) keeps today's refusal, byte for
  // byte, at all four endpoints
  const REDEEM_OK = { x_pizza: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, la_musa: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz Blanco' }] } };
  // codex S1b r3 P2-1: the malformed-key verdict depends on platform_config/extras_eligibility (absent = off: the extras check
  // is skipped and pricing coerces an array key). Both settings are captured; base and tip must agree byte for byte in each.
  // A 2xx body's per-run values (tokens, URLs, timestamps) are masked; a written order adds its money projection.
  const VOLATILE = /token|url|_at$|expires|attempt/i;
  const mask = (v) => (Array.isArray(v) ? v.map(mask) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, VOLATILE.test(k) ? '<volatile>' : mask(x)])) : v);
  const bodyOf = (r) => (r.status >= 200 && r.status < 300 && r.json ? JSON.stringify(mask(r.json)) : r.text);
  const MONEY = ['total', 'total_cents', 'subtotal', 'tax', 'items_text', 'items', 'payment_method', 'status'];
  const projection = async (id) => { const o = (await rtdb.ref(`orders/${id}`).get()).val(); return o ? Object.fromEntries(MONEY.map((f) => [f, o[f] === undefined ? null : o[f]])) : null; };
  for (const setting of ['off', 'enforce']) {
    await rtdb.ref('platform_config/extras_eligibility').set(setting);
    await new Promise((r) => setTimeout(r, 31000));   // the per-instance mode cache (30 s): the setting is live only after it expires
    for (const [rid, field] of [['x_pizza', 'name'], ['la_musa', 'id']]) for (const [kind, v] of [['array', [rid === 'x_pizza' ? 'Carnivora' : 'dimsum_01']], ['null', null]]) {
      const k = `mf_${setting}_${rid}_${field}_${kind}`; const line = () => lineOf(rid, { [field]: v });
      for (const [ep, handler, pm] of [['createOrder', app.createOrder, 'cash'], ['chargeOnlineOrder', app.chargeOnlineOrder, 'online']]) {
        const f = await fresh(); const before = CHARGED.length; const id = `rwp_${k}_${ep}`;
        const r = await post(handler, bodyFor(rid, id, f.phone, [line()], { payment_method: pm }), { 'x-firebase-id-token': uid });
        out[`${k}/${ep}`] = { status: r.status, body: bodyOf(r), written: await written(id), charged: CHARGED.length - before, order: await projection(id) };
      }
      const q = await post(app.quoteOrder, { restaurant_id: rid, items: [line()], order_type: 'pickup' });
      out[`${k}/quoteOrder`] = { status: q.status, body: bodyOf(q), written: false };
      const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: [line()], order_type: 'pickup', redeem: REDEEM_OK[rid] }, { 'x-firebase-id-token': uid });
      out[`${k}/quoteRedemption`] = { status: qr.status, body: bodyOf(qr), written: false };
    }
  }
  await rtdb.ref('platform_config/extras_eligibility').remove();
  require('fs').writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  FINISHED = true;
  console.log(`s1b-reward-parity(capture): ${Object.keys(out).length} responses from ${FN} → ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('s1b-reward-parity(capture) FAILED:', e); process.exit(1); });
