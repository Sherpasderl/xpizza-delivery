'use strict';
// S4 C′ (PLAN-capp-S4-r5 §0) — the ONE hours grammar: hours7Errors MOVED from branches/branch-ops.js, re-exported there as the
// SAME function object; the seed adopts it (BC-3, seed-identity.test.js). Run: node schedule/hours-grammar.test.js
const assert = require('assert');
const G = require('./hours-grammar');
const BO = require('../branches/branch-ops');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

assert.strictEqual(BO.hours7Errors, G.hours7Errors, 'MOVE-SAME-OBJECT: branch-ops re-exports the grammar module\'s function (no copy)');
assert.deepStrictEqual(BO.DAYS, G.DAYS, 'branch-ops keeps its DAYS export, equal to the grammar\'s');
ok('MOVE: branch-ops.hours7Errors === schedule/hours-grammar.hours7Errors (same reference); DAYS export kept');

const open = (start, end) => ({ open: true, start, end });
const H7 = Object.fromEntries(G.DAYS.map((d) => [d, open('12:00', '20:45')]));
assert.deepStrictEqual(G.hours7Errors(H7), [], 'GRAMMAR-VALID-7');
const refused = {
  missingDay: (() => { const h = { ...H7 }; delete h.sun; return h; })(),
  unknownDay: { ...H7, funday: { open: false } },
  oneDigit: { ...H7, tue: open('9:00', '20:45') },
  h24: { ...H7, tue: open('17:00', '24:00') },
  overnight: { ...H7, fri: open('22:00', '02:00') },
  equal: { ...H7, fri: open('17:00', '17:00') },
  extraKey: { ...H7, thu: { ...open('17:00', '20:45'), note: 'x' } },
  closedWithTimes: { ...H7, mon: { open: false, start: '17:00', end: '20:45' } },
  missingOpen: { ...H7, wed: { start: '12:00', end: '20:45' } },
  arrayTime: { ...H7, wed: { open: true, start: ['12:00'], end: '20:45' } },
  notObject: 'all week',
  nullHours: null,
};
for (const [label, h] of Object.entries(refused)) assert.ok(G.hours7Errors(h).length > 0, `GRAMMAR-REFUSES-${label}`);
ok(`GRAMMAR: 7 valid days accepted; ${Object.keys(refused).length} malformed shapes refused (missing/unknown day, 9:00, 24:00, overnight, equal, extra key, closed-with-times, missing open, array time, non-object, null)`);
console.log(`\nhours-grammar: OK (${n})`);
