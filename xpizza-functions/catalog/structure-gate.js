'use strict';
// S2-core (Codex build r1 P1-2 / P2-6) — the ONE current-state judgment of a draft on its way out: the owner publish
// (publish-edited-handler, after its own compareToActive) and the manager request (publish-request, which has no other) run it against
// the CURRENT live version, before anything is written:
//   1. the typed switch refusal: an Extras-page change while extrasCatalog is OFF is extras_catalog_not_supported_yet (409)
//   2. (request only — the publish runs its own) compareToActive with today's switches: accounting, claims, the reviewed deletion claim
//   3. every new extra through the ONE validator (catalog/extras-validate.js), with the restaurant's key mode and reserved keys
//   4. the caps, the byte budgets and the derived-maps claim (catalog/structure-budget.js)
// Throws AddProductError (the callers map it); a key-mode / reserved read failure is { unavailable: true } → 503.
const AP = require('./add-product');

async function judge({ rid, draft, draftRecords, live, liveExtraRecords, addProduct, compare = false, photos = null }) {
  const extrasCatalog = require('./platform-structure').structureCapabilities().extrasCatalog;
  const active = { items: live.items, extras: liveExtraRecords || [], structure: live.structure };
  if (!extrasCatalog && require('./review-diff').s2OpPresent({ live: active, liveExtraRecords: active.extras, draftBuilt: draftRecords, draftExtraRecords: draftRecords.extras })) {
    throw new AP.AddProductError('extras_catalog_not_supported_yet', 'the Extras page is not available yet', { field: 'extras', status: 409 });
  }
  if (require('./extra-identity').extraIdentityCapabilities().mintExtras) { const np = require('./frozen-extra-keys').renameNameProblems(draft, liveExtraRecords || [])[0]; if (np) throw new AP.AddProductError(np.error, `the option name cannot be used (${np.error})`, { key: np.key, field: np.field }); } if (compare) {   // S2b §1.3 (Codex S2b r1 P1-4): the name rules on the FULL candidate, new keys or not
    require('./choice-compare').compareToActive(rid, {
      draftBuilt: { ...draftRecords, ...(photos ? { photos: photos.draft } : {}) }, activeBuilt: { ...active, ...(photos ? { photos: photos.active } : {}) },
      draftAuthored: Object.keys(draft.structure || {}), renderedCategories: require('./source-store').rendererContract(rid).renderedCategories,
      deletedIds: draft.deleted_ids && Array.isArray(draft.deleted_ids.ids) ? draft.deleted_ids.ids : [],
      authoring: require('./platform-groups').groupCapabilities().authoring, extrasAuthoring: require('./platform-extras').extrasCapabilities().authoring,
      textEdit: require('./item-text-edit').textEditCapabilities().enabled, extrasCatalog,
    });
  }
  const activeKeys = new Set(active.extras.map((e) => e.key));
  if ((draftRecords.extras || []).some((e) => !activeKeys.has(e.key))) {
    if (!addProduct) return { unavailable: true };
    let keyMode, reserved;
    try { keyMode = AP.resolveKeyMode(await addProduct.readKeyMode(rid), live.items, draft.frozen_keys); reserved = await addProduct.readReservedKeys(rid); } catch (e) {
      if (e instanceof AP.AddProductError) throw e;
      return { unavailable: true };
    }
    require('./extras-validate').validateNewExtras({ extras: draftRecords.extras, activeExtras: active.extras, activeItems: live.items, keyMode, reserved, frozenExtraKeys: draft.frozen_extra_keys, mintExtras: require('./extra-identity').extraIdentityCapabilities().mintExtras });   // S2b: a minted row only with its recorded reuse
  }
  require('./structure-budget').enforce({ rid, source: draft, draft: draftRecords, active, extrasCatalog });
  return { ok: true };
}

module.exports = { judge };
