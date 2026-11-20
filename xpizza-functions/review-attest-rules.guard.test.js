'use strict';
// «Marcar como revisado» (structural rebuild, owner GO 11-19) — the static pin over the REAL rules file. RTDB rules cascade, so review data can
// never be fenced off INSIDE the order; it lives OFF the order instead:
//   · manual_review_closures — NO rule anywhere (the root grants nothing ⇒ every client denied by RTDB's default); a future rule is RED here
//   · manual_review_episodes — ONLY a dispatcher READ on $order_id (Central sends the episode back); NO .write / .validate at any level
//   · no root wildcard that would reach either
// Behaviourally (every client role, the emulator): test/review-attest-rules.emulator.test.js (slot).
// Run: node review-attest-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
assert.ok(!('.read' in R) && !('.write' in R) && !Object.keys(R).some((k) => k.startsWith('$')), 'RAR: premise — the root grants nothing and has no wildcard');
assert.ok(!('manual_review_closures' in R), '🔴 RAR: manual_review_closures must stay rule-less (server-only by default deny)');
ok('manual_review_closures: no rule, no root grant, no root wildcard ⇒ every client denied');
const E = R.manual_review_episodes;
assert.ok(E && Object.keys(E).join() === '$order_id', '🔴 RAR: manual_review_episodes has exactly one child rule, $order_id');
assert.deepStrictEqual(Object.keys(E.$order_id), ['.read'], '🔴 RAR: manual_review_episodes/$order_id carries ONLY a .read (no .write / .validate)');
const r = E.$order_id['.read'];
for (const term of ["auth != null", "auth.token.handheld !== true", "auth.token.customer !== true", "root.child('dispatchers').child(auth.uid).exists()"]) assert.ok(r.includes(term), `🔴 RAR: the episode read is a dispatcher's only (${term})`);
ok('manual_review_episodes: a dispatcher READ only, nothing else');
const w = R.orders.$order_id['.write'];
assert.ok(!/manual_review_closed|manual_review_since/.test(w), '🔴 RAR: the order rule carries no review leaf clauses (the review lives off the order)');
ok('the order rule is free of review fields (the #217 leaf clauses are reverted)');
console.log(`review-attest-rules.guard: OK (${n})`);
