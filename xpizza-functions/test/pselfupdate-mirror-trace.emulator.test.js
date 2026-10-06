'use strict';
// P-SELFUPDATE (advisor ruling, CP1 r2) — the MIRROR ROUTE: pricing served from the RTDB mirror during a Firestore outage
// (snapshot-fallback rung 2 → source mirror_cold → the persisted context via loadPersisted) is a WORKING live path, and
// P-SELFUPDATE's floor read runs on it too. Run: npm run test:pselfupdate-mirror-trace
//
// Two phases in one file:
//   ORCHESTRATE — seeds through the REAL writers with Firestore UP (catalog publish + mirror, identity bootstrap, the
//     reconciler's persisted catalog_snapshot_ctx), exports the identity-id → name map, then spawns
//   CAPTURE — a COLD handler process with Firestore UNREACHABLE (FIRESTORE_EMULATOR_HOST → a dead port; RTDB up), which
//     records quoteOrder + createOrder on both restaurants, WARMED (after an unrecorded warm-up) and REFRESH (a
//     controlled clock advanced past every per-instance TTL, so loadPersisted re-reads the persisted context).
// The golden catalog/pselfupdate-mirror-trace.golden.json was captured by running THIS file in a ba29282 checkout
// (PSU_TRACE_CAPTURE) and is FROZEN; compare mode allowlists exactly the floor GET (ruling R3.2). Current code only:
// floor ON on this route → the same typed 426 as the live route, with the whole RTDB tree byte-identical.
// CAPTURE phase: Firestore is DELIBERATELY pointed at a dead LOOPBACK port (it can never reach real infrastructure), so the
// guard checks only the database there; the orchestrator (seeding through Firestore) keeps the full guard.
if (process.env.PSU_MIRROR_PHASE === 'capture') {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:1') { console.error('capture phase: FIRESTORE_EMULATOR_HOST must be the dead loopback 127.0.0.1:1'); process.exit(2); }
  require('./_emulator-required')('database');
  // A PRE-EXISTING, RARE degraded-path event (observed 1 in 12 runs, base and current alike): a Firestore UNAVAILABLE
  // rejection from a retry of a call the code had already stopped waiting for surfaces as an UNHANDLED rejection. It is
  // RECORDED and SURFACED (printed loudly by the orchestrator and reported), not allowed to crash the capture —
  // the call-sequence golden is about which calls are made, which this event does not change.
  // codex CP1 r3 S2: record the FULL error; ONLY the documented signature is tolerated (see
  // ~/Downloads/xpizza-pselfupdate-evidence/UNHANDLED-REJECTION.md) — a gRPC 14 UNAVAILABLE / ECONNREFUSED to the dead
  // loopback 127.0.0.1:1. ANY other unhandled rejection is a FAILURE of this test.
  globalThis.__UNHANDLED = [];
  const DOCUMENTED = (e) => !!e && (e.code === 14 || /^14 UNAVAILABLE/.test(String(e.message))) && /ECONNREFUSED 127\.0\.0\.1:1\b/.test(String(e.message));
  process.on('unhandledRejection', (e) => {
    globalThis.__UNHANDLED.push({ documented: DOCUMENTED(e), code: e && e.code !== undefined ? e.code : null, message: String((e && e.message) || e), stack: String((e && e.stack) || '') });
  });
} else {
  require('./_emulator-required')('database', 'firestore');
}
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

const GOLDEN = path.join(__dirname, '..', 'catalog', 'pselfupdate-mirror-trace.golden.json');
const PHASE = process.env.PSU_MIRROR_PHASE || 'orchestrate';
const ID_MAP = process.env.PSU_MIRROR_IDMAP ? JSON.parse(fsys.readFileSync(process.env.PSU_MIRROR_IDMAP, 'utf8')) : null;
const CAPTURE = process.env.PSU_TRACE_CAPTURE || '';
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-mirror-trace(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

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
  const r = kind === 'cash'
    ? await post(app.createOrder, b, { 'x-firebase-id-token': uid })
    : kind === 'redeem'
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
      if (ID_MAP) { idName.set(`${rid}/${id}`, ID_MAP[`${rid}/${id}`] || name); continue; }
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
  return { status: r.status, trace, json: r.json };
}

