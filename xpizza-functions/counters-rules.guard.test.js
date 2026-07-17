'use strict';

/**
 * Offline structural guard for the /counters RTDB rule (admin-only) — order-display-number Core (R1-F7).
 *
 * /counters/order_display_seq/{restaurant}/{day} is the per-restaurant daily display_number counter, written
 * ONLY by the admin-SDK trigger (which bypasses rules). NO client — public, dispatcher, kitchen_staff, driver —
 * needs or may read/write it: surfaces read display_number off /orders (auth-readable) and order_tracking/{token}
 * (token-readable), never /counters. This guard asserts the node is a hard deny (.read:false + .write:false) with
 * NO truthy grant beneath and no cascading root grant, so a future accidental edit fails CI (wired into
 * `npm test` AND `npm run check:rules`).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const rules = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules;

const node = rules.counters;
assert(node, 'FAIL: top-level /counters rule missing');
assert.strictEqual(node['.read'], false, 'FAIL: /counters must have .read:false (admin-only)');
assert.strictEqual(node['.write'], false, 'FAIL: /counters must have .write:false (admin-only)');

// NO truthy .read/.write grant anywhere beneath (a nested grant would re-open it to clients).
(function walk(n, segs) {
  if (n === null || typeof n !== 'object') return;
  for (const [k, v] of Object.entries(n)) {
    if (k === '.read' || k === '.write') {
      assert.strictEqual(v, false, `FAIL: truthy ${k} grant under counters/${segs.join('/') || '(node)'} — must stay admin-only`);
    } else if (k !== '.validate') {
      walk(v, segs.concat(k));
    }
  }
})(node, []);

// No cascading grant at the rules ROOT (would override this deny for all clients).
assert(!rules['.read'], 'FAIL: rules root has a truthy .read grant — would cascade over /counters');
assert(!rules['.write'], 'FAIL: rules root has a truthy .write grant — would cascade over /counters');

// Sanity: an unrelated sibling keeps its access (proves this guard didn't over-restrict the tree).
assert.strictEqual(rules.order_timelines['.read'], 'auth != null', 'FAIL: sibling order_timelines .read changed — guard over-reached');

console.log('counters-rules.guard: OK (/counters is admin-only deny; no nested grant; no root cascade; sibling order_timelines unchanged)');
