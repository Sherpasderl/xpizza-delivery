'use strict';
/* derivePlan — the activation plan, DERIVED from what the transaction already read.
 *
 * 🔴 WHY DERIVED AND NOT RECEIVED. §68 says flipPointer "loads/receives" the plan and then re-verifies
 * it, and an argument satisfies that wording. But an argument whose only supplier is publishVersion is
 * exactly the shape that let `writeVersion`'s `stamps` map sit unfed for four slices while hiding a
 * production lockout — built work that reads as wired and is not. Deriving it from the candidate and
 * the registry snapshots the flip ALREADY HOLDS means there is nothing to forge and nothing to leave
 * unfed: the plan stops being a claim about the world and becomes a reading of it. That removes a
 * class of verification rather than adding checks to it.
 *
 * 🔴 AND IT CARRIES MORE WEIGHT THAN THE REASON IT WAS CHOSEN FOR — SAID SO NOBODY RE-LITIGATES IT
 * ON THE ORIGINAL GROUNDS ALONE. We derived in-tx to avoid a parameter only publishVersion would
 * supply. It turns out to be what makes verifyPlan's MINT rule sound at all: that rule asks whether an
 * id already EXISTS, and the answer is only meaningful against a registry read in THIS transaction.
 * Had the plan been built earlier and passed in, "already exists" would be evaluated against a stale
 * reading, and §4's "never recycle an id referenced by an activatable version" would be checked at the
 * wrong moment. With derive-in-tx, an earlier activation's mints are already in the registry by the
 * time this transaction reads it, and two pending versions minting the same id are serialized by the
 * fence — whichever activates second derives against a registry containing the first one's rows and is
 * refused by `plan_mint_id_exists`. Refusing is the correct outcome, not a missed case.
 *
 * 🔴 AND verifyPlan IS STILL RUN ON THE RESULT. Nobody should argue it is now redundant. Deriving the
 * plan makes the INPUT trustworthy; verifying it makes the OUTPUT checkable independently of the code
 * that produced it, which is the whole point of a predicate a reviewer can read on its own. A bug in
 * the derivation below is exactly what verifyPlan is positioned to catch, and it cannot catch it if it
 * is skipped because the derivation "cannot be wrong".
 *
 * PURE. Every input is data the caller read; the one function it takes is discussed below.
 */
const { STATUS_LIVE, encodeKey } = require('./identity-registry');

const isStr = (v) => typeof v === 'string' && v.length > 0;

/* `candidateKeys` : Set of the legacy keys this version serves for ONE kind.
   `stamps`        : {legacyKey -> canonicalId} persisted on the candidate's objects (may be partial).
   `ids`           : Map(id -> {legacy_key, status}) — the WHOLE registry for this kind, live AND retired.
   `keys`          : Map(encodedName -> {canonical_id}) — likewise whole.
   `retireIds`     : the ids the consumed deletion claim names (already validated upstream).
   `allocate`      : (legacyKey) => a fresh canonical id.

   🔴 `allocate` IS INJECTED AND THAT IS NOT THE MISTAKE `encode` WAS. encodeKey had one correct
   answer, so injecting it created a parameter that could silently disagree with the rows already
   written and make refusal 5 vacuous. Allocation has NO correct answer to import — it is
   nondeterministic by construction (randomToken) and brand-dependent (a grandfathered slug IS its
   id). So it must come from the caller. The difference that matters is that a WRONG allocator is
   CAUGHT rather than silent: any id it returns that already exists, live or retired, is refused by
   verifyPlan's MINT rule. An injected dependency whose failure is checked is not the same hazard as
   one whose failure is invisible. */
