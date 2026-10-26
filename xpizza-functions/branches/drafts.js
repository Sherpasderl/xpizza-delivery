'use strict';
// ORCHESTRATION O1b T1b (PLAN-orch-o1b r3) — the DRAFT binding. A draft lives only at restaurants/{rid}/draft (no identity, no
// roster entry), so it is real only when its node names the brand AND that brand's op-id mapping for the draft's op points back to
// this rid (branch_op_ids/{b}/{draft.op_id}.rid === rid — the O1a writer sets the mapping's rid before it writes the draft). E1's
// draft listing, E7 on a draft and E10 all go through this one predicate; the writers re-check it under the brand lock.
// Drafts are OWNER-only (brand.locations); no location capability ever applies to a draft.
const { isBrandId } = require('../brands/brand-model');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();

// the pure predicate over already-read nodes
function boundDraft(brandId, rid, draft, identity, mapping) {
  return isObj(draft) && identity == null && draft.brand_id === brandId && typeof draft.op_id === 'string'
    && isObj(mapping) && mapping.rid === rid;
}

async function draftBinding(db, brandId, rid) {
  if (!isBrandId(brandId) || !isBrandId(rid)) return { ok: false };
  const [draft, identity] = [await val(db, `restaurants/${rid}/draft`), await val(db, `restaurants/${rid}/identity`)];
  if (!isObj(draft) || typeof draft.op_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(draft.op_id)) return { ok: false };
  const mapping = await val(db, `branch_op_ids/${brandId}/${draft.op_id}`);
  return boundDraft(brandId, rid, draft, identity, mapping) ? { ok: true, draft, mapping } : { ok: false };
}

// every bound draft of a brand, discovered from its op-id mappings (a mapping without a rid, or one whose draft is gone /
// materialized / foreign, is skipped). Sorted by rid. A read failure throws.
async function draftsOfBrand(db, brandId) {
  const maps = (await val(db, `branch_op_ids/${brandId}`)) || {};
  const out = [];
  for (const mp of Object.values(isObj(maps) ? maps : {})) {
    if (!isObj(mp) || typeof mp.rid !== 'string' || !isBrandId(mp.rid)) continue;
    const b = await draftBinding(db, brandId, mp.rid);
    if (b.ok) out.push({ rid: mp.rid, draft: b.draft });
  }
  return out.sort((a, z) => (a.rid < z.rid ? -1 : a.rid > z.rid ? 1 : 0));
}

module.exports = { boundDraft, draftBinding, draftsOfBrand };
