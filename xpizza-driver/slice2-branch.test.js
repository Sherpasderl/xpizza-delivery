// slice2-branch.test.js — jsdom branch harness for the SLICE2 stacked path. TWO harnesses, honestly scoped:
// run: `node slice2-branch.test.js` (also in the xpizza-functions npm chain / mutation sweep).
//
//   run()      — drives the REAL stacked-view.js / overview-map.js builders through the REAL renderActiveAndQueue
//                + attachActiveCardHandlers / attachSlideConfirm / queue-tap listener lifted verbatim from
//                index.html, with only the SERVER WRITES stubbed as deferred promises. It proves BINDING / RENDER
//                / DRAG / LATCH: the slice-2 builders' hooks bind to the frozen handlers, the map mounts, labels
//                are phase-correct, QUEUE-IDENTITY resolves by orderId + fails closed, the drag defers/replays.
//   runReal()  — the REAL-WRITER integration proof (Codex r1 P2-4). It runs the REAL lifted getDriverOrders +
//                acceptTask / acceptSecondOrder / completeTask / pickupComplete (SOURCE-lifted from
//                xpizza-delivery.js, which imports firebase from a CDN so it cannot be imported here) over a
//                FAITHFUL mock Firebase transport, with buildCompleteTaskUpdates / stackedTasksToAccept / the
//                TASK_* constants IMPORTED REAL. Promotion is WRITER-DRIVEN: a real completion mutates the mock
//                board → real getDriverOrders recomputes → the lone next order promotes through the real builders.
//                Proves same-hub accept, cross-hub explicit accept, batch pickup, cancel/reassign, promotion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { singleOrderCardHtml } from './single-order-view.js';
import {
  incomingBannerHtml, activeCardHtml, queueHtml, queueDetailHtml,
  phaseStripHtml, stopNavInfo, resolveVisibleLabels,
  navBtnHtml, queuedPreviewHtml, coloniaOf, stopHeaderHtml, combinedPickupHtml, interludeHtml, cancelBannerHtml, offerScreenHtml,
} from './stacked-view.js';
import { overviewMapSvg, isStaleFix } from './overview-map.js';
// Firebase-FREE real modules → imported REAL (not lifted): the writers' pure cores + the task/order constants.
import { buildCompleteTaskUpdates, DRIVER_STATUS, ORDER_STATUS, TASK_STATUS, TASK_TYPE } from './driver-complete.js';
import { stackedTasksToAccept } from './stacking-helpers.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');

const scriptOf = (html) => html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const MY_SCRIPT = scriptOf(readFileSync(join(__dir, 'index.html'), 'utf8'));

