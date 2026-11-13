'use strict';
// S2b (PLAN-structure-S2b-r3 §2.6, §4, §6; §7 PAID-TEXT / KDS-FREE / ADMISSION) — the REAL intakes (index.js createOrder / chargeOnlineOrder /
// quoteOrder / quoteRedemption on the emulator) over a version that records an affected extra (one renamed, one retired-and-reused under a
// minted key), published by the REAL publisher. The paid cart is the customer app's OWN serializer over the SERVED menu (buildPublicMenu).
//   1 PAID-TEXT (both brands, cash + card): the honest app text is accepted and STORED (the kitchen reads the label); a stale name in the
//     text → 409 items_text_mismatch, no order written
//   2 KDS-FREE (la_musa): a redeemed affected extra sent with a stale client name → the stored free line names the server LABEL
//   3 ADMISSION (switch ON, all 4 intakes): a request stamped as each restaurant-context orders deployment, and a header-less one → 410
//     client_retired with no order and no hold; the platform app deployment is admitted. Switch OFF: the header-less request is today's
// Every refusal is preceded by an asserted SUCCESS of the same body. Run: npm run test:s2b-intake
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's2bi-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.PIXELPAY_RETURN_URL_X_PIZZA = process.env.PIXELPAY_RETURN_URL_X_PIZZA || 'https://xpizza.test';
const SW = { on: false };
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
stub('../catalog/extra-identity', (r) => ({ ...r, extraIdentityCapabilities: () => ({ mintExtras: SW.on }) }));
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
const CHARGES = [];   // every gateway call (Codex S2b r1 P2-6: refused requests are asserted to make none)
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGES.push(q.pixelpayOrderId); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildPublicMenu } = require('../catalog/public-menu');
const { PLATFORM } = require('../platform-manifest');
const CAPP = path.join(__dirname, '..', '..', 'customer-app');
const { adaptMenu } = require(path.join(CAPP, 'capp-menu.js'));
const { createCart } = require(path.join(CAPP, 'capp-cart.js'));
const { serialize } = require(path.join(CAPP, 'capp-serialize.js'));

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s2b-intake: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
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
const phone = () => `9966${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();
const reserved = async (rid) => ((await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val() || {}).reserved || 0;

// the recorded version: [0] renamed (key kept), [1] retired-and-reused under a minted key (as the S2b allocator + recordExtraRenames write it)
const MK = 'i_aaaaaaaaaabu';
function recorded(rid) {
  const s = clone(buildSourceFromCode(rid));
  const r = s.extras[0]; const oldR = r.display.name; r.display.name = 'Renombrado S2b';
  const m = s.extras[1]; const old = m.key; const oldM = m.display.name;
  if (rid === 'la_musa') m.display.id = MK;
  if (Array.isArray(s.structure.extra_order)) s.structure.extra_order = s.structure.extra_order.map((k) => (k === old ? MK : k));
  for (const f of ['extras_by_category', 'extras_by_item']) if (s.structure[f]) for (const v of Object.values(s.structure[f])) if (Array.isArray(v)) { const i = v.indexOf(old); if (i >= 0) v[i] = MK; }
  if (Array.isArray(s.structure.redeem_eligible_extras)) s.structure.redeem_eligible_extras = s.structure.redeem_eligible_extras.map((k) => (k === old ? MK : k));
  m.key = MK; m.display.name = 'Reusado S2b';
  s.frozen_extra_keys = { [r.key]: { display_id: String(r.display.id), field: 'name' }, [MK]: { display_id: String(m.display.id), minted: true, reuses: old } };
  return { s, renamed: r, minted: m, oldR, oldM };
}
async function publish(rid, src) {
  const { inputs, built } = buildSourceCandidate(rid, src);
  await quiet(() => publishVersion(fs, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's2bi',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }), ...(built.frozen_extra_keys == null ? {} : { frozen_extra_keys: built.frozen_extra_keys }) },
  { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: null } }));
  await sourceRefOf(fs, rid).set(canonicalize(src));
}
const servedMenu = async (rid) => { const m = await quiet(() => buildPublicMenu(fs, rid, { known: new Set(['x_pizza', 'la_musa']), isActive: async () => true })); return adaptMenu({ rid: m.rid, representation_version: m.representation_version, menu: clone(m.body) }); };
// the honest app cart: a dish with BOTH affected extras, serialized by the app
function honest(menu, keys) {
  const ex = (k) => menu.extras.find((e) => e.extra_key === k);
  const d = menu.dishes.find((x) => !x.launcher && keys.every((k) => menu.extrasFor(x.key).some((e) => e.extra_key === k)));
  assert.ok(d, 'premise: a dish offers both affected extras');
  const c = createCart(menu); c.add(d.key, keys.map((k) => ex(k).key), 1);
  return serialize(c, menu);
}
const bodyOf = (rid, oid, method, cappBody, extra = {}) => ({ restaurant_id: rid, order_id: oid, customer_name: 'S2b Intake', customer_phone: phone(), customer_email: 's2bi@example.com',
  items_text: cappBody.items_text, order_type: 'pickup', payment_method: method, items: cappBody.items, ...extra });
const place = async (rid, oid, method, cappBody, extra = {}, headers = {}) => { await clean(); return post(method === 'online' ? app.chargeOnlineOrder : app.createOrder, bodyOf(rid, oid, method, cappBody, extra), { 'x-firebase-id-token': `u_${rid}`, ...headers }); };   // an authenticated customer (members may pay cash)
const placedOk = (r, label) => { assert.strictEqual(r.status, 200, `${label}: ${r.text.slice(0, 200)}`); };
const stamp = (dep) => (dep ? { 'X-Client-App': dep.app, 'X-Client-Deployment': dep.id, 'X-Client-Build': 'b1', 'X-Client-Compat': '3' } : {});

async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  const R = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    R[rid] = recorded(rid);
    await publish(rid, R[rid].s);
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
    await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });
  }
  await rtdb.ref('config/redemption_enabled').set(true);

  // ── 1 PAID-TEXT ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const { renamed, oldR, oldM } = R[rid];
    const menu = await servedMenu(rid);
    const body = honest(menu, [renamed.key, MK]);
    for (const method of ['cash', 'online']) {
      const oid = `s2bi_${rid}_${method}_ok`;
      const r = await place(rid, oid, method, body);
      placedOk(r, `PAID-TEXT ${rid} ${method}: the honest app text`);
      const o = await order(oid);
      assert.ok(o && /Renombrado S2b/.test(o.items_text) && /Reusado S2b/.test(o.items_text), `🔴 PAID-TEXT ${rid} ${method}: the stored kitchen text carries both labels (${o && o.items_text})`);
      const stale = clone(body); stale.items_text = stale.items_text.split('Reusado S2b').join(oldM).split('Renombrado S2b').join(oldR);
      const sid = `s2bi_${rid}_${method}_stale`;
      const x = await place(rid, sid, method, stale);
      assert.deepStrictEqual([x.status, x.json && x.json.error], [409, 'items_text_mismatch'], `🔴 PAID-TEXT ${rid} ${method}: a stale name is refused (${x.text.slice(0, 160)})`);
      assert.strictEqual(await order(sid), null, `🔴 PAID-TEXT ${rid} ${method}: no order written`);
    }
  }
  ok('PAID-TEXT (both brands, cash + card): the honest app text is stored with the labels; a stale name → 409 items_text_mismatch, nothing written');

  // ── 2 KDS-FREE (la_musa: extras are reward items) ──
  {
    const rid = 'la_musa'; const { oldM } = R[rid];
    const menu = await servedMenu(rid);
    const d = menu.dishes.find((x) => !x.launcher && menu.extrasFor(x.key).length === 0) || menu.dishes.find((x) => !x.launcher);
    const c = createCart(menu); c.inc(d.key); const paid = serialize(c, menu);
    const oid = 's2bi_kds_free';
    const r = await place(rid, oid, 'cash', paid, { redeem: { type: 'points_ala_carte', items: [{ id: MK, qty: 1, name: oldM }] } }, { 'x-firebase-id-token': `u_${rid}` });
    placedOk(r, 'KDS-FREE: the reward redeems');
    const o = await order(oid);
    assert.ok(o && /1x Reusado S2b \(Recompensa\)/.test(o.items_text) && !o.items_text.includes(`${oldM} (Recompensa)`), `🔴 KDS-FREE: the free line names the label (${o && o.items_text})`);
    ok('KDS-FREE (la_musa): a redeemed minted extra sent with its stale name prints the server label on the kitchen line');
  }

  // ── 3 ADMISSION (Codex S2b r1 P2-6: authenticated, valid positive controls on all 4 intakes; refusals assert no order, no gateway call,
  //    no payment attempt and no reward hold — the refused order bodies DO request a redemption) ──
  {
    const forms = PLATFORM.sites.deployments.filter((d) => d.app === 'orders' && d.context !== 'platform');
    const appDep = PLATFORM.sites.deployments.find((d) => d.app === 'orders' && d.context === 'platform');
    assert.ok(forms.length >= 2 && appDep, 'premise: the manifest declares the forms and the app');
    const rid = 'x_pizza'; const menu = await servedMenu(rid); const body = honest(menu, [R[rid].renamed.key, MK]);
    const TOKEN = { 'x-firebase-id-token': `u_${rid}` };
    const REDEEM = { redeem: { type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' } };
    const attempts = async () => Object.keys((await rtdb.ref('payment_attempts').get()).val() || {}).length;
    const intakes = (dep, tag) => [
      ['createOrder', () => post(app.createOrder, bodyOf(rid, `s2bi_${tag}_co`, 'cash', body, REDEEM), { ...stamp(dep), ...TOKEN }), `s2bi_${tag}_co`],
      ['chargeOnlineOrder', () => post(app.chargeOnlineOrder, bodyOf(rid, `s2bi_${tag}_ch`, 'online', body, REDEEM), { ...stamp(dep), ...TOKEN }), `s2bi_${tag}_ch`],
      ['quoteOrder', () => post(app.quoteOrder, { restaurant_id: rid, items: body.items, order_type: 'pickup' }, { ...stamp(dep), ...TOKEN }), null],
      ['quoteRedemption', () => post(app.quoteRedemption, { restaurant_id: rid, items: body.items, ...REDEEM }, { ...stamp(dep), ...TOKEN }), null],
    ];
    const positive = async (dep, tag, label) => {
      for (const [ep, call, oid] of intakes(dep, tag)) {
        await clean(); const r = await call();
        assert.strictEqual(r.status, 200, `${label} ${ep}: a valid authenticated request is admitted (${r.text.slice(0, 200)})`);
        if (ep === 'quoteOrder' || ep === 'quoteRedemption') assert.ok(r.json && r.json.ok === true, `${label} ${ep}: ok:true (${r.text.slice(0, 160)})`);
        if (oid) assert.ok(await order(oid), `${label} ${ep}: the order is written`);
        if (oid) { await rtdb.ref(`orders/${oid}`).remove(); await rtdb.ref(`user_rewards/u_${rid}/${rid}/reserved`).set(0); }
      }
    };
    await positive(null, 'off', 'ADMISSION OFF (header-less, today)');
    SW.on = true;
    try {
      for (const dep of [...forms, null]) {
        const label = dep ? dep.id : 'header-less';
        const before = { holds: await reserved(rid), charges: CHARGES.length, attempts: await attempts() };
        for (const [ep, call, oid] of intakes(dep, `adm_${label}`.replace(/[^A-Za-z0-9_]/g, '_'))) {
          await clean(); const r = await call();
          assert.deepStrictEqual([r.status, r.json && r.json.error], [410, 'client_retired'], `🔴 ADMISSION ${label} ${ep}: ${r.text.slice(0, 160)}`);
          if (oid) assert.strictEqual(await order(oid), null, `🔴 ADMISSION ${label} ${ep}: no order`);
        }
        assert.deepStrictEqual({ holds: await reserved(rid), charges: CHARGES.length, attempts: await attempts() }, before, `🔴 ADMISSION ${label}: no reward hold, no gateway call, no payment attempt`);
      }
      // La Musa's FORM sending a minted display id (its legacy field) — the case the resolver alone would accept — is retired at admission
      { const lm = 'la_musa'; const lmMenu = await servedMenu(lm); const lmBody = honest(lmMenu, [R[lm].renamed.key, MK]);
        const formish = clone(lmBody); for (const it of formish.items) for (const e of it.extras) { delete e.extra_key; delete e.extra_id; }   // the form sends id (= the minted display id) only
        assert.ok(formish.items.some((it) => it.extras.some((e) => e.id === MK)), 'premise: the form-shaped line names the minted id');
        const dep = forms.find((d) => d.context === lm); await clean();
        const r = await post(app.createOrder, bodyOf(lm, 's2bi_adm_lm_minted', 'cash', formish), { ...stamp(dep), 'x-firebase-id-token': `u_${lm}` });
        assert.deepStrictEqual([r.status, r.json && r.json.error], [410, 'client_retired'], `🔴 ADMISSION la_musa form + minted id: ${r.text.slice(0, 160)}`);
        assert.strictEqual(await order('s2bi_adm_lm_minted'), null, '🔴 ADMISSION la_musa form + minted id: no order'); }
      for (const id of [appDep.id, PLATFORM.nativeDeployment()]) await positive({ app: 'orders', id }, `ok_${id}`.replace(/[^A-Za-z0-9_]/g, '_'), `ADMISSION ON (${id})`);
    } finally { SW.on = false; }
    ok('ADMISSION: OFF header-less is today on all 4 intakes; ON every stamped form deployment and a header-less request are 410 client_retired on all 4 (no order, no hold, no gateway call, no attempt), incl. La Musa\'s form with a minted id; the app + its native deployment are admitted on all 4');
  }
  FINISHED = true;
  console.log(`s2b-intake: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s2b-intake FAILED:', e && (e.stack || e.message)); process.exit(1); });
