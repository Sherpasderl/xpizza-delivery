'use strict';
// PER-PRODUCT EXTRAS, stage 2 (intake) — end to end on the emulator through the REAL index.js handlers (PLAN rev 2.2 §4/§5).
// A version is published with REAL typed exclusions (x_pizza Margherita: deny_extras ['Salsa Roja']; la_musa rice_02:
// ['rice_white']) — the publisher writes its eligibility document — and then, mode by mode (platform_config/extras_eligibility
// in the RTDB emulator; the per-instance mode cache is 30 s, so the modes run in order with a wait between them):
//   absent  → off: a denied extra is CHARGED as today (cash, card, quote)
//   'off'   → the same
//   'shadow'→ charged as today, and the decision is LOGGED (eligibility_shadow would_refuse)
//   'enforce' → cash 409 extra_not_allowed (nothing written); card 409 before any payment attempt or checkout; quoteOrder and
//               quoteRedemption 409 (no signed quote); an ALLOWED extra still goes through; a version WITHOUT the document →
//               503 eligibility_unavailable + Retry-After (cash AND quote), never "unrestricted"
// codex stage-2 r1: a FORGED line (the field pricing ignores names something permissive — {name:'Salsa Roja', id:'Pepperoni'})
// is judged by the key it is CHARGED by, at all four intakes, both brands (P1-1); the shadow log carries the orders client's
// compat generation (P2-4); a reuse that DRIFTS to a fresh issuance before the acquire refuses 409 WITH the denied lines
// (P2-5); a bound reuse under enforce is never re-judged.
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
// the acquisition race (order-control's recipe): the REAL classification, then the state drifts before the acquire — keyed on
// the CALL SITE (the bound-reuse probe calls the same classifier first), never on a call count
let DRIFT = null;
const classifySite = (stack) => (/[\\/]catalog[\\/]bound-reuse\.js:/.test(stack) ? 'bound-reuse' : 'gate');
stub('../pixelpay-hosted-charge', (r) => ({ ...r, classifyHostedAttempt: async (...a) => { const site = classifySite(new Error().stack); const out = await r.classifyHostedAttempt(...a); if (DRIFT && site === 'gate') { const d = DRIFT; DRIFT = null; await d(); } return out; } }));

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

function post(handler, body, hdr = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...hdr }, body: JSON.stringify(body) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t, retryAfter: r.headers.get('retry-after') }));
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
// FORGED lines (codex r1 P1-1): the field pricing IGNORES names something permissive — x_pizza prices by NAME (a forged id),
// la_musa by ID (a forged name). FREE_ITEM[rid] is an item the document leaves unrestricted (derived from it, not a literal).
const FREE_ITEM = {};
const forgedExtra = (rid) => { const l = B[rid].line(B[rid].item, B[rid].denied); l.extras[0] = rid === 'la_musa' ? { ...l.extras[0], name: B[rid].allowed } : { ...l.extras[0], id: B[rid].allowed }; return l; };
const forgedItem = (rid) => { const l = B[rid].line(B[rid].item, B[rid].denied); if (rid === 'la_musa') l.name = FREE_ITEM[rid]; else l.id = FREE_ITEM[rid]; return l; };
const order = (rid, oid, method, cart) => ({ restaurant_id: rid, order_id: oid, customer_name: 'Extras Intake', customer_phone: phone(), customer_email: 'xi@example.com',
  items_text: cart.map((c) => `1x ${c.name}`).join(', '), order_type: 'pickup', payment_method: method, items: cart });
