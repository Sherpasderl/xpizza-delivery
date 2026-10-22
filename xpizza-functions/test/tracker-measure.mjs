#!/usr/bin/env node
// TRACKER FIXES T9 (PLAN §8 "Measured in the harness") — the COST of the slice: invocations, Admin reads (+ bytes), transactions
// (calls + updater attempts), writes (+ bytes) per scenario, with the flag OFF (today's code verbatim — proven by the OFF goldens)
// vs ON. ALL of index.js's database triggers are delivered by the real trigger runner (old ones too), so the delta is what the
// slice adds. Counting happens ONLY inside a trigger handler's own .run() (the runner's pre/post images are not counted);
// the background accept monitor (a real 60 s sleep) is not wrapped — it is identical OFF and ON.
//
//   node tools/emulator-run.js --only firestore,database --project demo-xpizza "node test/tracker-measure.mjs --flag on --out m-on.json"
//   node test/tracker-measure.mjs --compare m-off.json m-on.json        (prints the deltas and checks the PLAN §8 acceptance)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
// PLAN r2.10.1 §8.4: limits = ceil((ON − OFF) × 1.25) per scenario for reads and read bytes, FROZEN once in
// test/fixtures/tracker-measure.limits.json (--freeze writes it from a measured OFF/ON pair). --compare FAILS unless every scenario is
// present in both runs, every scenario has zero handler failures, each frozen limit holds, the retention checks hold (25 vs 50 retained
// rows → EQUAL recomputes and read CALLS; query bytes at 25 / 50 / 100 recorded with the per-row growth) and every scenario leaves 0
// residual LIVE claims on terminal orders AFTER ONE validation sweep (codex build r1 P1-1 ruling; the sweep's own reads are recorded).
const SCENARIOS = ['lone', 'stacked', 'reassign', 'cancel', 'shiftEnd', 'duplicates', 'retained25', 'retained50', 'retained100', 'churn'];
const LIMITS = path.join(here, 'fixtures', 'tracker-measure.limits.json');
const SWEEP_SCENARIOS = ['sweep24', 'sweep100'];
const SWEEP_LIMITS = path.join(here, 'fixtures', 'tracker-sweep.limits.json');
if (argv[0] === '--freeze-sweep') {
  // codex build r2 P2-3: the populated validation-sweep bound, ceil(measured × 1.25), FROZEN once (the sweep is flag-independent; the ON run's values)
  const on = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  if (fs.existsSync(SWEEP_LIMITS)) { console.error(`tracker-measure: ${SWEEP_LIMITS} exists — frozen once; refusing to overwrite`); process.exit(1); }
  const limits = {};
  for (const sc of SWEEP_SCENARIOS) {
    const m = on.scenarios[sc]; if (!m) { console.error(`tracker-measure: ${sc} missing`); process.exit(1); }
    limits[sc] = Object.fromEntries(['reads', 'readBytes', 'tx', 'writes'].map((k) => [k, Math.ceil(m[k] * 1.25)]));
  }
  fs.writeFileSync(SWEEP_LIMITS, JSON.stringify({ _doc: 'tracker validation sweep (codex build r2 P2-3) — ceil(measured × 1.25) per populated scenario, frozen once', frozenFrom: path.basename(argv[1]), limits }, null, 1) + '\n');
  console.log(`tracker-measure: sweep limits FROZEN → ${SWEEP_LIMITS}`); process.exit(0);
}
if (argv[0] === '--compare' || argv[0] === '--freeze') {
  const [off, on] = [argv[1], argv[2]].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const problems = [];
  for (const sc of SCENARIOS) {
    if (!off.scenarios[sc] || !on.scenarios[sc]) problems.push(`scenario ${sc} missing (off: ${!!off.scenarios[sc]}, on: ${!!on.scenarios[sc]})`);
    for (const [m, r] of [['off', off], ['on', on]]) if (r.scenarios[sc] && r.scenarios[sc].failures) problems.push(`${sc} (${m}): ${r.scenarios[sc].failures} handler failure(s)`);
  }
  if (problems.length) { console.error(`tracker-measure: FAIL\n${problems.map((p) => `  FAIL ${p}`).join('\n')}`); process.exit(1); }
  const delta = (sc, k) => on.scenarios[sc][k] - off.scenarios[sc][k];
  console.log('scenario      invocations       reads           read bytes          recomputes   tx (attempts)   writes (bytes)');
  for (const sc of SCENARIOS) {
    const a = off.scenarios[sc], b = on.scenarios[sc];
    const d = (k) => `${a[k]}→${b[k]} (${b[k] - a[k] >= 0 ? '+' : ''}${b[k] - a[k]})`;
    console.log(`${sc.padEnd(13)} ${d('invocations').padEnd(17)} ${d('reads').padEnd(15)} ${d('readBytes').padEnd(19)} ${String(b.recomputes).padEnd(12)} ${d('tx').padEnd(9)} ${String(b.txAttempts - a.txAttempts).padStart(5)}   ${d('writes')} ${b.writeBytes - a.writeBytes} B`);
  }
  const r25 = on.scenarios.retained25, r50 = on.scenarios.retained50, r100 = on.scenarios.retained100;
  if (r25.recomputes !== r50.recomputes) problems.push(`retention: recomputes 25 → ${r25.recomputes}, 50 → ${r50.recomputes} (must be EQUAL)`);
  if (r25.reads !== r50.reads) problems.push(`retention: read calls 25 → ${r25.reads}, 50 → ${r50.reads} (must be EQUAL)`);
  const perRow = (r100.readBytes - r25.readBytes) / 75;
  console.log(`retention (ON): recomputes ${r25.recomputes}/${r50.recomputes}/${r100.recomputes}, read calls ${r25.reads}/${r50.reads}/${r100.reads} at 25/50/100 rows; read bytes ${r25.readBytes}/${r50.readBytes}/${r100.readBytes} → residual growth ≈ ${perRow.toFixed(1)} B per retained row (the queries still download retained rows; recorded, not bounded)`);
  for (const sc of SCENARIOS) if (on.scenarios[sc].liveClaims !== 0) problems.push(`${sc}: ${on.scenarios[sc].liveClaims} residual LIVE claim(s) after one sweep (must be 0)`);
  console.log(`validation sweep (ON, one per scenario): reads ${SCENARIOS.map((sc) => `${sc} ${on.scenarios[sc].sweepReads}`).join(', ')}; bytes ${SCENARIOS.map((sc) => on.scenarios[sc].sweepBytes).join('/')}`);
  if (argv[0] === '--freeze') {
    if (fs.existsSync(LIMITS)) { console.error(`tracker-measure: ${LIMITS} exists — the limits are FROZEN once; refusing to overwrite`); process.exit(1); }
    if (problems.length) { console.error(`tracker-measure: refusing to freeze over problems:\n  ${problems.join('\n  ')}`); process.exit(1); }
    const limits = Object.fromEntries(SCENARIOS.map((sc) => [sc, { reads: Math.ceil(delta(sc, 'reads') * 1.25), readBytes: Math.ceil(delta(sc, 'readBytes') * 1.25) }]));
    fs.writeFileSync(LIMITS, JSON.stringify({ _doc: 'PLAN-tracker-fixes r2.10.1 §8.4 — ceil((ON − OFF) × 1.25), frozen once', frozenFrom: { off: path.basename(argv[1]), on: path.basename(argv[2]) }, limits }, null, 1) + '\n');
    console.log(`tracker-measure: limits FROZEN → ${LIMITS}`);
    process.exit(0);
  }
  // the populated validation sweep: enforced against its FROZEN bound
  const SL = JSON.parse(fs.readFileSync(SWEEP_LIMITS, 'utf8')).limits;
  for (const sc of SWEEP_SCENARIOS) {
    const m = on.scenarios[sc];
    if (!m) { problems.push(`${sc} missing`); continue; }
    console.log(`sweep ${sc}: ${m.n} live claims (${m.staled} stale tombstoned, ${m.keptLive} kept) → reads ${m.reads}, bytes ${m.readBytes}, tx ${m.tx}, writes ${m.writes}`);
    for (const k of ['reads', 'readBytes', 'tx', 'writes']) { const okk = m[k] <= SL[sc][k]; console.log(`  ${okk ? '✓' : '✗'} limit ${sc}.${k}: ${m[k]} ≤ ${SL[sc][k]} → ${okk ? 'OK' : 'OVER'}`); if (!okk) problems.push(`${sc}.${k} ${m[k]} over the frozen limit ${SL[sc][k]}`); }
  }
  const L = JSON.parse(fs.readFileSync(LIMITS, 'utf8')).limits;
  for (const sc of SCENARIOS) for (const k of ['reads', 'readBytes']) {
    const dd = delta(sc, k);
    const okk = dd <= L[sc][k];
    console.log(`  ${okk ? '✓' : '✗'} limit ${sc}.${k}: +${dd} ≤ ${L[sc][k]} → ${okk ? 'OK' : 'OVER'}`);
    if (!okk) problems.push(`${sc}.${k} +${dd} over the frozen limit ${L[sc][k]}`);
  }
  if (problems.length) { console.error(`tracker-measure: FAIL\n${problems.map((p) => `  FAIL ${p}`).join('\n')}`); process.exit(1); }
  console.log('tracker-measure: compare OK');
  process.exit(0);
}

