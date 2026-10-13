'use strict';
// PER-PRODUCT EXTRAS, stage 2 (intake) — end to end on the emulator through the REAL index.js handlers (PLAN rev 2.2 §4/§5).
// A version is published with REAL typed exclusions (x_pizza Margherita: deny_extras ['Salsa Roja']; la_musa rice_02:
// ['rice_white']) — the publisher writes its eligibility document — and then, mode by mode (platform_config/extras_eligibility
// in the RTDB emulator; the per-instance mode cache is 30 s, so the modes run in order with a wait between them):
//   absent  → off: a denied extra is CHARGED as today (cash, card, quote)
//   'off'   → the same
//   'shadow'→ charged as today, and the decision is LOGGED (eligibility_shadow would_refuse)
//   'enforce' → cash 409 extra_not_allowed (nothing written); card 409 before any payment attempt or checkout; quote 200
//               ok:false extra_not_allowed; an ALLOWED extra still goes through; a version WITHOUT the document → 503
//               eligibility_unavailable (retryable), never "unrestricted"
// Run: npm run test:extras-intake
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'xi-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const stub = (rel, exportsOf) => { const p = require.resolve(rel); const real = require(rel); require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: exportsOf(real) }; };
const CHARGED = [];
stub('../whatsapp', (r) => ({ ...r, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) }));
stub('../pixelpay-hosted', (r) => ({ ...r, createHostedCharge: async (q) => { CHARGED.push(q.amountLempiras); return { ok: true, url: `https://pay.test/${q.pixelpayOrderId}` }; } }));
stub('firebase-admin/auth', (r) => ({ ...r, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) }));

