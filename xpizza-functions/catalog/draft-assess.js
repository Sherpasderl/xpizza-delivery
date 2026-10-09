'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A — IS THE SAVED DRAFT PUBLISHABLE AGAINST WHAT IS SERVING? (§0.1, §1 "poisoned draft")
// One answer, used by getEditableCatalog (so the portal can offer "Volver al menú publicado") and by the read-only
// tools/draft-drift-report.js (so the advisor can see, per brand, before deploy, whether a saved draft already
// drifts from the active catalog). The SAME checks a save runs: validate, build with publish's builder, and the
// structural comparison (honouring the D4-P1 deletion claim). Pure given its inputs; reads nothing itself.
// ---------------------------------------------------------------------------
const { validateSource, sourceToBuildInputs, rendererContract } = require('./source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const AP = require('./add-product');

// activeRes: { built: {items, structure}, extraRecords } (readActiveBuilt's shape)
function assessDraft(rid, source, activeRes) {
  try { validateSource(source, rid); } catch (e) {
    return { publishable: false, code: 'invalid_source', detail: String((e && e.message) || e).slice(0, 300) };
  }
  let built;
  try {
    const inputs = sourceToBuildInputs(source);
    built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable });
  } catch (e) {
    return { publishable: false, code: 'draft_unbuildable', detail: String((e && e.message) || e).slice(0, 300) };
  }
  try {
    const r = AP.compareToActive({
      draftBuilt: { items: built.items, extras: built.extras, structure: built.structure },
      activeBuilt: { items: activeRes.built.items, extras: activeRes.extraRecords, structure: activeRes.built.structure },
      draftAuthored: Object.keys(source.structure || {}),
      renderedCategories: rendererContract(rid).renderedCategories,
      deletedIds: source.deleted_ids && Array.isArray(source.deleted_ids.ids) ? source.deleted_ids.ids : [],
    });
    return { publishable: true, additions: r.additions, removals: r.removals };
  } catch (e) {
    if (e instanceof AP.AddProductError) return { publishable: false, code: e.code, detail: e.detail, ...(e.key ? { key: e.key } : {}), ...(e.field ? { field: e.field } : {}) };
    return { publishable: false, code: 'assessment_failed', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports = { assessDraft };
