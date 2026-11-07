'use strict';
// PLAN 3 — offline structural guard: /form_signals and /form_signal_limits are ADMIN-ONLY (.read:false + .write:false), with
// no truthy grant beneath and no cascading root grant. Reads are admin-only by the advisor's ruling (2026-10-26): the
// counters are read via the CLI; owner-facing reads would be a later slice. The behavioral twin is
// test/form-signal-rules.emulator.test.js (client read AND write denied on both paths).
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
for (const key of ['form_signals', 'form_signal_limits']) {
  const node = rules[key];
  assert.ok(node, `FAIL: top-level /${key} rule missing`);
  assert.strictEqual(node['.read'], false, `FAIL: /${key} must have .read:false`);
  assert.strictEqual(node['.write'], false, `FAIL: /${key} must have .write:false`);
  (function walk(nd, segs) {
    if (nd === null || typeof nd !== 'object') return;
    for (const [k, v] of Object.entries(nd)) {
      if (k === '.read' || k === '.write') assert.strictEqual(v, false, `FAIL: truthy ${k} under ${key}/${segs.join('/')}`);
      else if (k !== '.validate' && k !== '.indexOn') walk(v, segs.concat(k));
    }
  })(node, []);
  ok(`/${key}: .read:false + .write:false, no truthy grant beneath`);
}
assert.deepStrictEqual(rules.form_signal_limits['.indexOn'], ['window_start'], 'the limiter sweep queries window_start');
assert.ok(!rules['.read'] && !rules['.write'], 'FAIL: a root grant would cascade over both paths');
ok('form_signal_limits indexes window_start (the sweep); no root grant cascades');
console.log(`\nform-signal-rules.guard: OK (${n})`);
