'use strict';
// Portal 1D · D4-b codex r3 S3 — the REAL chargeOnlineOrder's ordered DB call sequence on the LEGACY paths, frozen
// from the 717f97e handler source and compared against the current handler.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:d4b-charge-trace
//
// Both restaurants × (a) the NORMAL legacy path (a fresh charge with a reward redemption, then a retry that reuses the
// attempt) and (b) the CLASSIFY-FAILURE legacy path (classifyHostedAttempt throws as an RTDB read failure would; the
// order probe decides). Every RTDB read/write/transaction and every Firestore read/write the handler issues is
// recorded in order (op + normalised path; EVERY document of a getAll, in order; a write's sorted top-level keys; values
// are NOT recorded — they carry timestamps; see the recorder note below for what cannot be distinguished). Request-local ids (order id, uid, phone key, attempt id, poll token) are normalised.
//
// CAPTURE (base only): D4B_TRACE_CAPTURE=<file> writes the trace instead of comparing. The golden
// catalog/d4b-charge-trace.golden.json was captured by running THIS file inside a 717f97e checkout (see HANDBACK-D4b.md
// r3) and is FROZEN — never regenerate it from the current handler.
//
// Uses only modules that exist at 717f97e, and the same external stubs as test/d4b-readers.emulator.test.js.
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'd4b-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const realWhatsapp = require('../whatsapp');
const wr = require.resolve('../whatsapp');
require.cache[wr] = { id: wr, filename: wr, loaded: true, children: [], paths: [], exports: { ...realWhatsapp, isEnabledForRestaurant: async () => false, sendMessage: async () => ({ ok: true }) } };
const ph = require.resolve('../pixelpay-hosted');
const realHosted = require('../pixelpay-hosted');
require.cache[ph] = { id: ph, filename: ph, loaded: true, children: [], paths: [], exports: { ...realHosted, createHostedCharge: async (r) => ({ ok: true, url: `https://pay.test/${r.pixelpayOrderId}` }) } };
const fa = require.resolve('firebase-admin/auth');
const realAuth = require('firebase-admin/auth');
require.cache[fa] = { id: fa, filename: fa, loaded: true, children: [], paths: [], exports: { ...realAuth, getAuth: () => ({ verifyIdToken: async (t) => ({ uid: String(t), customer: true }) }) } };
const hc = require.resolve('../pixelpay-hosted-charge');
const realHC = require('../pixelpay-hosted-charge');
let FAIL_CLASSIFY = false;
require.cache[hc] = { id: hc, filename: hc, loaded: true, children: [], paths: [], exports: { ...realHC,
  classifyHostedAttempt: async (...a) => { if (FAIL_CLASSIFY) throw new Error('UNAVAILABLE (injected classify failure)'); return realHC.classifyHostedAttempt(...a); } } };
// 1D add-product B (PB-2 ruling (A)): the frozen 717f97e trace is the render-OFF path — render is PINNED off for it; the
// render-ON companion below records the same requests with it on and asserts the exact delta (test/_render-delta.js)
const RP = require('./_render-pin');
const RD = require('./_render-delta');
// §3 serialization r1 (codex): the DECLARED delta — the order-independent content key (bound to the content each request
// persisted) (the factura's item_order adds no read); test/_serial3-delta.js. The golden is NOT recaptured.
const SD = require('./_serial3-delta');
const app = require('../index.js');
const CTL = require('./_order-control-trace');
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
const { rateLimitKey } = require('../order-dedup');