const args = Object.fromEntries(argv.reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
if (!args.out || !['on', 'off'].includes(args.flag)) { console.error('usage: tracker-measure.mjs --flag on|off --out <file> | --compare <off> <on>'); process.exit(2); }
const FN = path.join(here, '..');
const require = createRequire(path.join(FN, 'index.js'));
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'measure-secret';
require('./test/_emulator-required')('database');
const whatsapp = require('./whatsapp'); whatsapp.sendMessage = async () => ({ id: 'wa' });
const webpush = require('web-push'); webpush.sendNotification = async () => ({ statusCode: 201 });
const app = require('./index.js');
{ const { getAuth } = require('firebase-admin/auth'); Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null }); }
const { getDatabase } = require('firebase-admin/database');
const db = getDatabase();
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(db.ref().toString())) { console.error('measure: refusing — not the emulator'); process.exit(2); }
const { makeTriggerRunner } = await import(pathToFileURL(path.join(here, '_trigger-runner.mjs')).href);
const flag = require('./tracking/flag');

// production rules on the Admin namespace (its .indexOn is what the fan-out query runs against in production)
{
  const ns = new URL(db.app.options.databaseURL).hostname.split('.')[0];
  const r = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: fs.readFileSync(path.join(FN, '..', 'xpizza-reference', 'database.rules.json'), 'utf8') });
  if (!r.ok) { console.error('measure: could not load the production rules'); process.exit(2); }
}

