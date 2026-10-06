'use strict';
// P-SELFUPDATE (advisor ruling R3.3; codex CP1 S4) — the REAL quoteOrder's and quoteRedemption's ordered DB call
// sequences with the floor OFF, frozen from the ba29282 handler source and compared against the current handlers.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:pselfupdate-quote-trace
//
// Both restaurants × (a) quoteOrder (a plain cart), (b) quoteRedemption (a verified customer + a reward). Recorder,
// normalisation and fixtures are the d4b-charge-trace / createOrder-trace recipe.
//
// ALLOWLIST (advisor ruling R3.2): the comparison EXCLUDES exactly one call family — a GET of
// `platform_config/client_floor/orders` (the HTTP floor's cached read). It is asserted separately: only gets, at most one
// per request. Every other call must equal the frozen golden byte-for-byte. A header-less request writes NOTHING for
// telemetry (ruling R3.1: header-less counting is a log line, not a database write).
//
// CAPTURE (base only): PSU_TRACE_CAPTURE=<file>. The golden catalog/pselfupdate-quote-trace.golden.json was captured
// by running THIS file inside a ba29282 checkout and is FROZEN. (The golden file name: pselfupdate-quote-trace.golden.json.)
require('./_emulator-required')('database', 'firestore');
// A CONTROLLED CLOCK (codex CP1 r2 S4), installed BEFORE index.js loads so every per-instance cache captures it — incl.
// the catalog verifier's 60 s observation. Advancing it makes the REFRESH path deterministic instead of time-of-day luck.
const REAL_NOW = Date.now.bind(Date);
let CLOCK_OFFSET = 0;
Date.now = () => REAL_NOW() + CLOCK_OFFSET;

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
const { rateLimitKey } = require('../order-dedup');