function liftFn(script, name) {
  let start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < script.length; i++) {
    if (script[i] === '{') { depth++; seen = true; }
    else if (script[i] === '}') { depth--; if (seen && depth === 0) return script.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
// Lift a top-level `anchor( … )` call statement by balancing parentheses from the first '(' after the anchor.
function liftCall(script, anchor) {
  const at = script.indexOf(anchor);
  assert.notEqual(at, -1, `anchor not found: ${anchor}`);
  let i = script.indexOf('(', at + anchor.length), depth = 0;   // the call's OWN open paren, past the anchor
  const start = at;
  for (; i < script.length; i++) {
    if (script[i] === '(') depth++;
    else if (script[i] === ')') { depth--; if (depth === 0) { const end = script.indexOf(';', i); return script.slice(start, end + 1); } }
  }
  throw new Error(`unbalanced call: ${anchor}`);
}
// Lift a contiguous SOURCE span [startNeedle .. just before endNeedle) verbatim — used for the drv2
// recent-completion machinery (a block of lets + functions, not a single function) so the harness drives the
// REAL observer/interlude code, not a stub.
function liftSpan(script, startNeedle, endNeedle) {
  const s = script.indexOf(startNeedle);
  assert.notEqual(s, -1, `span start not found: ${startNeedle}`);
  const e = script.indexOf(endNeedle, s);
  assert.notEqual(e, -1, `span end not found: ${endNeedle}`);
  return script.slice(s, e);
}
// The REAL dep-D recent-completion block (drv2DoneRun … drv2ShowInterlude), lifted verbatim from SLICE2:IMPORT.
const DRV2_BLOCK = liftSpan(MY_SCRIPT, 'let drv2DoneRun', '/* ===== SLICE2:IMPORT:END');
// The REAL R7 nav-preference helpers (DRV2_NAV_PREF_PREFIX … drv2WriteNavPref), lifted verbatim — so the harness
// drives the REAL server-truth/per-uid hydration, not a `() => 'Waze'` stub (Codex r1 P2-10).
const NAV_BLOCK = liftSpan(MY_SCRIPT, 'const DRV2_NAV_PREF_PREFIX', 'let drv2DoneRun');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const ICONS = Object.fromEntries(['bell', 'cash', 'check', 'close', 'nav', 'phone', 'pin', 'store', 'warn', 'whatsapp'].map((k) => [k, `<svg data-ic="${k}"></svg>`]));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// P2-4 (Codex r1): REAL SDK, SOURCE-LIFTED fail-closed, run over a FAITHFUL mock Firebase transport.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const XPD_SRC = readFileSync(join(__dir, 'xpizza-delivery.js'), 'utf8');

// Lift a top-level `[export] const NAME = …;` single statement (fail-closed, like liftFn for functions).
function liftConst(script, name) {
  const hits = [...script.matchAll(new RegExp(`(?:export )?const ${name} = `, 'g'))];
  assert.equal(hits.length, 1, `const ${name} must appear exactly once (found ${hits.length})`);
  const start = hits[0].index + (hits[0][0].startsWith('export ') ? 'export '.length : 0);
  const end = script.indexOf(';', start);
  assert.notEqual(end, -1, `const ${name} not terminated`);
  return script.slice(start, end + 1);
}

// CONDITION 1 — extraction fails closed: each lifted name is declared EXACTLY ONCE and the lifted text is the
// VERBATIM source slice. A rename / restructure turns this RED instead of silently falling back to a stub.
const LIFTED = {};
for (const name of ['getDriverOrders', 'acceptTask', 'acceptSecondOrder', 'completeTask', 'pickupComplete']) {
  const decls = (XPD_SRC.match(new RegExp(`function ${name}\\(`, 'g')) || []).length;
  assert.equal(decls, 1, `function ${name} must be declared exactly once in xpizza-delivery.js (found ${decls})`);
  LIFTED[name] = liftFn(XPD_SRC, name);
  assert.ok(XPD_SRC.includes(LIFTED[name]), `lifted ${name} is not a verbatim slice of xpizza-delivery.js`);
}
LIFTED.ownTasksQuery = liftConst(XPD_SRC, 'ownTasksQuery');
assert.ok(XPD_SRC.includes(LIFTED.ownTasksQuery), 'lifted ownTasksQuery is not a verbatim slice');

// CONDITION 2 — the faithful mock's implemented Firebase API. The inventory of what MIGHT be used is DERIVED
// from the ACTUAL firebase import statements in xpizza-delivery.js — NOT a hand list (Codex r2 P2-2: a hand list
// fails open, so an imported `increment(...)` on an uncovered branch would stay green). FB_INVENTORY holds the
// EXPORT names the mock implements. parseFbBindings resolves every `{ ... }` binding across every firebase-*.js
// import — including ALIASES `increment as inc` (Codex r3-2: an aliased import of an unimplemented export, called
// by its LOCAL name, previously failed open). A binding whose EXPORT is NOT in the mock, whose LOCAL name the
// lifted blob CALLS, → RED, STATICALLY (independent of branch exec).
const FB_INVENTORY = new Set(['ref', 'get', 'update', 'serverTimestamp', 'runTransaction', 'query', 'orderByChild', 'equalTo']);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
function parseFbBindings(src) {
  const out = [];   // { exp, local }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*firebase[^']*\.js'/g)) {
    for (const raw of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [exp, local] = raw.split(/\s+as\s+/).map((s) => s.trim());
      out.push({ exp, local: local || exp });
    }
  }
  return out;
}
const FB_BINDINGS = parseFbBindings(XPD_SRC);
assert.ok(FB_BINDINGS.length, 'could not find any firebase import bindings in xpizza-delivery.js');
function uncoveredFbCalls(blobSrc, bindings) {
  const blob = stripComments(blobSrc);   // prose like "already set (…)" is not a call
  return bindings.filter((b) => !FB_INVENTORY.has(b.exp)).filter((b) => new RegExp(`\\b${b.local}\\s*\\(`).test(blob)).map((b) => b.local);
}
{
  const uncovered = uncoveredFbCalls(Object.values(LIFTED).join('\n'), FB_BINDINGS);
  assert.deepEqual(uncovered, [], `lifted writers call firebase API not implemented in the faithful mock: [${uncovered}] — implement it + add to FB_INVENTORY`);
}

// A faithful mock RTDB (plain-object tree) + the Firebase functions the lifted writers call. Semantics match
// the real SDK: multi-path update atomicity + null-deletes, get().val(), runTransaction null-first + retry/abort,
// serverTimestamp() sentinel resolved on write, query(orderByChild/equalTo) resolved by get() filtering.
function makeMock(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  const ST = { __st: true };
  let clock = 1700000000000;
  const pendingConflicts = {};   // path → queue of values a "concurrent writer" commits between a txn read and its commit
  const parts = (p) => (p ? p.split('/').filter(Boolean) : []);
  const read = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const prune = (ps) => {   // after a delete, remove now-empty ancestor objects (no leftover {}) — like RTDB
    for (let depth = ps.length - 1; depth >= 1; depth--) {
      const parent = ps.slice(0, depth - 1).reduce((o, k) => (o == null ? undefined : o[k]), data);
      const key = ps[depth - 1];
      if (parent && parent[key] && typeof parent[key] === 'object' && !Array.isArray(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
      else break;
    }
  };
  const writeOne = (p, v) => {
    const ps = parts(p); let o = data;
    for (let i = 0; i < ps.length - 1; i++) { if (o[ps[i]] == null || typeof o[ps[i]] !== 'object') o[ps[i]] = {}; o = o[ps[i]]; }
    const last = ps[ps.length - 1];
    if (v === null || v === undefined) { delete o[last]; prune(ps); } else o[last] = v;
  };
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const resolveST = (v) => (v && v.__st ? (clock += 1) : v);
  const snap = (v) => ({ val: () => (v === undefined ? null : v), exists: () => v !== undefined });
  const fb = {
    db: { __db: true },
    serverTimestamp: () => ST,
    ref: (_d, path) => ({ __ref: true, path: path == null ? '' : path }),
    get: async (r) => {
      if (r.__query) {
        const parent = read(r.path) || {};
        const out = {};
        for (const [k, v] of Object.entries(parent)) if (v && v[r.field] === r.value) out[k] = clone(v);
        return snap(out);
      }
      return snap(clone(read(r.path)));
    },
    update: async (rootRef, updates) => {
      // FAITHFUL multi-path update (Codex r2 P2-1 / r3-1): VALIDATE everything BEFORE mutating anything (atomic). The
      // installed SDK rejects an undefined value ANYWHERE in the tree (not just top-level) and OVERLAPPING paths (an
      // ancestor + a descendant). Paths are NORMALIZED to segment arrays first so a trailing/empty-segment key
      // (`probe/a/`) still collides with its descendant (`probe/a/b`) — a raw string prefix check missed it (r3-1).
      const entries = Object.entries(updates);
      const seg = (p) => String(p).split('/').filter(Boolean);   // drop empty segments: 'probe/a/' → ['probe','a']
      const full = entries.map(([k]) => seg((rootRef.path ? rootRef.path + '/' : '') + k));
      const hasUndef = (v) => v === undefined ? true
        : (v && typeof v === 'object' && !v.__st) ? Object.values(v).some(hasUndef) : false;   // RECURSIVE (r3-1)
      for (const [k, v] of entries) if (hasUndef(v)) throw new Error(`update: undefined value at or under '${k}'`);
      const isPrefix = (a, b) => a.length <= b.length && a.every((s, idx) => b[idx] === s);   // a is an ancestor of / equal to b
      for (let i = 0; i < full.length; i++) for (let j = 0; j < full.length; j++) {
        if (i !== j && isPrefix(full[i], full[j])) throw new Error(`update: overlapping paths '${entries[i][0]}' and '${entries[j][0]}'`);
      }
      for (const [k, v] of entries) writeOne((rootRef.path ? rootRef.path + '/' : '') + k, resolveST(v));
    },
    runTransaction: async (r, fn) => {
      // FAITHFUL (Codex r2 P2-1 / r3-1): run against the CURRENT value — never commit a speculative result over an
      // existing value. Abort on undefined; commit the returned value (null → delete). The writer's own null-first
      // guard (`if (t === null) return null`) is for RTDB's uncached speculative call.
      // RETRY (r3-1): the real SDK RE-RUNS the callback when the value changed under it between read and commit. A
      // queued conflict (queueConflict) is applied after the callback runs but before commit, forcing one more pass
      // against the NEW value — exactly the retry the real SDK performs.
      for (let attempt = 0; attempt < 25; attempt++) {
        const raw = read(r.path);
        const cur = raw === undefined ? null : clone(raw);
        const result = fn(cur);
        if (result === undefined) return { committed: false, snapshot: snap(cur) };   // abort → no write
        const conflict = pendingConflicts[r.path] && pendingConflicts[r.path].length ? pendingConflicts[r.path].shift() : undefined;
        if (conflict !== undefined) { writeOne(r.path, conflict === null ? null : conflict); continue; }   // value changed → re-run fn
        writeOne(r.path, result === null ? null : result);
        return { committed: true, snapshot: snap(result === null ? null : result) };
      }
      throw new Error('runTransaction: exceeded retry limit (conflict queue never drained)');
    },
    query: (r, ...cs) => { const f = {}; for (const c of cs) Object.assign(f, c); return { __query: true, path: r.path, field: f.field, value: f.value }; },
    orderByChild: (field) => ({ field }),
    equalTo: (value) => ({ value }),
  };
  // queue a value a concurrent writer commits mid-transaction at `path` → forces the next runTransaction there to retry
  const queueConflict = (path, value) => { (pendingConflicts[path] = pendingConflicts[path] || []).push(value); };
  return { data, read, fb, queueConflict };
}

// CONDITION 3 — accept/pickup/complete run their REAL lifted bodies over the mock (no hand-written equivalents).
function buildRealSDK(fb) {
  const body = LIFTED.ownTasksQuery + '\n' + LIFTED.getDriverOrders + '\n' + LIFTED.acceptTask + '\n'
    + LIFTED.acceptSecondOrder + '\n' + LIFTED.completeTask + '\n' + LIFTED.pickupComplete + '\n'
    + 'return { getDriverOrders, acceptTask, acceptSecondOrder, completeTask, pickupComplete };';
  const names = ['db', 'ref', 'get', 'update', 'serverTimestamp', 'runTransaction', 'query', 'orderByChild', 'equalTo',
    'stackedTasksToAccept', 'buildCompleteTaskUpdates', 'TASK_STATUS', 'TASK_TYPE', 'DRIVER_STATUS', 'ORDER_STATUS'];
  return (new Function(...names, body))(fb.db, fb.ref, fb.get, fb.update, fb.serverTimestamp, fb.runTransaction,
    fb.query, fb.orderByChild, fb.equalTo, stackedTasksToAccept, buildCompleteTaskUpdates,
    TASK_STATUS, TASK_TYPE, DRIVER_STATUS, ORDER_STATUS);
}

// Seed builder: each spec → a linked pickup+delivery task pair + an order node, at a named hub, for driver 'drv'.
// pickupStatus/deliveryStatus set the phase (see getDriverOrders): assigned=awaiting; pickup accepted=pickup;
// pickup completed + delivery accepted=delivery.
// Canonical ALLOWED_HUBS coords (stacking-helpers.js) — resolveOrderHub validates against these, so the seed
// must use them for same-hub/cross-hub to resolve correctly.
const HUBX = { lat: 15.507489753573818, lng: -88.0398486953722, addr: 'X. Pizza' };   // x_pizza (same-hub stack)
const HUBM = { lat: 15.50414, lng: -88.03848, addr: 'La Musa' };                      // la_musa (cross-hub)
function seed(specs) {
  const tasks = {}, orders = {}, drivers = { drv: { status: DRIVER_STATUS.EN_ROUTE_DELIVERY, current_task_id: null } };
  for (const s of specs) {
    const pid = s.id + '_p', did = s.id + '_d', hub = s.hub || HUBX;
    tasks[pid] = { type: TASK_TYPE.PICKUP, order_id: s.id, assigned_driver_id: s.driver ?? 'drv', status: s.pickup,
      linked_task_id: did, created_at: s.created ?? 1, destination_lat: hub.lat, destination_lng: hub.lng, destination_address: hub.addr };
    tasks[did] = { type: TASK_TYPE.DELIVERY, order_id: s.id, assigned_driver_id: s.driver ?? 'drv', status: s.delivery,
      linked_task_id: pid, created_at: s.created ?? 1, destination_lat: s.lat ?? 15.40, destination_lng: s.lng ?? -88.00, destination_address: s.addr || ('Col. ' + s.id) };
    orders[s.id] = { display_number: s.id, customer_name: s.name || ('Cliente ' + s.id), customer_phone: '99998888',
      payment_method: 'cash', total: 385, address_detected: s.addr || ('Col. ' + s.id), lat: s.lat ?? 15.40, lng: s.lng ?? -88.00,
      hub_lat: hub.lat, hub_lng: hub.lng, restaurant_display_name: hub.addr, restaurant_id: s.rid || (hub === HUBM ? 'la_musa' : 'x_pizza'),
      status: s.orderStatus || ORDER_STATUS.READY };
  }
  return { tasks, orders, drivers };
}

// Build a runReal harness: the lifted renderActiveAndQueue + handlers, with XPD backed by the REAL SDK over the
// mock. XPD.getDriverOrders reads the LIVE mock (prod's allTasks/allOrders are the live listener state), so a
// real write → the next render recomputes the board. Returns the same drag/dom helpers as run() + the mock.
function runReal({ seed: initial, driverState = { lat: 15.47, lng: -88.015, active: true, last_location_ts: Date.now() }, dist = 999, restaurant = HUBX }) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="screen-onshift"><main id="onshift-content">'
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div></main></div>'
    + '<div id="queue-sheet"><div id="queue-sheet-body"></div></div></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const { data, read, fb, queueConflict } = makeMock(initial);
  const sdk = buildRealSDK(fb);
  const rec = { toasts: [], idle: false, bannerAttached: [], mapTimerEnsured: 0, mapTimerStopped: 0 };
  const XPD = {
    getDriverOrders: (uid) => sdk.getDriverOrders(uid, read('tasks') || {}, read('orders') || {}),   // LIVE mock state
    RESTAURANT: { lat: restaurant.lat, lng: restaurant.lng },
    haversineDistance: () => dist,
    emitDiag: () => {}, getDiagConnState: () => true, isActingDispatcher: () => false,
    acceptTask: (uid, taskId) => sdk.acceptTask(uid, taskId),
    acceptSecondOrder: (uid, pid) => sdk.acceptSecondOrder(uid, pid),
    pickupComplete: (uid, pid) => sdk.pickupComplete(uid, pid),
    completeTask: (uid, taskId) => sdk.completeTask(uid, taskId),
  };
  const $ = (id) => document.getElementById(id);
  const scheduledBadge = () => '';
  const computeVuelto = () => null;
  const toast = (m, k) => rec.toasts.push([m, k]);
  const resolveCompleteErrorMessage = async (err) => String((err && err.message) || err);
  const renderIdleState = () => { rec.idle = true; };
  const attachIncomingBannerHandlers = (o) => rec.bannerAttached.push(o.orderId);
  const body = 'let slidingEl=null, renderPending=false;\n'
    + 'let queuedOrders=[]; const collapsedBanners=new Set(); const pendingCompletions=new Set();\n'
    + 'let driverState=_driverState; let slice1ReviewLatchKey=null; let authGen=0;\n'
    + 'let slice2MapAgeTimer=null; const SLICE2_MAP_AGE_MS=30000;\n'
    + 'function ensureSlice2MapAgeTimer(){ _rec.mapTimerEnsured++; }\n'
    + 'function stopSlice2MapAgeTimer(){ _rec.mapTimerStopped++; }\n'
    + 'const DRV2_CAN_NOTIFY_ARRIVAL=false; const DRV2_CAN_REPORT_PROBLEM=false;\n'
    + NAV_BLOCK + '\n'   // REAL drv2ReadNavPref/drv2WriteNavPref (not a Waze stub) — server-truth + per-uid hydration (Codex r1 P2-10)
    + DRV2_BLOCK + '\n'
    + liftFn(MY_SCRIPT, 'renderActiveAndQueue') + '\n'
    + liftFn(MY_SCRIPT, 'attachActiveCardHandlers') + '\n'
    + liftFn(MY_SCRIPT, 'attachSlideConfirm') + '\n'
    + liftCall(MY_SCRIPT, "$('queue-slot').addEventListener") + '\n'
    // The WHOLE STACKED-HANDLERS span — the delegate click (sheet taps) AND the capture-phase drv2ActionGuard
    // registration — so the harness boots the REAL listener set (Codex r2 P2-7: disabling the action guard → red).
    + liftSpan(MY_SCRIPT, "$('screen-onshift').addEventListener('click', (e) => {", '/* ===== SLICE2:STACKED-HANDLERS:END') + '\n'
    + liftFn(MY_SCRIPT, 'attachIncomingBannerHandlers') + '\n'   // REAL banner handler (Codex r2 P2-3)
    // expose the lifted mutable state so a cell can feed the observer the LIVE mock + flip the session (P2-10)
    + 'return { render: renderActiveAndQueue, setDriver:(d)=>{driverState=d;}, syncState:(t,o)=>{allTasks=t;allOrders=o;}, bumpAuth:()=>{authGen++;},'
    + ' getDoneRun:()=>drv2DoneRun, getInterlude:()=>drv2Interlude, getCancel:()=>drv2Cancel };';
  const names = ['document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS', 'localStorage',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'incomingBannerHtml', 'activeCardHtml', 'queueHtml',
    'queueDetailHtml', 'phaseStripHtml', 'stopNavInfo', 'resolveVisibleLabels', 'overviewMapSvg', 'isStaleFix',
    'navBtnHtml', 'queuedPreviewHtml', 'coloniaOf', 'stopHeaderHtml', 'combinedPickupHtml', 'interludeHtml', 'cancelBannerHtml', 'offerScreenHtml',
    'renderIdleState', 'toast', 'resolveCompleteErrorMessage', 'CSS', '_driverState', '_rec'];
  const CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  const lsStore = {};   // per-harness in-memory localStorage (the real drv2ReadNavPref per-uid mirror)
  const localStorage = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } };
  const api = (new Function(...names, body))(document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS, localStorage,
    computeVuelto, scheduledBadge, singleOrderCardHtml, incomingBannerHtml, activeCardHtml, queueHtml,
    queueDetailHtml, phaseStripHtml, stopNavInfo, resolveVisibleLabels, overviewMapSvg, isStaleFix,
    navBtnHtml, queuedPreviewHtml, coloniaOf, stopHeaderHtml, combinedPickupHtml, interludeHtml, cancelBannerHtml, offerScreenHtml,
    renderIdleState, toast, resolveCompleteErrorMessage, CSS, driverState, rec);
  // Feed the observer the SAME live mock state getDriverOrders reads BEFORE every render (prod's allTasks/
  // allOrders are the live listener state; a captured ref would go stale when completeTask deletes the task legs).
  // Also merge the mock's drivers/{uid} record into driverState — in prod driverState IS that record, so
  // current_task_id (written by the real acceptTask/pickupComplete/completeTask) must flow into the pointer (P1-1).
  const syncAndRender = () => {
    api.syncState(read('tasks') || {}, read('orders') || {});
    api.setDriver({ ...driverState, ...(read('drivers/drv') || {}) });
    api.render();
  };
  const slot = (id) => document.getElementById(id);
  const ret = {
    document, window: dom.window, rec, data, read, fb, queueConflict, sdk, XPD, api,
    lsStore,
    render: () => syncAndRender(),
    active: () => slot('active-order-slot').innerHTML,
    activeEl: () => slot('active-order-slot'),
    banner: () => slot('incoming-banner-slot').innerHTML,
    queue: () => slot('queue-slot').innerHTML,
    sheet: () => slot('queue-sheet-body').innerHTML,
    sheetOpen: () => slot('queue-sheet').classList.contains('open'),
    board: () => XPD.getDriverOrders('drv'),
    clickCard(sel) { const c = slot('queue-slot').querySelector(sel); assert.ok(c, `qcard ${sel} present`); c.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); },
    prep(id) {
      const el = slot('active-order-slot').querySelector('#' + id) || document.getElementById(id);
      assert.ok(el, `slide #${id} present`);
      const thumb = el.querySelector('.slide-thumb');
      el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
      thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
      return { el, thumb };
    },
    down({ thumb }) { thumb.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true })); },
    move(x) { document.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: x, bubbles: true, cancelable: true })); },
    async up(x) { document.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientX: x, bubbles: true, cancelable: true })); await tick(); },
  };
  syncAndRender();
  return ret;
}