// ── counters (only while a handler runs) ────────────────────────────────────────────────────────────────────────────
const C = { measuring: 0, trigger: null };
const BREAK = {};   // --breakdown: reads per trigger and per path root
const bk = (key) => { if (!args.breakdown) return; BREAK[key] = (BREAK[key] || 0) + 1; };
const zero = () => ({ invocations: 0, reads: 0, readBytes: 0, tx: 0, txAttempts: 0, writes: 0, writeBytes: 0, recomputes: 0 });
let cur = zero();
const size = (v) => (v === undefined || v === null ? 4 : Buffer.byteLength(JSON.stringify(v)));
{
  // READS are wrapped at the prototype that DEFINES once/get — Query.prototype, which Reference inherits from — so a reference read
  // AND an indexed query read (orderByChild().equalTo() returns a Query) are each counted exactly once (codex r2.9 P1-2). Writes and
  // transactions are defined on Reference.prototype.
  const proto = Object.getPrototypeOf(db.ref());
  const qproto = Object.getPrototypeOf(proto);
  for (const m of ['once', 'get']) if (!Object.prototype.hasOwnProperty.call(qproto, m) || Object.prototype.hasOwnProperty.call(proto, m)) { console.error(`measure: ${m} is not defined (only) on the Query prototype — the SDK layout changed; refusing`); process.exit(2); }
  const wrapOn = (P, m, fn) => { const o = P[m]; P[m] = function (...a) { return fn.call(this, o, a); }; };
  const wrap = (m, fn) => wrapOn(['once', 'get'].includes(m) ? qproto : proto, m, fn);
  wrap('once', function (o, a) { const p = o.apply(this, a); if (!C.measuring || globalThis.__trImaging > 0) return p; cur.reads += 1; bk(`${C.trigger} ${this.toString().replace(/^https?:\/\/[^/]+\//, '').split('?')[0].split('/').slice(0, 1).join('/')}`); return p.then((s) => { cur.readBytes += size(s && s.val()); return s; }); });
  wrap('get', function (o, a) { const p = o.apply(this, a); if (!C.measuring || globalThis.__trImaging > 0) return p; cur.reads += 1; return p.then((s) => { cur.readBytes += size(s && s.val()); return s; }); });
  wrap('transaction', function (o, a) {
    if (!C.measuring) return o.apply(this, a);
    cur.tx += 1; if (/\/tracker_seq\//.test(this.toString())) cur.recomputes += 1; const f = a[0];
    return o.call(this, (x) => { cur.txAttempts += 1; const r = f(x); if (r !== undefined) cur.writeBytes += size(r); return r; }, ...a.slice(1)).then((res) => { if (res && res.committed) cur.writes += 1; return res; });
  });
  for (const m of ['set', 'update', 'push', 'remove']) wrap(m, function (o, a) { if (C.measuring) { cur.writes += 1; cur.writeBytes += size(a[0]); } return o.apply(this, a); });
}

// SELF-CHECK (every run, before any scenario): a known payload; inside a counted window ONE ref.once and ONE indexed query; reads
// must be exactly 2 and bytes exactly the JSON sizes of the two results. Anything else → abort (a wrong instrument never measures).
{
  await db.ref('__measure_selfcheck').set({ a: { k: 1, v: 'xx' }, b: { k: 2, v: 'yyy' }, c: { k: 1, v: 'z' } });
  const before = { ...cur };
  C.measuring += 1;
  let s1, s2;
  try {
    s1 = await db.ref('__measure_selfcheck/b').once('value');
    s2 = await db.ref('__measure_selfcheck').orderByChild('k').equalTo(1).once('value');
  } finally { C.measuring -= 1; }
  const reads = cur.reads - before.reads, bytes = cur.readBytes - before.readBytes;
  const expect = Buffer.byteLength(JSON.stringify(s1.val())) + Buffer.byteLength(JSON.stringify(s2.val()));
  if (reads !== 2 || bytes !== expect || Object.keys(s2.val() || {}).sort().join() !== 'a,c') {
    console.error(`measure: SELF-CHECK FAILED — reads ${reads} (want 2), bytes ${bytes} (want ${expect}), query keys ${Object.keys(s2.val() || {})}`); process.exit(2);
  }
  cur = zero();
  await db.ref('__measure_selfcheck').set(null);
  // and the trigger runner's own pre/post images (per-write capture) are NOT counted: a captured write inside a counted window adds 0 reads
  {
    const Rx = makeTriggerRunner({ app, db, entities: { orders: ['__selfcheck'] } });
    const r0 = cur.reads;
    await Rx.step('selfcheck write', async () => { C.measuring += 1; try { await db.ref('orders/__selfcheck/status').set('new'); } finally { C.measuring -= 1; } });
    Rx.queue.length = 0; Rx.close();
    await db.ref('orders/__selfcheck').set(null);
    if (cur.reads - r0 !== 0) { console.error(`measure: SELF-CHECK FAILED — the runner's capture images were counted (${cur.reads - r0} reads)`); process.exit(2); }
    cur = zero();
  }
  console.log(`measure: self-check OK (1 ref read + 1 indexed query read = 2; ${expect} bytes exact; runner images excluded)`);
}

const RID = 'tb_centro', HUB = { lat: 15.5, lng: -88.03 };
const DA = 'u_meas_a0000000000000000', DB = 'u_meas_b0000000000000000', DC = 'u_meas_c0000000000000000', DISP = 'u_meas_disp000000000000';
function post(handler, { headers = {}, body }) {
  const express = require('express');
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try { const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); await r.text(); server.close(() => resolve(r.status)); }
      catch (e) { server.close(() => reject(e)); }
    });
  });
}
async function reset() {
  await db.ref('/').set(null);
  await db.ref().update({
    'config/auto_assign_enabled': false, 'config/whatsapp_enabled': true,
    ...(args.flag === 'on' ? { 'config/tracker_fixes_enabled': true } : {}),
    [`restaurants/${RID}/identity`]: { active: true, name: 'TB', phone: '+50400000000', whatsapp_enabled: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 10, version: 1 },
    [`dispatchers/${DISP}`]: { name: 'D' },
    ...Object.fromEntries([DA, DB, DC].map((u, i) => [`drivers/${u}`, { name: ['ana', 'beto', 'cris'][i], status: 'available', active: false }])),
  });
  flag._resetForTest();
}
let seq = 0;
const create = (oid) => {
  const { buildCreateOrderUpdates } = require('./create-order-build.js');
  return buildCreateOrderUpdates({
    orderId: oid, orderType: 'delivery', now: Date.now() + (seq += 1), trackingToken: `TOK_${oid}`, total: 250, lat: 15.52, lng: -88.01,
    fields: { customer_name: 'Ana', customer_phone: '+50499990000', items_text: '1x M', notes: '', payment_method: 'cash', address_detected: 'Col', address_details: 'Casa' },
    hubSnap: { hub_lat: HUB.lat, hub_lng: HUB.lng, restaurant_name: 'TB', restaurant_phone: '+50400000000' }, restaurantId: RID, priceBreakdown: { total_cents: 25000 },
    facturaPriced: {}, cashTenderedCents: null, freeOrder: false, rewardStamp: null,
  });
};
const assign = (oid, u) => ({ [`tasks/${oid}_pickup/assigned_driver_id`]: u, [`tasks/${oid}_pickup/status`]: 'assigned', [`tasks/${oid}_delivery/assigned_driver_id`]: u, [`tasks/${oid}_delivery/status`]: 'assigned' });