function derivePlan({ candidateKeys, stamps = {}, ids, keys, retireIds = [], allocate } = {}) {
  if (!(ids instanceof Map) || !(keys instanceof Map)) {
    throw new Error('identity_derive_registry_unread: the derivation needs the registry index the transaction read; an unread registry is not an empty one');
  }
  if (typeof allocate !== 'function') {
    throw new Error('identity_derive_no_allocator: minting a new id requires an allocator from the caller; there is no correct one to import');
  }
  const wanted = candidateKeys instanceof Set ? candidateKeys : new Set(candidateKeys || []);

  const moves = [];
  const mints = [];
  const retires = [];

  /* RETIRES FIRST, and the set is recorded, because the two rules below must not also act on an id
     this plan is ending. A plan that both retires an id and moves it is refused by verifyPlan — and
     refusing there would be a derivation bug reported as a plan bug, which is a worse error message
     than simply not deriving it. */
  const ending = new Set();
  for (const id of retireIds) {
    if (!isStr(id)) continue;
    const row = ids.get(id);
    /* An id the registry does not have, or one already retired, is not retired AGAIN. The claim was
       validated against the version upstream, not against the registry, and a claim naming something
       already gone is a no-op rather than an error: the activation's job is to reach the end state. */
    if (!row || row.status !== STATUS_LIVE) continue;
    retires.push({ id, name: row.legacy_key });
    ending.add(id);
  }

  for (const key of wanted) {
    const stamped = stamps[key];

    /* 🔴 A MOVE IS DETECTED FROM THE ID'S OWN ROW, NOT FROM THE KEY ROW. The candidate says "this
       object is X and is now called K". The registry says what X currently claims. If those differ,
       that IS the rename, and it is the one description of it that cannot have been round-tripped
       through a browser — the stamp is server-written and the row is server-owned. */
    if (isStr(stamped) && !ending.has(stamped)) {
      const row = ids.get(stamped);
      if (row && row.status === STATUS_LIVE && row.legacy_key !== key) {
        moves.push({ id: stamped, from: row.legacy_key, to: key });
        continue;
      }
      /* 🔴 EVERY OTHER STAMPED CASE FALLS THROUGH TO THE `stamped` SKIP BELOW, and there used to be a
         second `continue` right here saying so. The sweep left a mutant on it alive: removing it
         changed nothing, because a stamped key that does not move is skipped there anyway. Two
         lines with one meaning, and no fixture able to tell them apart — deleted rather than propped
         up. The cases it covered are unchanged and are named below. */
      /* Stamped at an id that is absent or retired. NOT repaired here and NOT minted over: a mint
         would hand this object a second identity while the stamp still names the first, and the
         stamp map's own verification (`stamp_id_retired`, `stamp_id_row_missing`) has already
         refused this activation before the derivation runs. Falling through to the mint branch would
         make that refusal reachable-but-bypassed, so it is left for the verifier to refuse rather
         than silently resolved. */
    }

    /* 🔴 MINT ONLY WHERE NOTHING CLAIMS THE NAME. The key row is consulted as well as the stamp: an
       object can arrive unstamped (pre-P1, or a candidate written before stamping) while the registry
       already holds its identity, and minting there is the duplicate-id bug ensureIdentity closed at
       the writer. If a live id already claims this name, this publish preserves it by doing nothing.
       A name claimed by a RETIRED id is not free either — that is the reservation — and it is left to
       the destination guard and verifyPlan to refuse rather than decided here. */
    const keyRow = keys.get(encodeKey(key));
    const claimantId = keyRow && isStr(keyRow.canonical_id) ? keyRow.canonical_id : null;

    /* 🔴 `!ending.has(...)` IS LOAD-BEARING AND WAS MISSING FROM THIS BRANCH. A bare `if (keyRow)
       continue` is wrong for one reachable case: the merchant deletes an object and, in the SAME
       publish, creates a new one under the same name. The key row still names the OUTGOING id, which
       this plan retires — and skipping on the row alone left the new object with NO identity at all,
       silently. It falls through to the mint now, because the name is being released by this very
       plan and the row is going with it.
       🔴 AND THERE WAS A REDUNDANT CHECK ABOVE THIS ONE. It asked separately whether the claimant was
       LIVE and not ending. Every fixture that satisfied it also satisfied this line, so no cell could
       ever tell the two apart — the sweep said so by leaving a mutant on it alive. A branch nothing
       can distinguish is a branch that should not exist, so it is gone rather than propped up with an
       assertion invented to justify it. What it was reaching for — a row naming an absent or retired
       id is a registry disagreement, refused upstream, not resolved here — is still true and is why
       this skips rather than mints. */
    if (keyRow && !(claimantId && ending.has(claimantId))) continue;

    /* 🔴 ANY STAMPED OBJECT THAT DID NOT MOVE IS LEFT ALONE, AND THE TWO CASES ARE DIFFERENT REASONS
       FOR THE SAME NON-ACTION. Either the id already claims this name — the ordinary republish, which
       preserves identity by doing nothing because the registry is not version-scoped — or the stamp
       names an id that is ABSENT or RETIRED, which the stamp map has already refused this activation
       for (`stamp_id_retired`, `stamp_id_row_missing`). Minting in the second case would hand the
       object a second identity while its stamp still names the first, and would make a refusal that
       already fires into one a path exists to route around.
       `!ending.has(stamped)` for symmetry with the move branch: a candidate still serving an object
       whose id the claim retires is refused upstream by the partition law (C ∩ D = ∅,
       `flip_claim_not_executed`), so it cannot arrive here — and if it ever did, minting a fresh id
       is the honest answer rather than silently skipping. */
    if (isStr(stamped) && !ending.has(stamped)) continue;
    mints.push({ id: allocate(key), name: key });
  }

  return { moves, mints, retires };
}

module.exports = { derivePlan };
