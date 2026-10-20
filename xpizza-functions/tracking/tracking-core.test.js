'use strict';
// TRACKER FIXES T1 — the pure core (PLAN-tracker-fixes r2.5 §1–§4): derive (Step 3 table), legacy encoding (§3), the tracker-node
// updater (Step 4: seq guard, terminal guard, epoch, smp, public-location clear), the claims seq rule, the ingest updater (§2).
// Synthetic third brand tb_brand (tb_centro). Run: node tracking/tracking-core.test.js
const assert = require('assert');
const { deriveOrderTracker } = require('./derive');
const { legacyFields } = require('./legacy-encode');
const { makeNodeUpdater } = require('./mx-txn');
const { grantUpdater, tombstoneUpdater, ownerHintUpdater } = require('./claims-txn');
const { makeIngestUpdater, sampleInWindow } = require('./ingest-txn');
const { tagOf } = require('./tag');

let n = 0; const ok = (l) => { n += 1; console.log(`  ✓ ${n} ${l}`); };
const O = 'u_owner', P2 = 'u_other';
const tk = (oid, type, status, owner, created_at = 1) => ({ order_id: oid, type, status, assigned_driver_id: owner, created_at });
// owner holds A (picked up, created 1) and B (picked up, created 2) unless overridden
function world({ status = 'out_for_delivery', pointer = 'A_delivery', active = true, legs = {}, ownerTasks = null } = {}) {
  const base = {
    A_pickup: tk('A', 'pickup', 'completed', O, 1), A_delivery: tk('A', 'delivery', 'in_progress', O, 1),
    B_pickup: tk('B', 'pickup', 'completed', O, 2), B_delivery: tk('B', 'delivery', 'accepted', O, 2),
  };
  const tasks = ownerTasks || base;
  return (oid) => ({
    order: { status },
    pickup: legs.pickup !== undefined ? legs.pickup : tasks[`${oid}_pickup`] || null,
    delivery: legs.delivery !== undefined ? legs.delivery : tasks[`${oid}_delivery`] || null,
    owner: { uid: O, active, current_shift_id: 'sh1', current_task_id: pointer },
    ownerTasks: tasks,
    orderId: oid,
  });
}

// ── derive: the P§1 Step 3 table ──
{
  const w = world();
  assert.strictEqual(deriveOrderTracker(w('A')).mode, 'live', 'A = pointer = app-first → live');
  assert.strictEqual(deriveOrderTracker(w('B')).mode, 'waiting', 'B is another delivery-phase order while the pointer = app-first');
  assert.strictEqual(deriveOrderTracker(w('A')).owner, O);
  assert.strictEqual(deriveOrderTracker(w('A')).shift_id, 'sh1');
  ok('derive: pointer === app-first (earliest created) → that order live, the other waiting');

  const sw = world({ pointer: 'B_delivery' });   // the pickupComplete swipe pointed at the NEWER order
  assert.strictEqual(deriveOrderTracker(sw('A')).mode, 'neutral', 'pointer ≠ app-first → neutral (the app shows A, the pointer says B)');
  assert.strictEqual(deriveOrderTracker(sw('B')).mode, 'neutral');
  ok('derive: pointer ≠ app-first (out-of-sort swipe) → BOTH neutral (codex r1 P1-5: disagreement ends neutral)');

  for (const s of ['delivered', 'completed', 'cancelled']) assert.strictEqual(deriveOrderTracker(world({ status: s })('A')).mode, 'terminal');
  for (const s of ['new', 'preparing', 'ready', 'pending_payment']) assert.strictEqual(deriveOrderTracker(world({ status: s })('A')).mode, 'pre');
  ok('derive: terminal statuses → terminal; pre-pickup statuses → pre');

  assert.strictEqual(deriveOrderTracker(world({ active: false })('A')).mode, 'neutral', 'owner off shift → neutral');
  assert.strictEqual(deriveOrderTracker(world({ pointer: null })('A')).mode, 'neutral', 'pointer null → neutral');
  ok('derive: owner off shift or pointer null → neutral');

  const split = world({ legs: { delivery: tk('A', 'delivery', 'assigned', P2, 1) } });   // mid-reassign: delivery moved first
  assert.strictEqual(deriveOrderTracker(split('A')).mode, 'neutral', 'split legs → neutral');
  assert.strictEqual(deriveOrderTracker(split('A')).owner, null);
  assert.strictEqual(deriveOrderTracker(world({ legs: { delivery: null } })('A')).mode, 'neutral', 'a missing leg → neutral');
  assert.strictEqual(deriveOrderTracker(world({ legs: { delivery: tk('A', 'delivery', 'pending', null, 1), pickup: tk('A', 'pickup', 'completed', null, 1) } })('A')).mode, 'neutral', 'unowned → neutral');
  ok('derive: split legs (the two-step dispatch reassign), a missing leg, or unowned → neutral, owner null');

  const tie = world({ ownerTasks: {
    A_pickup: tk('A', 'pickup', 'completed', O, 5), A_delivery: tk('A', 'delivery', 'in_progress', O, 5),
    B_pickup: tk('B', 'pickup', 'completed', O, 5), B_delivery: tk('B', 'delivery', 'accepted', O, 5),
  } });
  assert.strictEqual(deriveOrderTracker(tie('A')).mode, 'neutral', 'a created_at tie with another delivery-phase order → neutral');
  ok('derive: a created_at tie in the delivery phase → neutral (the app\'s order would be insertion-dependent)');

  const awaiting = world({ ownerTasks: {
    A_pickup: tk('A', 'pickup', 'assigned', O, 1), A_delivery: tk('A', 'delivery', 'assigned', O, 1),
  }, pointer: null });
  assert.strictEqual(deriveOrderTracker(awaiting('A')).mode, 'neutral', 'out_for_delivery but the new owner has it awaiting acceptance → neutral');
  ok('derive: OFD but awaiting_acceptance for the owner (after a reassign) → neutral');
}

