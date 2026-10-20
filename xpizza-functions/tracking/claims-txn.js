'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 4 claims) — seq-valued, tombstoned hint index. Every write applies ONLY if
// s > stored.seq; a recompute never hard-deletes (the retention sweep removes old tombstones). Pure updaters.
const newer = (cur, s) => !cur || typeof cur.seq !== 'number' || s > cur.seq;
const grantUpdater = (s, at) => (cur) => (newer(cur, s) ? { seq: s, gone: false, at } : undefined);
const tombstoneUpdater = (s, at) => (cur) => (newer(cur, s) ? { seq: s, gone: true, at } : undefined);
const ownerHintUpdater = (s, uid, at) => (cur) => (newer(cur, s) ? { seq: s, uid: uid || null, gone: !uid, at } : undefined);
module.exports = { grantUpdater, tombstoneUpdater, ownerHintUpdater };
