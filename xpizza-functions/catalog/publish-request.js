'use strict';
// PLAN-portal-team-invites r1 §2 G3 — «Enviar al dueño para publicar». On a platform-factura brand a manager with the
// per-manager «Puede editar el menú y los precios» permission edits and saves a draft, but every publish needs the OWNER's
// fiscal acknowledgement. This module records the manager's REQUEST that the owner review that exact draft. It is a note,
// never an authorization: the owner then uses the unchanged publish path (diff, large-change ack, owner fiscal ack).
//
// WHO (codex plan r1 P1-1): the resolved FACTS at the rid — a manager grant AND manager_menu, not the brand's owner, on a
// usesPlatformFactura rid. catalog.publish alone is never enough (dispatchers / kitchen staff hold it).
// STORAGE + SERIALIZATION (P1-2): ONE Firestore doc restaurants/{rid}/meta/publish_request beside meta/source and
// meta/active_version (firestore.rules deny every unenumerated meta/* doc). The edit token is verified exactly as
// publishEditedCore verifies it, then ONE transaction re-reads the draft + the pointer and writes the slot only if both
// are still what the token was verified against. FRESHNESS is derived at read time (requestState), so the publish / reset
// paths stay byte-identical: a slot that names an older draft or pointer can never read as fresh. ABA: the slot also binds the
// pointer's MONOTONIC generation (every flip — publish or rollback — bumps it), so a flip-back to the same version id after
// a publish never makes an old request fresh again.
const { validateSource, sourceRefOf, encodeUpdateTime, canonicalize } = require('./source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { catalogDiff, verifyEditToken, sha256 } = require('./catalog-edit');
const { activePointerRef, readPointerSnap, getActivePointer } = require('./catalog-firestore');
const { usesPlatformFactura } = require('../factura/eligibility');
const { resolveAccess, refuseContext } = require('../access/membership');

const MAX_AGE_MS = 14 * 24 * 3600 * 1000;   // an older request is ignored (never shown)
const requestRefOf = (fs, rid) => fs.collection('restaurants').doc(rid).collection('meta').doc('publish_request');
const reply = (status, body) => ({ status, body });
const STALE = 'publish_request_stale';

// → { status, body }. deps: { fs, db, now, readActiveBuilt(rid), readDraft(rid) }; ctx = the VERIFIED caller { uid, token }.
async function requestPublishCore(deps, ctx, body) {
  const { fs, db, now = () => Date.now(), readActiveBuilt, readDraft } = deps;
  const refused = refuseContext(ctx); if (refused) return reply(403, { error: 'forbidden' });
  const rid = body && body.restaurantId;
  const token = body && body.token;
  if (typeof rid !== 'string' || !rid) return reply(400, { error: 'bad_request' });
  if (typeof token !== 'string' || !token) return reply(400, { error: 'bad_request', detail: 'token is required' });
  let a;
  try { a = await resolveAccess({ db }, ctx, rid); } catch (_) { return reply(503, { error: 'unavailable' }); }
  if (!a || !a.ok) return a && a.code === 'unavailable' ? reply(503, { error: 'unavailable' }) : reply(403, { error: 'forbidden' });
  const f = a.facts || {};
  if (f.owner === true) return reply(409, { error: 'not_applicable', detail: 'the owner publishes directly' });
  if (!usesPlatformFactura(rid)) return reply(409, { error: 'not_applicable', detail: 'this brand publishes without the owner' });
  if (!(f.manager === true && f.manager_menu === true && a.state === 'member')) return reply(403, { error: 'forbidden' });

  // the SAME freshness check publishEditedCore runs (token bound to base active version + draft revision + hash + diff)
  let live, baseActiveVersionId, draft, sourceUpdateTime;
  try {
    const [activeRes, draftRes] = await Promise.all([readActiveBuilt(rid), readDraft(rid)]);
    ({ built: live, versionId: baseActiveVersionId } = activeRes);
    ({ source: draft, updateTime: sourceUpdateTime } = draftRes);
  } catch (_) { return reply(503, { error: 'store_unavailable', retryable: true }); }
  if (!draft || typeof draft !== 'object') return reply(409, { error: 'source_missing' });
  try { validateSource(draft, rid); } catch (e) { return reply(400, { error: 'invalid_source' }); }
  let diff, sameStructure;
  try {
    const { inputs, built } = buildSourceCandidate(rid, draft);
    diff = catalogDiff(live, { ...built, extras: inputs.extras });
    sameStructure = JSON.stringify(canonicalize(built.structure || null)) === JSON.stringify(canonicalize((live && live.structure) || null));
  } catch (_) { return reply(500, { error: 'draft_build_failed' }); }
  const sourceHash = sha256(draft);
  const v = verifyEditToken(token, { rid, baseActiveVersionId, sourceUpdateTime, sourceHash, diff });
  if (!v.ok) return reply(409, { error: 'edit_superseded', reason: v.reason });
  // NOTHING TO PUBLISH (codex plan r2 P1-1): a request exists only while draft ≠ active. Getting back to equality then
  // needs a source change (a new updateTime) or an activation (a new generation), and either retires the request, so a
  // no-op reset (Firestore keeps the updateTime of an unchanged document) can never resurrect one.
  if (!diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.changed.length && sameStructure) {
    return reply(409, { error: 'nothing_to_publish' });
  }

  // the sender's display name from the SERVER profile written at invite acceptance (codex build r1 P2) — never the token
  let name = null;
  try { const p = (await db.ref(`brand_members/${a.brandId}/profiles/${ctx.uid}`).once('value')).val(); name = p && typeof p.name === 'string' ? p.name : null; }
  catch (_) { return reply(503, { error: 'unavailable' }); }
  const slot = {
    by: ctx.uid, name, at: now(),
    base_active_version: baseActiveVersionId, base_generation: null, source_update_time: sourceUpdateTime, source_hash: sourceHash,
    counts: { changed: diff.changed.length, added: diff.added.length, removed: diff.removed.length, large: diff.largeChangeSet.length },
  };
  try {
    await fs.runTransaction(async (tx) => {
      const [s, p] = await Promise.all([tx.get(sourceRefOf(fs, rid)), tx.get(activePointerRef(fs, rid))]);
      const ut = s && s.exists && s.updateTime ? encodeUpdateTime(s.updateTime) : null;
      const { version, generation } = readPointerSnap(p, rid);
      if (ut !== sourceUpdateTime || version !== baseActiveVersionId) throw new Error(STALE);   // moved since the verify
      tx.set(requestRefOf(fs, rid), { ...slot, base_generation: generation });
    });
  } catch (e) {
    if (e && e.message === STALE) return reply(409, { error: 'edit_superseded', reason: 'raced' });
    return reply(503, { error: 'store_unavailable', retryable: true });
  }
  return reply(200, { ok: true, counts: slot.counts });
}

// The slot's state against the CURRENT draft + pointer (pure): fresh | draft_changed | published | null (none / too old / bad).
function requestState(slot, { sourceUpdateTime, sourceHash, activeVersionId, generation, now }) {
  if (!slot || typeof slot !== 'object' || typeof slot.at !== 'number' || !(now - slot.at <= MAX_AGE_MS)) return null;
  // any flip since (publish OR rollback, the generation is monotonic) → done, whatever the draft did afterwards
  if (slot.base_active_version !== activeVersionId || slot.base_generation !== generation) return 'published';
  if (slot.source_update_time !== sourceUpdateTime || slot.source_hash !== sourceHash) return 'draft_changed';
  return 'fresh';
}

// What the OWNER's editor receives (getEditableCatalog): only fresh / draft_changed; never for anyone else.
async function readRequestForOwner(fs, rid, current) {
  const snap = await requestRefOf(fs, rid).get();
  const slot = snap && snap.exists ? snap.data() : null;
  if (!slot) return null;
  const { version, generation } = await getActivePointer(fs, rid);   // the CURRENT pointer + its monotonic generation
  const state = requestState(slot, { ...current, activeVersionId: version, generation });
  if (state !== 'fresh' && state !== 'draft_changed') return null;
  const c = slot.counts || {};
  return { state, by_name: typeof slot.name === 'string' ? slot.name : null, at: slot.at,
    counts: { changed: c.changed | 0, added: c.added | 0, removed: c.removed | 0, large: c.large | 0 } };
}

// The two reads the token is bound to, from a Firestore handle — the same shapes portal/functions.js gives publishEditedCore
// (readActiveBuiltForEdit / readDraftForEdit), so the verify above is the publish's verify.
async function readActiveBuiltFrom(fs, rid) {
  const { previewVersion } = require('./catalog-publish');
  const { readVersionDocs, getActiveVersionId } = require('./catalog-firestore');
  const { buildTablesFromDocs } = require('./catalog-transform');
  const versionId = await getActiveVersionId(fs, rid);
  if (versionId == null) throw new Error(`no_active_version: ${rid}`);
  const [preview, docs] = await Promise.all([previewVersion(fs, rid, versionId), readVersionDocs(fs, rid, versionId)]);
  const { extras } = buildTablesFromDocs(docs.itemDocs, docs.extraDocs);
  return { built: { items: preview.items, structure: preview.structure, extras }, versionId, extraRecords: preview.extras };
}
async function readDraftFrom(fs, rid) {
  const snap = await sourceRefOf(fs, rid).get();
  if (!snap.exists) return { source: null, updateTime: null };
  return { source: snap.data(), updateTime: snap.updateTime ? encodeUpdateTime(snap.updateTime) : null };
}

module.exports = { requestPublishCore, requestState, readRequestForOwner, requestRefOf, readActiveBuiltFrom, readDraftFrom, MAX_AGE_MS };
