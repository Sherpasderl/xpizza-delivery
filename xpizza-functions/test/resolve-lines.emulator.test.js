'use strict';
// S1b (PLAN-portal-item-edit r6 §2.4; D4c-grill/item-s1/S1b-DESIGN.md + the advisor's rulings) — the resolution stage through
// the four REAL cart endpoints on the emulator (x_pizza name-keyed, la_musa id-keyed, both published through the real path).
//   U  an unknown item: createOrder / the charge → 409 menu_changed «El menú se actualizó, recargá la página» (not retryable),
//      nothing written, nothing charged; quoteOrder → 200 { ok:false, error:'menu_changed' } (fail-soft); quoteRedemption →
//      409 { ok:false, error:'menu_changed', detail }
//   I  a malformed legacy key is NOT the stage's (advisor ruling, option A), under both extras_eligibility settings: under
//      enforce an array name / id is today's 400 item_malformed with its customer copy at createOrder, the charge, quoteOrder
//      and quoteRedemption (nothing written or charged); under off the stage never answers (the base-vs-tip bytes for both
//      settings, null included: test/s1b-reward-parity.capture.js)
//   K  item_key: an agreeing item_key prices exactly as its legacy twin (same stored total); an item_key-only line refuses
//      menu_changed (S1b: never priced)
//   F  one key across endpoints: quoteOrder signs the SAME cart fingerprint for an item_key cart and its legacy twin, and the
//      order carrying the legacy quote's token is accepted for the item_key cart
//   W  the REAL writer (codex S1b r1): the served menu → the capp's own menu adapter, cart and serializer → quoteOrder ok and
//      createOrder 200 on both key modes (the stage never refuses a line a live client builds)
// The reward refusal's byte-identity (base vs tip) is test/s1b-reward-parity.capture.js. Run: npm run test:resolve-lines
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
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { verifyQuoteToken } = require('../quote-token');
const ROOT = require('path').join(__dirname, '..', '..');
const { buildPublicMenu } = require('../catalog/public-menu');
const { adaptMenu } = require(require('path').join(ROOT, 'customer-app/capp-menu.js'));
const { createCart } = require(require('path').join(ROOT, 'customer-app/capp-cart.js'));
const { serialize } = require(require('path').join(ROOT, 'customer-app/capp-serialize.js'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('resolve-lines(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

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
  { const f = await fresh(); const w = await post(app.createOrder, bodyFor('x_pizza', f.oid, f.phone, [lineOf('x_pizza')]), { 'x-firebase-id-token': uid });
    assert.strictEqual(w.status, 200, `premise: a plain cash order places (${w.text.slice(0, 200)})`); }

  // ── U: an unknown item ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const unknown = lineOf(rid, rid === 'x_pizza' ? { name: 'Pizza Que No Existe' } : { id: 'nope_99' });
    const f = await fresh();
    const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, [lineOf(rid), unknown]), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([co.status, co.json], [409, MENU_CHANGED], `U-CREATE ${rid} an unknown item is 409 menu_changed (${co.text.slice(0, 160)})`);
    assert.strictEqual(await written(f.oid), false, `U-CREATE ${rid} nothing written`);
    const g = await fresh(); const before = CHARGED.length;
    const ch = await post(app.chargeOnlineOrder, bodyFor(rid, g.oid, g.phone, [unknown], { payment_method: 'online' }), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([ch.status, ch.json], [409, MENU_CHANGED], `U-CHARGE ${rid} an unknown item is 409 menu_changed (${ch.text.slice(0, 160)})`);
    assert.strictEqual(CHARGED.length, before, `U-CHARGE ${rid} nothing charged`);
    assert.strictEqual(await written(g.oid), false, `U-CHARGE ${rid} nothing written`);
    const q = await post(app.quoteOrder, { restaurant_id: rid, items: [unknown], order_type: 'pickup' });
    assert.deepStrictEqual([q.status, q.json], [200, { ok: false, error: 'menu_changed' }], `U-QUOTE ${rid} fail-soft menu_changed (${q.text.slice(0, 160)})`);
    const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: [unknown], order_type: 'pickup', redeem: rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] } }, { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([qr.status, qr.json], [409, { ok: false, ...MENU_CHANGED }], `U-QUOTE-REDEEM ${rid} an unknown cart line is 409 { ok:false, menu_changed } (${qr.text.slice(0, 160)})`);
  }
  ok('an unknown item: 409 menu_changed on createOrder and the charge (nothing written or charged); quoteOrder fail-soft; quoteRedemption 409 { ok:false }');

  // ── I: a malformed legacy key keeps today's refusal (codex S1b r3 P2-1: under BOTH extras_eligibility settings) ──
  {
    const COPY = 'Tu pedido tiene un producto o un extra que no reconocemos. Volvé a armarlo, por favor.';
    const isMalformed = (r) => r.status === 400 && r.json && r.json.error === 'item_malformed' && r.json.detail === COPY;
    const notStage = (r) => !(r.json && ['menu_changed', 'invalid_line'].includes(r.json.error));
    const REDEEM = { x_pizza: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, la_musa: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz Blanco' }] } };
    for (const setting of ['enforce', 'off']) {
      await rtdb.ref('platform_config/extras_eligibility').set(setting);
      await new Promise((r) => setTimeout(r, 31000));   // the per-instance mode cache (30 s): the setting is live only after it expires
      // enforce: today's 400 item_malformed + copy, nothing written or charged. off: the extras check is skipped at the base too,
      // so the stage must simply not answer (its codes never appear); the byte-identity with the base is the capture's
      // (test/s1b-reward-parity.capture.js, both settings)
      const judge = setting === 'enforce' ? isMalformed : notStage;
      for (const [rid, over] of [['x_pizza', { name: ['Carnivora'] }], ['la_musa', { id: ['dimsum_01'] }]]) {
        const tag = `${setting} ${rid} ${Object.keys(over)[0]}=array`;
        const f = await fresh();
        const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, [lineOf(rid, over)]), { 'x-firebase-id-token': uid });
        assert.ok(judge(co), `I-CREATE ${tag} (${co.status} ${co.text.slice(0, 200)})`);
        if (setting === 'enforce') assert.strictEqual(await written(f.oid), false, `I-CREATE ${tag} nothing written`);
        const g = await fresh(); const before = CHARGED.length;
        const ch = await post(app.chargeOnlineOrder, bodyFor(rid, g.oid, g.phone, [lineOf(rid, over)], { payment_method: 'online' }), { 'x-firebase-id-token': uid });
        assert.ok(judge(ch), `I-CHARGE ${tag} (${ch.status} ${ch.text.slice(0, 200)})`);
        if (setting === 'enforce') { assert.strictEqual(CHARGED.length, before, `I-CHARGE ${tag} nothing charged`); assert.strictEqual(await written(g.oid), false, `I-CHARGE ${tag} nothing written`); }
        const q = await post(app.quoteOrder, { restaurant_id: rid, items: [lineOf(rid, over)], order_type: 'pickup' });
        assert.ok(judge(q), `I-QUOTE ${tag} (${q.status} ${q.text.slice(0, 200)})`);
        const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: [lineOf(rid, over)], order_type: 'pickup', redeem: REDEEM[rid] }, { 'x-firebase-id-token': uid });
        assert.ok(judge(qr), `I-QUOTE-REDEEM ${tag} (${qr.status} ${qr.text.slice(0, 200)})`);
      }
    }
    await rtdb.ref('platform_config/extras_eligibility').remove();
  }
  ok('a malformed legacy key: under enforce today\'s 400 item_malformed + copy at all four endpoints (nothing written or charged); under off the stage never answers');

  // ── K: item_key ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const key = dish(rid).key;
    const a = await fresh(); const b = await fresh();
    const legacy = await post(app.createOrder, bodyFor(rid, a.oid, a.phone, [lineOf(rid)]), { 'x-firebase-id-token': uid });
    const keyed = await post(app.createOrder, bodyFor(rid, b.oid, b.phone, [lineOf(rid, { item_key: key })]), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([legacy.status, keyed.status], [200, 200], `K-AGREE ${rid} both place (${keyed.text.slice(0, 160)})`);
    const [oa, ob] = [(await rtdb.ref(`orders/${a.oid}`).get()).val(), (await rtdb.ref(`orders/${b.oid}`).get()).val()];
    for (const f of ['total', 'total_cents', 'subtotal', 'tax', 'items_text']) assert.deepStrictEqual(ob[f], oa[f], `K-AGREE ${rid} the item_key twin stores the same ${f}`);
    const c = await fresh();
    const only = await post(app.createOrder, bodyFor(rid, c.oid, c.phone, [{ item_key: key, qty: 1, price: dish(rid).price, extras: [] }]), { 'x-firebase-id-token': uid });
    assert.deepStrictEqual([only.status, only.json], [409, MENU_CHANGED], `K-ONLY ${rid} an item_key-only line is 409 menu_changed in S1b (${only.text.slice(0, 160)})`);
    assert.strictEqual(await written(c.oid), false);
  }
  ok('an agreeing item_key prices exactly as its legacy twin; an item_key-only line refuses menu_changed (never priced in S1b)');

  // ── F: one key across endpoints ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const key = dish(rid).key;
    const ql = await post(app.quoteOrder, { restaurant_id: rid, items: [lineOf(rid)], order_type: 'pickup' });
    const qk = await post(app.quoteOrder, { restaurant_id: rid, items: [lineOf(rid, { item_key: key })], order_type: 'pickup' });
    assert.ok(ql.json && ql.json.ok && ql.json.quote_token && qk.json && qk.json.ok && qk.json.quote_token, `premise: ${rid} both quotes signed (${qk.text.slice(0, 160)})`);
    const [pl, pk] = [verifyQuoteToken(ql.json.quote_token, process.env.QUOTE_TOKEN_SECRET, Date.now()), verifyQuoteToken(qk.json.quote_token, process.env.QUOTE_TOKEN_SECRET, Date.now())];
    assert.ok(pl.ok && pk.ok, 'premise: both tokens verify');
    assert.strictEqual(pk.payload.cart_fingerprint, pl.payload.cart_fingerprint, `F-FP ${rid} the item_key cart and its legacy twin are ONE fingerprint`);
    assert.strictEqual(qk.json.net_total_cents, ql.json.net_total_cents, `F-FP ${rid} one net total`);
    const f = await fresh();
    const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, [lineOf(rid, { item_key: key })], { quote_token: ql.json.quote_token }), { 'x-firebase-id-token': uid });
    assert.strictEqual(co.status, 200, `F-ORDER ${rid} the order with the item_key cart accepts the legacy cart's quote (${co.text.slice(0, 200)})`);
  }
  ok('quoteOrder and the order fingerprint one key: an item_key cart and its legacy twin sign the same fingerprint; the order accepts either\'s quote');

  // ── W: the real capp writer ──
  for (const rid of ['x_pizza', 'la_musa']) {
    await fs.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 }, { merge: true });
    const pm = await buildPublicMenu(fs, rid, { known: new Set([rid]), isActive: async () => true });
    const m = adaptMenu({ rid: pm.rid, representation_version: pm.representation_version, menu: pm.body });
    const d = m.dishes.find((x) => !x.launcher && !(m.weekendOnlyCats.has(String(x.cat)) || m.pickupOnlyCats.has(String(x.cat))));
    assert.ok(d, `premise: ${rid} the served menu has an orderable dish`);
    const cart = createCart(m); cart.inc(d.key);
    const s = serialize(cart, m);
    assert.ok(Array.isArray(s.items) && s.items.length === 1, `premise: ${rid} the capp serialized one line`);
    const q = await post(app.quoteOrder, { restaurant_id: rid, items: s.items, order_type: 'pickup' });
    assert.ok(q.status === 200 && q.json && q.json.ok === true, `W-QUOTE ${rid} the capp's own line quotes (${q.text.slice(0, 200)})`);
    const f = await fresh();
    const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, s.items, { items_text: s.items_text }), { 'x-firebase-id-token': uid });
    assert.strictEqual(co.status, 200, `W-CREATE ${rid} the capp's own line places (${co.text.slice(0, 200)})`);
    assert.strictEqual(await written(f.oid), true, `W-CREATE ${rid} written`);
  }
  ok('the real capp writer (served menu → adapter → cart → serializer): quoteOrder ok and createOrder 200 on both key modes');

  // ── G (S1d D3 + codex S1d r1 #3): a reward that consumes an OPAQUE key this route has no label for is refused 503
  //    labels_unavailable right after the stage — before ANY write (rate limit, dedupe, reserve, order) — at createOrder and
  //    the charge. The version below holds a minted dish whose stored display is stripped, so its route carries no label. ──
  {
    const { buildSourceCandidate } = require('../catalog/candidate-validate');
    const OPQ = 'i_aaaaaaaaaaab';
    const src = canonicalize(buildSourceFromCode('x_pizza'));
    src.items.push({ key: OPQ, price: 150, display: { id: 9901, name: 'Pizza Nueva', cat: src.items[0].display.cat, price: 150, desc: '' } });
    src.structure.item_order.push(OPQ); src.frozen_keys = { 9901: OPQ };
    const { inputs, built } = buildSourceCandidate('x_pizza', src);
    const active = (await getActivePointer(fs, 'x_pizza')).version;
    const v = await publishVersion(fs, 'x_pizza', { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's1d-gate', key_mode: built.key_mode, frozen_keys: built.frozen_keys }, { expected: { activeVersionId: active }, mirror: makeRtdbMirror(rtdb) });
    const docs = await fs.collection('restaurants').doc('x_pizza').collection('versions').doc(v.versionId).collection('menu_items').where('key', '==', OPQ).get();
    assert.strictEqual(docs.size, 1, 'premise: the minted dish is in the version');
    await docs.docs[0].ref.update({ display: admin.firestore.FieldValue.delete() });   // the price docs (key, price) and their hash are untouched
    // codex S1d r2 #2: the handler caches the active pointer for 45 s — wait it out, then PROVE the new version is the one served
    // (the minted dish exists only there: a key-only line for it quotes ok) before asserting anything about it
    await new Promise((r) => setTimeout(r, 46000));
    const probe = await post(app.quoteOrder, { restaurant_id: 'x_pizza', items: [{ item_key: OPQ, qty: 1, price: 150, extras: [] }], order_type: 'pickup' });
    assert.ok(probe.status === 200 && probe.json && probe.json.ok === true, `G-PREMISE the new version is the one served (${probe.text.slice(0, 160)})`);
    const redeem = { type: 'free_pizza_choice', item_id: OPQ, name: 'Pizza Nueva' };
    for (const [route, pay] of [['createOrder', 'cash'], ['chargeOnlineOrder', 'online']]) {
      const f = await fresh(); const before = JSON.stringify((await rtdb.ref().get()).val()); const charged = CHARGED.length;
      const r = await post(app[route], bodyFor('x_pizza', f.oid, f.phone, [lineOf('x_pizza')], { payment_method: pay, redeem }), { 'x-firebase-id-token': uid });
      assert.deepStrictEqual([r.status, r.json && r.json.error, r.json && r.json.retryable], [503, 'labels_unavailable', true], `G-${route} an unlabelled opaque reward key: 503 labels_unavailable (${r.text.slice(0, 160)})`);
      assert.strictEqual(JSON.stringify((await rtdb.ref().get()).val()), before, `G-${route} ZERO writes (rate limit, dedupe, reserve, order)`);
      assert.strictEqual(CHARGED.length, charged, `G-${route} nothing charged`);
    }
    ok('an unlabelled opaque reward key: 503 labels_unavailable at createOrder and the charge, with zero writes');
  }

  FINISHED = true;
  console.log(`\nresolve-lines(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('resolve-lines(emulator) FAILED:', e); process.exit(1); });
