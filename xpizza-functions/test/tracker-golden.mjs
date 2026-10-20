#!/usr/bin/env node
// TRACKER FIXES (BUILD-tracker-fixes r1.1 §3.3) — the single-order GOLDEN journey, captured per step.
//
//   node tools/emulator-run.js --only firestore,database --project demo-xpizza \
//     "node <this file> --root <repo root to test> --out <capture.json>"
//
// SOURCE PINNING: index.js, the site SDKs (driver, dispatch) and the firebase npm SDKs are loaded ONLY from --root (its own
// xpizza-functions/node_modules). Only the harness (this file, _trigger-runner, _web-sdk-loader) comes from here, so a BASELINE
// capture (--root = a worktree at the base SHA) never imports candidate product code.
//
// Journeys (each from a wiped emulator):
//   native   create → assign (dispatch SDK) → clock-in (native token) → accept → preparing → ready → pickup → ingest ×3 → complete
//   pwa      the same, clock-in 'pwa' and driver-SDK updateDriverLocation ×3 instead of ingest
//   cancel   native up to pickup + 1 ingest → dispatcher cancel (the real HTTP endpoint, RECON_SECRET bearer)
//   reassign native up to pickup + 1 ingest → dispatch SDK reassignOrder to a second driver → that driver's accept/pickup/complete
// Captured after every step (at trigger quiescence): order_tracking/{token}, orders/{id}, dispatcher_alerts, and the side-effect
// log (WhatsApp sends, web-push, FCM). Canonicalized (only): sorted keys; server timestamps → T<rank> per capture step (rank over
// the distinct timestamp values in that step's capture: order + equality preserved); generated identities → ID<n> by first
// appearance; time deltas the script sets (ingest sample ages) are kept as written.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
if (!args.root || !args.out) { console.error('usage: tracker-golden.mjs --root <repo> --out <file> [--flag on|off]'); process.exit(2); }
// TRACKER FIXES flag modes (BUILD §3.3 "Candidate OFF … with the flag (a) missing, (b) false, (c) a refresh failure, (d) a refresh
// timeout"): off (default; the key is ABSENT) | false (seeded false) | on (seeded true) | fault-fail / fault-hang (seeded TRUE, but every
// read of the flag path REJECTS / NEVER ANSWERS — so the capture equals OFF only if the flag fails closed).
const FLAG_MODE = args.flag || 'off';
if (!['off', 'false', 'on', 'fault-fail', 'fault-hang'].includes(FLAG_MODE)) { console.error(`golden: unknown --flag ${FLAG_MODE}`); process.exit(2); }
const FLAG_SEED = { off: undefined, false: false, on: true, 'fault-fail': true, 'fault-hang': true }[FLAG_MODE];
const ROOT = path.resolve(args.root);
const FNR = path.join(ROOT, 'xpizza-functions');
const here = path.dirname(fileURLToPath(import.meta.url));
const { makeTriggerRunner } = await import(pathToFileURL(path.join(here, '_trigger-runner.mjs')).href);
const { makeWebSdkLoader } = await import(pathToFileURL(path.join(here, '_web-sdk-loader.mjs')).href);
const rootRequire = createRequire(path.join(FNR, 'index.js'));

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'golden-secret';
process.env.RECON_SECRET = process.env.RECON_SECRET || 'golden-recon';
rootRequire(path.join(FNR, 'test', '_emulator-required'))('database');

// external sends → spies (the side-effect log); installed BEFORE index.js loads
const sideEffects = [];
const whatsapp = rootRequire(path.join(FNR, 'whatsapp'));
whatsapp.sendMessage = async (phone, body, rid) => { sideEffects.push(['whatsapp', phone, typeof body === 'string' ? body : JSON.stringify(body), rid || null]); return { id: 'wa' }; };
const webpush = rootRequire('web-push');
webpush.sendNotification = async (sub, payload) => { sideEffects.push(['webpush', sub && sub.endpoint, String(payload)]); return { statusCode: 201 }; };
const app = rootRequire(path.join(FNR, 'index.js'));
// EXTERNAL-BOUNDARY stub (identical for baseline and candidate captures): Firebase Auth's user lookup. The emulator band has no
// Auth emulator; assertDriverCallerActive (lib/driver-callable-guard.js) only needs an active, non-disabled user record.
{
  const { getAuth } = rootRequire('firebase-admin/auth');
  const authProto = Object.getPrototypeOf(getAuth());
  authProto.getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });
}
const { getDatabase } = rootRequire('firebase-admin/database');
const db = getDatabase();
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(db.ref().toString())) { console.error('golden: refusing — not the emulator'); process.exit(2); }
if (FLAG_MODE.startsWith('fault-')) {
  // test-only fault at the READ boundary: only the flag path; every other read is untouched
  const RefProto = Object.getPrototypeOf(db.ref('config'));
  const once = RefProto.once;
  RefProto.once = function (...a) {
    if (/\/config\/tracker_fixes_enabled$/.test(this.toString())) return FLAG_MODE === 'fault-fail' ? Promise.reject(new Error('golden: injected flag read failure')) : new Promise(() => {});
    return once.apply(this, a);
  };
}

