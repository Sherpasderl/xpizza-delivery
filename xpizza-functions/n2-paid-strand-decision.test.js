'use strict';
// N2 paid-strand sweep decision — pure. Run: node n2-paid-strand-decision.test.js
const assert = require('assert');
const { isPaidStranded, postRedrivePaidStrand } = require('./n2-paid-strand-decision');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const GRACE = 20 * 60 * 1000;

// ── isPaidStranded (pre-redrive) ─────────────────────────────────────────────
assert.equal(isPaidStranded({ payment_status: 'pending', status: 'pending_payment' }), true);
ok('paid attempt + pending order → STRANDED (re-drive)');
assert.equal(isPaidStranded({ payment_status: 'confirmed' }), false);
ok('paid + confirmed → done (not stranded)');
assert.equal(isPaidStranded({ payment_status: 'pending', materialized_at: 123 }), false);
ok('paid + materialized_at → done (not stranded)');
assert.equal(isPaidStranded(null), false);
ok('no order → not stranded');

// ── postRedrivePaidStrand (post-redrive) ─────────────────────────────────────
// recovered
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'confirmed', paid_strand_seen_at: 100 }, 1000, GRACE), { outcome: 'recovered' });
ok('re-drive recovered (confirmed) → recovered (clear stamp)');
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'pending', materialized_at: 500 }, 1000, GRACE), { outcome: 'recovered' });
ok('re-drive recovered (materialized) → recovered');
// first detection → stamp
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'pending' }, 1000, GRACE), { outcome: 'stamp' });
ok('still stranded, no seen-stamp → stamp (start the clock)');
// within grace → leave
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'pending', paid_strand_seen_at: 1000 }, 1000 + GRACE - 1, GRACE), { outcome: 'leave' });
ok('still stranded, within grace → leave (retry next sweep)');
// past grace → flag
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'pending', paid_strand_seen_at: 1000 }, 1000 + GRACE + 1, GRACE), { outcome: 'flag' });
ok('still stranded, past grace → flag (manual_reconciliation + alert)');
// exactly at grace boundary → leave (strictly greater triggers flag)
assert.deepEqual(postRedrivePaidStrand({ payment_status: 'pending', paid_strand_seen_at: 1000 }, 1000 + GRACE, GRACE), { outcome: 'leave' });
ok('at grace boundary → leave (strictly-greater flags)');
// null order → leave (fail-safe)
assert.deepEqual(postRedrivePaidStrand(null, 1000, GRACE), { outcome: 'leave' });
ok('null re-read → leave');

// ── Static wiring guard on sweepStalePending (index.js not require-safe — lock P1/P2/P3 in source) ──
{
  const fs = require('fs');
  const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const a = SRC.indexOf('exports.sweepStalePending'); assert.ok(a !== -1, 'sweepStalePending found');
  const b = SRC.indexOf('exports.', a + 20); const body = SRC.slice(a, b === -1 ? undefined : b);
  const inBody = (re, msg) => assert.ok(re.test(body), msg);

  // P1 — the split decides on the ORDER via isPaidStranded (not just attempt.hosted_state)
  inBody(/attempt\.hosted_state === 'paid'/, 'paid case present');
  inBody(/N2\.isPaidStranded\(order\)/, 'P1: split uses isPaidStranded(order) (order-state, not attempt)');
  inBody(/if \(!attempt\) \{ left\+\+; continue; \}/, '!attempt still left++ (unchanged)');
  // P2 — re-drive the REAL idempotent confirmAndMaterialize (no hand-rolled materialize)
  inBody(/confirmAndMaterialize\(confirmDeps\(db\), \{ orderId, attemptId: order\.active_attempt_id, now, trackingToken: generateTrackingToken\(\) \}\)/, 'P2: re-drives confirmAndMaterialize with confirmDeps + generateTrackingToken');
  inBody(/N2\.postRedrivePaidStrand\(after, now, PAID_STRAND_GRACE_MS\)/, 'post-redrive decision on the re-read order');
  // P3 — bounded: stamp → flag(manual_reconciliation + dispatcher alert) → clear on recovery
  inBody(/paid_strand_seen_at`\)\.set\(now\)/, 'P3: first-detection stamp');
  inBody(/payment_status: 'manual_reconciliation', blocked_reason: 'paid_strand_unrecovered'/, 'P3: flag → manual_reconciliation');
  inBody(/dispatcher_alerts\/paid_strand_\$\{orderId\}/, 'P3: dispatcher alert written');
  // REVISE parity: the flag branch secures the redemption hold (mirror the stale-hosted :1908 path).
  // Ordered between the manual_reconciliation update and the dispatcher alert, inside the fail-open try.
  inBody(/blocked_reason: 'paid_strand_unrecovered' \}\);\s*\n\s*await holdRedemptionForManual\(db, \{ orderId, order, now, alert: \(k, d\) => paymentAlert\(db, k, d\) \}\);/, 'REVISE: flag secures the reward via holdRedemptionForManual (parity with :1908)');
  inBody(/paid_strand_seen_at`\)\.remove\(\)/, 'clear stamp on recovery');
  // fail-open — the re-drive AND the post-handling are try/caught (never break the sweep)
  inBody(/paid-strand re-drive failed for/, 'fail-open: re-drive wrapped (catch → continue)');
  inBody(/paid-strand post-redrive handling failed for/, 'fail-open: post-redrive handling wrapped');
  ok('static guard: P1 (order-state split) + P2 (real confirmAndMaterialize re-drive) + P3 (stamp→flag→alert) + fail-open wired');
}

console.log(`\nn2-paid-strand-decision.test.js: ${pass} passed`);
