'use strict';
// Portal 1D · D4-b — readers on the Firestore + RTDB EMULATORS (PLAN-D4b §A races, §E manifest, F display).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4b-readers
//
// Fixtures through the REAL writers (the D4-a recipe: publish → strip to pre-P1 → real bootstrap), then:
//   §E  menus_identity: generation from the live version, validate-all-then-write, conditional publish against a
//       CONCURRENT publisher, idempotent repeat, normalized read-back, /menus/{rid} untouched (golden), a 3rd synthetic
//       restaurant enumerated with no code change, and the READ-ONLY divergence report on a forced proxy drift.
//   §A  a different-format record appearing between an ADVISORY read and the CAS is decided by the CAS (payment and
//       reservation), on the real RTDB.
//   F   the real createOrder handler REFUSES a canonical-tagged retry it cannot verify; the real paymentStatus handler
//       renders a canonical reward as its LABEL (never a ck / canonical id).
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'd4b-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';   // la_musa fails CLOSED without it (pixelpay-return-url.js)
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
// The charge handler's two EXTERNAL edges, stubbed exactly like WhatsApp above: PixelPay's hosted-checkout HTTP call and
// the Firebase Auth token verifier. Everything between them — pricing, classify, the reservation, the CAS — is real.
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
// B1-c(4): a FAILURE-INJECTION seam on the charge handler's advisory classify — the REAL classifyHostedAttempt runs
// unless the test raises the flag, in which case it throws exactly as an RTDB read failure would.
const hc = require.resolve('../pixelpay-hosted-charge');
const realHC = require('../pixelpay-hosted-charge');
let FAIL_CLASSIFY = false;
// codex r3 S1: a RACE seam just before the CAS — a concurrent writer retagging the order between classify and acquire.
let BEFORE_ACQUIRE = null;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  classifyHostedAttempt: async (...a) => { if (FAIL_CLASSIFY) throw new Error('UNAVAILABLE (injected classify failure)'); return realHC.classifyHostedAttempt(...a); },
  acquireHostedAttempt: async (...a) => { if (BEFORE_ACQUIRE) await BEFORE_ACQUIRE(); return realHC.acquireHostedAttempt(...a); } } };
const app = require('../index.js');
const admin = require('firebase-admin');
const fs = admin.firestore();
const rtdb = admin.database();