async function cash(rid, extra, tag, { line = null, hdr = {} } = {}) {
  await clean();
  const oid = `xi_${rid}_${tag}_${Date.now()}`;
  const r = await post(app.createOrder, order(rid, oid, 'cash', [line || B[rid].line(B[rid].item, extra)]), hdr);
  return { ...r, oid, written: (await rtdb.ref(`orders/${oid}`).get()).exists() };
}
async function card(rid, extra, tag, { line = null, body = null } = {}) {
  await clean(); CHARGED.length = 0;
  const b = body || order(rid, `xi_${rid}_${tag}_card_${Date.now()}`, 'online', [line || B[rid].line(B[rid].item, extra)]);
  const oid = b.order_id;
  const r = await post(app.chargeOnlineOrder, b);
  const all = (await rtdb.ref('payment_attempts').get()).val() || {};
  return { ...r, oid, charged: CHARGED.length, attempts: Object.values(all).filter((a) => a && a.order_id === oid).length };
}
async function quote(rid, extra, line = null) { await clean(); return post(app.quoteOrder, { restaurant_id: rid, items: [line || B[rid].line(B[rid].item, extra)] }); }
async function quoteRed(rid, extra, line = null) { await clean(); return post(app.quoteRedemption, { restaurant_id: rid, items: [line || B[rid].line(B[rid].item, extra)] }, { 'x-firebase-id-token': `xi_${rid}` }); }
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

