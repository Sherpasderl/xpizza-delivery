'use strict';
/* reconcileOnRollback — what a rollback must do to the registry to make the TARGET true again.
 *
 * 🔴 THE TARGET IS THE PROVENANCE AUTHORITY, AND `consumed_deleted_ids` IS AUDIT ONLY. The target
 * version says "the object at key K carries stamp X" — an immutable, certified, server-owned record
 * of OWNERSHIP, reached through the key, which is the exact coordinate restoreIdentity requires.
 * `identity_activation.consumed_deleted_ids` says "an activation retired [X, Y, Z]" — a record of an
 * ACTION. It carries NO KEY, so it structurally cannot answer "which object did X belong to"; and the
 * retire half below was never performed by any activation, so no amount of reading that field
 * produces it. A field cannot be the input to a derivation whose second half it cannot describe.
 * (§4 says the field is "written one slice ahead of its READER". The reader arrived and does not need
 * it. Recorded as spec v7.7.)
 *
 * 🔴 WHY THE STAMP MAP NO LONGER JUDGES THIS. Its threat model is a DRAFT: ids round-trip through the
 * merchant's editor, so a merchant-controlled field could become server certification. A rollback
 * target is not a draft — its stamps are history that module already validated at publish time. Its
 * five registry-agreement refusals are states a rollback LEGITIMATELY produces, and after a deletion
 * one of them is guaranteed. See REGISTRY_AGREEMENT_REFUSALS in identity-stampmap.js.
 *
 * 🔴 AND THIS MAY PERMIT WHAT A PER-STAMP CHECK MUST REFUSE, WHICH IS THE WHOLE REASON IT EXISTS.
 * `stamp_registry_disagrees` — the target says K holds X, the registry says K holds Y — is THEFT if Y
 * survives the rollback, and is §5's delete→recreate→rollback if Y is released by this same rollback.
 * Per stamp those are identical. With the whole target in hand they are not. Same information, asked
 * in a place that can answer.
 *
 * PURE. Every input is data the caller read inside the transaction.
 */
const { STATUS_LIVE, encodeKey } = require('./identity-registry');

const isStr = (v) => typeof v === 'string' && v.length > 0;
const refuse = (code, detail) => ({ code, detail });

/* `targetStamps` : {legacyKey -> canonicalId} the ROLLBACK TARGET carries, for ONE kind.
   `ids`          : Map(id -> {legacy_key, status}) — the WHOLE registry for this kind, live AND retired.
   `keys`         : Map(encodedName -> {canonical_id}) — likewise whole.

   Returns { restores, retires, deletions, refusals }:
     restores  — (id, name) pairs the registry must assert again, whether the id row is retired,
                 missing, or claiming something else. Resurrection included: see the note on policy.
     retires   — live ids the target does not stamp anywhere. §5: "Y retired if absent from the target."
     deletions — key rows to remove because the id that owns them is being moved off or retired, each
                 conditioned on the row NAMING that id (identity-bootstrap.js:488's pattern).
     refusals  — states the whole-target view still cannot make coherent. Non-empty means refuse. */
