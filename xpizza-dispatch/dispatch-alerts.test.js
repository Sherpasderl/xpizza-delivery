// xpizza-dispatch/dispatch-alerts.test.js
import assert from 'node:assert';
import { classifyAlert, sortAlertEntries } from './dispatch-alerts.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ALL 7 known types keep today's category/severity/icon (Guardrail-6 parity vs
// index.html:2239–2321 — a silent reclassification here would bury a real alert).
{
  const KNOWN = [
    ['driver_freshness_stale',           'driver-dark', 'red',     'i-signaloff'],
    ['no_drivers_available',             'no-driver',   'red',     'i-userx'],
    ['no_response_takeover',             'takeover',    'amber',   'i-phoneoff'],
    ['assignment_strand',                'takeover',    'amber',   'i-phoneoff'],
    ['payment_hosted_stale_no_callback', 'payment',     'amber',   'i-card'],
    ['payment_reconcile_breaches',       'payment',     'neutral', 'i-card'],
    ['payment_aged_refund_pending',      'payment',     'neutral', 'i-card'],
  ];
  for (const [type, category, severity, iconId] of KNOWN) {
    const c = classifyAlert({ type });
    assert.strictEqual(c.category, category, `${type} category`);
    assert.strictEqual(c.severity, severity, `${type} severity`);
    assert.strictEqual(c.iconId, iconId, `${type} iconId`);
    assert.strictEqual(c.known, true, `${type} known`);
  }
  ok('all 7 known types → exact category/severity/icon parity');
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
// same-tier order is STABLE (preserves input/insertion order within a severity)
{
  const entries = sortAlertEntries({
    x1: { type: 'no_response_takeover' },   // amber
    x2: { type: 'assignment_strand' },      // amber
    x3: { type: 'payment_hosted_stale_no_callback' }, // amber
  });
  assert.deepStrictEqual(entries.map(e => e.id), ['x1', 'x2', 'x3'], 'stable within amber tier');
  ok('sortAlertEntries: same-tier stable order');
}

console.log(`\n${pass} passed`);
