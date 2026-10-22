'use strict';
// ORCHESTRATION O1a — Codex r3 #1(d): the READ-ONLY lifecycle consistency check behind `branches-admin check <brand>` (the safety net
// for the one stated residual window of the lifecycle lock — see orch-o1a ledger). It writes nothing. Findings, each with its rid:
//   listed_without_branch   the brand lists a staged rid with neither a draft nor an identity
//   listed_without_identity the brand lists a member / retired rid with no identity
//   draft_without_brand     a draft of this brand whose brand record is gone
//   draft_without_reservation / draft_without_mapping   a draft its (brand, op) allocation does not back
//   draft_and_identity      a rid holding both (materialize writes one and removes the other atomically)
//   identity_not_listed     an identity of this brand its brand does not list
//   orphan_reservation / orphan_mapping   allocation records of this brand whose rid has no draft and no identity (a mapping with no rid
//                           at all — an incomplete or stray create — is an orphan_mapping too, keyed by op id)
//   orphan_name             a name reservation of this brand no op-id mapping owns
// The brand's lifecycle lock is reported alongside: while one is held, findings may be its unfinished work (resume it first).
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function checkBrand(db, brandId, { now = Date.now() } = {}) {
  const [brand, lock, restaurants, reservations, maps, names] = await Promise.all([val(db, `brands/${brandId}`), val(db, `brand_ops/${brandId}`), val(db, 'restaurants'),
    val(db, 'rid_reservations'), val(db, `branch_op_ids/${brandId}`), val(db, `brand_branch_names/${brandId}`)]);
  const R = isObj(restaurants) ? restaurants : {}; const RES = isObj(reservations) ? reservations : {};
  const MAPS = isObj(maps) ? maps : {}; const NAMES = isObj(names) ? names : {};
  const locs = isObj(brand) && isObj(brand.locations) ? brand.locations : {};
  const node = (rid) => (isObj(R[rid]) ? R[rid] : {});
  const findings = [];
  for (const [rid, st] of Object.entries(locs)) {
    const { draft, identity } = node(rid);
    if (st === 'staged') { if (draft == null && identity == null) findings.push({ code: 'listed_without_branch', rid }); } else if (identity == null) findings.push({ code: 'listed_without_identity', rid });
  }
  for (const [rid, r] of Object.entries(R)) {
    if (!isObj(r)) continue;
    if (isObj(r.draft) && r.draft.brand_id === brandId) {
      if (!isObj(brand)) findings.push({ code: 'draft_without_brand', rid });
      const rv = RES[rid];
      if (!(isObj(rv) && rv.brand_id === brandId && rv.op_id === r.draft.op_id)) findings.push({ code: 'draft_without_reservation', rid });
      const mp = MAPS[r.draft.op_id];
      if (!(isObj(mp) && mp.rid === rid)) findings.push({ code: 'draft_without_mapping', rid });
      if (r.identity != null) findings.push({ code: 'draft_and_identity', rid });
    }
    if (isObj(r.identity) && r.identity.brand_id === brandId && !(rid in locs)) findings.push({ code: 'identity_not_listed', rid });
  }
  for (const [rid, rv] of Object.entries(RES)) {
    if (isObj(rv) && rv.brand_id === brandId && node(rid).draft == null && node(rid).identity == null) findings.push({ code: 'orphan_reservation', rid });
  }
  for (const [opId, mp] of Object.entries(MAPS)) {   // EVERY mapping must resolve to a live draft / identity — an incomplete one (no rid) too (Codex r4 #2)
    const rid = isObj(mp) && typeof mp.rid === 'string' ? mp.rid : null;
    if (rid === null || (node(rid).draft == null && node(rid).identity == null)) findings.push({ code: 'orphan_mapping', op_id: opId, rid });
  }
  for (const [nk, nm] of Object.entries(NAMES)) if (!(isObj(nm) && typeof nm.op_id === 'string' && isObj(MAPS[nm.op_id]))) findings.push({ code: 'orphan_name', name: nk });
  const held = isObj(lock) ? { kind: lock.kind || null, step: lock.step || null, rid: (isObj(lock.inputs) && lock.inputs.rid) || null,
    interrupted: !(isObj(lock.lease) && Number.isFinite(lock.lease.until) && lock.lease.until > now) } : null;
  return { brand: brandId, findings, lock: held };
}

module.exports = { checkBrand };
