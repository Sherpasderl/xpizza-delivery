'use strict';
/* applyIdentityPlan — the ATOMIC WRITER. It writes resolved registry rows inside the activation's own
 * transaction, and it performs NO READS.
 *
 * 🔴 IT MUST NOT CALL ensureIdentity OR retireIdentity. Both open their OWN transactions
 * (identity-registry.js), so calling them here would split the activation across several commits: the
 * pointer could move with half the registry written, which is the one thing atomic activation exists
 * to prevent. §4 says so by name. That is also why this file duplicates a little of their row shape
 * rather than reusing them.
 *
 * 🔴 AND IT READS NOTHING, WHICH IS THE ORDERING DISCIPLINE MADE STRUCTURAL. Firestore refuses a read
 * after a write inside a transaction — observed, not assumed: test/tx-read-after-write.emulator.test.js
 * records the exact refusal ("Firestore transactions require all reads to be executed before all
 * writes"). A writer that took a read would therefore break the caller's first write, loudly, in the
 * emulator. By having no reads at all, this cannot be the thing that breaks the ordering.
 *
 * 🔴 BUT THE DATABASE ENFORCES ORDER, NOT COMPLETENESS, and this header used to claim the stronger
 * thing ("every document it writes was read by the caller BEFORE it was called — rule 17, enforced by
 * the database rather than by review"). Firestore refuses a read AFTER a write; nothing in it checks
 * that the caller read everything this writes. That comes from the CALLER'S QUERIES — the flip reads all
 * four registry collections whole — and it is reviewed, not enforced. Rule 17's table
 * (tools/registry-writers.js) is where that read is named per writer, and the table is the enforcement.
 *
 * It is handed a verdict that CARRIES the plan it judged — there is no separate plan argument — and it
 * writes only operations of a kind that verdict claims to have judged.
 */
const { STATUS_LIVE, STATUS_RETIRED, encodeKey, idsColOf, keysColOf } = require('./identity-registry');
const { wasIssued } = require('./identity-verdict');

/* `verified` : a PERMITTING verdict that CARRIES THE PLAN IT JUDGED — `verifyPlan`'s for an activation,
                `reconcileOnRollback`'s `.verdict` for a rollback. The plan is read from it; there is no
                separate `plan` argument, by design (see the guard below).
   `existing` : Map(id -> row) the caller already read, so a move/retire PRESERVES the row's other
                fields instead of replacing the document. */
