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
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div>'
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
    + liftFn(MY_SCRIPT, 'renderActiveAndQueue') + '\n'
    + liftFn(MY_SCRIPT, 'attachActiveCardHandlers') + '\n'
    + liftFn(MY_SCRIPT, 'attachSlideConfirm') + '\n'
    + liftCall(MY_SCRIPT, "$('queue-slot').addEventListener") + '\n'
    + liftFn(MY_SCRIPT, 'attachIncomingBannerHandlers') + '\n'   // REAL banner handler (Codex r2 P2-3)
    + 'return { render: renderActiveAndQueue, setDriver:(d)=>{driverState=d;} };';
  const names = ['document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'incomingBannerHtml', 'activeCardHtml', 'queueHtml',
    'queueDetailHtml', 'phaseStripHtml', 'stopNavInfo', 'resolveVisibleLabels', 'overviewMapSvg', 'isStaleFix',
    'renderIdleState', 'toast', 'resolveCompleteErrorMessage', 'CSS', '_driverState', '_rec'];
  const CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  const api = (new Function(...names, body))(document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS,
    computeVuelto, scheduledBadge, singleOrderCardHtml, incomingBannerHtml, activeCardHtml, queueHtml,
    queueDetailHtml, phaseStripHtml, stopNavInfo, resolveVisibleLabels, overviewMapSvg, isStaleFix,
    renderIdleState, toast, resolveCompleteErrorMessage, CSS, driverState, rec);
  const slot = (id) => document.getElementById(id);
  const ret = {
    document, window: dom.window, rec, data, read, fb, queueConflict, sdk, XPD, api,
    render: () => api.render(),
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
  api.render();
  return ret;
}

