'use strict';

// Deploy-DISCOVERY load guard (deploy-only failure class — the emulator can't catch it; test suites run WITH
// OTP_SALT set). `firebase deploy` runs source discovery in a runtime-env-LESS process: OTP_SALT is unset.
// A module that TOP-LEVEL-requires a dep whose module-load fail-closes on a missing OTP_SALT (otp-lib) throws
// at discovery → blocks ALL functions deploys (this exact bug hit claim-order.js — fixed by lazy-requiring
// otp-lib). This guards that class: requiring claim-order.js with OTP_SALT unset must NOT throw.
const assert = require('assert');

delete process.env.OTP_SALT;
delete require.cache[require.resolve('./claim-order')];
assert.doesNotThrow(
  () => require('./claim-order'),
  'claim-order.js must load with OTP_SALT unset (firebase deploy source discovery has no runtime env) — lazy-require any fail-closed-on-OTP_SALT dep (otp-lib)',
);
// The claim-prefill sibling is pure (no OTP dep) but load it too — cheap regression net for the same class.
assert.doesNotThrow(() => require('./claim-prefill'), 'claim-prefill.js must load with OTP_SALT unset');

console.log('claim-order-discovery: OK (loads without OTP_SALT — deploy-discovery safe)');
