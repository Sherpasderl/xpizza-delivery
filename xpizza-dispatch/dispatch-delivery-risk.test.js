// xpizza-dispatch/dispatch-delivery-risk.test.js
import assert from 'node:assert';
import { deliveryRisk } from './dispatch-delivery-risk.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// no baseline + red band → aging only, never "slipping"
{
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: null, currentArrivalMs: 999999 });
  assert.strictEqual(r.band, 'red');
  assert.strictEqual(r.level, 'aging');   // red-aging, but NOT slipping
  assert.strictEqual(r.slipMs, null);
  ok('no baseline + red band → aging, slip suppressed');
}
// amber band alone → visual heads-up but does NOT count (level ok)
{
  const r = deliveryRisk({ agingSeconds: 400, baselineArrivalMs: null, currentArrivalMs: null });
  assert.strictEqual(r.band, 'amber');
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.slipMs, null);
  ok('amber band alone → level ok (row shows amber, header does not count)');
}
// baseline present, slipped past threshold → slipping (band still reflects aging)
{
  const base = 1_000_000, cur = base + 5 * 60 * 1000;   // slipped 5 min
  const r = deliveryRisk({ agingSeconds: 60, baselineArrivalMs: base, currentArrivalMs: cur });
  assert.strictEqual(r.band, 'green');
  assert.strictEqual(r.level, 'slipping');
  assert.strictEqual(r.slipMs, 5 * 60 * 1000);
  ok('baseline + 5min slip → slipping (band=green, level=slipping)');
}
// baseline present, within tolerance + old → aging rule
{
  const base = 1_000_000, cur = base + 60 * 1000;       // only 1 min
  const r = deliveryRisk({ agingSeconds: 700, baselineArrivalMs: base, currentArrivalMs: cur });
  assert.strictEqual(r.band, 'red');
  assert.strictEqual(r.level, 'aging');
  ok('baseline + small slip + old → aging');
}

console.log(`\n${pass} passed`);
