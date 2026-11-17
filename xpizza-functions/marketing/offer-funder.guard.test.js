'use strict';
// offer-audience BUILD T13 (PLAN-5f-offer-audience r4.1 §4: «offerFunder — the only funder reader, census-pinned»; r2 §8 mutant «read
// offer.funded_by directly in a payout reader») — WHO funds a discount is answered ONLY by marketing/offer-price offerFunder: an audience-'new'
// offer's decision lives in orders/{id}/offer_reconcile (absent ⇒ Sherpa), so a reader of the frozen offer.funded_by would pay a mis-granted
// «nuevo» from the restaurant. Every non-test source file in the repo that names `funded_by` or `offer_reconcile` must be one of:
//   marketing/offer-price.js     — offerFunder (THE reader) + frozenOf (the frozen offer's writer)
//   marketing/offer-wire.js      — storedOfferOf (pricing-record validation of the frozen offer — not a payout reader)
//   marketing/audience-writer.js — the fulfilment writer's create-if-absent decision (a WRITER)
//   marketing/audience-sweep.js  — the deadline sweep's create-if-absent 'ids_expired' decision (a WRITER)
// A new file (a payout ledger, a statement, stats, the portal) is RED here until it reads through offerFunder and is reviewed in.
// Run: node marketing/offer-funder.guard.test.js
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..', '..');
const ALLOWED = ['xpizza-functions/marketing/offer-price.js', 'xpizza-functions/marketing/offer-wire.js', 'xpizza-functions/marketing/audience-writer.js', 'xpizza-functions/marketing/audience-sweep.js'];

let hits = [];
try {
  hits = execFileSync('git', ['grep', '-l', '-e', 'funded_by', '-e', 'offer_reconcile', '--', '*.js', '*.mjs', '*.html', ':!*.test.js', ':!*.test.mjs', ':!**/node_modules/**', ':!xpizza-functions/tools/*-inverse.js'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (e) { if (e.status !== 1) throw e; }   // git grep exits 1 on no match
assert.ok(ALLOWED.every((f) => hits.includes(f)), `FUNDER: non-vacuity — every allowed file still names the funder (${hits})`);
const extra = hits.filter((f) => !ALLOWED.includes(f));
assert.deepStrictEqual(extra, [], `FUNDER: 🔴 a file names funded_by / offer_reconcile outside offerFunder's reviewed set — read the funder through marketing/offer-price offerFunder: ${extra.join(', ')}`);
ok(`funded_by / offer_reconcile appear only in the ${ALLOWED.length} reviewed files (offerFunder is the ONE reader)`);
console.log(`offer-funder.guard: OK (${n})`);
