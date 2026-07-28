// xpizza-dispatch/dispatch-alerts.test.js
import assert from 'node:assert';
import { classifyAlert, sortAlertEntries } from './dispatch-alerts.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// known types keep today's category/severity
{
  const c = classifyAlert({ type: 'driver_freshness_stale', driver_id: 'u1' });
  assert.strictEqual(c.category, 'driver-dark');
  assert.strictEqual(c.severity, 'red');
  assert.strictEqual(c.iconId, 'i-signaloff');
  assert.strictEqual(c.known, true);
  ok('driver_freshness_stale → driver-dark/red');
}
{
  const c = classifyAlert({ type: 'no_drivers_available' });
  assert.strictEqual(c.category, 'no-driver'); assert.strictEqual(c.severity, 'red');
  ok('no_drivers_available → no-driver/red');
}
{
  const c = classifyAlert({ type: 'payment_aged_refund_pending' });
  assert.strictEqual(c.category, 'payment'); assert.strictEqual(c.severity, 'neutral');
  ok('payment_aged_refund_pending → payment/neutral');
}
// unknown / no-type / factura → fallback bucket, NEVER dropped
{
  const u = classifyAlert({ type: 'some_new_kind' });
  assert.strictEqual(u.category, 'otros'); assert.strictEqual(u.known, false);
  const noType = classifyAlert({ message: 'x' });         // no `type` at all
  assert.strictEqual(noType.category, 'otros'); assert.strictEqual(noType.known, false);
  const fac = classifyAlert({ type: 'factura_cai_low' });
  assert.strictEqual(fac.category, 'fiscal'); assert.strictEqual(fac.known, false);
  ok('unknown / no-type / factura_* → surfaced in fallback bucket');
}
// keyed RTDB object → sorted entries, id preserved, most-severe-first
{
  const entries = sortAlertEntries({
    a1: { type: 'payment_reconcile_breaches' },  // neutral
    a2: { type: 'no_drivers_available' },         // red
    a3: { type: 'assignment_strand' },            // amber
  });
  assert.deepStrictEqual(entries.map(e => e.id), ['a2', 'a3', 'a1']);
  assert.strictEqual(entries[0].alert.type, 'no_drivers_available');
  assert.strictEqual(entries[0].category, 'no-driver');
  ok('sortAlertEntries: keyed obj → severity-sorted, id preserved');
}

console.log(`\n${pass} passed`);
