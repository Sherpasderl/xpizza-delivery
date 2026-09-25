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
 * emulator. By having no reads at all, this cannot be the thing that breaks the ordering, and every
 * document it writes was read by the caller BEFORE it was called — rule 17, enforced by the database
 * rather than by review.
 *
 * It is handed the plan AND the verifier's verdict, and writes only what the verdict resolved.
 */
const { STATUS_LIVE, STATUS_RETIRED, encodeKey, idsColOf, keysColOf } = require('./identity-registry');

/* `plan`     : {moves, mints, retires} as derivePlan produced and verifyPlan permitted.
   `verified` : verifyPlan's PERMITTING verdict for that plan — its `deletions` are what get deleted.
   `existing` : Map(id -> row) the caller already read, so a move/retire PRESERVES the row's other
                fields instead of replacing the document. */
function applyIdentityPlan(tx, { db, rid, kind, plan, verified, existing, now } = {}) {
  if (!tx || typeof tx.set !== 'function' || typeof tx.delete !== 'function') {
    throw new Error('identity_writer_no_transaction: the atomic writer only writes inside the activation transaction');
  }
  /* 🔴 THE VERDICT IS REQUIRED, NOT THE PLAN ALONE. Accepting a bare plan would let a caller skip
     verification and still reach the writes — the shape where a guard exists, passes its cells, and
     protects nothing because one path does not go through it. There is no "write it anyway" door. */
  if (!verified || verified.ok !== true || !Array.isArray(verified.deletions)) {
    throw new Error(`identity_writer_unverified: the plan must carry verifyPlan's PERMITTING verdict; got ${JSON.stringify(verified && verified.code)}`);
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
