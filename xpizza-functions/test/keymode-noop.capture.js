'use strict';
// S0 key mode as data (PLAN-portal-item-edit r6) — THE NO-OP CAPTURE through the REAL writers. Not run by CI: it is run
// twice in the heavy slot — once against the BASE handlers (KM_FN = the b13a0c82 worktree's xpizza-functions) and once
// against this tip — and test/keymode-noop.compare.js diffs the two. Emulator only (refuses without both services).
//   KM_FN=<functions dir> KM_STATES=pre[,pre_again,snap,rollback,drift] CAPTURE_OUT=<file> node test/keymode-noop.capture.js
// Bodies come from the REAL clients: the new renderer's serializer (customer-app capp-cart → capp-serialize) and the OLD
// live page's own builder (booted by the S0 form harness). Endpoints: cash createOrder, card chargeOnlineOrder, quoteOrder,
// quoteRedemption — both brands, both extras models (x_pizza name / count-once, la_musa id / qty-aware), paid AND free
// factura lines (a redeemed x_pizza order), an 86'd item and an unknown line. States (fresh database each):
//   pre        the catalog published WITHOUT a key mode (every live version today) — the only state the BASE can produce
//   pre_again  the same, captured a second time: the leaves that differ between the two are the volatile ones
//   snap       published by this tip from the seeded source, so the version, snapshot and mirror carry key_mode
//   rollback   snap, a second publish, then a rollback to the first: the rollback re-emits the first version's mode
//   drift      snap, then the profile's pricing_key_mode flipped to the other value: the version route must not read it
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const express = require('express');
const FN = path.resolve(process.env.KM_FN || path.join(__dirname, '..'));
const ROOT = path.join(__dirname, '..', '..');
const STATES = String(process.env.KM_STATES || 'pre').split(',').filter(Boolean);
const OUT = process.env.CAPTURE_OUT;
assert.ok(OUT, 'CAPTURE_OUT is required');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'km-noop-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 'km-noop-quote-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.OTP_SALT = process.env.OTP_SALT || 'k'.repeat(40);
const req = (rel) => require(path.join(FN, rel));
const stub = (rel, exportsOf) => { const p = require.resolve(path.join(FN, rel)); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(Number(q.amountLempiras)); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
{ const p = require.resolve('firebase-admin/auth', { paths: [FN] }); const real = require(p); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: { ...real, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } }; }