function reconcileOnRollback({ targetStamps, ids, keys } = {}) {
  if (!(ids instanceof Map) || !(keys instanceof Map)) {
    throw new Error('identity_reconcile_registry_unread: reconciliation needs the registry index the transaction read; an unread registry is not an empty one');
  }
  const stamps = targetStamps && typeof targetStamps === 'object' ? targetStamps : {};
  const refusals = [];

  /* 🔴 THE TARGET IS CHECKED FOR COHERENCE FIRST, BEFORE THE REGISTRY IS CONSULTED. An immutable
     version stamping ONE id on TWO keys cannot be made true by any sequence of writes — and if the
     registry is consulted first, that same state surfaces as a confusing per-object disagreement
     rather than as what it is. This is verifyPlan's refusal 6 asked of the target instead of the plan. */
  const keyOfId = new Map();
  for (const [key, id] of Object.entries(stamps)) {
    if (!isStr(key) || !isStr(id)) {
      refusals.push(refuse('reconcile_target_malformed', `the target carries an unreadable stamp at ${JSON.stringify(key)}: ${JSON.stringify(id)}`));
      continue;
    }
    if (keyOfId.has(id)) {
      refusals.push(refuse('reconcile_target_forked', `${id} is stamped on BOTH ${JSON.stringify(keyOfId.get(id))} and ${JSON.stringify(key)} in the target; one identity cannot be restored to two names, and no write makes that version true`));
      continue;
    }
    keyOfId.set(id, key);
  }
  if (refusals.length) return { restores: [], retires: [], deletions: [], refusals };

  /* SURVIVES = the target stamps this id somewhere. It is the whole-target fact a per-stamp check
     cannot see, and it is what separates theft from a swap. */
  const survives = (id) => keyOfId.has(id);

  const restores = [];
  const released = [];          // (id, name) pairs whose key row this reconciliation gives up

  for (const [id, key] of keyOfId) {
    const row = ids.get(id);
    const encoded = encodeKey(key);
    const keyRow = keys.get(encoded);
    const claimant = keyRow && isStr(keyRow.canonical_id) ? keyRow.canonical_id : null;

    /* 🔴 THE DESTINATION IS NEVER CONTESTED, AND THAT IS A PROPERTY OF THE TARGET RATHER THAN LUCK —
       said here because I wrote a refusal for it first and the sweep showed nothing could reach it.
       A live id Y holding K while the target says X holds it is the `stamp_registry_disagrees` state.
       Y is either stamped by the target somewhere — restored to ITS name, releasing K — or not
       stamped at all, in which case §5 retires it below for being absent, also releasing K. The only
       remaining shape would be Y surviving AT THIS SAME KEY, and the target cannot express that: it
       maps K to exactly one id, and we are iterating the pair where that id is X. So a refusal branch
       here is unreachable by construction, and a branch no fixture can distinguish is a branch that
       should not exist. THE WHOLE-TARGET VIEW DOES NOT MERELY HELP TELL THEFT FROM A SWAP — IT
       DISSOLVES THE CONFLICT, which is the sharper form of why these five refusals moved. */

    /* Nothing to do: the registry already says exactly what the target says. The commonest case by
       far, and it must write NOTHING — an ordinary rollback of an unchanged menu is not a registry
       operation. */
    if (row && row.status === STATUS_LIVE && row.legacy_key === key && claimant === id) continue;

    /* 🔴 EVERYTHING ELSE IS A RESTORE, INCLUDING RESURRECTING A RETIRED ID — AND THAT IS THE OPPOSITE
       OF WHAT THE STANDALONE PRIMITIVE DOES, DELIBERATELY. `restoreIdentity` refuses a retired landing
       id (`identity_restore_id_retired`) and is right to: it has NO PLAN and NO FENCE over a rollback
       target, so a certified-active version stamping a retired id is a contradiction it must surface.
       THIS caller has the plan, knows the target legitimately predates the retirement, and
       resurrection is the DECLARED INTENT rather than an inference. Same provenance predicate,
       different policy, because the callers know different things — said here so nobody "fixes" one
       to match the other. */
    if (row && row.legacy_key !== key && isStr(row.legacy_key)) {
      released.push({ id, name: row.legacy_key });     // the id is coming back from another name
    }
    restores.push({ id, name: key,
      was: row ? row.status : 'absent',
      resurrects: !!row && row.status !== STATUS_LIVE });
  }
  if (refusals.length) return { restores: [], retires: [], deletions: [], refusals };

  /* §5: "Y retired if absent from the target." 🔴 ONLY MEANINGFUL BECAUSE THE CALLER HAS ALREADY
     ESTABLISHED THE TARGET IS CERTIFIED. An UNCERTIFIED target has no stamps, so every live id would
     be "absent" and this would retire the entire registry — see the gate in catalog-publish.js and
     its cell. This function is never called for one; that is the caller's contract, and it is the
     reason this loop can be this simple. */
  const retires = [];
  for (const [id, row] of ids) {
    if (!row || row.status !== STATUS_LIVE) continue;
    if (survives(id)) continue;
    retires.push({ id, name: row.legacy_key });
    if (isStr(row.legacy_key)) released.push({ id, name: row.legacy_key });
  }

  /* 🔴 EVERY DELETION IS CONDITIONED ON THE ROW NAMING THE ID GIVING IT UP (identity-bootstrap.js:488),
     and a name this same reconciliation RE-LANDS is not a deletion at all — otherwise a swap deletes
     two rows it is about to re-create and survives only on write order. Same rule as verifyPlan's
     refusal 5, applied to the rollback plan. */
  const landing = new Set(restores.map((r) => encodeKey(r.name)));
  const deletions = [];
  for (const r of released) {
    const encoded = encodeKey(r.name);
    if (landing.has(encoded)) continue;
    const keyRow = keys.get(encoded);
    if (!keyRow) continue;                                   // nothing to delete; the sweep's territory
    /* 🔴 NEVER DELETE A ROW THAT NAMES SOMEONE ELSE (identity-bootstrap.js:488). Carried as defence
       in depth and it has NO MUTANT, because I could not construct a case where it is the thing that
       decides: a released name whose row belongs to another id is either skipped by the re-landing
       check above, or that id is itself releasing the name and the deletion is queued as its own.
       Stated rather than armed — an assertion invented to justify a branch is worse than an honest
       note, and this is the third such branch this slice has found. */
    if (keyRow.canonical_id !== r.id) continue;
    deletions.push({ name: r.name, encoded, id: r.id });
  }

  return { restores, retires, deletions, refusals: [] };
}

module.exports = { reconcileOnRollback };
