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
const AP = require('./add-product');
const { rendererContract, sourceToBuildInputs } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');

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
// An add-product refusal, typed and field-mapped for the portal.
const refusal = (e) => reply(e.status || 400, { error: e.code, detail: e.detail, ...(e.field ? { field: e.field } : {}), ...(e.key ? { key: e.key } : {}), ...(e.ref ? { ref: e.ref } : {}) });

async function editCatalogCore({ db, authorize, readActiveBuilt, toPrecondition = (v) => v, addProduct = null }, body, req) {
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

  /* ── 1D add-product A §1 — THE ACTIVE CATALOG IS READ FIRST ────────────────────────────────────────
     Every save is now checked against what is SERVING before anything is written: the draft is built with
     the same builder publish uses, validated, and structurally compared (ADD-ONLY: existing items, extras
     and structure may change only in price; new plain products may be appended; the D4-P1 deletion claim
     is honoured). A draft that cannot pass is never stored, so it can never be saved again and poison every
     later publish. (Declared permitted difference: this read used to follow the write.) */
  let liveRes;
  try {
    liveRes = await readActiveBuilt(rid);
  } catch (e) {
    return reply(503, { error: 'live_version_unavailable', retryable: true });
  }
  const live = liveRes.built;
  const baseActiveVersionId = liveRes.versionId;
  const activeKeys = new Set((live.items || []).map((it) => it && it.key));
  const isAddition = (it) => !(it && typeof it === 'object' && typeof it.key === 'string' && activeKeys.has(it.key)
    && !Object.prototype.hasOwnProperty.call(it, 'ref'));
  const hasAdditions = Array.isArray(source.items) && source.items.some(isAddition);
  // OWNER-ONLY for any draft that adds products (§1); price-only drafts keep today's tiers.
  if (hasAdditions && auth.role !== 'owner') {
    return reply(403, { error: 'not_owner', detail: 'only the restaurant owner can add products' });
  }

  const ref = sourceRefOf(db, rid);
  let snap;
  try {
    snap = await ref.get();
  } catch (e) {
    return reply(503, { error: 'store_unavailable', retryable: true });
  }
  if (!snap || !snap.exists) return reply(409, { error: 'source_missing', detail: 'no draft to edit — seed the store first' });
  const stored = (snap.data && snap.data()) || {};

  // SERVER ALLOCATION (§2): tmp references become keys/ids here, once; the high-water mark advances in the
  // same commit as the draft below.
  let candidate = canonicalize(source);
  let hwmPlan = null;
  if (hasAdditions) {
    if (!addProduct) return reply(503, { error: 'add_product_unavailable', retryable: false });
    try {
      const keyMode = AP.resolveKeyMode(await addProduct.readKeyMode(rid), live.items);
      const hwmRef = addProduct.hwmRef(rid);
      const hwmSnap = await hwmRef.get();
      const hwmVal = hwmSnap.exists ? (hwmSnap.data() || {}).value : null;
      const prospective = (candidate.items || [])
        .filter((it) => it && typeof it === 'object' && Object.prototype.hasOwnProperty.call(it, 'ref') && it.display && typeof it.display.name === 'string')
        .map((it) => (keyMode === 'name' ? AP.tidyName(it.display.name) : AP.slugify(it.display.name)))
        .filter(Boolean);
      const taken = prospective.length ? await addProduct.registryKeysTaken(rid, prospective) : new Set();
      const res = AP.allocateAdditions({ incoming: candidate, stored, activeItems: live.items, keyMode,
        hwm: Number.isInteger(hwmVal) ? hwmVal : null, registryHasKey: (k) => taken.has(k) });
      candidate = res.source;
      if (res.allocatedNow.length) hwmPlan = { ref: hwmRef, snap: hwmSnap, value: res.hwm };
    } catch (e) {
      if (e instanceof AP.AddProductError) return refusal(e);
      return reply(503, { error: 'store_unavailable', retryable: true });
    }
  }

  // VALIDATE BEFORE WRITING. The 2a validator is the structural gate — mis-keyed extras, dangling
  // categories, non-positive or float prices, key/item non-bijection, inline-price disagreement — and
  // it names the offending field. A draft that fails it is never stored, so a broken draft cannot sit
  // in the store waiting for someone to publish it.
  try {
    validateSource(candidate, rid);
  } catch (e) {
    return reply(400, { error: 'invalid_source', detail: String((e && e.message) || e).slice(0, 400) });
  }
  // …and BUILD it with publish's builder: a draft the builder cannot carry is refused here, never stored.
  let draftBuilt, draftExtraRecords;
  try {
    const inputs = sourceToBuildInputs(candidate);
    const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
    draftBuilt = { ...built, extras: inputs.extras };
    draftExtraRecords = built.extras;
  } catch (e) {
    return reply(400, { error: 'draft_unbuildable', detail: String((e && e.message) || e).slice(0, 200) });
  }

  // The whole-object write. update() carries the precondition; set() cannot. Every top-level field the
  // stored doc has but the new source does not is explicitly cleared, so an update is a REPLACEMENT
  // rather than a merge — a stale field left behind would be content nobody authored and nobody saw.
  const next = candidate;

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
  /* 🔴 THE CLEARED SENTINEL IS NOT A DECLARATION. A withdrawn or consumed claim is stored as a
     top-level null, and the editor loads and echoes the whole source — so a perfectly ordinary edit
     arrives carrying `deleted_ids: null`. That is "there are no deletions", exactly like absent, and
     it must not reach the claim machinery, where null is (correctly) malformed. This is the one
     null-is-a-sentinel exemption, and it belongs here at the boundary rather than inside the
     validators, which is why they treat null as the client error it otherwise is. */
  const declared = Object.prototype.hasOwnProperty.call(next, 'deleted_ids') && next.deleted_ids !== null;
  const declaredIds = (next.deleted_ids && typeof next.deleted_ids === 'object' && !Array.isArray(next.deleted_ids))
    ? next.deleted_ids.ids
    : next.deleted_ids;
  delete next.deleted_ids;                    // whatever the client sent is not what gets stored

  /* ── 🔴 EVERY DECLARED ID MUST BE A NON-EMPTY STRING, CHECKED BEFORE ANYTHING COMPARES THEM ──────
     THE DEFECT: the echo test below used `[...a].map(String)`, so a NESTED ARRAY stringified into a
     match. With stored ids `['X']`, a merchant request carrying `{ids:[['X']]}` returned 200 through the
     authenticated API, was classified an ECHO, preserved the claim verbatim, and REQUIRED NO LOADED BASE
     — skipping the guard whose entire purpose is that a merchant's deletion is judged against what they
     actually saw. A validation gate opened by a string coercion.
     🔴 AND THE FIX IS NOT A BETTER COMPARISON. Making `sameSet` structure-aware would stop THIS
     stringification and leave the shape that produced it: ids of unknown type flowing into a comparison,
     into storage, and into the loaded-base decision. The ids are strings — `encodeKey`'d registry ids —
     so anything else is malformed and must REFUSE here, once, before any of those three uses. That also
     answers half of the validator's own gap (members were never checked), and it refuses UNIQUENESS for
     the same reason: `['X','X']` is not a set, and a claim whose length disagrees with its content makes
     every count downstream a guess.
     Refused as 400 rather than coerced or dropped: a merchant's deletion list is not something to guess at. */
  /* 🔴 `deleted_ids: {}` IS MALFORMED, NOT ABSENT. An OBJECT that carries no `ids` is a claim the server
     cannot read; only an omitted key or an explicit null means "I am not talking about deletions". It used
     to fall through as `undefined` ids and CLEAR the merchant's standing claim with a 200. */
  if (declared && declaredIds === undefined) {
    return reply(400, { error: 'deleted_ids_malformed',
      detail: 'deleted_ids was sent as an object with no `ids` — omit the key entirely to say nothing about deletions; an object that carries no ids is unreadable, not empty' });
  }
  if (declaredIds !== undefined && declaredIds !== null && !Array.isArray(declaredIds)) {
    return reply(400, { error: 'deleted_ids_malformed', detail: 'deleted_ids.ids must be an array' });
  }
  if (Array.isArray(declaredIds)) {
    const bad = declaredIds.findIndex((id) => typeof id !== 'string' || !id);
    if (bad !== -1) {
      return reply(400, { error: 'deleted_ids_malformed',
        detail: `deleted_ids.ids[${bad}] is ${JSON.stringify(declaredIds[bad])}; every id must be a non-empty string — a value that merely STRINGIFIES to one would be read as an echo and skip the loaded-base guard` });
    }
    if (new Set(declaredIds).size !== declaredIds.length) {
      return reply(400, { error: 'deleted_ids_malformed',
        detail: 'deleted_ids.ids contains duplicates; a claim whose length disagrees with its content makes every count downstream a guess' });
    }
  }

  /* 🔴 AN ECHO IS NOT A CHANGE, AND THE REAL EDITOR ALWAYS ECHOES. The portal loads the whole source
     and clones it (editor.js createDraft), so a save sends BACK the server-owned claim it was handed —
     which means "the client did not mention deleted_ids" is very nearly unreachable in practice, and
     treating every echo as a declaration would demand a loaded base on every ordinary price edit made
     while a deletion stands. That is friction on the common path, and friction on the common path is
     how a guard gets removed.
     So the comparison is against the STORED ids, by value: the same set is an echo and is preserved
     verbatim (base included, so echoing cannot re-stamp and cannot become the silent rebind); a
     DIFFERENT set is the merchant actually changing what they are deleting. */
  const storedIds = (storedClaim && Array.isArray(storedClaim.ids)) ? storedClaim.ids : null;
  const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && [...a].map(String).sort().join('\u0000') === [...b].map(String).sort().join('\u0000');
  /* 🔴 AN ACKNOWLEDGED RESEND IS A DECLARATION, NEVER AN ECHO — AND THIS WAS A DEAD END.
     The documented recovery from a stale claim is: get deleted_ids_stale_baseline, re-show the
     merchant existing_ids, resend the SAME ids with deleted_ids_reviewed. Those ids are by definition
     identical to the stored ones, so the echo test classified the recovery as "nothing changed",
     preserved the claim verbatim with its OLD base, and returned 200. The merchant saw success, the
     claim stayed stale, publishing refused forever, and their only exit was withdrawing every
     deletion — the echo optimisation, meant to keep ordinary editing frictionless, had closed the one
     door out. The ack is what separates "the editor is echoing state back at us" from "the merchant
     looked at this list again and means it", so it must defeat the echo. */
  const acked = !!(body && body.deleted_ids_reviewed === true);
  const isEcho = declared && storedIds && sameSet(declaredIds, storedIds) && !acked;

  if (!declared || isEcho) {
    /* Carried forward VERBATIM — not re-stamped. Re-stamping here would be the silent rebind by
       another route: an ordinary edit would quietly re-bless a claim against a newer baseline. */
    if (storedClaim) next.deleted_ids = storedClaim;
  } else {
  let claimResult;
  try {
    /* The live pair, read as ONE snapshot so version and generation cannot tear. It is read here,
       immediately before the conditional write, rather than reused from anything earlier. */
    const live = await getActivePointer(db, rid);

    /* 🔴 THE LOADED-BASE GUARD — what the merchant SAW, not merely what is live when they save.
       The server writes the base (C-1), but writing it from a fresh read alone leaves a real
       false-accept: if an activation lands between the merchant loading their draft and saving it,
       the server stamps a baseline they never saw, and at publish it validates cleanly. A transaction
       does not close that — atomicity ties the stamp to the WRITE, not to what was reviewed.
       So a save that CHANGES the claim must carry the active version/generation the editor loaded and
       displayed, and it is refused when that no longer matches live. The client value is a GUARD and
       never a source: on equality the server still stamps its own read. This is the same shape as the
       flip's expected.activeVersionId CAS, applied at declaration time, and it is scoped to exactly
       the thing it protects — a save that does not touch the claim needs none of it.
       Per §0 it does not prove a human looked; it establishes that the editor declared against the
       menu that is live, which is the accidental-staleness case the binding exists for.
       NB the pointer read is not transactional with the write. With this guard that direction fails
       SAFE: if live moves after the read, the stamp is the older pair the merchant genuinely reviewed
       against, and publish refuses it as stale. The unsafe direction — stamping something NEWER than
       the merchant saw — is what the guard closes. */
    /* 🔴 WITHDRAWING IS DELIBERATELY NOT "A CHANGE" HERE, AND I ALMOST BROKE THAT. The gate says F2:
       `{ids: []}` clears a standing claim with no loaded base and a 200. I changed this to "does the
       declared set DIFFER from the stored one" — and a cell named WITHDRAWING EVERY DELETION IS ALWAYS
       ALLOWED refused, because withdrawal is the merchant's ESCAPE from a stale claim. Demanding the
       loaded base to withdraw would trap anyone whose baseline had moved: the same "the optimisation had
       closed the one door out" failure the echo note above describes, in the other direction.
       So the test stays "are there ids to bind". What WAS a real defect in the same finding is
       `deleted_ids: {}` — an object carrying no ids, which is unreadable rather than empty — and that is
       refused above. Two cases, one finding, and only one of them was a defect. */
    const changesClaim = Array.isArray(declaredIds) ? declaredIds.length > 0 : !!declaredIds;
    if (changesClaim) {
      const loaded = body && body.deleted_ids_loaded_base;
      if (!loaded || typeof loaded !== 'object' || typeof loaded.version !== 'string' || !loaded.version
          || !Number.isInteger(loaded.generation) || loaded.generation < 0) {
        return reply(409, { error: 'deleted_ids_unbound',
          detail: 'a save that changes the deletion claim must send deleted_ids_loaded_base {version, generation} — the baseline the merchant reviewed the deletion against' });
      }
      if (loaded.version !== live.version || loaded.generation !== live.generation) {
        return reply(409, { error: 'deleted_ids_base_moved',
          detail: `the deletion was reviewed against ${loaded.version}@${loaded.generation} but ${live.version}@${live.generation} is live; reload and re-review`,
          loaded_base: `${loaded.version}@${loaded.generation}`, live: `${live.version}@${live.generation}` });
      }
    }

    claimResult = persistDeletionClaim({
      existing: storedClaim,
      ids: declaredIds,
      live: { version: live.version, generation: live.generation },
      reviewed: acked,
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

  /* THE STRUCTURAL COMPARISON (§1), after the deletion claim is settled so it can honour it (advisor ruling A:
     ADD-ONLY for portal-authored changes; the pre-existing D4-P1 server-owned deletion claim is preserved). */
  try {
    AP.assertSameAuthoredFields(next.structure, stored.structure);
    AP.compareToActive({
      draftBuilt: { items: draftBuilt.items, extras: draftExtraRecords, structure: draftBuilt.structure },
      activeBuilt: { items: live.items, extras: liveRes.extraRecords, structure: live.structure },
      draftAuthored: Object.keys(next.structure || {}),
      renderedCategories: rendererContract(rid).renderedCategories,
      deletedIds: next.deleted_ids && Array.isArray(next.deleted_ids.ids) ? next.deleted_ids.ids : [],
    });
  } catch (e) {
    if (e instanceof AP.AddProductError) return refusal(e);
    return reply(500, { error: 'structural_check_failed', detail: String((e && e.message) || e).slice(0, 200) });
  }

  const stale = Object.keys((snap.data && snap.data()) || {}).filter((k) => !Object.prototype.hasOwnProperty.call(next, k));
  const payload = { ...next };
  for (const k of stale) payload[k] = null;   // cleared; the source schema is closed, so this is normally empty

  let writeTime;
  try {
    let res;
    if (hwmPlan) {
      /* The draft and the high-water mark commit TOGETHER, each conditional: the draft on the revision the
         merchant loaded, the mark on the version read above (or create-only when it has never existed). A
         concurrent save loses on one of the two preconditions, never half-commits. */
      const batch = db.batch();
      batch.update(ref, payload, { lastUpdateTime: toPrecondition(base) });
      if (hwmPlan.snap.exists) batch.update(hwmPlan.ref, { value: hwmPlan.value }, { lastUpdateTime: hwmPlan.snap.updateTime });
      else batch.create(hwmPlan.ref, { value: hwmPlan.value });
      const results = await batch.commit();
      res = results && results[0];
    } else {
      res = await ref.update(payload, { lastUpdateTime: toPrecondition(base) });
    }
    writeTime = (res && (res.writeTime || res.updateTime)) || null;
    if (writeTime && typeof writeTime === 'object') writeTime = encodeUpdateTime(writeTime);
  } catch (e) {
    if (isPreconditionFailure(e) || (hwmPlan && (e && (e.code === 6 || e.code === 'already-exists')))) {
      // Someone else saved. Their draft stands; this edit is refused rather than merged or overwritten.
      return reply(409, { error: 'stale_edit', detail: 'the draft changed since you loaded it — reload and re-apply your edit' });
    }
    return reply(503, { error: 'store_unavailable', retryable: true });
  }

  // Everything below is read-only and in memory: the live catalog and the built draft were read and built
  // BEFORE the write (above).
  const diff = catalogDiff(live, draftBuilt);
  /* 🔴 THE TOKEN MUST HASH WHAT PUBLISH WILL HASH, AND THAT IS THE STORED DRAFT — NOT THE BODY.
     This hashed the incoming `source`, and publish hashes the draft it reads BACK. Those agreed only
     while the two were the same bytes, which stopped being true the moment the server began owning a
     field: the stored payload carries the server-stamped, preserved or withdrawn deletion claim, and
     any null-cleared stale fields. So a save would succeed and the follow-up publish would fail
     token_mismatch → edit_superseded, which means ANY ordinary edit made while a deletion claim
     stands could never be published — the merchant sees "reload and review again" forever, with
     nothing to reload that would help.
     Hashing `payload` through the same function publish uses makes the two agree by construction
     rather than by the two expressions happening to coincide. */
  const sourceHash = sha256(payload);
  // Bound to the POST-write updateTime, deliberately. Binding the pre-write one would let a publish land
  // against a draft that had already moved on.
  const token = issueEditToken({ rid, baseActiveVersionId, sourceUpdateTime: writeTime, sourceHash, diff });

  console.log('catalog_edit_saved', JSON.stringify({
    rid, actor: auth.actor || auth.uid, role: auth.role, updateTime: writeTime,
    counts: { added: diff.added.length, removed: diff.removed.length, renamed: diff.renamed.length, changed: diff.changed.length, large: diff.largeChangeSet.length },
  }));
  // 1D add-product A §3: the CANONICAL saved source comes back, so the portal adopts server truth (allocated
  // keys and ids, canonical order) before it builds the review.
  return reply(200, { updateTime: writeTime, baseActiveVersionId, sourceHash, diff, token, source: next });
}

module.exports = { editCatalogCore, isPreconditionFailure, encodeUpdateTime };
