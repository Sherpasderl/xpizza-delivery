'use strict';
// TRACKER FIXES T2 (PLAN-tracker-fixes r2.5 §1 Step 1/4): the three server-only tracker nodes — /tracker_seq (per-order fence
// counter), /tracker_claims and /tracker_claims_owner (the seq-valued hint index) — are written ONLY by the Admin SDK (rules
// bypassed). No client identity may read or write them. Asserts a hard deny with no truthy grant beneath and no root grant.
// Wired into npm test AND npm run check:rules. The emulator matrix is test:tracker-rules.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
assert.ok(rules['.read'] !== true && rules['.write'] !== true, 'no root grant may cascade into the tracker nodes');
for (const k of ['tracker_seq', 'tracker_claims', 'tracker_claims_owner']) {
  const node = rules[k];
  assert.ok(node, `FAIL: top-level /${k} rule missing`);
  assert.strictEqual(node['.read'], false, `FAIL: /${k} must be .read:false`);
  assert.strictEqual(node['.write'], false, `FAIL: /${k} must be .write:false`);
  (function walk(n, segs) {
    for (const [kk, v] of Object.entries(n)) {
      if ((kk === '.read' || kk === '.write') && segs.length) assert.ok(v === false, `FAIL: /${segs.join('/')}/${kk} re-opens the node`);
      if (v && typeof v === 'object') walk(v, segs.concat(kk));
    }
  })(node, [k]);
}
console.log('tracker-rules.guard: OK (tracker_seq, tracker_claims, tracker_claims_owner are hard-deny, nothing beneath, no root grant)');
