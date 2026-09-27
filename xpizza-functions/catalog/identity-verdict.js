'use strict';
/* THE VERDICT REGISTRY — provenance for a permitting verdict, and immutability for the plan it carries.
 *
 * 🔴 WHY THIS FILE EXISTS. Three holes, all reproduced rather than argued, survived the first binding
 * fix. Removing the writer's separate `plan` parameter closed the MISMATCH between two arguments; it did
 * nothing about where the verdict came from:
 *
 *   1. SHAPE IS NOT PROVENANCE. `{ ok: true, lands: [], deletions: [], plan: {…} }` — a hand-built
 *      object literal with a plan attached — was accepted and wrote a retired row. The refusal added for
 *      the OLD literal only caught it because that literal had no `plan`; adding one reopened the door.
 *   2. A REFERENCE IS NOT A SNAPSHOT. Verify an empty plan, get a permitting verdict, then push a mint
 *      onto `plan.mints` and hand the same verdict over: the mint was written. "The plan it judged" was
 *      still whatever the caller made of it afterwards.
 *   3. A VERDICT SAID `ok` ABOUT WORK IT NEVER LOOKED AT. verifyPlan does not model `restores`, so a
 *      restores-only plan came back PERMITTED with empty lands and releases — an honest answer about
 *      the operations it can see — and the writer executed the restore. No forgery needed.
 *
 * SO: a verdict is only valid if it was ISSUED HERE, and the plan it carries is FROZEN when issued.
 *
 * 🔴 WHAT THE WeakSet BUYS AND WHAT IT DOES NOT. A caller cannot put its object into a set it holds no
 * reference to, so a literal assembled at a call site is refused by construction rather than by a shape
 * check that the next field can satisfy. It is NOT a capability system: any module may require this one
 * and call `issue`. That is deliberate and it is the honest boundary — the point is that authorising a
 * plan becomes an explicit, greppable act in a named file instead of an object literal that happens to
 * have the right keys. `grep -rn "require.*identity-verdict"` is the audit.
 *
 * WeakSet, not Set: a verdict must not be kept alive by having been issued.
 */

/* ═══ 🔴 THE THREAT MODEL, STATED, BECAUSE THE DEFENCE CANNOT BE COMPLETED AND SHOULD NOT BE ═══
 *
 * WHO IS THE ADVERSARY. `issueVerdict` has exactly two callers, both functions in this directory, both
 * building their verdict from data the transaction read out of Firestore. There is NO UNTRUSTED INPUT
 * anywhere on this path — no merchant, no request body, no third-party module.
 *
 * WHAT THIS DEFENDS AGAINST, and these are the mistakes that actually happened, twice each:
 *   · a caller that HAND-BUILDS a correctly-shaped verdict — the rollback path did exactly this, in
 *     production, and the writer executed it. Closed by the WeakSet: shape is not provenance.
 *   · a caller that keeps a reference to the plan and MUTATES IT after the verdict was issued, or pushes
 *     onto a field of the verdict itself. Closed by the deep snapshot: a reference is not a snapshot.
 * Both are careless-caller errors — the kind a person makes while wiring a second call site.
 *
 * 🔴 WHAT THIS DOES NOT DEFEND AGAINST, AND DELIBERATELY: a caller that overrides a built-in
 * (`deletions.map = () => [row]`), hides operations behind Symbol or non-enumerable keys, or manipulates
 * prototypes. Those are not mistakes; they are this module attacking itself. A caller willing to do any
 * of them DOES NOT NEED THE VERDICT AT ALL — it holds `tx` and can call `tx.delete` directly, which no
 * amount of freezing here would prevent.
 *
 * AND NOTHING ELSE IN THIS CODEBASE IS HARDENED AGAINST THAT, which is the consistency argument:
 * `verifyPlan` trusts the registry Map it is handed, `applyIdentityPlan` trusts `tx`, the partition law
 * trusts the stamps it reads. If a hostile module inside our own functions directory is the threat, the
 * identity registry is the least of the problems.
 *
 * 🔴 WHY THE BOUNDARY IS WRITTEN INSTEAD OF THE NEXT LAYER BUILT. Four rounds of hardening produced four
 * progressively more exotic bypasses. That is the signature of an UNBOUNDED problem, not of a list of
 * bugs — and a comment claiming "the verdict cannot be tampered with" would be exactly the
 * claim-stronger-than-the-code failure this slice has corrected a dozen times. A boundary stated is worth
 * more than a defence that cannot be finished. If the threat model ever changes — an untrusted caller, a
 * plugin, a verdict crossing a process boundary — THIS PARAGRAPH is what has to be revisited first, and
 * the answer then is probably a different mechanism than freezing, not more of it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════ */

