'use strict';
// S3 (PLAN-structure-S3-r4 §1c; Codex build r1 P1-1 / P1-2) — EVERY activation is judged at the one boundary every path shares: publishVersion
// and rollbackVersion call this right before flipPointer, inside the lease. With choiceEdit ON, the version being activated (target) is
// judged against the version the flip REPLACES — expected.activeVersionId, the pointer flipPointer's CAS binds, so a concurrent publish
// fails that CAS and no activation is judged against a pointer it does not replace — by:
//   · the ONE classifier (choice-activation): the reward-dish refusal, exactly one «Recomendada» per touched group, the D3 price
//   · the served-shape rule: a version WITHOUT variant_items never replaces one that HAS it (choice_groups_would_vanish, 409) — a frozen
//     form keeps its retained map when the field is absent, so the next update would be refused (Codex build r1 P1-2; ruled: refuse)
// Both versions are read through the ONE version reader and rebuilt as the pre-flip check rebuilds them. OFF: nothing is read (today).
const { readVersionMenu } = require('./catalog-menu');
const { candidateSource, buildSourceCandidate } = require('./candidate-validate');
const { choiceActivation } = require('./choice-activation');
const { AddProductError } = require('./add-product');

async function assertActivationChoices(db, rid, targetVersionId, expected) {
  if (!require('./platform-structure').structureCapabilities().choiceEdit) return;
  const baseId = expected && typeof expected.activeVersionId === 'string' ? expected.activeVersionId : null;
  if (!baseId || baseId === targetVersionId) return;   // a first publish has no version to replace (the flip's own refusals apply)
  const built = (v) => buildSourceCandidate(rid, candidateSource(rid, { items: v.items, extras: v.extras, structure: v.structure, key_mode: v.keyMode, frozen_keys: v.frozenKeys })).built;
  const [b, t] = await Promise.all([readVersionMenu(db, rid, baseId), readVersionMenu(db, rid, targetVersionId)]);
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  if (own(b.structure, 'variant_items') && !own(t.structure, 'variant_items')) {
    throw new AddProductError('choice_groups_would_vanish', 'this version has no choice groups at all, while the live menu does — it cannot replace it (publish a version that keeps them)', { status: 409, field: 'choices' });
  }
  choiceActivation({ rid, baseline: built(b), target: built(t), choiceEdit: true });
}

module.exports = { assertActivationChoices, assertRollbackChoices: assertActivationChoices };
