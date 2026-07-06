'use strict';

/**
 * Golden test for the cash-intake builder, driven by the shared, hash-guarded anchored expected
 * (deploy/combo-validation.js — the SAME COMBOS the emulator e2e validates against, so what the
 * emulator proves is byte-for-byte what the goldens prove). Asserts each cash combo's output is
 * byte-identical on existing fields + additive-snapshot-only + tasks/tracking exact + no metadata
 * leak, against the audited pre-Phase-0 truth.
 */
const assert = require('assert');
const { buildCreateOrderUpdates, buildScheduledOrderRecord } = require('./create-order-build');
const { COMBOS, assertComboOutput } = require('./deploy/combo-validation');

let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);

for (const [key, combo] of Object.entries(COMBOS)) {
  const updates = buildCreateOrderUpdates({ ...combo.input, hubSnap: combo.snapshot });
  assertComboOutput(updates, combo);
  ok(`${key}: order+tasks+tracking byte-identical (existing) + additive-snapshot-only + no leak`);
}

// ── buildScheduledOrderRecord — HELD, zero live side-effects (Scheduled Orders §B) ──
for (const [key, combo] of Object.entries(COMBOS)) {
  const held = buildScheduledOrderRecord({ ...combo.input, hubSnap: combo.snapshot, scheduledFor: 1800000000000, releaseAt: 1799998200000 });
  const paths = Object.keys(held);
  assert.deepStrictEqual(paths, [`orders/${combo.input.orderId}`], `${key}: ONLY the order record — no tasks/ or order_tracking/`);
  const rec = held[`orders/${combo.input.orderId}`];
  assert.strictEqual(rec.status, 'scheduled');
  assert.strictEqual(rec.scheduled_for, 1800000000000);
  assert.strictEqual(rec.release_at, 1799998200000);
  assert.ok(!('tracking_token' in rec) && !('pickup_task_id' in rec) && !('delivery_task_id' in rec), `${key}: no live token/task pointers`);
  assert.ok(rec.customer_name != null && rec.total_cents != null && rec.factura_status === 'not_due', `${key}: record fields + factura not_due present`);
  ok(`${key}: held record = scheduled + slot, NO tasks/tracking/token/task-pointers (single order path)`);
}

console.log(`create-order-build: OK (${n} cases)`);
