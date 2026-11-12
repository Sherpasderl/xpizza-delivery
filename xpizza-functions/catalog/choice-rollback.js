'use strict';
// S3 (PLAN-structure-S3-r3 §1c) — rollback is an ACTIVATION: with choiceEdit ON, the version a rollback would restore (target) is judged
// against the version its flip REPLACES — expected.activeVersionId, the pointer flipPointer's CAS binds (a concurrent publish fails
// that CAS, so no activation is ever judged against a pointer it does not replace) — by the ONE classifier (choice-activation). Both
// versions are read through the ONE version reader and rebuilt exactly as the pre-flip check rebuilds them (candidateSource →
// buildSourceCandidate). OFF: nothing is read, today's rollback. Called by catalog-publish rollbackVersion before the pointer moves.
const { readVersionMenu } = require('./catalog-menu');
const { candidateSource, buildSourceCandidate } = require('./candidate-validate');
const { choiceActivation } = require('./choice-activation');

async function assertRollbackChoices(db, rid, targetVersionId, expected) {
  if (!require('./platform-structure').structureCapabilities().choiceEdit) return;
  const baseId = expected && typeof expected.activeVersionId === 'string' ? expected.activeVersionId : null;
  if (!baseId || baseId === targetVersionId) return;   // no live version to replace (the flip's own refusals apply)
  const built = (v) => buildSourceCandidate(rid, candidateSource(rid, { items: v.items, extras: v.extras, structure: v.structure, key_mode: v.keyMode, frozen_keys: v.frozenKeys })).built;
  const [b, t] = await Promise.all([readVersionMenu(db, rid, baseId), readVersionMenu(db, rid, targetVersionId)]);
  choiceActivation({ rid, baseline: built(b), target: built(t), choiceEdit: true });
}

module.exports = { assertRollbackChoices };