function applyIdentityPlan(tx, { db, rid, kind, verified, existing, now } = {}) {
  if (!tx || typeof tx.set !== 'function' || typeof tx.delete !== 'function') {
    throw new Error('identity_writer_no_transaction: the atomic writer only writes inside the activation transaction');
  }
  /* 🔴 THE PLAN COMES OUT OF THE VERDICT. IT IS NOT A SEPARATE ARGUMENT, AND THAT IS THE FIX.
     This used to take `plan` and `verified` side by side and check only that the verdict was SHAPED like
     a permitting one. Nothing tied the two together, so a permitting verdict for one plan authorised the
     writing of ANOTHER: codex passed a genuinely verified EMPTY plan's verdict alongside an unverified
     retirement and this writer created the retired row. The comment that stood here claimed "there is no
     'write it anyway' door" — and named the exact failure class it did not close, which is worse than
     saying nothing, because a reader checks the comment, sees the concern was considered, and stops.
     Taking the plan from the verdict makes the mismatch INEXPRESSIBLE rather than checked. A fingerprint
     compared here was the weaker alternative: it detects a mistake instead of preventing it. */
  if (!verified || verified.ok !== true || !Array.isArray(verified.deletions)) {
    throw new Error(`identity_writer_unverified: the plan must carry a PERMITTING verdict; got ${JSON.stringify(verified && verified.code)}`);
  }
  /* 🔴 PROVENANCE, NOT SHAPE. The previous version refused the exact literal the rollback call site used
     to build — and ADDING A `plan` FIELD TO IT REOPENED THE DOOR: `{ok:true, lands:[], deletions:[],
     plan:{retires:[…]}}` was accepted and wrote a retired row. A shape check can always be satisfied by
     supplying the next field. So the verdict must have been ISSUED by verifyPlan or reconcileOnRollback,
     recorded in a WeakSet neither a call site nor a test fixture can reach. */
  if (!wasIssued(verified)) {
    throw new Error('identity_writer_verdict_not_issued: this verdict was not issued by verifyPlan or reconcileOnRollback — a correctly-shaped object is not a verification');
  }
  /* 🔴 KEPT, AND UNREACHABLE FROM OUTSIDE TODAY — the premise written down rather than the branch left
     to look guarded. `issueVerdict` is the only way into the WeakSet above, and `normalisePlan` ALWAYS
     yields moves/mints/retires arrays, so no issued verdict can lack them and an unissued one is refused
     one line up. A mutation-sweep mutant for this branch therefore SURVIVES by construction, and the
     mutant was REMOVED rather than left failing or given a cell that cannot exist.
     It stays because it is the second line if a future issuer builds verdicts differently, and because
     the arming run showed it catching the no-plan literal the moment provenance was taken out.
     🔴 THE EXPIRY CONDITION, sharpened by the gate and worth stating precisely: A THIRD CALLER ALONE
     CANNOT INVALIDATE THE PREMISE. Every caller must go through `issueVerdict` to be accepted at all, so
     adding one changes nothing here. What would is a change to THE ISSUER OR TO `normalisePlan`'s
     guarantee that the three kind arrays always exist. That is the edit which should bring a cell back —
     not the arrival of another call site, which is what I first wrote and which would have expired this
     branch for the wrong reason. */
  const plan = verified.plan;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.moves) || !Array.isArray(plan.mints) || !Array.isArray(plan.retires)) {
    throw new Error('identity_writer_verdict_carries_no_plan: the verdict must carry the plan it judged — a verdict without one cannot be bound to what is about to be written');
  }
  /* 🔴 AND ONLY THE KINDS THE VERDICT CLAIMS TO HAVE JUDGED. This is the hole that needed no forgery at
     all: verifyPlan does not model `restores`, so a restores-only plan came back PERMITTED — a truthful
     answer about the operations it can see — and this writer executed the restore anyway. A verifier's
     SILENCE about an operation is not permission for it. `judged` makes the limitation a refusal instead
     of a comment: verifyPlan judges moves/mints/retires, reconcileOnRollback judges retires/restores. */
  const judged = Array.isArray(verified.judged) ? verified.judged : [];
  for (const kind of ['moves', 'mints', 'retires', 'restores']) {
    const rows = plan[kind];
    if (Array.isArray(rows) && rows.length && !judged.includes(kind)) {
      throw new Error(`identity_writer_kind_unjudged: the plan carries ${rows.length} ${kind} but its verdict judged only [${judged.join(', ')}] — the verifier never looked at this operation, and silence is not permission`);
    }
  }
  const rows = existing instanceof Map ? existing : new Map();
  const stamp = now || new Date().toISOString();
  const ids = idsColOf(db, rid, kind);
  const keys = keysColOf(db, rid, kind);
  const preserve = (id) => rows.get(id) || {};

  /* 🔴 A LANDED NAME IS NEVER ALSO DELETED, AND THAT IS RE-ESTABLISHED HERE RATHER THAN TRUSTED.
     verifyPlan already excludes a name this same plan re-lands from its deletion list — that is what
     makes a two-object swap delete nothing. If that ever stopped being true, Firestore applies a
     transaction's writes in order and the last one wins, so the outcome would depend on the order of
     the loops below: a key row silently missing, or silently present, according to nothing anyone
     chose. Cheap to check, and a wrong answer here is unrecoverable. */
  /* 🔴 RESTORED NAMES COUNT AS LANDED. A reconciliation that restores X to K and releases K from a
     retired claimant would otherwise queue K for deletion AND write it, and which survives depends on
     loop order. Same rule as the swap: a name this plan lands is never a name this plan deletes. */
  const landed = new Set(verified.lands.map((l) => encodeKey(l.name))
    .concat((plan.restores || []).map((r) => encodeKey(r.name))));
  for (const d of verified.deletions) {
    if (landed.has(d.encoded)) {
      throw new Error(`identity_writer_delete_lands: ${rid}/${kind}/${d.name} is both deleted and landed by one plan; the result would depend on write order`);
    }
  }

  let writes = 0;

  /* MOVES — both planes, in one transaction. The id row keeps everything it had (created_at, kind,
     whatever a later slice adds) and changes only its name: tx.set is a full replace, so a bare
     object here would destroy fields, the same mechanism that once dropped `generation` from the
     pointer write. */
  for (const m of plan.moves) {
    tx.set(ids.doc(m.id), { ...preserve(m.id), legacy_key: m.to, kind, status: STATUS_LIVE, moved_at: stamp });
    tx.set(keys.doc(encodeKey(m.to)), { canonical_id: m.id, kind, created_at: stamp });
    writes += 2;
  }

  /* RESTORES — the ROLLBACK operation, and structurally a move and a mint at once: assert (id, name)
     in BOTH planes, preserving whatever the id row already had.
     🔴 IT RESURRECTS A RETIRED ID, WHICH IS THE OPPOSITE OF WHAT retireIdentity AND restoreIdentity
     ALLOW — see the policy note in identity-reconcile.js. The standalone primitive has no plan and no
     fence over a rollback target, so a certified-active version stamping a retired id is a
     contradiction it must surface; this path has the plan and resurrection is the declared intent.
     `restored_at` is added rather than `retired_at` removed: the row keeps the history of having been
     retired, which is what tells a later reader this id has been round the loop. */
  for (const r of plan.restores || []) {
    const prior = preserve(r.id);
    tx.set(ids.doc(r.id), { ...prior, legacy_key: r.name, kind, status: STATUS_LIVE,
      created_at: prior.created_at || stamp, restored_at: stamp });
    tx.set(keys.doc(encodeKey(r.name)), { canonical_id: r.id, kind, created_at: stamp });
    writes += 2;
  }

  /* MINTS — a fresh identity: both rows, created together. */
  for (const m of plan.mints) {
    tx.set(ids.doc(m.id), { legacy_key: m.name, status: STATUS_LIVE, created_at: stamp, kind });
    tx.set(keys.doc(encodeKey(m.name)), { canonical_id: m.id, kind, created_at: stamp });
    writes += 2;
  }

  /* RETIRES — 🔴 THE ID ROW IS KEPT, MARKED. Deleting it would FREE the id, and a freed id handed to
     a new object makes every old record — an order snapshot, a factura line, a support ticket —
     resolve to a dish nobody meant. The reservation is the whole point and it is permanent. */
  for (const r of plan.retires) {
    tx.set(ids.doc(r.id), { ...preserve(r.id), legacy_key: r.name, kind, status: STATUS_RETIRED, retired_at: stamp });
    writes += 1;
  }

  /* DELETIONS — only what the verifier resolved, each already checked to NAME the id releasing it
     (refusal 5). This is the only place in an activation that deletes anything. */
  for (const d of verified.deletions) {
    tx.delete(keys.doc(d.encoded));
    writes += 1;
  }

  return { writes, moved: plan.moves.length, minted: plan.mints.length, retired: plan.retires.length,
    restored: (plan.restores || []).length, deleted: verified.deletions.length };
}

module.exports = { applyIdentityPlan };
