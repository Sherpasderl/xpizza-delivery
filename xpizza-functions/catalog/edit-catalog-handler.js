'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2b-1 Task 3 — editCatalog: validate → CAS draft write → diff → token. NO publish.
//
// The handler body lives here rather than in index.js so it can be tested: index.js cannot be imported
// without Firebase initialisation, and an untested money-adjacent handler is a handler nobody has read
// carefully. index.js keeps only the thin onRequest wrapper.
//
// Two properties define it, and both are about what it must NOT do.
//
//   IT MUST NOT CLOBBER. Two people editing one menu is the ordinary case. The concurrency check is a
//   server-evaluated PRECONDITION on the write, not a read-then-compare — those are indistinguishable
//   except when a save lands BETWEEN the read and the write, which is exactly when the difference is a
//   lost edit. Firestore evaluates `lastUpdateTime` atomically at commit; we never decide freshness
//   ourselves.
//
//   IT MUST NOT PUBLISH. It writes `meta/source` and nothing else. It READS `meta/active_version` —
//   the diff has to be against the live version — but never moves it. A save is not a price change.
// ---------------------------------------------------------------------------
const { validateSource, sourceRefOf, canonicalize } = require('./source-store');
const { persistDeletionClaim } = require('./identity-partition');
const { getActivePointer } = require('./catalog-firestore');

// The wire form of a Firestore commit time: seconds and nanoseconds, losslessly. Used for both the
// value returned to the caller and the precondition it later presents, so the two are the same thing.
// MOVED to source-store.js beside sourceRefOf — the pointer-flip CAS compares draft revisions too,
// and two spellings of "which draft is this" is a comparison that agrees until someone edits one.
// Re-exported here so every existing importer is unchanged.
const { encodeUpdateTime } = require('./source-store');
const { catalogDiff, issueEditToken, sha256 } = require('./catalog-edit');

const reply = (status, body) => ({ status, body });

// Firestore signals a failed precondition with code 9 (FAILED_PRECONDITION). Matched on the code, with
// a message fallback for stubs and older surfaces — misreading it as a generic error would turn a
// prevented clobber into a 500 and hide the reason from the editor.
const isPreconditionFailure = (e) =>
  !!e && (e.code === 9 || e.code === 'failed-precondition' || /FAILED_PRECONDITION|precondition/i.test(String(e.message || '')));