const GOLDEN = path.join(__dirname, '..', 'catalog', 'd4b-charge-trace.golden.json');
const CAPTURE = process.env.D4B_TRACE_CAPTURE || '';
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('d4b-charge-trace(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// ── the recorder: patch the RTDB Reference/Query and Firestore reference/query/transaction prototypes ─────────────
let REC = null;
// R1b: every recorded call's result is tracked IN FLIGHT; a recording ends at QUIESCENCE (no call in flight and none
// recorded for 300 ms, hard cap 15 s → loud), not after a fixed sleep that a slow machine outruns — see test/_quiescence.js
const Q = require('./_quiescence').makeQuiescence();
const rel = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch (_) { return String(u); } };
function patchChain(obj, names, describe) {
  const done = new Set();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const nm of names) {
      if (done.has(nm) || !Object.prototype.hasOwnProperty.call(p, nm) || typeof p[nm] !== 'function') continue;
      done.add(nm);
      const orig = p[nm];
      p[nm] = function (...a) { if (REC) REC.push(describe(this, nm, a)); return Q.track(orig.apply(this, a), nm); };   // R1b: in-flight counted
    }
  }
}
const rtdbPath = (r) => (r && typeof r.toString === 'function' ? rel(r.toString()) : '?');
const keysOf = (v) => (v && typeof v === 'object' ? Object.keys(v).sort() : undefined);
// What an entry carries (codex r4 S3): op + path; a write ALSO carries the sorted top-level keys of its value
// (set/update/push on RTDB, set/update/create on Firestore) or, for a non-object value, its type. NOT
// distinguishable: two writes of the same path + same key set + different VALUES (values carry timestamps and are not
// recorded), and what an RTDB transaction's update function computes (opaque — only the transaction's path is recorded).
const writeShape = (v) => (v && typeof v === 'object' ? { keys: Object.keys(v).sort() } : { type: v === null ? 'null' : typeof v });
patchChain(rtdb.ref('x'), ['get', 'once', 'set', 'update', 'remove', 'transaction', 'push'], (self, nm, a) => {
  const e = { db: 'rtdb', op: nm, path: rtdbPath(self.ref || self) };
  if (nm === 'update' || nm === 'set' || (nm === 'push' && a.length)) Object.assign(e, writeShape(a[0]));
  return e;
});
const fsDescribe = (self, nm, a) => ({ db: 'fs', op: nm, path: self.path !== undefined ? self.path : (self._queryOptions ? `${self._queryOptions.parentPath.relativeName}/${self._queryOptions.collectionId}?query` : '?'),
  ...((nm === 'set' || nm === 'update' || nm === 'create' || nm === 'add') ? writeShape(a[0]) : {}) });
// EVERY document argument of a getAll, in order, with multiplicity (a trailing ReadOptions object is not a document)
const docPaths = (a) => a.filter((d) => d && typeof d === 'object' && typeof d.path === 'string' && typeof d.get === 'function').map((d) => d.path);
patchChain(fs.doc('a/b'), ['get', 'set', 'update', 'create', 'delete', 'listCollections'], fsDescribe);
patchChain(fs.collection('a').where('x', '==', 1), ['get'], fsDescribe);
patchChain(fs.collection('a'), ['get', 'add'], fsDescribe);
patchChain(fs, ['getAll', 'runTransaction'], (self, nm, a) => (nm === 'getAll' ? { db: 'fs', op: nm, paths: docPaths(a) } : { db: 'fs', op: nm, path: '' }));
let txProtoPatched = false;
const origRunTx = fs.runTransaction.bind(fs);
fs.runTransaction = (fn, opts) => origRunTx(async (tx) => {
  if (!txProtoPatched) { txProtoPatched = true; patchChain(tx, ['get', 'getAll', 'set', 'update', 'create', 'delete'], (self, nm, a) => (nm === 'getAll'
    ? { db: 'fs', op: 'tx.getAll', paths: docPaths(a) }
    : { db: 'fs', op: `tx.${nm}`, path: a[0] && a[0].path !== undefined ? a[0].path : '?', ...((nm === 'set' || nm === 'update' || nm === 'create') ? writeShape(a[1]) : {}) })); }
  return fn(tx);
}, opts);

