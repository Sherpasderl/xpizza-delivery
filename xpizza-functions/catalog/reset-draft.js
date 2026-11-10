'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A §0.1 — resetDraftToLive: "Volver al menú publicado".
//
// The recovery for a saved draft that cannot publish (a structural drift, an unbuildable draft, an addition the
// owner no longer wants after a rollback). It reconstructs the EDITABLE SOURCE from the ACTIVE catalog — the
// very projection publish validates before every flip (candidateSource over the read-back version: items with
// their identity stamps, extras in extra_order, the structure incl. item_order and categories) — and REPLACES the
// saved draft with it, conditional on the revision the owner saw. The standing D4-P1 deletion claim is cleared
// (stored as the null sentinel): going back to what is published withdraws it.
//
// Owner-only. Writes ONE document (meta/source), under CAS. Never moves the pointer, never touches the registry.
// Distinct from the portal's "Descartar", which only throws away unsaved browser edits.
// ---------------------------------------------------------------------------
const { validateSource, sourceRefOf, canonicalize, encodeUpdateTime } = require('./source-store');
const { candidateSource } = require('./candidate-validate');
const { isPreconditionFailure } = require('./edit-catalog-handler');
const PS = require('../photos/photo-state');   // DISH PHOTOS A2: the three-state vocabulary (pure)

const { can } = require('../access/membership');   // PLAN-portal-membership r3 §3.2 — the ONE capability table
const reply = (status, body) => ({ status, body });

async function resetDraftToLiveCore({ db, authorize, readActiveVersionId, previewVersion, toPrecondition = (v) => v, readActivePhotos = null, attach = null }, body, req) {
  const rid = body && body.restaurantId;
  const auth = await authorize(rid, req);
  if (!auth || !auth.ok) return reply((auth && auth.status) || 403, { error: (auth && auth.error) || 'not_authorized' });
  if (!can(auth, 'catalog.reset_draft')) return reply(403, { error: 'not_owner', detail: 'only the restaurant owner can reset the draft' });
  const expected = body && body.expectedRevision;
  if (typeof expected !== 'string' || !expected) return reply(400, { error: 'bad_request', detail: 'expectedRevision is required (the reset is conditional on it)' });

  let versionId, preview;
  try {
    versionId = await readActiveVersionId(db, rid);
    if (versionId == null) return reply(409, { error: 'no_active_version', detail: 'nothing is published yet — there is no menu to go back to' });
    preview = await previewVersion(db, rid, versionId);
  } catch (e) {
    return reply(503, { error: 'live_version_unavailable', retryable: true });
  }
  // DISH PHOTOS A2 step 11 (§2.1): the draft photo map comes back from the ACTIVE version's meta/photos (pid / removed; legacy = absent).
  // Without the dependency, or with no photo doc on the active version, nothing is added (a stale draft map is cleared below).
  let photoMap = null;
  if (readActivePhotos) {
    try { photoMap = PS.resetMapFromActive(await readActivePhotos(rid, versionId)); } catch (e) { return reply(503, { error: 'live_version_unavailable', retryable: true }); }
  }

  const projected = canonicalize({ ...candidateSource(rid, { items: preview.items, extras: preview.extras, structure: preview.structure, key_mode: preview.record && preview.record.key_mode, frozen_keys: preview.record && preview.record.frozen_keys }), deleted_ids: null, ...(photoMap ? { photos: photoMap } : {}) });
  try {
    validateSource(projected, rid);
  } catch (e) {
    // The active version passed this exact validation before it was flipped live; failing now is a contradiction.
    return reply(500, { error: 'projection_invalid', detail: String((e && e.message) || e).slice(0, 200) });
  }

  /* codex r1 P1-3 — the restored pids go through the SAME fenced attach editCatalog uses (registry draft|published + last_ref_at bump,
     one transaction) BEFORE the CAS below: a concurrent publish + prune + sweep can no longer delete a photo this reset is about to
     reference. A pid already deleting/deleted refuses (the owner re-uploads); an attach I/O failure fails closed. */
  if (attach && photoMap) {
    const pids = PS.referencedPids(photoMap);
    if (pids.length) {
      let a;
      try { a = await attach(rid, pids); } catch (e) { return reply(503, { error: 'store_unavailable', retryable: true }); }
      if (!a || a.ok !== true) return reply(409, { error: 'photo_unavailable', detail: 'a published photo is no longer available — publish again or upload it again' });
    }
  }

  const ref = sourceRefOf(db, rid);
  let snap;
  try { snap = await ref.get(); } catch (e) { return reply(503, { error: 'store_unavailable', retryable: true }); }
  if (!snap || !snap.exists) return reply(409, { error: 'source_missing' });
  const payload = { ...projected };
  const storedFk = ((snap.data && snap.data()) || {}).frozen_keys; const keepFk = !!storedFk && typeof storedFk === 'object' && !Array.isArray(storedFk); for (const k of Object.keys((snap.data && snap.data()) || {})) if (!Object.prototype.hasOwnProperty.call(projected, k) && k !== 'key_mode' && !(k === 'frozen_keys' && keepFk)) payload[k] = null; if (keepFk) payload.frozen_keys = { ...storedFk, ...(projected.frozen_keys || {}) };   // S0: a version with no recorded mode leaves the stored mode in place; S1a: recorded renames are never dropped (stored ∪ version)

  let writeTime;
  try {
    const res = await ref.update(payload, { lastUpdateTime: toPrecondition(expected) });
    writeTime = (res && (res.writeTime || res.updateTime)) || null;
    if (writeTime && typeof writeTime === 'object') writeTime = encodeUpdateTime(writeTime);
  } catch (e) {
    if (isPreconditionFailure(e)) return reply(409, { error: 'stale_edit', detail: 'the draft changed since you loaded it — reload and try again' });
    return reply(503, { error: 'store_unavailable', retryable: true });
  }
  console.log('catalog_draft_reset', JSON.stringify({ rid, actor: auth.actor || auth.uid, to: versionId, updateTime: writeTime }));
  return reply(200, { source: projected, sourceUpdateTime: writeTime, activeVersionId: versionId });
}

module.exports = { resetDraftToLiveCore };
