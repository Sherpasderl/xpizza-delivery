'use strict';
// F2 client terminal screen (Task 2) — structural parity across both forms. The poll-loop + copy-map are inline
// in the form HTML, so lock the invariants + byte-parallelism in source. Runtime is the manual smoke checklist.
// Run: node f2-client.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const VERBATIM = 'Recibimos tu pago. Lastimosamente el pedido se recibió fuera de horario; un agente te contactará en breve para coordinar un nuevo horario o reembolsarte la transacción si prefieres.';
const FORMS = {
  'la-musa': { file: path.join(__dirname, '..', 'la-musa-orders', 'index.html'), stash: 'lamusa_pending_pay' },
  'x-pizza': { file: path.join(__dirname, '..', 'xpizza-orders', 'index.html'), stash: 'xpizza_pending_pay' },
};
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

for (const [brand, { file, stash }] of Object.entries(FORMS)) {
  const src = fs.readFileSync(file, 'utf8');
  const has = (re, msg) => assert.ok(re.test(src), `[${brand}] ${msg}`);
  // poll-loop terminal case: stops polling, clears the stash, shows the terminal screen
  has(new RegExp(`st==='scheduled_review'\\)\\{[\\s\\S]*?removeItem\\('${stash}'\\)[\\s\\S]*?showPayReturn\\('scheduled_review'\\); return true;`), 'poll-loop scheduled_review case (clears stash + terminal showPayReturn + stops polling)');
  // copy-map entry: terminal (mark:'ok', NOT wait:true) + verbatim message
  has(/scheduled_review:\s*\{mark:'ok'/, 'copy-map scheduled_review is terminal (mark:ok, not wait)');
  assert.ok(src.includes(VERBATIM), `[${brand}] verbatim owner-locked message present`);
  ok(`${brand}: scheduled_review poll-case + terminal copy-map + verbatim message`);
}

// byte-parallel: identical scheduled_review handling tokens in BOTH forms
const tok = ["st==='scheduled_review'", "scheduled_review:{mark:'ok'", VERBATIM, "showPayReturn('scheduled_review')"];
const present = Object.fromEntries(Object.entries(FORMS).map(([b, { file }]) => [b, tok.map((t) => fs.readFileSync(file, 'utf8').includes(t))]));
assert.deepEqual(present['la-musa'], present['x-pizza'], 'both forms carry the identical scheduled_review handling (byte-parallel)');
assert.ok(present['la-musa'].every(Boolean), 'all scheduled_review tokens present in both forms');
ok('both forms byte-parallel on the F2 terminal-screen handling');

console.log(`\nf2-client.test.js: ${pass} passed`);
