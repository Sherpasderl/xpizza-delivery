'use strict';
// PLAN 4 §4 — offline structural guard: /form_rebake (the reconciler's own bookkeeping: {at, attempts, version, stuck,
// last_class, hook_alarm} per rid) is ADMIN-ONLY (.read:false + .write:false), with no truthy grant beneath and no cascading
// root grant. Only the functions (Admin SDK) read and write it; a client has no reason to see a rid's rebuild history.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const node = rules.form_rebake;
assert.ok(node, 'FAIL: top-level /form_rebake rule missing');
assert.strictEqual(node['.read'], false, 'FAIL: /form_rebake must have .read:false');
assert.strictEqual(node['.write'], false, 'FAIL: /form_rebake must have .write:false');
(function walk(nd, segs) {
  if (nd === null || typeof nd !== 'object') return;
  for (const [k, v] of Object.entries(nd)) {
    if (k === '.read' || k === '.write') assert.strictEqual(v, false, `FAIL: truthy ${k} under form_rebake/${segs.join('/')}`);
    else if (k !== '.validate' && k !== '.indexOn') walk(v, segs.concat(k));
  }
})(node, []);
assert.ok(!rules['.read'] && !rules['.write'], 'FAIL: a root grant would cascade over /form_rebake');
ok('/form_rebake: .read:false + .write:false, no truthy grant beneath, no root grant cascades');
console.log(`\nform-rebake-rules.guard: OK (${n})`);
