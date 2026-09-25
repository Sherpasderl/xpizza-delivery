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
 * 🔴 PER-RESTAURANT, NOT GLOBAL — A DEVIATION FROM §7's "SINGLE FLAG", AND AGAIN NOT FOR THE REASON I
 * FIRST GAVE. I justified rid-scoping by saying a global switch would enable renames for la_musa.
 * IT WOULD NOT. la_musa is already excluded by CERTIFICATION: it is never certified (observed —
 * `certifiedCandidate:false` on every la_musa publish), the in-transaction block is never entered for
 * it, and no move is derived for it whatever this flag says. Claiming the flag protects la_musa puts a
 * guarantee on the wrong mechanism, which is how the destination guard came to be believed-wired for
 * four slices.
 * THE REASON THAT HOLDS, and it is §10's own: "later, flip identity_rename_enabled ON (P1b) AFTER THE
 * COVERAGE WATCH IS CLEAN." A watch you cannot scope is a watch you cannot act on. A global flag makes
 * the first rename in production every restaurant's first rename, simultaneously, with no way to
 * enable one, observe it, and widen. Rid-scoping is what makes §10's staging instruction EXECUTABLE —
 * a deviation from §7's literal wording in service of §10, not against it.
 *
 * So, precisely: la_musa is protected by certification. This flag exists for incremental rollout.
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