function run({ orders, driverState = null, dist = 999, latchInit = null, authGen = 0 }) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div>'
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
    + liftFn(MY_SCRIPT, 'renderActiveAndQueue') + '\n'
    + liftFn(MY_SCRIPT, 'attachActiveCardHandlers') + '\n'
    + liftFn(MY_SCRIPT, 'attachSlideConfirm') + '\n'
    + liftCall(MY_SCRIPT, "$('queue-slot').addEventListener") + '\n'
    + 'return { render: renderActiveAndQueue, setDriver:(d)=>{driverState=d;}, getQueued:()=>queuedOrders,'
    + ' getLatch:()=>slice1ReviewLatchKey, getSliding:()=>slidingEl, getRenderPending:()=>renderPending, bumpAuth:()=>{ authGen+=1; } };';
  const params = ['document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'incomingBannerHtml', 'activeCardHtml', 'queueHtml',
    'queueDetailHtml', 'phaseStripHtml', 'stopNavInfo', 'resolveVisibleLabels', 'overviewMapSvg', 'isStaleFix',
    'attachIncomingBannerHandlers', 'renderIdleState', 'toast', 'resolveCompleteErrorMessage', '_driverState', '_rec',
    '_latchInit', '_authGen'];
  const fn = new Function(...params, body);
  const api = fn(document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS,
    computeVuelto, scheduledBadge, singleOrderCardHtml, incomingBannerHtml, activeCardHtml, queueHtml,
    queueDetailHtml, phaseStripHtml, stopNavInfo, resolveVisibleLabels, overviewMapSvg, isStaleFix,
    attachIncomingBannerHandlers, renderIdleState, toast, resolveCompleteErrorMessage, driverState, rec,
    latchInit, authGen);

  const slot = (id) => document.getElementById(id);
  const ret = {
    document, window: dom.window, rec, writes, api,
    render: () => api.render(),
    setOrders: (o) => { ctx.orders = o; },
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
  api.render();
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
t('stacked (2 orders): real builders render strip + overview map + active card + queue with identity hooks', () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  const a = r.active();
  assert.ok(a.includes('class="strip"'), 'phase strip rendered');
  assert.ok(a.includes('class="map"'), 'overview map mounted');
  assert.ok(a.includes('id="btn-delivered"') && a.includes('class="slide-thumb"'), 'active card slide hook');
  assert.ok(a.includes('<span class="bagtag a">1</span>'), 'active bag tag 1');
  assert.ok(a.includes('class="pactual">Parada actual'), 'parada-actual pill');
  assert.ok(a.includes('Navegar con Waze') && a.includes('→ '), 'navBtn: «Navegar con {app}» + «→ {destino}»');
  const q = r.queue();
  assert.ok(q.includes('data-order-id="B"') && q.includes('data-q="0"'), 'queue row carries both identity hooks');
  assert.ok(q.includes('<span class="bagtag b">2</span>'), 'queued bag tag 2');
  assert.equal(r.rec.mapTimerEnsured >= 1, true, 'map-age lifecycle timer armed on mount');
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
  assert.ok(r.queue().includes('data-order-id="B"'), 'B starts queued');
  r.setOrders([delivery('B')]); r.render();                         // A completed/gone → lone B
  assert.ok(r.activeEl().classList.contains('solo'), 'lone B → solo single-order layout');
  assert.ok(r.active().includes('class="map"'), 'promoted lone B gets the overview map (SINGLE-ORDER-MOUNT)');
  assert.ok(r.active().includes('sv-card'), 'the slice-1 single-order card renders');
  assert.ok(!r.active().includes('>A<') && !r.active().includes('data-order-id="A"'), 'completed A is off the board');
  assert.equal(r.banner(), '', 'no banner'); assert.equal(r.queue(), '', 'no queue');
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
t('queue identity: tapping B opens the read-only sheet for B (NO nav — owner ruling); a stale/gone card is a no-op', () => {
  const r = run({ orders: [delivery('A'), delivery('B', { dn: 'B', name: 'Carlos' })], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  r.clickCard('.qcard[data-order-id="B"]');
  assert.ok(r.sheetOpen(), 'sheet opened for the resolved order');
  const s = r.sheet();
  assert.ok(s.includes('Carlos'), 'sheet shows B’s customer');
  assert.ok(!s.includes('waze-btn') && !s.includes('maps-btn') && !s.includes('nav-row'), 'read-only sheet has NO nav (owner ruling 2026-10-23 supersedes Codex P1-1)');
  assert.ok(s.includes('Orden de entrega asignada por despacho.'), 'completion-lock copy present');
  assert.ok(s.includes('id="queue-sheet-close"'), 'close hook present');
  // Fail-closed: inject a stale card for an order no longer in the queue and tap it → no sheet change.
  r.document.getElementById('queue-sheet').classList.remove('open');
  const stale = r.document.createElement('div');
  stale.className = 'qcard'; stale.setAttribute('data-order-id', 'GONE'); stale.setAttribute('data-q', '0');
  r.document.getElementById('queue-slot').appendChild(stale);
  stale.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(r.sheetOpen(), false, 'a card whose orderId is gone from the queue fails CLOSED (no index fallback)');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// MIGRATED from single-order-branch.test.js (slice-1 P2-6 harness, RETIRED — advisor ruling 2026-10-21).
// Every cell here drives the REAL single-order path (singleOrderCardHtml + the real attachSlideConfirm drag
// + the real XPD writers), replacing the slice-1 harness that stubbed renderActiveCard/renderQueue and
// asserted the 2-order stacked render was byte-identical to baseline — an invariant slice 2 intentionally
// overturns (it reroutes the stacked path through the builders; renderActiveCard is now dead code, see the
// census unreachableOnSurface entries). The retired file's mapping table is in the hand-back evidence.

// M1 ← slice-1 "1 order → single-order card, .solo, cleared". The gate: exactly one order renders the
// single-order view (NOT the stacked activeCardHtml/queueHtml builders), with the SINGLE-ORDER-MOUNT map.
t('M1 gate: 1 order → single-order card in #active-order-slot (.solo) + overview map; banner & queue cleared', () => {
  const r = run({ orders: [delivery('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH } });
  assert.ok(r.activeEl().classList.contains('solo'), 'active slot gets .solo');
  assert.ok(r.active().includes('sv-card'), 'the slice-1 single-order card rendered');
  assert.ok(r.active().includes('class="map"'), 'the single-order overview map mounted (SINGLE-ORDER-MOUNT)');
  assert.ok(!r.active().includes('class="pactual"') && !r.active().includes('class="bagtag'), 'NOT the stacked builder (no Parada-actual pill / bag tag for 1 order)');
  assert.equal(r.banner(), '', 'banner cleared'); assert.equal(r.queue(), '', 'queue cleared');
});

// M2 ← slice-1 "0 orders → idle".
t('M2 gate: 0 orders → idle path (renderIdleState), no .solo, slots cleared', () => {
  const r = run({ orders: [] });
  assert.equal(r.rec.idle, true, 'renderIdleState ran');
  assert.equal(r.activeEl().classList.contains('solo'), false, 'no solo on idle');
  assert.equal(r.active(), ''); assert.equal(r.banner(), ''); assert.equal(r.queue(), '');
});

// M3/M4 ← slice-1 "pickup @49 m → review (#btn-pickup)" / "@51 m → to-restaurant (#btn-at-restaurant)".
t('M3 arrived: pickup @ 49 m → ARRIVED → review card (#btn-pickup)', () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 49 });
  assert.ok(r.active().includes('id="btn-pickup"'), 'review card renders the pickup slide');
  assert.ok(!r.active().includes('id="btn-at-restaurant"'), 'not the to-restaurant card');
});
t('M4 threshold: pickup @ 51 m → NOT arrived → to-restaurant card (#btn-at-restaurant)', () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 51 });
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'to-restaurant card renders the client toggle');
  assert.ok(!r.active().includes('id="btn-pickup"'), 'not yet the review card');
});

// M5 ← slice-1 "tap btn-at-restaurant latches review CLIENT-ONLY (no writer)".
t('M5 latch: drag btn-at-restaurant → latches review client-side (0:A), re-renders #btn-pickup, NO writer', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'starts on the to-restaurant card');
  const d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A', 'latch set to `${authGen}:${orderId}` (client-only)');
  assert.ok(r.document.getElementById('btn-pickup'), 're-rendered into the review card');
  assert.deepEqual(Object.keys(r.writes), [], 'NO XPD server write was called (client-only latch)');
});

// M6 ← slice-1 "latch A → idle → delivery → pickup A far ⇒ NOT review" (phase-change clear).
t('M6 latch reset: A → idle → delivery (phase change) → pickup A @999 m ⇒ NOT review', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  const d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A', 'latched');
  r.setOrders([]); r.render();
  r.setOrders([delivery('A')]); r.render();                 // A returns as delivery → phase change clears
  assert.equal(r.api.getLatch(), null, 'latch cleared on the delivery render (phase !== pickup)');
  r.setOrders([pickup('A')]); r.render();
  assert.ok(r.active().includes('id="btn-at-restaurant"') && !r.active().includes('id="btn-pickup"'), 'to-restaurant, NOT a stale review');
});

