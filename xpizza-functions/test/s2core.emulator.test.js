'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.4, §1.5, §2.2, §3.3; T7, T9, T10, T12) — the Extras page through the REAL cores on the emulator
// (Firestore + RTDB): exposure-transitions (the portal's writer) → editCatalogCore → publishEditedCore → publishVersion, each brand
// CERTIFIED (bootstrapIdentityStamps), the extrasCatalog switch stubbed ON; the four REAL cart endpoints of index.js.
//   T7  REMOVE-PARTITION-CLAIMED  a removed certified extra: unclaimed, the save refuses existing_extra_removed (nothing written) and a
//       direct activation refuses identity_partition_unaccounted (the pointer does not move); claimed, it publishes, the claim is consumed
//   T9  KEY-REMOVED-TYPED  a cart still carrying the removed extra: createOrder / the charge 409 menu_changed, quoteOrder 200 fail-soft,
//       quoteRedemption 409 { ok:false } — ZERO effects (no RTDB byte moves, nothing charged)
//   T10 STALE-WINDOW-RESIDUAL then POST-TTL-TYPED  a reader warmed on the old version keeps pricing the removed extra inside the
//       active-pointer cache window (the accepted, bounded residual of §1.5 — no new fence); past the TTL it is typed menu_changed
//   T12 PROJ-EMPTY-MAP-CLEARS  detaching a dish's last item-level group publishes a PRESENT `extras_by_item: {}`, so an open form's
//       live refresh (index.html: a map REPLACES, an absent field KEEPS the old one) drops the attachment
// Run: npm run test:s2core
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's2core-secret';
process.env.QUOTE_TOKEN_SECRET = process.env.QUOTE_TOKEN_SECRET || 's2core-quote-secret';
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 's2core-edit-secret-'.padEnd(48, 'x');
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
const READ = { fail: false };   // T26: the live reader's Firestore pointer probe and doc read fail while set (index.js destructures them at load)
stub('../catalog/catalog-firestore', (r) => ({ ...r,
  getActiveVersionId: async (...a) => { if (READ.fail) throw Object.assign(new Error('UNAVAILABLE (T26)'), { code: 14 }); return r.getActiveVersionId(...a); },
  getRestaurantDocs: async (...a) => { if (READ.fail) throw Object.assign(new Error('UNAVAILABLE (T26)'), { code: 14 }); return r.getRestaurantDocs(...a); } }));
stub('../catalog/platform-structure', (r) => ({ ...r, structureCapabilities: () => ({ ...r.structureCapabilities(), extrasCatalog: true }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { buildPublicMenu } = require('../catalog/public-menu');
const XT = require('../catalog/exposure-transitions');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2core(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// ── the portal-side cores, as add-product.emulator.test.js wires them ──
const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};
const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'owner@x.hn' });
const io = addProductIo({ fs: db, rtdb });
const readActiveBuilt = (rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const readDraft = (rid) => async () => { const s = await sourceRefOf(db, rid).get(); return { source: s.data(), updateTime: encodeUpdateTime(s.updateTime) }; };
const rev = async (rid) => encodeUpdateTime((await sourceRefOf(db, rid).get()).updateTime);
const draft = async (rid) => (await sourceRefOf(db, rid).get()).data();
const save = async (rid, source, body = {}) => editCatalogCore({ db, authorize: owner, readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct: io },
  { restaurantId: rid, source, baseSourceUpdateTime: await rev(rid), ...body }, {});
const loadedBase = async (rid) => { const p = await getActivePointer(db, rid); return { deleted_ids_loaded_base: { version: p.version, generation: p.generation } }; };
const publish = (rid, saved) => publishEditedCore({ db, authorize: owner, readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid), publishVersion,
  mirror: makeRtdbMirror(rtdb), sourceSha: 's2core', addProduct: io },
{ restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});
const served = async (rid) => (await buildPublicMenu(db, rid, { known: new Set([rid]), isActive: async () => true })).body;

// ── the cart endpoints, as resolve-lines.emulator.test.js drives them ──
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
const DISH = { x_pizza: 'Carnivora', la_musa: 'dimsum_01' };
const GROUP = { x_pizza: 'Carnes', la_musa: 'Salsas' };   // a group the dish is offered, with more than one extra
const dishOf = (rid) => catalogSnapshot(rid).items.find((i) => i.key === DISH[rid]);
const lineWith = (rid, extra) => { const it = dishOf(rid); return { ...(rid === 'x_pizza' ? { name: it.display.name } : { id: it.key, name: it.display.name, cat: it.display.cat }), qty: 1, price: it.price + extra.price, extras: [{ id: extra.display.id, name: extra.display.name, qty: 1 }] }; };
const bodyFor = (rid, oid, phone, items, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'S2core Test', customer_phone: phone, customer_email: 's2core@example.com',
  items_text: '1x test', order_type: 'pickup', payment_method: 'cash', items, ...extra });
const REDEEM = { x_pizza: { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' }, la_musa: { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz Blanco' }] } };
let seq = 0;
const fresh = async () => { await rtdb.ref('rate_limits').remove(); seq += 1; return { oid: `s2c_${seq}_${Date.now() % 100000}`, phone: `9946${String(1000 + seq).slice(-4)}` }; };
const UID = 'u_s2core';