// ── legacy encoding (P§3) ──
assert.deepStrictEqual(legacyFields({ mode: 'live', hasLocation: true, name: 'Uno' }), { is_active_drop: true, driver_name: 'Uno' });
assert.deepStrictEqual(legacyFields({ mode: 'live', hasLocation: false, name: 'Uno' }), { is_active_drop: null, driver_name: null });
assert.deepStrictEqual(legacyFields({ mode: 'waiting', hasLocation: false, name: 'Uno' }), { is_active_drop: false, driver_name: 'Uno' });
for (const m of ['neutral', 'pre', 'terminal']) assert.deepStrictEqual(legacyFields({ mode: m, hasLocation: false, name: 'Uno' }), { is_active_drop: null, driver_name: null });
ok('legacy encoding: only live+location → true+name; live without location / neutral / pre / terminal → null+null (gen-1 no-countdown branch); waiting → false+name');

// ── the node updater (P§1 Step 4) ──
const T = tagOf('k', O), T2 = tagOf('k', P2);
const derivedLive = { mode: 'live', owner_tag: T, shift_id: 'sh1' };
const smp = { owner_tag: T, shift_id: 'sh1' };
const order = { status: 'out_for_delivery', picked_up_at: 111 };
{
  const node0 = { order_id: 'A', status: 'ready' };
  const u = makeNodeUpdater({ s: 5, derived: derivedLive, smp, name: 'Uno', order });
  const n1 = u(node0);
  assert.strictEqual(n1.mx.seq, 5); assert.strictEqual(n1.mx.mode, 'live'); assert.strictEqual(n1.mx.epoch, 1);
  assert.deepStrictEqual(n1.mx.smp, { owner_tag: T, shift_id: 'sh1', sample_at: 0 });
  assert.strictEqual(n1.status, 'out_for_delivery'); assert.strictEqual(n1.picked_up_at, 111, 'step timestamps from the CURRENT order');
  assert.strictEqual(n1.is_active_drop, null, 'live without location → legacy null'); assert.strictEqual(n1.driver_name, null);
  assert.strictEqual(n1.mx.name, 'Uno');
  assert.strictEqual(u(null), null, 'a missing node → null (never created; lets the server re-run on a cold local cache)');
  ok('node updater: first live grant → mx {seq, mode, epoch 1, smp sample_at 0, name}; status from the current order; legacy null (no location yet); null node → abort');

  const withLoc = { ...n1, driver_location: { lat: 1, lng: 2, at: 900 }, dest_lat: 3, dest_lng: 4, mx: { ...n1.mx, smp: { ...n1.mx.smp, sample_at: 900 } } };
  const n2 = makeNodeUpdater({ s: 6, derived: derivedLive, smp, name: 'Uno', order })(withLoc);
  assert.strictEqual(n2.mx.epoch, 1, 'unchanged (mode, owner, shift) → same epoch');
  assert.deepStrictEqual(n2.driver_location, { lat: 1, lng: 2, at: 900 }, 'live, same owner/shift → location preserved');
  assert.strictEqual(n2.mx.smp.sample_at, 900, 'watermark preserved');
  assert.strictEqual(n2.is_active_drop, true, 'live WITH location → legacy true');
  assert.strictEqual(n2.driver_name, 'Uno');
  ok('node updater: unchanged live recompute keeps epoch, location and watermark; legacy becomes true+name once a location exists');

  const n3 = makeNodeUpdater({ s: 7, derived: { mode: 'neutral', owner_tag: 'none', shift_id: null }, smp, name: 'Uno', order })(withLoc);
  assert.strictEqual(n3.mx.epoch, 2, 'mode change → epoch bump');
  assert.strictEqual(n3.driver_location, null); assert.strictEqual(n3.dest_lat, null); assert.strictEqual(n3.dest_lng, null);
  assert.strictEqual(n3.mx.smp.sample_at, 900, 'NEUTRAL keeps the sampling identity + watermark (r2.1, codex r3 P1)');
  assert.strictEqual(n3.is_active_drop, null); assert.strictEqual(n3.driver_name, null);
  ok('node updater: live → neutral clears ONLY the public location; smp + watermark survive (same owner/shift)');

  const n4 = makeNodeUpdater({ s: 8, derived: { mode: 'live', owner_tag: T2, shift_id: 'shX' }, smp: { owner_tag: T2, shift_id: 'shX' }, name: 'Dos', order })(withLoc);
  assert.strictEqual(n4.driver_location, null, 'owner change → location cleared (never carried to another owner)');
  assert.deepStrictEqual(n4.mx.smp, { owner_tag: T2, shift_id: 'shX', sample_at: 0 }, 'owner change → watermark reset');
  assert.strictEqual(n4.mx.epoch, 2);
  assert.strictEqual(n4.mx.name, 'Dos');
  ok('node updater: owner/shift change → location cleared, watermark reset, epoch bump, new name');

  const sameOwnerNewShift = makeNodeUpdater({ s: 8, derived: { mode: 'live', owner_tag: T, shift_id: 'sh2' }, smp: { owner_tag: T, shift_id: 'sh2' }, name: 'Uno', order })(withLoc);
  assert.strictEqual(sameOwnerNewShift.mx.epoch, 2, 'same owner, NEW shift (clock-out/clock-in ABA) → epoch bump');
  assert.strictEqual(sameOwnerNewShift.driver_location, null, 'and the previous shift\'s location is cleared');
  assert.strictEqual(sameOwnerNewShift.mx.smp.sample_at, 0, 'and the watermark resets for the new shift');
  ok('node updater: same owner + new shift (off/on ABA) → epoch bump, location cleared, watermark reset');

  const n5 = makeNodeUpdater({ s: 4, derived: derivedLive, smp, name: 'Uno', order })(n1);
  assert.strictEqual(n5, undefined, 'a LOWER seq aborts');
  const term = makeNodeUpdater({ s: 9, derived: { mode: 'terminal', owner_tag: 'none', shift_id: null }, smp, name: 'Uno', order: { status: 'delivered', picked_up_at: 111, delivered_at: 222 } })(withLoc);
  assert.strictEqual(term.mx.mode, 'terminal'); assert.strictEqual(term.status, 'delivered'); assert.strictEqual(term.delivered_at, 222);
  assert.strictEqual(makeNodeUpdater({ s: 10, derived: derivedLive, smp, name: 'Uno', order })(term), undefined, 'terminal is never regressed');
  ok('node updater: lower seq → abort; terminal written; a later non-terminal derive never regresses terminal');
}

