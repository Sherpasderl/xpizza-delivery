// xpizza-dispatch/dispatch-aging.test.js
import assert from 'node:assert';
import { agingBaselineMs, agingSeconds, agingBand, formatAging } from './dispatch-aging.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  assert.strictEqual(agingBaselineMs({ created_at: 1000 }), 1000);
  assert.strictEqual(agingBaselineMs({}), null);
  ok('baseline = created_at (null when absent)');
}
{
  assert.strictEqual(agingSeconds(1000, 1000 + 65 * 1000), 65);
  assert.strictEqual(agingSeconds(null, 5000), 0);
  ok('agingSeconds = (now - baseline)/1000, 0 when no baseline');
}
{
  assert.strictEqual(agingBand(120), 'green');
  assert.strictEqual(agingBand(400), 'amber');
  assert.strictEqual(agingBand(700), 'red');
  ok('band thresholds green/amber/red');
}
{
  assert.strictEqual(formatAging(65), '1:05');
  assert.strictEqual(formatAging(600), '10:00');
  ok('formatAging m:ss');
}

console.log(`\n${pass} passed`);