const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { bootstrapIdentityStamps } = require('../catalog/identity-bootstrap');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { createCatalogVerifier } = require('../catalog/catalog-verifier');
const { buildIdentityManifest, publishIdentityManifests, divergenceReport, MANIFEST_PATH } = require('../catalog/identity-manifest');
const { readOnlyRtdb } = require('../tools/menus-divergence-report');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const CB = require('../catalog/canonical-binding');
const hosted = require('../pixelpay-hosted-charge');
const reserve = require('../rewards-reserve');
const { computeRedemption } = require('../rewards-redeem');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4b-readers(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const vrefOf = (rid, v) => fs.collection('restaurants').doc(rid).collection('versions').doc(v);

// ── D4-a's real-writer fixture recipe (kept in step with test/catalog-context.emulator.test.js) ───────────────
async function asPreP1(rid, versionId) {
  const vref = vrefOf(rid, versionId);
  for (const col of ['menu_items', 'extras']) {
    const snap = await vref.collection(col).get();
    await Promise.all(snap.docs.map((d) => { const display = (d.data() || {}).display; if (!display || display.identity_id === undefined) return null; const { identity_id, ...rest } = display; return d.ref.update({ display: rest }); }).filter(Boolean));   // eslint-disable-line no-unused-vars
  }
  await vref.update({ identity_activation: admin.firestore.FieldValue.delete(), identity_certified: admin.firestore.FieldValue.delete() });
}
async function seedPreP1(rid, { dataFrom = rid } = {}) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(dataFrom)));
  const { input } = buildPublishCandidate(dataFrom, { activeVersionId: null }, { source_sha: `d4b-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await vrefOf(rid, res.versionId).update({ identity_activation: admin.firestore.FieldValue.delete() });
  await backfillIdentities(fs, rid, catalogSnapshot(dataFrom), { captured: await getActivePointer(fs, rid) });
  await asPreP1(rid, res.versionId);
  return res.versionId;
}
function post(handler, body, method = 'POST', query = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/${query}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
        const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: res.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = { open: true, start: '00:00', end: '24:00' };
const identityFor = (rid) => ({ name: rid, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
  hours: { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN } });

(async () => {
  // ═══ SETUP ═══
  const xV = await seedPreP1('x_pizza');
  await seedPreP1('la_musa');
  await seedPreP1('synthetic_3', { dataFrom: 'x_pizza' });
  assert.strictEqual((await bootstrapIdentityStamps(fs, 'x_pizza')).stamped, true);
  // today's KDS manifest, published exactly as publish-menus.mjs does (extractManifest → set)
  const { extractManifest } = await import('../menu-extract.mjs');
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`menus/${rid}`).set(extractManifest(rid));
  const menusBefore = (await rtdb.ref('menus').get()).val();
  ok('fixtures: x_pizza certified, la_musa uncertified, synthetic_3 (a 3rd brand); /menus/{rid} published exactly as publish-menus.mjs does');

  // ═══ §E.2 GENERATION ═══
  const verifier = createCatalogVerifier({ db: fs });
  const gx = await buildIdentityManifest({ db: fs, rid: 'x_pizza', verifier });
  const gl = await buildIdentityManifest({ db: fs, rid: 'la_musa', verifier });
  assert.ok(gx.ok && gl.ok);
  const snapX = catalogSnapshot('x_pizza'), snapL = catalogSnapshot('la_musa');
  assert.strictEqual(gx.node.versionId, xV);
  assert.strictEqual(gx.node.rows.filter((r) => r.kind === 'dish').length, snapX.items.length, 'every dish');
  assert.strictEqual(gx.node.rows.filter((r) => r.kind === 'extra').length, snapX.extras.length, 'AND every extra');
  assert.strictEqual(gx.usableAsIdentity, true); assert.ok(gx.node.rows.every((r) => typeof r.cid === 'string' && r.cid), 'certified + confirmed → every row carries its cid');
  assert.strictEqual(gl.usableAsIdentity, false); assert.ok(gl.node.rows.every((r) => r.cid === null), 'uncertified → cid null on every row');
  const dishRow = gx.node.rows.find((r) => r.kind === 'dish');
  const src = snapX.items.find((i) => i.key === dishRow.key);
  assert.deepStrictEqual({ label: dishRow.label, category: dishRow.category }, { label: src.display.name, category: src.display.cat }, 'label + category from the LIVE version');
  ok('generation from the LIVE version (one consistent read): dishes AND extras with label/category; cid only when usable-as-identity (x_pizza yes, la_musa null)');

  // ═══ §E.3 VALIDATE-ALL-THEN-WRITE ═══
  const listAll = makeFirestoreRegistryReader(fs);
  const tampered = (await vrefOf('synthetic_3', (await getActivePointer(fs, 'synthetic_3')).version).collection('menu_items').get()).docs[0];
  const keepName = tampered.data().display.name;
  await tampered.ref.update({ 'display.name': 'edited in place' });             // synthetic_3 now fails its pinned hash
  const r0 = await publishIdentityManifests({ db: fs, rtdb, listIds: listAll, verifier });
  assert.strictEqual(r0.ok, false); assert.deepStrictEqual(r0.invalid.map((i) => i.rid), ['synthetic_3']);
  assert.strictEqual((await rtdb.ref(MANIFEST_PATH).get()).val(), null, '🔴 one invalid restaurant → NOTHING written for ANY');
  await tampered.ref.update({ 'display.name': keepName });
  ok('validate-all-then-write: one restaurant failing its pinned content hash → nothing written for any restaurant');

  // ═══ §E.3 CONDITIONAL PUBLISH vs a CONCURRENT PUBLISHER; idempotent repeat; normalized read-back ═══
  const rival = { versionId: 'rival', seq: 0, rows: [{ kind: 'dish', key: 'R', label: 'Rival', category: 'x' }] };
  const r1 = await publishIdentityManifests({ db: fs, rtdb, listIds: listAll, verifier, onBeforeWrite: async (rid) => { if (rid === 'la_musa') await rtdb.ref(`${MANIFEST_PATH}/la_musa`).set(rival); } });
  const byRid = Object.fromEntries(r1.results.map((r) => [r.rid, r.outcome]));
  assert.strictEqual(byRid.la_musa, 'conflict', 'a concurrent publisher between observe and write → our write aborts');
  assert.deepStrictEqual((await rtdb.ref(`${MANIFEST_PATH}/la_musa`).get()).val(), rival, '🔴 the other publisher\'s write survives — no lost update');
  assert.strictEqual(byRid.x_pizza, 'committed'); assert.strictEqual(byRid.synthetic_3, 'committed', 'a 3rd restaurant is enumerated and published with no code change');
  await rtdb.ref(`${MANIFEST_PATH}/la_musa`).remove();
  const r2 = await publishIdentityManifests({ db: fs, rtdb, listIds: listAll, verifier });
  assert.strictEqual(r2.ok, true); assert.strictEqual(Object.fromEntries(r2.results.map((r) => [r.rid, r.outcome])).la_musa, 'committed');
  const r3 = await publishIdentityManifests({ db: fs, rtdb, listIds: listAll, verifier });
  assert.ok(r3.results.every((r) => r.outcome === 'idempotent'), 'a repeat run writes nothing');
  const stored = (await rtdb.ref(`${MANIFEST_PATH}/la_musa`).get()).val();
  assert.ok(stored.rows.every((r) => !('cid' in r)), 'read-back is compared AFTER RTDB normalisation (a null cid is absent once stored) — and still judged equal');
  ok('conditional publish: a concurrent publisher\'s write survives (our write aborts — lost update impossible); a 3rd restaurant published with no code change; a repeat run is idempotent; read-back verified after RTDB normalisation');

  // ═══ /menus/{rid} UNTOUCHED; today's KDS never reads menus_identity ═══
  assert.deepStrictEqual((await rtdb.ref('menus').get()).val(), menusBefore, '🔴 /menus/{rid} byte-identical');
  const kdsSrc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'xpizza-kitchen', 'xpizza-delivery.js'), 'utf8')
    + require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'xpizza-kitchen', 'index.html'), 'utf8');
  assert.ok(!kdsSrc.includes(MANIFEST_PATH), 'today\'s KDS never references menus_identity');
  assert.ok(/ref\(db, `menus\/\$\{rid\}`\)/.test(kdsSrc), 'premise — the KDS subscribes to /menus/{rid}');
  ok('/menus/{rid} is byte-identical across every publication; today\'s KDS subscribes only to /menus/{rid} and never references menus_identity');

  // ═══ §E.4 the READ-ONLY divergence report ═══
  const ro = readOnlyRtdb(rtdb);
  assert.throws(() => ro.ref('menus/x_pizza').set({}), /read-only/, 'the report\'s RTDB handle refuses writes');
  const rep0 = await divergenceReport({ db: fs, rtdb: ro, listIds: listAll });
  const rep0x = rep0.find((r) => r.rid === 'x_pizza');
  assert.ok(['identical', 'diverged'].includes(rep0x.status), 'x_pizza compared');
  assert.strictEqual(rep0.find((r) => r.rid === 'synthetic_3').status, 'proxy_unpublished', 'a restaurant with no /menus node is reported, not invented');
  // force a proxy drift: one label and one missing row in the published proxy
  const drift = menusBefore.x_pizza.map((r, i) => (i === 0 ? { ...r, label: 'STALE LABEL' } : r)).slice(0, -1);
  await rtdb.ref('menus/x_pizza').set(drift);
  const dataBefore = JSON.stringify((await rtdb.ref('/').get()).val());
  const rep1 = (await divergenceReport({ db: fs, rtdb: ro, listIds: listAll })).find((r) => r.rid === 'x_pizza');
  assert.strictEqual(rep1.status, 'diverged');
  assert.ok(rep1.changed.some((c) => c.key === drift[0].key && c.proxy.label === 'STALE LABEL'), 'names the drifted label');
  assert.ok(rep1.onlyLive.includes(menusBefore.x_pizza[menusBefore.x_pizza.length - 1].key), 'names the row missing from the proxy');
  assert.strictEqual(JSON.stringify((await rtdb.ref('/').get()).val()), dataBefore, '🔴 the report wrote NOTHING');
  await rtdb.ref('menus/x_pizza').set(menusBefore.x_pizza);
  ok('divergence report (read-only handle that throws on any write): a forced proxy drift (stale label + missing row) is reported by key; the whole RTDB tree is byte-identical afterwards');

  // ═══ §A RACES on the real RTDB: decided by the CAS ═══
  {
    const ORDER = { restaurant_id: 'x_pizza', total_cents: 1000, status: 'pending_payment' };
    const LEG = 'a'.repeat(64);
    // a CANONICAL record with a different fingerprint lands BETWEEN the advisory pre-read (order absent) and the CAS
    let raced = false;
    const racy = { ref: (p) => { const r = rtdb.ref(p); return { ...r, once: async (...a) => { const s = await r.once(...a); if (!raced && p === 'orders/race1') { raced = true; await rtdb.ref('orders/race1').set({ ...ORDER, payment_fingerprint: 'c'.repeat(64), fp_format: 'canonical', active_attempt_id: 'att_other' }); } return s; }, transaction: (...a) => r.transaction(...a), update: (...a) => r.update(...a) }; } };
    const res = await hosted.acquireHostedAttempt(racy, 'race1', ORDER, LEG, Date.now(), [], () => 'att_mine', () => 'tok', () => ({ ok: true, fp: 'd'.repeat(64) }));
    assert.ok(res.outcome === 'conflict', `the CAS (not the stale advisory read) decided: ${JSON.stringify(res)}`);
    const after = (await rtdb.ref('orders/race1').get()).val();
    assert.strictEqual(after.active_attempt_id, 'att_other'); assert.strictEqual(after.payment_fingerprint, 'c'.repeat(64), '🔴 the other-format record was not overwritten');
    // a reservation created CONCURRENTLY in the other format, between our fp computation and the transaction
    const rid = 'x_pizza', uid = 'u_race';
    const red = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: 'Margherita' }, items: [{ name: 'Carnivora', qty: 1, extras: [] }], restaurantId: rid, tables: { restaurantId: rid, menu: Object.fromEntries(catalogSnapshot(rid).items.map((i) => [i.key, i.price])), extras: {} } });
    await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 1000, reserved: 0 });
    const canonRec = { state: 'reserved', cost: red.cost, fp: 'e'.repeat(64), fp_format: 'canonical', canonical: { v: 'c1' }, order_fingerprint: 'c1:zz', config_version: REDEMPTION_CONFIG_VERSION, created_at: 1, updated_at: 1, seq: 1 };
    let injected = false;
    const racyR = { ref: (p) => { const r = rtdb.ref(p); return { ...r, get: (...a) => r.get(...a), transaction: async (...a) => { if (!injected && p === `user_rewards/${uid}/${rid}`) { injected = true; await rtdb.ref(`user_rewards/${uid}/${rid}/reservations/o_race`).set(canonRec); await rtdb.ref(`user_rewards/${uid}/${rid}/reserved`).set(red.cost); } return r.transaction(...a); } }; } };
    const rr = await reserve.reserveRedemption(racyR, { uid, rid, orderId: 'o_race', cost: red.cost, canonical: red.canonical, orderFingerprint: LEG, configVersion: REDEMPTION_CONFIG_VERSION, now: 5,
      canonicalBinding: () => ({ ok: true, fp: 'f'.repeat(64) }) });
    assert.deepStrictEqual(rr, { ok: false, reason: 'reservation_conflict' }, 'the concurrently-created other-format reservation is judged IN the transaction → conflict');
    const w = (await rtdb.ref(`user_rewards/${uid}/${rid}`).get()).val();
    assert.strictEqual(w.reserved, red.cost, 'no second debit'); assert.strictEqual(w.reservations.o_race.fp_format, 'canonical', 'the record is untouched');
  }
  ok('races on the real RTDB: an other-format payment record landing between the advisory read and the CAS is decided by the CAS (no overwrite); a reservation created concurrently in the other format → reservation_conflict inside the transaction, no second debit');

  // ═══ F — the REAL createOrder handler refuses a canonical retry it cannot verify ═══
  {
    for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
    const s = catalogSnapshot('x_pizza');
    const items = [{ name: s.items[0].display.name, qty: 1, price: s.items[0].price, extras: [] }];
    const body = { restaurant_id: 'x_pizza', order_id: 'ord_canon_1', customer_name: 'T', customer_phone: '99990001', items_text: '1x X', order_type: 'pickup', payment_method: 'cash', items };
    const first = await post(app.createOrder, body);
    assert.strictEqual(first.status, 200, `premise — a fresh legacy cash order is accepted (${first.text.slice(0, 120)})`);
    const stored = (await rtdb.ref('orders/ord_canon_1').get()).val();
    assert.strictEqual(stored.fp_format, undefined, 'the D4-b writer never tags');
    const again = await post(app.createOrder, body);
    assert.strictEqual(again.status, 200, 'a legacy idempotent retry → 200 (today)');
    // the same order tagged canonical (as a D4-c writer would have left it): x_pizza's context is USABLE on this warm
    // instance, so the canonical recompute runs — and a legacy fingerprint under a canonical tag can never equal it → 409 cart
    await rtdb.ref('orders/ord_canon_1/fp_format').set('canonical');
    const canonRetry = await post(app.createOrder, body);
    assert.strictEqual(canonRetry.status, 409, `🔴 canonical tag → judged in the canonical format, never the legacy 200 (${canonRetry.text.slice(0, 160)})`);
    assert.strictEqual(canonRetry.json.reason, 'cart');
    // la_musa is UNCERTIFIED: its context is never usable-as-identity → the canonical recompute is UNVERIFIABLE → refused
    const ls = catalogSnapshot('la_musa');
    const lbody = { restaurant_id: 'la_musa', order_id: 'ord_canon_2', customer_name: 'T', customer_phone: '99990002', items_text: '1x Y', order_type: 'pickup', payment_method: 'cash',
      items: [{ id: ls.items[0].key, name: ls.items[0].display.name, cat: ls.items[0].display.cat, qty: 1, price: ls.items[0].price, extras: [] }] };
    assert.strictEqual((await post(app.createOrder, lbody)).status, 200, 'premise — a fresh la_musa cash order');
    assert.strictEqual((await post(app.createOrder, lbody)).status, 200, 'its legacy retry → 200');
    await rtdb.ref('orders/ord_canon_2/fp_format').set('canonical');
    const unv = await post(app.createOrder, lbody);
    assert.strictEqual(unv.status, 409, `🔴 canonical + unverifiable → REFUSED, never the fail-open 200 (${unv.text.slice(0, 160)})`);
    assert.strictEqual(unv.json.reason, 'cart_unverifiable');
    await rtdb.ref('orders/ord_canon_1/fp_format').set('bogus');
    const bogus = await post(app.createOrder, body);
    assert.strictEqual(bogus.status, 409); assert.strictEqual(bogus.json.reason, 'binding_format_invalid');
  }
  ok('the REAL createOrder handler: legacy retries → 200 as today; the same order tagged canonical → judged canonically (x_pizza usable → 409 cart; la_musa unusable → 409 cart_unverifiable, never the fail-open); a malformed tag → 409 binding_format_invalid');

  // ═══ F — the REAL paymentStatus handler: a canonical reward renders its LABEL, never an id ═══
  {
    const s = catalogSnapshot('x_pizza');
    const marg = s.items.find((i) => i.key === 'Margherita');
    const ver = (await getActivePointer(fs, 'x_pizza')).version;
    const stamped = (await vrefOf('x_pizza', ver).collection('menu_items').get()).docs.find((d) => d.data().key === 'Margherita').data().display.identity_id;
    assert.ok(stamped, 'premise — the certified version stamps Margherita');
    await rtdb.ref('payment_attempts/att_ps').set({ poll_token: 'ptok', hosted_state: 'paid' });
    const order = (tag) => ({ restaurant_id: 'x_pizza', status: 'new', payment_status: 'confirmed', total_cents: 1000, active_attempt_id: 'att_ps', ...(tag ? { fp_format: tag } : {}),
      redemption: { model: 'add_free', discount_cents: 0, free_item_key: tag ? CB.ck('dish', stamped) : 'Margherita' } });
    const status = async () => (await post(app.paymentStatus, null, 'GET', '?order_id=ord_ps&t=ptok')).json;
    await rtdb.ref('orders/ord_ps').set(order(null));
    const legacy = await status();
    const legacyItem = JSON.stringify(legacy).includes('"free_item":"Margherita"');
    assert.ok(legacyItem, `legacy: the stored key is shown exactly as today (${JSON.stringify(legacy).slice(0, 200)})`);
    await rtdb.ref('orders/ord_ps').set(order('canonical'));
    let canon = await status();
    for (let i = 0; i < 40 && !JSON.stringify(canon).includes(`"free_item":"${marg.display.name}"`); i += 1) { await wait(100); canon = await status(); }
    const txt = JSON.stringify(canon);
    assert.ok(txt.includes(`"free_item":"${marg.display.name}"`), `canonical: the CONTEXT LABEL is rendered (${txt.slice(0, 220)})`);
    assert.ok(!txt.includes('["c1"') && !txt.includes(stamped), '🔴 no ck string and no canonical id ever reaches the response');
    await rtdb.ref('orders/ord_ps/redemption/free_item_key').set(CB.ck('dish', 'NO-SUCH-ID'));
    const unknown = JSON.stringify(await status());
    assert.ok(unknown.includes('"free_item":null') && !unknown.includes('NO-SUCH-ID'), 'an unknown identity renders null');
  }
  ok('the REAL paymentStatus handler: legacy → the stored key as today; canonical → the current context\'s LABEL; an unknown identity → null; no ck string or canonical id in any response');

  // ═══ B1 (codex D4-b r1; advisor B1-a / B1-b) — the reservation binds the order AS SELECTED, through the REAL charge handler ═══
  {
    await rtdb.ref('config/redemption_enabled').set(true);
    const resv = async (uid, rid, oid) => (await rtdb.ref(`user_rewards/${uid}/${rid}/reservations/${oid}`).get()).val();
    const wallet = async (uid, rid) => (await rtdb.ref(`user_rewards/${uid}/${rid}`).get()).val();
    const bodyFor = (rid, oid, phone) => {
      const s = catalogSnapshot(rid);
      const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
      const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
      const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
      return { restaurant_id: rid, order_id: oid, customer_name: 'B1 Test', customer_phone: phone, customer_email: 'b1@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: 'online', items, redeem };
    };
    let phoneSeq = 0;
    // every test request comes from 127.0.0.1, so the per-IP intake limit is reset between charges (test environment only)
    const charge = async (rid, oid, uid) => (await rtdb.ref('rate_limits').remove(), post(app.chargeOnlineOrder, bodyFor(rid, oid, `9988${String(phoneSeq += 1).padStart(4, '0')}`), 'POST', '', { 'x-firebase-id-token': uid }));
    // a canonical order needs this instance's context USABLE: until it is, the request is REFUSED before any write (B1-b).
    // After a certification the request side rediscovers the new revision within one CONTEXT_RECORD_TTL_MS (45 s) UNDER
    // CONTINUOUS TRAFFIC (ERRATA E4) — so this keeps traffic flowing for up to one TTL + margin.
    const chargeCanonical = async (rid, oid, uid) => {
      let r; const t0 = Date.now();
      while (Date.now() - t0 < 60000) { r = await charge(rid, oid, uid); if (!(r.status === 409 && r.json && r.json.reason === 'cart_unverifiable')) return r; await wait(500); }
      return r;
    };
    const canonOrder = (rid) => ({ restaurant_id: rid, status: 'pending_payment', payment_method: 'online', fp_format: 'canonical' });

    // B1-b FIRST, while la_musa is UNCERTIFIED (never usable): a canonical order → 409 cart_unverifiable BEFORE reserve, nothing written
    await rtdb.ref('user_rewards/u_lm/la_musa').set({ balance: 100000, reserved: 0 });
    await rtdb.ref('orders/b1_lm_unv').set(canonOrder('la_musa'));
    const bookkeeping = async () => JSON.stringify({ c: (await rtdb.ref('recent_order_content').get()).val(), r: (await rtdb.ref('rate_limits').get()).val() });
    await rtdb.ref('rate_limits').remove();
    const before0 = await bookkeeping();
    const unv = await post(app.chargeOnlineOrder, bodyFor('la_musa', 'b1_lm_unv', '99887001'), 'POST', '', { 'x-firebase-id-token': 'u_lm' });
    assert.strictEqual(await bookkeeping(), before0, '🔴 B1-c(2): the NORMAL-path refusal writes NOTHING — no dedup stamp, no rate-limit token');
    assert.strictEqual(unv.status, 409, `B1-b: ${unv.text.slice(0, 160)}`); assert.strictEqual(unv.json.reason, 'cart_unverifiable');
    assert.strictEqual(await resv('u_lm', 'la_musa', 'b1_lm_unv'), null, '🔴 B1-b: no reservation written');
    assert.strictEqual((await wallet('u_lm', 'la_musa')).reserved, 0, 'no debit');
    assert.strictEqual((await rtdb.ref('orders/b1_lm_unv').get()).val().payment_fingerprint, undefined, 'no fingerprint written');
    // the DEGRADED path (classify throws): the probe decides the format; a canonical order is refused before reserve.
    // The earlier bookkeeping writes happened (today's behaviour for any post-probe refusal) — never a reservation/wallet/order write.
    await rtdb.ref('rate_limits').remove();
    const beforeD = await bookkeeping();
    FAIL_CLASSIFY = true;
    const unvD = await post(app.chargeOnlineOrder, bodyFor('la_musa', 'b1_lm_unv', '99887002'), 'POST', '', { 'x-firebase-id-token': 'u_lm' });
    FAIL_CLASSIFY = false;
    assert.strictEqual(unvD.status, 409, `B1-c(3) degraded: ${unvD.text.slice(0, 160)}`); assert.strictEqual(unvD.json.reason, 'cart_unverifiable');
    assert.notStrictEqual(await bookkeeping(), beforeD, 'premise — the degraded path did reach the bookkeeping writes (today\'s order)');
    assert.strictEqual(await resv('u_lm', 'la_musa', 'b1_lm_unv'), null, 'no reservation');
    assert.strictEqual((await wallet('u_lm', 'la_musa')).reserved, 0, 'no debit');
    assert.deepStrictEqual((await rtdb.ref('orders/b1_lm_unv').get()).val(), canonOrder('la_musa'), 'the order is untouched');
    // B1-b with a LEGACY reservation for the SAME order already present (the order was charged legacy, then left as a D4-c
    // writer would leave it: tagged canonical, no fingerprint, no attempt). The refusal must come BEFORE the reservation —
    // a fallback to the legacy fp would silently REUSE that legacy hold.
    assert.strictEqual((await charge('la_musa', 'b1_lm_unv2', 'u_lm')).status, 200, 'premise — a legacy charge for this order id');
    const heldBefore = await resv('u_lm', 'la_musa', 'b1_lm_unv2'), walletBefore = await wallet('u_lm', 'la_musa');
    await rtdb.ref('orders/b1_lm_unv2').update({ fp_format: 'canonical', payment_fingerprint: null, active_attempt_id: null });
    const unv2 = await charge('la_musa', 'b1_lm_unv2', 'u_lm');
    assert.strictEqual(unv2.status, 409, `B1-b (existing legacy hold): ${unv2.text.slice(0, 160)}`); assert.strictEqual(unv2.json.reason, 'cart_unverifiable');
    assert.deepStrictEqual(await resv('u_lm', 'la_musa', 'b1_lm_unv2'), heldBefore, '🔴 the legacy hold is untouched — never reused by a canonical order');
    assert.deepStrictEqual(await wallet('u_lm', 'la_musa'), walletBefore);
    assert.strictEqual((await rtdb.ref('orders/b1_lm_unv2').get()).val().payment_fingerprint, undefined, 'and no fingerprint was installed');
    assert.strictEqual((await bootstrapIdentityStamps(fs, 'la_musa')).stamped, true, 'now certify la_musa, so BOTH restaurants run the canonical matrix');

    for (const rid of ['x_pizza', 'la_musa']) {
      const uid = `u_b1_${rid}`;
      await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
      // legacy order / legacy reservation: today's path — untagged record, a retry REUSES it (no second debit)
      const L1 = await charge(rid, `b1_${rid}_leg`, uid);
      assert.strictEqual(L1.status, 200, `${rid} legacy charge: ${L1.text.slice(0, 160)}`);
      const lr = await resv(uid, rid, `b1_${rid}_leg`);
      assert.strictEqual(lr.fp_format, undefined, `${rid}: a legacy order's reservation is NEVER tagged`);
      assert.ok(/^[0-9a-f]{64}$/.test(lr.order_fingerprint), 'bound to the bare legacy fingerprint (today)');
      const reservedAfterLegacy = (await wallet(uid, rid)).reserved;
      assert.strictEqual((await charge(rid, `b1_${rid}_leg`, uid)).status, 200, `${rid}: legacy retry`);
      assert.strictEqual((await wallet(uid, rid)).reserved, reservedAfterLegacy, 'reused — no second debit');
      // canonical order / FRESH reservation → a CANONICAL record in the ONE shape (B1-a); a retry REUSES it
      await rtdb.ref(`orders/b1_${rid}_can`).set(canonOrder(rid));
      const C1 = await chargeCanonical(rid, `b1_${rid}_can`, uid);
      assert.strictEqual(C1.status, 200, `${rid} canonical charge: ${C1.text.slice(0, 200)}`);
      const cr = await resv(uid, rid, `b1_${rid}_can`);
      assert.strictEqual(cr.fp_format, 'canonical', `🔴 ${rid}: a canonical order's fresh reservation is a CANONICAL record`);
      assert.ok(cr.order_fingerprint.startsWith('c1:'), 'bound to the SELECTED canonical order value');
      assert.strictEqual(cr.canonical.v, 'c1'); assert.ok(CB.parseCk(cr.canonical.free_item_key || cr.canonical.items[0].free_item_key), 'the ck-substituted reward');
      const SHAPE = require('../catalog/d4b-canonical-reservation.golden.json').records[rid].record;
      assert.deepStrictEqual(Object.keys(cr).sort(), [...Object.keys(SHAPE), 'hosted_expires_at', 'attempt_id'].sort(),
        'the frozen canonical shape (catalog/d4b-canonical-reservation.golden.json) + the two ONLINE lifecycle fields (reserve-time hold expiry, attachAttempt)');
      const ord = (await rtdb.ref(`orders/b1_${rid}_can`).get()).val();
      assert.strictEqual(cr.order_fingerprint, `c1:${ord.payment_fingerprint}`, 'the order\'s installed canonical fp is exactly the value the reservation bound');
      const reservedAfterCanon = (await wallet(uid, rid)).reserved;
      assert.strictEqual((await chargeCanonical(rid, `b1_${rid}_can`, uid)).status, 200, `${rid}: canonical retry`);
      assert.strictEqual((await wallet(uid, rid)).reserved, reservedAfterCanon, 'reused — no second debit');
      assert.strictEqual((await resv(uid, rid, `b1_${rid}_can`)).fp, cr.fp);
      // MIXED (a) — codex's reproduction: the order was charged LEGACY (its own legacy hold), then left as a D4-c writer would
      // leave it (tagged canonical, no fingerprint, no attempt). A canonical request must NOT reuse that legacy hold.
      assert.strictEqual((await charge(rid, `b1_${rid}_mixA`, uid)).status, 200, `premise — ${rid}: a legacy charge of the SAME order id`);
      const heldA = await resv(uid, rid, `b1_${rid}_mixA`);
      assert.strictEqual(heldA.fp_format, undefined, 'premise — a legacy hold that WOULD match a legacy recomputation');
      await rtdb.ref(`orders/b1_${rid}_mixA`).update({ fp_format: 'canonical', payment_fingerprint: null, active_attempt_id: null });
      const mA = await chargeCanonical(rid, `b1_${rid}_mixA`, uid);
      assert.strictEqual(mA.status, 409, `🔴 ${rid}: canonical order vs legacy reservation must NOT be reused (${mA.text.slice(0, 160)})`);
      assert.strictEqual(mA.json.reason, 'reservation_conflict');
      assert.deepStrictEqual(await resv(uid, rid, `b1_${rid}_mixA`), heldA, 'the legacy hold is untouched');
      // MIXED (b) — codex r2 N3, on the SAME order id: the order is charged CANONICAL through the handler (its own canonical
      // hold), then left as a legacy order would be (tag, fingerprint and attempt removed). A legacy request must NOT reuse it.
      await rtdb.ref(`orders/b1_${rid}_mixB`).set(canonOrder(rid));
      assert.strictEqual((await chargeCanonical(rid, `b1_${rid}_mixB`, uid)).status, 200, `premise — ${rid}: a canonical charge of the SAME order id`);
      const heldB = await resv(uid, rid, `b1_${rid}_mixB`);
      assert.strictEqual(heldB.fp_format, 'canonical', 'premise — its hold is canonical');
      await rtdb.ref(`orders/b1_${rid}_mixB`).update({ fp_format: null, payment_fingerprint: null, active_attempt_id: null });
      const walletB = await wallet(uid, rid);
      const mB = await charge(rid, `b1_${rid}_mixB`, uid);
      assert.strictEqual(mB.status, 409, `🔴 ${rid}: legacy order vs canonical reservation must NOT be reused (${mB.text.slice(0, 160)})`);
      assert.strictEqual(mB.json.reason, 'reservation_conflict');
      assert.deepStrictEqual(await resv(uid, rid, `b1_${rid}_mixB`), heldB, 'the canonical hold is untouched');
      assert.deepStrictEqual(await wallet(uid, rid), walletB, 'no wallet change');

      // ── B1-c(4): classify FAILURE × {no hold, legacy hold on the SAME order id} × {legacy order, canonical order} ──
      const failing = async (oid, canonical) => { FAIL_CLASSIFY = true; try { return canonical ? await chargeCanonical(rid, oid, uid) : await charge(rid, oid, uid); } finally { FAIL_CLASSIFY = false; } };
      // (i) legacy order, no hold → today's fail-open: 200, an UNTAGGED hold, one debit, bookkeeping written
      const w0 = await wallet(uid, rid);
      const i = await failing(`b1c_${rid}_leg_nohold`, false);
      assert.strictEqual(i.status, 200, `${rid} (i): ${i.text.slice(0, 160)}`);
      const hi = await resv(uid, rid, `b1c_${rid}_leg_nohold`);
      assert.strictEqual(hi.fp_format, undefined, 'untagged');
      assert.strictEqual((await wallet(uid, rid)).reserved, w0.reserved + hi.cost, 'one debit');
      assert.ok((await rtdb.ref('recent_order_content').get()).val(), 'the dedup stamp was written (today)');
      // (ii) legacy order, legacy hold on the same id → reused, no second debit
      const w1 = await wallet(uid, rid);
      assert.strictEqual((await failing(`b1c_${rid}_leg_nohold`, false)).status, 200, `${rid} (ii)`);
      assert.deepStrictEqual(await wallet(uid, rid), w1, 'no second debit');
      // (iii) canonical order, no hold → the PROBE decides canonical: a CANONICAL hold
      await rtdb.ref(`orders/b1c_${rid}_can_nohold`).set(canonOrder(rid));
      const iii = await failing(`b1c_${rid}_can_nohold`, true);
      assert.strictEqual(iii.status, 200, `${rid} (iii): ${iii.text.slice(0, 160)}`);
      assert.strictEqual((await resv(uid, rid, `b1c_${rid}_can_nohold`)).fp_format, 'canonical', '🔴 B1-c(1): classify failed, yet the canonical order got a CANONICAL hold (the probe decided)');
      // (iv) canonical order, a LEGACY hold on the same id → conflict, hold and wallet untouched
      assert.strictEqual((await charge(rid, `b1c_${rid}_can_leghold`, uid)).status, 200, 'premise — a legacy hold for this order id');
      const hiv = await resv(uid, rid, `b1c_${rid}_can_leghold`);
      await rtdb.ref(`orders/b1c_${rid}_can_leghold`).update({ fp_format: 'canonical', payment_fingerprint: null, active_attempt_id: null });
      const w4 = await wallet(uid, rid);
      const iv = await failing(`b1c_${rid}_can_leghold`, true);
      assert.strictEqual(iv.status, 409, `🔴 ${rid} (iv): classify failed + canonical order must NOT reuse a legacy hold (${iv.text.slice(0, 160)})`);
      assert.strictEqual(iv.json.reason, 'reservation_conflict');
      assert.deepStrictEqual(await resv(uid, rid, `b1c_${rid}_can_leghold`), hiv); assert.deepStrictEqual(await wallet(uid, rid), w4);
      // a malformed tag under classify failure → refused by the probe
      await rtdb.ref(`orders/b1c_${rid}_bad`).set({ ...canonOrder(rid), fp_format: 'bogus' });
      const bad = await failing(`b1c_${rid}_bad`, false);
      assert.strictEqual(bad.status, 409); assert.strictEqual(bad.json.reason, 'binding_format_invalid');
      assert.strictEqual(await resv(uid, rid, `b1c_${rid}_bad`), null);
    }
  }
  ok('B1 through the REAL charge handler (both restaurants): legacy/legacy → untagged record, retry reused; a canonical order\'s FRESH reservation is a CANONICAL record (one shape, bound to "c1:<the order\'s installed fp>"), retry reused, no second debit; canonical order vs legacy reservation and legacy order vs canonical reservation → 409 reservation_conflict; B1-b: an uncomputable canonical fp → 409 cart_unverifiable BEFORE reserve, nothing written. B1-c: the normal-path refusal writes NO bookkeeping; with classify FAILING the order probe decides the format — legacy no-hold/legacy-hold as today, canonical no-hold → canonical hold, canonical vs legacy hold → conflict, malformed → binding_format_invalid, uncomputable → refused before reserve; mixed (b) rebuilt on the SAME order id');

  // ═══ codex r3 S2 — REQUEST-SPECIFIC no-write matrix: both restaurants × {normal, degraded classify} × {no hold, legacy hold on the
  //     SAME order id}, for an UNVERIFIABLE canonical order (a disagreeing dish_id claim makes the canonical recompute
  //     uncomputable on any context) and for a MALFORMED tag on the normal path. ═══
  {
    const { rateLimitKey } = require('../order-dedup');
    const get = async (p) => (await rtdb.ref(p).get()).val();
    const canonOrder = (rid) => ({ restaurant_id: rid, status: 'pending_payment', payment_method: 'online', fp_format: 'canonical' });
    let n4 = 0;
    const bodyX = (rid, oid, phone, claim) => {
      const s = catalogSnapshot(rid);
      const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
      const line = rid === 'x_pizza' ? { name: it.display.name, qty: 1, price: it.price, extras: [] } : { id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] };
      const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
      return { restaurant_id: rid, order_id: oid, customer_name: 'S2', customer_phone: phone, customer_email: 's2@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: 'online',
        items: [claim ? { ...line, dish_id: 'CID-DISAGREES' } : line], redeem };
    };
    const send = async (rid, oid, uid, phone, claim) => post(app.chargeOnlineOrder, bodyX(rid, oid, phone, claim), 'POST', '', { 'x-firebase-id-token': uid });
    const state = async (uid, rid, oid, phone) => ({
      content: await get(`recent_order_content/${rateLimitKey(phone)}`), phoneQuota: await get(`rate_limits/phone/${rateLimitKey(phone)}`),
      ipQuotas: await get('rate_limits/ip'), resv: await get(`user_rewards/${uid}/${rid}/reservations/${oid}`), wallet: await get(`user_rewards/${uid}/${rid}`), order: await get(`orders/${oid}`) });
    for (const rid of ['x_pizza', 'la_musa']) {
      const uid = `u_s2_${rid}`;
      await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
      for (const degraded of [false, true]) {
        for (const hold of [false, true]) {
          for (const kind of ['unverifiable', 'malformed']) {
            if (kind === 'malformed' && degraded) continue;   // the degraded malformed case is the probe's, covered in cell 10
            const oid = `s2_${rid}_${degraded ? 'deg' : 'norm'}_${hold ? 'hold' : 'nohold'}_${kind}`;
            const phone = `9977${String(n4 += 1).padStart(4, '0')}`;
            await rtdb.ref('rate_limits').remove();
            if (hold) {
              const pre = await send(rid, oid, uid, `9966${String(n4).padStart(4, '0')}`, false);   // a LEGACY hold on the SAME order id
              assert.strictEqual(pre.status, 200, `premise ${oid}: ${pre.text.slice(0, 140)}`);
              await rtdb.ref(`orders/${oid}`).update({ fp_format: kind === 'malformed' ? 'bogus' : 'canonical', payment_fingerprint: null, active_attempt_id: null });
            } else {
              await rtdb.ref(`orders/${oid}`).set({ ...canonOrder(rid), ...(kind === 'malformed' ? { fp_format: 'bogus' } : {}) });
            }
            await rtdb.ref('rate_limits').remove();
            const before = await state(uid, rid, oid, phone);
            FAIL_CLASSIFY = degraded;
            let r; try { r = await send(rid, oid, uid, phone, kind === 'unverifiable'); } finally { FAIL_CLASSIFY = false; }
            const after = await state(uid, rid, oid, phone);
            const want = kind === 'malformed' ? 'binding_format_invalid' : 'cart_unverifiable';
            assert.strictEqual(r.status, 409, `${oid}: ${r.text.slice(0, 160)}`); assert.strictEqual(r.json.reason, want, `${oid}: the TYPED reason is kept`);
            assert.deepStrictEqual(after.resv, before.resv, `🔴 ${oid}: the reservation is preserved`);
            assert.deepStrictEqual(after.wallet, before.wallet, `🔴 ${oid}: the wallet is preserved`);
            assert.deepStrictEqual(after.order, before.order, `🔴 ${oid}: the order is preserved`);
            if (!degraded) {
              assert.deepStrictEqual({ c: after.content, p: after.phoneQuota, i: after.ipQuotas }, { c: before.content, p: before.phoneQuota, i: before.ipQuotas },
                `🔴 ${oid}: the NORMAL-path refusal writes NO bookkeeping for THIS request (dedup stamp, phone quota, ip quota)`);
            } else {
              assert.ok(after.content && Object.values(after.content).some((v) => v && v.order_id === oid), `${oid}: degraded — THIS request's dedup stamp was written (today's order)`);
              assert.strictEqual(after.phoneQuota && after.phoneQuota.count, 1, `${oid}: degraded — THIS request's phone quota was taken (today's order)`);
            }
          }
        }
      }
    }
  }
  ok('S2 request-specific matrix (both restaurants): an unverifiable canonical order on the NORMAL path — with and without a legacy hold on the same order id — and a MALFORMED tag (409 binding_format_invalid, typed) write NO dedup stamp, phone or ip quota for that request; on the DEGRADED path (classify throws) the request\'s own stamp + quota are written as today, and in EVERY case the reservation, wallet and order are preserved byte-for-byte');

  // ═══ codex r3 S1 — typed-conflict PROPAGATION from acquireHostedAttempt to the client: a concurrent writer tags the order
  //     with a malformed format AFTER classify passed it as legacy and BEFORE acquire runs. acquire's ADVISORY pre-read
  //     (pixelpay-hosted-charge.js, before its transaction) is what refuses it here — so this proves the handler
  //     keeps acquire's typed reason (409 binding_format_invalid, not an untyped "different cart") and releases the
  //     fresh hold. It does NOT prove a conflict originating INSIDE acquire's transaction: cell 7 pins that only at the
  //     module level (acquireHostedAttempt called directly, outcome 'conflict' asserted, the typed reason NOT asserted),
  //     and no test drives a transaction-originated TYPED conflict through the handler. The order is never bound. ═══
  {
    const get = async (p) => (await rtdb.ref(p).get()).val();
    for (const rid of ['x_pizza', 'la_musa']) {
      const uid = `u_s1race_${rid}`, oid = `s1race_${rid}`;
      await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
      await rtdb.ref('rate_limits').remove();
      const s = catalogSnapshot(rid);
      const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
      const line = rid === 'x_pizza' ? { name: it.display.name, qty: 1, price: it.price, extras: [] } : { id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] };
      const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
      const body = { restaurant_id: rid, order_id: oid, customer_name: 'S1 Race', customer_phone: `99550${rid === 'x_pizza' ? 1 : 2}00`, customer_email: 's1@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: 'online', items: [line], redeem };
      BEFORE_ACQUIRE = async () => { await rtdb.ref(`orders/${oid}`).update({ fp_format: 'bogus' }); };
      let r; try { r = await post(app.chargeOnlineOrder, body, 'POST', '', { 'x-firebase-id-token': uid }); } finally { BEFORE_ACQUIRE = null; }
      assert.strictEqual(r.status, 409, `${rid} race: ${r.text.slice(0, 160)}`);
      assert.strictEqual(r.json.reason, 'binding_format_invalid', `🔴 ${rid}: acquire's TYPED reason is kept on the 409 (propagation)`);
      const o = await get(`orders/${oid}`);
      assert.ok(!o.payment_fingerprint && !o.active_attempt_id, `${rid}: the order was never bound`);
      const resv = await get(`user_rewards/${uid}/${rid}/reservations/${oid}`);
      assert.ok(!resv || resv.state === 'released', `${rid}: the fresh hold is released (${JSON.stringify(resv)})`);
      assert.strictEqual((await get(`user_rewards/${uid}/${rid}`)).reserved || 0, 0, `${rid}: no net debit`);
    }
  }
  ok('S1 typed-conflict PROPAGATION through the REAL charge handler (both restaurants): an order retagged with a malformed format between classify and acquire → acquire (its advisory pre-read) refuses it and the 409 keeps the TYPED reason binding_format_invalid; the order is never bound, the fresh hold is released, no net debit');

  FINISHED = true;
  console.log(`d4b-readers(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('d4b-readers(emulator) FAILED:', e); process.exit(1); });