function run({ orders, driverState = null, dist = 999, latchInit = null, authGen = 0 }) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="screen-onshift"><main id="onshift-content">'
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div></main></div>'
    + '<div id="queue-sheet"><div id="queue-sheet-body"></div></div></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const ctx = { orders };
  const rec = { toasts: [], idle: false, bannerAttached: [], mapTimerEnsured: 0, mapTimerStopped: 0 };
  const writes = {};
  const XPD = {
    getDriverOrders: () => ctx.orders,
    RESTAURANT: { lat: 15.5, lng: -88.03 },
    haversineDistance: () => dist,                                 // per-run distance (m) for the <50 m arrived threshold
    emitDiag: () => {}, getDiagConnState: () => true, isActingDispatcher: () => false,
    acceptTask: () => (writes.accept = deferred()).promise,
    pickupComplete: (uid, taskId) => { writes.pickup = { taskId, ...deferred() }; return writes.pickup.promise; },
    completeTask: (uid, taskId) => { writes.complete = { taskId, ...deferred() }; return writes.complete.promise; },
    acceptSecondOrder: () => (writes.accept2 = deferred()).promise,
  };
  const $ = (id) => document.getElementById(id);
  const scheduledBadge = () => '';
  const computeVuelto = () => null;
  const toast = (m, k) => rec.toasts.push([m, k]);
  const resolveCompleteErrorMessage = async (err) => String((err && err.message) || err);
  const renderIdleState = () => { rec.idle = true; };
  const attachIncomingBannerHandlers = (o) => rec.bannerAttached.push(o.orderId);

  const body = 'let slidingEl=null, renderPending=false;\n'
    + 'let queuedOrders=[]; const collapsedBanners=new Set(); const pendingCompletions=new Set();\n'
    + 'let driverState=_driverState; let slice1ReviewLatchKey=_latchInit; let authGen=_authGen;\n'
    + 'let slice2MapAgeTimer=null; const SLICE2_MAP_AGE_MS=30000;\n'
    + 'function ensureSlice2MapAgeTimer(){ _rec.mapTimerEnsured++; }\n'
    + 'function stopSlice2MapAgeTimer(){ _rec.mapTimerStopped++; }\n'
    // dep-D capability gates + nav pref (R7): render reads these. The recent-completion machinery is lifted REAL.
    + 'const DRV2_CAN_NOTIFY_ARRIVAL=false; const DRV2_CAN_REPORT_PROBLEM=false;\n'
    + 'const drv2ReadNavPref=()=>\'Waze\';\n'
    + DRV2_BLOCK + '\n'
    + liftFn(MY_SCRIPT, 'renderActiveAndQueue') + '\n'
    + liftFn(MY_SCRIPT, 'attachActiveCardHandlers') + '\n'
    + liftFn(MY_SCRIPT, 'attachSlideConfirm') + '\n'
    + liftCall(MY_SCRIPT, "$('queue-slot').addEventListener") + '\n'
    // WHOLE STACKED-HANDLERS span: the delegate click (sheet taps, cancel-ack, end-shift) AND the capture-phase
    // drv2ActionGuard registration — the real listener set (Codex r2 P2-7).
    + liftSpan(MY_SCRIPT, "$('screen-onshift').addEventListener('click', (e) => {", '/* ===== SLICE2:STACKED-HANDLERS:END') + '\n'
    + 'return { render: renderActiveAndQueue, setDriver:(d)=>{driverState=d;}, getQueued:()=>queuedOrders,'
    + ' getLatch:()=>slice1ReviewLatchKey, getSliding:()=>slidingEl, getRenderPending:()=>renderPending, bumpAuth:()=>{ authGen+=1; },'
    + ' syncState:(t,o)=>{allTasks=t;allOrders=o;}, setPtr:(id)=>{ if(driverState) driverState.current_task_id=id; },'
    + ' getDoneRun:()=>drv2DoneRun, getInterlude:()=>drv2Interlude, getCancel:()=>drv2Cancel };';
  const params = ['document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'incomingBannerHtml', 'activeCardHtml', 'queueHtml',
    'queueDetailHtml', 'phaseStripHtml', 'stopNavInfo', 'resolveVisibleLabels', 'overviewMapSvg', 'isStaleFix',
    'navBtnHtml', 'queuedPreviewHtml', 'coloniaOf', 'stopHeaderHtml', 'combinedPickupHtml', 'interludeHtml', 'cancelBannerHtml', 'offerScreenHtml',
    'attachIncomingBannerHandlers', 'renderIdleState', 'toast', 'resolveCompleteErrorMessage', '_driverState', '_rec',
    '_latchInit', '_authGen'];
  const fn = new Function(...params, body);
  const api = fn(document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS,
    computeVuelto, scheduledBadge, singleOrderCardHtml, incomingBannerHtml, activeCardHtml, queueHtml,
    queueDetailHtml, phaseStripHtml, stopNavInfo, resolveVisibleLabels, overviewMapSvg, isStaleFix,
    navBtnHtml, queuedPreviewHtml, coloniaOf, stopHeaderHtml, combinedPickupHtml, interludeHtml, cancelBannerHtml, offerScreenHtml,
    attachIncomingBannerHandlers, renderIdleState, toast, resolveCompleteErrorMessage, driverState, rec,
    latchInit, authGen);

  // Live observer state (Codex r1 P2-10): drv2Observe must see the SAME board state getDriverOrders reports, plus
  // the affirmative terminal status of any stop that LEFT the board. `terminal` persists a vanished order's
  // outcome (delivered / cancelled / reassigned-away) so the observer classifies on EVIDENCE, never a bare
  // disappearance. `current_task_id` auto-points at the active board[0] working task (the realistic pointer for
  // these single/stacked layout cells → navArmed, controls not gated); the pointer-disagreement / fail-closed and
  // cancel-ordering / reassign paths are exercised in the runReal real-writer cells + the dedicated cells below.
  const terminal = {};   // orderId → { status?, reassigned? } for orders no longer in ctx.orders
  const workId = (o) => (o && o.phase === 'delivery') ? (o.deliveryTask && o.deliveryTask.id)
    : (o && o.phase === 'pickup') ? (o.pickupTask && o.pickupTask.id) : null;
  const stateFrom = () => {
    const tasks = {}, orders = {};
    for (const o of ctx.orders) {
      orders[o.orderId] = { ...(o.order || {}), status: (o.order && o.order.status) || 'out_for_delivery' };
      if (o.pickupTask && o.pickupTask.id) tasks[o.pickupTask.id] = { order_id: o.orderId, assigned_driver_id: 'drv', type: 'pickup', status: 'accepted' };
      if (o.deliveryTask && o.deliveryTask.id) tasks[o.deliveryTask.id] = { order_id: o.orderId, assigned_driver_id: 'drv', type: 'delivery', status: 'accepted' };
    }
    for (const [oid, m] of Object.entries(terminal)) {
      orders[oid] = { ...(orders[oid] || {}), status: m.status || 'out_for_delivery' };
      if (m.reassigned) {   // reassign KEEPS the legs, now owned by another driver (delivered/cancelled delete them)
        tasks[oid + '_p'] = { order_id: oid, assigned_driver_id: 'other', type: 'pickup', status: 'assigned' };
        tasks[oid + '_d'] = { order_id: oid, assigned_driver_id: 'other', type: 'delivery', status: 'assigned' };
      }
    }
    return { tasks, orders };
  };
  const syncAndRender = () => {
    const st = stateFrom();
    api.syncState(st.tasks, st.orders);
    api.setPtr(workId(ctx.orders[0]));
    api.render();
  };
  const slot = (id) => document.getElementById(id);
  const ret = {
    document, window: dom.window, rec, writes, api, terminal,
    render: () => syncAndRender(),
    setOrders: (o) => { ctx.orders = o; },
    markDelivered: (oid) => { terminal[oid] = { status: 'delivered' }; },
    markCancelled: (oid) => { terminal[oid] = { status: 'cancelled' }; },
    markReassigned: (oid) => { terminal[oid] = { status: 'out_for_delivery', reassigned: true }; },
    active: () => slot('active-order-slot').innerHTML,
    activeEl: () => slot('active-order-slot'),
    banner: () => slot('incoming-banner-slot').innerHTML,
    queue: () => slot('queue-slot').innerHTML,
    sheet: () => slot('queue-sheet-body').innerHTML,
    sheetOpen: () => slot('queue-sheet').classList.contains('open'),
    clickCard(sel) {
      const card = slot('queue-slot').querySelector(sel);
      assert.ok(card, `qcard ${sel} present`);
      card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    prep(id) {
      const el = slot('active-order-slot').querySelector('#' + id) || document.getElementById(id);
      assert.ok(el, `slide #${id} present`);
      const thumb = el.querySelector('.slide-thumb');
      el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
      thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
      return { el, thumb };
    },
    down({ thumb }) { thumb.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true })); },
    move(x) { document.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientX: x, bubbles: true, cancelable: true })); },
    async up(x) { document.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientX: x, bubbles: true, cancelable: true })); await tick(); },
  };
  syncAndRender();
  return ret;
}

