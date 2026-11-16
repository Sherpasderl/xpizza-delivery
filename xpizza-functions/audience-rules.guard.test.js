'use strict';
// offer-audience BUILD T11 (PLAN-5f-offer-audience r2 §8 «marker rule denials», r4.1 §4) — the static pin over the REAL rules file
// (xpizza-reference/database.rules.json, synced into this package by sync:rules):
//   · the audience's server-only nodes — customer_seen, customer_seen_m, audience_ids_by_day, audience_alerts — have NO rule (and the root
//     grants nothing), so every client is denied by RTDB's default; a future rule there is RED here until reviewed;
//   · the dispatcher's orders/$order_id write keeps the payout decision orders/{id}/offer_reconcile byte-for-byte (funded_by, reason, at):
//     only the fulfilment writer / the deadline sweep (Admin SDK) ever decide who funds a discount (rule 17).
// Behaviourally (every client role, the emulator): test/audience-rules.emulator.test.js (slot).
// Run: node audience-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;

assert.ok(!('.read' in R) && !('.write' in R), 'AUD-RULES: premise — the root grants nothing (RTDB denies by default)');
for (const node of ['customer_seen', 'customer_seen_m', 'audience_ids_by_day', 'audience_alerts']) {
  assert.ok(!(node in R), `AUD-RULES: 🔴 ${node} must stay rule-less (server-only by RTDB's default deny)`);
  assert.ok(!Object.keys(R).some((k) => k.startsWith('$')), `AUD-RULES: 🔴 a root wildcard would expose ${node}`);
}
ok('customer_seen / customer_seen_m / audience_ids_by_day / audience_alerts: no rule, no root grant, no root wildcard ⇒ every client denied');

const w = R.orders.$order_id['.write'];
for (const leaf of ['offer_reconcile/funded_by', 'offer_reconcile/reason', 'offer_reconcile/at']) {
  assert.ok(w.includes(`newData.child('${leaf}').val() === data.child('${leaf}').val()`), `AUD-RULES: 🔴 the dispatcher order write must keep ${leaf}`);
}
ok('the dispatcher\'s order write keeps the payout decision (offer_reconcile funded_by / reason / at) unchanged');
console.log(`audience-rules.guard: OK (${n})`);