// ── E1 (PLAN §E1, additive): mx.pins = {hub, dest} while live, only with all four coordinates finite ──
{
  const ordP = { status: 'out_for_delivery', picked_up_at: 111, hub_lat: 15.5, hub_lng: -88.02, lat: 15.52, lng: -88.01 };
  const node0 = { order_id: 'A', status: 'ready' };
  const live = makeNodeUpdater({ s: 5, derived: derivedLive, smp, name: 'Uno', order: ordP })(node0);
  assert.deepStrictEqual(live.mx.pins, { hub: { lat: 15.5, lng: -88.02 }, dest: { lat: 15.52, lng: -88.01 } }, 'E1: live → pins from the order\'s hub snapshot + destination');
  assert.strictEqual(live.dest_lat ?? null, null, 'E1: the legacy dest_* fields are NOT written by the pins (still only with an ingest sample)');
  for (const k of ['hub_lat', 'hub_lng', 'lat', 'lng']) {
    for (const bad of [undefined, null, NaN, '15.5', Infinity]) {
      const o = { ...ordP, [k]: bad };
      assert.strictEqual(makeNodeUpdater({ s: 5, derived: derivedLive, smp, name: 'Uno', order: o })(node0).mx.pins, null, `E1: ${k}=${String(bad)} → pins null`);
    }
  }
  for (const m of ['pre', 'waiting', 'neutral', 'terminal']) {
    const n = makeNodeUpdater({ s: 6, derived: { mode: m, owner_tag: m === 'waiting' ? T : 'none', shift_id: null }, smp, name: 'Uno', order: m === 'terminal' ? { ...ordP, status: 'delivered' } : ordP })(live);
    assert.strictEqual(n.mx.pins, null, `E1: leaving live (${m}) clears the pins`);
  }
  const other = makeNodeUpdater({ s: 7, derived: { mode: 'live', owner_tag: T2, shift_id: 'shX' }, smp: { owner_tag: T2, shift_id: 'shX' }, name: 'Dos', order: ordP })(live);
  assert.deepStrictEqual(other.mx.pins, live.mx.pins, 'E1: a new live claim (owner change) gets the pins of THIS order (order-derived, no driver data)');
  assert.strictEqual(makeNodeUpdater({ s: 5, derived: derivedLive, smp, name: 'Uno', order: null })(node0).mx.pins, null, 'E1: no order → pins null');
  ok('E1: mx.pins {hub, dest} written while live with all four coordinates finite; null otherwise (any missing/non-finite coordinate, any non-live mode, no order); legacy dest_* untouched');
}

