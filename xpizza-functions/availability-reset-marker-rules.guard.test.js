'use strict';

/**
 * Offline structural guard for the KDS-2b availability_reset_marker RTDB rule (admin-only).
 *
 * The marker is the reset job's per-day lease + "last reset date" record, written ONLY by the trusted
 * admin-SDK scheduled function (which bypasses rules). No client — public OR kitchen_staff — may read or
 * write it. This guard asserts the node is a hard deny (.read:false + .write:false) with NO truthy grant
 * anywhere beneath it, so a future edit that accidentally opens it fails CI (wired into `npm test`).
 *
 * (The sibling item_availability stays client-readable/staff-writable — the marker must NOT inherit that.)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CANON = path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json');
const r = JSON.parse(fs.readFileSync(CANON, 'utf8')).rules.restaurants['$restaurant_id'];

const marker = r && r.availability_reset_marker;
assert(marker, 'FAIL: /restaurants/$restaurant_id/availability_reset_marker rule missing');

// Hard deny at the node — client read AND write DENIED (admin SDK bypasses rules).
assert.strictEqual(marker['.read'], false, 'FAIL: availability_reset_marker must have .read:false (admin-only)');
assert.strictEqual(marker['.write'], false, 'FAIL: availability_reset_marker must have .write:false (admin-only)');

// NO truthy .read/.write grant anywhere beneath the marker (a nested grant would re-open it to clients).
(function walk(node, segs) {
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === '.read' || k === '.write') {
      assert.strictEqual(v, false, `FAIL: truthy ${k} grant under availability_reset_marker/${segs.join('/') || '(node)'} — must stay admin-only`);
    } else if (k !== '.validate') {
      walk(v, segs.concat(k));
    }
  }
})(marker, []);

// Sanity: the sibling item_availability keeps its client read (proves this guard didn't over-restrict).
assert.strictEqual(r.item_availability['.read'], true, 'FAIL: sibling item_availability .read changed (expected true)');

console.log('availability-reset-marker-rules.guard: OK (marker is admin-only deny; no nested grant; sibling item_availability unchanged)');
