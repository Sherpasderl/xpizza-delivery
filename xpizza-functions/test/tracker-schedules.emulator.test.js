'use strict';
// TRACKER FIXES T7 (BUILD-tracker-fixes r1.5 §3.2 = PLAN §7) — the ADVERSARIAL SCHEDULES, driven through the REAL exported triggers
// of index.js (flag ON) on the RTDB emulator. Run: npm run test:tracker-schedules
//
// Mechanics:
//   - truth is written with Admin `commit(updates)`; the events it causes are derived from the PRE/POST values of every watched leaf
//     (orders/{id}/status, tasks/{id}/assigned_driver_id|status, drivers/{uid}/current_task_id|active|current_shift_id) and returned
//     as THUNKS — a schedule delivers them in the order it chooses, delays them, or delivers them twice;
//   - delivery runs the REAL export's `.run(event)`; a throw is re-delivered only if the export says retry:true;
//   - holds at event delivery (the schedule's choice), seq acquisition, each truth read, the node transaction, the claims write,
//     and ingest auth / epoch capture / commit go through the production seam (tracking/hold.js → globalThis.__trackerHold);
//   - ingest is the REAL HTTP export (express adapter) with a REAL native shift token from startDriverShift;
//   - THE INVARIANT (no stale revival): a monitor reads every node after every delivery/commit; mx.seq never decreases, and once a
//     node is terminal it stays terminal. At the end of each schedule: node == derive(final truth) (a fresh recompute changes no
//     visible field) and no LIVE claim remains for a terminal order.
// Real client writers (driver / dispatch SDKs under production rules) are exercised by the golden journeys (test:tracker-golden);
// here truth is written by Admin so the schedule — not a client round-trip — controls every interleaving.
require('./_emulator-required')('database');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'sched-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { recomputeOrderTracker } = require('../tracking/recompute');
const { driverFanout } = require('../tracking/fanout');
const flag = require('../tracking/flag');
const { sweepTrackerTombstones, validateLiveClaims } = require('../tracking/tombstones');
Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });
const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const v = async (p) => (await db.ref(p).once('value')).val();
const clone = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
const snap = (x) => ({ val: () => clone(x), exists: () => x !== null && x !== undefined });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RID = 'tb_centro', HUB = { lat: 15.5, lng: -88.03 };
const DA = 'u_sched_a00000000000000', DB = 'u_sched_b00000000000000', DC = 'u_sched_c00000000000000';
const NAMES = { [DA]: 'ana', [DB]: 'beto', [DC]: 'cris' };

// ── holds (the production seam) ─────────────────────────────────────────────────────────────────────────────────────
const holds = [];
globalThis.__trackerHold = async (name, ctx) => {
  for (const h of holds) if (!h.used && h.name === name && h.match(ctx || {})) { h.used = true; h.reachedResolve(ctx); await h.gate; if (h.throwOnRelease) throw h.throwOnRelease; return; }
};
function hold(name, match = () => true, opts = {}) {
  let open, reachedResolve; const gate = new Promise((r) => { open = r; }); const reached = new Promise((r) => { reachedResolve = r; });
  const h = { name, match, gate, reachedResolve, used: false, throwOnRelease: opts.throwOnRelease || null };
  holds.push(h);
  return { reached, release: () => open(), h };
}

// ── the invariant monitor ───────────────────────────────────────────────────────────────────────────────────────────
const tokens = new Set(); const maxSeq = new Map(); const wasTerminal = new Set(); const history = [];
async function observe(label) {
  for (const t of tokens) {
    const mx = await v(`order_tracking/${t}/mx`);
    if (!mx) continue;
    const prev = maxSeq.get(t) || 0;
    assert.ok(mx.seq >= prev, `🔴 STALE REVIVAL on ${t} at "${label}": mx.seq ${mx.seq} < previously committed ${prev}`);
    maxSeq.set(t, mx.seq);
    if (wasTerminal.has(t)) assert.strictEqual(mx.mode, 'terminal', `🔴 terminal REGRESSED on ${t} at "${label}" (${mx.mode})`);
    if (mx.mode === 'terminal') wasTerminal.add(t);
    history.push([label, t, mx.seq, mx.mode]);
  }
}

