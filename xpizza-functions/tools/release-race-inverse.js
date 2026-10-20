'use strict';
// RELEASE RACE (PLAN-release-race r2.1) — the test-only INVERSE of this slice's index.js footprint: the assignment-conflict
// require and the healer's alert call after a committed heal. unapplyReleaseRaceIndex(index.js) === 32f6f17e:index.js byte-for-byte
// (release-race-wiring.guard). Newest layer → applied INNERMOST in every index.js fold consumer:
// unapplyTrackerFixesIndex(unapplyReleaseRaceIndex(<source>)).
// Each hunk must occur EXACTLY once, else this throws. GENERATED from base (32f6f17e) vs candidate; JSON-quoted [now, was] pairs.

const INDEX_HUNKS = [
 [
  "const { alertAssignmentConflict } = require('./assignment-conflict');   // release race: the healer's conflict alert\n",
  ""
 ],
 [
  "        // RELEASE RACE (owner edge-case rule): a CONFIRMED (≥ HALF_CLAIM_STALE_MS persisted) and committed heal → ONE create-only\n        // dispatcher alert carrying order_id (Torre click-through). Bounded (3 s) and best-effort: never blocks the sweep.\n        await alertAssignmentConflict(db, { orderId, deliveryDriverId: strandedDel, pickupDriverId: strandedPick, now });\n",
  ""
 ]
];

function unapplyReleaseRaceIndex(src) {
  let out = src;
  for (const [now, was] of INDEX_HUNKS) {
    const n = out.split(now).length - 1;
    if (n !== 1) throw new Error(`release-race-inverse index.js: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(now.slice(0, 120))}`);
    out = out.replace(now, () => was);
  }
  return out;
}

module.exports = { unapplyReleaseRaceIndex, INDEX_HUNKS };
