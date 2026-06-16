/**
 * Unit tests for the hosted-payment helpers (Stage H1).
 * Run: `node pixelpay-hosted.test.js`.
 */
const assert = require('assert');
const { toCents } = require('./pixelpay-hosted');
const { clientSignature } = require('./pixelpay');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// ---- toCents: centavo-safe amount parsing (I2) ----
{
  assert.strictEqual(toCents('299'), 29900);
  assert.strictEqual(toCents('299.00'), 29900);
  assert.strictEqual(toCents('299.5'), 29950);
  assert.strictEqual(toCents('299.50'), 29950);
  assert.strictEqual(toCents('299.99'), 29999);
  assert.strictEqual(toCents(299), 29900);
  assert.strictEqual(toCents(299.9), 29990);
  assert.strictEqual(toCents('0'), 0);
  ok('toCents: valid amounts → integer centavos');

  for (const bad of ['', '  ', 'abc', '29a', '299.999', '1.2.3', '-5', null, undefined, 'NaN', '1,99']) {
    assert.ok(Number.isNaN(toCents(bad)), `toCents(${JSON.stringify(bad)}) must be NaN`);
  }
  ok('toCents: malformed/empty/negative/3-decimal → NaN (never a real total by accident)');

  // The money-safety comparison the webhook does:
  const orderTotalCents = 29900;
  assert.strictEqual(toCents('299.00') === orderTotalCents, true);
  assert.strictEqual(toCents('298.00') === orderTotalCents, false); // underpay caught
  assert.strictEqual(Number.isNaN(toCents('')) && '' === orderTotalCents, false); // absent never matches
  ok('toCents: amount==total_cents compare catches underpay + absent');
}

// ---- clientSignature: known-answer (the hosted _client_signature uses the same formula) ----
{
  const sig = clientSignature('@s4ndb0x-abcd-1234-n1l4-p1x3l', ['1234567890', 'ORDER-8888', 'https://pixelpay.dev']);
  assert.ok(sig.startsWith('688084a6') && sig.endsWith('e852ee2a'), `KAT mismatch: ${sig}`);
  ok('clientSignature: doc known-answer (688084a6…e852ee2a) reproduced');
}

console.log(`\nAll ${pass} hosted-helper tests passed.`);
