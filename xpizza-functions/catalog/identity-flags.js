'use strict';
/* renameEnabled — §7's staging switch, which did not exist.
 *
 * 🔴 IT WAS PROSE. §7 describes "staging via a single rename-enable flag" and §10 says to deploy P1a
 * with it OFF. Every spelling of it in this tree is a COMMENT — identity-restore.js:156,
 * d4p1-money-noop.test.js:13, test/d4p1-money-noop.emulator.test.js:11 — and not one is a read. So
 * "P1a" and "P1b" were the same build, and the safety of the cutover rested on an artefact that
 * existed only on the page. This is that artefact.
 *
 * 🔴 WHAT IT GATES: MOVES, AND ONLY MOVES. With it OFF the activation writer MINTS new identities and
 * derives no moves, which is P1a — and P1a is mints-only rather than mint-and-retire because
 * retirement is not safely reversible until Slice F wires restoreIdentity (see the standing-divergence
 * note at the top of identity-registry.js). With it ON a rename preserves the id at the write
 * boundary, which is P1b.
 *
 * 🔴 FAIL-SAFE OFF, AND THE DIRECTION IS THE WHOLE POINT. An unreadable flag must degrade to the
 * behaviour that shipped before the flag existed — renames refused by the stamp map, exactly as today
 * — not to silently moving ids around because a config read blipped. Same shape as
 * `tokenEnforceEnabled` (token-gate.js:264): try/catch, one default, and ANY read error means off.
 *
 * 🔴 READ ONCE, OUTSIDE THE TRANSACTION, AND PASSED DOWN. Copied deliberately from token-gate's note:
 * "a flag that could change between the cash and card gate within one request would be a way to get
 * two different answers about the same order". Here it would be worse — dish and extra are derived in
 * one activation, and a flag that changed between them would let one kind rename while the other
 * refused, inside a transaction that is supposed to be all-or-nothing.
 *
 * 🔴 FIRESTORE, NOT RTDB — A DELIBERATE DIVERGENCE FROM token_enforce, AND NOT FOR THE REASON I FIRST
 * GAVE. My first draft of this note said RTDB would put a non-transactional store "in the path of the
 * most dangerous transaction in the system". That is false and worth correcting rather than deleting:
 * the flag is read ONCE, OUTSIDE the transaction, and passed down, so RTDB would be no more inside it
 * than Firestore is. A deviation defended by an argument that does not hold gets reverted the first
 * time someone tests the argument.
 * THE REASONS THAT DO HOLD:
 *   · publishVersion holds a Firestore handle and NO RTDB one. RTDB therefore costs a new parameter on
 *     the most dangerous function in the system, and a Firestore-handle-where-RTDB-was-meant confusion
 *     already cost a slice in D3. That is a measured cost, not a hypothetical.
 *   · Read with the same handle whose availability ALREADY determines whether a publish can happen at
 *     all: a Firestore outage fails the publish anyway, so the flag cannot fail independently of the
 *     thing it gates. A second store is exactly what would introduce that independent failure.
 *
 * 🔴 THE COST OF THE SPLIT, STATED SO WHOEVER FLIPS IT CAN FIND IT. There are now TWO flag homes.
 * token_enforce lives in RTDB at `config/token_enforce`; THIS ONE DOES NOT. It is the Firestore
 * document `restaurants/{rid}/meta/identity_flags`, field `rename_enabled`, boolean true. Whoever
 * flips it will not be whoever wrote it, and a staging flag nobody can find is one that gets left in
 * the wrong position. It is flipped once, deliberately, per §10 — never during an incident.
 *
 * 🔴 PER-RESTAURANT, NOT GLOBAL — A DEVIATION FROM §7's "SINGLE FLAG", WITH TWO REASONS, AND THE ORDER
 * MATTERS BECAUSE ONE IS CONTINGENT AND THE OTHER IS NOT.
 *
 * (1) TODAY, la_musa is excluded by CERTIFICATION, not by this flag. It is never certified — observed,
 *     `certifiedCandidate:false` on every la_musa publish — so the in-transaction block is never
 *     entered for it and no move is derived whatever this flag says.
 *
 * (2) 🔴 BUT CERTIFICATION IS A CURRENT-STATE PROPERTY, NOT A BRAND-ENFORCED INVARIANT, AND THAT IS
 *     WHY THE rid SCOPING IS LOAD-BEARING RATHER THAN COSMETIC. Verified at catalog-publish.js:897:
 *         const certified = !!stamps && (Object.keys(stamps.dish||{}).length + …) > 0;
 *     It depends ONLY on whether stamps were supplied and non-empty. NOTHING brand-gates it. la_musa
 *     is uncertified because nothing stamps it, not because anything prevents it — so the day
 *     something does, (1) evaporates and this flag is the only thing still holding moves off. §9
 *     grandfathers la_musa with its SLUG AS ITS ID, so a move there is not a rename, it is an
 *     identity change.
 *
 * (3) And §10's own staging instruction: "flip identity_rename_enabled ON (P1b) AFTER THE COVERAGE
 *     WATCH IS CLEAN." A watch you cannot scope is a watch you cannot act on — a global flag makes the
 *     first rename in production every restaurant's first rename, simultaneously, with no way to
 *     enable one, observe it, and widen.
 *
 * 🔴 THE HISTORY IS KEPT BECAUSE THE MISTAKE IS INSTRUCTIVE. An earlier version of this note asserted
 * ONLY (1) — "la_musa is protected by certification, not by this flag" — replacing a durable reason
 * with a contingent one. That is the same failure as attributing a guarantee to the wrong mechanism,
 * which is how the destination guard sat believed-wired for four slices. A reason that is true only of
 * the current cohort must never be the sole reason recorded for a safety property.
 */
const FLAG_DOC = 'identity_flags';
const FLAG_FIELD = 'rename_enabled';

function flagRefOf(db, rid) {
  return db.collection('restaurants').doc(rid).collection('meta').doc(FLAG_DOC);
}

/* Returns true ONLY for an explicit boolean true. A missing document, a missing field, a string
   "true", a 1 — all off. A flag that turns on by accident is worse than one that will not turn on. */
async function renameEnabled(db, rid) {
  try {
    const snap = await flagRefOf(db, rid).get();
    return snap.exists && (snap.data() || {})[FLAG_FIELD] === true;
  } catch (e) {
    try { console.warn('renameEnabled: read failed — fail-safe OFF', JSON.stringify({ rid, error: (e && e.message) || String(e) })); } catch (_) {}
    return false;
  }
}

module.exports = { renameEnabled, flagRefOf, FLAG_DOC, FLAG_FIELD };
