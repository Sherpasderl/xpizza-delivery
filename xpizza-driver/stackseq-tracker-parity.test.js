// JOINT ACCEPTANCE (BUILD-stacked-seq-driver plan §3 / PLAN-tracker-fixes §1) — the driver SDK ⊗ the tracker derivation,
// composed over ONE shared task-state, asserting the advisor's tie-rule SPLIT (Codex r1 #3) per the 5-case matrix.
//
// This is the SINGLE-FILE precursor to the emulator E2E (my heavy slot): real driver writers (recomputeOrderTracker,
// tracker_fixes ON). Here both halves are the REAL code, no stubbed decision:
//   • driver side  — the LIFTED getDriverOrders (sort) + the imported buildCompleteTaskUpdates (promotion pointer) +
//                    pickStackPointer (pickup pointer). pickupComplete's inHand gathering is mirrored (documented) and
//                    its pointer chosen by the REAL pickStackPointer; the emulator E2E drives the actual pickupComplete.
//   • tracker side — the REAL deriveOrderTracker (tracking/derive.js), which internally reads the byte-copy
//                    tracking/driver-orders.js and applies its tie check.
//
// RED-FIRST / COMPOSITION: until 5f's tracker half lands (re-copy getDriverOrders into driver-orders.js + make derive's
// tie check validPair-aware), the valid-pair cases FAIL here — the driver pointer names stop_seq 1 while the stale
// byte-copy's element 0 / the created_at tie disagree → neutral. That RED is the proof this harness REQUIRES both halves;
// it flips GREEN when the tracker half composes in. Case keys mirror stackseq-consume.test.js so 5f reuses them as labels.
//
// Run: node stackseq-tracker-parity.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildCompleteTaskUpdates, pickStackPointer, TASK_STATUS, TASK_TYPE } from './driver-complete.js';

const require = createRequire(import.meta.url);
const { deriveOrderTracker } = require('../xpizza-functions/tracking/derive.js');

// Lift getDriverOrders from the driver SDK (same mechanism as stackseq-consume.test.js).
function liftFn(src, name, scope) {
  const at = src.indexOf(`export function ${name}(`);
  const open = src.indexOf('{', src.indexOf('(', at));
  let depth = 0, end = -1;
  for (let k = open; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { end = k + 1; break; } } }
  const sig = src.slice(src.indexOf('(', at), open);
  const names = Object.keys(scope);
  return new Function(...names, `return (function ${name}${sig}${src.slice(open, end)});`)(...Object.values(scope));
}
const SDK = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
const { validPair } = await import('./stack-validity.js');
const getDriverOrders = liftFn(SDK, 'getDriverOrders', { TASK_TYPE, TASK_STATUS, validPair });

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}

const UID = 'drv';
const PTR = `drivers/${UID}/current_task_id`;
// a VALID stack-copy delivery (server provenance): stack_id 'S', stack_uid===driver, assigned_at(1) <= stack_at(2).
const vdel = (oid, o) => ({ id: `${oid}_delivery`, order_id: oid, type: TASK_TYPE.DELIVERY, assigned_driver_id: UID, linked_task_id: `${oid}_pickup`, stack_id: 'S', stack_uid: UID, assigned_at: 1, stack_at: 2, ...o });
const del  = (oid, o) => ({ id: `${oid}_delivery`, order_id: oid, type: TASK_TYPE.DELIVERY, assigned_driver_id: UID, linked_task_id: `${oid}_pickup`, ...o });
const pu   = (oid, o) => ({ id: `${oid}_pickup`, order_id: oid, type: TASK_TYPE.PICKUP, assigned_driver_id: UID, linked_task_id: `${oid}_delivery`, ...o });

