'use strict';
// R3 P1-a (codex r2 P1-1c): every R3 runner asserts, BEFORE it sets any fake test value, that its process holds no REAL
// credential (tools/secret-env.js; emulator-run scrubs them). Only key NAMES are reported, never values.
const { present } = require('../tools/secret-env');
const leaked = present(process.env);
if (leaked.length) { console.error(`🔴 R3-SECRETS a test process holds real-credential env key(s): ${leaked.join(', ')} — run through tools/emulator-run.js (it scrubs them)`); process.exit(1); }
module.exports = { checked: true };