async function seedBrand(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = require('../tools/publish-version').buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  await rtdb.ref(`user_rewards/${UID}/${rid}`).set({ balance: 100000, reserved: 0 });
  if (rid === 'la_musa') await removedOptionCells(rid);   // before certification: an option leaves through a plain re-publish (S2-core has no option op)
  const b = await bootstrapIdentityStamps(db, rid); assert.ok(b.stamped, `${rid}: certified baseline ${JSON.stringify(b)}`);
}

// T9 (removed OPTION, PLAN §1.4: options are items, so the stage's menu_changed covers them — proven anyway on all four endpoints): the
// launcher noodle_01 loses its «Pollo» option in a new active version; a cart still naming it is typed everywhere with zero effects
const OPTION = 'noodle_01_pollo';
let optionCellAt = 0;
async function removedOptionCells(rid) {
  const src = canonicalize(buildSourceFromCode(rid));
  const opt = src.items.find((i) => i.key === OPTION);
  assert.ok(opt, 'premise: the option exists today');
  src.items = src.items.filter((i) => i.key !== OPTION);
  src.structure.item_order = src.structure.item_order.filter((k) => k !== OPTION);
  for (const g of Object.values(src.structure.variant_items || {})) if (Array.isArray(g.variantIds)) g.variantIds = g.variantIds.filter((k) => k !== OPTION);
  for (const f of ['redeem_eligible_items']) if (Array.isArray(src.structure[f])) src.structure[f] = src.structure[f].filter((k) => k !== OPTION);
  const { inputs, built } = buildSourceCandidate(rid, src);
  const ptr = await getActivePointer(db, rid);
  await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's2core-option', key_mode: built.key_mode, frozen_keys: built.frozen_keys }, { expected: { activeVersionId: ptr.version }, mirror: makeRtdbMirror(rtdb) });
  await sourceRefOf(db, rid).set(src);
  const line = { id: OPTION, name: opt.display.name, cat: opt.display.cat, qty: 1, price: opt.price, extras: [] };
  await typedEverywhere(rid, line, `T9-OPTION ${rid}`);
  optionCellAt = Date.now();
  ok(`T9-OPTION ${rid}: a cart still naming a removed option is menu_changed at createOrder / the charge (409), quoteOrder (200), quoteRedemption (409), zero effects`);
}