// A two-order world with both pickups COMPLETED (out for delivery) and the driver pointer freshly set by pickup.
// `mk` = vdel (valid copy) or del (bare); `co` = per-order {created_at, stop_seq?, stack_id?, stack_uid?, assigned_at?}.
function world(coById, swipedOid) {
  const tasks = {};
  const orders = {};
  for (const [oid, co] of Object.entries(coById)) {
    const mk = co.mk || vdel;
    tasks[`${oid}_pickup`] = pu(oid, { status: TASK_STATUS.COMPLETED, created_at: co.created_at - 1 });
    tasks[`${oid}_delivery`] = mk(oid, { status: TASK_STATUS.ACCEPTED, ...co, mk: undefined });
    orders[oid] = { status: 'out_for_delivery' };
  }
  // pickup pointer: mirror pickupComplete — inHand = driver DELIVERY tasks accepted/in_progress — pick via the REAL pickStackPointer.
  const inHand = Object.values(tasks)
    .filter((x) => x.type === TASK_TYPE.DELIVERY && (x.status === TASK_STATUS.ACCEPTED || x.status === TASK_STATUS.IN_PROGRESS))
    .map((x) => ({ id: x.id, task: x }));
  const pointer = pickStackPointer(inHand, `${swipedOid}_delivery`);
  const driver = { uid: UID, active: true, current_shift_id: 'sh', current_task_id: pointer };
  return { tasks, orders, driver, pointer };
}
// The tracker mode for one order, fed the SAME world.
const mode = (w, oid) => deriveOrderTracker({ orderId: oid, order: w.orders[oid], pickup: w.tasks[`${oid}_pickup`], delivery: w.tasks[`${oid}_delivery`], owner: w.driver, ownerTasks: w.tasks }).mode;
const both = (w, a, b) => [mode(w, a), mode(w, b)];
// Deliver one order through the REAL buildCompleteTaskUpdates, then APPLY the writer's own returned paths to the world —
// the task-status + order-status + promotion-pointer writes all come from `u`, nothing hard-coded. So if the writer
// stops emitting any of those writes (e.g. a mutant drops the orders/{oid}/status = DELIVERED line), the world no longer
// transitions and the downstream mode assertion turns RED. Paths are RTDB-style `root/key/field…`.
function deliver(w, oid) {
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: `${oid}_delivery`, task: w.tasks[`${oid}_delivery`], allTasks: w.tasks, now: 1 });
  for (const [p, val] of Object.entries(u)) {
    const seg = p.split('/');
    const field = seg.slice(2).join('/');
    if (seg[0] === 'tasks' && w.tasks[seg[1]]) w.tasks[seg[1]][field] = val;
    else if (seg[0] === 'orders' && w.orders[seg[1]]) w.orders[seg[1]][field] = val;
    else if (seg[0] === 'drivers' && seg[1] === UID) w.driver[field] = val;
  }
}

// ───────── the 5-case matrix (keys mirror stackseq-consume.test.js) ─────────

t('(a) coherent valid stack, distinct created_at → pointer stop 1; tracker LIVE / WAITING', () => {
  const w = world({ i: { created_at: 100, stop_seq: 1 }, n: { created_at: 200, stop_seq: 2 } }, 'n');
  assert.equal(w.pointer, 'i_delivery', 'pickup pointer = stop 1 (ord i)');
  assert.deepEqual(both(w, 'i', 'n'), ['live', 'waiting'], 'stop 1 live, stop 2 waiting');
  deliver(w, 'i');
  assert.deepEqual(both(w, 'i', 'n'), ['terminal', 'live'], 'stop 1 delivered → stop 2 live');
});

t('(a) VALID stack, N-FIRST (stop 1 created LATER) → pointer stop 1; LIVE / WAITING (requires the byte-copy re-copy)', () => {
  // stop_seq 1 is the LATER order: the OLD byte-copy orders by created_at (stop 2 at element 0) and disagrees with the
  // pointer (stop 1) → neutral today. 5f's re-copy of getDriverOrders (seqMode) puts stop 1 at element 0 → live/waiting.
  const w = world({ i: { created_at: 200, stop_seq: 1 }, n: { created_at: 100, stop_seq: 2 } }, 'n');
  assert.equal(w.pointer, 'i_delivery', 'pickup pointer = stop 1 (ord i) by validPair, though ord i is the LATER order');
  assert.deepEqual(both(w, 'i', 'n'), ['live', 'waiting'], 'stop 1 (i) live, stop 2 (n) waiting — not neutral');
});