const app = require('../index.js');
const admin = require('firebase-admin');
const rtdb = admin.database();
const db = admin.firestore();
const { publishVersion } = require('../catalog/catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { eligibilityRefOf, _cache: eligibilityCache } = require('../catalog/extras-eligibility-store');
const { EXTRAS_BY_RESTAURANT } = require('../menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('extras-intake: FAILED — exited without completing'); process.exitCode = 1; } });

function post(handler, body) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}` }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const OPENH = { open: true, start: '00:00', end: '24:00' };
const HOURS = { sun: OPENH, mon: OPENH, tue: OPENH, wed: OPENH, thu: OPENH, fri: OPENH, sat: OPENH };
let PH = 0; const phone = () => `9955${String(PH += 1).padStart(4, '0')}`;
const clean = async () => { await rtdb.ref('rate_limits').remove(); await rtdb.ref('recent_order_content').remove(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// the brand's cart line in its own addressing (x_pizza by NAME, la_musa by ID), carrying one extra
const B = {
  x_pizza: { item: 'Margherita', denied: 'Salsa Roja', allowed: 'Pepperoni', line: (k, e) => ({ name: k, qty: 1, price: 0, extras: [{ name: e, price: EXTRAS_BY_RESTAURANT.x_pizza[e] }] }) },
  la_musa: { item: 'rice_02', denied: 'rice_white', allowed: 'sauce_aioli', line: (k, e) => ({ id: k, name: k, qty: 1, price: 0, extras: [{ id: e, qty: 1, price: EXTRAS_BY_RESTAURANT.la_musa[e] }] }) },
};
const order = (rid, oid, method, cart) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Extras Intake', customer_phone: phone(), customer_email: 'xi@example.com',
  items_text: cart.map((c) => `1x ${c.name}`).join(', '), order_type: 'pickup', payment_method: method, items: cart });
async function cash(rid, extra, tag) {
  await clean();
  const oid = `xi_${rid}_${tag}_${Date.now()}`;
  const r = await post(app.createOrder, order(rid, oid, 'cash', [B[rid].line(B[rid].item, extra)]));
  return { ...r, oid, written: (await rtdb.ref(`orders/${oid}`).get()).exists() };
}
async function card(rid, extra, tag) {
  await clean(); CHARGED.length = 0;
  const oid = `xi_${rid}_${tag}_card_${Date.now()}`;
  const r = await post(app.chargeOnlineOrder, order(rid, oid, 'online', [B[rid].line(B[rid].item, extra)]));
  const all = (await rtdb.ref('payment_attempts').get()).val() || {};
  return { ...r, oid, charged: CHARGED.length, attempts: Object.values(all).filter((a) => a && a.order_id === oid).length };
}
async function quote(rid, extra) { await clean(); return post(app.quoteOrder, { restaurant_id: rid, items: [B[rid].line(B[rid].item, extra)] }); }
async function setMode(v) {
  if (v === undefined) await rtdb.ref('platform_config/extras_eligibility').remove(); else await rtdb.ref('platform_config/extras_eligibility').set(v);
  await wait(31000);   // the per-instance mode cache (30 s)
}
async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing to wipe: Firestore is not the local emulator');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}

(async () => {
  await wipe();
  for (const rid of ['x_pizza', 'la_musa']) {
    await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
    const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'xi-seed' });
    await publishVersion(db, rid, seed.input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
    // the version under test: the brand's source WITH a typed exclusion — the publisher writes its eligibility document
    const src = buildSourceFromCode(rid);
    src.structure.exposure.item_overrides[B[rid].item] = { ...(src.structure.exposure.item_overrides[B[rid].item] || {}), deny_extras: [B[rid].denied] };
    const { inputs, built } = buildSourceCandidate(rid, src);
    const before = await getActiveVersionId(db, rid);
    await publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'xi-deny' }, { expected: { activeVersionId: before }, mirror: makeRtdbMirror(rtdb) });
    const vid = await getActiveVersionId(db, rid);
    const doc = (await eligibilityRefOf(db, rid, vid).get()).data();
    assert.ok(doc && doc.public_deny[B[rid].item].includes(B[rid].denied), `${rid}: premise — the active version's document excludes ${B[rid].denied} on ${B[rid].item}`);
    await rtdb.ref(`restaurants/${rid}/identity`).set({ name: rid, phone: '+504', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1, hours: HOURS });
  }

  // ── absent → off, then explicit off: a denied extra is charged as today ──
  for (const [label, v] of [['absent', undefined], ["'off'", 'off']]) {
    await setMode(v);
    for (const rid of ['x_pizza', 'la_musa']) {
      const c = await cash(rid, B[rid].denied, `off${PH}`);
      assert.strictEqual(c.status, 200, `${rid} ${label}: cash with a denied extra is accepted as today (${c.text.slice(0, 200)})`);
      const k = await card(rid, B[rid].denied, `off${PH}`);
      assert.ok(k.status === 200 && k.charged === 1, `${rid} ${label}: card issues its checkout as today (${k.text.slice(0, 200)})`);
      const q = await quote(rid, B[rid].denied);
      assert.ok(q.json && q.json.ok === true, `${rid} ${label}: the quote prices it as today`);
    }
    ok(`mode ${label}: a denied extra is accepted, charged and quoted exactly as today, on both brands (orders flow)`);
  }

  // ── shadow: charged as today, the decision LOGGED ──
  await setMode('shadow');
  {
    const logs = []; const orig = console.log; console.log = (...a) => { if (a[0] === 'eligibility_shadow') logs.push(JSON.parse(a[1])); orig(...a); };
    try {
      for (const rid of ['x_pizza', 'la_musa']) {
        const c = await cash(rid, B[rid].denied, `sh${PH}`);
        assert.strictEqual(c.status, 200, `${rid} shadow: still accepted`);
      }
    } finally { console.log = orig; }
    assert.ok(['x_pizza', 'la_musa'].every((rid) => logs.some((l) => l.endpoint === 'createOrder' && l.rid === rid && l.outcome === 'would_refuse')), `shadow logs would_refuse on both brands (${JSON.stringify(logs).slice(0, 300)})`);
    ok('mode shadow: accepted as today, and each decision is logged (eligibility_shadow would_refuse) on both brands');
  }

  // ── enforce ──
  await setMode('enforce');
  for (const rid of ['x_pizza', 'la_musa']) {
    const c = await cash(rid, B[rid].denied, `en${PH}`);
    assert.ok(c.status === 409 && c.json && c.json.error === 'extra_not_allowed' && !c.written, `🔴 ${rid} enforce: cash 409 extra_not_allowed, nothing written (${c.status} ${c.text.slice(0, 160)})`);
    assert.deepStrictEqual(c.json.lines, [{ item: B[rid].item, extra: B[rid].denied }], `${rid}: the refusal names the line`);
    const okc = await cash(rid, B[rid].allowed, `en${PH}`);
    assert.strictEqual(okc.status, 200, `${rid} enforce: an ALLOWED extra still goes through (${okc.text.slice(0, 160)})`);
    const k = await card(rid, B[rid].denied, `en${PH}`);
    assert.ok(k.status === 409 && k.json.error === 'extra_not_allowed' && k.charged === 0 && k.attempts === 0, `🔴 ${rid} enforce: card refused before any attempt or checkout (${k.status} charged ${k.charged} attempts ${k.attempts})`);
    const q = await quote(rid, B[rid].denied);
    assert.ok(q.status === 200 && q.json.ok === false && q.json.error === 'extra_not_allowed', `${rid} enforce: the quote refuses (no signed quote for it)`);
  }
  ok('mode enforce: a denied extra is refused at cash (409, nothing written), card (409, no attempt, no checkout) and quote; an allowed extra goes through — both brands');

  // a version WITHOUT the document (pre-feature) → retryable 503, never "unrestricted"
  {
    const rid = 'x_pizza';
    await eligibilityRefOf(db, rid, await getActiveVersionId(db, rid)).delete();
    eligibilityCache.clear();
    const c = await cash(rid, B[rid].allowed, `pre${PH}`);
    assert.ok(c.status === 503 && c.json.error === 'eligibility_unavailable' && c.json.retryable === true && !c.written, `🔴 enforce + no document → 503 eligibility_unavailable (${c.status} ${c.text.slice(0, 160)})`);
    ok('mode enforce: a version without its eligibility document → 503 eligibility_unavailable (retryable), nothing written');
  }
  FINISHED = true;
  console.log(`\nextras-intake(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('extras-intake FAILED:', e); process.exit(1); });
