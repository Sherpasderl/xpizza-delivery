'use strict';
// F2 Q0 (PLAN-F2-query-rules §0): every non-public grant carries the device exclusion `auth.token.handheld !== true`;
// the pinned sibling/owner expressions below include it.

/**
 * Offline structural guard for the /catalog_integrity RTDB rule (server-only) — 1D D4-c2b (PLAN-D4c2b rev 14 §4).
 *
 * catalog_integrity/{rid} is the identity integrity monitor's state (findings, coverage, timers), written ONLY by the
 * scheduled monitor and the owner-run acknowledgement tool through the Admin SDK (which bypasses rules). NO client —
 * public, merchant, dispatcher, kitchen_staff, driver — may read or write it. This guard asserts the node is an explicit
 * hard deny with NO truthy grant beneath and no cascading root grant (wired into `npm test` AND `npm run check:rules`).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const rules = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules;

const node = rules.catalog_integrity;
assert(node, 'FAIL: top-level /catalog_integrity rule missing (the deny must be EXPLICIT, not left to the default)');
assert.strictEqual(node['.read'], false, 'FAIL: /catalog_integrity must have .read:false (server-only)');
assert.strictEqual(node['.write'], false, 'FAIL: /catalog_integrity must have .write:false (server-only)');

(function walk(n, segs) {
  if (n === null || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    if (k === '.read' || k === '.write') {
      assert.strictEqual(v, false, `FAIL: truthy ${k} grant under catalog_integrity/${segs.join('/') || '(node)'} — must stay server-only`);
    } else if (k !== '.validate') {
      walk(v, segs.concat(k));
    }
  }
})(node, []);

assert(!rules['.read'], 'FAIL: rules root has a truthy .read grant — would cascade over /catalog_integrity');
assert(!rules['.write'], 'FAIL: rules root has a truthy .write grant — would cascade over /catalog_integrity');

// Sanity: an unrelated sibling keeps its access (proves this guard didn't over-restrict the tree).
assert.strictEqual(rules.order_control['.read'], "auth != null && auth.token.handheld !== true && root.child('dispatchers').child(auth.uid).exists()", 'FAIL: sibling order_control .read changed — guard over-reached');

console.log('catalog-integrity-rules.guard: OK (/catalog_integrity is an explicit server-only deny; no nested grant; no root cascade; sibling order_control unchanged)');