const PROJECT = process.env.GCLOUD_PROJECT;
const RID = 'tb_centro', DISP = 'u_disp_golden00000000000', D1 = 'u_drv_golden_10000000000', D2 = 'u_drv_golden_20000000000';
const OID = 'o_golden_1', TOK = 'TOKgolden1';
const HUB = { lat: 15.5, lng: -88.03 }, CUST = { lat: 15.52, lng: -88.01 };

function post(handler, { headers = {}, body }) {
  const express = rootRequire('express');
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}

async function seed() {
  await db.ref('/').set(null);
  const { buildCreateOrderUpdates } = rootRequire(path.join(FNR, 'create-order-build.js'));
  await db.ref().update({
    'config/auto_assign_enabled': false,
    ...(FLAG_SEED !== undefined ? { 'config/tracker_fixes_enabled': FLAG_SEED } : {}),
    'config/whatsapp_enabled': true,
    [`restaurants/${RID}/identity`]: { active: true, name: 'TB Centro', phone: '+50400000000', whatsapp_enabled: true, hub_lat: HUB.lat, hub_lng: HUB.lng, delivery_radius_km: 10, version: 1, hours: null },
    [`dispatchers/${DISP}`]: { name: 'Disp' },
    [`drivers/${D1}`]: { name: 'uno', status: 'available', active: false },
    [`drivers/${D2}`]: { name: 'dos', status: 'available', active: false },
  });
  return buildCreateOrderUpdates({
    orderId: OID, orderType: 'delivery', now: Date.now(), trackingToken: TOK, total: 250, lat: CUST.lat, lng: CUST.lng,
    fields: { customer_name: 'Ana', customer_phone: '+50499990000', items_text: '1x Margherita', notes: '', payment_method: 'cash', address_detected: 'Col. Centro', address_details: 'Casa azul' },
    hubSnap: { hub_lat: HUB.lat, hub_lng: HUB.lng, restaurant_name: 'TB Centro', restaurant_phone: '+50400000000' }, restaurantId: RID, priceBreakdown: { total_cents: 25000 },
    facturaPriced: {}, cashTenderedCents: null, freeOrder: false, rewardStamp: null,
  });
}

