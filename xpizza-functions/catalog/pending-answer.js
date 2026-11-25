'use strict';
// S3 r1 — the writers' side of has_pending (the save and the owner publish): the review line model's answer over the canonical diff. Kept
// OUT of catalog/pending-summary.js so getMyBranches' static closure never carries the model (portal/ops-split pins that closure).
// Every top-level field a review diff carries today. The model draws from all but `fiscal` / `reach` (facts the screen never lists as
// lines). A field NOT here makes the answer null (unknown) — a new diff facet is a decision (PS-CLASSIFY pins it against real diffs).
const KNOWN_FIELDS = Object.freeze(['added', 'removed', 'renamed', 'changed', 'largeChangeSet', 'consequences', 'extras', 'structure', 'attachments', 'choices', 'sections', 'fiscal', 'reach']);

/* pendingOf(diff, ctx) → true | false | null — the review model's own answer; null for anything it cannot classify */
function pendingOf(diff, ctx) {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
  if (Object.keys(diff).some((k) => !KNOWN_FIELDS.includes(k))) return null;
  try { return require('./review-lines').hasPending(diff, ctx || {}) === true; } catch (_) { return null; }
}

/* ctxOf(source, liveItems) — the model's context from the SAVED draft source, as app.js builds it (a removed row from live) */
function ctxOf(source, liveItems) {
  const rows = Array.isArray(liveItems) ? liveItems : [];
  try { return require('./review-lines').reviewCtxFromSource(source || {}, { removedRowFor: (k) => rows.find((r) => r && r.key === k) || null }); } catch (_) { return {}; }
}

module.exports = { pendingOf, ctxOf, KNOWN_FIELDS };
