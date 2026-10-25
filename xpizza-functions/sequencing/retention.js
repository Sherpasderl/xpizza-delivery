'use strict';
// BUILD-stacked-seq-server r5 T9 / D10 — retention of stacks/{id}, a NEW isolated pass wired inside runRetentionSweep.
//   refused   → deleted once past expires_at + 1 day;
//   committed → deleted once decided_at is older than 7 days AND neither member's delivery task exists (while one does, the
//               detector and the reuse rule may still read it).
// Each delete is ONE transaction that re-checks the record it scanned (state + the timestamp that qualified it), so a record
// re-written meanwhile is never removed.
const DAY_MS = 24 * 3600 * 1000;
const COMMITTED_TTL_MS = 7 * DAY_MS;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

async function runStackPass(db, now) {
  const all = (await db.ref('stacks').once('value')).val() || {};
  let scanned = 0; let deleted = 0;
  for (const [id, rec] of Object.entries(all)) {
    scanned++;
    if (!rec || typeof rec !== 'object') continue;
    let still;
    if (rec.state === 'refused' && fin(rec.expires_at) && rec.expires_at + DAY_MS < now) {
      still = (c) => !!c && c.state === 'refused' && c.expires_at === rec.expires_at;
    } else if (rec.state === 'committed' && fin(rec.decided_at) && rec.decided_at + COMMITTED_TTL_MS < now && Array.isArray(rec.pair)) {
      const live = await Promise.all(rec.pair.map(async (oid) => (await db.ref(`tasks/${oid}_delivery`).once('value')).val() !== null));
      if (live.some(Boolean)) continue;
      still = (c) => !!c && c.state === 'committed' && c.decided_at === rec.decided_at;
    } else continue;
    const r = await db.ref(`stacks/${id}`).transaction((c) => (still(c) ? null : undefined));
    if (r && r.committed) deleted++;
  }
  return { scanned, deleted, kept: scanned - deleted };
}

module.exports = { runStackPass, DAY_MS, COMMITTED_TTL_MS };
