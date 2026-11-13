'use strict';
// S3 (PLAN-structure-S3-r4 §1b, §7 REWARD-UNCHANGED / RENAME-FROZEN; Codex build r1 P2-4) — today's free-item rewards across the S3 edits,
// through the REAL money endpoints (index.js createOrder / chargeOnlineOrder / quoteRedemption on the emulator) with REAL payloads: the paid
// cart serialized by the customer app's own serializer (capp-serialize) over the SERVED menu (buildPublicMenu), the reward picked from the
// REAL order form's picker (buildRedeemCatalog, the booted page) and sent in the form's own redeem shape (account.js rkCommit). The versions
// are published by the real publisher with choiceEdit ON (the S3 writer → the save's steps → publishVersion).
//   1 UNCHANGED (la_musa): a reward on an unaffected dish — before vs after D3 and an option rename — the same stored canonical redemption and
//     redemption fingerprint (cash), and the same quote
//   2 RENAME (la_musa): the renamed option, picked from the form's picker, redeems exactly as before the rename (cash + card)
//   3 D3 STALE (la_musa): a reward naming a removed option → 409 before any write (no order, no hold)
//   4 RENAME (x_pizza, a NEW sized 12" pizza — Q3): the live picker's kept key redeems; the baked bundle's new name → 409, nothing written
// HONEST SCOPE (advisor r2): the reward PAYLOADS are reconstructed in the form's own redeem shape (account.js rkCommit) from the REAL picker's
// row — this suite does not drive the frozen form's submit button; the form's submission serializer for renamed options is covered by
// s3-rewards.test.mjs (the real picker) and the served-menu cells (s3-served.test.mjs). The PAID cart is the capp's own serializer.
// Every comparison is preceded by an asserted SUCCESS (status + the body's own fields).
// Run: npm run test:s3-rewards
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's3r-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.PIXELPAY_RETURN_URL_X_PIZZA = process.env.PIXELPAY_RETURN_URL_X_PIZZA || 'https://xpizza.test';
const STRUCT = { choiceEdit: true };
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../catalog/platform-structure', (r) => ({ ...r, structureCapabilities: () => ({ ...r.structureCapabilities(), choiceEdit: STRUCT.choiceEdit }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => ({ ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }) }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const realPublish = require('../catalog/catalog-publish');
const AP = require('../catalog/add-product');
const FK = require('../catalog/frozen-keys');
const CT = require('../catalog/choice-transitions');
const CC = require('../catalog/choice-compare');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { buildPublicMenu } = require('../catalog/public-menu');
const { redemptionFingerprint } = require('../rewards-redeem');
const CAPP = path.join(__dirname, '..', '..', 'customer-app');
const { adaptMenu } = require(path.join(CAPP, 'capp-menu.js'));
const { createCart } = require(path.join(CAPP, 'capp-cart.js'));
const { serialize } = require(path.join(CAPP, 'capp-serialize.js'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s3-rewards-endpoints: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
const MODE = { x_pizza: 'name', la_musa: 'id' };
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
let PH = 0;
const phone = () => `9977${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();
const reserved = async (rid) => ((await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val() || {}).reserved || 0;

// the save's own steps (edit-catalog-handler.js:113 + the allocator with the S3 preparer) and the real publisher
function saved(rid, live, draft) {
  let c = canonicalize(AP.rederiveOptionNames(canonicalize(draft)));
  const rec = FK.recordRenames({ draft: c, live, stored: live, textEdit: true });
  if (!rec.ok) throw new Error(`recordRenames refused (${rec.error})`);
  c = canonicalize(FK.withFrozenKeys(c, rec.frozen_keys));
  if (c.items.some((i) => i.ref)) c = canonicalize(AP.allocateAdditions({ incoming: c, stored: live, activeItems: live.items, keyMode: MODE[rid], hwm: null, registryHasKey: () => false, authoring: true, prepareExisting: CC.prepareExistingGroups }).source);
  return c;
}
async function publish(rid, src) {
  const { inputs, built } = buildSourceCandidate(rid, src);
  const active = await getActivePointer(fs, rid);
  await quiet(() => realPublish.publishVersion(fs, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's3re',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) },
  { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: active.version } }));
  await sourceRefOf(fs, rid).set(src);
}
const servedEnv = async (rid) => { const m = await quiet(() => buildPublicMenu(fs, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true })); return { rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }; };
// the paid cart: one plain dish, serialized by the customer app's OWN serializer over the served menu
const paidItems = (env, pick) => { const m = adaptMenu(env); const d = m.dishes.find(pick); assert.ok(d, 'premise: a paid dish is served'); const c = createCart(m); c.inc(d.key); return serialize(c, m).items; };
// the order form's OWN reward picker, booted on the served menu (form-harness: the real page in jsdom)
async function pickerRows(rid, env) {
  const H = await import(path.join(__dirname, '..', '..', 'form-harness.mjs'));
  const w = H.loadForm(rid === 'la_musa' ? 'la-musa-orders' : 'xpizza-orders'); await H.settle();
  await H.serve(w, env); await H.settle();
  const rows = w.buildRedeemCatalog(); H.closeAll(); return rows;
}
// the redeem payload exactly as the form builds it (account.js rkCommit)
const redeemOf = (rid, row) => (rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: row.key, name: row.name } : { type: 'points_ala_carte', items: [{ id: row.key, qty: 1, name: row.name }] });
const bodyOf = (rid, oid, method, items, redeem) => ({ restaurant_id: rid, order_id: oid, customer_name: 'S3 Rewards', customer_phone: phone(), customer_email: 's3r@example.com',
  items_text: items.map((i) => `${i.qty}x ${i.name}`).join(', '), order_type: 'pickup', payment_method: method, items, redeem });
const place = async (rid, oid, method, items, redeem) => { await clean(); return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyOf(rid, oid, method, items, redeem), { 'x-firebase-id-token': `u_${rid}` }); };
const quote = async (rid, items, redeem) => post(app.quoteRedemption, { restaurant_id: rid, items, redeem }, { 'x-firebase-id-token': `u_${rid}` });
// SUCCESS first: the status and the body's own fields, before any comparison
const placedOk = (r, label, method) => { assert.strictEqual(r.status, 200, `${label}: ${r.text.slice(0, 200)}`); assert.ok(r.json && (method === 'online' ? typeof r.json.url === 'string' || r.json.ok === true : r.json.ok === true || typeof r.json.tracking_token === 'string'), `${label}: the success body (${r.text.slice(0, 160)})`); };
const quotedOk = (q, label) => { assert.strictEqual(q.status, 200, `${label}: ${q.text.slice(0, 200)}`); assert.ok(q.json && Array.isArray(q.json.free_items) && q.json.free_items.length === 1 && Number.isInteger(q.json.total_cost), `${label}: the quote body (${q.text.slice(0, 160)})`); };

async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 's3re-seed' });
    await quiet(() => realPublish.publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) }));
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
    await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  const LM = canonicalize(buildSourceFromCode('la_musa'));
  const PAD = 'noodle_01';
  const opts = LM.structure.variant_items[PAD].variantIds.map((id) => LM.items.find((i) => String(i.display.id) === String(id)).key);
  const mark = (s) => CT.apply(s, { op: 'choice.recommended', launcher: PAD, option: opts[0] }).source;
  const plainPaid = (d) => d.key === 'dimsum_02';
  const STEADY = 'noodle_02';

  // ── 1 + 2: the base redemptions (cash), then the same after an option rename and after D3 ──
  const env0 = await servedEnv('la_musa');
  const rows0 = await pickerRows('la_musa', env0);
  const steadyRow = rows0.find((r) => r.key === STEADY); const optRow0 = rows0.find((r) => r.key === opts[1]);
  assert.ok(steadyRow && optRow0, 'premise: the steady dish and the option are reward rows');
  const items0 = paidItems(env0, plainPaid);
  const base = {};
  for (const [label, row] of [['steady', steadyRow], ['option', optRow0]]) {
    const r = await place('la_musa', `s3re_base_${label}`, 'cash', items0, redeemOf('la_musa', row));
    placedOk(r, `premise: the base ${label} reward redeems`, 'cash');
    base[label] = (await order(`s3re_base_${label}`)).redemption;
  }
  const q0 = await quote('la_musa', items0, redeemOf('la_musa', steadyRow)); quotedOk(q0, 'premise: the base quote');
  await publish('la_musa', saved('la_musa', LM, mark(CT.apply(LM, { op: 'option.rename', key: opts[1], choice: 'Pollo al Wok' }).source)));
  {
    const env = await servedEnv('la_musa'); const rows = await pickerRows('la_musa', env); const items = paidItems(env, plainPaid);
    const s = await place('la_musa', 's3re_ren_steady', 'cash', items, redeemOf('la_musa', rows.find((r) => r.key === STEADY)));
    placedOk(s, 'UNCHANGED after rename', 'cash');
    const so = (await order('s3re_ren_steady')).redemption;
    assert.deepStrictEqual(so, base.steady, '🔴 UNCHANGED after rename: the same stored canonical redemption');
    assert.strictEqual(redemptionFingerprint(so), redemptionFingerprint(base.steady), '🔴 UNCHANGED after rename: the same redemption fingerprint');
    const q = await quote('la_musa', items, redeemOf('la_musa', rows.find((r) => r.key === STEADY))); quotedOk(q, 'UNCHANGED after rename: the quote');
    assert.deepStrictEqual([q.status, q.json && q.json.free_items, q.json && q.json.total_cost], [q0.status, q0.json && q0.json.free_items, q0.json && q0.json.total_cost], 'UNCHANGED after rename: the same quote');
    const row = rows.find((r) => r.key === opts[1]);
    assert.ok(row && /Pollo al Wok$/.test(row.name), `premise: the picker shows the renamed option under its kept key (${JSON.stringify(row)})`);
    const c = await place('la_musa', 's3re_ren_opt', 'cash', items, redeemOf('la_musa', row));
    placedOk(c, '🔴 RENAME cash', 'cash');
    assert.deepStrictEqual((await order('s3re_ren_opt')).redemption, base.option, '🔴 RENAME cash: the renamed option redeems exactly as before (canonical)');
    const k = await place('la_musa', 's3re_ren_card', 'online', items, redeemOf('la_musa', row));
    placedOk(k, '🔴 RENAME card', 'online');
    ok('UNCHANGED + RENAME (la_musa): after an option rename the steady reward stores the same canonical + fingerprint and quotes the same; the renamed option (picked from the form) redeems as before, cash and card');
  }
  {   // the OPTION ADD transition (planned): a new option under the group — the steady reward unchanged; the new option redeems
    const cur = (await sourceRefOf(fs, 'la_musa').get()).data();
    await publish('la_musa', saved('la_musa', cur, CT.apply(cur, { op: 'option.add', launcher: PAD, ref: 'tmp:s3re-tofu-xxxx', choice: 'Tofu', price: 330 }).source));
    await new Promise((r) => setTimeout(r, 46000));   // the intake gates' pointer TTL (catalog/menu-gates.js POINTER_TTL_MS 45 s): a NEW key is menu_updating until it lapses
    const env = await servedEnv('la_musa'); const rows = await pickerRows('la_musa', env); const items = paidItems(env, plainPaid);
    const s = await place('la_musa', 's3re_add_steady', 'cash', items, redeemOf('la_musa', rows.find((r) => r.key === STEADY)));
    placedOk(s, 'UNCHANGED after option add', 'cash');
    assert.deepStrictEqual((await order('s3re_add_steady')).redemption, base.steady, '🔴 UNCHANGED after option add: the same stored canonical redemption');
    const tofu = rows.find((r) => /Tofu$/.test(r.name));
    assert.ok(tofu, 'premise: the new option is a reward row');
    const t = await place('la_musa', 's3re_add_tofu', 'cash', items, redeemOf('la_musa', tofu));
    placedOk(t, 'ADD: the new option redeems', 'cash');
    ok('OPTION ADD (la_musa): the steady reward is unchanged; the new option redeems from the picker');
  }
  await publish('la_musa', saved('la_musa', (await sourceRefOf(fs, 'la_musa').get()).data(), CT.apply((await sourceRefOf(fs, 'la_musa').get()).data(), { op: 'choice.remove', launcher: PAD, price_from: opts[1] }).source));
  await new Promise((r) => setTimeout(r, 46000));   // the intake gates' pointer TTL (catalog/menu-gates.js POINTER_TTL_MS 45 s): until it lapses the gates price by the version before D3
  {
    const env = await servedEnv('la_musa'); const rows = await pickerRows('la_musa', env); const items = paidItems(env, plainPaid);
    const s = await place('la_musa', 's3re_d3_steady', 'cash', items, redeemOf('la_musa', rows.find((r) => r.key === STEADY)));
    placedOk(s, 'UNCHANGED after D3', 'cash');
    assert.deepStrictEqual((await order('s3re_d3_steady')).redemption, base.steady, '🔴 UNCHANGED after D3: the same stored canonical redemption');
    const held = await reserved('la_musa');
    const stale = await place('la_musa', 's3re_d3_stale', 'cash', items, redeemOf('la_musa', optRow0));
    assert.strictEqual(stale.status, 409, `🔴 D3 STALE: a reward naming a removed option is refused (${stale.text.slice(0, 160)})`);
    assert.strictEqual(await order('s3re_d3_stale'), null, '🔴 D3 STALE: no order written');
    assert.strictEqual(await reserved('la_musa'), held, '🔴 D3 STALE: no hold taken');
    assert.ok(rows.some((r) => r.key === PAD) && !rows.some((r) => opts.includes(r.key)), 'D3: the picker offers the plain dish, no removed option');
    ok('UNCHANGED + D3 STALE (la_musa): after D3 the steady reward is unchanged; a stale reward naming a removed option is 409 with no order and no hold');
  }

  // ── 4: x_pizza, a NEW sized 12" pizza (Q3) whose option is renamed ──
  {
    const XP = canonicalize(buildSourceFromCode('x_pizza'));
    const add = clone(XP);
    add.items.push({ ref: 'tmp:s3re-pie-xxxxx', price: 300, display: { name: 'Pizza Doble S3', cat: 'individual', price: 300 } });
    add.structure.item_order.push('tmp:s3re-pie-xxxxx');
    add.structure.variant_items = { ...(add.structure.variant_items || {}), 'tmp:s3re-pie-xxxxx': { label: 'Tamaño', variantIds: ['tmp:s3re-p12-xxxxx', 'tmp:s3re-p18-xxxxx'] } };
    for (const [ref, choice, price] of [['tmp:s3re-p12-xxxxx', '12 pulgadas', 300], ['tmp:s3re-p18-xxxxx', '18 pulgadas', 520]]) { add.items.push({ ref, price, display: { variantOf: 'tmp:s3re-pie-xxxxx', choice, price, ...(choice === '12 pulgadas' ? { tags: ['recommended'] } : {}) } }); add.structure.item_order.push(ref); }   // its one «Recomendada», before the first publish (a new group is a touched group)
    const v1 = saved('x_pizza', XP, add);
    await publish('x_pizza', v1);
    const small = v1.items.find((i) => i.display.choice === '12 pulgadas');
    let v2 = CT.apply(v1, { op: 'option.rename', key: small.key, choice: 'Personal' }).source;
    await publish('x_pizza', saved('x_pizza', v1, v2));
    await new Promise((r) => setTimeout(r, 46000));   // the intake gates' pointer TTL (catalog/menu-gates.js POINTER_TTL_MS 45 s): the new sized pizza's keys are menu_updating until it lapses
    const env = await servedEnv('x_pizza'); const rows = await pickerRows('x_pizza', env);
    const live = rows.find((r) => r.name === 'Pizza Doble S3 - Personal');
    assert.ok(live && live.key === small.key, `🔴 the live picker keys the renamed option by its kept key (${JSON.stringify(live)})`);
    const items = paidItems(env, (d) => d.cat === 'individual' && d.key !== small.key && !d.variantOf);
    const ok1 = await place('x_pizza', 's3re_xp_live', 'cash', items, redeemOf('x_pizza', live));
    placedOk(ok1, '🔴 RENAME-XP live', 'cash');
    const okc = await place('x_pizza', 's3re_xp_live_card', 'online', items, redeemOf('x_pizza', live));
    placedOk(okc, '🔴 RENAME-XP live card', 'online');
    const qx = await quote('x_pizza', items, redeemOf('x_pizza', live)); assert.strictEqual(qx.status, 200, `RENAME-XP quote: ${qx.text.slice(0, 160)}`);
    const baked = clone(env); delete baked.menu.item_keys;
    const bk = (await pickerRows('x_pizza', baked)).find((r) => r.name === 'Pizza Doble S3 - Personal');
    assert.ok(bk && bk.key === 'Pizza Doble S3 - Personal', 'premise: without item_keys the picker keys the row by its name');
    const held = await reserved('x_pizza');
    const no = await place('x_pizza', 's3re_xp_baked', 'cash', items, redeemOf('x_pizza', bk));
    assert.strictEqual(no.status, 409, `🔴 RENAME-XP baked: the new name is refused (${no.text.slice(0, 160)})`);
    assert.strictEqual(await order('s3re_xp_baked'), null, '🔴 RENAME-XP baked: no order');
    assert.strictEqual(await reserved('x_pizza'), held, '🔴 RENAME-XP baked: no hold');
    ok('RENAME (x_pizza, a new sized pizza): the live picker\'s kept key redeems; the baked bundle\'s new name is 409 with no order and no hold');
  }
  FINISHED = true;
  console.log(`s3-rewards-endpoints: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s3-rewards-endpoints FAILED:', e && (e.stack || e.message)); process.exit(1); });