// ── events from truth writes ────────────────────────────────────────────────────────────────────────────────────────
const LEAVES = [
  [/^orders\/([^/]+)\/status$/, ['trackerOnOrderStatus', 'clearTrackerMirrorOnDone'], (m) => ({ orderId: m[1] })],
  [/^tasks\/([^/]+)\/assigned_driver_id$/, ['trackerOnTaskOwner'], (m) => ({ taskId: m[1] })],
  [/^tasks\/([^/]+)\/status$/, ['trackerOnTaskStatus'], (m) => ({ taskId: m[1] })],
  [/^drivers\/([^/]+)\/current_task_id$/, ['trackerOnDriverPointer'], (m) => ({ uid: m[1] })],
  [/^drivers\/([^/]+)\/active$/, ['trackerOnDriverActive'], (m) => ({ uid: m[1] })],
  [/^drivers\/([^/]+)\/current_shift_id$/, ['trackerOnDriverShiftId'], (m) => ({ uid: m[1] })],
];
const leavesUnder = (p) => {
  const parts = p.split('/');
  if (parts[0] === 'orders' && parts.length <= 2) return [`orders/${parts[1]}/status`];
  if (parts[0] === 'tasks' && parts.length <= 2) return [`tasks/${parts[1]}/assigned_driver_id`, `tasks/${parts[1]}/status`];
  if (parts[0] === 'drivers' && parts.length <= 2) return ['current_task_id', 'active', 'current_shift_id'].map((k) => `drivers/${parts[1]}/${k}`);
  return [p];
};
let deliveries = 0;
async function deliver(ev) {
  const fn = app[ev.name];
  const retry = !!(fn.__endpoint && fn.__endpoint.eventTrigger && fn.__endpoint.eventTrigger.retry);
  for (let attempt = 0; ; attempt += 1) {
    try { deliveries += 1; await fn.run({ params: ev.params, data: { before: snap(ev.before), after: snap(ev.after) } }); break; }
    catch (e) { if (!retry || attempt >= 3) throw e; }
  }
  await observe(`${ev.name}:${JSON.stringify(ev.params)}`);
}
async function commit(updates) {
  const leaves = [...new Set(Object.keys(updates).flatMap(leavesUnder))];
  const pre = {}; for (const l of leaves) pre[l] = await v(l);
  await db.ref().update(updates);
  const evs = [];
  for (const l of leaves) {
    const after = await v(l);
    if (JSON.stringify(after) === JSON.stringify(pre[l])) continue;
    for (const [re, names, params] of LEAVES) {
      const m = re.exec(l); if (!m) continue;
      for (const name of names) evs.push({ name, params: params(m), before: pre[l], after, leaf: l });
    }
  }
  await observe(`commit ${Object.keys(updates).join(',')}`);
  return evs;
}
const deliverAll = async (evs) => { for (const e of evs) await deliver(e); };
const step = async (updates) => deliverAll(await commit(updates));

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────
// the PRODUCTION rules on index.js's Admin namespace: Admin bypasses rule ENFORCEMENT, but the rules' .indexOn are what production
// queries run against (the emulator rule-binds only the default namespace otherwise)
let rulesLoaded = false;
async function loadRules() {
  if (rulesLoaded) return; rulesLoaded = true;
  const ns = new URL(db.app.options.databaseURL).hostname.split('.')[0];
  const rules = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
  const r = await fetch(`http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
  assert.ok(r.ok, `production rules loaded into ns=${ns}`);
}
async function reset() {
  await loadRules();
  await db.ref('/').set(null);
  tokens.clear(); maxSeq.clear(); wasTerminal.clear(); history.length = 0; holds.length = 0;
  await db.ref().update({
    'config/tracker_fixes_enabled': true, 'config/whatsapp_enabled': false,
    [`restaurants/${RID}/identity`]: { active: true, name: 'TB', phone: '+50400000000', hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 10, version: 1 },
    ...Object.fromEntries([DA, DB, DC].map((u) => [`drivers/${u}`, { name: NAMES[u], status: 'available', active: false }])),
  });
  flag._resetForTest();
}
let created = 0;
function orderUpdates(oid, { status = 'ready', owner = null, pickup = owner ? 'accepted' : 'pending', delivery = owner ? 'accepted' : 'pending' } = {}) {
  const tok = `TOK_${oid}`; tokens.add(tok); created += 1;
  return {
    [`orders/${oid}`]: { order_id: oid, status, tracking_token: tok, restaurant_id: RID, hub_lat: HUB.lat, hub_lng: HUB.lng, lat: 15.52, lng: -88.01, created_at: 1000 + created },
    [`order_tracking/${tok}`]: { order_id: oid, status },
    [`tasks/${oid}_pickup`]: { order_id: oid, type: 'pickup', status: pickup, assigned_driver_id: owner, restaurant_id: RID, created_at: 1000 + created },
    [`tasks/${oid}_delivery`]: { order_id: oid, type: 'delivery', status: delivery, assigned_driver_id: owner, restaurant_id: RID, created_at: 1000 + created },
  };
}
// startDriverShift writes drivers/{uid}/{active,current_shift_id}; deliver those trigger events explicitly (it is not a commit())
async function clockInAndDeliver(uid) {
  const pre = { a: await v(`drivers/${uid}/active`), s: await v(`drivers/${uid}/current_shift_id`) };
  const r = await app.startDriverShift.run({ auth: { uid, token: { uid } }, data: { platform: 'native' }, rawRequest: { headers: {} } });
  const post = { a: await v(`drivers/${uid}/active`), s: await v(`drivers/${uid}/current_shift_id`) };
  await observe(`clock-in ${uid}`);
  if (pre.a !== post.a) await deliver({ name: 'trackerOnDriverActive', params: { uid }, before: pre.a, after: post.a });
  if (pre.s !== post.s) await deliver({ name: 'trackerOnDriverShiftId', params: { uid }, before: pre.s, after: post.s });
  return r.ingest_token;
}
let lngStep = 0;
async function ingest(token, { ageMs = 1000, ts } = {}) {
  lngStep += 1;
  const body = { locations: [{ ts: ts != null ? ts : Date.now() - ageMs, lat: 15.51, lng: -88.02 + lngStep * 0.005, accuracy: 10 }] };
  const w = express(); w.use(express.json()); w.use(app.ingestDriverLocation);
  const res = await new Promise((resolve, reject) => {
    const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try { const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-driver-token': token }, body: JSON.stringify(body) }); const t = await r.text(); server.close(() => resolve({ status: r.status, text: t })); }
      catch (e) { server.close(() => reject(e)); }
    });
  });
  await observe('ingest');
  return { ...res, sample: body.locations[0] };
}
const node = (oid) => v(`order_tracking/TOK_${oid}`);
async function converged(oid, label) {
  const before = await node(oid);
  await recomputeOrderTracker(db, oid);
  const after = await node(oid);
  const vis = (x) => JSON.stringify({ ...x, mx: x && x.mx ? { ...x.mx, seq: 0 } : null });
  assert.strictEqual(vis(after), vis(before), `${label}: node == derive(final truth) — a fresh recompute changes no visible field`);
  await observe(`converged ${oid}`);
}
async function noLiveClaims(oid) {
  const claims = (await v('tracker_claims')) || {};
  for (const [uid, byOrder] of Object.entries(claims)) {
    const e = byOrder && byOrder[oid];
    assert.ok(!e || e.gone === true, `no LIVE claim for terminal ${oid} (uid ${uid}: ${JSON.stringify(e)})`);
  }
}
// a driver live on an order: clocked in, holds both legs, pickup completed, pointer at the delivery leg, order out_for_delivery
async function liveOn(uid, oid, extra = {}) {
  const token = await clockInAndDeliver(uid);
  await step({ ...orderUpdates(oid, { status: 'out_for_delivery', owner: uid, pickup: 'completed', delivery: 'in_progress' }), [`drivers/${uid}/current_task_id`]: `${oid}_delivery`, ...extra });
  return token;
}

(async () => {
  const watchdog = setTimeout(() => { console.error('tracker-schedules: FAIL — timed out'); process.exit(1); }, 1500000);

  // (a) lone pickup → live; stacked A,B pointer at the older → A live, B waiting; pointer at the NEWER (the swipe) → both neutral
  await reset();
  await liveOn(DA, 'A1');
  assert.strictEqual((await node('A1')).mx.mode, 'live');
  await step({ ...orderUpdates('A2', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'accepted' }) });
  assert.deepStrictEqual([(await node('A1')).mx.mode, (await node('A2')).mx.mode], ['live', 'waiting']);
  await step({ [`drivers/${DA}/current_task_id`]: 'A2_delivery' });
  assert.deepStrictEqual([(await node('A1')).mx.mode, (await node('A2')).mx.mode], ['neutral', 'neutral'], 'pointer at the newer order (not the app\'s sort-first) → both neutral');
  await converged('A1', '(a)'); await converged('A2', '(a)');
  ok('(a) lone pickup → live; stacked (pointer at the older) → live + waiting; pointer at the newer (swipe) → both neutral, matching the app\'s sort-first');

  // (b) the older order delivered: its recompute is delivered BEFORE the sibling's pointer event → the sibling converges to live
  await reset();
  await liveOn(DA, 'B1');
  await step({ ...orderUpdates('B2', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'accepted' }) });
  const evB = await commit({ 'orders/B1/status': 'delivered', 'tasks/B1_delivery/status': 'completed', [`drivers/${DA}/current_task_id`]: 'B2_delivery' });
  const order = ['trackerOnOrderStatus', 'clearTrackerMirrorOnDone', 'trackerOnTaskStatus', 'trackerOnDriverPointer'];
  await deliverAll(evB.sort((x, y) => order.indexOf(x.name) - order.indexOf(y.name)));
  assert.deepStrictEqual([(await node('B1')).mx.mode, (await node('B2')).mx.mode], ['terminal', 'live']);
  await converged('B2', '(b)'); await noLiveClaims('B1');
  ok('(b) the older order\'s delivered recompute runs BEFORE the sibling\'s pointer event → the sibling converges to live; no live claim on the terminal one');

  // (c) a pickup event delivered AFTER the order's terminal edge → no regression
  await reset();
  await clockInAndDeliver(DA);
  await step(orderUpdates('C1', { status: 'ready', owner: DA }));
  const evPick = await commit({ 'orders/C1/status': 'out_for_delivery', 'tasks/C1_pickup/status': 'completed', [`drivers/${DA}/current_task_id`]: 'C1_delivery' });
  await step({ 'orders/C1/status': 'delivered', 'tasks/C1_delivery/status': 'completed', [`drivers/${DA}/current_task_id`]: null });
  await deliverAll(evPick);   // the stale pickup events arrive last
  assert.strictEqual((await node('C1')).mx.mode, 'terminal');
  await converged('C1', '(c)'); await noLiveClaims('C1');
  ok('(c) pickup events delivered after the terminal edge → terminal stands (no regression)');

  // (d) a paused ingest (held at COMMIT) resuming after each of: complete, cancel, reassign, shift end, back-on-shift → aborted
  // positive control: the SAME held ingest, released with NO transition, lands (so the aborts below are the fences, not a dud ingest)
  {
    await reset();
    const tok = await liveOn(DA, 'D0');
    const h = hold('ingest:commit', (c) => c.orderId === 'D0');
    const p = ingest(tok, { ageMs: 500 });
    await h.reached; h.release(); const r0 = await p;
    const d0 = await node('D0');
    assert.ok(d0.driver_location && d0.driver_location.lng === r0.sample.lng, `positive control: an undisturbed held ingest lands (${JSON.stringify(d0.driver_location)})`);
  }
  const dCases = [
    ['complete', async () => step({ 'orders/D1/status': 'delivered', 'tasks/D1_delivery/status': 'completed', [`drivers/${DA}/current_task_id`]: null })],
    ['cancel', async () => step({ 'orders/D1/status': 'cancelled', 'tasks/D1_delivery/status': 'cancelled', 'tasks/D1_pickup/status': 'cancelled', [`drivers/${DA}/current_task_id`]: null })],
    ['reassign', async () => { await clockInAndDeliver(DB); await step({ 'tasks/D1_delivery/assigned_driver_id': DB, 'tasks/D1_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'D1_delivery' }); }],
    ['shift end', async () => step({ [`drivers/${DA}/active`]: false })],
    ['back on shift', async () => { await step({ [`drivers/${DA}/active`]: false }); await clockInAndDeliver(DA); }],
  ];
  for (const [label, transition] of dCases) {
    await reset();
    const tok = await liveOn(DA, 'D1');
    const h = hold('ingest:commit', (c) => c.orderId === 'D1');
    const p = ingest(tok, { ageMs: 500 });
    await h.reached;
    await transition();
    const mid = await node('D1');
    h.release(); await p;
    const fin = await node('D1');
    assert.strictEqual(fin.driver_location ?? null, mid.driver_location ?? null, `(d) ${label}: the paused ingest did not land`);
    assert.strictEqual(JSON.stringify(fin.mx), JSON.stringify(mid.mx), `(d) ${label}: mx untouched by the paused ingest`);
  }
  ok('(d) an ingest paused at commit resuming after complete / cancel / reassign / shift end / back-on-shift → aborted every time');

  // (e) owner events out of order: A→B processed AFTER B→C → the final owner/name is C
  await reset();
  for (const u of [DA, DB, DC]) await clockInAndDeliver(u);
  await step({ ...orderUpdates('E1', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'in_progress' }), [`drivers/${DA}/current_task_id`]: 'E1_delivery' });
  const ab = await commit({ 'tasks/E1_delivery/assigned_driver_id': DB, 'tasks/E1_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'E1_delivery' });
  const bc = await commit({ 'tasks/E1_delivery/assigned_driver_id': DC, 'tasks/E1_pickup/assigned_driver_id': DC, [`drivers/${DB}/current_task_id`]: null, [`drivers/${DC}/current_task_id`]: 'E1_delivery' });
  await deliverAll(bc); await deliverAll(ab);
  const e1 = await node('E1');
  assert.strictEqual(e1.mx.mode, 'live'); assert.strictEqual(e1.mx.name, 'Cris', `final name is C's (${e1.mx.name})`);
  await converged('E1', '(e)');
  ok('(e) owner events delivered out of order (A→B after B→C) → final owner and name are C');

  // (f) cancel cleanup's pointer write lands AFTER the cancel recompute → the pointer trigger recomputes → consistent
  await reset();
  await liveOn(DA, 'F1');
  await step({ 'orders/F1/status': 'cancelled', 'tasks/F1_delivery/status': 'cancelled', 'tasks/F1_pickup/status': 'cancelled' });
  assert.strictEqual((await node('F1')).mx.mode, 'terminal');
  await step({ [`drivers/${DA}/current_task_id`]: null, [`drivers/${DA}/status`]: 'available' });
  assert.strictEqual((await node('F1')).mx.mode, 'terminal');
  await converged('F1', '(f)'); await noLiveClaims('F1');
  ok('(f) the cancel cleanup\'s pointer write after the cancel recompute → still terminal and consistent; no live claim');

  // (g) duplicate events → no customer-visible change; an older-sample replay and a future-dated sample are rejected
  await reset();
  const gTok = await liveOn(DA, 'G1');
  await ingest(gTok, { ageMs: 1000 });
  const g0 = await node('G1');
  const dup = await commit({ [`drivers/${DA}/current_task_id`]: 'G1_pickup' }); await deliverAll(dup);
  const back = await commit({ [`drivers/${DA}/current_task_id`]: 'G1_delivery' });
  await deliverAll(back); await deliverAll(back);   // duplicated delivery
  const g1 = await node('G1');
  assert.strictEqual(g1.mx.mode, 'live');
  await deliverAll(back);
  const g2 = await node('G1');
  const visible = (x) => JSON.stringify({ ...x, mx: { ...x.mx, seq: 0 } });
  assert.strictEqual(visible(g2), visible(g1), 'a duplicate event changes no visible field (only mx.seq)');
  const sampleAt = g2.mx.smp.sample_at;
  await ingest(gTok, { ts: sampleAt - 5000 });
  assert.strictEqual((await node('G1')).mx.smp.sample_at, sampleAt, 'an older-sample replay is rejected (watermark)');
  await ingest(gTok, { ts: Date.now() + 60000 });
  assert.strictEqual((await node('G1')).mx.smp.sample_at, sampleAt, 'a future-dated sample is rejected (window)');
  assert.ok(g0.driver_location, 'premise: a location existed');
  ok('(g) duplicate events → no visible change (mx.seq only); an older-sample replay and a future-dated sample are rejected');

  // (h) WhatsApp disabled: the tracker still carries the driver name; a reassign changes the name
  await reset();
  await liveOn(DA, 'H1');
  assert.strictEqual((await v('config/whatsapp_enabled')), false, 'premise: WhatsApp disabled');
  assert.strictEqual((await node('H1')).mx.name, 'Ana');
  await clockInAndDeliver(DB);
  await step({ 'tasks/H1_delivery/assigned_driver_id': DB, 'tasks/H1_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'H1_delivery' });
  assert.strictEqual((await node('H1')).mx.name, 'Beto');
  ok('(h) with WhatsApp disabled the tracker still has the driver name; a reassign changes it');

  // (i) a forced dispatch shift end → neutral
  await reset();
  await liveOn(DA, 'I1');
  await step({ [`drivers/${DA}/active`]: false, [`drivers/${DA}/current_shift_id`]: null });
  assert.strictEqual((await node('I1')).mx.mode, 'neutral');
  assert.strictEqual((await node('I1')).driver_location ?? null, null);
  await converged('I1', '(i)');
  ok('(i) a forced shift end → neutral, location cleared');

  // codex r2 P1-1: A's recompute paused (after reading tasks), reassigned to B, B publishes; A resumes → aborted
  await reset();
  await liveOn(DA, 'P1');
  await clockInAndDeliver(DB);
  const hp = hold('read:tasks', (c) => c.orderId === 'P1');
  const stale = recomputeOrderTracker(db, 'P1');
  await hp.reached;
  await step({ 'tasks/P1_delivery/assigned_driver_id': DB, 'tasks/P1_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'P1_delivery' });
  const bState = await node('P1');
  hp.release(); const sr = await stale;
  assert.strictEqual(sr.committed, false, 'the paused A recompute aborts');
  assert.strictEqual(JSON.stringify((await node('P1')).mx), JSON.stringify(bState.mx), 'B\'s published state stands');
  await observe('P1 after release');
  ok('codex r2 P1-1: a recompute paused after reading A\'s tasks, overtaken by B\'s publish, resumes → aborted; B\'s state stands');

  // the real two-step dispatch reassign (delivery owner first, then pickup) observed at the intermediate → neutral
  await reset();
  await liveOn(DA, 'R1'); await clockInAndDeliver(DB);
  await step({ 'tasks/R1_delivery/assigned_driver_id': DB });
  const mid = await node('R1');
  assert.strictEqual(mid.mx.mode, 'neutral', `split legs (delivery B, pickup A) → neutral (${mid.mx.mode})`);
  assert.strictEqual(mid.driver_location ?? null, null);
  await step({ 'tasks/R1_pickup/assigned_driver_id': DB, 'tasks/R1_delivery/status': 'assigned', [`drivers/${DA}/current_task_id`]: null });
  assert.notStrictEqual((await node('R1')).mx.mode, 'live', 'not live until B accepts and points at it');
  ok('two-step reassign: the intermediate (split legs) is neutral with no location; never live before B takes it');

  // a paused pre-delivery status writer (held at its node transaction) resuming after terminal → aborted
  await reset();
  await liveOn(DA, 'T1');
  const ht = hold('node-tx', (c) => c.orderId === 'T1' && c.mode === 'live');
  const pre = recomputeOrderTracker(db, 'T1');
  await ht.reached;
  await step({ 'orders/T1/status': 'delivered', 'tasks/T1_delivery/status': 'completed', [`drivers/${DA}/current_task_id`]: null });
  ht.release(); const pr = await pre;
  assert.strictEqual(pr.committed, false); assert.strictEqual((await node('T1')).mx.mode, 'terminal');
  await observe('T1'); await noLiveClaims('T1');
  ok('a pre-delivery recompute paused at its node transaction resumes after terminal → aborted (seq / terminal guard)');

  // deletion of the tasks BEFORE the terminal recompute → terminal from the order
  await reset();
  await liveOn(DA, 'X1');
  const evDel = await commit({ 'tasks/X1_pickup': null, 'tasks/X1_delivery': null, 'orders/X1/status': 'delivered', [`drivers/${DA}/current_task_id`]: null });
  await deliverAll(evDel.filter((e) => e.name !== 'trackerOnOrderStatus' && e.name !== 'clearTrackerMirrorOnDone'));
  await deliverAll(evDel.filter((e) => e.name === 'trackerOnOrderStatus' || e.name === 'clearTrackerMirrorOnDone'));
  assert.strictEqual((await node('X1')).mx.mode, 'terminal'); await noLiveClaims('X1');
  ok('tasks deleted before the terminal recompute → terminal from the order; no live claim');

  // ingest paused BEFORE vs AFTER epoch capture across shift end + new shift → aborted
  for (const at of ['ingest:auth', 'ingest:epoch']) {
    await reset();
    const tok = await liveOn(DA, 'S1');
    const hs = hold(at, (c) => c.uid === DA);
    const p = ingest(tok, { ageMs: 500 });
    await hs.reached;
    await step({ [`drivers/${DA}/active`]: false });
    await clockInAndDeliver(DA);   // new shift, same driver, still pointing at S1
    const m = await node('S1');
    hs.release(); await p;
    assert.strictEqual((await node('S1')).driver_location ?? null, m.driver_location ?? null, `${at}: the old-shift ingest never lands on the new shift`);
  }
  ok('an ingest paused before (auth) or after (epoch) epoch capture, across shift end + a new shift → aborted');

  // live without a location → gen-1 no-countdown encoding
  await reset();
  await liveOn(DA, 'L1');
  const l1 = await node('L1');
  assert.strictEqual(l1.mx.mode, 'live'); assert.strictEqual(l1.is_active_drop ?? null, null); assert.strictEqual(l1.driver_name ?? null, null);
  ok('live without a location → gen-1 encoding (null, null): the no-countdown branch');

  // B granted live before A's cleanup → no A coordinates on B
  await reset();
  const aTok = await liveOn(DA, 'K1');
  await ingest(aTok, { ageMs: 500 });
  assert.ok((await node('K1')).driver_location, 'premise: A\'s location is on the node');
  await clockInAndDeliver(DB);
  const evK = await commit({ 'tasks/K1_delivery/assigned_driver_id': DB, 'tasks/K1_pickup/assigned_driver_id': DB, [`drivers/${DB}/current_task_id`]: 'K1_delivery', [`drivers/${DA}/current_task_id`]: null });
  await deliverAll(evK.filter((e) => e.leaf.startsWith(`drivers/${DB}`) || e.leaf.startsWith('tasks/')));   // B's grant first
  const k1 = await node('K1');
  assert.strictEqual(k1.mx.name, 'Beto'); assert.strictEqual(k1.driver_location ?? null, null, 'no A coordinates under B');
  await deliverAll(evK.filter((e) => e.leaf.startsWith(`drivers/${DA}`)));
  assert.strictEqual((await node('K1')).driver_location ?? null, null);
  ok('B granted live before A\'s cleanup → A\'s coordinates are never shown under B');

  // the same-shift watermark: S1 (t1) paused at commit; S2 (t2 > t1) publishes; live → neutral → live (same shift); S1 resumes → aborted
  await reset();
  const wTok = await liveOn(DA, 'W1');
  const hw = hold('ingest:commit', (c) => c.orderId === 'W1');
  const s1 = ingest(wTok, { ageMs: 3000 });
  await hw.reached;
  hw.h.used = true;
  const s2 = await ingest(wTok, { ageMs: 500 });
  const t2 = (await node('W1')).mx.smp.sample_at;
  assert.strictEqual(t2, s2.sample.ts, 'premise: S2 published');
  await step({ [`drivers/${DA}/current_task_id`]: 'W1_pickup' });
  assert.strictEqual((await node('W1')).mx.mode, 'neutral');
  await step({ [`drivers/${DA}/current_task_id`]: 'W1_delivery' });
  assert.strictEqual((await node('W1')).mx.mode, 'live');
  hw.release(); await s1;
  const w1 = await node('W1');
  assert.strictEqual(w1.mx.smp.sample_at, t2, 'the older same-shift sample S1 is rejected by the watermark');
  ok('same-shift watermark: an older sample paused at commit, a newer one published, live → neutral → live, resume → aborted');
  // the PURE watermark case: nothing else changes (same mode, owner, shift AND epoch) — only the watermark can reject the older sample
  {
    await reset();
    const tok = await liveOn(DA, 'W2');
    const h = hold('ingest:commit', (c) => c.orderId === 'W2');
    const older = ingest(tok, { ageMs: 3000 });
    await h.reached;
    const newer = await ingest(tok, { ageMs: 500 });
    const e0 = (await node('W2')).mx.epoch;
    h.release(); await older;
    const w2 = await node('W2');
    assert.strictEqual(w2.mx.epoch, e0, 'premise: the epoch did not change (the epoch fence cannot be what rejects it)');
    assert.strictEqual(w2.mx.smp.sample_at, newer.sample.ts, 'the older sample is rejected by the watermark alone');
    assert.strictEqual(w2.driver_location.lng, newer.sample.lng, 'the newer location stands');
  }
  ok('pure watermark: an older sample paused at commit while a newer one publishes (same mode/owner/shift/epoch) → rejected by the watermark alone');

  // claims churn: A→B→A→C with interleaved + duplicated recomputes, then terminal → no live claim anywhere; tombstone seqs ≥ terminal
  await reset();
  for (const u of [DA, DB, DC]) await clockInAndDeliver(u);
  await step({ ...orderUpdates('Z1', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'in_progress' }), [`drivers/${DA}/current_task_id`]: 'Z1_delivery' });
  let cur = DA;
  for (const nx of [DB, DA, DC]) {
    const evs = await commit({ 'tasks/Z1_delivery/assigned_driver_id': nx, 'tasks/Z1_pickup/assigned_driver_id': nx, [`drivers/${cur}/current_task_id`]: null, [`drivers/${nx}/current_task_id`]: 'Z1_delivery' });
    await deliverAll([...evs].reverse()); await deliverAll(evs.slice(0, 2));   // interleaved order + duplicates
    cur = nx;
  }
  const g6 = hold('claims', (c) => c.orderId === 'Z1');
  const heldGrant = recomputeOrderTracker(db, 'Z1');
  await g6.reached;
  const term = await commit({ 'orders/Z1/status': 'delivered', 'tasks/Z1_delivery/status': 'completed', [`drivers/${DC}/current_task_id`]: null });
  await deliverAll(term);
  const termSeq = (await node('Z1')).mx.seq;
  g6.release(); await heldGrant;
  await noLiveClaims('Z1');
  const claims = (await v('tracker_claims')) || {};
  for (const byOrder of Object.values(claims)) if (byOrder && byOrder.Z1) assert.ok(byOrder.Z1.seq >= termSeq || byOrder.Z1.gone, `tombstone seq ${byOrder.Z1.seq} vs terminal ${termSeq}`);
  ok(`claims churn A→B→A→C (interleaved, duplicated) + a held grant released after the terminal tombstone → no live claim; ${deliveries} deliveries so far`);

  // REGRESSION (codex r2.9 P1-1, against the CURRENT code) — B's FIRST live grant. B holds the order PRE (no claim entry yet); the
  // pickup commits; the REAL trackerOnOrderStatus delivery recomputes LIVE for B, passes stillMine and is HELD before its grant txn
  // (the sibling pickup events stay in flight). The order is reassigned to C, then cancelled + terminal-cleaned — neither touches B
  // (no hint names B yet). B resumes: its s grant lands on an ABSENT entry (LIVE). What tombstones it is the SAME trigger's
  // driverFanout(B) that follows — the load-bearing second recompute that (A) would have skipped. After every delayed writer
  // (incl. the late sibling events): no LIVE claim for the order anywhere.
  const firstGrant = async (label, between, { openWindow = true } = {}) => {
    await reset();
    for (const u of [DA, DB]) await clockInAndDeliver(u);
    await step({ ...orderUpdates('Q1', { status: 'ready', owner: DA }), [`drivers/${DA}/current_task_id`]: 'Q1_pickup' });
    const pre0 = await v(`tracker_claims/${DA}/Q1`);
    assert.ok(!pre0 || pre0.gone === true, `${label}: premise: B has no LIVE claim before going live (${JSON.stringify(pre0)})`);
    const evs = await commit({ 'orders/Q1/status': 'out_for_delivery', 'tasks/Q1_pickup/status': 'completed', 'tasks/Q1_delivery/status': 'in_progress', [`drivers/${DA}/current_task_id`]: 'Q1_delivery' });
    const statusEv = evs.find((e) => e.name === 'trackerOnOrderStatus');
    const hq = hold('claims:grant', (c) => c.orderId === 'Q1' && c.owner === DA);
    const heldTrigger = deliver(statusEv);
    const ctx = await hq.reached;
    assert.ok(!pre0 || pre0.seq < ctx.s, `${label}: premise: the held grant's seq ${ctx.s} is above B's earlier tombstone (${pre0 && pre0.seq}) — it WILL apply on release`);
    await between();
    const mid = await v(`tracker_claims/${DA}/Q1`);
    if (openWindow) assert.ok(!mid || mid.seq < ctx.s, `${label}: premise: nothing tombstoned B above the held seq while it was paused (${JSON.stringify(mid)}) — the window is open`);
    assert.strictEqual((await node('Q1')).mx.mode, 'terminal', `${label}: premise: terminal before B resumes`);
    hq.release(); await heldTrigger;
    await deliverAll(evs.filter((e) => e !== statusEv));   // the late sibling pickup events
    await observe(`Q1 ${label}`);
    await noLiveClaims('Q1');
    const b = await v(`tracker_claims/${DA}/Q1`);
    assert.ok(b && b.gone === true && b.seq > ctx.s, `${label}: B's late first grant (s=${ctx.s}) ends tombstoned above it (${JSON.stringify(b)})`);
    return { s: ctx.s, b, closedBeforeRelease: !!(mid && mid.seq > ctx.s) };
  };
  const toC = { 'tasks/Q1_delivery/assigned_driver_id': DB, 'tasks/Q1_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'Q1_delivery' };
  const toB = { 'tasks/Q1_delivery/assigned_driver_id': DA, 'tasks/Q1_pickup/assigned_driver_id': DA, [`drivers/${DB}/current_task_id`]: null, [`drivers/${DA}/current_task_id`]: 'Q1_delivery' };
  const cancelQ = { 'orders/Q1/status': 'cancelled', 'tasks/Q1_pickup/status': 'cancelled', 'tasks/Q1_delivery/status': 'cancelled', [`drivers/${DB}/current_task_id`]: null };
  const r1 = await firstGrant('codex schedule', async () => { await step(toC); await step(cancelQ); });
  ok(`regression (codex r2.9 P1-1): B's FIRST live grant held after stillMine (s=${r1.s}) → reassign to C → cancel + cleanup → released → B tombstoned by its own trigger's fan-out (seq ${r1.b.seq}); no LIVE claim remains`);
  const r2 = await firstGrant('with reassignment back', async () => { await step(toC); await step(toB); await step(toC); await step(cancelQ); }, { openWindow: false });
  ok(`regression, with reassignment BACK (C → B → C) before the cancel: B's held first grant (s=${r2.s}) released → no LIVE claim remains (B seq ${r2.b.seq}, gone; window closed before release by the back-and-forth: ${r2.closedBeforeRelease})`);

  // ── codex build r1 P1-1 (ruling: claims are ADVISORY; the 6-hourly sweep VALIDATES live claims) ────────────────────────────────
  const liveClaimsOn = async (oid) => Object.entries((await v('tracker_claims')) || {}).filter(([, b]) => b && b[oid] && b[oid].gone === false).map(([u]) => u);
  // (i) the delayed grant INSIDE the fan-out: B goes live through its OWN pointer-trigger fan-out, held after stillMine; reassign to C
  // + cancel complete; B's late s grant lands LIVE and its fan-out does not clean it (claimOwner === B) → a residual LIVE claim
  {
    await reset();
    for (const u of [DA, DB]) await clockInAndDeliver(u);
    await step({ ...orderUpdates('Y1', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'in_progress' }) });   // pointer not set yet → not live
    const evs = await commit({ [`drivers/${DA}/current_task_id`]: 'Y1_delivery' });
    const hy = hold('claims:grant', (c) => c.orderId === 'Y1' && c.owner === DA);
    const fan = deliver(evs.find((e) => e.name === 'trackerOnDriverPointer'));
    await hy.reached;
    await step({ 'tasks/Y1_delivery/assigned_driver_id': DB, 'tasks/Y1_pickup/assigned_driver_id': DB, [`drivers/${DB}/current_task_id`]: 'Y1_delivery' });
    await step({ 'orders/Y1/status': 'cancelled', 'tasks/Y1_pickup/status': 'cancelled', 'tasks/Y1_delivery/status': 'cancelled', [`drivers/${DB}/current_task_id`]: null });
    hy.release(); await fan;
    const before = await liveClaimsOn('Y1');
    assert.deepStrictEqual(before, [DA], `premise (codex repro): B's delayed in-fan-out grant leaves a residual LIVE claim (${before})`);
    const sw = await sweepTrackerTombstones(db, Date.now());
    assert.deepStrictEqual(await liveClaimsOn('Y1'), [], `after ONE sweep: 0 LIVE claims on the terminal order (${JSON.stringify(sw.validated)})`);
    ok(`P1-1 (i): B's grant delayed INSIDE its own fan-out lands LIVE on a cancelled order (residual confirmed); ONE sweep → 0 LIVE claims (${sw.validated.why})`);
  }
  // (ii) codex build r2 P2-2 — the REAL task-status retry: B's FIRST live grant comes from a captured trackerOnTaskStatus event whose
  // attempt is (1) paused before its grant while the ownership change to C is delivered (B's fan-out then finds nothing to clean),
  // (2) released → the grant lands, then the attempt CRASHES right after the acknowledged grant (no owner hint written); (3) the SAME
  // event is redelivered (the platform retry) → it recomputes for C and fans out to C only → B left LIVE; ONE sweep cleans it.
  {
    await reset();
    for (const u of [DA, DB]) await clockInAndDeliver(u);
    await step({ ...orderUpdates('Y2', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'accepted' }), [`drivers/${DA}/current_task_id`]: 'Y2_pickup' });
    assert.notStrictEqual((await node('Y2')).mx.mode, 'live', 'premise: not live yet (pointer at the pickup leg)');
    const evT = await commit({ 'tasks/Y2_delivery/status': 'in_progress', [`drivers/${DA}/current_task_id`]: 'Y2_delivery' });
    const statusEv = evT.find((e) => e.name === 'trackerOnTaskStatus');
    assert.ok(statusEv, 'premise: the commit produced a trackerOnTaskStatus event');
    const hPause = hold('claims:grant', (c) => c.orderId === 'Y2' && c.owner === DA);
    holds.push({ name: 'claims:post-grant', match: (c) => c.orderId === 'Y2' && c.owner === DA, gate: Promise.resolve(), reachedResolve: () => {}, used: false, throwOnRelease: new Error('crash after the acknowledged grant') });
    const attempt1 = app.trackerOnTaskStatus.run({ params: statusEv.params, data: { before: snap(statusEv.before), after: snap(statusEv.after) } });
    await hPause.reached;
    await step({ 'tasks/Y2_delivery/assigned_driver_id': DB, 'tasks/Y2_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'Y2_delivery' });
    hPause.release();
    await assert.rejects(attempt1, /crash after the acknowledged grant/, 'the first attempt crashes AFTER its grant');
    assert.strictEqual((await v(`tracker_claims/${DA}/Y2`) || {}).gone, false, 'premise: B\'s grant was acknowledged before the crash');
    await deliver(statusEv);   // the platform retry of the SAME event
    await step({ 'orders/Y2/status': 'cancelled', 'tasks/Y2_pickup/status': 'cancelled', 'tasks/Y2_delivery/status': 'cancelled', [`drivers/${DB}/current_task_id`]: null });
    const residual = await liveClaimsOn('Y2');
    assert.deepStrictEqual(residual, [DA], `premise: B is left LIVE after the retry fanned out to C only (${residual})`);
    const sw = await sweepTrackerTombstones(db, Date.now());
    assert.deepStrictEqual(await liveClaimsOn('Y2'), [], `after ONE sweep: 0 LIVE claims (${JSON.stringify(sw.validated.why)})`);
    ok('P1-1 (ii) (codex r2 P2-2): the captured task-status event crashes after its acknowledged grant, ownership moves to C, the SAME event is redelivered (fans out to C only) → B LIVE (residual confirmed); ONE sweep → 0 LIVE claims');
  }
  // (iii) reassignment BACK: B → C → B; B's NEWER legitimate grant SURVIVES the sweep
  {
    await reset();
    for (const u of [DA, DB]) await clockInAndDeliver(u);
    await liveOn(DA, 'Y3');
    await step({ 'tasks/Y3_delivery/assigned_driver_id': DB, 'tasks/Y3_pickup/assigned_driver_id': DB, [`drivers/${DA}/current_task_id`]: null, [`drivers/${DB}/current_task_id`]: 'Y3_delivery' });
    await step({ 'tasks/Y3_delivery/assigned_driver_id': DA, 'tasks/Y3_pickup/assigned_driver_id': DA, [`drivers/${DB}/current_task_id`]: null, [`drivers/${DA}/current_task_id`]: 'Y3_delivery' });
    const b0 = await v(`tracker_claims/${DA}/Y3`);
    assert.ok(b0 && b0.gone === false, `premise: B holds a newer LIVE grant after reassignment back (${JSON.stringify(b0)})`);
    await sweepTrackerTombstones(db, Date.now());
    assert.deepStrictEqual(await v(`tracker_claims/${DA}/Y3`), b0, 'B\'s legitimate newer grant SURVIVES the sweep');
    ok(`P1-1 (iii): reassignment back (B → C → B): B's newer grant (seq ${b0.seq}) survives the sweep untouched`);
  }

  // (iv) codex build r2 P1 (ACCEPTED with proof): the validator reads with once('value'), which may see a SPECULATIVE local write.
  // Worst case: it wrongly tombstones a LEGITIMATE live claim. Claims are advisory, so: no customer-visible effect, and the next
  // normal recompute for the driver re-grants it (the fan-out discovers the order through the indexed task query, not the claim).
  {
    await reset();
    const tok = await liveOn(DA, 'Y4');
    const c0 = await v(`tracker_claims/${DA}/Y4`);
    assert.ok(c0 && c0.gone === false, 'premise: B holds a legitimate LIVE claim');
    const vis = (x) => JSON.stringify({ mode: x.mx.mode, owner: x.mx.owner_tag, name: x.mx.name, pins: x.mx.pins || null, status: x.status, is_active_drop: x.is_active_drop ?? null, driver_name: x.driver_name ?? null });
    const n0 = await node('Y4');
    // a validator that READS a speculative (never committed) cancellation of the order
    const realRef = db.ref.bind(db);
    const speculative = { ref: (p) => (p === 'orders/Y4' ? { once: async () => ({ val: () => ({ ...(n0 && {}), status: 'cancelled', tracking_token: 'TOK_Y4' }) }) } : realRef(p)) };
    const wrong = await validateLiveClaims(speculative, await v('tracker_claims'), Date.now());
    assert.strictEqual(wrong.staled, 1, 'premise: the speculative read wrongly tombstones the legitimate claim');
    assert.strictEqual((await v(`tracker_claims/${DA}/Y4`)).gone, true);
    assert.strictEqual(vis(await node('Y4')), vis(n0), 'the validator never touches the public node: nothing customer-visible changed');
    const ing = await ingest(tok, { ageMs: 500 });
    const n1 = await node('Y4');
    assert.strictEqual(n1.driver_location && n1.driver_location.lng, ing.sample.lng, 'an ingest in the window still lands (ingest never reads claims; the node fences decide)');
    await deliver({ name: 'trackerOnDriverPointer', params: { uid: DA }, before: 'Y4_delivery', after: 'Y4_delivery' });   // the driver's next normal recompute
    const c1 = await v(`tracker_claims/${DA}/Y4`);
    assert.ok(c1 && c1.gone === false && c1.seq > c0.seq + 0.5, `the next normal recompute RE-GRANTS the claim (${JSON.stringify(c1)})`);
    const n2 = await node('Y4');
    assert.strictEqual(vis(n1), vis({ ...n0, is_active_drop: true, driver_name: n0.mx.name }), 'the ingest\'s only visible effect is its normal one: live WITH a location → legacy (true, name)');
    assert.strictEqual(vis(n2), vis(n1), 'the re-grant changes NOTHING on the node (same mode / owner / name / pins / status / legacy fields)');
    assert.strictEqual(n2.driver_location && n2.driver_location.lng, ing.sample.lng, 'and the live location stands');
    ok(`P1 accepted residual: a speculative read wrongly tombstones B's legitimate claim (seq ${c0.seq} → ${c0.seq + 0.5}, gone); no customer-visible change; an ingest still lands; B's next normal recompute re-grants it (seq ${c1.seq}) with the node unchanged`);
  }

  // mid-fan-out failure + retry: the fan-out's SECOND recompute throws once → the retry:true trigger re-runs → converges
  await reset();
  await liveOn(DA, 'M1');
  await step({ ...orderUpdates('M2', { status: 'out_for_delivery', owner: DA, pickup: 'completed', delivery: 'accepted' }) });
  let failed = 0;
  holds.push({ name: 'seq', match: (c) => c.orderId === 'M2' && failed++ === 0, gate: Promise.resolve(), reachedResolve: () => {}, used: false, throwOnRelease: new Error('injected mid-fan-out failure') });
  await step({ [`drivers/${DA}/current_task_id`]: 'M2_delivery' });
  assert.ok(failed >= 1, 'premise: the fan-out failed once');
  assert.deepStrictEqual([(await node('M1')).mx.mode, (await node('M2')).mx.mode], ['neutral', 'neutral']);
  await converged('M1', 'fan-out retry'); await converged('M2', 'fan-out retry');
  ok('a fan-out that fails mid-way (second order) is re-delivered (retry:true) and converges');

  clearTimeout(watchdog);
  delete globalThis.__trackerHold;
  console.log(`tracker-schedules: OK (${n}) — ${deliveries} trigger deliveries, no stale revival observed`);
  process.exit(0);
})().catch((e) => { console.error('tracker-schedules: FAIL\n', e); process.exit(1); });