async function scenario(name, orders, drivers, body) {
  await reset();
  const R = makeTriggerRunner({ app, db, entities: { orders, tasks: orders.flatMap((o) => [`${o}_pickup`, `${o}_delivery`]), drivers, rids: [RID] }, background: ['monitorAssignmentTimeout'] });
  for (const t of R.triggers) {
    if (t.name === 'monitorAssignmentTimeout' || t.fn.__measureWrapped) continue;
    const orig = t.fn.run.bind(t.fn);
    t.fn.run = async (ev) => { cur.invocations += 1; C.measuring += 1; const prevT = C.trigger; C.trigger = t.name; bk(`${t.name} INVOCATION`); try { return await orig(ev); } finally { C.measuring -= 1; C.trigger = prevT; } };
    t.fn.__measureWrapped = true;
  }
  cur = zero();
  const tokens = {};
  const S = {
    step: async (label, fn) => { await R.step(label, fn); await R.quiesce({ awaitBackground: false }); },
    write: (label, u) => S.step(label, () => db.ref().update(u)),
    clockIn: async (u) => { await S.step(`clock-in ${u}`, async () => { const r = await app.startDriverShift.run({ auth: { uid: u, token: { uid: u } }, data: { platform: 'native' }, rawRequest: { headers: {} } }); tokens[u] = r.ingest_token; }); },
    ingest: async (u, i) => S.step(`ingest ${u} ${i}`, () => post(app.ingestDriverLocation, { headers: { 'x-driver-token': tokens[u] }, body: { locations: [{ ts: Date.now() - 1000, lat: 15.51, lng: -88.02 + i * 0.01, accuracy: 10 }] } })),
    R,
  };
  await body(S);
  await R.quiesce({ awaitBackground: true });
  // codex build r1 P1-1 ruling: residual LIVE claims are bounded by ONE validation sweep — run it (ON), count its cost SEPARATELY
  // (sweepReads / sweepBytes, not part of the journey's frozen numbers), then count residual LIVE claims on terminal orders
  const journey = { ...cur };
  let sweepReads = 0, sweepBytes = 0;
  if (args.flag === 'on') {
    const r0 = cur.reads, b0 = cur.readBytes;
    C.measuring += 1;
    try { await require('./tracking/tombstones').sweepTrackerTombstones(db, Date.now()); } finally { C.measuring -= 1; }
    sweepReads = cur.reads - r0; sweepBytes = cur.readBytes - b0;
  }
  cur = journey;
  const claimsNow = (await db.ref('tracker_claims').once('value')).val() || {};
  const terminalLive = [];
  for (const [uid, byOrder] of Object.entries(claimsNow)) for (const [oid, c] of Object.entries(byOrder || {})) {
    if (c && c.gone !== true && ['delivered', 'completed', 'cancelled'].includes((await db.ref(`orders/${oid}/status`).once('value')).val())) terminalLive.push(`${uid}/${oid}`);
  }
  const out = { ...cur, failures: R.failures.length, liveClaims: args.flag === 'on' ? terminalLive.length : 0, sweepReads, sweepBytes };
  R.close();
  return out;
}
// the lone journey up to (and including) pickup + ingests, reused by several scenarios
async function upToPickup(S, oid, u, ingests = 1) {
  await S.write('create', create(oid));
  await S.write('assign', assign(oid, u));
  await S.clockIn(u);
  await S.write('accept', { [`tasks/${oid}_pickup/status`]: 'accepted', [`tasks/${oid}_delivery/status`]: 'accepted', [`drivers/${u}/current_task_id`]: `${oid}_pickup`, [`drivers/${u}/status`]: 'assigned' });
  await S.write('preparing', { [`orders/${oid}/status`]: 'preparing' });
  await S.write('ready', { [`orders/${oid}/status`]: 'ready' });
  await S.write('pickup', { [`orders/${oid}/status`]: 'out_for_delivery', [`orders/${oid}/picked_up_at`]: Date.now(), [`tasks/${oid}_pickup/status`]: 'completed', [`tasks/${oid}_delivery/status`]: 'in_progress', [`drivers/${u}/current_task_id`]: `${oid}_delivery` });
  for (let i = 1; i <= ingests; i += 1) await S.ingest(u, i);
}
const complete = (S, oid, u) => S.write('complete', { [`orders/${oid}/status`]: 'delivered', [`orders/${oid}/delivered_at`]: Date.now(), [`tasks/${oid}_delivery/status`]: 'completed', [`drivers/${u}/current_task_id`]: null, [`drivers/${u}/status`]: 'available' });