// ── the fixtures (the D4-a real-writer recipe, as test/d4b-readers.emulator.test.js) ──────────────────────────────
const vrefOf = (rid, v) => fs.collection('restaurants').doc(rid).collection('versions').doc(v);
async function asPreP1(rid, versionId) {
  const vref = vrefOf(rid, versionId);
  for (const col of ['menu_items', 'extras']) {
    const snap = await vref.collection(col).get();
    await Promise.all(snap.docs.map((d) => { const display = (d.data() || {}).display; if (!display || display.identity_id === undefined) return null; const { identity_id, ...rest } = display; return d.ref.update({ display: rest }); }));
  }
  await vref.update({ identity_activation: admin.firestore.FieldValue.delete(), identity_certified: admin.firestore.FieldValue.delete() });
}
async function seedPreP1(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `d4b-${rid}` });
  const res = await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await vrefOf(rid, res.versionId).update({ identity_activation: admin.firestore.FieldValue.delete() });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
  await asPreP1(rid, res.versionId);
}
/* R1b: the server binds 127.0.0.1 (exclusive — see tools/loopback-listen.guard.test.js), so the socket peer is
   '127.0.0.1'; the FROZEN golden was captured on a wildcard server, whose IPv4 peer is '::ffff:127.0.0.1'. The handlers
   key their per-IP rate limit on the left-most X-Forwarded-For first (index.js clientIp), so the golden's client identity
   is pinned EXPLICITLY here instead of depending on the socket family. */
const GOLDEN_CLIENT_IP = '::ffff:127.0.0.1';
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, 'x-forwarded-for': GOLDEN_CLIENT_IP, ...headers }, body: JSON.stringify(body) });
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
function bodyFor(rid, oid, phone) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty: 1, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
  const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'Trace Test', customer_phone: phone, customer_email: 'trace@example.com', items_text: `1x ${it.display.name}`, order_type: 'pickup', payment_method: 'online', items, redeem };
}

