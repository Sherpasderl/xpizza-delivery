'use strict';
/**
 * Source-placement guard for the Phase B1 redemption REVERSAL wiring (Task 8). Run: node rewards-reversal-placement.test.js
 * Locks that cancelOrderCore + resolve-manual reverse/settle the hold via the SINGLE helper at the right
 * branches — a future edit that drops a call (the exact "resolve-manual has no redemption release" gap) fails
 * the build. The behavior is proven in the emulator suites; this locks the structural precondition in source.
 */
const fs = require('fs');
const assert = require('assert');
const CO = fs.readFileSync(require.resolve('./cancel-order-core.js'), 'utf8');
const RM = fs.readFileSync(require.resolve('./resolve-manual.js'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const has = (h, re, m) => assert.ok(re.test(h), m);
const between = (h, a, b) => { const ia = h.indexOf(a), ib = b ? h.indexOf(b) : h.length; assert.ok(ia !== -1, `marker not found: ${a}`); return h.slice(ia, ib === -1 ? h.length : ib); };
const before = (h, a, b, m) => { const ia = h.indexOf(a), ib = h.indexOf(b); assert.ok(ia !== -1 && ib !== -1, `markers: ${a} / ${b}`); assert.ok(ia < ib, m); };

// ── cancelOrderCore: reverse the redemption (refund) AFTER a committed finalize (a real cancel) ──
has(CO, /reverseRedemptionForOrder\(db, \{ orderId, order, disposition: 'refund'/, 'cancelOrderCore must reverse the redemption (refund) via the single helper');
before(CO, 'const done = await finalize(', 'reverseRedemptionForOrder(', 'cancelOrderCore: reverse only AFTER finalize commits (a real cancel)');
ok('cancelOrderCore reverses the redemption hold (refund) after a committed cancel');

// ── resolve-manual: all THREE terminal branches settle the hold via a single helper ──
const abandon = between(RM, "if (action === 'abandon')", "if (action === 'materialize')");
has(abandon, /reverseRedemptionForOrder\(db, \{ orderId, order, disposition: 'refund'/, "abandon → reverse(refund) release");
const materialize = between(RM, "if (action === 'materialize')", "// ── action === 'refund'");
has(materialize, /disposition: 'sale'/, "materialize success → reverse(sale) consume");
has(materialize, /settleRedemptionAtConfirm\(db, \{ orderId, order, disposition: 'hold'/, "materialize held_closed → settle(hold)");
const refund = between(RM, "// ── action === 'refund'", null);
has(refund, /reverseRedemptionForOrder\(db, \{ orderId, order, disposition: 'refund'/, "refund → reverse(refund)");
ok('resolve-manual settles the hold in ALL 3 terminal branches (abandon→refund / materialize→sale|hold / refund→refund)');

// ── neither open-codes reservation balance math (the plan constraint: single helper only) ──
for (const [name, src] of [['cancel-order-core', CO], ['resolve-manual', RM]]) {
  assert.ok(!/user_rewards\/\$\{[^}]*\}\/[^`]*\/(balance|reserved)/.test(src), `${name} must NOT open-code user_rewards balance/reserved math (single helper only)`);
}
ok('neither cancelOrderCore nor resolve-manual open-codes user_rewards balance/reserved math');

console.log(`\nAll ${pass} redemption-reversal placement guards passed.`);
