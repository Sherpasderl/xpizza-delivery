'use strict';
/* The generation fence: re-read the active pointer INSIDE a transaction and refuse if it moved
 * since the caller decided.
 *
 * 🔴 THE PAIR IS CAPTURED BY THE CALLER, NEVER BY THE WRITER. A fence exists to detect a move
 * between the DECISION and the WRITE. A writer that re-reads the pair itself is comparing a value it
 * captured AFTER the decision was made, so it cannot see a move that happened before it was called —
 * that is not a fence, it is a tautology that always passes. The caller captures {version,
 * generation} AS A PAIR at the moment it decides, and this re-reads in-transaction and compares.
 *
 * 🔴 THE BASELINE IS REQUIRED AND THIS FAILS CLOSED WITHOUT IT. `writeVersion` accepted a `stamps`
 * map that nothing ever supplied, and that unfed parameter hid a production lockout for four slices.
 * An optional baseline here would repeat it exactly: every call would pass, the fence would protect
 * nothing, and the cells would still be green. So a missing, malformed or half-present baseline is an
 * ERROR AT THE FIRST CALL rather than a silent default four slices later.
 *
 * 🔴 BOTH HALVES, ALWAYS. The version and the generation are two reads that can tear, which is why
 * they are carried as a pair; comparing only one re-opens the gap the pair exists to close.
 *
 * Extracted from identity-bootstrap.js's retireOrphanFenced, which already did this correctly — a
 * reference implementation to MATCH rather than a spec to interpret. Its call site now delegates
 * here and its refusal text is unchanged, which is what makes the extraction checkable.
 */
const { activePointerRef, readPointerSnap } = require('./catalog-firestore');

/* A usable baseline names a version and carries an integer generation. `null` version is the pre-P1
   shape and is NOT a baseline you can fence against: it means nobody has established one, so a
   caller offering it is asking this to compare against nothing. */
function baselineOf(captured, rid, code) {
  /* 🔴 DERIVED FIRST, THEN REFUSED — never guarded-then-indexed. Written as
     `if (!captured) throw; … captured.versionId`, the refusal and the use are coupled by ORDER:
     remove the guard and the next line throws a TypeError. A crash is not a decision, and a harness
     that reads a nonzero exit as "the check noticed" would score this property as guarded by a stack
     trace. Reading through an empty object instead means every bad shape reaches an ordinary refusal
     below. */
  const c = captured && typeof captured === 'object' ? captured : {};
  if (c !== captured) {
    throw new Error(`${code}_no_baseline: ${rid} — the fence was called with no captured {version, generation} at all (${JSON.stringify(captured)}); the caller must capture the pair when it DECIDES, or there is nothing to fence against`);
  }
  /* Both spellings are accepted because the tree carries both: identity-bootstrap's `active` names it
     `versionId`, while readPointerSnap returns `version`. Accepting either is not laxity — it is the
     same value under the two names already in use, and normalising here keeps callers from
     reshaping a pair in transit, which is how a pair stops being a pair. */
  const version = c.versionId !== undefined ? c.versionId : c.version;
  const generation = c.generation;
  if (typeof version !== 'string' || !version) {
    throw new Error(`${code}_no_baseline: ${rid} — the captured baseline names no version (${JSON.stringify(version)}); a fence against an unnamed version cannot refuse anything`);
  }
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error(`${code}_no_baseline: ${rid} — the captured baseline carries no usable generation (${JSON.stringify(generation)}); half a pair is not a baseline`);
  }
  return { version, generation };
}

/* Re-read the pointer in the transaction and compare against what the caller captured.
 *
 *   tx       the transaction whose reads must see the same snapshot as the write
 *   db       used only to build the pointer ref
 *   rid      restaurant id, brand-agnostic — there is no per-brand branch here and must not be one
 *   captured the caller's {version|versionId, generation} pair
 *   code     the refusal prefix, so each call site keeps the error its operators already know
 */
async function assertPointerUnmoved(tx, { db, rid, captured, code }) {
  if (!tx || typeof tx.get !== 'function') {
    throw new Error(`${code || 'identity_fence'}_not_a_transaction: ${rid} — the fence must read INSIDE the transaction that writes, or what it checked can change before the write lands`);
  }
  if (typeof code !== 'string' || !code) {
    throw new Error(`identity_fence_no_code: ${rid} — every call site names its own refusal, so an operator sees which fence refused`);
  }
  const base = baselineOf(captured, rid, code);
  const live = readPointerSnap(await tx.get(activePointerRef(db, rid)), rid);
  if (live.version !== base.version || live.generation !== base.generation) {
    throw new Error(`${code}: ${rid} — judged against ${base.version}@${base.generation}, now ${JSON.stringify(live.version)}@${live.generation}`);
  }
  return live;
}

module.exports = { assertPointerUnmoved, baselineOf };