// one handler call, recorded; request-local ids normalised AFTER the call (the attempt id / poll token are read back)
async function traced(rid, oid, uid, phone) {
  await rtdb.ref('rate_limits').remove();   // every test request is 127.0.0.1 — the per-IP limit is reset between charges (test env only)
  REC = [];
  const r = await post(app.chargeOnlineOrder, bodyFor(rid, oid, phone), { 'x-firebase-id-token': uid });
  await Q.quiescent();   // R1b: every fire-and-forget write the handler issued has SETTLED inside the recording (was a fixed wait(300))
  const calls = REC; REC = null;
  const o = (await rtdb.ref(`orders/${oid}`).get()).val() || {};
  const subs = [];
  for (const [k, v] of Object.entries(o)) if (/attempt_id$|poll_token$/.test(k) && typeof v === 'string' && v.length >= 8) subs.push([v, `<${k}>`]);
  subs.push([oid, '<oid>'], [rateLimitKey(phone), '<phoneKey>'], [uid, '<uid>']);
  // the fixture mints identity ids at random per run → each id in an identity-registry path is replaced by the row
  // that OWNS it, in whichever kind (<id:dish/Margherita>), read AFTER the call with the recorder off — so a dish id
  // probed under extra/ids still gets its stable name. An id with no owning row → <id:UNOWNED>.
  const ID_RE = /restaurants\/([^/]+)\/identity\/([^/]+)\/ids\/([^/]+)/g;
  const idName = new Map();
  for (const c of calls) for (const p of [c.path, ...(c.paths || [])]) {
    if (typeof p !== 'string') continue;
    for (const m of p.matchAll(ID_RE)) {
      const [, rid, , id] = m;
      if (idName.has(`${rid}/${id}`)) continue;
      let name = '<id:UNOWNED>';
      for (const kind of ['dish', 'extra']) {
        const d = await fs.doc(`restaurants/${rid}/identity/${kind}/ids/${id}`).get();
        if (d.exists && typeof d.data().legacy_key === 'string') { name = `<id:${kind}/${d.data().legacy_key}>`; break; }
      }
      idName.set(`${rid}/${id}`, name);
    }
  }
  const norm = (s) => subs.reduce((acc, [from, to]) => acc.split(from).join(to), String(s))
    .replace(ID_RE, (m, rid, kind, id) => `restaurants/${rid}/identity/${kind}/ids/${idName.get(`${rid}/${id}`)}`);
  // a getAll's ORDER follows the raw (random) ids, so it is recorded as: the normalised document MULTISET (sorted,
  // multiplicity kept) + whether the RAW order was ascending. Ascending + the multiset pins the exact raw sequence; any
  // other order flips the flag; an added, dropped or repeated document changes the multiset.
  const batch = (raw) => ({ paths: raw.map(norm).sort(), raw_order: raw.every((x, i) => i === 0 || raw[i - 1] <= x) ? 'ascending' : 'other', count: raw.length });
  const trace = calls.map((c) => ({ ...c, ...(c.path !== undefined ? { path: norm(c.path) } : {}), ...(c.paths ? batch(c.paths) : {}), ...(c.keys ? { keys: c.keys.map(norm) } : {}) }));
  // the answer, request-local values normalised (read only by the render-ON companion)
  const body = r.json ? JSON.parse(norm(JSON.stringify(r.json)).replace(/https:\/\/pay\.test\/[^"]+/g, '<checkout_url>')) : null;
  if (body) for (const k of ['poll_token', 'attempt_id', 'pixelpay_order_id']) if (typeof body[k] === 'string') body[k] = `<${k}>`;
  return { status: r.status, trace, body, content: SD.contentOfOrder(o) };
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) await seedPreP1(rid);
  assert.strictEqual((await bootstrapIdentityStamps(fs, 'x_pizza')).stamped, true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  await rtdb.ref('config/redemption_enabled').set(true);

  const out = {}; const CONTENT = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const uid = `u_trace_${rid}`;
    await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
    // warm-up (NOT recorded): the instance's cached reads (context, config) settle, so the recorded calls are the
    // per-request sequence rather than a cold-cache artefact.
    await rtdb.ref('rate_limits').remove();
    assert.strictEqual((await post(app.chargeOnlineOrder, bodyFor(rid, `trace_${rid}_warm`, '99330000'), { 'x-firebase-id-token': uid })).status, 200, `${rid}: warm-up`);
    // D4-c4: the switch cache is put WARM before each recorded request (not left to timing) → no switch read in these
    await CTL.controlWarm(rtdb, rid);
    const a1 = await traced(rid, `trace_${rid}_normal`, uid, '99331001');
    await CTL.controlWarm(rtdb, rid);
    const a2 = await traced(rid, `trace_${rid}_normal`, uid, '99331001');
    FAIL_CLASSIFY = true;
    await CTL.controlWarm(rtdb, rid);
    let b1; try { b1 = await traced(rid, `trace_${rid}_degraded`, uid, '99332001'); } finally { FAIL_CLASSIFY = false; }
    for (const [k, v] of [['a_normal_fresh', a1], ['a_normal_retry', a2], ['b_classify_failure_fresh', b1]]) {
      assert.strictEqual(v.status, 200, `${rid} ${k}: premise — the legacy path charges (${v.status})`);
      assert.ok(v.trace.length > 5, `${rid} ${k}: premise — the recorder saw the handler's calls`);
    }
    out[rid] = { a_normal_fresh: a1.trace, a_normal_retry: a2.trace, b_classify_failure_fresh: b1.trace };
    CONTENT[rid] = { a_normal_fresh: a1.content, a_normal_retry: a2.content, b_classify_failure_fresh: b1.content };
  }

  if (CAPTURE) {
    fsys.writeFileSync(CAPTURE, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`d4b-charge-trace(emulator): CAPTURED → ${CAPTURE}`);
  } else {
    const golden = JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
    // P-SELFUPDATE ALLOWLIST (advisor ruling R3.2): the comparison EXCLUDES exactly one call family — a GET of
    // `platform_config/client_floor/orders` (the HTTP floor's cached read) — asserted on its own: only gets, at most one
    // per request. Every other call must equal the frozen 717f97e golden (NOT recaptured) byte-for-byte.
    // D4-c4 ALLOWLIST (advisor ruling, DECISIONS 2026-10-08 — mirrors R3.2): exactly one more call family is excluded,
    // the pause switch's read (rtdb once order_control/<rid>/current), asserted on its own by _order-control-trace.js
    const isFloorRead = (e) => e.db === 'rtdb' && e.path === 'platform_config/client_floor/orders';
    // per-product extras (DECLARED, exact): the extras MODE read (platform_config/extras_eligibility) is a TTL-cached config read
    // like the floor — set aside on its own: at most ONE per request, only a read; and with the mode absent (off) the version's
    // eligibility DOCUMENT is never read
    const isExtrasModeRead = (e) => e.db === 'rtdb' && e.path === 'platform_config/extras_eligibility';
    const assertExtrasDeclared = (trace, label) => {
      const m = trace.filter(isExtrasModeRead);
      assert.ok(m.length <= 1 && m.every((e) => /^(get|once)$/.test(e.op)), `🔴 ${label}: the extras mode read is at most one plain read (${JSON.stringify(m)})`);
      assert.ok(!trace.some((e) => /\/meta\/extras_eligibility$/.test(String(e.path || ''))), `🔴 ${label}: no eligibility-document read while the mode is off`);
    };
    let S3_DELTA_SEEN = 0;
    for (const rid of Object.keys(golden)) for (const k of Object.keys(golden[rid])) {
      const floorCalls = out[rid][k].filter(isFloorRead);
      assertExtrasDeclared(out[rid][k], `${rid} ${k}`);
      assert.ok(floorCalls.every((e) => e.op === 'get'), `🔴 ${rid} ${k}: the floor path is only ever READ (got ${JSON.stringify(floorCalls)})`);
      assert.ok(floorCalls.length <= 1, `🔴 ${rid} ${k}: at most one floor read per request (cached) — got ${floorCalls.length}`);
      const rest = CTL.withoutControlRead(out[rid][k], rid, { expected: 0, label: `${rid} ${k} (switch cache warm)` });
      // codex r2 P2: every d4b case is a charge that persists its own content → DECLARED bound (never inferred from the trace)
      const s3 = (ops, content, label) => SD.compareShape(ops, [], { mode: 'bound', content, route: 'chargeOnlineOrder', label }).actual;
      assert.ok(CONTENT[rid][k], `${rid} ${k}: premise — the request persisted its order (the content-key delta is content-bound)`);
      assert.deepStrictEqual(s3(rest.filter((e) => !isFloorRead(e) && !isExtrasModeRead(e)), CONTENT[rid][k], `${rid} ${k}`), golden[rid][k], `🔴 ${rid} ${k}: the REAL handler's ordered DB call sequence differs from the frozen 717f97e trace`);
      if (JSON.stringify(rest.filter((e) => !isFloorRead(e) && !isExtrasModeRead(e))) !== JSON.stringify(golden[rid][k])) S3_DELTA_SEEN += 1;
      console.log(`  ✓ ${rid} ${k}: ${golden[rid][k].length} calls identical to 717f97e (+${floorCalls.length} allowlisted floor get)`);
    }
    assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(golden).sort());
    assert.ok(S3_DELTA_SEEN > 0, 'non-vacuity: WITHOUT the §3 declared delta at least one case differs from the golden (the content key really changed)');
    { // sensitivity: a content binding of DIFFERENT content does not map — the comparison stays RED
      const k = 'a_normal_fresh', rid = Object.keys(golden).find((r) => JSON.stringify(out[r][k]) !== JSON.stringify(golden[r][k])) || 'x_pizza';
      const rest = CTL.withoutControlRead(out[rid][k], rid, { expected: 0, label: `${rid} ${k} (sensitivity)` }).filter((e) => !isFloorRead(e) && !isExtrasModeRead(e));
      const wrong = { ...CONTENT[rid][k], itemsText: `${CONTENT[rid][k].itemsText} | 1x Otra (L1)` };
      let stillRed = false; try { stillRed = JSON.stringify(SD.compareShape(rest, golden[rid][k], { mode: 'bound', content: wrong, route: 'chargeOnlineOrder' }).actual) !== JSON.stringify(golden[rid][k]); } catch (_) { stillRed = true; }
      assert.ok(stillRed, '🔴 a corrupted (different-content) binding must leave the comparison RED');
    }
    console.log(`  ✓ §3 r1 declared delta: ${S3_DELTA_SEEN} case(s) differ only by the order-independent content key (content-bound); a wrong binding stays red`);
    // NON-VACUOUS ALLOWLIST: one more fresh request after the floor cache has EXPIRED (one TTL since any earlier read) MUST
    // carry exactly ONE floor GET, and with it removed its sequence must equal the golden's a_normal_retry (a retry: no other cache — e.g. the catalog verifier's 45 s TTL — enters its sequence).
    {
      const { FLOOR_TTL_MS } = require('../client-floor');
      await wait(FLOOR_TTL_MS + 1500);
      CTL.controlCold();   // D4-c4: the switch cache COLD too (explicitly, not by timing) → this request makes its own read
      const t = await traced('x_pizza', 'trace_x_pizza_normal', 'u_trace_x_pizza', '99331001');
      assert.strictEqual(t.status, 200, 'post-TTL request premise');
      const fl = t.trace.filter(isFloorRead);
      assert.deepStrictEqual(fl.map((e) => e.op), ['get'], `🔴 after the TTL exactly ONE floor GET is made (got ${JSON.stringify(fl)})`);
      // §0.5 position on the charge: issued before the classifier → right before its first read of the order
      const ctlOpts = { expected: 1, label: 'x_pizza post-TTL a_normal_retry (switch cache cold)',
        anchor: ({ after }) => !!after && after.db === 'rtdb' && after.op === 'once' && after.path === 'orders/<oid>' };
      const rest = CTL.withoutControlRead(t.trace, 'x_pizza', ctlOpts);
      assert.deepStrictEqual(SD.compareShape(rest.filter((e) => !isFloorRead(e) && !isExtrasModeRead(e)), [], { mode: 'bound', content: t.content, route: 'chargeOnlineOrder', label: 'post-TTL' }).actual, golden.x_pizza.a_normal_retry, '🔴 the post-TTL request, minus its floor GET and its switch read, equals the frozen golden');
      CTL.assertOtherRidRefused(t.trace, 'x_pizza', 'la_musa', ctlOpts);
      console.log(`  ✓ x_pizza post-TTL a_normal_retry: exactly 1 allowlisted floor GET + exactly 1 switch read (before the classifier's order read); the rest identical to the golden; a switch read on la_musa's path is refused`);
    }
    // ── RENDER-ON COMPANION (1D add-product B, PB-2 ruling (A)) ─────────────────────────────────────────────────────
    // Each render-ON request is compared with a render-OFF request recorded right before it in the SAME cache state (an
    // unrecorded warm-up absorbs any due TTL refresh first): ON == OFF + exactly the probe, at the probe's position.
    // The pin's sensitivity: every pair below MUST differ by its non-empty declared delta.
    console.log(`  (render capability shipped by catalog/platform-render.generated.js: ${RP.SHIPPED}; the golden cells above ran with it PINNED off)`);
    {
      const pair = async (label, offReq, onReq) => {
        await rtdb.ref('rate_limits').remove();
        const off = await RP.withRender(false, offReq);
        const on = await RP.withRender(true, onReq);
        for (const [s, v] of [['OFF', off], ['ON', on]]) assert.strictEqual(v.status, 200, `${label} (${s}): premise — charged (${v.status})`);
        assert.deepStrictEqual(on.body, off.body, `🔴 ${label}: the render-ON answer differs from the render-OFF one`);
        return { off: RD.normOps(off.trace.filter((e) => !isFloorRead(e) && !isExtrasModeRead(e))), on: RD.normOps(on.trace.filter((e) => !isFloorRead(e) && !isExtrasModeRead(e))) };
      };
      let W = 0;   // each warm-up its own phone: the duplicate-order guard keys on phone + content
      const warm = async (rid, uid, tag) => { await rtdb.ref('rate_limits').remove(); W += 1; await post(app.chargeOnlineOrder, bodyFor(rid, `trace_${rid}_warm_${tag}`, `9935${String(W).padStart(4, '0')}`), { 'x-firebase-id-token': uid }); await CTL.controlWarm(rtdb, rid); };
      const at = (rid, oid, uid, phone) => async () => { await CTL.controlWarm(rtdb, rid); return traced(rid, oid, uid, phone); };
      for (const rid of ['x_pizza', 'la_musa']) {
        const uid = `u_trace_${rid}`;
        const R = `trace_${rid}_ron_ref`; const N = `trace_${rid}_ron_new`;
        // a fresh reward charge: + the probe's order read (no order yet → null), right after the customer's check
        await warm(rid, uid, 'f');
        let p = await pair(`${rid} render-ON fresh`, at(rid, R, uid, '99361001'), at(rid, N, uid, '99362001'));
        RD.assertInserted(p.off, p.on, RD.afterUidCheck(p.off, rid), RD.PROBE_ABSENT(), `${rid} render-ON fresh`);
        // the retry of an order ISSUED with render ON: its bound charge-input fingerprint matches → the full probe answers
        // the bound reuse (the same answer as the render-OFF reuse), and the request ends there
        await warm(rid, uid, 'r');
        p = await pair(`${rid} render-ON retry (bound reuse)`, at(rid, R, uid, '99361001'), at(rid, N, uid, '99362001'));
        RD.assertShortCircuit(p.off, p.on, RD.afterUidCheck(p.off, rid), RD.PROBE_FULL(rid), `${rid} render-ON retry (bound reuse)`);
        // the retry, with render ON, of an order issued with render OFF (in flight across the flip): no bound fingerprint →
        // the probe stops at the order read and the current path runs unchanged
        await warm(rid, uid, 't');
        p = await pair(`${rid} render-ON retry of a render-OFF order`, at(rid, R, uid, '99361001'), at(rid, R, uid, '99361001'));
        RD.assertInserted(p.off, p.on, RD.afterUidCheck(p.off, rid), RD.PROBE_ABSENT(), `${rid} render-ON retry of a render-OFF order`);
        // the classify-failure fresh path: the probe reads the (absent) order and never classifies
        await warm(rid, uid, 'd');
        FAIL_CLASSIFY = true;
        try { p = await pair(`${rid} render-ON classify failure`, at(rid, `${R}_deg`, uid, '99363001'), at(rid, `${N}_deg`, uid, '99364001')); } finally { FAIL_CLASSIFY = false; }
        RD.assertInserted(p.off, p.on, RD.afterUidCheck(p.off, rid), RD.PROBE_ABSENT(), `${rid} render-ON classify failure`);
        console.log(`  ✓ ${rid} render-ON: fresh / render-OFF-order retry / classify failure = the render-OFF trace + exactly the probe's order read after the customer check; a render-ON order's retry = the render-OFF prefix + exactly the full probe, answering the render-OFF reuse's body`);
      }
    }
    console.log('d4b-charge-trace(emulator): OK');
  }
  FINISHED = true;
  process.exit(0);
})().catch((e) => { console.error('d4b-charge-trace(emulator) FAILED:', e); process.exit(1); });