const scenarios = {};
const ONLY = args.only ? args.only.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
if (want('lone')) scenarios.lone = await scenario('lone', ['m1'], [DA], async (S) => { await upToPickup(S, 'm1', DA, 3); await complete(S, 'm1', DA); });
if (want('stacked')) scenarios.stacked = await scenario('stacked', ['m1', 'm2'], [DA], async (S) => {
  await S.write('create 1', create('m1')); await S.write('create 2', create('m2'));
  await S.write('assign both', { ...assign('m1', DA), ...assign('m2', DA) });
  await S.clockIn(DA);
  await S.write('accept both', { 'tasks/m1_pickup/status': 'accepted', 'tasks/m1_delivery/status': 'accepted', 'tasks/m2_pickup/status': 'accepted', 'tasks/m2_delivery/status': 'accepted', [`drivers/${DA}/current_task_id`]: 'm1_pickup' });
  await S.write('ready both', { 'orders/m1/status': 'ready', 'orders/m2/status': 'ready' });
  await S.write('pickup both', { 'orders/m1/status': 'out_for_delivery', 'orders/m2/status': 'out_for_delivery', 'tasks/m1_pickup/status': 'completed', 'tasks/m2_pickup/status': 'completed', 'tasks/m1_delivery/status': 'in_progress', [`drivers/${DA}/current_task_id`]: 'm1_delivery' });
  for (const i of [1, 2]) await S.ingest(DA, i);
  await S.write('complete 1', { 'orders/m1/status': 'delivered', 'tasks/m1_delivery/status': 'completed', 'tasks/m2_delivery/status': 'in_progress', [`drivers/${DA}/current_task_id`]: 'm2_delivery' });
  await S.ingest(DA, 3);
  await complete(S, 'm2', DA);
});
if (want('reassign')) scenarios.reassign = await scenario('reassign', ['m1'], [DA, DB], async (S) => {
  await upToPickup(S, 'm1', DA, 1); await S.clockIn(DB);
  await S.write('reassign: delivery owner', { 'tasks/m1_delivery/assigned_driver_id': DB, 'tasks/m1_delivery/status': 'assigned', [`drivers/${DA}/current_task_id`]: null });
  await S.write('reassign: pickup owner', { 'tasks/m1_pickup/assigned_driver_id': DB });
  await S.write('B accepts', { 'tasks/m1_delivery/status': 'in_progress', [`drivers/${DB}/current_task_id`]: 'm1_delivery' });
  await S.ingest(DB, 2); await complete(S, 'm1', DB);
});
if (want('cancel')) scenarios.cancel = await scenario('cancel', ['m1'], [DA], async (S) => {
  await upToPickup(S, 'm1', DA, 1);
  await S.write('cancel', { 'orders/m1/status': 'cancelled', 'tasks/m1_pickup/status': 'cancelled', 'tasks/m1_delivery/status': 'cancelled', [`drivers/${DA}/current_task_id`]: null, [`drivers/${DA}/status`]: 'available' });
});
if (want('shiftEnd')) scenarios.shiftEnd = await scenario('shiftEnd', ['m1'], [DA], async (S) => {
  await upToPickup(S, 'm1', DA, 1);
  await S.write('forced shift end', { [`drivers/${DA}/active`]: false, [`drivers/${DA}/current_shift_id`]: null });
});
if (want('duplicates')) scenarios.duplicates = await scenario('duplicates', ['m1'], [DA], async (S) => {
  await upToPickup(S, 'm1', DA, 0);
  await S.R.step('pointer flip', () => db.ref().update({ [`drivers/${DA}/current_task_id`]: 'm1_pickup' }));
  const q = [...S.R.queue]; S.R.queue.push(...q.map((e) => ({ ...e })));   // every event of this step delivered TWICE
  await S.R.quiesce({ awaitBackground: false });
});
// RETAINED (r2.10.1 B fixture): N COMPLETE retained pairs for driver A — order + pickup + delivery rows, delivered / cancelled
// alternating, each with an existing terminal tracking mirror; claims hints ABSENT for all but ONE terminal order that carries a LIVE
// hint (a late grant that landed: the fan-out must still find it through the hint and tombstone it). Then the lone journey.
const retained = (N) => async (S) => {
  const u = {};
  for (let i = 0; i < N; i += 1) {
    const oid = `old${i}`, st = i % 2 ? 'cancelled' : 'delivered', ts = i % 2 ? 'cancelled' : 'completed';
    u[`orders/${oid}`] = { order_id: oid, status: st, tracking_token: `TOK_${oid}`, restaurant_id: RID, created_at: i + 1 };
    u[`tasks/${oid}_pickup`] = { order_id: oid, type: 'pickup', status: ts, assigned_driver_id: DA, created_at: i + 1 };
    u[`tasks/${oid}_delivery`] = { order_id: oid, type: 'delivery', status: ts, assigned_driver_id: DA, created_at: i + 1 };
    u[`order_tracking/TOK_${oid}`] = { order_id: oid, status: st, mx: { seq: 1, mode: 'terminal', owner_tag: 'none', epoch: 1, smp: { owner_tag: 'none', sample_at: 0 } } };
  }
  u[`tracker_claims/${DA}/old0`] = { seq: 0, gone: false, at: 1 };   // the one LIVE hint on a terminal order
  await S.write('retained rows', u);
  await upToPickup(S, 'm1', DA, 1); await complete(S, 'm1', DA);
};
for (const N of [25, 50, 100]) if (want(`retained${N}`)) scenarios[`retained${N}`] = await scenario(`retained${N}`, ['m1'], [DA], retained(N));

