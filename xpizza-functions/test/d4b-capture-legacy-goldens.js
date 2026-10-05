'use strict';
// Portal 1D · D4-b — CAPTURE the frozen legacy-hash goldens. Run ONCE, on UNMODIFIED code at main 717f97e:
//   node test/d4b-capture-legacy-goldens.js
// 🔴 THE GOLDEN IS PRE-D4-b CODE'S OUTPUT, AND IT IS NEVER REGENERATED. Regenerating it after a D4-b
// change would make it agree with whatever D4-b does — exactly what it exists to refuse. So this script
// REFUSES to run unless HEAD is the base commit and none of the writers it drives is modified.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { captureLegacyHashes } = require('./d4b-legacy-capture');

const BASE = '717f97e911774aa03fa285b54ee5af576067ba1a';
const WRITERS = ['quote-token.js', 'quote-issue.js', 'rewards-redeem.js', 'createorder-classify.js', 'rewards-redeem-intake.js',
  'pixelpay-charge.js', 'order-money.js', 'scheduled-orders.js', 'rewards-reserve.js', 'menu-pricing.js', 'rewards-redeem-pricing.js',
  'availability-gate.js', 'rewards-redeem-config.js', 'catalog/pricing-tables.js'];

(async () => {
  const git = (...a) => execFileSync('git', a, { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  if (head !== BASE) throw new Error(`refusing: HEAD is ${head}, the golden must be captured at ${BASE}`);
  const dirty = git('status', '--porcelain', '--', ...WRITERS);
  if (dirty) throw new Error(`refusing: a writer differs from ${BASE}:\n${dirty}`);
  const values = await captureLegacyHashes();
  const golden = {
    _provenance: { captured_at_commit: BASE, captured_by: 'test/d4b-capture-legacy-goldens.js', captured_on: new Date().toISOString().slice(0, 10),
      writers: 'issueQuote token cart_fingerprint · redemptionFingerprint(computeRedemption) · computeIncomingFingerprint (createOrder) · reserveRedemption stored fp' },
    values,
  };
  const out = path.join(__dirname, '..', 'catalog', 'd4b-legacy-hashes.golden.json');
  fs.writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${out}`);
})().catch((e) => { console.error(String(e && e.message)); process.exit(1); });
