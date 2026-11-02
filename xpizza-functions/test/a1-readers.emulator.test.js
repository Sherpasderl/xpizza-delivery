'use strict';
// PLAN-A A-1 (A8a step 1) — the text-version READERS through the REAL handlers on the RTDB + Firestore emulators.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:a1-readers
//
// Every 'a8' artifact is made by the REAL writers: the request write mode (catalog/text-version.js WRITE_MODE, hard-wired
// 'legacy' in A-1) is switched to 'a8' for the setup request only — exactly what A-4's flag will do — and back to 'legacy'
// (= a rollback to A-1) before the request under test. Both restaurants, cash (createOrder) and card (chargeOnlineOrder),
// a redeemed cart whose paid text is LONGER than int10's 1500-char bound (the only case where the two candidates differ).
//   1. ROLLBACK FLOOR: an order + reservation written in 'a8' → A-1 retries it idempotently (no second debit); a cart that
//      differs ONLY past char 1500 (the legacy candidate WOULD match) → refused as a different cart.
//   2. RETAINED 'a8' RESERVATION (the order write failed after the 'a8' reserve): A-1 re-places the order IN the
//      reservation's binding — marker 'a8', the untruncated text, the order fp == the reservation's order binding — and
//      (Q4 c) the card path's content keys / reward provenance / content stamp are recomputed over the a8 text.
//   3. MALFORMED markers (order or reservation) → 409 binding_format_invalid, nothing debited.
//   4. EVERY EDGE keeps the provenance: confirm/materialize, claim, cancel, manual resolve, scheduled release — each the REAL
//      writer — leave the marker beside an unchanged fingerprint; a client-sent marker is ignored.
//   5. Q4 GOLDEN — the LEGACY differential: with no 'a8' artifact, the SAME requests through the BASE (c83f2f9) handlers
//      (compiled in memory from git, the A-1-changed modules wired base→base) and today's handlers leave identical
//      responses and identical RTDB changes (request-local tokens and timestamps normalised).
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'a1-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
process.env.OTP_SALT = process.env.OTP_SALT || 'a'.repeat(40);   // otp-lib fails closed at require without a >=32-char salt (a TEST value, as claim-order.emulator does)
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
// a one-shot failure seam on the card CAS (the "order write failed after the reserve" setup) — the real function otherwise
const hc = require.resolve('../pixelpay-hosted-charge');
const realHC = require('../pixelpay-hosted-charge');
let FAIL_ACQUIRE = false;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  acquireHostedAttempt: async (...a) => { if (FAIL_ACQUIRE) { FAIL_ACQUIRE = false; throw new Error('UNAVAILABLE (injected acquire failure)'); } return realHC.acquireHostedAttempt(...a); } } };
const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const fs = admin.firestore();
const TV = require('../catalog/text-version');
const { BASE } = require('../tools/a1-inverse');
const { orderContentKey, rateLimitKey } = require('../order-dedup');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const SCHED = require('../scheduled-orders');
const T3 = require('../contract/third-brand');   // the R3 third synthetic brand (every dish key renamed — no x_pizza literal can match)
const REL = require('../scheduled-release-core');
const { confirmAndMaterialize } = require('../pixelpay-confirm');
const { buildMaterializeUpdates } = require('../materialize');
const { claimOrderCore } = require('../claim-order');
const { phoneHash } = require('../otp-lib');
const BR = require('../catalog/bound-reuse');
const { reserveRedemption } = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { cancelOrderCore } = require('../cancel-order-core');
const { resolveManualReconciliationCore } = require('../resolve-manual');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('a1-readers(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const DIR = path.join(__dirname, '..');

// ── the BASE handlers, compiled from git in memory; the A-1-changed modules resolve to their BASE twins ──
// + assign-hub.js: the brand-agnostic server removed its X_PIZZA_HUB export, which the BASE index.js reads at load (base :5582)
const BASE_FILES = ['index.js', 'createorder-classify.js', 'rewards-redeem-intake.js', 'rewards-reserve.js', 'pixelpay-hosted-charge.js', 'pixelpay-charge.js', 'catalog/canonical-binding.js', 'assign-hub.js'];
const baseMods = {};
function resolveBaseId(fromFile, id) {
  if (!id.startsWith('.')) return null;
  const rel = path.relative(DIR, path.resolve(path.dirname(path.join(DIR, fromFile)), id)).replace(/\\/g, '/');
  const f = rel.endsWith('.js') ? rel : `${rel}.js`;
  return BASE_FILES.includes(f) ? f : null;
}
function loadBase(rel) {
  if (baseMods[rel]) return baseMods[rel].exports;
  const src = execFileSync('git', ['show', `${BASE}:xpizza-functions/${rel}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 28 });
  const filename = path.join(DIR, rel);
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  const real = m.require.bind(m);
  m.require = (id) => { const b = resolveBaseId(rel, id); return b ? loadBase(b) : real(id); };
  baseMods[rel] = m;
  m._compile(src, filename);
  return m.exports;
}

// ── fixtures (the order-exists recipe) ──
async function seed(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `a1-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
}
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json({ limit: '1mb' })); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: `Rest ${rid}`, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });
let PH = 0;
const phoneFor = () => `9955${String(PH += 1).padStart(4, '0')}`;
// a redeemed cart whose paid text is 1,700+ chars: the legacy candidate sees its first 1500, the a8 candidate all of it
const TAIL = (c) => ` | nota: ${'llamar al portón '.repeat(100)}${c}`;
function bodyFor(rid, oid, method, phone, tail = 'A') {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'A1 Test', customer_phone: phone, customer_email: 'a1@example.com', items_text: `1x ${it.display.name}${TAIL(tail)}`, order_type: 'pickup', payment_method: method, items, redeem };
}
// the THIRD brand: its own published catalog; no redemption (rewards are configured per brand today), so a third brand
// can hold no 'a8' artifact — its cells prove the legacy path and that A-1 marks nothing for it
let T3_ITEM = null;
function bodyFor3(oid, method, phone, tail = 'A') {
  return { restaurant_id: T3.THIRD, order_id: oid, customer_name: 'A1 Third', customer_phone: phone, customer_email: 'a1@example.com',
    items_text: `1x ${T3_ITEM.display.name}${TAIL(tail)}`, order_type: 'pickup', payment_method: method,
    items: [{ id: T3_ITEM.key, name: T3_ITEM.display.name, qty: 1, price: T3_ITEM.price, extras: [] }] };
}
const handlers = (h) => ({ cash: h.createOrder, online: h.chargeOnlineOrder });
const send = async (h, rid, body) => { await rtdb.ref('rate_limits').remove(); return post(handlers(h)[body.payment_method], body, { 'x-firebase-id-token': `u_${rid}` }); };
const withMode = async (mode, fn) => { const prev = TV.WRITE_MODE; TV.WRITE_MODE = mode; try { return await fn(); } finally { TV.WRITE_MODE = prev; } };
const resv = async (rid, oid) => (await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${oid}`).get()).val();
const wallet = async (rid) => (await rtdb.ref(`user_rewards/u_${rid}/${rid}`).get()).val();
const order = async (oid) => (await rtdb.ref(`orders/${oid}`).get()).val();
// fail the ONE root update that writes orders/<oid> (the cash "order write failed after the reserve" setup)
const refProto = (() => { let p = Object.getPrototypeOf(rtdb.ref('x')); while (p && !Object.prototype.hasOwnProperty.call(p, 'update')) p = Object.getPrototypeOf(p); return p; })();
const realUpdate = refProto.update;
async function failingOrderWrite(oid, fn) {
  refProto.update = function (v, ...a) { if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, `orders/${oid}`)) return Promise.reject(new Error('UNAVAILABLE (injected order write failure)')); return realUpdate.call(this, v, ...a); };
  try { return await fn(); } finally { refProto.update = realUpdate; }
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) { await seed(rid); await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid)); }
  {
    const pub = await T3.publishThirdBrand(fs, { mirror: makeRtdbMirror(rtdb) });
    assert.ok(pub.versionId && pub.source.items.every((i) => /^R3 /.test(i.key)), 'premise — the third brand published, every key renamed');
    T3_ITEM = pub.source.items[0];
    await rtdb.ref(`restaurants/${T3.THIRD}/identity`).set(identityFor(T3.THIRD));
  }
  await rtdb.ref('config/redemption_enabled').set(true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`user_rewards/u_${rid}/${rid}`).set({ balance: 100000, reserved: 0 });
  assert.strictEqual(TV.WRITE_MODE, 'legacy', 'premise — A-1 is hard-wired legacy');
  {
    const b = bodyFor('x_pizza', 'p', 'cash', '1', 'A'), b2 = bodyFor('x_pizza', 'p', 'cash', '1', 'B');
    const san = (s, max) => { const t = String(s).replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim(); return t.length > max ? t.slice(0, max) : t; };   // eslint-disable-line no-control-regex
    assert.ok(b.items_text.length > 1600, 'premise — the paid text is past the legacy bound');
    assert.strictEqual(san(b.items_text, 1500), san(b2.items_text, 1500), 'premise — the two carts are IDENTICAL to the legacy candidate');
    assert.notStrictEqual(b.items_text, b2.items_text, 'premise — and differ to the a8 candidate');
  }
  ok('fixtures: both brands seeded + identity; wallets funded; redemption on; the long carts A/B agree within 1500 chars and differ past it');

  // ═══ 1. ROLLBACK FLOOR ═══
  for (const rid of ['x_pizza', 'la_musa']) for (const method of ['cash', 'online']) {
    const oid = `a1rf_${method}_${rid}`, phone = phoneFor();
    const w0 = await wallet(rid);
    const first = await withMode('a8', () => send(app, rid, bodyFor(rid, oid, method, phone)));
    assert.strictEqual(first.status, 200, `${rid}/${method} 'a8' placement: ${first.text.slice(0, 200)}`);
    const o = await order(oid), r = await resv(rid, oid);
    assert.strictEqual(o.payment_fingerprint_text_version, 'a8', `${rid}/${method}: the order carries the marker`);
    assert.strictEqual(r.text_version, 'a8', `${rid}/${method}: the reservation carries the marker`);
    assert.ok(o.items_text.length > 1500, `${rid}/${method}: the order holds the untruncated paid text`);
    assert.ok(/^[0-9a-f]{64}$/.test(o.payment_fingerprint) && o.payment_fingerprint === r.order_fingerprint, `${rid}/${method}: the order binding == the reservation's order binding`);
    const w1 = await wallet(rid);
    assert.strictEqual(w1.reserved, w0.reserved + r.cost, 'one debit');
    // rollback to A-1 (legacy write mode): the identical retry is idempotent, no second debit
    const again = await send(app, rid, bodyFor(rid, oid, method, phone));
    assert.strictEqual(again.status, 200, `🔴 ${rid}/${method}: A-1 refused its own 'a8' order (${again.text.slice(0, 200)})`);
    assert.deepStrictEqual(await wallet(rid), w1, 'no second debit');
    assert.strictEqual((await order(oid)).payment_fingerprint, o.payment_fingerprint, 'the binding is unchanged');
    // a cart that differs ONLY past char 1500 — the legacy candidate would match — is a different cart
    const diff = await send(app, rid, bodyFor(rid, oid, method, phone, 'B'));
    assert.strictEqual(diff.status, 409, `🔴 ${rid}/${method}: an 'a8' order judged by the legacy candidate (${diff.text.slice(0, 200)})`);
    // cash: the order classifier (cart); card: the 'a8' hold refuses first (the reserve runs before the CAS) — both judged
    // by the a8 candidate, since by the legacy candidate the two carts are identical
    assert.ok(diff.json && (method === 'cash' ? ['cart'] : ['reservation_conflict', 'conflict']).includes(diff.json.reason), `${rid}/${method}: refused as a different cart (${diff.text.slice(0, 200)})`);
    assert.deepStrictEqual(await wallet(rid), w1, 'no debit on the refusal');
    assert.deepStrictEqual(await resv(rid, oid), r, 'the hold is untouched');
  }
  ok("rollback floor (both brands × cash/card): an order + hold written in 'a8' by the REAL handler → A-1 retries it idempotently (no second debit); a cart differing only past char 1500 → refused as a different cart (the legacy candidate would have matched)");

  // ═══ 2. RETAINED 'a8' RESERVATION ═══
  for (const rid of ['x_pizza', 'la_musa']) for (const method of ['cash', 'online']) {
    const oid = `a1rt_${method}_${rid}`, phone = phoneFor();
    const body = bodyFor(rid, oid, method, phone);
    const failed = await withMode('a8', () => (method === 'cash'
      ? failingOrderWrite(oid, () => send(app, rid, body))
      : (FAIL_ACQUIRE = true, send(app, rid, body))));
    FAIL_ACQUIRE = false;
    assert.notStrictEqual(failed.status, 200, `premise — ${rid}/${method}: the 'a8' attempt's order write failed (${failed.text.slice(0, 160)})`);
    assert.strictEqual(await order(oid), null, `premise — ${rid}/${method}: no order`);
    const held = await resv(rid, oid);
    assert.ok(held && held.text_version === 'a8', `premise — ${rid}/${method}: the 'a8' reservation is retained (${JSON.stringify(held)})`);
    const w0 = await wallet(rid);
    // A-1 (legacy write mode) re-places it: the order takes the RESERVATION's binding
    const r = await send(app, rid, body);
    assert.strictEqual(r.status, 200, `${rid}/${method} retained: ${r.text.slice(0, 200)}`);
    const o = await order(oid), h = await resv(rid, oid);
    assert.strictEqual(o.payment_fingerprint_text_version, 'a8', `🔴 ${rid}/${method}: the order did not take the retained 'a8' binding`);
    assert.strictEqual(o.payment_fingerprint, h.order_fingerprint, `🔴 ${rid}/${method}: the order fp is not the reservation's order binding`);
    assert.ok(o.items_text.length > 1500, 'the untruncated paid text');
    assert.strictEqual(h.text_version, 'a8', 'the reservation keeps its marker');
    assert.strictEqual((await wallet(rid)).reserved - w0.reserved, held.state === 'released' ? h.cost : 0, held.state === 'released' ? 're-reserved: one debit' : 'reused: no second debit');
    if (method === 'online') {
      // Q4 (c): the card path's content keys, reward provenance and content stamp are recomputed over the a8 text
      const ck = orderContentKey({ phone: body.customer_phone, itemsText: o.items_text, orderType: 'pickup', scheduledFor: null });
      const stamp = (await rtdb.ref(`recent_order_content/${rateLimitKey(body.customer_phone)}/${ck}`).get()).val();
      assert.ok(stamp && stamp.order_id === oid, `🔴 ${rid}: no content stamp over the a8 text (${JSON.stringify(stamp)})`);
      if (o.reward_text_appended) assert.ok(o.items_text.endsWith(o.reward_text_appended), `${rid}: the reward provenance is the a8 text's suffix`);
    }
    // and the retry of THAT order is judged by the a8 candidate
    const diff = await send(app, rid, bodyFor(rid, oid, method, phone, 'B'));
    assert.strictEqual(diff.status, 409, `🔴 ${rid}/${method}: the re-placed order judged by the legacy candidate (${diff.text.slice(0, 160)})`);
  }
  ok("retained 'a8' reservation (both brands × cash/card; the 'a8' attempt's order write failed): A-1 re-places the order IN the reservation's binding — marker 'a8', the untruncated text, order fp == the reservation's order binding — the card's content stamp is recomputed over the a8 text (Q4 c); the re-placed order is judged by its a8 candidate");

  // ═══ 3. MALFORMED MARKERS ═══
  for (const rid of ['x_pizza', 'la_musa']) for (const method of ['cash', 'online']) {
    const phone = phoneFor();
    // (a) a malformed ORDER marker on an existing order
    const oidA = `a1mo_${method}_${rid}`;
    assert.strictEqual((await send(app, rid, bodyFor(rid, oidA, method, phone))).status, 200, 'premise — a legacy order');
    const legacyOrder = await order(oidA);
    assert.strictEqual(legacyOrder.payment_fingerprint_text_version, undefined, '🔴 A-1 wrote a marker on a FRESH order');
    assert.strictEqual((await resv(rid, oidA)).text_version, undefined, '🔴 A-1 wrote a marker on a FRESH reservation');
    await rtdb.ref(`orders/${oidA}/payment_fingerprint_text_version`).set('bogus');
    const wA = await wallet(rid);
    const ra = await send(app, rid, bodyFor(rid, oidA, method, phone));
    assert.strictEqual(ra.status, 409, `${rid}/${method} malformed order marker: ${ra.text.slice(0, 160)}`);
    assert.strictEqual(ra.json.reason, 'binding_format_invalid');
    assert.deepStrictEqual(await wallet(rid), wA, 'nothing debited');
    // (b) a malformed RESERVATION marker on a retained hold (no order yet)
    const oidB = `a1mr_${method}_${rid}`;
    const bodyB = bodyFor(rid, oidB, method, phoneFor());
    const failed = method === 'cash' ? await failingOrderWrite(oidB, () => send(app, rid, bodyB)) : (FAIL_ACQUIRE = true, await send(app, rid, bodyB));
    FAIL_ACQUIRE = false;
    assert.notStrictEqual(failed.status, 200, 'premise — the order write failed');
    assert.ok(await resv(rid, oidB), 'premise — a retained hold');
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${oidB}/text_version`).set('A8');
    const wB = await wallet(rid);
    const rb = await send(app, rid, bodyB);
    assert.strictEqual(rb.status, 409, `${rid}/${method} malformed reservation marker: ${rb.text.slice(0, 160)}`);
    assert.strictEqual(rb.json && (rb.json.reason || rb.json.error), 'binding_format_invalid', `${rid}/${method}: ${rb.text.slice(0, 160)}`);
    assert.strictEqual(await order(oidB), null, 'no order placed');
    assert.deepStrictEqual(await wallet(rid), wB, 'nothing debited');
  }
  ok("malformed markers (both brands × cash/card): a bad order marker or a bad reservation marker → 409 binding_format_invalid, nothing placed or debited; A-1's FRESH orders and holds carry NO marker");

  // ═══ 4. EVERY EDGE keeps the provenance (the real edge writers over 'a8' orders made by the real handlers) ═══
  {
    const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
    const ALL_OPEN = identityFor('x').hours;
    const edgeDeps = { db: rtdb, restaurant: RESTAURANT, buildMaterializeUpdates, genToken: () => 'TOK', alert: async () => {}, client: { voidTransaction: async () => ({ ok: true }) },
      getIdentity: async () => ({ active: true, hours: ALL_OPEN }), sanitizeText: (x) => String(x || ''), serverTimestamp: 1,
      voidOrRefund: async () => ({ ok: true, outcome: 'voided' }) };
    const kept = async (oid, fp, label) => {
      const o = await order(oid);
      assert.ok(o, `${label}: the order exists`);
      assert.strictEqual(o.payment_fingerprint_text_version, 'a8', `🔴 ${label}: the marker was dropped (${JSON.stringify(o).slice(0, 200)})`);
      assert.strictEqual(o.payment_fingerprint, fp, `🔴 ${label}: the fingerprint changed`);
      return o;
    };
    const placedA8 = async (rid, oid, method, extra = {}) => {
      const r = await withMode('a8', () => send(app, rid, { ...bodyFor(rid, oid, method, phoneFor()), ...extra }));
      assert.strictEqual(r.status, 200, `setup ${oid}: ${r.text.slice(0, 200)}`);
      const o = await order(oid);
      assert.strictEqual(o.payment_fingerprint_text_version, 'a8', `premise — ${oid} is an 'a8' order`);
      return o;
    };
    for (const rid of ['x_pizza', 'la_musa']) {
      // card: confirm + materialize (the webhook's writer) → claim → cancel
      const oc = `a1ed_card_${rid}`;
      const p = await placedA8(rid, oc, 'online');
      const m = await confirmAndMaterialize(edgeDeps, { orderId: oc, attemptId: p.active_attempt_id, now: Date.now(), trackingToken: `TT${rid}` });
      const om = await kept(oc, p.payment_fingerprint, `${rid} confirm+materialize`);
      assert.ok(om.payment_status === 'confirmed' && om.status === 'new', `premise — materialized (${JSON.stringify(m)})`);
      // codex A-1 build r1 P2: a CLAIMABLE fixture — the real 'a8' order left unbound (a guest-held 'a8' order; A-1 can only mark a
      // member's reward order, so the binding is removed) and the claimer's profile seeded with the order's phone hash; the REAL
      // claim writer must bind it AND keep the marker beside the unchanged fingerprint
      await rtdb.ref(`orders/${oc}/customer_uid`).remove();
      await rtdb.ref(`user_profiles/u_claim_${rid}`).set({ phone_hash: phoneHash(om.customer_phone) });
      const cl = await claimOrderCore(rtdb, { uid: `u_claim_${rid}`, orderId: oc, token: null, now: Date.now() });
      assert.strictEqual(cl.status, 200, `premise — the claim writer ran and bound the order (${JSON.stringify(cl)})`);
      const oCl = await kept(oc, p.payment_fingerprint, `${rid} claim`);
      assert.strictEqual(oCl.customer_uid, `u_claim_${rid}`, `${rid}: the claim persisted`);
      const cr = await cancelOrderCore({ db: rtdb, voidOrRefund: async () => ({ ok: true, outcome: 'voided' }), alert: async () => {}, serverTimestamp: Date.now() },
        { orderId: oc, actor: 'test', reason: 'test', now: Date.now(), claimId: `claim-${oc}` });
      // a paid card cancel ends cancelled (200) or parked for a human (409 manual_review) — the edge wrote either way
      assert.ok(cr.status === 200 || (cr.body && cr.body.outcome === 'manual_review'), `premise — the cancel writer ran (${JSON.stringify(cr)})`);
      await kept(oc, p.payment_fingerprint, `${rid} cancel`);
      // card: the manual-reconciliation resolve (dispatcher "materialize")
      const or = `a1ed_res_${rid}`;
      const pr = await placedA8(rid, or, 'online');
      await rtdb.ref(`orders/${or}/payment_status`).set('manual_reconciliation');   // where the reconciler parks it (staged, as superseded-capture does)
      const rr = await resolveManualReconciliationCore(edgeDeps, { orderId: or, action: 'materialize', actor: 'test', note: 'a1', now: Date.now(), claimId: `rc-${or}` });
      assert.ok(rr && rr.status === 200, `premise — resolved (${JSON.stringify(rr).slice(0, 200)})`);
      await kept(or, pr.payment_fingerprint, `${rid} manual resolve`);
      // cash, SCHEDULED: held (the hold strips the live fields) → the REAL release
      const os = `a1ed_sched_${rid}`;
      const slot = (() => { const now = Date.now(); for (let k = 2; k < 400; k += 1) { const t = Math.ceil((now + k * 15 * 60000) / (15 * 60000)) * 15 * 60000; if (SCHED.validateScheduledFor(ALL_OPEN, t, now, 'pickup').valid) return t; } throw new Error('no valid slot'); })();
      const ps = await placedA8(rid, os, 'cash', { scheduled_for: slot });
      assert.strictEqual(ps.status, 'scheduled', `premise — held (${ps.status})`);
      const rel = await REL.releaseOne({ db: rtdb, alert: async () => {}, genToken: () => `RT${rid}` }, { orderId: os, now: slot, claimId: `rel-${os}` });
      assert.ok(rel.released, `premise — released (${JSON.stringify(rel)})`);
      const ol = await kept(os, ps.payment_fingerprint, `${rid} scheduled release`);
      assert.strictEqual(ol.status, 'new', 'premise — live');
      // the released order's retry is still judged by its a8 candidate
      const b2 = { ...bodyFor(rid, os, 'cash', ol.customer_phone, 'B'), scheduled_for: slot };
      assert.notStrictEqual((await send(app, rid, b2)).status, 200, `🔴 ${rid}: the released 'a8' order accepted a past-1500 cart`);
    }
    // a client-sent marker is IGNORED: A-1 never writes one on a fresh order or hold
    for (const rid of ['x_pizza', 'la_musa']) for (const method of ['cash', 'online']) {
      const oid = `a1cm_${method}_${rid}`;
      const r = await send(app, rid, { ...bodyFor(rid, oid, method, phoneFor()), payment_fingerprint_text_version: 'a8', text_version: 'a8', fp_format: 'canonical' });
      assert.strictEqual(r.status, 200, `${rid}/${method}: ${r.text.slice(0, 160)}`);
      assert.strictEqual((await order(oid)).payment_fingerprint_text_version, undefined, `🔴 ${rid}/${method}: a client marker reached the order`);
      assert.strictEqual((await resv(rid, oid)).text_version, undefined, `🔴 ${rid}/${method}: a client marker reached the hold`);
    }
  }
  ok("every edge keeps the provenance (both brands; real writers over 'a8' orders from the real handlers): confirm+materialize, claim, cancel, manual resolve, scheduled hold → release — the marker stays beside an unchanged fingerprint, and the released order is still judged by its a8 candidate; a client-sent marker is ignored (cash + card)");

  // ═══ 4b. codex A-1 build r1 P1-1 — the BOUND-REUSE probe is provenance-aware (real writers) ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    const now = () => Date.now();
    const probe = (oid, body) => BR.probeBoundReuse(rtdb, { orderId: oid, uid: `u_${rid}`, rid, body, now: now() });
    // (a) a live 'a8' checkout (the REAL card handler in 'a8' mode) → the probe REUSES it (it returned null before)
    const oa = `a1br_a8_${rid}`, ba = bodyFor(rid, oa, 'online', phoneFor());
    const ra = await withMode('a8', () => send(app, rid, ba));
    assert.strictEqual(ra.status, 200, `setup ${oa}: ${ra.text.slice(0, 200)}`);
    const o8 = await order(oa), h8 = await resv(rid, oa), at8 = (await rtdb.ref(`payment_attempts/${o8.active_attempt_id}`).get()).val();
    assert.ok(o8.payment_fingerprint_text_version === 'a8' && h8.text_version === 'a8', 'premise — an a8 order + an a8 hold');
    const p8 = await probe(oa, ba);
    assert.ok(p8 && p8.outcome === 'reuse' && p8.checkout_url === at8.hosted_checkout_url && p8.attempt_id === o8.active_attempt_id, `🔴 ${rid}: a matching live a8 checkout was not reused (${JSON.stringify(p8)})`);
    // (b) the same order, its hold re-marked "bogus" → binding_format_invalid → never reuse
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${oa}/text_version`).set('bogus');
    assert.strictEqual(await probe(oa, ba), null, `🔴 ${rid}: an a8 order reused over a "bogus" hold`);
    // (c) codex's reproduction: an UNMARKED order (A-1's legacy write) whose matching hold is marked "bogus" → never reuse
    const ol = `a1br_lg_${rid}`, bl = bodyFor(rid, ol, 'online', phoneFor());
    const rl = await send(app, rid, bl);
    assert.strictEqual(rl.status, 200, `setup ${ol}: ${rl.text.slice(0, 200)}`);
    assert.ok(!('payment_fingerprint_text_version' in (await order(ol))) && !('text_version' in (await resv(rid, ol))), 'premise — a legacy order + a legacy hold');
    const pl = await probe(ol, bl);
    assert.ok(pl && pl.outcome === 'reuse', `premise — the legacy checkout reuses (non-vacuity: ${JSON.stringify(pl)})`);
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${ol}/text_version`).set('bogus');
    assert.strictEqual(await probe(ol, bl), null, `🔴 ${rid}: an unmarked order reused its checkout over a "bogus" hold (codex's reproduction)`);
    // (d) a VALID hold in the OTHER version than its order → never reuse
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${ol}/text_version`).set('a8');
    assert.strictEqual(await probe(ol, bl), null, `🔴 ${rid}: a legacy order reused over an a8 hold`);
  }
  ok("bound-reuse probe (both brands; real handlers): a live 'a8' checkout + its 'a8' hold → REUSED (same URL / attempt); a hold re-marked \"bogus\" → never (a8 order AND codex's unmarked-order reproduction); a valid hold in the other version → never; a legacy checkout still reuses");

  // ═══ 4c. codex A-1 build r1 P1-2 — reserve precedence: the EXISTING ORDER's marker > the reservation's > the request mode ═══
  for (const rid of ['x_pizza', 'la_musa']) {
    // codex's reproduction: an 'a8' order (the real handler) whose hold is gone (released + purged, as after a sweep), retried by
    // A-1 (legacy write mode): the reserve must NOT write an unmarked hold with a different order fingerprint, nor debit
    const oid = `a1rp_${rid}`, b = bodyFor(rid, oid, 'online', phoneFor());
    const r0 = await withMode('a8', () => send(app, rid, b));
    assert.strictEqual(r0.status, 200, `setup ${oid}: ${r0.text.slice(0, 200)}`);
    const o = await order(oid), h = await resv(rid, oid);
    assert.ok(o.payment_fingerprint_text_version === 'a8' && h.text_version === 'a8', 'premise — an a8 order + hold');
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reservations/${oid}`).remove();
    await rtdb.ref(`user_rewards/u_${rid}/${rid}/reserved`).transaction((x) => (Number(x) || 0) - h.cost);
    const w0 = await wallet(rid);
    const again = await send(app, rid, b);
    const h2 = await resv(rid, oid);
    assert.ok(!h2 || (h2.text_version === 'a8' && h2.order_fingerprint === o.payment_fingerprint), `🔴 ${rid}: the a8 order got an unmarked / differently-bound hold (${JSON.stringify(h2)})`);
    if (h2) assert.strictEqual(again.status, 200, `${rid}: re-reserved in the order's binding → the checkout resumes (${again.text.slice(0, 200)})`);
    else assert.deepStrictEqual(await wallet(rid), w0, `🔴 ${rid}: points moved without a hold`);
    // the core, directly: a mismatching existing hold → conflict, no debit; a malformed order marker → refused
    const legacyFp = 'L'.repeat(64), a8Fp = 'A'.repeat(64);
    const base = { uid: `u_${rid}`, rid, cost: h.cost, canonical: h.canonical, configVersion: REDEMPTION_CONFIG_VERSION, now: Date.now(), orderFingerprint: legacyFp, a8OrderFingerprint: a8Fp, writeMode: 'legacy' };
    const w1 = await wallet(rid);
    const fresh = await reserveRedemption(rtdb, { ...base, orderId: `${oid}_core`, orderTextVersion: 'a8' });
    assert.ok(fresh.ok && fresh.selected_text_version === 'a8', `${rid}: no hold + an a8 order → an a8 hold (the order wins over the legacy write mode): ${JSON.stringify(fresh)}`);
    const rec = await resv(rid, `${oid}_core`);
    assert.ok(rec.text_version === 'a8' && rec.order_fingerprint === a8Fp, `${rid}: bound to the a8 order fingerprint`);
    const w2 = await wallet(rid);
    const clash = await reserveRedemption(rtdb, { ...base, orderId: `${oid}_core`, orderTextVersion: 'legacy' });
    assert.ok(!clash.ok && clash.reason === 'reservation_conflict', `${rid}: an a8 hold under a legacy order → conflict (${JSON.stringify(clash)})`);
    assert.deepStrictEqual(await wallet(rid), w2, `${rid}: no debit on the conflict`);
    const bad = await reserveRedemption(rtdb, { ...base, orderId: `${oid}_bad`, orderTextVersion: 'invalid' });
    assert.ok(!bad.ok && bad.reason === 'binding_format_invalid' && !(await resv(rid, `${oid}_bad`)), `${rid}: a malformed order marker → refused, no hold`);
    const none = await reserveRedemption(rtdb, { ...base, orderId: `${oid}_none` });
    assert.ok(none.ok && !('selected_text_version' in none) && !('text_version' in (await resv(rid, `${oid}_none`))), `${rid}: no order → the request mode (legacy, unmarked) exactly as before`);
    assert.ok((await wallet(rid)).reserved === w1.reserved + 2 * h.cost, 'exactly the two successful holds debited');
  }
  ok("reserve precedence (both brands): codex's reproduction — an a8 order whose hold is gone, retried by A-1 (legacy write mode) → never an unmarked / differently-bound hold, never a debit without a hold; the core: no hold + an a8 order → an a8 hold (the order wins), an a8 hold under a legacy order → conflict with no debit, a malformed order marker → refused, no order → today's legacy path");

  // ═══ 4b. THE THIRD BRAND: even in 'a8' write mode, A-1 marks nothing it holds no 'a8' artifact for ═══
  for (const method of ['cash', 'online']) {
    const oid = `a1t3_${method}`, phone = phoneFor();
    const r = await withMode('a8', () => send(app, T3.THIRD, bodyFor3(oid, method, phone)));
    assert.strictEqual(r.status, 200, `${T3.THIRD}/${method}: ${r.text.slice(0, 200)}`);
    const o = await order(oid);
    assert.strictEqual(o.restaurant_id, T3.THIRD);
    assert.strictEqual(o.payment_fingerprint_text_version, undefined, `🔴 ${T3.THIRD}/${method}: a marker without an 'a8' artifact`);
    assert.ok(o.items_text.length <= 1500, `${T3.THIRD}/${method}: the legacy (int10) paid text`);
    assert.strictEqual((await send(app, T3.THIRD, bodyFor3(oid, method, phone))).status, 200, `${T3.THIRD}/${method}: idempotent retry`);
    await rtdb.ref(`orders/${oid}/payment_fingerprint_text_version`).set('bogus');
    const bad = await send(app, T3.THIRD, bodyFor3(oid, method, phone));
    assert.deepStrictEqual([bad.status, bad.json && bad.json.reason], [409, 'binding_format_invalid'], `${T3.THIRD}/${method}: a malformed marker refuses for any brand`);
  }
  ok(`the third brand ${T3.THIRD} (own catalog, every key renamed; cash + card): A-1 writes no marker without an 'a8' artifact even in 'a8' mode, keeps int10's text, retries idempotently, and refuses a malformed marker exactly as for the two brands`);

  // ═══ 5. Q4 GOLDEN — the legacy differential vs the BASE handlers ═══
  {
    const base = loadBase('index.js');
    assert.notStrictEqual(base.createOrder, app.createOrder, 'premise — distinct handler instances');
    const leaves = (v, pre = '', out = new Map()) => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) leaves(v[k], pre ? `${pre}/${k}` : k, out); } else out.set(pre, v); return out; };
    const snapshot = async () => (await rtdb.ref().get()).val() || {};
    const normalised = (before, after, resp) => {
      const b = leaves(before), a = leaves(after);
      const toks = new Set();
      for (const [k, v] of a) if (/(attempt_id|poll_token|tracking_token|claim_id)$/.test(k) && typeof v === 'string') toks.add(v);
      for (const k of a.keys()) { const m = k.match(/^(?:payment_attempts|order_tracking)\/([^/]+)/); if (m) toks.add(m[1]); }
      const norm = (s) => { let x = String(s); for (const t of toks) x = x.split(t).join('<tok>'); return x.replace(/https:\/\/pay\.test\/[^"\s]+/g, '<url>').replace(/\/-[A-Za-z0-9_-]{19}/g, '/<push>'); };
      const val = (k, v) => (typeof v === 'number' && v > 1.6e12 && v < 4e12 ? '<t>' : /(_at|timestamp|expires)$/.test(k) && typeof v === 'string' ? '<t>' : norm(v));
      const changed = {};
      for (const k of new Set([...b.keys(), ...a.keys()])) if (b.get(k) !== a.get(k)) changed[norm(k)] = a.has(k) ? val(k, a.get(k)) : '<deleted>';
      return { status: resp.status, body: JSON.parse(norm(JSON.stringify(resp.json || null)).replace(/"(?:[a-z_]*_at|timestamp)":\d+/g, '"t":0')), changed };
    };
    for (const rid of ['x_pizza', 'la_musa', T3.THIRD]) for (const method of ['cash', 'online']) {
      const oid = `a1dq_${method}_${rid}`, phone = phoneFor();
      const mk = (tail) => (rid === T3.THIRD ? bodyFor3(oid, method, phone, tail) : bodyFor(rid, oid, method, phone, tail));
      const S0 = await snapshot();
      const runAll = async (h) => {
        const out = [];
        for (const tail of ['A', 'A', 'B']) {           // a fresh placement, its idempotent retry, a different cart
          const before = await snapshot();
          const r = await send(h, rid, mk(tail));
          await new Promise((res) => setTimeout(res, 400));   // fire-and-forget writes settle
          out.push(normalised(before, await snapshot(), r));
        }
        return out;
      };
      const mine = await runAll(app);
      await rtdb.ref().set(S0);
      const theirs = await runAll(base);
      await rtdb.ref().set(S0);
      assert.strictEqual(mine[0].status, 200, `premise — ${rid}/${method}: placed (${JSON.stringify(mine[0].body).slice(0, 160)})`);
      assert.ok(Object.keys(mine[0].changed).some((k) => k.startsWith(`orders/${oid}/`)), 'premise — the order was written');
      for (let i = 0; i < mine.length; i += 1) assert.deepStrictEqual(mine[i], theirs[i], `🔴 ${rid}/${method} step ${i}: today's handler differs from ${BASE}`);
      assert.strictEqual(mine[2].status, 200, `${rid}/${method}: a LEGACY order with a cart differing only past char 1500 → idempotent, exactly as ${BASE} (int10 truncation)`);
    }
    ok(`Q4 golden — legacy differential (x_pizza, la_musa AND the third brand ${T3.THIRD} × cash/card × place / retry / past-1500 cart): today's handlers and the ${BASE} handlers leave identical responses and identical RTDB changes`);
  }

  FINISHED = true;
  console.log(`\na1-readers(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('a1-readers(emulator): FAILED', e); process.exit(1); });