if (want('churn')) scenarios.churn = await scenario('churn', ['m1'], [DA, DB, DC], async (S) => {
  await upToPickup(S, 'm1', DA, 1); await S.clockIn(DB); await S.clockIn(DC);
  let prev = DA;
  for (const nx of [DB, DA, DC]) {
    await S.write(`reassign → ${nx}`, { 'tasks/m1_delivery/assigned_driver_id': nx, 'tasks/m1_pickup/assigned_driver_id': nx, [`drivers/${prev}/current_task_id`]: null, [`drivers/${nx}/current_task_id`]: 'm1_delivery' });
    prev = nx;
  }
  await complete(S, 'm1', DC);
});
// POPULATED LIVE-claim SWEEP scenarios (codex build r2 P2-3): N live claims — half LEGITIMATE (out_for_delivery, node live for the
// claimant, the claimant still the delivery assignee), half STALE (terminal orders) — then ONE validation sweep, counted alone
// (reads / bytes / transactions / writes). The stale half must be tombstoned and the legitimate half kept.
async function sweepScenario(N) {
  const { tagOf } = require('./tracking/tag');
  await db.ref('/').set(null);
  const u = {};
  for (let i = 0; i < N; i += 1) {
    const oid = `sw${i}`, legit = i % 2 === 0, uid = `u_sweep_${String(i).padStart(18, '0')}`;
    u[`orders/${oid}`] = { order_id: oid, status: legit ? 'out_for_delivery' : 'delivered', tracking_token: `TOK_${oid}`, created_at: i + 1, ...(legit ? {} : { delivered_at: Date.now() - 1000 }) };
    u[`tasks/${oid}_delivery`] = { order_id: oid, type: 'delivery', status: legit ? 'in_progress' : 'completed', assigned_driver_id: uid, created_at: i + 1 };
    u[`order_tracking/TOK_${oid}`] = { order_id: oid, status: legit ? 'out_for_delivery' : 'delivered', mx: { seq: 5, mode: legit ? 'live' : 'terminal', owner_tag: legit ? tagOf(process.env.MAKE_SECRET, uid) : 'none', epoch: 1 } };
    u[`tracker_claims/${uid}/${oid}`] = { seq: 5, gone: false, at: 1 };
  }
  await db.ref().update(u);
  cur = zero();
  C.measuring += 1;
  let r;
  try { r = await require('./tracking/tombstones').sweepTrackerTombstones(db, Date.now()); } finally { C.measuring -= 1; }
  const out = { ...cur, n: N, staled: r.validated.staled, keptLive: r.validated.kept, failures: 0, liveClaims: 0 };
  if (r.validated.staled !== N / 2 || r.validated.kept !== N / 2) { console.error(`measure: sweep${N} validated ${r.validated.staled} stale / ${r.validated.kept} kept (want ${N / 2} / ${N / 2})`); process.exit(2); }
  cur = zero();
  return out;
}
for (const N of [24, 100]) if (want(`sweep${N}`)) scenarios[`sweep${N}`] = await sweepScenario(N);

fs.writeFileSync(args.out, JSON.stringify({ flag: args.flag, scenarios, ...(args.breakdown ? { breakdown: Object.fromEntries(Object.entries(BREAK).sort((a, b) => b[1] - a[1])) } : {}) }, null, 1) + '\n');
console.log(`tracker-measure (${args.flag}): ${Object.entries(scenarios).map(([k, v]) => `${k} inv=${v.invocations} reads=${v.reads} fail=${v.failures}`).join(' | ')}`);
process.exit(0);