// M7 ← slice-1 "latch reset: idle (0 orders)".
t('M7 latch reset: A → idle (0 orders) → pickup A @999 m ⇒ NOT review', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  const d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A', 'latched');
  r.setOrders([]); r.render();
  r.setOrders([pickup('A')]); r.render();
  assert.equal(r.api.getLatch(), null, 'the idle gap cleared the latch');
  assert.ok(r.active().includes('id="btn-at-restaurant"') && !r.active().includes('id="btn-pickup"'), 'to-restaurant, NOT review');
});

// M8 ← slice-1 "latch reset: stacked (2 orders)".
t('M8 latch reset: A → stacked (2 orders) → pickup A @999 m ⇒ NOT review', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  const d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A', 'latched');
  r.setOrders([delivery('A'), delivery('B')]); r.render();  // stacked → the branch clears the latch
  assert.equal(r.api.getLatch(), null, 'the stacked board cleared the latch');
  r.setOrders([pickup('A')]); r.render();
  assert.ok(r.active().includes('id="btn-at-restaurant"') && !r.active().includes('id="btn-pickup"'), 'to-restaurant, NOT review');
});

// M9 ← slice-1 "latch clears on a DIFFERENT order and on an auth/session change".
t('M9 latch reset: a DIFFERENT order clears it; an auth/session bump clears it', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  let d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  r.setOrders([pickup('B')]); r.render();
  assert.equal(r.api.getLatch(), null, 'latch cleared for a different order');
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'B shows to-restaurant, not a stale review');
  r.setOrders([pickup('A')]); r.render();
  d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A', 're-latched A');
  r.api.bumpAuth(); r.render();
  assert.equal(r.api.getLatch(), null, 'latch cleared after an auth/session change (authGen bump)');
});

// M10 ← slice-1 "(a) 1→2 while a drag is in progress → deferred, replayed on drag-end".
t('M10 defer: 1→2 while a slide drag is in progress → render DEFERS (renderPending), replays to stacked on drag-end', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  const d = r.prep('btn-at-restaurant');
  r.down(d);
  assert.ok(r.api.getSliding(), 'slidingEl set during the drag');
  r.setOrders([delivery('A'), delivery('B')]); r.render();  // 2 orders arrive mid-drag
  assert.equal(r.api.getRenderPending(), true, 'render DEFERRED (not applied mid-drag)');
  assert.ok(r.active().includes('sv-card'), 'DOM still shows the single card during the drag');
  r.move(20); await r.up(20);                               // release below threshold → reset + replay
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared on drag-end');
  assert.ok(r.active().includes('class="bagtag'), 'the deferred render replayed into the stacked builder');
  assert.ok(!r.active().includes('sv-card'), 'single card replaced by the stacked render');
});