t('(a/advisor Codex r1 #3) VALID stack, EQUAL created_at → pointer stop 1; LIVE / WAITING, NOT neutral', () => {
  // the degenerate: equal created_at that WOULD be neutral for an invalid pair is authoritatively sequenced by stop_seq.
  const w = world({ i: { created_at: 150, stop_seq: 2 }, n: { created_at: 150, stop_seq: 1 } }, 'i');
  assert.equal(w.pointer, 'n_delivery', 'pickup pointer = stop 1 (ord n) even though ord i was swiped and created_at is equal');
  assert.deepEqual(both(w, 'n', 'i'), ['live', 'waiting'], 'stop 1 (n) live, stop 2 (i) waiting — NOT neutral/neutral');
});

t('(a) GOLDEN: mismatched stack_id + equal created_at → invalid pair → tracker NEUTRAL / NEUTRAL', () => {
  const w = world({ i: { created_at: 150, stop_seq: 2, stack_id: 'S1' }, n: { created_at: 150, stop_seq: 1, stack_id: 'S2' } }, 'i');
  assert.equal(w.pointer, 'i_delivery', 'invalid pair → legacy swiped-delivery pointer');
  assert.deepEqual(both(w, 'i', 'n'), ['neutral', 'neutral'], 'invalid pair + created_at tie → neutral for both');
});

t('(a/#4) STALE provenance (assigned_at > stack_at) + equal created_at → invalid → NEUTRAL / NEUTRAL', () => {
  const w = world({ i: { created_at: 150, stop_seq: 2, assigned_at: 9 }, n: { created_at: 150, stop_seq: 1, assigned_at: 9 } }, 'i');
  assert.equal(w.pointer, 'i_delivery', 'stale provenance → invalid → legacy swiped pointer');
  assert.deepEqual(both(w, 'i', 'n'), ['neutral', 'neutral'], 'stale provenance + tie → neutral for both');
});

t('(a/#2) 3 orders (valid pair + a 3rd) → NOT exactly one pair → legacy created_at, no stop_seq sequencing', () => {
  const w = world({ a: { created_at: 300, stop_seq: 2 }, b: { created_at: 100, stop_seq: 1 }, c: { created_at: 200, mk: del } }, 'a');
  // driver side: legacy created_at order b(100) < c(200) < a(300), NOT stop_seq
  assert.deepEqual(getDriverOrders(UID, w.tasks, {}).map((o) => o.orderId), ['b', 'c', 'a'], 'legacy created_at order across 3 orders');
  // tracker side (exact, from deriveOrderTracker): 3 delivery orders ⇒ NOT seqMode (D.length===2 is false); created_at
  // distinct ⇒ no tie; pointer = swiped a_delivery (no valid 2-pair for pickStackPointer) while element-0 = earliest-created
  // b ⇒ pointsAtFirst is FALSE ⇒ every order falls through to neutral. No order — least of all the 3rd, c — is forced live
  // or waiting. This is the "never wrong when uncertain" rule, and it kills a mutant that drops the pointsAtFirst guard
  // (which would otherwise promote b→live and a/c→waiting).
  assert.equal(w.pointer, 'a_delivery', 'no clean pair ⇒ pointer stays on the swiped delivery');
  assert.deepEqual([mode(w, 'a'), mode(w, 'b'), mode(w, 'c')], ['neutral', 'neutral', 'neutral'], 'pointer (swiped a) ≠ element-0 (created-first b) ⇒ neutral for all three');
});

console.log(`\nstackseq-tracker-parity: ${failed === 0 ? 'OK' : 'INCOMPLETE'} (${passed} passed, ${failed} failed)`);