const app = req('index.js');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
const rtdb = admin.database();
const fs = admin.firestore();
const { adaptMenu } = require(path.join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(path.join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(path.join(ROOT, 'customer-app/capp-serialize.js'));
const { publishVersion, rollbackVersion } = req('catalog/catalog-publish');
const { buildPublishCandidate } = req('tools/publish-version');
const { makeRtdbMirror } = req('catalog/mirror-rtdb');
const { buildPublicMenu } = req('catalog/public-menu');
const { getActivePointer } = req('catalog/catalog-firestore');
const { availKey } = req('avail-key');

function post(handler, body, hdr = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...hdr }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe: not the local RTDB emulator');
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const HUB = { lat: 14.1, lng: -87.2 };
const PIN = { lat: HUB.lat + 1 / 111.195, lng: HUB.lng };
const UID = 'u_km';
const REWARD = { x_pizza: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, la_musa: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 2, name: 'Arroz Blanco' }] } };
const BALANCE = { x_pizza: 8, la_musa: 400 };
const PROFILE_MODE = { x_pizza: 'name', la_musa: 'id' };
let PH = 0; let OID = 0;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const MENU = {}; const ENV = {};
async function serve(rid) {
  const m = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
  ENV[rid] = { rid: m.rid, representation_version: m.representation_version, menu: m.body };
  MENU[rid] = adaptMenu(ENV[rid]);
}
const orderableDish = (m) => m.dishes.find((d) => !d.launcher && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))));
const configurable = (m) => m.dishes.find((d) => !d.launcher && m.extrasFor(d.key).length >= 2 && !(m.weekendOnlyCats.has(String(d.cat)) || m.pickupOnlyCats.has(String(d.cat))));
function carts(rid) {
  const m = MENU[rid]; const out = [];
  const p = orderableDish(m); const plain = createCart(m); plain.inc(p.key); out.push(['plain', plain]);
  const d = configurable(m);
  // ONE extra per line: the serializer orders a line's extras by key, and the keys are identity ids minted at random per publish, so a
  // multi-extra line's text (and the payment fingerprint over it) would differ between two publishes of the same menu — not a no-op signal
  if (d) { const [e1, e2] = m.extrasFor(d.key); const t = createCart(m); t.add(d.key, [e1.key], 2); t.add(d.key, [e2.key], 1); out.push(['extras', t]); }
  const g = Object.values(m.groups)[0];
  if (g) { const c = createCart(m); c.add(g.choices[0], [], 1); c.add(g.choices[1], [], 2); out.push(['launcher choices', c]); }
  return out;
}
function bodyOf(rid, method, items, itemsText, extra = {}) {
  return { restaurant_id: rid, order_id: `km_${rid}_${method}_${OID += 1}`, customer_name: 'KM S0', customer_phone: `9966${String(PH += 1).padStart(4, '0')}`,
    customer_email: 'km@example.com', order_type: 'delivery', payment_method: method, lat: PIN.lat, lng: PIN.lng, pin_confirmed: true,
    address_detected: 'Calle Principal', address_details: 'portón', items, items_text: itemsText, ...extra };
}
let HARNESS = null;
async function oldBody(rid, build) {
  if (!HARNESS) HARNESS = { cap: await import(path.join(ROOT, 'xpizza-functions/contract/capp/capture.mjs')), fh: await import(path.join(ROOT, 'form-harness.mjs')) };
  const { w } = await HARNESS.cap.boot(rid === 'x_pizza' ? 'xpizza-orders' : 'la-musa-orders', ENV[rid]);
  try {
    await build(w, HARNESS.fh.settle);
    assert.strictEqual(w.buildOrder(), true, 'premise: the live page built the order');
    const b = w.eval('currentOrder');
    return JSON.parse(JSON.stringify({ items: b.items, items_text: b.items_text }));
  } finally { HARNESS.fh.closeAll(); }
}
async function stored(orderId) {
  const order = (await rtdb.ref(`orders/${orderId}`).get()).val();
  const attempt = order && order.active_attempt_id ? (await rtdb.ref(`payment_attempts/${order.active_attempt_id}`).get()).val() : null;
  return { order, attempt };
}

async function seed(state) {
  await wipe(); PH = 0; OID = 0; CHARGED.length = 0;
  const versions = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: PROFILE_MODE[rid], active: true, schema_version: 2 });
    const seedC = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'km-noop-seed' });
    const input = { ...seedC.input };
    if (state === 'pre' || state === 'pre_again') delete input.key_mode;   // every live version today: no recorded mode
    const v1 = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    versions[rid] = [v1.versionId];
    if (state === 'rollback') {
      const v2 = await publishVersion(fs, rid, { ...input, source_sha: 'km-noop-v2' }, { expected: { activeVersionId: v1.versionId }, mirror: makeRtdbMirror(rtdb) });
      versions[rid].push(v2.versionId);
      await rollbackVersion(fs, rid, v1.versionId, { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: v2.versionId } });
      assert.strictEqual((await getActivePointer(fs, rid)).version, v1.versionId, 'premise: rolled back to v1');
    }
    if (state === 'drift') await fs.collection('restaurants').doc(rid).set({ pricing_key_mode: PROFILE_MODE[rid] === 'id' ? 'name' : 'id' }, { merge: true });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 8, version: 1, hours: HOURS });
    await serve(rid);
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
  return versions;
}