// M11 ← slice-1 "(b) 2→1 while an action write is pending → deferred, replayed when the write settles".
t('M11 defer: 2→1 while a delivery write is PENDING → deferred during the await, single view on settle', async () => {
  const r = run({ orders: [delivery('A'), delivery('B')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 999 });
  assert.ok(r.active().includes('class="bagtag'), 'starts stacked (2 orders)');
  const d = r.prep('btn-delivered'); r.down(d); r.move(1000); await r.up(1000);  // completeTask PENDING
  assert.ok(r.writes.complete, 'the delivery write is in flight');
  assert.ok(r.api.getSliding(), 'slidingEl held while the write is pending');
  r.setOrders([delivery('A')]); r.render();                 // feed drops to 1 while pending
  assert.equal(r.api.getRenderPending(), true, 'render deferred while the write is pending');
  r.writes.complete.resolve(); await tick();
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared after the write settled');
  assert.ok(r.active().includes('sv-card'), 'replayed into the single-order view (1 order)');
});

// M12 ← slice-1 "(c) rejected write recovers (slider reset, toast, slidingEl cleared)".
t('M12 recover: a rejected pickup write → slider RESETS (no .completed), error toast, slidingEl cleared', async () => {
  const r = run({ orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03, last_location_ts: FRESH }, dist: 49 });  // arrived → btn-pickup
  assert.ok(r.active().includes('id="btn-pickup"'), 'review card with the server pickup slide');
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
  assert.ok(r.activeEl().classList.contains('solo') && r.active().includes('sv-card'), 'lone B → single-order view');
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
  assert.ok(r.queue().includes('data-order-id="B"'), 'B (still pickup phase) is queued');
  r.clickCard('.qcard[data-order-id="B"]');
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
  const spies = { render: 0, statusBar: 0, gps: 0, wakeLockCalls: 0 };
  const renderActiveAndQueue = () => { spies.render += 1; };
  const renderStatusBar = () => { spies.statusBar += 1; };
  const startGpsStream = () => { spies.gps += 1; };
  const acquireWakeLock = () => { spies.wakeLockCalls += 1; return new Promise(() => {}); };   // NEVER resolves
  const driverState = { active: true };
  const navigator = { geolocation: { clearWatch() {} } };
  const body = 'let slice2MapAgeTimer=null; const SLICE2_MAP_AGE_MS=30000;\n'
    + 'let wakeLock=null, watchId=null, lastUpdateAt=0;\n'
    + liftFn(MY_SCRIPT, 'ensureSlice2MapAgeTimer') + '\n'
    + liftFn(MY_SCRIPT, 'stopSlice2MapAgeTimer') + '\n'
    + liftFn(MY_SCRIPT, 'cleanupShift') + '\n'
    + liftVisibilityHandler(MY_SCRIPT) + '\n'
    + 'return { ensure: ensureSlice2MapAgeTimer, stop: stopSlice2MapAgeTimer, cleanup: cleanupShift, timerSet: () => slice2MapAgeTimer != null };';
  const names = ['document', 'setInterval', 'clearInterval', 'renderActiveAndQueue', 'renderStatusBar', 'startGpsStream', 'acquireWakeLock', 'driverState', 'navigator', 'isNative', 'pingNativeLocation'];
  const api = (new Function(...names, body))(document, setInterval, clearInterval, renderActiveAndQueue, renderStatusBar, startGpsStream, acquireWakeLock, driverState, navigator, () => false, () => {});
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
  assert.ok(r.queue().includes('data-order-id="B"'), 'B starts accepted + queued');
  const d = r.prep('btn-delivered'); r.down(d);   // begin A's completion drag → slidingEl set
  // B goes back to awaiting_acceptance in the feed; the render DEFERS (drag in progress) so B's card is RETAINED/stale.
  r.read('tasks/B_p').status = TASK_STATUS.ASSIGNED; r.read('tasks/B_d').status = TASK_STATUS.ASSIGNED;
  r.render();   // deferred under the drag — the stale B card stays in the DOM
  r.clickCard('.qcard[data-order-id="B"]');
  assert.ok(!r.sheetOpen(), 'the sheet does NOT open for an order now awaiting (QUEUE-IDENTITY awaiting gate)');
  assert.ok(!r.sheet().includes('Beto Secreto') && !r.sheet().includes('99998888') && !r.sheet().includes('waze-btn'), 'no awaiting-order name/phone/nav leaked into the sheet body');
  r.move(20); await r.up(20);   // finish the drag (below threshold)
});

await Promise.all(_p);
console.log(`✓ slice2-branch: ${passed} cells passed (run() render/binding + runReal real-writer integration + mock boundaries + lifecycle)`);
