'use strict';
// ORCHESTRATION O1b T2 (PLAN-orch-o1b r3) — the activation-readiness TEAM reader (O1a injected it; absent = fail closed).
// teamCount = the brand's owners + THIS branch's managers (advisor Q5: an owner counts, so a portal-created branch normally
// passes no_owner_or_manager). A read failure THROWS: the caller refuses `unavailable`, never no_owner_or_manager from an outage.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function teamCount(db, brandId, rid) {
  const [owners, managers] = [await val(db, `brand_members/${brandId}/owners`), await val(db, `brand_members/${brandId}/managers/${rid}`)];
  const count = (m) => (isObj(m) ? Object.values(m).filter(isObj).length : 0);
  return count(owners) + count(managers);
}

// the readers object the O1a writers take: { teamCount(rid) }
const portalReaders = (db, brandId) => ({ teamCount: (rid) => teamCount(db, brandId, rid) });

module.exports = { teamCount, portalReaders };
