'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A — IS THE SAVED DRAFT PUBLISHABLE AGAINST WHAT IS SERVING? (§0.1, §1 "poisoned draft")
// One answer, used by getEditableCatalog (so the portal can offer "Volver al menú publicado") and by the read-only
// tools/draft-drift-report.js (so the advisor can see, per brand, before deploy, whether a saved draft already
// drifts from the active catalog). The SAME checks a save runs: validate, build with publish's builder, and the
// structural comparison (honouring the D4-P1 deletion claim). Pure given its inputs; reads nothing itself.
// ---------------------------------------------------------------------------
const { validateSource, rendererContract } = require('./source-store');
const { buildSourceCandidate, assertBuiltValid } = require('./candidate-validate');
const AP = require('./add-product');
const { groupCapabilities } = require('./platform-groups');
const { extrasCapabilities } = require('./platform-extras');   // 1D add-product B: the SAME authoring switch a save is judged by

// activeRes: { built: {items, structure}, extraRecords } (readActiveBuilt's shape)
function assessDraft(rid, source, activeRes) {
  try { validateSource(source, rid); } catch (e) {
    return { publishable: false, code: 'invalid_source', detail: String((e && e.message) || e).slice(0, 300) };
  }
  let built;
  try {
    built = buildSourceCandidate(rid, source).built;
    assertBuiltValid(rid, built, `${rid} (assessment)`);   // codex build r1 #4: the same candidate validation publish runs
  } catch (e) {
    return { publishable: false, code: 'draft_unbuildable', detail: String((e && e.message) || e).slice(0, 300) };
  }
  try {
    const draftBuilt = { items: built.items, extras: built.extras, structure: built.structure };
    const activeBuilt = { items: activeRes.built.items, extras: activeRes.extraRecords, structure: activeRes.built.structure };
    const r = AP.compareToActive({
      draftBuilt,
      activeBuilt,
      draftAuthored: Object.keys(source.structure || {}),
      renderedCategories: rendererContract(rid).renderedCategories,
      deletedIds: source.deleted_ids && Array.isArray(source.deleted_ids.ids) ? source.deleted_ids.ids : [],
      // 1D add-product B (PB-3): judged by the switch the save was judged by — without it a SAVED, unpublished group read as
      // choices_not_supported_yet once authoring is on, and the reloaded editor offered "Volver al menú publicado" instead
      authoring: groupCapabilities().authoring,
      extrasAuthoring: extrasCapabilities().authoring,   // per-product extras (the narrow deny_extras / extras_policy exception)
    });
    // PLAN-public-menu-display T1 (portal r1 #3) — what the saved draft has PENDING against the published menu, from the SAME
    // comparison a save and a publish are judged by: the section names that differ (paired by index — compareToActive has
    // just proved the ids, order and count equal), and whether ANYTHING besides a name differs (changesNothingElse, the
    // rule rename_not_alone enforces). A publishable draft never has both: that is exactly rename_not_alone.
    const nameOf = (c) => (c && c.name !== undefined ? c.name : null);
    const ac = Array.isArray(activeBuilt.structure.categories) ? activeBuilt.structure.categories : [];
    const dc = Array.isArray(draftBuilt.structure.categories) ? draftBuilt.structure.categories : [];
    const renames = dc.map((c, i) => ({ id: c && c.id, from: nameOf(ac[i]), to: nameOf(c) })).filter((x) => x.from !== x.to);
    const other = !AP.changesNothingElse(draftBuilt, activeBuilt, r.additions, r.removals);
    return { publishable: true, additions: r.additions, removals: r.removals, renames, other };
  } catch (e) {
    if (e instanceof AP.AddProductError) return { publishable: false, code: e.code, detail: e.detail, ...(e.key ? { key: e.key } : {}), ...(e.field ? { field: e.field } : {}) };
    return { publishable: false, code: 'assessment_failed', detail: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports = { assessDraft };