// Fixtures — two restaurants so a cross-hub stack is realistic.
const base = { customer_phone: '99998888', payment_method: 'cash', total: 385 };
const delivery = (id, over = {}) => ({ orderId: id, phase: 'delivery', pickupTask: { id: id + '_p' },
  deliveryTask: { id: id + '_d', destination_lat: 15.4, destination_lng: -88.0, destination_address: 'addr ' + id },
  order: { ...base, display_number: over.dn ?? id, restaurant_display_name: over.brand || 'X. Pizza', restaurant_id: over.rid || 'x_pizza',
    customer_name: over.name || ('Cliente ' + id), address_detected: over.addr || ('Col. ' + id), lat: 15.52, lng: -88.01 } });
const pickup = (id) => ({ orderId: id, phase: 'pickup', pickupTask: { id: id + '_p', destination_lat: 15.5, destination_lng: -88.03, destination_address: 'Blvd' },
  deliveryTask: { id: id + '_d' }, order: { ...base, display_number: id, restaurant_display_name: 'La Musa', restaurant_id: 'la_musa', customer_name: 'Cliente ' + id, address_detected: 'Col. ' + id } });

let passed = 0;
const _p = [];
const t = (name, fn) => _p.push(Promise.resolve().then(fn).then(() => { passed += 1; }, (e) => { console.error(`✗ ${name}`); throw e; }));

const FRESH = Date.now();

// 1. Stacked render via the REAL builders: strip + map + active card hooks + queue identity hooks.
t('stacked (2 orders): real builders render stop-header + strip + map + active card + the in-card «Después» preview (identity hook)', () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  const a = r.active();
  assert.ok(a.includes('class="stop-header"') && a.includes('Parada 1 de 2'), 'stop header «Parada 1 de 2»');
  assert.ok(a.includes('class="strip"'), 'phase strip rendered');
  assert.ok(a.includes('class="map"'), 'overview map mounted');
  assert.ok(a.includes('id="btn-delivered"') && a.includes('class="slide-thumb"'), 'active card slide hook');
  assert.ok(a.includes('<span class="bagtag a">1</span>'), 'active bag tag 1');
  assert.ok(a.includes('class="pactual">Parada actual'), 'parada-actual pill');
  assert.ok(a.includes('Navegar con Waze') && a.includes('→ '), 'navBtn: «Navegar con {app}» + «→ {destino}»');
  // stop 2 is the «Después» preview INSIDE the active card (after-card + identity hook, bag tag 2); queue-slot is empty with 2 stops.
  assert.ok(a.includes('class="after-card" data-order-id="B"'), 'stop-2 preview in the card carries the orderId hook');
  assert.ok(a.includes('<span class="bagtag b">2</span>'), 'preview bag tag 2');
  assert.equal(r.queue(), '', 'queue-slot empty with only 2 stops (stop 2 is the in-card preview)');
  assert.equal(r.rec.mapTimerEnsured >= 1, true, 'map-age lifecycle timer armed on mount');
});

// 1b. A THIRD stop lands in #queue-slot as an after-card with its identity hook (the in-card preview is stop 2).
t('stacked (3 orders): stop 3 renders in #queue-slot as an after-card with the orderId hook (bag tag 3)', () => {
  const r = run({ orders: [delivery('A'), delivery('B'), delivery('C')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  assert.ok(r.active().includes('class="after-card" data-order-id="B"'), 'stop 2 is the in-card preview');
  const q = r.queue();
  assert.ok(q.includes('class="after-card" data-order-id="C"'), 'stop 3 is a queue-slot after-card with the orderId hook');
  assert.ok(q.includes('<span class="bagtag b">3</span>'), 'queued stop 3 bag tag');
  assert.ok(!q.includes('data-order-id="B"'), 'stop 2 is NOT duplicated into the queue slot');
});

// 2. REAL slide binds to the REAL handler on the REAL builder markup → completeTask fired.
t('stacked delivery: dragging the real btn-delivered slide calls XPD.completeTask with the delivery task id', async () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000);
  assert.ok(r.writes.complete, 'completeTask was called through the real handler');
  assert.equal(r.writes.complete.taskId, 'A_d', 'targets the ACTIVE order A delivery task');
  r.writes.complete.resolve(); await tick();
});

// 3. Pickup active: the real btn-pickup slide calls pickupComplete (its batch completion is frozen SDK).
t('stacked pickup: dragging btn-pickup calls XPD.pickupComplete for the active pickup task', async () => {
  const r = run({ orders: [pickup('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  const d = r.prep('btn-pickup'); r.down(d); r.move(1000); await r.up(1000);
  assert.ok(r.writes.pickup && r.writes.pickup.taskId === 'A_p', 'pickupComplete called for A_p');
  r.writes.pickup.resolve(); await tick();
});

// 4. A→B promotion reaches the SLICE2:SINGLE-ORDER-MOUNT map; completed A is absent from the board.
t('A→B promotion: when A leaves, the lone B renders the single-order card WITH the overview map; A absent', () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  assert.ok(r.active().includes('class="after-card" data-order-id="B"'), 'B starts as the in-card «Después» preview');
  r.markDelivered('A'); r.setOrders([delivery('B')]); r.render();   // A DELIVERED (affirmative status) + off the board → lone B promoted
  assert.ok(r.activeEl().classList.contains('solo'), 'lone B → solo single-order layout');
  assert.ok(r.active().includes('class="map"'), 'promoted lone B gets the overview map (SINGLE-ORDER-MOUNT)');
  assert.ok(r.active().includes('class="active-card"'), 'the promoted stop renders the prototype STOP card (activeCardHtml, advisor #3)');
  assert.ok(!r.active().includes('>A<') && !r.active().includes('data-order-id="A"'), 'completed A is off the board');
  assert.equal(r.banner(), '', 'no banner'); assert.equal(r.queue(), '', 'no queue');
});

// 4b. TRANSITION LAYOUT (Fix 2, advisor 2026-10-23): two-stop stacked → deliver stop 1 → the promoted single-order
//     render must leave NO stale stacked node in the flow (the ~380px map↔card gap in an earlier build). The
//     post-transition #active-order-slot is a CLEAN single-order structure and the card immediately follows the map.
t('transition 2→1: delivering stop 1 leaves a CLEAN single-order layout — no stale node / map↔card gap', () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  r.markDelivered('A'); r.setOrders([delivery('B')]); r.render();   // A delivered (affirmative) → drv2Observe records A done → single-order B WITH history
  const kids = Array.from(r.activeEl().children);
  const empties = kids.filter((c) => c.children.length === 0 && (c.textContent || '').trim() === '');
  assert.equal(empties.length, 0, 'no empty/childless leftover node (the old stacked container that caused the gap)');
  const cls = kids.map((c) => String(c.className || ''));
  const mapI = cls.findIndex((c) => /(^|\s)map(\s|$)/.test(c));
  assert.ok(mapI >= 0, 'overview map present after the transition');
  assert.ok(/active-card/.test(cls[mapI + 1] || ''), 'the promoted stop card IMMEDIATELY follows the map (no gap node between)');
  assert.ok(r.activeEl().classList.contains('solo'), 'lone promoted order → solo layout (equals a direct apParada2 render)');
});

// 5. Staleness drives the map render: fresh fix → not stale; old fix → stale (dimmed) class.
t('map staleness: a fresh last_location_ts renders a live map; an old one renders class="map stale"', () => {
  const fresh = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: Date.now() } });
  assert.ok(!fresh.active().includes('class="map stale"'), 'fresh fix → not stale');
  const old = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: Date.now() - 5 * 60 * 1000 } });
  assert.ok(old.active().includes('class="map stale"'), 'a 5-min-old fix → stale/dimmed');
  const missing = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03 } });
  assert.ok(missing.active().includes('class="map stale"'), 'missing last_location_ts → stale (conservative)');
});

