'use strict';
// ---------------------------------------------------------------------------
// Portal 1A Task 7 — THE ONE PLACE A PUBLISH CANDIDATE IS VALIDATED.
//
// 🔴 A PUBLISHED VERSION *IS* A SOURCE DOCUMENT. Same items, same extras, same structure — the store
// draft and the immutable version are the same shape wearing two names, which is why the complete
// validator built in Task 2 can be applied to a candidate without inventing a second rule set. It is
// applied HERE, not at each caller, for the reason every path-by-path checklist eventually fails:
// the next path nobody remembers to add is the one that publishes the bad menu.
//
// TWO MOMENTS, deliberately, and neither replaces the other:
//   • PRE-PUBLISH, before anything is written — so an invalid candidate never becomes an immutable
//     version at all, and the merchant is told what is wrong rather than left with a dead version.
//   • PRE-FLIP, against what was actually PERSISTED and read back — because what gets served is what
//     Firestore holds, not what the publisher meant to send. The first check validates an intention;
//     only the second validates a fact.
//
// The failures are re-tagged `publish_refused_invalid` with the validator's own message intact: the
// caller needs to branch on "this candidate cannot go live" while a human still needs the reason.
// ---------------------------------------------------------------------------
const { validateSource, SCHEMA_VERSION } = require('./source-store');

// A candidate in source shape. `extras` is the RECORD array (key/price/display), never the numeric
// charging table — the publisher carries both and they are easy to confuse, so the one that names
// options is the one named here.
function candidateSource(restaurantId, { items, extras, structure }) {
  return { restaurant_id: restaurantId, schema_version: SCHEMA_VERSION, items, extras, structure };
}

function assertCandidateValid(restaurantId, candidate, where) {
  try {
    validateSource(candidate, restaurantId);
  } catch (e) {
    const err = new Error(`publish_refused_invalid: ${where} — ${String((e && e.message) || e)}`);
    err.code = 'publish_refused_invalid';
    err.cause = e;
    throw err;
  }
  return true;
}

module.exports = { candidateSource, assertCandidateValid };