const GOLDEN = path.join(__dirname, '..', 'catalog', 'pselfupdate-quote-trace.golden.json');
const CAPTURE = process.env.PSU_TRACE_CAPTURE || '';
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-quote-trace(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// ── the recorder: patch the RTDB Reference/Query and Firestore reference/query/transaction prototypes ─────────────
let REC = null;
const rel = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch (_) { return String(u); } };
function patchChain(obj, names, describe) {
  const done = new Set();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const nm of names) {
      if (done.has(nm) || !Object.prototype.hasOwnProperty.call(p, nm) || typeof p[nm] !== 'function') continue;
      done.add(nm);
      const orig = p[nm];
      p[nm] = function (...a) { if (REC) REC.push(describe(this, nm, a)); return orig.apply(this, a); };
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
function post(handler, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MAKE_SECRET}`, ...headers }, body: JSON.stringify(body) });
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
function bodyFor(rid, oid, phone, { redeem: withRedeem = false, qty = 1 } = {}) {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  const items = rid === 'x_pizza' ? [{ name: it.display.name, qty, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty, price: it.price, extras: [] }];
  const redeem = rid === 'x_pizza' ? { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' } : { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 1, name: 'Arroz' }] };
  return { restaurant_id: rid, order_id: oid, customer_name: 'Trace Test', customer_phone: phone, customer_email: 'trace@example.com', items_text: `${qty}x ${it.display.name}`, order_type: 'pickup', payment_method: 'cash', items, ...(withRedeem ? { redeem } : {}) };
}

// one handler call, recorded; request-local ids normalised AFTER the call (the attempt id / poll token are read back)
async function traced(rid, oid, uid, phone, opts = {}) {
  const kind = opts.kind || 'quote';
  await rtdb.ref('rate_limits').remove();   // every test request is 127.0.0.1 — the per-IP limit is reset between charges (test env only)
  REC = [];
  const b = bodyFor(rid, oid, phone, { redeem: kind === 'redeem' });
  const r = kind === 'redeem'
    ? await post(app.quoteRedemption, { restaurant_id: rid, items: b.items, redeem: b.redeem }, { 'x-firebase-id-token': uid })
    : await post(app.quoteOrder, { restaurant_id: rid, items: b.items }, {});
  await wait(300);   // let any fire-and-forget write the handler issued land inside the recording
  const calls = REC; REC = null;
  const o = (await rtdb.ref(`orders/${oid}`).get()).val() || {};
  const subs = [];
  for (const [k, v] of Object.entries(o)) if (/attempt_id$|poll_token$|tracking_token$/.test(k) && typeof v === 'string' && v.length >= 8) subs.push([v, `<${k}>`]);
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
    .replace(ID_RE, (m, rid, kind, id) => `restaurants/${rid}/identity/${kind}/ids/${idName.get(`${rid}/${id}`)}`)
    // the fixture publishes a fresh catalog version per run (time + random id) — normalised like the other run-local ids
    .replace(/(restaurants\/[^/]+\/versions\/)v-\d+-[0-9a-f]+/g, '$1<version>');
  // a getAll's ORDER follows the raw (random) ids, so it is recorded as: the normalised document MULTISET (sorted,
  // multiplicity kept) + whether the RAW order was ascending. Ascending + the multiset pins the exact raw sequence; any
  // other order flips the flag; an added, dropped or repeated document changes the multiset.
  const batch = (raw) => ({ paths: raw.map(norm).sort(), raw_order: raw.every((x, i) => i === 0 || raw[i - 1] <= x) ? 'ascending' : 'other', count: raw.length });
  const trace = calls.map((c) => ({ ...c, ...(c.path !== undefined ? { path: norm(c.path) } : {}), ...(c.paths ? batch(c.paths) : {}), ...(c.keys ? { keys: c.keys.map(norm) } : {}) }));
  return { status: r.status, trace };
}

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) await seedPreP1(rid);
  assert.strictEqual((await bootstrapIdentityStamps(fs, 'x_pizza')).stamped, true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  await rtdb.ref('config/redemption_enabled').set(true);

  const out = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const uid = `u_trace_${rid}`;
    await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
    await rtdb.ref('rate_limits').remove();
    // warm-up (NOT recorded): one of each, so per-instance caches settle
    assert.strictEqual((await post(app.quoteOrder, { restaurant_id: rid, items: bodyFor(rid, 'w', '1').items }, {})).status, 200, `${rid}: warm-up quote`);
    const wb = bodyFor(rid, 'w', '1', { redeem: true });
    assert.strictEqual((await post(app.quoteRedemption, { restaurant_id: rid, items: wb.items, redeem: wb.redeem }, { 'x-firebase-id-token': uid })).status, 200, `${rid}: warm-up redemption quote`);
    // SETTLE (not recorded, not filtered): the catalog verifier re-reads Firestore when its 60 s observation expires, which
    // lands in whichever request crosses that moment. Probe quotes run until one makes NO Firestore call, so the recorded
    // requests that follow (well inside 60 s) see a settled instance. Base and current run the same settle step.
    for (let i = 0; i < 10; i += 1) {
      REC = [];
      await post(app.quoteOrder, { restaurant_id: rid, items: bodyFor(rid, 'w', '1').items }, {});
      await wait(300);
      const fsCalls = REC.filter((e) => e.db === 'fs').length; REC = null;
      if (!fsCalls) break;
      assert.ok(i < 9, `${rid}: the instance never settled`);
    }
    await rtdb.ref('rate_limits').remove();
    const a = await traced(rid, 'qtrace_unused_oid', uid, '99000001', { kind: 'quote' });
    const b = await traced(rid, 'qtrace_unused_oid', uid, '99000001', { kind: 'redeem' });
    for (const [k, v] of [['a_quote_order', a], ['b_quote_redemption', b]]) {
      assert.strictEqual(v.status, 200, `${rid} ${k}: premise — status 200 (${v.status})`);
      assert.ok(v.trace.length > 0, `${rid} ${k}: premise — the recorder saw the handler's calls`);
    }
    // c — the REFRESH request: advance the controlled clock past every per-instance TTL (verifier 60 s, catalog context
    // 45 s, floor 30 s), so this quote re-reads exactly what an init/refresh reads. Reproducible: same state, same clock.
    CLOCK_OFFSET += 61000;
    await rtdb.ref('rate_limits').remove();
    const c = await traced(rid, 'qtrace_unused_oid', uid, '99000001', { kind: 'quote' });
    assert.strictEqual(c.status, 200, `${rid} c_quote_order_refresh: premise — status 200 (${c.status})`);
    assert.ok(c.trace.some((e) => e.db === 'fs') || rid !== 'x_pizza', `${rid} c_quote_order_refresh: premise — the refresh really re-read (x_pizza's certified context reads Firestore)`);
    out[rid] = { a_quote_order: a.trace, b_quote_redemption: b.trace, c_quote_order_refresh: c.trace };
  }

  if (CAPTURE) {
    fsys.writeFileSync(CAPTURE, `${JSON.stringify(out, null, 1)}\n`);
    console.log(`pselfupdate-quote-trace(emulator): CAPTURED → ${CAPTURE}`);
  } else {
    const golden = JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
    // ALLOWLIST (ruling R3.2): exactly the HTTP floor's GET is excluded from the comparison, and asserted on its own
    const isFloorRead = (e) => e.db === 'rtdb' && e.path === 'platform_config/client_floor/orders';
    for (const rid of Object.keys(golden)) for (const k of Object.keys(golden[rid])) {
      const floorCalls = out[rid][k].filter(isFloorRead);
      assert.ok(floorCalls.every((e) => e.op === 'get'), `🔴 ${rid} ${k}: the floor path is only ever READ (got ${JSON.stringify(floorCalls)})`);
      assert.ok(floorCalls.length <= 1, `🔴 ${rid} ${k}: at most one floor read per request (cached) — got ${floorCalls.length}`);
      assert.deepStrictEqual(out[rid][k].filter((e) => !isFloorRead(e)), golden[rid][k], `🔴 ${rid} ${k}: the REAL handler's ordered DB call sequence differs from the frozen ba29282 trace`);
      console.log(`  ✓ ${rid} ${k}: ${golden[rid][k].length} calls identical to ba29282 (+${floorCalls.length} allowlisted floor get)`);
    }
    assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(golden).sort());
    // NON-VACUOUS ALLOWLIST: one more fresh request after the floor cache has EXPIRED (one TTL since any earlier read) MUST
    // carry exactly ONE floor GET, and with it removed its sequence must equal the golden's b_quote_redemption (it never involves the catalog verifier, whose 60 s TTL a 31 s wait could cross).
    {
      const { FLOOR_TTL_MS } = require('../client-floor');
      // with the CONTROLLED clock: refresh every cache now (an unrecorded quoteRedemption), then advance exactly one floor TTL — past
      // the floor's 30 s, inside the catalog context's 45 s and the verifier's 60 s — so ONLY the floor cache has expired
      await rtdb.ref('rate_limits').remove();
      { const wb2 = bodyFor('x_pizza', 'w', '1', { redeem: true });   // the SAME path as the checked request, so ITS caches refresh too
        await post(app.quoteRedemption, { restaurant_id: 'x_pizza', items: wb2.items, redeem: wb2.redeem }, { 'x-firebase-id-token': 'u_trace_x_pizza' }); }
      await wait(300);
      CLOCK_OFFSET += FLOOR_TTL_MS + 1500;   // 31.5 s: past the floor's 30 s; inside the 45 s context / gate-pointer TTLs and the 60 s verifier
      const t = await traced('x_pizza', 'qtrace_unused_oid', 'u_trace_x_pizza', '99000001', { kind: 'redeem' });
      assert.strictEqual(t.status, 200, 'post-TTL request premise');
      const fl = t.trace.filter(isFloorRead);
      assert.deepStrictEqual(fl.map((e) => e.op), ['get'], `🔴 after the TTL exactly ONE floor GET is made (got ${JSON.stringify(fl)})`);
      assert.deepStrictEqual(t.trace.filter((e) => !isFloorRead(e)), golden.x_pizza.b_quote_redemption, '🔴 the post-TTL request, minus its floor GET, equals the frozen golden');
      console.log(`  ✓ x_pizza post-TTL b_quote_redemption: exactly 1 allowlisted floor GET; the rest identical to the golden`);
    }
    console.log('pselfupdate-quote-trace(emulator): OK');
  }
  FINISHED = true;
  process.exit(0);
})().catch((e) => { console.error('pselfupdate-quote-trace(emulator) FAILED:', e); process.exit(1); });