// 6. SLICE2:QUEUE-IDENTITY: tapping a real queued card opens the read-only sheet (NO nav — owner ruling
//    2026-10-23); a stale card whose orderId left the queue FAILS CLOSED (no index fallback, no wrong-stop sheet).
t('queue identity: tapping a queue-slot after-card opens the read-only sheet by orderId (NO nav — owner ruling); a stale/gone card is a no-op', () => {
  // 3 stops → C is a real #queue-slot after-card (B is the in-card preview). The #screen-onshift delegate resolves
  // the tap by data-order-id against a FRESHLY computed board and opens the read-only sheet.
  const r = run({ orders: [delivery('A'), delivery('B'), delivery('C', { name: 'Carlos' })], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  r.clickCard('.after-card[data-order-id="C"]');
  assert.ok(r.sheetOpen(), 'sheet opened for the resolved order');
  const s = r.sheet();
  assert.ok(s.includes('Carlos'), 'sheet shows C’s customer');
  assert.ok(!s.includes('waze-btn') && !s.includes('maps-btn') && !s.includes('nav-row'), 'read-only sheet has NO nav (owner ruling 2026-10-23 supersedes Codex P1-1)');
  assert.ok(s.includes('nunca se entrega fuera de orden'), 'completion-lock copy present');
  assert.ok(s.includes('id="queue-sheet-close"'), 'close hook present');
  // Fail-closed: inject a stale after-card for an order no longer on the board and tap it → no sheet change.
  r.document.getElementById('queue-sheet').classList.remove('open');
  const stale = r.document.createElement('div');
  stale.className = 'after-card'; stale.setAttribute('data-order-id', 'GONE');
  r.document.getElementById('queue-slot').appendChild(stale);
  stale.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(r.sheetOpen(), false, 'a card whose orderId is gone from the board fails CLOSED (no index fallback)');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// MIGRATED from single-order-branch.test.js (slice-1 P2-6 harness, RETIRED — advisor ruling 2026-10-21).
// Every cell here drives the REAL single-order path (singleOrderCardHtml + the real attachSlideConfirm drag
// + the real XPD writers), replacing the slice-1 harness that stubbed renderActiveCard/renderQueue and
// asserted the 2-order stacked render was byte-identical to baseline — an invariant slice 2 intentionally
// overturns (it reroutes the stacked path through the builders; renderActiveCard is now dead code, see the
// census unreachableOnSurface entries). The retired file's mapping table is in the hand-back evidence.

// M1 ← slice-1 "1 order → single-order card, .solo, cleared", RETUNED (Codex r2 visual): a committed single stop
// renders the UNIFIED prototype STOP card (activeCardHtml) + the «Única parada» header + the SINGLE-ORDER-MOUNT map,
// NOT the retired slice-1 single-order card.
t('M1 gate: 1 order → the prototype stop card (.active-card) + «Única parada» header + overview map; banner & queue cleared', () => {
  const r = run({ orders: [delivery('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  assert.ok(r.activeEl().classList.contains('solo'), 'active slot gets .solo');
  assert.ok(r.active().includes('class="active-card"'), 'the UNIFIED prototype stop card rendered (Codex r2)');
  assert.ok(r.active().includes('class="stop-header"') && r.active().includes('Única parada'), '«Única parada» stop header (end-shift power reachable)');
  assert.ok(r.active().includes('class="map"'), 'the single-order overview map mounted (SINGLE-ORDER-MOUNT)');
  assert.ok(!r.active().includes('sv-card'), 'NOT the retired slice-1 single-order card');
  assert.equal(r.banner(), '', 'banner cleared'); assert.equal(r.queue(), '', 'queue cleared');
});

// M2 ← slice-1 "0 orders → idle".
t('M2 gate: 0 orders → idle path (renderIdleState), no .solo, slots cleared', () => {
  const r = run({ orders: [] });
  assert.equal(r.rec.idle, true, 'renderIdleState ran');
  assert.equal(r.activeEl().classList.contains('solo'), false, 'no solo on idle');
  assert.equal(r.active(), ''); assert.equal(r.banner(), ''); assert.equal(r.queue(), '');
});

// M3/M4 ← slice-1 geofence cells, RETUNED to the stop card (Codex r2): the pickup stop card shows the arrived
// note when inside the geofence, else the nav button — both with the Recogí slide. The slice-1 «Ya estoy en el
// restaurante» review latch is GONE (unified stop card; the latch was client-only, no server write).
t('M3 arrived: pickup @ 49 m → ARRIVED → «Has llegado al restaurante» note + the Recogí slide', () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 49 });
  assert.ok(r.active().includes('Has llegado al restaurante'), 'the geofence arrived note on the stop card');
  assert.ok(r.active().includes('id="btn-pickup"'), 'the Recogí slide');
  assert.ok(!r.active().includes('id="btn-at-restaurant"'), 'no review toggle (latch removed)');
});
t('M4 threshold: pickup @ 51 m → NOT arrived → the nav button + the Recogí slide (no arrived note, no review toggle)', () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 51 });
  assert.ok(r.active().includes('Navegar con'), 'the nav button renders when not arrived');
  assert.ok(r.active().includes('id="btn-pickup"'), 'the Recogí slide');
  assert.ok(!r.active().includes('Has llegado'), 'not arrived → no arrived note');
  assert.ok(!r.active().includes('id="btn-at-restaurant"'), 'the review latch is gone (unified stop card)');
});

// M5–M9 RETIRED (Codex r2 confirmed 2026-10-24): the slice-1 «Ya estoy en el restaurante» review latch
// (slice1ReviewLatchKey + btn-at-restaurant) is dropped by unifying the single stop on the prototype stop card.
// It was CLIENT-ONLY (no server write) so nothing is lost; the server-side arriveAtRestaurant / geofence
// at_restaurant paths are separate and remain byte-unchanged (proven by the freeze guard on xpizza-delivery.js).

// M10 ← slice-1 "(a) 1→2 while a drag is in progress → deferred, replayed on drag-end" (retuned to the stop card).
t('M10 defer: 1→2 while a slide drag is in progress → render DEFERS (renderPending), replays to stacked on drag-end', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 49 });
  const d = r.prep('btn-pickup');
  r.down(d);
  assert.ok(r.api.getSliding(), 'slidingEl set during the drag');
  r.setOrders([delivery('A'), delivery('B')]); r.render();  // 2 orders arrive mid-drag
  assert.equal(r.api.getRenderPending(), true, 'render DEFERRED (not applied mid-drag)');
  assert.ok(r.active().includes('Única parada'), 'DOM still shows the SINGLE stop during the drag');
  r.move(20); await r.up(20);                               // release below threshold → reset + replay
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared on drag-end');
  assert.ok(r.active().includes('Parada 1 de 2') && !r.active().includes('Única parada'), 'the deferred render replayed into the stacked builder');
});

// M11 ← slice-1 "(b) 2→1 while an action write is pending → deferred, replayed when the write settles".
t('M11 defer: 2→1 while a delivery write is PENDING → deferred during the await, single view on settle', async () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  assert.ok(r.active().includes('Parada 1 de 2'), 'starts stacked (2 orders)');
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000);  // completeTask PENDING
  assert.ok(r.writes.complete, 'the delivery write is in flight');
  assert.ok(r.api.getSliding(), 'slidingEl held while the write is pending');
  r.setOrders([delivery('A')]); r.render();                 // feed drops to 1 while pending
  assert.equal(r.api.getRenderPending(), true, 'render deferred while the write is pending');
  r.writes.complete.resolve(); await tick();
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared after the write settled');
  assert.ok(r.active().includes('Única parada'), 'replayed into the single stop card (1 order)');
});

// M12 ← slice-1 "(c) rejected write recovers (slider reset, toast, slidingEl cleared)".
t('M12 recover: a rejected pickup write → slider RESETS (no .completed), error toast, slidingEl cleared', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 49 });  // arrived → btn-pickup
  assert.ok(r.active().includes('id="btn-pickup"'), 'the stop card renders the server pickup slide');
  const d = r.prep('btn-pickup'); r.down(d); r.move(1000);
  const upDone = r.up(1000); await tick();
  assert.ok(r.writes.pickup, 'pickupComplete write in flight');
  r.writes.pickup.reject(new Error('boom'));
  await upDone; await tick();
  assert.equal(d.el.classList.contains('completed'), false, 'slider reset — not left completed');
  assert.ok(r.rec.toasts.some(([, k]) => k === 'error'), 'an error toast was shown');
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared on the error path');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// runReal — the REAL-WRITER integration proof (Codex r1 P2-4). Real lifted SDK over the faithful mock transport.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// (a) same-hub accept — acceptTask auto-accepts the same-hub stacked order via the REAL stackedTasksToAccept.
t('runReal (a) same-hub accept: acceptTask on A auto-accepts the same-hub stacked B', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBX, created: 2 },
  ]) });
  await r.XPD.acceptTask('drv', 'A_p');
  assert.equal(r.read('tasks/A_p').status, TASK_STATUS.ACCEPTED, 'A pickup accepted (real acceptTask)');
  assert.equal(r.read('tasks/B_p').status, TASK_STATUS.ACCEPTED, 'same-hub B auto-accepted (real stackedTasksToAccept)');
  assert.equal(r.read('drivers/drv').current_task_id, 'A_p', 'A is the current task');
  r.render();
  assert.equal(r.board().length, 2, 'both A and B now on the board (pickup phase)');
});

// (b) cross-hub explicit accept — acceptSecondOrder accepts B without re-stamping the current task/hub.
t('runReal (b) cross-hub explicit accept: acceptSecondOrder accepts B WITHOUT changing the current task', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBM, created: 2 },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d';
  const res = await r.XPD.acceptSecondOrder('drv', 'B_p');
  assert.ok(res && res.ok, 'acceptSecondOrder committed (real runTransaction)');
  assert.equal(r.read('tasks/B_p').status, TASK_STATUS.ACCEPTED, 'B accepted');
  assert.equal(r.read('drivers/drv').current_task_id, 'A_d', 'current task UNCHANGED (in-progress order keeps its hub)');
});

// (c) batch pickup — pickupComplete completes the active pickup AND the stacked pickup atomically.
t('runReal (c) batch pickup: pickupComplete completes the active + stacked pickups and promotes their deliveries', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.ACCEPTED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.ACCEPTED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2 },
  ]) });
  await r.XPD.pickupComplete('drv', 'A_p');
  assert.equal(r.read('tasks/A_p').status, TASK_STATUS.COMPLETED, 'A pickup completed');
  assert.equal(r.read('tasks/B_p').status, TASK_STATUS.COMPLETED, 'stacked B pickup auto-completed (batch, real pickupComplete)');
  assert.equal(r.read('tasks/A_d').status, TASK_STATUS.ACCEPTED, 'A delivery promoted');
  r.render();
  assert.ok(r.board().every((o) => o.phase === 'delivery'), 'both orders now in delivery phase');
});

// (d) cancel/reassign — a cancelled or reassigned task drops its order from the real board.
t('runReal (d) cancel/reassign: a cancelled task — and a reassigned one — drop the order from the board', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, created: 1 },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, created: 2 },
  ]) });
  assert.equal(r.board().length, 2, 'A + B on the board');
  r.read('tasks/B_p').status = TASK_STATUS.CANCELLED; r.read('tasks/B_d').status = TASK_STATUS.CANCELLED;
  r.render();
  assert.equal(r.board().length, 1, 'cancelled B dropped by real getDriverOrders');
  assert.ok(!r.queue().includes('data-order-id="B"'), 'B gone from the queue');
  const r2 = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, created: 1 },
    { id: 'C', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, created: 2 },
  ]) });
  r2.read('tasks/C_p').assigned_driver_id = 'other'; r2.read('tasks/C_d').assigned_driver_id = 'other';
  r2.render();
  assert.ok(!r2.queue().includes('data-order-id="C"'), 'reassigned C gone (own-filter)');
});

// (e) WRITER-DRIVEN PROMOTION — drag the real btn-delivered → real completeTask → A completes → lone B promotes.
t('runReal (e) promotion: real drag → real completeTask(A) → A completes in the mock → B promotes to the single-order view + map', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  assert.ok(r.active().includes('class="bagtag'), 'starts stacked (A active, B queued)');
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000); await tick();
  assert.equal(r.read('tasks/A_d').status, TASK_STATUS.COMPLETED, 'A delivery completed by the REAL writer (buildCompleteTaskUpdates)');
  r.render();
  assert.equal(r.board().length, 1, 'A dropped (completed); only B remains');
  assert.ok(r.activeEl().classList.contains('solo') && r.active().includes('class="active-card"'), 'lone B → promoted stop card (activeCardHtml, advisor #3)');
  assert.ok(r.active().includes('class="map"'), 'promoted B gets the SINGLE-ORDER-MOUNT map');
  assert.ok(!r.queue().includes('data-order-id="A"'), 'A off the board');
});

// MAP MODEL (kills drv2-25): two pending cross-hub offers → two peer customer pins AND both hubs on the map.
t('runReal map model (kills drv2-25): TWO pending cross-hub offers → TWO peer pins + BOTH hubs', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBX, created: 1, lat: 15.40, lng: -88.00 },
    { id: 'B', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBM, created: 2, lat: 15.45, lng: -88.05 },
  ]) });
  const a = r.active();
  const pins = (a.match(/class="om-stop"/g) || []).length;
  const hubs = (a.match(/class="om-hub"/g) || []).length;
  assert.ok(pins >= 2, `every visible destination (incl. the pending offer) is a pin — got ${pins}`);
  assert.ok(hubs >= 2, `cross-hub: both hubs shown — got ${hubs}`);
});