// `baseSourceUpdateTime` travels over HTTP as a string but must reconstruct to the EXACT Firestore
// Timestamp, nanoseconds included — a lossy round trip (an ISO string, say) yields a precondition that
// can never match, so every conditional write fails and no edit is ever saveable. The encoding lives
// with the Firestore code that produces it; the default is identity, for stubs that deal in opaque
// strings. This is deliberately injected rather than imported: the core stays free of firebase-admin.
async function editCatalogCore({ db, authorize, readActiveBuilt, toPrecondition = (v) => v }, body, req) {
  const rid = body && body.restaurantId;

  // AUTH FIRST — before any read. Its typed status/error pass through verbatim so the caller can tell
  // "log in" from "not your restaurant" from "try again"; flattening them into one code would make an
  // outage look like a permissions problem.
  const auth = await authorize(rid, req);
  if (!auth || !auth.ok) return reply((auth && auth.status) || 403, { error: (auth && auth.error) || 'not_authorized' });

  const source = body && body.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return reply(400, { error: 'bad_source', detail: 'source must be an object' });

  // A missing base is NOT a licence to write unconditionally. Without it there is nothing to make the
  // write conditional ON, so the only safe answer is to refuse.
  const base = body && body.baseSourceUpdateTime;
  if (typeof base !== 'string' || !base) return reply(400, { error: 'bad_request', detail: 'baseSourceUpdateTime is required (the write is conditional on it)' });

  // VALIDATE BEFORE WRITING. The 2a validator is the structural gate — mis-keyed extras, dangling
  // categories, non-positive or float prices, key/item non-bijection, inline-price disagreement — and
  // it names the offending field. A draft that fails it is never stored, so a broken draft cannot sit
  // in the store waiting for someone to publish it.
  try {
    validateSource(source, rid);
  } catch (e) {
    return reply(400, { error: 'invalid_source', detail: String((e && e.message) || e).slice(0, 400) });
  }

  const ref = sourceRefOf(db, rid);
  let snap;
  try {
    snap = await ref.get();
  } catch (e) {
    return reply(503, { error: 'store_unavailable', retryable: true });
  }
  if (!snap || !snap.exists) return reply(409, { error: 'source_missing', detail: 'no draft to edit — seed the store first' });

  // The whole-object write. update() carries the precondition; set() cannot. Every top-level field the
  // stored doc has but the new source does not is explicitly cleared, so an update is a REPLACEMENT
  // rather than a merge — a stale field left behind would be content nobody authored and nobody saw.
  const next = canonicalize(source);

  /* ── 1D D4-P1 — THE DELETION CLAIM IS SERVER-OWNED, AND THE REPLACEMENT ABOVE WOULD EAT IT ──────
     🔴 TWO THINGS GO WRONG IF THIS IS LEFT TO THE CLIENT, and they pull in opposite directions.
     The write below is a REPLACEMENT: every top-level field the stored doc has and the incoming source
     lacks is explicitly NULLED. So an ordinary save that does not re-send `deleted_ids` does not merely
     fail to persist it — it actively DELETES the merchant's standing deletion claim. And the obvious
     fix, having the client echo the claim back on every save, hands the client control of the very
     binding that exists to stop a replay.
     So the server owns it end to end: the declared IDS come from the request (deletion is the
     merchant's call — it must be declared, never inferred), while the BASE is written here from the
     live pointer and any client-supplied base is discarded unread. persistDeletionClaim decides
     whether this is a fresh claim, an ordinary edit on a still-live base, a withdrawal, or a rebind
     that needs the merchant to have been re-shown the list. */
  const storedClaim = ((snap.data && snap.data()) || {}).deleted_ids || null;

  /* 🔴 ABSENT IS NOT EMPTY, AND CONFLATING THEM WITHDRAWS DELETIONS NOBODY WITHDREW. A save whose
     source does not mention `deleted_ids` at all is an ordinary content edit and must PRESERVE the
     standing claim; a save that explicitly sends `{ids: []}` is the merchant withdrawing it. Reading
     both as "no ids declared" makes every unrelated edit silently cancel the merchant's deletions —
     the same absent-versus-declared distinction the partition law exists to enforce, one layer down.
     hasOwnProperty, not truthiness, because `{ids: []}` is falsy in every way that matters here. */
  const declared = Object.prototype.hasOwnProperty.call(next, 'deleted_ids');
  const declaredIds = (next.deleted_ids && typeof next.deleted_ids === 'object' && !Array.isArray(next.deleted_ids))
    ? next.deleted_ids.ids
    : next.deleted_ids;
  delete next.deleted_ids;                    // whatever the client sent is not what gets stored

  if (!declared) {
    /* Carried forward VERBATIM — not re-stamped. Re-stamping here would be the silent rebind by
       another route: an ordinary edit would quietly re-bless a claim against a newer baseline. */
    if (storedClaim) next.deleted_ids = storedClaim;
  } else {
  let claimResult;
  try {
    /* The live pair, read as ONE snapshot so version and generation cannot tear. It is read here,
       immediately before the conditional write, rather than reused from anything earlier. */
    const live = await getActivePointer(db, rid);
    claimResult = persistDeletionClaim({
      existing: storedClaim,
      ids: declaredIds,
      live: { version: live.version, generation: live.generation },
      reviewed: body && body.deleted_ids_reviewed === true,
    });
  } catch (e) {
    if (e && e.code) {
      /* A refused claim must not take the merchant's content edit with it — but it must not save
         silently either, because the draft they are looking at shows the deletion. Refuse the whole
         save and tell the editor what to re-show. */
      return reply(409, { error: e.code, detail: e.detail || String(e.message || e), existing_ids: e.existing_ids });
    }
    return reply(503, { error: 'store_unavailable', retryable: true });
  }
  if (claimResult.claim) next.deleted_ids = claimResult.claim;
  }

  const stale = Object.keys((snap.data && snap.data()) || {}).filter((k) => !Object.prototype.hasOwnProperty.call(next, k));
  const payload = { ...next };
  for (const k of stale) payload[k] = null;   // cleared; the source schema is closed, so this is normally empty

  let writeTime;
  try {
    const res = await ref.update(payload, { lastUpdateTime: toPrecondition(base) });
    writeTime = (res && (res.writeTime || res.updateTime)) || null;
    if (writeTime && typeof writeTime === 'object') writeTime = encodeUpdateTime(writeTime);
  } catch (e) {
    if (isPreconditionFailure(e)) {
      // Someone else saved. Their draft stands; this edit is refused rather than merged or overwritten.
      return reply(409, { error: 'stale_edit', detail: 'the draft changed since you loaded it — reload and re-apply your edit' });
    }
    return reply(503, { error: 'store_unavailable', retryable: true });
  }

  // Everything below is read-only. The draft is already saved, so a failure here costs the caller their
  // token (they can re-request a diff), never their edit.
  let live, baseActiveVersionId;
  try {
    ({ built: live, versionId: baseActiveVersionId } = await readActiveBuilt(rid));
  } catch (e) {
    return reply(503, { error: 'live_version_unavailable', retryable: true, updateTime: writeTime });
  }

  const { sourceToBuildInputs } = require('./source-store');
  const { buildCatalogV2 } = require('./form-menu-source');
  let draftBuilt;
  try {
    const inputs = sourceToBuildInputs(source);
    draftBuilt = { ...buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable }), extras: inputs.extras };
  } catch (e) {
    return reply(500, { error: 'draft_build_failed', detail: String((e && e.message) || e).slice(0, 200), updateTime: writeTime });
  }

  const diff = catalogDiff(live, draftBuilt);
  const sourceHash = sha256(source);
  // Bound to the POST-write updateTime, deliberately. Binding the pre-write one would let a publish land
  // against a draft that had already moved on.
  const token = issueEditToken({ rid, baseActiveVersionId, sourceUpdateTime: writeTime, sourceHash, diff });

  console.log('catalog_edit_saved', JSON.stringify({
    rid, actor: auth.actor || auth.uid, role: auth.role, updateTime: writeTime,
    counts: { added: diff.added.length, removed: diff.removed.length, renamed: diff.renamed.length, changed: diff.changed.length, large: diff.largeChangeSet.length },
  }));
  return reply(200, { updateTime: writeTime, baseActiveVersionId, sourceHash, diff, token });
}

module.exports = { editCatalogCore, isPreconditionFailure, encodeUpdateTime };