// T9's four endpoints on a cart line (a removed extra's or a removed option's), with ZERO effects
async function typedEverywhere(rid, line, tag) {
  // ZERO effects = no RTDB byte moves OUTSIDE rate_limits: quoteOrder counts its caller (quote_ip) before any resolution (index.js
  // quoteOrder, today's design and every quote's), which is the request being seen, not an effect of the refused cart
  const effects = async () => { const all = (await rtdb.ref().get()).val() || {}; delete all.rate_limits; return JSON.stringify(all); };
  const f = await fresh(); const before = await effects(); const charged = CHARGED.length;
  const co = await post(app.createOrder, bodyFor(rid, f.oid, f.phone, [line]), { 'x-firebase-id-token': UID });
  assert.deepStrictEqual([co.status, co.json], [409, MENU_CHANGED], `${tag} createOrder 409 menu_changed (${co.text.slice(0, 160)})`);
  const g = `${f.oid}_ch`;
  const ch = await post(app.chargeOnlineOrder, bodyFor(rid, g, f.phone, [line], { payment_method: 'online' }), { 'x-firebase-id-token': UID });
  assert.deepStrictEqual([ch.status, ch.json], [409, MENU_CHANGED], `${tag} the charge 409 menu_changed (${ch.text.slice(0, 160)})`);
  const q = await post(app.quoteOrder, { restaurant_id: rid, items: [line], order_type: 'pickup' });
  assert.deepStrictEqual([q.status, q.json], [200, { ok: false, error: 'menu_changed' }], `${tag} quoteOrder fail-soft menu_changed (${q.text.slice(0, 160)})`);
  const qr = await post(app.quoteRedemption, { restaurant_id: rid, items: [line], order_type: 'pickup', redeem: REDEEM[rid] }, { 'x-firebase-id-token': UID });
  assert.deepStrictEqual([qr.status, qr.json], [409, { ok: false, ...MENU_CHANGED }], `${tag} quoteRedemption 409 { ok:false } (${qr.text.slice(0, 160)})`);
  assert.strictEqual(await effects(), before, `${tag} ZERO RTDB effects (dedupe, reserve, order, holds — every path but the rate counters)`);
  assert.strictEqual(CHARGED.length, charged, `${tag} nothing charged`);
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) await seedBrand(rid);
  await rtdb.ref('config/redemption_enabled').set(true);

  for (const rid of ['x_pizza', 'la_musa']) {
    const base = await draft(rid);
    const X = base.extras.filter((e) => e.display.cat === GROUP[rid])[1];
    assert.ok(X && X.display.identity_id, `premise: ${rid} the stored draft carries the certified extra's stamp (${JSON.stringify(X)})`);
    const warm = rid === 'x_pizza';   // T10 on x_pizza: a reader warmed on the OLD version before the removal publishes
    if (warm) {
      const q0 = await post(app.quoteOrder, { restaurant_id: rid, items: [lineWith(rid, X)], order_type: 'pickup' });
      assert.ok(q0.status === 200 && q0.json && q0.json.ok === true, `T10 premise: ${rid} the extra quotes on the old version (${q0.text.slice(0, 160)})`);
    }

    // ── T7: the claim ──
    const r = XT.apply(base, { op: 'extra.remove', key: X.key });
    assert.deepStrictEqual(r.deletedIds, [X.display.identity_id], `T7 ${rid}: the writer names the removed extra's identity`);
    const rev0 = await rev(rid);
    const unclaimed = await save(rid, r.source);
    assert.deepStrictEqual([unclaimed.status, unclaimed.body.error], [400, 'existing_extra_removed'], `T7 ${rid}: unclaimed, the save refuses (${JSON.stringify(unclaimed.body).slice(0, 200)})`);
    assert.strictEqual(await rev(rid), rev0, `T7 ${rid}: nothing written`);
    const ptr0 = await getActivePointer(db, rid);
    {
      const { inputs, built } = buildSourceCandidate(rid, r.source);
      let outcome = 'FLIPPED';
      try { await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's2core-unclaimed', key_mode: built.key_mode, frozen_keys: built.frozen_keys }, { expected: { activeVersionId: ptr0.version } }); } catch (e) { outcome = (e && (e.code || e.message)) || String(e); }
      assert.match(String(outcome), /identity_partition_unaccounted/, `T7 ${rid}: an unclaimed activation refuses identity_partition_unaccounted (${outcome})`);
      assert.strictEqual((await getActivePointer(db, rid)).version, ptr0.version, `T7 ${rid}: the pointer did not move`);
    }
    const claimed = await save(rid, { ...r.source, deleted_ids: r.deletedIds }, await loadedBase(rid));   // the baseline the merchant reviewed the deletion against (the real save contract)
    assert.strictEqual(claimed.status, 200, `T7 ${rid}: claimed, the save passes (${JSON.stringify(claimed.body).slice(0, 300)})`);
    assert.ok(claimed.body.diff.extras.some((x) => x.key === X.key && x.change === 'removed'), `T7 ${rid}: the review lists the removal`);
    const p = await publish(rid, claimed);
    assert.strictEqual(p.status, 200, `T7 ${rid}: claimed, it publishes (${JSON.stringify(p.body).slice(0, 300)})`);
    const ptr1 = await getActivePointer(db, rid);
    assert.notStrictEqual(ptr1.version, ptr0.version, `T7 ${rid}: activated`);
    const live = await previewVersion(db, rid, ptr1.version);
    assert.ok(!live.extras.some((e) => e.key === X.key), `T7 ${rid}: the live version no longer carries it`);
    const vdoc = (await db.collection('restaurants').doc(rid).collection('versions').doc(ptr1.version).get()).data() || {};
    assert.deepStrictEqual(((vdoc.identity_activation || {}).consumed_deleted_ids || []), [X.display.identity_id], `T7 ${rid}: the claim was consumed at the flip`);
    assert.ok(!(await draft(rid)).deleted_ids, `T7 ${rid}: the source's claim is cleared`);
    ok(`T7 ${rid}: a removed certified extra — unclaimed: save existing_extra_removed (nothing written), activation identity_partition_unaccounted (pointer unmoved); claimed: publishes and consumes the claim`);

    // ── T10 (x_pizza): the bounded stale window, then typed ──
    if (warm) {
      const q1 = await post(app.quoteOrder, { restaurant_id: rid, items: [lineWith(rid, X)], order_type: 'pickup' });
      assert.ok(q1.status === 200 && q1.json && q1.json.ok === true, `T10 ${rid} STALE-WINDOW-RESIDUAL: inside the cache window the warmed reader still prices the old version (${q1.text.slice(0, 160)})`);
      console.log(`      T10 ${rid}: residual recorded — the warmed reader quoted the removed extra ok inside the window`);
      // T26 FALLBACK-RESIDUAL-RECORDED (§1.5): past the TTL with the reader's Firestore reads FAILING, the fallback ladder has no elapsed-time
      // expiry — whatever it answers is recorded (the honest residual), and it never writes
      READ.fail = true;
      try {
        await new Promise((res) => setTimeout(res, 46000));
        const q2 = await post(app.quoteOrder, { restaurant_id: rid, items: [lineWith(rid, X)], order_type: 'pickup' });
        assert.strictEqual(q2.status, 200, `T26 ${rid}: the quote answers while reads fail (${q2.text.slice(0, 160)})`);
        console.log(`      T26 ${rid} FALLBACK-RESIDUAL-RECORDED: reads failing past the TTL → quoteOrder ${JSON.stringify(q2.json).slice(0, 120)}`);
      } finally { READ.fail = false; }
      ok(`T26 ${rid}: past the TTL with reads failing the fallback answers (recorded residual, no expiry by time)`);
      await new Promise((res) => setTimeout(res, 46000));   // reads healthy again: the next pointer probe moves the reader to the removing version
      ok(`T10 ${rid}: inside the active-pointer cache window a warmed reader still prices the removed extra (the accepted residual, §1.5); past the TTL —`);
    }
    // ── T9: typed at all four endpoints, zero effects ──
    if (!warm && optionCellAt) { const wait = optionCellAt + 46000 - Date.now(); if (wait > 0) await new Promise((res) => setTimeout(res, wait)); }   // the option cell warmed this reader
    await typedEverywhere(rid, lineWith(rid, X), `T9 ${rid}${warm ? ' POST-TTL-TYPED' : ''}`);
    ok(`T9 ${rid}: a cart still carrying the removed extra is menu_changed at createOrder / the charge (409), quoteOrder (200 fail-soft), quoteRedemption (409 { ok:false }), with zero effects`);
  }

  // ── T12 (la_musa): the last item-level attachment detached clears the open form's map ──
  {
    const rid = 'la_musa';
    const a = await save(rid, XT.apply(await draft(rid), { op: 'attach.item', item: 'dimsum_01', group: 'Proteínas' }).source);
    assert.strictEqual(a.status, 200, `T12: the attach saves (${JSON.stringify(a.body).slice(0, 200)})`);
    assert.strictEqual((await publish(rid, a)).status, 200, 'T12: the attach publishes');
    const on = await served(rid);
    assert.deepStrictEqual(on.extras_by_item, { dimsum_01: ['Proteínas'], rice_03: ['Proteínas'] }, `T12 premise: the served map carries both item-level attachments (${JSON.stringify(on.extras_by_item)})`);
    let off0 = XT.apply(await draft(rid), { op: 'detach.item', item: 'dimsum_01', group: 'Proteínas' }).source;
    off0 = XT.apply(off0, { op: 'detach.item', item: 'rice_03', group: 'Proteínas' }).source;   // today's own item-level attachment, so the map truly empties
    const d = await save(rid, off0);
    assert.strictEqual(d.status, 200, `T12: the detach saves (${JSON.stringify(d.body).slice(0, 200)})`);
    assert.strictEqual((await publish(rid, d)).status, 200, 'T12: the detach publishes');
    const off = await served(rid);
    assert.ok(Object.prototype.hasOwnProperty.call(off, 'extras_by_item'), 'T12 PROJ-EMPTY-MAP-CLEARS: the served body carries extras_by_item (m14: an omitted map leaves the form on the old one)');
    assert.deepStrictEqual(off.extras_by_item, {}, 'T12: the map is empty');
    // the open form's refresh rule (index.html): a served MAP replaces EXTRAS_BY_ITEM; an absent field keeps the old one
    const form = require('fs').readFileSync(path.join(__dirname, '..', '..', 'xpizza-orders', 'index.html'), 'utf8');
    assert.ok(form.includes('EXTRAS_BY_ITEM: isMap(body.extras_by_item) ? body.extras_by_item : EXTRAS_BY_ITEM'), 'T12 premise: the form\'s live refresh replaces the map only when one is served');
    ok('T12 la_musa: detaching the last item-level group publishes a present extras_by_item {} — the open form\'s refresh replaces its map');
  }

  FINISHED = true;
  console.log(`\ns2core(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s2core(emulator) FAILED:', e); process.exit(1); });
