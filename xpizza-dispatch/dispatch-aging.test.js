// xpizza-dispatch/dispatch-aging.test.js
import assert from 'node:assert';
import { agingBaselineMs, agingSeconds, agingBand, formatAging } from './dispatch-aging.js';

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

{
  assert.strictEqual(agingBaselineMs({ created_at: 1000 }), 1000);
  assert.strictEqual(agingBaselineMs({}), null);
  assert.strictEqual(agingBaselineMs({ created_at: NaN }), null);   // non-finite created_at → null
  assert.strictEqual(agingBaselineMs(null), null);
  ok('baseline = created_at (null when absent / non-finite)');
}
{
  assert.strictEqual(agingSeconds(1000, 1000 + 65 * 1000), 65);
  assert.strictEqual(agingSeconds(null, 5000), 0);
  ok('agingSeconds = (now - baseline)/1000, 0 when no baseline');
}
// contract: non-finite / negative never leak NaN or a negative
{
  assert.strictEqual(agingSeconds(NaN, 1000), 0, 'non-finite baseline → 0, not NaN');
  assert.strictEqual(agingSeconds(1000, NaN), 0, 'non-finite now → 0, not NaN');
  assert.strictEqual(agingSeconds(5000, 1000), 0, 'now < baseline clamps to 0, not negative');
  assert.strictEqual(agingSeconds(agingBaselineMs({ created_at: NaN }), 9000), 0, 'non-finite created_at path → 0');
  ok('agingSeconds guards: non-finite/negative → 0');
}
{
  assert.strictEqual(agingBand(120), 'green');
  assert.strictEqual(agingBand(400), 'amber');
  assert.strictEqual(agingBand(700), 'red');
  // exact >= boundaries (300 amber, 600 red)
  assert.strictEqual(agingBand(299), 'green');
  assert.strictEqual(agingBand(300), 'amber');
  assert.strictEqual(agingBand(599), 'amber');
  assert.strictEqual(agingBand(600), 'red');
  ok('band thresholds green/amber/red + exact >= boundaries');
}
{
  assert.strictEqual(formatAging(65), '1:05');
  assert.strictEqual(formatAging(600), '10:00');
  ok('formatAging m:ss');
}

console.log(`\n${pass} passed`);
