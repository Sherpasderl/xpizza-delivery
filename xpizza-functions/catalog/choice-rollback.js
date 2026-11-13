'use strict';
// S3 (PLAN-structure-S3-r4 §1c; Codex build r1 P1-1 / P1-2) — EVERY activation is judged at the one boundary every path shares: publishVersion
// and rollbackVersion call this right before flipPointer, inside the lease. With choiceEdit ON, the version being activated (target) is
// judged against the version the flip REPLACES — expected.activeVersionId, the pointer flipPointer's CAS binds, so a concurrent publish
// fails that CAS and no activation is judged against a pointer it does not replace — by:
//   · the ONE classifier (choice-activation): the reward-dish refusal, exactly one «Recomendada» per touched group, the D3 price
//   · the served-shape rule: a version WITHOUT variant_items never replaces one that HAS it (choice_groups_would_vanish, 409) — a frozen
//     form keeps its retained map when the field is absent, so the next update would be refused (Codex build r1 P1-2; ruled: refuse)
// Both versions are read through the ONE version reader and rebuilt as the pre-flip check rebuilds them (choiceEdit ON). The shape rule is
// UNGATED (advisor 11-12): it reads only the two structure documents, whatever the switch.
const { readVersionMenu } = require('./catalog-menu');
const { candidateSource, buildSourceCandidate } = require('./candidate-validate');
const { choiceActivation } = require('./choice-activation');
const { AddProductError } = require('./add-product');

async function assertActivationChoices(db, rid, targetVersionId, expected) {
  const baseId = expected && typeof expected.activeVersionId === 'string' ? expected.activeVersionId : null;
  if (!baseId || baseId === targetVersionId) return;   // a first publish has no version to replace (the flip's own refusals apply)
  // THE SHAPE RULE — UNGATED (advisor 11-12: a fix of a live hole; a deliberate OFF-behaviour change). Two small reads (each version's own
  // structure document); it refuses ONLY a target with no variant_items over a replaced version whose groups map is NON-EMPTY (groups a frozen form may have
  // retained) — never a never-grouped restaurant, never a version that keeps variant_items: {}, never {} → absent (nothing retained to orphan).
  const structureOf = (v) => db.collection('restaurants').doc(rid).collection('versions').doc(v).collection('meta').doc('menu_structure').get();
  const [bs, ts] = await Promise.all([structureOf(baseId), structureOf(targetVersionId)]);
  const data = (snap) => (snap && snap.exists ? (snap.data() || {}) : null);
  const b0 = data(bs); const t0 = data(ts);
  const liveGroups = !!b0 && b0.variant_items && typeof b0.variant_items === 'object' && Object.keys(b0.variant_items).length > 0;   // groups a form may RETAIN
  if (liveGroups && t0 && !Object.prototype.hasOwnProperty.call(t0, 'variant_items')) {
    throw new AddProductError('choice_groups_would_vanish', 'this version has no choice groups at all, while the live menu does — it cannot replace it (publish a version that keeps them)', { status: 409, field: 'choices' });
  }
  if (!require('./platform-structure').structureCapabilities().choiceEdit) return;   // the classifier: choiceEdit ON only
  const built = (v) => buildSourceCandidate(rid, candidateSource(rid, { items: v.items, extras: v.extras, structure: v.structure, key_mode: v.keyMode, frozen_keys: v.frozenKeys })).built;
  const [b, t] = await Promise.all([readVersionMenu(db, rid, baseId), readVersionMenu(db, rid, targetVersionId)]);
  choiceActivation({ rid, baseline: built(b), target: built(t), choiceEdit: true });
}

module.exports = { assertActivationChoices, assertRollbackChoices: assertActivationChoices };
