'use strict';
// PLAN-manual-factura r3 §6/§13 + Codex #252-1 — the `manual_` key space belongs to manual facturas (facturas/{rid}/manual_{opId}); an
// app order must never take such an id, or the factura trigger would adopt the manual copy as its own (and an app cancel would void it).
//   MFN-ADMIT   createOrder / chargeOnlineOrder admission (validateOrderPayload) refuses a manual_ order_id, on the same line as the
//               charset rule (index.js is not importable without Firebase init: a source pin, like fail-closed-reject.test.js)
//   MFN-RULES   the canonical rules' orders/$order_id VALIDATION refuses a manual_ id first (a parent validation also covers child-only
//               writes incl. /status); the derived f2-narrow files carry it. Behaviourally: npm run test:manual-factura-rules
// Run: node factura/manual-namespace.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const fn = SRC.slice(SRC.indexOf('function validateOrderPayload('), SRC.indexOf('\n}\n', SRC.indexOf('function validateOrderPayload(')));
const line = fn.split('\n').find((l) => l.includes("body.order_id != null"));
assert.ok(line && /\|\| String\(body\.order_id\)\.startsWith\('manual_'\)\)\) \{/.test(line.split('//')[0]), `🔴 MFN-ADMIT: validateOrderPayload refuses a manual_ order_id in CODE, not a comment (${line})`);
assert.ok(/errors\.push\('order_id has invalid format'\)/.test(fn.slice(fn.indexOf(line))), '🔴 MFN-ADMIT: …and the refusal is the order_id error');
ok('MFN-ADMIT: order admission refuses a manual_ order_id');
for (const f of ['database.rules.json', 'f2-narrow/N-human.rules.json', 'f2-narrow/N-full.rules.json']) {
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', f), 'utf8')).rules;
  const v = R.orders.$order_id['.validate'];
  assert.ok(typeof v === 'string' && v.split(") && !$order_id.beginsWith('manual_') && (").length === 2, `🔴 MFN-RULES: ${f} orders/$order_id .validate ANDs the manual_ refusal at the top level (before the no-reversal clause, which must stay last)`);
}
ok('MFN-RULES: orders/$order_id validation refuses a manual_ id (canonical + both f2-narrow derivations)');
console.log(`manual-namespace.guard: OK (${n})`);