async function seedAndExport(idMapFile) {
  for (const rid of ['x_pizza', 'la_musa']) await seedPreP1(rid);
  assert.strictEqual((await bootstrapIdentityStamps(fs, 'x_pizza')).stamped, true);
  for (const rid of ['x_pizza', 'la_musa']) await rtdb.ref(`restaurants/${rid}/identity`).set(identityFor(rid));
  await rtdb.ref('config/redemption_enabled').set(true);
  await app.reconcileCatalogContexts.run({});                                   // the REAL writer of catalog_snapshot_ctx
  for (const rid of ['x_pizza', 'la_musa']) assert.ok((await rtdb.ref(`catalog_snapshot_ctx/${rid}`).get()).val(), `${rid}: persisted context written`);
  const map = {};
  for (const rid of ['x_pizza', 'la_musa']) for (const kind of ['dish', 'extra']) {
    const snap = await fs.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('ids').get();
    for (const d of snap.docs) if (typeof (d.data() || {}).legacy_key === 'string') map[`${rid}/${d.id}`] = `<id:${kind}/${d.data().legacy_key}>`;
  }
  fsys.writeFileSync(idMapFile, JSON.stringify(map));
}

async function capturePhase() {
  const out = {};
  const money = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const uid = `u_trace_${rid}`;
    await rtdb.ref(`user_rewards/${uid}/${rid}`).set({ balance: 100000, reserved: 0 });
    // warm-up (NOT recorded) on the cold, Firestore-less instance: one quote + one cash order
    await rtdb.ref('rate_limits').remove();
    const w1 = await post(app.quoteOrder, { restaurant_id: rid, items: bodyFor(rid, 'w', '1').items }, {});
    assert.strictEqual(w1.status, 200, `${rid}: warm-up quote served from the MIRROR (${w1.status} ${w1.text.slice(0, 120)})`);
    await rtdb.ref('rate_limits').remove();
    const w2 = await post(app.createOrder, bodyFor(rid, `mwarm_${rid}`, '99550000'), { 'x-firebase-id-token': uid });
    assert.strictEqual(w2.status, 200, `${rid}: warm-up cash order priced from the MIRROR (${w2.status} ${w2.text.slice(0, 120)})`);
    await wait(2500);
    await rtdb.ref('rate_limits').remove();
    const a = await traced(rid, 'qtrace_unused_oid', uid, '99000001', { kind: 'quote' });
    await rtdb.ref('rate_limits').remove();
    const b = await traced(rid, `mcash_${rid}_a`, uid, '99551001', { kind: 'cash' });
    CLOCK_OFFSET += 61000;                                                       // REFRESH: past every per-instance TTL
    await rtdb.ref('rate_limits').remove();
    const c = await traced(rid, 'qtrace_unused_oid', uid, '99000001', { kind: 'quote' });
    await rtdb.ref('rate_limits').remove();
    const d = await traced(rid, `mcash_${rid}_b`, uid, '99552001', { kind: 'cash' });
    for (const [k, v] of [['a_quote_mirror', a], ['b_cash_mirror', b], ['c_quote_mirror_refresh', c], ['d_cash_mirror_refresh', d]]) {
      assert.strictEqual(v.status, 200, `${rid} ${k}: premise — status 200 on the mirror route (${v.status})`);
      assert.ok(v.trace.some((e) => e.db === 'rtdb' && /^catalog_snapshot/.test(e.path || '')) || k.startsWith('a_') || k.startsWith('b_'), `${rid} ${k}: premise — the refresh re-read the mirror/persisted context`);
    }
    out[rid] = { a_quote_mirror: a.trace, b_cash_mirror: b.trace, c_quote_mirror_refresh: c.trace, d_cash_mirror_refresh: d.trace };
    // MONEY on the mirror route (owner rule): the quote's numeric fields and the WRITTEN order's money fields (every leaf
    // whose key names money: totals, subtotals, tax, line prices, discounts), warmed AND refresh
    const quoteMoney = (j) => Object.fromEntries(Object.entries(j || {}).filter(([k, v]) => typeof v === 'number').sort());
    const MONEY_KEY = /(^|_)(total|subtotal|tax|price|cents|amount|discount|rebaja|isv|net)(_|$)/i;
    const orderMoney = async (oid) => {
      const o = (await rtdb.ref(`orders/${oid}`).get()).val() || {};
      const flat = {};
      const walk = (v, pfx) => {
        if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, pfx ? `${pfx}.${k}` : k); return; }
        const leaf = pfx.split('.').pop();
        if (typeof v === 'number' && MONEY_KEY.test(leaf)) flat[pfx] = v;
      };
      walk(o, '');
      return Object.fromEntries(Object.entries(flat).sort());
    };
    money[rid] = {
      a_quote_mirror: quoteMoney(a.json), b_cash_mirror: await orderMoney(`mcash_${rid}_a`),
      c_quote_mirror_refresh: quoteMoney(c.json), d_cash_mirror_refresh: await orderMoney(`mcash_${rid}_b`),
    };
  }
  let floorOn = null;
  if (process.env.PSU_MIRROR_FLOOR === '1') {
    // floor ON on the mirror route → the SAME typed 426 as the live route, zero mutation (current code only)
    const { FLOOR_TTL_MS } = require('../client-floor');
    await rtdb.ref('platform_config/client_floor/orders').set(2);
    CLOCK_OFFSET += FLOOR_TTL_MS + 1500;
    await rtdb.ref('rate_limits').remove();
    const tree = async () => JSON.stringify((await rtdb.ref().get()).val());
    floorOn = {};
    for (const rid of ['x_pizza', 'la_musa']) {
      let t0 = await tree();
      const q = await post(app.quoteOrder, { restaurant_id: rid, items: bodyFor(rid, 'w', '1').items }, {});
      const qSame = (await tree()) === t0;
      t0 = await tree();
      const cO = await post(app.createOrder, bodyFor(rid, `mfloor_${rid}`, '99553001'), { 'x-firebase-id-token': `u_trace_${rid}` });
      const cSame = (await tree()) === t0;
      floorOn[rid] = { quote: { status: q.status, body: q.json, zeroMutation: qSame }, cash: { status: cO.status, body: cO.json, zeroMutation: cSame } };
    }
    await rtdb.ref('platform_config/client_floor/orders').remove();
  }
  fsys.writeFileSync(process.env.PSU_MIRROR_OUT, JSON.stringify({ out, floorOn, money, unhandled: globalThis.__UNHANDLED || [] }));
}