async function journey(kind) {
  const createUpdates = await seed();
  const R = makeTriggerRunner({ app, db, entities: { orders: [OID], tasks: [`${OID}_pickup`, `${OID}_delivery`], drivers: [D1, D2], rids: [RID] }, background: ['monitorAssignmentTimeout'] });
  const callables = {
    startDriverShift: (req) => app.startDriverShift.run({ ...req, rawRequest: { headers: {} } }),
    endDriverShift: (req) => app.endDriverShift.run({ ...req, rawRequest: { headers: {} } }),
  };
  const NS = new URL(db.app.options.databaseURL).hostname.split('.')[0];   // index.js's Admin namespace (lib/admin.js) — clients must share it
  const mk = (site, uid) => makeWebSdkLoader({ project: PROJECT, site, uid, root: ROOT, hooks: R.clientHooks, callables, ns: NS });
  const loaders = [mk('xpizza-dispatch', DISP), mk('xpizza-driver', D1), mk('xpizza-driver', D2)];
  const [XD, X1, X2] = [await loaders[0].load(), await loaders[1].load(), await loaders[2].load()];
  const steps = [];
  const capture = async (label, { awaitBackground = false } = {}) => {
    await R.quiesce({ awaitBackground });
    const read = async (p) => (await db.ref(p).once('value')).val();
    const st = { step: label, tracking: await read(`order_tracking/${TOK}`), order: await read(`orders/${OID}`), alerts: await read('dispatcher_alerts'), side_effects: sideEffects.splice(0) , failures: R.failures.splice(0).map((f) => f.label) };
    assertLocationAt(st, label, Date.now());
    steps.push(st);
  };
  // driver_location.at PROVENANCE / FRESHNESS (codex restack P2): `_ts_order` does not rank it (a script-chosen sample time under ON
  // races server stamps), so it is asserted HERE, on the raw value before canonicalization: it is never before the order was created
  // nor before the first location sample was sent, never after this capture; OFF (native) it is a SERVER Date.now (≥ the POST start,
  // never a sample time we sent); ON (native) it IS one of the sample times we sent (ingest-txn: sample.measured_at).
  const sent = { firstStart: null, samples: [], starts: [] };
  function assertLocationAt(st, label, capturedAt) {
    const at = st.tracking && st.tracking.driver_location ? st.tracking.driver_location.at : undefined;
    if (at === undefined || at === null) return;
    const where = `golden: ${kind} step '${label}' tracking.driver_location.at=${at}`;
    if (!(typeof at === 'number' && sent.firstStart !== null)) throw new Error(`${where} — present before any location was sent`);
    if (!(st.order && typeof st.order.created_at === 'number' && at >= st.order.created_at)) throw new Error(`${where} — before the order was created (${st.order && st.order.created_at})`);
    if (!(at >= sent.firstStart - 2000 - 1)) throw new Error(`${where} — older than the first sample sent (${sent.firstStart})`);
    if (!(at <= capturedAt)) throw new Error(`${where} — after the capture (${capturedAt})`);
    if (kind !== 'pwa') {
      if (FLAG_MODE === 'on') { if (!sent.samples.includes(at)) throw new Error(`${where} — ON: not one of the sample times sent (${sent.samples})`); }
      else if (sent.samples.includes(at) || !sent.starts.some((s0) => at >= s0)) throw new Error(`${where} — OFF: not a server Date.now at/after an ingest POST (${sent.starts})`);
    }
  }
  const doStep = async (label, fn) => { await R.step(label, fn); await capture(label); };
  let token = null;
  const clockIn = async (X, uid) => {
    if (kind === 'pwa') { await R.step(`clock-in ${uid}`, () => X.startShift(uid)); }
    else {
      const r = await R.step(`clock-in ${uid}`, () => app.startDriverShift.run({ auth: { uid, token: { uid } }, data: { platform: 'native' }, rawRequest: { headers: {} } }));
      token = r && r.ingest_token;
    }
    await capture(`clock-in ${uid}`);
  };
  const ingest = async (i, ageMs) => {
    const p = { lat: HUB.lat + 0.004 * i, lng: HUB.lng + 0.004 * i };
    const start = Date.now(); if (sent.firstStart === null) sent.firstStart = start; sent.starts.push(start);
    if (kind === 'pwa') await doStep(`location ${i}`, () => X1.updateDriverLocation(D1, { ...p, accuracy: 10, heading: 0, speed: 5 }));
    else await doStep(`ingest ${i}`, () => { const ts = Date.now() - ageMs; sent.samples.push(ts); return post(app.ingestDriverLocation, { headers: { 'x-driver-token': token }, body: { locations: [{ ts, ...p, accuracy: 10 }] } }); });
  };

  await doStep('create', () => db.ref().update(createUpdates));
  await doStep('assign', () => XD.assignOrderToDriver(OID, D1));
  await clockIn(X1, D1);
  await doStep('accept', () => X1.acceptTask(D1, `${OID}_pickup`));
  await doStep('kitchen preparing', () => db.ref(`orders/${OID}/status`).set('preparing'));
  await doStep('kitchen ready', () => db.ref(`orders/${OID}/status`).set('ready'));
  await doStep('pickup', () => X1.pickupComplete(D1, `${OID}_pickup`));
  if (kind === 'native' || kind === 'pwa') {
    for (const i of [1, 2, 3]) await ingest(i, 2000);
    await doStep('complete', () => X1.completeTask(D1, `${OID}_delivery`));
  } else if (kind === 'cancel') {
    await ingest(1, 2000);
    await doStep('dispatcher cancel', () => post(app.cancelPaidOrder, { headers: { Authorization: `Bearer ${process.env.RECON_SECRET}` }, body: { order_id: OID, reason: 'golden' } }));
  } else if (kind === 'reassign') {
    await ingest(1, 2000);
    await clockIn(X2, D2);
    await doStep('reassign to D2', () => XD.reassignOrder(OID, D2, D1));
    await doStep('D2 accept', () => X2.acceptTask(D2, `${OID}_pickup`));
  }
  await capture('end (background handlers settled)', { awaitBackground: true });
  for (const L of loaders) L.cleanup();
  R.close();
  return steps;
}

