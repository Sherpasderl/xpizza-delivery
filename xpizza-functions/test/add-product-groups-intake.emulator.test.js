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

  /* ── codex PB-1 r1 P1-3 / P2-5 — REWARD LIFECYCLES with an OWNED hold ────────────────────────────────────────────────── */
  const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
  const { buildMaterializeUpdates } = require('../materialize');
  const { paymentHash } = require('../pixelpay');
  const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';   // sandbox (resolvePixelPayConfig default)
  const hookDeps = { db: rtdb, restaurant: { lat: 14.1, lng: -87.2, name: 'La Musa', phone: '+504' }, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) };
  const holdOf = async (oid) => (await rtdb.ref(`user_rewards/u_la_musa/la_musa/reservations/${oid}`).get()).val();
  const reservedNow = async () => Number(((await rtdb.ref('user_rewards/u_la_musa/la_musa').get()).val() || {}).reserved) || 0;
  const paidCallback = async (oid) => {
    const o = await order(oid); const hosted = `${oid}-${o.active_attempt_id}`;
    return handleHostedCallback(hookDeps, { order: hosted, status: 'paid', amount: o.total_cents / 100, uuid: `P-${oid}`, transaction_id: `T-${oid}`, payment_hash: paymentHash(hosted, KEY, SECRET) }, Date.now());
  };
  const PAID = [line('la_musa', 'dimsum_01', 225)];

  // S1 — a BARE launcher reward issued while render was OFF (legacy, no bound input fingerprint): it reuses and
  // materializes from its bound values; its rotation after the flip is refused (choice_required) and the hold is untouched.
  {
    Object.assign(CAPS, { render: false });
    const rdL = { type: 'points_ala_carte', items: [{ id: 'noodle_01', qty: 1, name: 'Pad Thai' }] };
    const a1 = await send('la_musa', 'apg_lc_A', 'online', PAID, { redeem: rdL });
    const b1 = await send('la_musa', 'apg_lc_B', 'online', PAID, { redeem: rdL });
    assert.ok(a1.status === 200 && a1.json.checkout_url && b1.status === 200, `setup (render OFF): two launcher-reward checkouts — ${a1.text.slice(0, 160)} / ${b1.text.slice(0, 160)}`);
    assert.ok((await holdOf('apg_lc_A')).state === 'reserved' && (await holdOf('apg_lc_B')).state === 'reserved', 'setup: each owns a reserved hold');
    assert.strictEqual((await order('apg_lc_A')).charge_inputs_fp, undefined, 'render OFF binds no input fingerprint (dormant)');
    Object.assign(CAPS, { render: true });
    const held = await reservedNow();
    const a2 = await send('la_musa', 'apg_lc_A', 'online', PAID, { redeem: rdL });
    assert.deepStrictEqual([a2.status, a2.json && a2.json.checkout_url], [200, a1.json.checkout_url], `🔴 after the flip the issued launcher-reward checkout REUSES its URL — ${a2.text.slice(0, 200)}`);
    assert.strictEqual(await reservedNow(), held, 'no second hold');
    const boundTotal = (await order('apg_lc_A')).total_cents;
    const cb = await paidCallback('apg_lc_A');
    const oa = await order('apg_lc_A');
    assert.ok(cb.code === 200 && oa.payment_status === 'confirmed', `the paid callback materializes it — ${JSON.stringify(cb).slice(0, 160)}`);
    assert.strictEqual(oa.total_cents, boundTotal, 'materialized from the BOUND total');
    assert.ok(oa.redemption, 'the bound reward stays on the order');
    assert.strictEqual((await holdOf('apg_lc_A')).state, 'consumed', 'the owned hold is CONSUMED at materialize');
    const attB = (await order('apg_lc_B')).active_attempt_id;
    await rtdb.ref(`payment_attempts/${attB}/hosted_expires_at`).set(1);
    const heldB = await reservedNow();
    const b2 = await send('la_musa', 'apg_lc_B', 'online', PAID, { redeem: rdL });
    assert.deepStrictEqual([b2.status, b2.json && b2.json.error], [409, 'choice_required'], `🔴 the expired launcher-reward checkout's ROTATION is refused — ${b2.text.slice(0, 200)}`);
    assert.strictEqual((await order('apg_lc_B')).active_attempt_id, attB, 'no new attempt was issued');
    assert.strictEqual((await holdOf('apg_lc_B')).state, 'reserved', 'the hold (not this request\'s to release) is untouched — the expiry sweep owns it');
    assert.strictEqual(await reservedNow(), heldB, 'no hold taken or released by the refused rotation');
  }
  ok('launcher REWARD issued before the flip (owned hold): reuse returns its URL with no second hold, the paid callback materializes the bound total and CONSUMES the hold; an expired one\'s rotation is refused (choice_required) with no new attempt and the hold untouched');

  // S2 — a CHOICE reward issued under render ON is BOUND (charge_inputs_fp): its reuse survives a whole-dish 86, a reward
  // re-price and an eligibility change; different options / fee input / an expired attempt take the CURRENT path.
  {
    const rdV = { type: 'points_ala_carte', items: [{ id: 'noodle_01_pollo', qty: 1, name: 'Pad Thai - Pollo' }] };
    const c1 = await send('la_musa', 'apg_bd_C', 'online', PAID, { redeem: rdV });
    assert.ok(c1.status === 200 && c1.json.checkout_url, `setup: a bound choice-reward checkout — ${c1.text.slice(0, 200)}`);
    assert.match(String((await order('apg_bd_C')).charge_inputs_fp), /^[0-9a-f]{64}$/, 'render ON binds the charge-input fingerprint at issuance');
    const urlC = c1.json.checkout_url;
    const heldC = await reservedNow();
    /* WHICH PATH ANSWERED, observed rather than inferred: the bound fast path writes NOTHING, while the current path's
       unblocked branch always writes its rate-limit bookkeeping (send() clears rate_limits first). A same-URL answer is
       not enough on its own — the current path's pricing / eligibility reads sit behind a 45 s pointer cache and could
       also reuse — so every cell below asserts the footprint too. */
    const footprint = async () => (await rtdb.ref('rate_limits').get()).val();
    const sameUrl = async (label) => {
      const r = await send('la_musa', 'apg_bd_C', 'online', PAID, { redeem: rdV });
      assert.deepStrictEqual([r.status, r.json && r.json.checkout_url], [200, urlC], `🔴 ${label}: the bound checkout is resumed (same URL) — ${r.text.slice(0, 200)}`);
      assert.strictEqual(await footprint(), null, `🔴 ${label}: answered by the BOUND fast path (no write at all)`);
      assert.strictEqual(await reservedNow(), heldC, `${label}: no second hold`);
    };
    await sameUrl('an untouched resume');
    for (const k of ['noodle_01', 'noodle_01_pollo']) await rtdb.ref(`restaurants/la_musa/item_availability/${availKey(k)}`).set({ available: false });
    await sameUrl('whole dish + the choice 86\'d after issuance');
    for (const k of ['noodle_01', 'noodle_01_pollo']) await rtdb.ref(`restaurants/la_musa/item_availability/${availKey(k)}`).remove();
    const lm = canonicalize(buildSourceFromCode('la_musa'));
    const repriced = JSON.parse(JSON.stringify(lm)); const pi = repriced.items.find((i) => i.key === 'noodle_01_pollo'); pi.price = 352; pi.display.price = 352;
    await publishSource('la_musa', repriced);
    await sameUrl('the reward re-priced after issuance');
    const inel = JSON.parse(JSON.stringify(repriced)); inel.structure.redeem_eligible_cats = inel.structure.redeem_eligible_cats.filter((c) => c !== 'noodles');
    await publishSource('la_musa', inel);
    await sameUrl('the reward made INELIGIBLE after issuance');
    // different options on a line / a different fee input → not the bound inputs → the CURRENT path answers (footprint)
    const ext = await send('la_musa', 'apg_bd_C', 'online', [{ ...PAID[0], extras: [{ id: 'rice_white', qty: 1 }] }], { redeem: rdV });
    // (its total differs, so the current path's classifier refuses it as a conflict before any bookkeeping write; the fast
    // path only ever answers 200 with the bound URL, so "not that answer" is the proof here)
    assert.ok(!(ext.status === 200 && ext.json && ext.json.checkout_url === urlC), `🔴 same items + DIFFERENT options fall through — ${ext.text.slice(0, 160)}`);
    const fee = await send('la_musa', 'apg_bd_C', 'online', PAID, { redeem: rdV, order_type: 'delivery', address_detected: 'Col. X', address_details: 'casa', lat: 14.1, lng: -87.2 });
    assert.notStrictEqual(await footprint(), null, `🔴 same content + a DIFFERENT fee input falls through to the CURRENT path (its footprint) — ${fee.text.slice(0, 160)}`);
    // an EXPIRED identical checkout → the current path, with CURRENT enforcement (the reward choice 86'd now — a fresh read)
    const attC = (await order('apg_bd_C')).active_attempt_id;
    await rtdb.ref(`payment_attempts/${attC}/hosted_expires_at`).set(1);
    await rtdb.ref(`restaurants/la_musa/item_availability/${availKey('noodle_01_pollo')}`).set({ available: false });
    const rot = await send('la_musa', 'apg_bd_C', 'online', PAID, { redeem: rdV });
    assert.deepStrictEqual([rot.status, rot.json && rot.json.error], [409, 'reward_unavailable'], `🔴 an EXPIRED identical checkout rotates through CURRENT enforcement — ${rot.text.slice(0, 200)}`);
    assert.strictEqual((await order('apg_bd_C')).active_attempt_id, attC, 'no new attempt was issued');
    await rtdb.ref(`restaurants/la_musa/item_availability/${availKey('noodle_01_pollo')}`).remove();
    // precedence: a FRESH bare-launcher reward whose preparation FAILS (the launcher 86'd — a fresh read) answers
    // choice_required, not the preparation's own reward_unavailable
    await rtdb.ref(`restaurants/la_musa/item_availability/${availKey('noodle_01')}`).set({ available: false });
    const pre = await send('la_musa', 'apg_bd_D', 'online', PAID, { redeem: { type: 'points_ala_carte', items: [{ id: 'noodle_01', qty: 1, name: 'Pad Thai' }] } });
    assert.deepStrictEqual([pre.status, pre.json && pre.json.error], [409, 'choice_required'], `🔴 precedence: a fresh launcher reward whose preparation failed → choice_required — ${pre.text.slice(0, 200)}`);
    await rtdb.ref(`restaurants/la_musa/item_availability/${availKey('noodle_01')}`).remove();
    await publishSource('la_musa', lm);   // restore today's catalog
  }
  ok('bound reuse (render ON): a choice-reward checkout resumes its URL — answered by the bound fast path with ZERO writes and no second hold — untouched and after a whole-dish 86, a re-price and an eligibility change; different options or fee input reach the current path; an expired one rotates through current enforcement (reward_unavailable); a fresh launcher reward whose preparation fails answers choice_required');

  FINISHED = true;
  console.log(`\nadd-product-groups-intake: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('add-product-groups-intake FAILED:', e && (e.stack || e)); process.exit(1); });