// QUEUE-SHEET IS READ-ONLY (owner ruling 2026-10-23, supersedes Codex P1-1): a queued order's sheet shows its
// info but offers NO navigation — navigation exists only for the ACTIVE stop, so a driver cannot route to stop 2
// before delivering stop 1.
t('runReal queue-sheet (owner ruling 2026-10-23): a queued order opens a READ-ONLY sheet with its info but NO nav', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, lat: 15.40, lng: -88.00 },
    { id: 'B', pickup: TASK_STATUS.ACCEPTED, delivery: TASK_STATUS.ACCEPTED, hub: HUBM, created: 2, lat: 15.45, lng: -88.05, addr: 'Res. Los Robles' },
  ]) });
  // With 2 stops, the queued B is the in-card «Después» preview (after-card). Tapping it bubbles to the
  // #screen-onshift delegate, which resolves by orderId and opens the read-only sheet.
  assert.ok(r.active().includes('class="after-card" data-order-id="B"'), 'B (still pickup phase) is the in-card preview');
  const bCard = r.document.querySelector('.after-card[data-order-id="B"]');
  assert.ok(bCard, 'B after-card present');
  bCard.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(r.sheetOpen(), 'sheet opened for B');
  const s = r.sheet();
  assert.ok(s.includes('Res. Los Robles'), 'read-only sheet still shows B’s CUSTOMER address (info)');
  assert.ok(!s.includes('waze-btn') && !s.includes('maps-btn') && !s.includes('nav-row'), 'NO nav controls in the queued sheet');
  assert.ok(!s.includes('waze.com/ul'), 'no navigation URL to a queued stop');
});

// ── P2-1 mock-faithfulness boundary cells (prove the mock is NOT laxer than Firebase) ──
t('runReal mock (boundary): multi-path update VALIDATES atomically — undefined value / overlapping paths throw, mutate NOTHING', async () => {
  const r = runReal({ seed: seed([{ id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED }]) });
  const before = JSON.stringify(r.data);
  await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), { 'x/a': 1, 'x/a/b': 2 }), /overlapping/i, 'overlapping ancestor+descendant paths reject');
  assert.equal(JSON.stringify(r.data), before, 'nothing mutated by the overlapping update');
  await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), { 'tasks/A_d/foo': undefined }), /undefined/i, 'undefined value rejects');
  assert.equal(JSON.stringify(r.data), before, 'nothing mutated by the undefined update');
});
t('runReal mock (boundary, r3-1): validation is RECURSIVE and path-NORMALIZED — the holes Codex found reject like the SDK', async () => {
  const r = runReal({ seed: seed([{ id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED }]) });
  const before = JSON.stringify(r.data);
  // nested undefined — a top-level-only check missed `{ value: undefined }`
  await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), { 'probe': { value: undefined } }), /undefined/i, 'NESTED undefined rejects');
  await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), { 'probe': { a: { b: undefined } } }), /undefined/i, 'deeply nested undefined rejects');
  assert.equal(JSON.stringify(r.data), before, 'nothing mutated by the nested-undefined updates');
  // trailing-slash / empty-segment path — a raw string prefix check missed `probe/a/` vs `probe/a/b`
  await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), { 'probe/a/': 1, 'probe/a/b': 2 }), /overlapping/i, 'trailing-slash ancestor still collides with its descendant');
  assert.equal(JSON.stringify(r.data), before, 'nothing mutated by the normalized-overlap update');
  // a legitimate serverTimestamp sentinel is NOT mistaken for undefined
  await r.fb.update(r.fb.ref(r.fb.db), { 'probe/ts': r.fb.serverTimestamp() });
  assert.equal(typeof r.read('probe/ts'), 'number', 'serverTimestamp sentinel resolved, not rejected');
});
t('mock vs installed Firebase SDK (r3-1): the real SDK rejects the SAME inputs the mock rejects', async () => {
  // Codex r3-1: confirm against the INSTALLED SDK (xpizza-functions/node_modules/firebase) that the mock's
  // validation is not laxer. The client SDK's update() validates arguments SYNCHRONOUSLY before any network —
  // so these throws need no connection. Each input must be rejected by BOTH the SDK and the mock.
  const { initializeApp } = require('firebase/app');
  const { getDatabase, goOffline, ref: fref, update: fupdate } = require('firebase/database');
  const app = initializeApp({ databaseURL: 'https://validation-probe.firebaseio.com' }, 'slice2-sdk-' + Date.now());
  const db = getDatabase(app);
  goOffline(db);   // arg validation is synchronous and needs no network; stay offline so no connection warning is logged
  const root = fref(db);
  const r = runReal({ seed: seed([{ id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED }]) });
  const cases = [
    ['nested undefined', { probe: { value: undefined } }, /undefined/i],
    ['deep undefined', { probe: { a: { b: undefined } } }, /undefined/i],
    ['overlapping paths', { 'probe/a': 1, 'probe/a/b': 2 }, /overlapping|ancestor/i],
    ['trailing-slash overlap', { 'probe/a/': 1, 'probe/a/b': 2 }, /overlapping|ancestor/i],
  ];
  for (const [label, input, re] of cases) {
    assert.throws(() => fupdate(root, input), /undefined|ancestor/i, `installed SDK rejects ${label}`);   // SDK throws SYNC on bad args
    await assert.rejects(() => r.fb.update(r.fb.ref(r.fb.db), input), re, `mock rejects ${label} like the SDK`);
  }
});
t('runReal mock (boundary, r3-1): runTransaction RE-RUNS the callback when the value changed underneath (one conflict-retry)', async () => {
  const r = runReal({ seed: { ctr: { n: 5 }, tasks: {}, orders: {} } });
  r.queueConflict('ctr', { n: 10 });   // a concurrent writer commits n:10 between this txn's read and its commit
  let calls = 0;
  const res = await r.fb.runTransaction(r.fb.ref(r.fb.db, 'ctr'), (cur) => { calls++; return { n: (cur && cur.n || 0) + 1 }; });
  assert.equal(calls, 2, 'callback ran TWICE — first against 5, then re-ran against the conflicting 10');
  assert.ok(res.committed && r.read('ctr/n') === 11, 'committed the RETRY result 10→11, not the stale 5→6');
});
t('runReal mock (boundary): null deletion PRUNES now-empty parents (no leftover {})', async () => {
  const r = runReal({ seed: { nest: { a: { b: 1 } }, tasks: {}, orders: {} } });
  await r.fb.update(r.fb.ref(r.fb.db), { 'nest/a/b': null });
  assert.equal(r.read('nest/a'), undefined, 'empty parent "a" pruned');
  assert.equal(r.read('nest'), undefined, 'empty grandparent "nest" pruned');
});
t('runReal mock (boundary): runTransaction runs against the CURRENT value and aborts on undefined (no speculative commit)', async () => {
  const r = runReal({ seed: { ctr: { n: 5 }, tasks: {}, orders: {} } });
  const ok = await r.fb.runTransaction(r.fb.ref(r.fb.db, 'ctr'), (cur) => { cur.n += 1; return cur; });
  assert.ok(ok.committed && r.read('ctr/n') === 6, 'ran against the CURRENT value (5→6), committed — not a speculative null');
  const ab = await r.fb.runTransaction(r.fb.ref(r.fb.db, 'ctr'), () => undefined);
  assert.ok(!ab.committed && r.read('ctr/n') === 6, 'returning undefined ABORTS — value unchanged');
});

// ── P2-2 inventory guard is alias-aware (Codex r3-2) ──
t('inventory guard (r3-2): an ALIASED import of an unimplemented export, called by its local name, is caught', () => {
  // the real guard parses bindings + resolves local names; prove it catches the exact hole Codex found.
  const aliased = `import { increment as inc } from 'https://x/firebase-database.js';`;
  assert.deepEqual(uncoveredFbCalls('const z = inc(1);', parseFbBindings(aliased)), ['inc'],
    'aliased increment-as-inc called as inc(1) is flagged uncovered');
  // multi-declaration + plain alias of an IMPLEMENTED export is NOT a false positive (ref is in FB_INVENTORY)
  const impl = `import { ref as r } from 'https://x/firebase-database.js';\nimport { get } from 'https://x/firebase-app.js';`;
  assert.deepEqual(uncoveredFbCalls('r(db, "x"); get(x);', parseFbBindings(impl)), [],
    'an alias of an implemented export (ref as r) is not falsely flagged; multiple firebase imports are scanned');
  // prose that merely NAMES the local without calling it is not a call
  assert.deepEqual(uncoveredFbCalls('// we could inc later', parseFbBindings(aliased)), [],
    'a mention without a call () is not flagged');
});

// ── P2-3 the REAL incoming-banner handler drives a real acceptSecondOrder ──
t('runReal banner accept: the REAL attachIncomingBannerHandlers slide → real acceptSecondOrder over the mock', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.ASSIGNED, delivery: TASK_STATUS.ASSIGNED, hub: HUBM, created: 2 },   // awaiting cross-hub → banner
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d';
  assert.ok(r.banner().includes('btn-accept-inc-B'), 'B surfaces as an incoming banner');
  const d = r.prep('btn-accept-inc-B'); r.down(d); r.move(1000); await r.up(1000); await tick();
  assert.equal(r.read('tasks/B_p').status, TASK_STATUS.ACCEPTED, 'the REAL banner handler accepted B via real acceptSecondOrder');
  assert.equal(r.read('drivers/drv').current_task_id, 'A_d', 'current task unchanged (cross-hub 2nd order keeps the in-progress hub)');
});