async function captureState(state) {
  const versions = await seed(state);
  const out = { meta: {}, cells: {} };
  for (const rid of ['x_pizza', 'la_musa']) {
    const vdoc = (await fs.collection('restaurants').doc(rid).collection('versions').doc(versions[rid][0]).get()).data() || {};
    const snap = (await fs.collection('restaurants').doc(rid).collection('meta').doc('active_snapshot').get()).data() || {};
    const mir = (await rtdb.ref(`catalog_snapshot/${rid}`).get()).val() || {};
    out.meta[rid] = { record_key_mode: vdoc.key_mode === undefined ? null : vdoc.key_mode, snapshot_key_mode: snap.key_mode === undefined ? null : snap.key_mode,
      mirror_key_mode: mir.key_mode === undefined ? null : mir.key_mode, avail_identity: ENV[rid].menu.avail_identity || null, versions: versions[rid] };
    const m = MENU[rid];
    for (const [label, cart] of carts(rid)) {
      const s = serialize(cart, m);
      await clean();
      const q = await post(app.quoteOrder, { restaurant_id: rid, items: s.items, mode: 'delivery', pin: { ...PIN, confirmed: true } });
      out.cells[`${rid} | ${label} | quoteOrder`] = q;
      await clean();
      const cb = bodyOf(rid, 'cash', s.items, s.items_text);
      out.cells[`${rid} | ${label} | cash`] = { res: await post(app.createOrder, cb), ...(await stored(cb.order_id)) };
      await clean();
      const kb = bodyOf(rid, 'online', s.items, s.items_text, q.json && q.json.quote_token ? { quote_token: q.json.quote_token, expected_net_cents: q.json.net_total_cents } : {});
      out.cells[`${rid} | ${label} | card`] = { res: await post(app.chargeOnlineOrder, kb), ...(await stored(kb.order_id)), charged: CHARGED[CHARGED.length - 1] };
    }
    // rewards: quoteRedemption, then a redeemed cash order (x_pizza: paid + FREE factura lines) and a redeemed card order
    {
      const d = configurable(m) || orderableDish(m); const ex = m.extrasFor(d.key);
      const cart = createCart(m); cart.add(d.key, ex.length ? [ex[0].key] : [], 2);
      const s = serialize(cart, m); const auth = { 'x-firebase-id-token': UID };
      for (const method of ['cash', 'online']) {
        await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: BALANCE[rid], reserved: 0 });
        await clean();
        const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: s.items, redeem: REWARD[rid], mode: 'delivery', pin: { ...PIN, confirmed: true } }, auth);
        out.cells[`${rid} | reward | quoteRedemption | ${method}`] = qr;
        const b = bodyOf(rid, method, s.items, s.items_text, { redeem: REWARD[rid], customer_uid: UID,
          ...(qr.json && qr.json.quote_token ? { quote_token: qr.json.quote_token, expected_net_cents: qr.json.net_total_cents } : {}) });
        const res = await post(method === 'cash' ? app.createOrder : app.chargeOnlineOrder, b, auth);
        out.cells[`${rid} | reward | ${method}`] = { res, ...(await stored(b.order_id)), wallet: (await rtdb.ref(`user_rewards/${UID}/${rid}`).get()).val() };
      }
    }
    // the OLD live page's body for a configured cart, through cash createOrder
    {
      const d = configurable(m) || orderableDish(m); const ex = m.extrasFor(d.key);
      const ob = await oldBody(rid, async (w, settle) => {
        w.chg(d.id, 2); await settle();
        if (ex.length) {
          w.openDetailModal(d.id); await settle();
          if (rid === 'x_pizza') w.toggleDetailExtra(String(ex[0].id), d.id, 0); else w.chgDetailExtra(String(ex[0].id), d.id, 2);
          await settle(); w.closeDetailModal(); await settle();
        }
      });
      await clean();
      const b = bodyOf(rid, 'cash', ob.items, ob.items_text);
      out.cells[`${rid} | old form | cash`] = { res: await post(app.createOrder, b), ...(await stored(b.order_id)) };
    }
    // an 86'd item (its availability key is the PRICED key), and a line no table knows
    {
      const p = orderableDish(m); const cart = createCart(m); cart.inc(p.key); const s = serialize(cart, m);
      const priced = rid === 'la_musa' ? s.items[0].id : s.items[0].name;   // today's rule, written out: what the 86 gate must read
      await rtdb.ref(`restaurants/${rid}/item_availability/${availKey(priced)}`).set({ available: false });
      await clean();
      const b86 = bodyOf(rid, 'cash', s.items, s.items_text);
      out.cells[`${rid} | 86 | cash`] = { res: await post(app.createOrder, b86), ...(await stored(b86.order_id)) };
      await rtdb.ref(`restaurants/${rid}/item_availability`).remove();
      await clean();
      const bad = bodyOf(rid, 'cash', [{ ...s.items[0], id: 'km_ghost', name: 'KM Ghost' }], 'KM Ghost');
      out.cells[`${rid} | unknown line | cash`] = { res: await post(app.createOrder, bad), ...(await stored(bad.order_id)) };
    }
  }
  return out;
}

(async () => {
  const result = { fn: FN, states: {} };
  for (const st of STATES) { result.states[st] = await captureState(st); console.log(`  captured ${st}: ${Object.keys(result.states[st].cells).length} cells`); }
  fsys.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`keymode-noop capture: OK (${STATES.join(', ')}) → ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('keymode-noop capture FAILED:', e); process.exit(1); });
