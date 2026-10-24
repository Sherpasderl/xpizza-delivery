'use strict';
// driver-ledger (Customer App S8) — the test-only INVERSE of the driver payable ledger slice (hot-file invariant, see memory
// index-js-inverse-fold-invariant). The slice's ONE index.js hunk — a same-line append to the driverDiagIngest export
// that re-exports closeDriverPayWeeks / getDriverPayWeek / markDriverWeekPaid from driver-ledger/functions.js — put back
// to its e0af1007 text, so every *-wiring.guard fold chain reconstructs its frozen base. Proof (i):
// unapplyDriverLedgerIndex(index.js) === e0af1007:index.js byte-for-byte (driver-ledger-wiring.guard). The hunk must occur
// EXACTLY once, else this throws. GENERATED from `git diff e0af1007 -- index.js`; JSON-quoted strings.

const HUNKS = [
  [
    "exports.driverDiagIngest = require('./driver-diag').driverDiagIngest; exports.closeDriverPayWeeks = require('./driver-ledger/functions').closeDriverPayWeeks; exports.getDriverPayWeek = require('./driver-ledger/functions').getDriverPayWeek; exports.markDriverWeekPaid = require('./driver-ledger/functions').markDriverWeekPaid;   // S8 driver payable ledger (driver-ledger/; tools/driver-ledger-inverse.js)\n",
    "exports.driverDiagIngest = require('./driver-diag').driverDiagIngest;\n"
  ]
];

function unapplyDriverLedgerIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`driver-ledger-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyDriverLedgerIndex, HUNKS };
