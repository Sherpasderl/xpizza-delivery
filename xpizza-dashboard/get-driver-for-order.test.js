'use strict';
/**
 * Piece 2 — dashboard driver attribution READ. Run:  node get-driver-for-order.test.js
 *
 * Executes the REAL getDriverIdForOrder extracted verbatim from index.html (not a hand-copied version — the
 * function text is pulled from the shipped source and eval'd with a stub allTasks), so the prefer-durable +
 * live-fallback + null logic is runtime-verified, not just pattern-matched. Plus structural guards that the
 * two NAME display sites prefer the durable delivered_by_name snapshot.
 *
 * Contract (from functions/driver-attribution.js): orders/<id>/delivered_by_uid (durable, survives task
 * pruning) + delivered_by_name (display snapshot). A completed order's _delivery task is DELETED, so reading
 * the task attributes "unknown" — the durable field fixes both the leaderboard and the order-detail line.
 */
const fs = require('fs');
const assert = require('assert');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ── Extract + execute the REAL getDriverIdForOrder (with an injected allTasks) ──
const m = html.match(/function getDriverIdForOrder\(o\) \{[\s\S]*?\n\}/);
assert.ok(m, 'getDriverIdForOrder found in index.html');
const makeFn = (allTasks) => new Function('allTasks', `${m[0]}\nreturn getDriverIdForOrder;`)(allTasks);

// A live/in-flight order's delivery task is still present; a completed order's is gone.
const allTasks = { O_live_delivery: { assigned_driver_id: 'driver_live' }, O_nodriver_delivery: {} };
const f = makeFn(allTasks);

// 1. Durable field wins — even when a (stale) task with a DIFFERENT driver still exists (sensitivity: prefer-durable).
assert.strictEqual(f({ delivered_by_uid: 'driver_durable', delivery_task_id: 'O_live_delivery' }), 'driver_durable', 'delivered_by_uid is preferred over the task (durable wins)');
// 2. No durable field, task present with a driver → live/in-flight fallback.
assert.strictEqual(f({ delivery_task_id: 'O_live_delivery' }), 'driver_live', 'no delivered_by_uid → falls back to the live task assigned_driver_id');
// 3. No durable field, task present without a driver → null.
assert.strictEqual(f({ delivery_task_id: 'O_nodriver_delivery' }), null, 'task without assigned_driver_id → null');
// 4. No durable field, task missing (deleted/completed with no durable stamp — legacy pre-capture order) → null.
assert.strictEqual(f({ delivery_task_id: 'O_gone_delivery' }), null, 'missing task + no durable field → null (legacy)');
// 5. No durable field, no delivery_task_id → null.
assert.strictEqual(f({ order_id: 'x' }), null, 'no delivered_by_uid and no delivery_task_id → null');
// 6. Null/absent order → null (no throw).
assert.strictEqual(f(null), null, 'null order → null');
// 7. A completed order (task pruned) but WITH the durable stamp → attributed (the bug this fixes).
assert.strictEqual(f({ delivered_by_uid: 'driver_durable', delivery_task_id: 'O_gone_delivery' }), 'driver_durable', 'completed order (task gone) still attributes via the durable field');
ok('getDriverIdForOrder: prefers delivered_by_uid, falls back to the live task, else null (executed from real source)');

// ── Structural guards: both NAME display sites prefer the durable delivered_by_name snapshot ──
// Order-detail line: uid via the SHARED getDriverIdForOrder (durable → live task, same as leaderboard — #6 align),
// name prefers the delivered_by_name snapshot, then /drivers, then a SHORT uid (consistent with the leaderboard row).
assert.match(html, /const driverUid = getDriverIdForOrder\(o\);/, 'order-detail resolves the uid via the shared getDriverIdForOrder (aligned on delivery_task_id, not a bespoke ${order_id}_delivery lookup)');
assert.match(html, /const driverName = o\.delivered_by_name \|\| \(driverUid \? \(allDrivers\[driverUid\]\?\.name \|\| driverUid\.slice\(0, 8\)\) : null\);/, 'order-detail name prefers delivered_by_name, then /drivers, then a short uid (slice consistent with the leaderboard)');
ok('order-detail driver line: shared getDriverIdForOrder for the uid + delivered_by_name snapshot + consistent short-uid fallback (#6)');

// Leaderboard: a per-driver name snapshot is captured from delivered_by_name and preferred on the row.
assert.match(html, /if \(!byDriver\[driverId\]\.snapshotName && o\.delivered_by_name\) byDriver\[driverId\]\.snapshotName = o\.delivered_by_name;/, 'leaderboard captures a delivered_by_name snapshot per driver');
assert.match(html, /name: d\.snapshotName \|\| allDrivers\[d\.driverId\]\?\.name \|\|/, 'leaderboard row name prefers the snapshot, then /drivers, then a uid slice');
ok('leaderboard prefers the delivered_by_name snapshot (attribution survives driver rename/delete)');

console.log(`\nAll ${pass} dashboard driver-attribution read checks passed.`);