/* Module-private. Not exported, not reachable, and that is the whole mechanism. */
const ISSUED = new WeakSet();

/* 🔴 ONE SURFACE, SNAPSHOTTED WHOLE — NOT A LIST OF FIELDS TO REMEMBER. The first version of this file
   snapshotted `plan` and froze the issued object SHALLOWLY, so `verdict.deletions` came through the
   spread BY REFERENCE and stayed mutable: a caller pushed one entry onto a genuine empty plan's verdict
   and the writer DELETED AN UNRELATED KEY ROW — the operation with no cheap recovery, on an
   authorisation nothing judged.
   Adding `deletions` to the snapshot would have fixed that hole and left the shape that produced it:
   a writer that executes fields of a verdict, an issuer that snapshots SOME of them, and a fifth field
   one day that passes every cell. So nothing is enumerated here. The ENTIRE verdict is deep-copied and
   deep-frozen, which removes the category "executable field outside the snapshot" instead of listing
   its members. The cell derives what to check FROM THE WRITER'S OWN SOURCE for the same reason — a
   hand-kept list is what let the CLI refusal census sit at 8 while 10 tools connected.

   🔴 AND AN UNEXPECTED TYPE REFUSES RATHER THAN PASSING THROUGH. A Map, Set, Date, class instance or
   function cannot be copied by this and would otherwise be shared by reference — the exact hole again,
   wearing a type nobody thought about. A verdict is plain data; anything else is a mistake worth a
   loud one. */
function deepSnapshot(value, path) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || typeof value === 'undefined') {
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((v, i) => deepSnapshot(v, `${path}[${i}]`)));
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepSnapshot(value[k], `${path}.${k}`);
    return Object.freeze(out);
  }
  throw new Error(`identity_verdict_unsnapshottable: ${path} is a ${Object.prototype.toString.call(value)}, which cannot be copied here and would be shared with the caller by reference — a verdict must be plain data`);
}

/* The plan's kind arrays are NORMALISED before snapshotting so every issued verdict has the three the
   writer reads, whatever the issuer passed. The freezing is deepSnapshot's job, not this one's. */
function normalisePlan(plan) {
  const out = {};
  for (const kind of ['moves', 'mints', 'retires', 'restores']) {
    if (Array.isArray(plan && plan[kind])) out[kind] = plan[kind];
  }
  for (const kind of ['moves', 'mints', 'retires']) if (!out[kind]) out[kind] = [];
  return out;
}

/* `judged` — WHICH OPERATION KINDS THIS VERDICT ACTUALLY LOOKED AT. Hole 3 is not that verifyPlan is
   wrong about restores; it is that its silence was read as permission. A verdict now SAYS what it
   judged and the writer refuses a kind the verdict does not claim, which turns "verifyPlan does not
   model restores" from a sentence in a comment into a refusal. */
const JUDGED_BY_VERIFY_PLAN = Object.freeze(['moves', 'mints', 'retires']);
const JUDGED_BY_RECONCILE = Object.freeze(['retires', 'restores']);

/* Issue a verdict: deep-copy and deep-freeze the WHOLE thing, record the object, hand it back. The
   caller must use the RETURNED object — the one that is registered and detached. */
function issueVerdict(verdict, { plan, judged }) {
  const issued = deepSnapshot({ ...verdict, plan: normalisePlan(plan), judged: [...judged] }, 'verdict');
  ISSUED.add(issued);
  return issued;
}

function wasIssued(verdict) {
  return !!verdict && typeof verdict === 'object' && ISSUED.has(verdict);
}

module.exports = { issueVerdict, wasIssued, JUDGED_BY_VERIFY_PLAN, JUDGED_BY_RECONCILE };