// ── claims (seq-valued, tombstoned) ──
assert.deepStrictEqual(grantUpdater(3, 100)(null), { seq: 3, gone: false, at: 100 });
assert.strictEqual(grantUpdater(1, 100)({ seq: 2, gone: true, at: 90 }), undefined, 'a delayed s=1 grant aborts against the s=2 tombstone (codex r4)');
assert.deepStrictEqual(tombstoneUpdater(2, 110)({ seq: 1, gone: false, at: 100 }), { seq: 2, gone: true, at: 110 });
assert.strictEqual(tombstoneUpdater(2, 110)({ seq: 2, gone: false, at: 100 }), undefined, 'equal seq → abort (s must be > stored)');
assert.deepStrictEqual(ownerHintUpdater(4, O, 120)(null), { seq: 4, uid: O, gone: false, at: 120 });
assert.deepStrictEqual(ownerHintUpdater(5, null, 130)({ seq: 4, uid: O, gone: false, at: 120 }), { seq: 5, uid: null, gone: true, at: 130 });
ok('claims: grant/tombstone/owner-hint apply only if s > stored.seq; a delayed older grant cannot resurrect a claim');

// ── ingest (P§2) ──
{
  const node = { status: 'out_for_delivery', mx: { mode: 'live', owner_tag: T, shift_id: 'sh1', epoch: 3, name: 'Uno', smp: { owner_tag: T, shift_id: 'sh1', sample_at: 500 } } };
  const mk = (o = {}) => makeIngestUpdater({ uidTag: T, shiftId: 'sh1', epoch: 3, sample: { lat: 1, lng: 2, measured_at: 600 }, dest: { lat: 3, lng: 4 }, ...o });
  const r = mk()(node);
  assert.deepStrictEqual(r.driver_location, { lat: 1, lng: 2, at: 600 });
  assert.strictEqual(r.mx.smp.sample_at, 600); assert.strictEqual(r.is_active_drop, true); assert.strictEqual(r.driver_name, 'Uno');
  assert.strictEqual(r.dest_lat, 3);
  for (const [why, o, nd] of [
    ['older sample', { sample: { lat: 1, lng: 2, measured_at: 500 } }, node],
    ['other owner', { uidTag: T2 }, node],
    ['other shift (paused before epoch capture)', { shiftId: 'sh0' }, node],
    ['other epoch (paused after capture)', { epoch: 2 }, node],
    ['not live', {}, { ...node, mx: { ...node.mx, mode: 'neutral' } }],
    ['terminal status', {}, { ...node, status: 'delivered' }],
    ['defensive: the public shift differs from the sampling shift', {}, { ...node, mx: { ...node.mx, shift_id: 'shOld' } }],
  ]) assert.strictEqual(mk(o)(nd), undefined, `ingest aborts: ${why}`);
  assert.strictEqual(mk()(null), null, 'ingest on a cold local cache → null (server re-runs with the real node)');
  assert.ok(sampleInWindow(1000, 1000 + 90000)); assert.ok(!sampleInWindow(1000, 1000 + 90001), '> 90 s old → out');
  assert.ok(sampleInWindow(3000, 1000)); assert.ok(!sampleInWindow(3001, 1000), '> 2 s in the future → out');
  ok('ingest: writes the location + watermark + legacy live shape; aborts on older sample / other owner / other shift / other epoch / not live / terminal / missing node; window ≤ 90 s old, ≤ 2 s future');
}

assert.notStrictEqual(tagOf('k', O), tagOf('k', P2)); assert.strictEqual(tagOf('k', O), tagOf('k', O)); assert.ok(!tagOf('k', O).includes(O), 'the tag never exposes the uid');
ok('tag: deterministic, distinct per uid, never contains the uid');
console.log(`tracking-core: OK (${n})`);
