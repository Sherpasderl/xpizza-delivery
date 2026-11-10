'use strict';
// DISH PHOTOS A2 step 12 (PLAN-dish-photos r2 §2.2 E-P4 + amendment 2026-10-27) — the manager's read-only photos on getBranchAvailability:
// PER BRANCH ENTRY, `photos: {[itemKey]: {card}}` from THAT branch's ACTIVE version's meta/photos — pid entries only, their published
// card URL only (never a draft). Omitted when empty. A read failure omits it for that branch only; the availability answer stands.
// (Multi-branch views union by itemKey in scope order, first wins — that is the portal's job, from these per-branch maps.)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cardsFrom(entries) {
  const out = {};
  for (const [key, e] of Object.entries(isObj(entries) ? entries : {})) if (isObj(e) && e.state === 'pid' && typeof e.card === 'string' && e.card) out[key] = { card: e.card };
  return Object.keys(out).length ? out : null;
}

async function branchPhotosOf(fs, rid, versionId, read, log = console) {
  if (!versionId) return null;
  try {
    const doc = await read(fs, rid, versionId);
    if (doc === null || doc === undefined) return null;
    if (!(isObj(doc) && doc.schema === 1 && isObj(doc.entries))) throw new Error('malformed meta/photos');
    return cardsFrom(doc.entries);
  } catch (e) {
    log.warn(JSON.stringify({ evt: 'branch_photos_unavailable', rid, code: (e && e.code) || 'error' }));
    return null;
  }
}

module.exports = { cardsFrom, branchPhotosOf };
