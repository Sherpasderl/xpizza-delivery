'use strict';
// 1D add-product PHASE B (rev 6, UNIFORM) — the group rules at intake through the REAL createOrder / chargeOnlineOrder /
// quoteOrder / quoteRedemption handlers on the emulator (part of `npm run test:add-product`), BOTH brands:
//   render OFF  → nothing changes (a bare launcher is priced as today);
//   render ON   → a bare launcher LINE or REWARD → 409 choice_required (cash before any write; card on FRESH issuance; a
//                 verified reuse is honoured and a reuse → fresh rotation is refused by the acquire guard); a choice whose
//                 launcher is 86'd → item_unavailable; quotes answer choice_required.
// The platform switches are stubbed (require.cache) before index.js loads; production reads the committed values.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'apg-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const CAPS = { render: false, authoring: false };
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../catalog/platform-groups', (r) => ({ ...r, groupCapabilities: () => ({ ...CAPS }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
let DRIFT = null;
stub('../pixelpay-hosted-charge', (r) => ({ ...r, classifyHostedAttempt: async (...a) => { const c = await r.classifyHostedAttempt(...a); if (DRIFT) await DRIFT(a[1]); return c; } }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const realPublish = require('../catalog/catalog-publish');
const A = require('../catalog/add-product');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { availKey } = require('../avail-key');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('add-product-groups-intake: FAILED — exited without completing'); process.exitCode = 1; } });

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
const phone = () => `9988${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const line = (rid, key, price) => (rid === 'la_musa' ? { id: key, name: key, qty: 1, price, extras: [] } : { name: key, qty: 1, price, extras: [] });
const body = (rid, oid, method, items, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Groups', customer_phone: phone(), customer_email: 'g@example.com',
  items_text: items.map((i) => `1x ${i.name}`).join(', '), order_type: 'pickup', payment_method: method, items, ...extra });
const send = async (rid, oid, method, items, extra = {}) => { await clean(); return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, body(rid, oid, method, items, extra), { 'x-firebase-id-token': `u_${rid}` }); };
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();

async function publishSource(rid, src) {
  const { inputs, built } = buildSourceCandidate(rid, src);
  const active = await getActivePointer(fs, rid);
  await realPublish.publishVersion(fs, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'apg' },
    { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: active.version } });
}
// x_pizza gains the SAME group shape la_musa already has (allocated by the real pure core, authoring on)
function xpWithGroup(src) {
  const s = JSON.parse(JSON.stringify(src));
  s.items.push({ ref: 'tmp:llllllll-0001', price: 1, display: { cat: 'ny', name: 'NY Plain Slice', price: 1 } }); s.structure.item_order.push('tmp:llllllll-0001');
  const V = ['tmp:vvvvvvvv-0001', 'tmp:vvvvvvvv-0002'];
  ['Salsa Roja', 'Combinada'].forEach((ch, i) => { s.items.push({ ref: V[i], price: 624, display: { choice: ch, variantOf: 'tmp:llllllll-0001', price: 624 } }); s.structure.item_order.push(V[i]); });
  s.structure.variant_items = { 'tmp:llllllll-0001': { label: 'Salsa', variantIds: V } };
  return A.allocateAdditions({ incoming: s, stored: src, activeItems: src.items, keyMode: 'name', hwm: null, registryHasKey: () => false, authoring: true }).source;
}

// The chain shares ONE emulator (test:add-product), so this suite starts from an empty one — a predecessor's published
// catalog would otherwise make the seed publish below a stale-CAS overwrite. Guarded: it refuses a non-emulator target.
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = canonicalize(buildSourceFromCode(rid));
    await sourceRefOf(fs, rid).set(src);
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'apg-seed' });
    await realPublish.publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  }
  await publishSource('x_pizza', xpWithGroup(canonicalize(buildSourceFromCode('x_pizza'))));
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });
  const G = { x_pizza: { launcher: 'NY Plain Slice', variant: 'NY Plain Slice - Salsa Roja', price: 624 }, la_musa: { launcher: 'noodle_01', variant: 'noodle_01_pollo', price: 342 } };

  // ── render OFF: dormant — a bare launcher is accepted and priced exactly as today ──
  {
    Object.assign(CAPS, { render: false });
    for (const rid of ['x_pizza', 'la_musa']) {
      const r = await send(rid, `apg_off_${rid}`, 'cash', [line(rid, G[rid].launcher, rid === 'la_musa' ? 414 : 624)]);
      assert.strictEqual(r.status, 200, `${rid} render OFF: today's behaviour for a bare launcher — ${r.text.slice(0, 200)}`);
    }
    ok('render OFF: nothing changes — a bare launcher is accepted and priced as today, on both brands');
  }
  // a live card checkout carrying a BARE launcher, made while render is OFF (for the reuse / rotation cells)
  const liveOid = 'apg_card_live_x';
  assert.strictEqual((await send('x_pizza', liveOid, 'online', [line('x_pizza', G.x_pizza.launcher, 624)])).status, 200, 'setup: a live checkout with a bare launcher');

  // ── render ON ──
  Object.assign(CAPS, { render: true });
  for (const rid of ['x_pizza', 'la_musa']) {
    const bare = await send(rid, `apg_cash_bare_${rid}`, 'cash', [line(rid, G[rid].launcher, rid === 'la_musa' ? 414 : 624)]);
    assert.deepStrictEqual([bare.status, bare.json && bare.json.error], [409, 'choice_required'], `${rid}: a bare launcher (cash) — ${bare.text.slice(0, 200)}`);
    assert.strictEqual(await order(`apg_cash_bare_${rid}`), null, `${rid}: NOTHING written`);
    const v = await send(rid, `apg_cash_var_${rid}`, 'cash', [line(rid, G[rid].variant, G[rid].price)]);
    assert.strictEqual(v.status, 200, `${rid}: a choice orders normally — ${v.text.slice(0, 200)}`);
    const cardBare = await send(rid, `apg_card_bare_${rid}`, 'online', [line(rid, G[rid].launcher, rid === 'la_musa' ? 414 : 624)]);
    assert.deepStrictEqual([cardBare.status, cardBare.json && cardBare.json.error], [409, 'choice_required'], `${rid}: a FRESH card checkout with a bare launcher — ${cardBare.text.slice(0, 200)}`);
    const q = await post(app.quoteOrder, { restaurant_id: rid, items: [line(rid, G[rid].launcher, 1)] });
    assert.deepStrictEqual([q.status, q.json.ok, q.json.error], [200, false, 'choice_required'], `${rid}: quoteOrder fails soft with choice_required`);
  }
  ok('render ON, BOTH brands: a bare launcher is refused at cash (nothing written) and at a fresh card checkout (409 choice_required); a choice orders normally; quoteOrder answers choice_required');

  // ── a verified REUSE keeps its bound snapshot; a reuse → fresh ROTATION is refused by the acquire guard ──
  {
    const reuse = await send('x_pizza', liveOid, 'online', [line('x_pizza', G.x_pizza.launcher, 624)]);
    assert.strictEqual(reuse.status, 200, `a verified reuse of the pre-existing checkout is honoured — ${reuse.text.slice(0, 200)}`);
    DRIFT = async (oid) => { if (oid === liveOid) { const o = await order(oid); if (o && o.active_attempt_id) await rtdb.ref(`payment_attempts/${o.active_attempt_id}/hosted_expires_at`).set(1); } };
    const rot = await send('x_pizza', liveOid, 'online', [line('x_pizza', G.x_pizza.launcher, 624)]);
    DRIFT = null;
    assert.deepStrictEqual([rot.status, rot.json && rot.json.error], [409, 'choice_required'], `a reuse that drifts to a fresh issuance is refused by the guard — ${rot.text.slice(0, 200)}`);
  }
  ok('card: a verified reuse keeps its bound snapshot; a reuse → fresh rotation is refused inside acquireHostedAttempt (choice_required)');

  // ── parent-or-variant: the launcher 86'd blocks its choices ──
  for (const rid of ['x_pizza', 'la_musa']) {
    await rtdb.ref(`restaurants/${rid}/item_availability/${availKey(G[rid].launcher)}`).set({ available: false });
    const r = await send(rid, `apg_p86_${rid}`, 'cash', [line(rid, G[rid].variant, G[rid].price)]);
    assert.deepStrictEqual([r.status, r.json && r.json.error], [400, 'item_unavailable'], `${rid}: a choice whose launcher is 86'd — ${r.text.slice(0, 200)}`);
    await rtdb.ref(`restaurants/${rid}/item_availability/${availKey(G[rid].launcher)}`).remove();
  }
  ok('parent-or-variant: 86-ing the whole dish (the launcher row) blocks its choices at intake, on both brands');

  // ── a bare launcher as a REWARD (la_musa's Pad Thai is category-eligible today) ──
  {
    const rd = { type: 'points_ala_carte', items: [{ id: 'noodle_01', qty: 1, name: 'Pad Thai' }] };
    const cash = await send('la_musa', 'apg_rw_cash', 'cash', [line('la_musa', 'dimsum_01', 225)], { redeem: rd });
    assert.deepStrictEqual([cash.status, cash.json && cash.json.error], [409, 'choice_required'], `cash with a bare launcher reward — ${cash.text.slice(0, 200)}`);
    assert.strictEqual(((await rtdb.ref('user_rewards/u_la_musa/la_musa').get()).val() || {}).reserved, 0, 'no reward hold was taken');
    const qr = await post(app.quoteRedemption, { restaurant_id: 'la_musa', items: [line('la_musa', 'dimsum_01', 225)], redeem: rd }, { 'x-firebase-id-token': 'u_la_musa' });
    assert.deepStrictEqual([qr.status, qr.json.error], [409, 'choice_required'], `quoteRedemption — ${qr.text.slice(0, 200)}`);
    const okRd = { type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] };
    const fine = await send('la_musa', 'apg_rw_ok', 'cash', [line('la_musa', 'dimsum_01', 225)], { redeem: okRd });
    assert.strictEqual(fine.status, 200, `a CHOICE as the reward is fine — ${fine.text.slice(0, 200)}`);
  }
  ok('rewards: a bare launcher reward is refused (cash, no hold taken; quoteRedemption 409); a choice as the reward redeems normally');

  FINISHED = true;
  console.log(`\nadd-product-groups-intake: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-groups-intake FAILED:', e && (e.stack || e)); process.exit(1); });