// ── P3 REAL map-lifecycle regression (lifts the real timer fns + visibilitychange handler + cleanupShift) ──
function liftVisibilityHandler(script) {
  const anchor = "document.addEventListener('visibilitychange', async () => {";
  const at = script.indexOf(anchor);
  assert.notEqual(at, -1, 'visibilitychange async handler not found (anchor moved?)');
  let depth = 0;
  for (let i = at + anchor.length - 1; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') { depth--; if (depth === 0) return script.slice(at, script.indexOf(';', i) + 1); }
  }
  throw new Error('unbalanced visibility handler');
}
function runLifecycle() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  let vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
  const spies = { render: 0, statusBar: 0, gps: 0, wakeLockCalls: 0, interludeDismissed: 0, runReset: 0 };
  const renderActiveAndQueue = () => { spies.render += 1; };
  const renderStatusBar = () => { spies.statusBar += 1; };
  const startGpsStream = () => { spies.gps += 1; };
  const acquireWakeLock = () => { spies.wakeLockCalls += 1; return new Promise(() => {}); };   // NEVER resolves
  const driverState = { active: true };
  const navigator = { geolocation: { clearWatch() {} } };
  const body = 'let slice2MapAgeTimer=null; const SLICE2_MAP_AGE_MS=30000;\n'
    + 'let wakeLock=null, watchId=null, lastUpdateAt=0;\n'
    // P2-8: cleanupShift now clears the per-run terminal state on shift/session disposal — spy the two calls here
    // (this harness owns the map-timer + lifecycle; the run-state reset is proven by these spies + the runReal cells).
    + 'let drv2DoneRun=[1];\n'
    + 'function drv2DismissInterlude(){ _spies.interludeDismissed += 1; }\n'
    + 'function drv2ResetRun(){ _spies.runReset += 1; drv2DoneRun = []; }\n'
    + liftFn(MY_SCRIPT, 'ensureSlice2MapAgeTimer') + '\n'
    + liftFn(MY_SCRIPT, 'stopSlice2MapAgeTimer') + '\n'
    + liftFn(MY_SCRIPT, 'cleanupShift') + '\n'
    + liftVisibilityHandler(MY_SCRIPT) + '\n'
    + 'return { ensure: ensureSlice2MapAgeTimer, stop: stopSlice2MapAgeTimer, cleanup: cleanupShift, timerSet: () => slice2MapAgeTimer != null, doneRun: () => drv2DoneRun };';
  const names = ['document', 'setInterval', 'clearInterval', 'renderActiveAndQueue', 'renderStatusBar', 'startGpsStream', 'acquireWakeLock', 'driverState', 'navigator', 'isNative', 'pingNativeLocation', '_spies'];
  const api = (new Function(...names, body))(document, setInterval, clearInterval, renderActiveAndQueue, renderStatusBar, startGpsStream, acquireWakeLock, driverState, navigator, () => false, () => {}, spies);
  return { document, spies, api, setVis: (v) => { vis = v; }, fireVis: () => document.dispatchEvent(new dom.window.Event('visibilitychange')) };
}
t('runLifecycle (a): tab HIDE clears the aging timer SYNCHRONOUSLY (not on the next ~30 s tick)', () => {
  const L = runLifecycle();
  L.api.ensure();
  assert.ok(L.api.timerSet(), 'timer armed while visible');
  L.setVis('hidden'); L.fireVis();
  assert.ok(!L.api.timerSet(), 'timer cleared the INSTANT the tab hid (synchronously in the handler)');
});
t('runLifecycle (b): cleanupShift (shift/session disposal) clears the aging timer', async () => {
  const L = runLifecycle();
  L.api.ensure();
  assert.ok(L.api.timerSet(), 'timer armed');
  await L.api.cleanup();
  assert.ok(!L.api.timerSet(), 'cleanupShift stopped the timer (SLICE2:SHIFT-CLEANUP)');
  assert.ok(L.spies.runReset >= 1 && L.spies.interludeDismissed >= 1, 'cleanupShift also cleared the per-run terminal state (drv2ResetRun + drv2DismissInterlude) — P2-8 shift/session disposal');
  assert.deepEqual(L.api.doneRun(), [], 'the recent-completion memory is emptied on disposal');
});
t('runLifecycle (c): on resume, the re-age (renderActiveAndQueue) runs BEFORE the awaited acquireWakeLock() settles', async () => {
  const L = runLifecycle();
  L.setVis('visible'); L.fireVis();
  await tick();
  assert.equal(L.spies.render, 1, 're-age ran');
  assert.equal(L.spies.wakeLockCalls, 1, 'acquireWakeLock was called (and NEVER resolves)');
  assert.equal(L.spies.statusBar, 0, 'post-await resume work did NOT run — the re-age happened while the wake-lock promise is still pending');
  L.api.stop();   // clear the real interval the re-age armed, so node can exit
});

// ── P1 deferred-render privacy repro (kills drv2-29 = removing the QUEUE-IDENTITY awaiting gate) ──
t('runReal deferred-render privacy (kills drv2-29): a queued order gone to awaiting during a deferred render → its retained card opens NOTHING', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto Secreto' },
  ]) });
  assert.ok(r.active().includes('class="after-card" data-order-id="B"'), 'B starts accepted + queued (the in-card preview)');
  const d = r.prep('btn-delivered'); r.down(d);   // begin A's completion drag → slidingEl set
  // B goes back to awaiting_acceptance in the feed; the render DEFERS (drag in progress) so B's card is RETAINED/stale.
  r.read('tasks/B_p').status = TASK_STATUS.ASSIGNED; r.read('tasks/B_d').status = TASK_STATUS.ASSIGNED;
  r.render();   // deferred under the drag — the stale B after-card stays in the DOM
  const staleB = r.document.querySelector('.after-card[data-order-id="B"]');
  assert.ok(staleB, 'the stale B after-card is retained under the deferred render');
  staleB.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(!r.sheetOpen(), 'the sheet does NOT open for an order now awaiting (STACKED-HANDLERS awaiting gate)');
  assert.ok(!r.sheet().includes('Beto Secreto') && !r.sheet().includes('99998888') && !r.sheet().includes('waze-btn'), 'no awaiting-order name/phone/nav leaked into the sheet body');
  r.move(20); await r.up(20);   // finish the drag (below threshold)
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// P2-10 — the NEW safety paths exercised through the REAL observer + pointer, over the live mock (Codex r1).
// These cells are the mutation tripwires: disabling the pointer binding OR the cancel/affirmative classifier
// turns at least one RED (the old build's empty-globals observer let both regress silently).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// P1-1 pointer binding (kills a mutation to `active = orders[0]`): board order is [A, B] (A created first), but the
// driver's current_task_id points at B — so B is the ACTIVE card and A becomes the «Después» preview.
t('P1-1 active = current_task_id pointer, not board[0]: pointer→B makes B active (A the preview)', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2 },
  ]) });
  assert.equal(r.board()[0].orderId, 'A', 'board order is A then B (A created first)');
  r.read('drivers/drv').current_task_id = 'B_d'; r.render();
  assert.ok(r.active().includes('class="active-card" data-order-id="B"'), 'B (the pointer) is the ACTIVE card — not board[0]=A');
  assert.ok(r.active().includes('class="after-card" data-order-id="A"'), 'A is the «Después» preview behind the pointer stop');
});

// P1-1 fail-closed (kills removing the gate): accepted stops but the pointer resolves to NONE (missing/disagree)
// → the nav + Entregado controls are neutralized (is-gated, href stripped), read-only, no new copy.
t('P1-1 fail closed: a missing/disagreeing pointer gates the nav + Entregado controls', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2 },
  ]) });
  r.read('drivers/drv').current_task_id = 'ZZZ_nonexistent'; r.render();   // points at no board stop → disagree
  const del = r.activeEl().querySelector('#btn-delivered');
  assert.ok(del && del.classList.contains('is-gated'), 'Entregado slide is gated (fail-closed)');
  const nav = r.activeEl().querySelector('.nav-btn, .sv-nav-primary');
  assert.ok(nav && nav.classList.contains('is-gated') && !nav.getAttribute('href'), 'nav button gated + href stripped (cannot launch nav)');
});

// P1-2 cancel, ORDER-first (kills the cancel classifier): B leaves the board AND its order status is 'cancelled'
// → the cancel banner is raised and B is never recorded done.
t('P1-2 cancel (order-first): a cancelled queued stop raises the banner, never a phantom delivery', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();   // A active, B queued — observed
  r.read('orders/B').status = ORDER_STATUS.CANCELLED;
  r.read('tasks/B_p').status = TASK_STATUS.CANCELLED; r.read('tasks/B_d').status = TASK_STATUS.CANCELLED;  // B drops from the board
  r.render();
  assert.ok(r.api.getCancel(), 'the cancel banner is armed from the confirmed cancelled status');
  assert.ok(!r.api.getDoneRun().some((d) => d.orderId === 'B'), 'cancelled B is NOT recorded as a delivery');
  assert.ok(!r.api.getInterlude(), 'no delivered interlude for a cancellation');
});

// P1-2 cancel, TASK-first + late-snapshot reconcile: the task leg vanishes BEFORE the order status flips. The
// observer must NOT bank anything on the bare disappearance; it reconciles when the status later confirms cancel.
t('P1-2 cancel (task-first): a bare disappearance banks nothing; the banner appears only once status confirms', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();
  r.read('tasks/B_p').status = TASK_STATUS.CANCELLED; r.read('tasks/B_d').status = TASK_STATUS.CANCELLED;  // legs gone, status still live
  r.render();
  assert.ok(!r.api.getCancel(), 'no banner yet — the order status has not confirmed the cancellation');
  assert.ok(!r.api.getDoneRun().some((d) => d.orderId === 'B'), 'and definitely no phantom delivery from the disappearance');
  r.read('orders/B').status = ORDER_STATUS.CANCELLED; r.render();   // late snapshot confirms
  assert.ok(r.api.getCancel(), 'the banner appears once the cancelled status reconciles');
});

// P1-2 reassign (THE discriminator — kills the old "disappearance ⇒ delivered" bug): B is reassigned to another
// driver (its legs survive under that driver). B must drop SILENTLY — no banner, no done, no interlude.
t('P1-2 reassign: a stop reassigned away drops silently — never a phantom delivery or cash', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();
  r.read('tasks/B_p').assigned_driver_id = 'other'; r.read('tasks/B_d').assigned_driver_id = 'other';  // reassigned away (legs survive)
  r.render();
  assert.ok(!r.board().some((o) => o.orderId === 'B'), 'B is off MY board (owned by another driver)');
  assert.ok(!r.api.getDoneRun().some((d) => d.orderId === 'B'), 'reassigned B is NOT recorded delivered (the old bug)');
  assert.ok(!r.api.getInterlude(), 'no «Cobraste» interlude for a reassignment');
  assert.ok(!r.api.getCancel(), 'no cancel banner for a reassignment');
});

// P1-2 delivered (affirmative): A, the active stop, is delivered through the REAL completeTask drag → recorded
// done + the interlude armed (A was active), with B promoted behind it.
t('P1-2 delivered: the active stop delivered through the real writer → recorded done + interlude armed', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]), dist: 10 });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();   // A active + observed
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000);   // REAL completeTask(A_d)
  assert.equal(r.read('orders/A').status, ORDER_STATUS.DELIVERED, 'A really went delivered through the writer');
  r.render();
  assert.ok(r.api.getDoneRun().some((x) => x.orderId === 'A'), 'A recorded done on the affirmative delivered status');
  assert.ok(r.api.getInterlude() && r.api.getInterlude().orderId === 'A', 'the interlude is armed for the delivered active stop');
});

// P2-6 nav-pref hydration (kills the Waze stub / an un-hydrated read): driverState.nav_app = 'maps' → the lone
// stop's nav button reads «Navegar con Maps», not the Waze default.
t('P2-6 nav hydration: driverState.nav_app = "maps" surfaces «Navegar con Maps» (server truth, not a Waze stub)', () => {
  const r = runReal({ seed: seed([{ id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 }]),
    driverState: { lat: 15.47, lng: -88.015, active: true, last_location_ts: Date.now(), nav_app: 'maps', current_task_id: 'A_d' } });
  assert.ok(r.active().includes('Navegar con Google Maps'), 'the nav button hydrated to Maps from the server leaf');
  assert.ok(!r.active().includes('Navegar con Waze'), 'not the Waze default');
});

