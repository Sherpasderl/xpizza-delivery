#!/usr/bin/env node
'use strict';
// fix/privacy-gaps-5f (Codex #133 r1 HIGH 1) — the ONE-TIME owner upgrade for accounts deleted BEFORE the deletion core fenced the saved
// cards. Their profile is gone, so the sweep never selects them again, and pruneResidual never touches customer_cards: their
// customer_cards/{uid} (tokens, hashes, rows) would stay forever. This tool writes the SAME fence the deletion core now writes,
// customer_cards/{uid} = { _deleted: at }, so every reader sees nothing and a late vault write drops (payments/sdk/cards completeVault).
//
// A uid is fenced ONLY when it is AUTHORITATIVELY deleted, the deletion core's own test: tombstoned (deleted_uids/{uid} OR
// user_private/{uid}/deleted_at — signup-core isTombstoned) AND no user_profiles/{uid}. A profile present (a live account, a REVIVED
// one carrying a stale tombstone, or one a sweep has claimed and is deleting now) is NEVER touched — the profile is re-checked right
// before the write, and no login path ever creates a profile at a tombstoned uid (signup-endpoints loginUid). `at` is the account's own
// deletion instant (deleted_uids, else user_private.deleted_at). One transaction per node; an existing fence is never rewritten.
//
//   node tools/fence-deleted-cards.js --project xpizza-delivery            (DRY RUN: counts only; writes nothing)
//   node tools/fence-deleted-cards.js --project xpizza-delivery --apply    (OWNER-RUN, after the deploy that carries the fence)
// Output: counts only — never a uid, token or hash.
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// every tombstoned uid → its deletion instant (deleted_uids first, then user_private.deleted_at)
async function tombstoned(rtdb) {
  const out = new Map();
  const du = (await rtdb.ref('deleted_uids').once('value')).val() || {};
  for (const [uid, at] of Object.entries(du)) if (isNum(at)) out.set(uid, at);
  const up = (await rtdb.ref('user_private').orderByChild('deleted_at').startAt(0).once('value')).val() || {};
  for (const [uid, row] of Object.entries(up)) if (!out.has(uid) && row && isNum(row.deleted_at)) out.set(uid, row.deleted_at);
  return out;
}

async function fence({ rtdb, apply = false }) {
  const r = { dryRun: !apply, tombstoned: 0, live: 0, noCards: 0, alreadyFenced: 0, fenced: 0 };
  for (const [uid, at] of [...(await tombstoned(rtdb))].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    r.tombstoned += 1;
    if ((await rtdb.ref(`user_profiles/${uid}`).once('value')).exists()) { r.live += 1; continue; }
    const cur = (await rtdb.ref(`customer_cards/${uid}`).once('value')).val();
    if (cur == null) { r.noCards += 1; continue; }
    if (isObj(cur) && cur._deleted !== undefined) { r.alreadyFenced += 1; continue; }
    if (!apply) { r.fenced += 1; continue; }
    if ((await rtdb.ref(`user_profiles/${uid}`).once('value')).exists()) { r.live += 1; continue; }   // re-checked at apply time
    let seen = null;
    await rtdb.ref(`customer_cards/${uid}`).transaction((c) => {
      seen = null;
      if (c == null) { seen = 'none'; return null; }   // null-first: a no-op write, retried with the server value
      if (isObj(c) && c._deleted !== undefined) { seen = 'fenced'; return undefined; }
      seen = 'cards'; return { _deleted: at };
    });
    if (seen === 'cards') r.fenced += 1; else if (seen === 'fenced') r.alreadyFenced += 1; else r.noCards += 1;
  }
  return r;
}

module.exports = { tombstoned, fence };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  (async () => {
    const r = await fence({ rtdb: admin.database(), apply: argv.includes('--apply') });
    console.log(`fence-deleted-cards ${r.dryRun ? 'DRY RUN' : 'APPLY'} — project ${PROJECT_ID}`);
    console.log(`tombstoned ${r.tombstoned}: live/revived/claimed (never touched) ${r.live}, no saved cards ${r.noCards}, already fenced ${r.alreadyFenced}, ${r.dryRun ? 'would fence' : 'fenced'} ${r.fenced}`);
    if (r.dryRun) console.log('(dry run — nothing written; add --apply)');
    process.exit(0);
  })().catch((e) => { console.error('fence-deleted-cards: FAILED —', e && e.code ? e.code : 'error'); process.exit(1); });
}