// ── canonicalization (BUILD §3.3): only server timestamps and generated identities are relabelled ──
const TS = (v) => typeof v === 'number' && v > 1.5e12 && v < 2.5e12;
// generated identities: push keys, long hex, UUIDs (shift ids are crypto.randomUUID — index.js startDriverShift). NOT a `shift_…`
// prefix: that matched the FIELD NAME `shift_id` and relabelled the key itself (mx.shift_id → "ID1")
const GEN_ID = /^(-[A-Za-z0-9_-]{19}|[0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
function canonical(steps) {
  const ids = new Map();
  const idOf = (s) => { if (!ids.has(s)) ids.set(s, `ID${ids.size + 1}`); return ids.get(s); };
  // display_number is a GENERATED identity: allocateDisplayNumberOnSale seeds each day's sequence with Math.random
  // (order-display-number.js:44). Label it (DN<n>, first appearance; equality kept) in its own fields AND where the
  // same value is rendered into a side-effect string (the WhatsApp template args).
  const dns = new Map();
  const dnOf = (v) => { if (!dns.has(v)) dns.set(v, `DN${dns.size + 1}`); return dns.get(v); };
  (function scan(v) { if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (k === 'display_number' && typeof v[k] === 'number') dnOf(v[k]); scan(v[k]); } })(steps);
  const dnInString = (str) => str.replace(/(display_?[nN]umber\\?"?\s*:\s*)(\d+)/g, (m, pre, num) => (dns.has(Number(num)) ? pre + dns.get(Number(num)) : m));
  // TIMESTAMPS (r2 canonicalization): each server timestamp value is labelled by the FIRST field path where it appears in this
  // step's canonical traversal (sorted keys), e.g. "T@order/picked_up_at". Labels are therefore stable when OTHER timestamps are
  // added or removed (no rank shifting), and equality is preserved (a value shared by two fields carries ONE label — so
  // "tracking/picked_up_at sourced from the order" shows up as exactly that). ORDERING is kept explicitly in `_ts_order`: the
  // step's labels sorted by value, ties joined with "=".
  return steps.map((st) => {
    const first = new Map();
    (function walk(v, p) {
      if (TS(v)) { if (!first.has(v)) first.set(v, `T@${p}`); return; }
      if (v && typeof v === 'object') for (const k of Object.keys(v).sort()) walk(v[k], p ? `${p}/${k}` : k);
    })(st, '');
    // ORDERING is over SERVER timestamps only. The ingest sample times (driver_location.at, mx.smp.sample_at) are SCRIPT-chosen
    // under ON (now − the journey's sample age): ranking them against server stamps is a timing race (they flip under load — first
    // exposed by S5's ready_at on e8e77e24). Their labels stay on their fields; driver_location.at (a server Date.now under OFF) is
    // instead pinned by explicit provenance / freshness asserts at capture (assertLocationAt).
    const SAMPLE = /(^|\/)(driver_location\/at|mx\/smp\/sample_at)$/;
    const byVal = [...first.entries()].filter(([, label]) => !SAMPLE.test(label)).sort((a, b) => a[0] - b[0]);
    const order = [];
    for (let i = 0; i < byVal.length; i += 1) {
      if (i && byVal[i][0] === byVal[i - 1][0]) order[order.length - 1] += `=${byVal[i][1]}`; else order.push(byVal[i][1]);
    }
    const conv = (v) => {
      if (TS(v)) return first.get(v);
      if (typeof v === 'string') return GEN_ID.test(v) ? idOf(v) : dnInString(v);
      if (Array.isArray(v)) return v.map(conv);
      if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [GEN_ID.test(k) ? idOf(k) : k, k === 'display_number' && typeof v[k] === 'number' ? dnOf(v[k]) : conv(v[k])]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      return v;
    };
    return { ...conv(st), _ts_order: order };
  });
}

const watchdog = setTimeout(() => { console.error('golden: FAIL — timed out'); process.exit(1); }, 2400000);   // 40 min: 4 journeys, each with a real 60 s accept-monitor sleep; generous under gate load
try {
  const { execFileSync } = await import('node:child_process');
  const out = { root_head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), flag: FLAG_MODE, journeys: {} };
  for (const k of ['native', 'pwa', 'cancel', 'reassign']) { out.journeys[k] = canonical(await journey(k)); console.log(`golden: ${k} — ${out.journeys[k].length} steps`); }
  fs.writeFileSync(args.out, JSON.stringify(out, null, 1) + '\n');
  console.log(`golden: wrote ${args.out}`);
} catch (e) {
  console.error('golden: FAIL\n', e); process.exit(1);
}
clearTimeout(watchdog);
process.exit(0);