// P2-6 nav-pref WRITE — the real drv2WriteNavPref/drv2ReadNavPref lifted into a focused closure: server-truth
// hydration, per-UID isolation, ack→mirror, rejection→no mirror, session-switch→no mirror, no-auth→throw.
function buildNav({ uid = 'drv', nav_app = null, setNavPref = async () => {} } = {}) {
  const lsStore = {};
  const localStorage = { getItem: (k) => (k in lsStore ? lsStore[k] : null), setItem: (k, v) => { lsStore[k] = String(v); }, removeItem: (k) => { delete lsStore[k]; } };
  const s = { driverState: nav_app ? { nav_app } : {}, currentUser: uid ? { uid } : null, setNavPref };
  const body = 'let driverState=_s.driverState; let currentUser=_s.currentUser; let authGen=0;\n'
    + 'const XPD={ setNavPref:(u,p)=>_s.setNavPref(u,p) };\n'
    + NAV_BLOCK + '\n'
    + 'return { read:()=>drv2ReadNavPref(), write:(p)=>drv2WriteNavPref(p), setAuth:(n)=>{authGen=n;}, setUser:(u)=>{currentUser=u;}, setDriver:(d)=>{driverState=d;} };';
  const api = new Function('_s', 'localStorage', body)(s, localStorage);
  return { api, lsStore };
}
t('P2-6 nav write: hydration + per-UID isolation + ack-mirror + rejection/session/no-auth guards', async () => {
  // hydration: server leaf wins
  assert.equal(buildNav({ nav_app: 'maps' }).api.read(), 'Maps', 'driverState.nav_app=maps → Maps');
  assert.equal(buildNav({ nav_app: 'waze' }).api.read(), 'Waze', 'driverState.nav_app=waze → Waze');
  // per-UID cache isolation: uid A's mirror never leaks to uid B
  const n = buildNav({ uid: 'A' });
  await n.api.write('maps');
  assert.equal(n.lsStore['sherpa_nav_app:A'], 'maps', 'ack → per-uid mirror written for A');
  n.api.setUser({ uid: 'B' });
  assert.equal(n.api.read(), 'Waze', 'uid B does NOT inherit A’s cached Maps (per-uid key)');
  // write rejection → no mirror + throws
  const rej = buildNav({ uid: 'A', setNavPref: async () => { throw new Error('denied'); } });
  await assert.rejects(rej.api.write('maps'), /denied/, 'a rejected server write propagates');
  assert.equal(rej.lsStore['sherpa_nav_app:A'], undefined, 'a rejected write mirrors NOTHING');
  // session switch mid-write → no mirror (the ack belongs to the OLD session)
  let ref; const sw = buildNav({ uid: 'A', setNavPref: async () => { ref.setAuth(99); } }); ref = sw.api;
  await sw.api.write('maps');
  assert.equal(sw.lsStore['sherpa_nav_app:A'], undefined, 'session changed during the await → no local success banked');
  // no auth → throws, writes nothing
  const noauth = buildNav({ uid: null });
  await assert.rejects(noauth.api.write('maps'), /sesión/, 'no signed-in session → the write throws');
  assert.equal(Object.keys(noauth.lsStore).length, 0, 'no auth → nothing mirrored');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Codex r2 — the new mutation tripwires. Each kills a specific r2 regression.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// P1-1 STARTUP ORDER (kills reintroducing `let drv2RunAuthGen = authGen;` before `let authGen`): reproduce the two
// declarations in SOURCE order in a bare Function — a TDZ read throws, which is the real boot crash.
t('P1-1 startup order: drv2RunAuthGen + authGen in source order do NOT TDZ-crash at module load', () => {
  const raM = MY_SCRIPT.match(/let\s+drv2RunAuthGen\s*=\s*[^;]*;/);
  assert.ok(raM, 'drv2RunAuthGen declaration found');
  assert.doesNotThrow(() => { (new Function(raM[0] + '\nlet authGen = 0;\nreturn drv2RunAuthGen;'))(); },
    'drv2RunAuthGen read authGen before `let authGen` → TDZ crash at boot (Codex r2 P1-1)');
});

// P1-3 cross-hub (kills failing closed on a NULL pointer): after a cross-hub delivery current_task_id is cleared
// while the next order is still at PICKUP — that pickup must stay ARMED (baseline), never gated.
t('P1-3 cross-hub: a NULL pointer behaves as baseline — the next pickup is ARMED, not gated', () => {
  const r = runReal({ seed: seed([{ id: 'B', pickup: TASK_STATUS.ACCEPTED, delivery: TASK_STATUS.ACCEPTED, hub: HUBM, created: 2, name: 'Beto' }]) });
  r.read('drivers/drv').current_task_id = null; r.render();
  assert.ok(r.active().includes('class="active-card"'), 'B renders the stop card');
  const slide = r.activeEl().querySelector('#btn-pickup');
  assert.ok(slide && !slide.classList.contains('is-gated'), 'the Recogí slide is ARMED (null pointer = baseline, not fail-closed)');
});

// P1-2 swipe-END revalidation (kills removing the onConfirm pointer check): the pointer disagrees at the instant
// of completion → the delivery is NOT banked, no server write.
t('P1-2 swipe-END: a pointer that disagrees at completion time aborts — A is never delivered', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]), dist: 10 });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();   // A active + armed
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000);
  r.api.setDriver({ ...r.read('drivers/drv'), current_task_id: 'B_d' });   // pointer goes stale mid-swipe (no re-render)
  await r.up(1000);   // swipe completes → onConfirm revalidates → aborts
  assert.notEqual(r.read('orders/A').status, ORDER_STATUS.DELIVERED, 'A was NOT delivered — completeTask aborted at swipe-end (Codex r2 P1-2)');
});

// P2-7 ACTION GUARD (kills disabling drv2ActionGuard): a nav tap is blocked when the pointer went stale AFTER the
// render (the render gate did NOT fire — the href is still present — so this isolates the capture-phase guard).
t('P2-7 action guard: a nav tap is blocked when the pointer goes stale after render (guard, not the render gate)', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1 },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2 },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();   // armed → the render gate is OFF (nav keeps its href)
  const nav = r.activeEl().querySelector('.nav-btn, .sv-nav-primary');
  assert.ok(nav && nav.getAttribute('href'), 'nav armed with an href at render time (gate off)');
  r.api.setDriver({ ...r.read('drivers/drv'), current_task_id: 'ZZZ_nope' });   // pointer disagrees now, NO re-render
  const ev = new r.window.MouseEvent('click', { bubbles: true, cancelable: true });
  nav.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, 'the capture-phase action guard blocked the stale-pointer nav tap');
});

// P2-7 INTERLUDE FIXED EXPIRY (kills restoring the per-render timer reset): a re-render must NOT rebuild the
// interlude overlay — the button tagged after the first show survives the second render.
t('P2-7 interlude fixed expiry: a re-render does NOT rebuild the interlude overlay', async () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]), dist: 10 });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000);   // deliver A (B promotes)
  r.render();   // A delivered → interlude armed + shown
  const ov = r.document.getElementById('drv2-interlude');
  assert.ok(ov && ov.classList.contains('open'), 'the interlude overlay is shown');
  const go = ov.querySelector('#btn-interlude-go'); assert.ok(go, 'interlude button present'); go.dataset.probe = '1';
  r.render();   // a re-render must leave the overlay untouched (fixed expiry)
  const go2 = r.document.querySelector('#drv2-interlude #btn-interlude-go');
  assert.ok(go2 && go2.dataset.probe === '1', 'the overlay was NOT rebuilt/re-armed on re-render (Codex r2 P2-8)');
});

// P2-7 ACTIVE-CARD DETAIL (kills removing the active-card tap): tapping the active card opens the read-only sheet,
// as the ACTIVE stop (no «En cola» chip, no lock text — P3-9), still read-only.
t('P2-7 active-card detail: tapping the active card opens the read-only sheet (active variant, P3-9)', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana', items: 'pizza' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();
  const card = r.activeEl().querySelector('.active-card');
  assert.ok(card, 'active card present');
  card.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(r.sheetOpen(), 'the read-only detail sheet opened');
  const s = r.sheet();
  assert.ok(!s.includes('En cola') && !s.includes('Sin navegación'), 'active-stop sheet drops the queued-only chrome (P3-9)');
  assert.ok(!s.includes('nav-primary') && !s.includes('id="btn-delivered"'), 'still read-only — no nav, no Entregado');
});

// P2-4 ordering (kills resolving the «Después» tap against a non-pointer-ordered board): with pointer→B, A is the
// queued «Después» and opens AS a queued stop (lock text present), numbered consistently with the render.
t('P2-4 «Después» tap uses the pointer-ordered board: pointer→B makes A the queued stop', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'B_d'; r.render();   // B active, A is the «Después» preview
  const after = r.activeEl().querySelector('.after-card[data-order-id="A"]');
  assert.ok(after, 'A is the «Después» preview behind the pointer stop B');
  after.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok(r.sheetOpen() && r.sheet().includes('Ana'), 'A opens as the queued stop, resolved in pointer order');
  assert.ok(r.sheet().includes('Sin navegación'), 'A is a QUEUED stop (lock text present) — not the active one');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Codex r3 — nav-link task binding + stale-fix arrival.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// P1-1 (kills the resolve-ONLY action guard): a nav link RETAINED from before the pointer moved A→B must not
// open. At click, bound=A_d but the pointer is B_d (which DOES resolve to B) — the resolve-only check passed, the
// bound-task check must still block.
t('P1-1 nav-link task binding: a stale A nav link is blocked after the pointer moved A→B (bound ≠ pointer)', () => {
  const r = runReal({ seed: seed([
    { id: 'A', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 1, name: 'Ana' },
    { id: 'B', pickup: TASK_STATUS.COMPLETED, delivery: TASK_STATUS.ACCEPTED, hub: HUBX, created: 2, name: 'Beto' },
  ]) });
  r.read('drivers/drv').current_task_id = 'A_d'; r.render();   // A active, nav bound to A_d
  const nav = r.activeEl().querySelector('.nav-btn[data-nav-task], .sv-nav-primary[data-nav-task]');
  assert.ok(nav && nav.getAttribute('data-nav-task') === 'A_d', 'the rendered nav link is bound to A_d');
  r.api.setDriver({ ...r.read('drivers/drv'), current_task_id: 'B_d' });   // pointer moves A→B (B resolves!), NO re-render
  const ev = new r.window.MouseEvent('click', { bubbles: true, cancelable: true });
  nav.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, 'the stale A link is blocked (bound A_d ≠ pointer B_d) even though B resolves');
});

// P2-4 (kills dropping the freshness gate on arrival): inside the 50 m geofence with a STALE fix → keep
// navigation, no «Has llegado». A FRESH fix inside the geofence shows the arrived note.
t('P2-4 stale-fix arrival: inside 50 m but a STALE fix keeps navigation (no «Has llegado»); a FRESH fix arrives', () => {
  const fresh = run({ orders: [delivery('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: Date.now() }, dist: 10 });
  assert.ok(fresh.active().includes('Has llegado'), 'a FRESH fix inside 50 m → the arrived note');
  const stale = run({ orders: [delivery('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: Date.now() - 5 * 60 * 1000 }, dist: 10 });
  assert.ok(!stale.active().includes('Has llegado'), 'a STALE fix inside 50 m → NO arrived note');
  assert.ok(stale.active().includes('Navegar con'), 'a stale fix keeps navigation (as the old single card did)');
});

await Promise.all(_p);
console.log(`✓ slice2-branch: ${passed} cells passed (run() render/binding + runReal real-writer integration + mock boundaries + lifecycle)`);
