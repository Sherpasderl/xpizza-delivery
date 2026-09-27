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

/* Module-private. Not exported, not reachable, and that is the whole mechanism. */
const ISSUED = new WeakSet();

/* 🔴 FREEZE DEEPLY ENOUGH THAT THE ARRAYS CANNOT BE PUSHED TO. `Object.freeze(plan)` alone leaves
   `plan.mints.push(...)` working, which is exactly hole 2 — the plan object was never the thing being
   mutated, its arrays were. Entries are frozen too: a caller holding one could otherwise repoint an id
   after the verdict was issued. */
function deepFreezePlan(plan) {
  for (const kind of ['moves', 'mints', 'retires', 'restores']) {
    const rows = plan[kind];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (row && typeof row === 'object') Object.freeze(row);
    Object.freeze(rows);
  }
  return Object.freeze(plan);
}

/* A FROZEN COPY, NOT THE CALLER'S OBJECT. Freezing the plan in place would make the verifier mutate
   what it was asked to judge — identity-plan.test.js asserts it does not, and that assertion is worth
   more than saving a shallow copy. Copying also gives the stronger property: the verdict's plan is
   immune to anything done to the original afterwards, which is what hole 2 actually requires. */
function snapshotPlan(plan) {
  const out = {};
  for (const kind of ['moves', 'mints', 'retires', 'restores']) {
    if (Array.isArray(plan && plan[kind])) out[kind] = plan[kind].map((r) => (r && typeof r === 'object' ? { ...r } : r));
  }
  for (const kind of ['moves', 'mints', 'retires']) if (!out[kind]) out[kind] = [];
  return deepFreezePlan(out);
}

/* `judged` — WHICH OPERATION KINDS THIS VERDICT ACTUALLY LOOKED AT. Hole 3 is not that verifyPlan is
   wrong about restores; it is that its silence was read as permission. A verdict now SAYS what it
   judged and the writer refuses a kind the verdict does not claim, which turns "verifyPlan does not
   model restores" from a sentence in a comment into a refusal. */
const JUDGED_BY_VERIFY_PLAN = Object.freeze(['moves', 'mints', 'retires']);
const JUDGED_BY_RECONCILE = Object.freeze(['retires', 'restores']);

/* Issue a verdict: snapshot+freeze its plan, record the object, hand it back. The caller must use the
   RETURNED object — the one that is registered. */
function issueVerdict(verdict, { plan, judged }) {
  const issued = { ...verdict, plan: snapshotPlan(plan), judged: Object.freeze([...judged]) };
  Object.freeze(issued);
  ISSUED.add(issued);
  return issued;
}

function wasIssued(verdict) {
  return !!verdict && typeof verdict === 'object' && ISSUED.has(verdict);
}

module.exports = { issueVerdict, wasIssued, JUDGED_BY_VERIFY_PLAN, JUDGED_BY_RECONCILE };
