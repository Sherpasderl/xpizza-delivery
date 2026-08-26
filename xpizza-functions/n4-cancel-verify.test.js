'use strict';
// N4 — cancel-return payment verify (client-only, both forms). The handler is inline in the form HTML, so
// lock the P1/P2/P3 invariants + byte-parallelism in source. Runtime is the manual smoke checklist.
// Run: node n4-cancel-verify.test.js
const fs = require('fs');
const assert = require('assert');
const path = require('path');

const FORMS = {
  'la-musa': { file: path.join(__dirname, '..', 'la-musa-orders', 'index.html'), stash: 'lamusa_pending_pay' },
  'x-pizza': { file: path.join(__dirname, '..', 'xpizza-orders', 'index.html'), stash: 'xpizza_pending_pay' },
};
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

for (const [brand, { file, stash }] of Object.entries(FORMS)) {
  const src = fs.readFileSync(file, 'utf8');
  const has = (re, msg) => assert.ok(re.test(src), `[${brand}] ${msg}`);

  // P3 — shared per-state dispatch extracted + reused by the loop
  has(/function applyPollState\(st, j, orderId, stashedOrder\)\{/, 'applyPollState helper defined');
  has(/const st = \(r\.ok && j\.state\) \|\| 'pending';\s*\n\s*if\(applyPollState\(st, j, orderId, stashedOrder\)\) return true;/, 'poll loop reuses applyPollState');
  has(/return false;   \/\/ pending \/ unknown/, 'applyPollState returns false for pending/unknown');

  // cancel-verify branch
  const ci = src.indexOf("if(pay==='cancel'){"); assert.ok(ci !== -1, `[${brand}] cancel-verify branch present`);
  const cend = src.indexOf("if(pay!=='complete'", ci); assert.ok(cend !== -1, `[${brand}] cancel branch bound`);
  const cancel = src.slice(ci, cend);
  // P2 — can't-verify fallback stays 'cancel'
  has(/if\(pay==='cancel' && \(!orderId \|\| !token\)\)\{ showPayReturn\('cancel'\); return true; \}/, 'P2: no orderId/token → cancel (no fetch)');
  // P1 — SINGLE bounded check (Promise.race 5s), NOT the 90s loop
  assert.ok(/Promise\.race\(/.test(cancel), `[${brand}] P1: single bounded check via Promise.race`);
  assert.ok(/setTimeout\(\(\)=>rej\(new Error\('timeout'\)\), 5000\)/.test(cancel), `[${brand}] P1: ~5s timeout`);
  assert.ok(!/while\(/.test(cancel), `[${brand}] P1: cancel path has NO polling loop`);
  // only the 4 paid states override "cancelled"
  assert.ok(/\(st==='paid' \|\| st==='scheduled_paid' \|\| st==='closed_refunded' \|\| st==='scheduled_review'\) && applyPollState\(st, j, orderId, stashedOrder\)/.test(cancel), `[${brand}] only the 4 paid states override cancel, via applyPollState`);
  // P2 — fail-safe: the branch ends by showing 'cancel'
  assert.ok(/showPayReturn\('cancel'\); return true;   \/\/ P2 fail-safe/.test(cancel), `[${brand}] P2: fail-safe to 'cancel'`);
  // accepted residual documented
  assert.ok(/self-heals on retry/.test(cancel), `[${brand}] accepted residual documented`);
  // uses the brand's stash key (byte-parallel-but-branded)
  assert.ok(src.includes(`localStorage.getItem('${stash}'`), `[${brand}] reads its own stash`);

  ok(`${brand}: applyPollState reuse + cancel-verify (P1 single-check, P2 fail-safe, 4-paid-state override)`);
}

// byte-parallel: identical N4 control tokens in BOTH forms
const tok = ["function applyPollState(st, j, orderId, stashedOrder){", "if(pay==='cancel' && (!orderId || !token)){ showPayReturn('cancel'); return true; }", "(st==='paid' || st==='scheduled_paid' || st==='closed_refunded' || st==='scheduled_review') && applyPollState(st, j, orderId, stashedOrder)", "setTimeout(()=>rej(new Error('timeout')), 5000)"];
const present = Object.fromEntries(Object.entries(FORMS).map(([b, { file }]) => [b, tok.map((t) => fs.readFileSync(file, 'utf8').includes(t))]));
assert.deepEqual(present['la-musa'], present['x-pizza'], 'both forms carry the identical N4 cancel-verify logic (byte-parallel)');
assert.ok(present['la-musa'].every(Boolean), 'all N4 tokens present in both forms');
ok('both forms byte-parallel on the N4 cancel-verify logic');

console.log(`\nn4-cancel-verify.test.js: ${pass} passed`);