const LIVE = {};
const GEN_HDR = { 'x-client-app': 'orders', 'x-client-deployment': 'orders-xi', 'x-client-build': 'xi1', 'x-client-compat': '7' };
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
    FREE_ITEM[rid] = Object.keys(doc.public_deny).find((k) => k !== B[rid].item && doc.public_deny[k].length === 0);
    assert.ok(FREE_ITEM[rid], `${rid}: premise — some item takes every extra`);
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
      const qr = await quoteRed(rid, B[rid].denied);
      assert.ok(qr.json && !['extra_not_allowed', 'eligibility_unavailable'].includes(qr.json.error), `${rid} ${label}: quoteRedemption is not refused for its extras (whatever rewards answers) (${qr.status} ${qr.text.slice(0, 160)})`);
      if (v === 'off') for (const kind of ['reuse', 'race']) {   // live checkouts carrying the denied extra, made while it was allowed
        const body = order(rid, `xi_${rid}_${kind}_${Date.now()}`, 'online', [B[rid].line(B[rid].item, B[rid].denied)]);
        const made = await card(rid, null, kind, { body });
        assert.ok(made.status === 200 && made.charged === 1, `${rid}: premise — the ${kind} checkout exists (${made.text.slice(0, 160)})`);
        LIVE[`${rid} ${kind}`] = body;
      }
    }
    ok(`mode ${label}: a denied extra is accepted, charged and quoted exactly as today, on both brands (orders flow)`);
  }

  // ── shadow: charged as today, the decision LOGGED ──
  await setMode('shadow');
  {
    const logs = []; const orig = console.log; console.log = (...a) => { if (a[0] === 'eligibility_shadow') logs.push(JSON.parse(a[1])); orig(...a); };
    try {
      for (const rid of ['x_pizza', 'la_musa']) {
        const c = await cash(rid, B[rid].denied, `sh${PH}`, { hdr: GEN_HDR });
        assert.strictEqual(c.status, 200, `${rid} shadow: still accepted`);
      }
    } finally { console.log = orig; }
    assert.ok(['x_pizza', 'la_musa'].every((rid) => logs.some((l) => l.endpoint === 'createOrder' && l.rid === rid && l.outcome === 'would_refuse')), `shadow logs would_refuse on both brands (${JSON.stringify(logs).slice(0, 300)})`);
    assert.ok(logs.filter((l) => l.endpoint === 'createOrder').every((l) => l.client_gen === 7), `🔴 the shadow record carries the orders client's compat generation (${JSON.stringify(logs).slice(0, 300)})`);
    ok('mode shadow: accepted as today, and each decision is logged (eligibility_shadow would_refuse, client_gen = the orders compat) on both brands');
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
    assert.ok(q.status === 409 && q.json.ok === false && q.json.error === 'extra_not_allowed' && !q.json.quote_token, `${rid} enforce: quoteOrder refuses 409, no signed quote (${q.status} ${q.text.slice(0, 160)})`);
    const qr = await quoteRed(rid, B[rid].denied);
    assert.ok(qr.status === 409 && qr.json.ok === false && qr.json.error === 'extra_not_allowed', `${rid} enforce: quoteRedemption refuses 409 (${qr.status} ${qr.text.slice(0, 160)})`);
  }
  ok('mode enforce: a denied extra is refused at cash (409, nothing written), card (409, no attempt, no checkout), quoteOrder and quoteRedemption (409); an allowed extra goes through — both brands');

  // FORGED id/name (codex r1 P1-1): judged by the key pricing CHARGES — all four intakes, both brands, extra AND item forgery
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [what, mk] of [['extra', forgedExtra], ['item', forgedItem]]) {
      const want = [{ item: B[rid].item, extra: B[rid].denied }];
      const c = await cash(rid, null, `fg${PH}`, { line: mk(rid) });
      assert.ok(c.status === 409 && c.json.error === 'extra_not_allowed' && !c.written, `🔴 ${rid} forged ${what}: cash refused (${c.status} ${c.text.slice(0, 160)})`);
      assert.deepStrictEqual(c.json.lines, want, `${rid} forged ${what}: named by its CHARGED keys`);
      const k = await card(rid, null, `fg${PH}`, { line: mk(rid) });
      assert.ok(k.status === 409 && k.json.error === 'extra_not_allowed' && k.charged === 0 && k.attempts === 0, `🔴 ${rid} forged ${what}: card refused before any attempt (${k.status})`);
      const q = await quote(rid, null, mk(rid));
      assert.ok(q.status === 409 && q.json.error === 'extra_not_allowed', `🔴 ${rid} forged ${what}: quoteOrder refused (${q.status})`);
      const qr = await quoteRed(rid, null, mk(rid));
      assert.ok(qr.status === 409 && qr.json.error === 'extra_not_allowed', `🔴 ${rid} forged ${what}: quoteRedemption refused (${qr.status})`);
    }
  }
  ok('forged id/name lines (a permissive name/id beside the charged key) are refused at cash, card, quoteOrder and quoteRedemption — judged by the key pricing charges, both brands');

  // MALFORMED keys (codex stage-2 r2 P1): a priced key that is an array / object / boolean / null — which pricing would COERCE
  // and charge — is refused 400 item_malformed at all four intakes, both brands, product AND extra; nothing written, no charge
  {
    const PRICED = { x_pizza: 'name', la_musa: 'id' };
    const KINDS = { array: (k) => [k], object: (k) => ({ k }), boolean: () => true, null: () => null };
    let cells = 0;
    for (const rid of ['x_pizza', 'la_musa']) for (const [kind, mk] of Object.entries(KINDS)) for (const where of ['product', 'extra']) {
      const f = PRICED[rid];
      const bad = () => { const l = B[rid].line(B[rid].item, B[rid].denied); if (where === 'product') l[f] = mk(l[f]); else l.extras[0][f] = mk(l.extras[0][f]); return l; };
      const tag = `${rid} ${where}.${f}=${kind}`;
      // an ARRAY is the coercion bypass (pricing reads ["k"] as "k"): it must be refused BY THIS CHECK. The other kinds may
      // meet pricing's own earlier 400 ("unknown menu item: [object Object]") — refused either way, nothing written or charged
      const refusedHere = (j) => j && j.error === 'item_malformed';
      const refused = (st, j) => st === 400 && (refusedHere(j) || (kind !== 'array' && j && /unknown (menu item|extra)|invalid/.test(String(j.detail || j.error || ''))));
      const c = await cash(rid, null, `mf${PH}`, { line: bad() });
      assert.ok(refused(c.status, c.json) && !c.written, `🔴 ${tag}: cash 400, nothing written (${c.status} ${c.text.slice(0, 120)})`);
      const k = await card(rid, null, `mf${PH}`, { line: bad() });
      assert.ok(refused(k.status, k.json) && k.charged === 0 && k.attempts === 0, `🔴 ${tag}: card 400, no attempt, no checkout (${k.status} ${k.text.slice(0, 120)})`);
      const q = await quote(rid, null, bad());
      assert.ok((refused(q.status, q.json) || (kind !== 'array' && q.json && q.json.ok === false && !q.json.quote_token)) && !(q.json && q.json.quote_token), `🔴 ${tag}: quoteOrder refuses, no quote (${q.status} ${q.text.slice(0, 120)})`);
      const qr = await quoteRed(rid, null, bad());
      assert.ok(refused(qr.status, qr.json) || (kind !== 'array' && qr.json && qr.json.ok === false), `🔴 ${tag}: quoteRedemption refuses (${qr.status} ${qr.text.slice(0, 120)})`);
      if (kind === 'array') for (const [nm, r] of [['cash', c], ['card', k], ['quoteOrder', q], ['quoteRedemption', qr]]) assert.strictEqual(r.json.error, 'item_malformed', `🔴 ${tag}: ${nm} refuses the array by THIS check`);
      cells++;
    }
    assert.strictEqual(cells, 16, 'premise: the whole matrix ran');
    ok('malformed keys (array / object / boolean / null on the priced product or extra key) → 400 item_malformed at cash, card, quoteOrder and quoteRedemption, both brands; nothing written, no attempt, no charge');
  }

  // a BOUND reuse is never re-judged; a reuse that DRIFTS to a fresh issuance refuses 409 WITH its lines (codex r1 P2-5)
  for (const rid of ['x_pizza', 'la_musa']) {
    const re = await card(rid, null, 'reuse', { body: LIVE[`${rid} reuse`] });
    assert.ok(re.status === 200 && re.charged === 0, `${rid} enforce: the live checkout is REUSED, not re-judged (${re.status} ${re.text.slice(0, 160)})`);
    const body = LIVE[`${rid} race`];
    DRIFT = async () => { const a = (await rtdb.ref(`orders/${body.order_id}/active_attempt_id`).get()).val(); await rtdb.ref(`payment_attempts/${a}/hosted_expires_at`).set(1); };
    let ra; try { ra = await card(rid, null, 'race', { body }); } finally { DRIFT = null; }
    assert.ok(ra.status === 409 && ra.json.error === 'extra_not_allowed' && ra.charged === 0, `🔴 ${rid} race: reuse → rotate refuses 409 before a new checkout (${ra.status} ${ra.text.slice(0, 160)})`);
    assert.deepStrictEqual(ra.json.lines, [{ item: B[rid].item, extra: B[rid].denied }], `🔴 ${rid} race: the race-mapped refusal still names the denied line`);
  }
  ok('enforce: a bound reuse is returned unjudged; a reuse that drifts to a rotation before the acquire refuses 409 extra_not_allowed WITH the denied lines — both brands');

  // a version WITHOUT the document (pre-feature) → retryable 503, never "unrestricted"
  {
    const rid = 'x_pizza';
    await eligibilityRefOf(db, rid, await getActiveVersionId(db, rid)).delete();
    eligibilityCache.clear();
    const c = await cash(rid, B[rid].allowed, `pre${PH}`);
    assert.ok(c.status === 503 && c.json.error === 'eligibility_unavailable' && c.json.retryable === true && !c.written && c.retryAfter === '2', `🔴 enforce + no document → 503 eligibility_unavailable + Retry-After (${c.status} ${c.retryAfter} ${c.text.slice(0, 160)})`);
    const q = await quote(rid, B[rid].allowed);
    assert.ok(q.status === 503 && q.json.error === 'eligibility_unavailable' && q.retryAfter === '2', `🔴 quoteOrder: 503 + Retry-After, not a 200 (${q.status} ${q.retryAfter})`);
    ok('mode enforce: a version without its eligibility document → 503 eligibility_unavailable + Retry-After at cash and quoteOrder, nothing written');
  }
  FINISHED = true;
  console.log(`\nextras-intake(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('extras-intake FAILED:', e); process.exit(1); });
