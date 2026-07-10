'use strict';

/**
 * Offline structural guard for the KDS-2c pickup_ready_notifications RTDB rule (admin-only).
 *
 * /pickup_ready_notifications/{orderId} is the at-most-once send-state ledger for notifyPickupReady, written
 * ONLY by the trusted admin-SDK trigger (which bypasses rules). No client — public, kitchen_staff, dispatcher,
 * OR driver — may read or write it: it carries no customer data a client needs, and the recovery view is
 * Admin-SDK / Cloud Logging (KDS_2C_PLAN.md §5/§7). Dispatchers otherwise hold broad grants, so this must be
 * an explicit top-level hard deny that no ancestor grant can override.
 *
 * This guard asserts the node is .read:false + .write:false with NO truthy grant beneath, and that the rules
 * ROOT carries no cascading .read/.write grant — so a future edit that accidentally opens it fails CI
 * (wired into `npm test` AND `npm run check:rules`).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const rules = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules;

const node = rules.pickup_ready_notifications;
assert(node, 'FAIL: top-level /pickup_ready_notifications rule missing');

// Hard deny at the node — client read AND write DENIED (admin SDK bypasses rules).
assert.strictEqual(node['.read'], false, 'FAIL: pickup_ready_notifications must have .read:false (admin-only)');
assert.strictEqual(node['.write'], false, 'FAIL: pickup_ready_notifications must have .write:false (admin-only)');

// NO truthy .read/.write grant anywhere beneath (a nested grant would re-open it to clients).
(function walk(n, segs) {
  if (n === null || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    if (k === '.read' || k === '.write') {
      assert.strictEqual(v, false, `FAIL: truthy ${k} grant under pickup_ready_notifications/${segs.join('/') || '(node)'} — must stay admin-only`);
    } else if (k !== '.validate') {
      walk(v, segs.concat(k));
    }
  }
})(node, []);

// No cascading grant at the rules ROOT — a top-level .read/.write:true there would override this deny for
// ALL clients (RTDB grants cascade down and cannot be revoked deeper). It must be absent/falsy.
assert(!rules['.read'], 'FAIL: rules root has a truthy .read grant — would cascade over pickup_ready_notifications');
assert(!rules['.write'], 'FAIL: rules root has a truthy .write grant — would cascade over pickup_ready_notifications');

// Sanity: an unrelated sibling keeps its access (proves this guard didn't over-restrict the tree).
assert.strictEqual(rules.menus['.read'], true, 'FAIL: sibling menus .read changed (expected true) — guard over-reached');

console.log('pickup-ready-rules.guard: OK (pickup_ready_notifications is admin-only deny; no nested grant; no root cascade; sibling menus read unchanged)');