(async () => {
  if (PHASE === 'capture') { await capturePhase(); FINISHED = true; process.exit(0); }
  const os = require('os'); const { execFileSync } = require('child_process');
  const dir = fsys.mkdtempSync(path.join(os.tmpdir(), 'psu-mirror-'));
  const idMapFile = path.join(dir, 'ids.json'), outFile = path.join(dir, 'out.json');
  await seedAndExport(idMapFile);
  const env = { ...process.env, PSU_MIRROR_PHASE: 'capture', PSU_MIRROR_IDMAP: idMapFile, PSU_MIRROR_OUT: outFile,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', PSU_MIRROR_FLOOR: CAPTURE ? '0' : '1' };
  try { execFileSync('node', [__filename], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, killSignal: 'SIGKILL' }); }
  catch (e) { console.error(String(e.stdout || '').slice(-1500) + String(e.stderr || '').slice(-3000)); throw new Error(`capture phase failed (${e.status === null ? 'TIMEOUT' : e.status})`); }
  const { out, floorOn, unhandled, money } = JSON.parse(fsys.readFileSync(outFile, 'utf8'));
  const undocumented = (unhandled || []).filter((u) => !u.documented);
  if (undocumented.length) throw new Error(`🔴 ${undocumented.length} UNDOCUMENTED unhandled rejection(s) on the mirror route — only the documented 14 UNAVAILABLE / ECONNREFUSED 127.0.0.1:1 signature is tolerated:\n${undocumented.map((u) => `${u.message}\n${u.stack}`).join('\n---\n')}`);
  if (unhandled && unhandled.length) console.log(`⚠ pselfupdate-mirror-trace: ${unhandled.length} documented UNHANDLED rejection(s) on the Firestore-outage route (pre-existing; reported): ${unhandled.map((u) => u.message.slice(0, 120)).join(' | ')}`);
  if (CAPTURE) {
    fsys.writeFileSync(CAPTURE, `${JSON.stringify(out, null, 1)}\n`);
    if (process.env.PSU_MONEY_CAPTURE) fsys.writeFileSync(process.env.PSU_MONEY_CAPTURE, `${JSON.stringify(money, null, 1)}\n`);
    console.log(`pselfupdate-mirror-trace(emulator): CAPTURED → ${CAPTURE}`);
  } else {
    const golden = JSON.parse(fsys.readFileSync(GOLDEN, 'utf8'));
    const isFloorRead = (e) => e.db === 'rtdb' && e.path === 'platform_config/client_floor/orders';
    for (const rid of Object.keys(golden)) for (const k of Object.keys(golden[rid])) {
      const floorCalls = out[rid][k].filter(isFloorRead);
      assert.ok(floorCalls.every((e) => e.op === 'get'), `🔴 ${rid} ${k}: the floor path is only ever READ`);
      assert.ok(floorCalls.length <= 1, `🔴 ${rid} ${k}: at most one floor read per request — got ${floorCalls.length}`);
      assert.deepStrictEqual(out[rid][k].filter((e) => !isFloorRead(e)), golden[rid][k], `🔴 ${rid} ${k}: the MIRROR-route call sequence differs from the frozen ba29282 trace`);
      console.log(`  ✓ ${rid} ${k}: ${golden[rid][k].length} calls identical to ba29282 (+${floorCalls.length} allowlisted floor get)`);
    }
    assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(golden).sort());
    // MONEY (owner rule): the mirror route's prices equal the FROZEN literals captured at a pristine ba29282
    const MONEY_GOLDEN = JSON.parse(fsys.readFileSync(path.join(__dirname, '..', 'catalog', 'pselfupdate-mirror-money.golden.json'), 'utf8'));
    for (const rid of Object.keys(MONEY_GOLDEN)) for (const k of Object.keys(MONEY_GOLDEN[rid])) {
      assert.ok(Object.keys(MONEY_GOLDEN[rid][k]).length > 0, `non-vacuity: ${rid} ${k} froze money fields`);
      assert.deepStrictEqual(money[rid][k], MONEY_GOLDEN[rid][k], `🔴 ${rid} ${k}: the MIRROR-route money differs from the frozen ba29282 literals`);
      console.log(`  ✓ ${rid} ${k}: money identical to ba29282 (${Object.entries(MONEY_GOLDEN[rid][k]).map(([f, v]) => `${f}=${v}`).join(', ').slice(0, 110)})`);
    }
    const LIVE_426 = { error: 'client_update_required', app: 'orders', required_compat: 2 };   // the live route's body (client-floor-http Z)
    for (const rid of ['x_pizza', 'la_musa']) for (const kind of ['quote', 'cash']) {
      const f = floorOn[rid][kind];
      assert.strictEqual(f.status, 426, `🔴 ${rid} ${kind}: floor ON on the MIRROR route refuses a header-less request (${f.status})`);
      assert.deepStrictEqual(f.body, LIVE_426, `🔴 ${rid} ${kind}: the same typed body as the live route`);
      assert.strictEqual(f.zeroMutation, true, `🔴 ${rid} ${kind}: the 426 on the mirror route is ZERO-mutation (whole tree)`);
    }
    console.log('  ✓ floor ON on the mirror route: header-less quoteOrder + createOrder → the live route\'s typed 426, whole RTDB tree byte-identical (both restaurants)');
    console.log('pselfupdate-mirror-trace(emulator): OK');
  }
  FINISHED = true;
  process.exit(0);
})().catch((e) => { console.error('pselfupdate-mirror-trace(emulator) FAILED:', e); process.exit(1); });
