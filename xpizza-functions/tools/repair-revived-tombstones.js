#!/usr/bin/env node
'use strict';
// SECURITY BACKLOG r2 (advisor ruling 2, 2026-11-01) — the ONE-TIME owner migration that repairs REVIVED accounts. A legacy profile
// without phone_hash kept its phone_index on deletion, so a later phone login recreated the profile at the SAME uid while the
// deletion's tombstones stayed. Such an account is LIVE (it has orders / points after the deletion) but carries STALE tombstones:
// the deleted_uids-only checks refuse its attribution, and the user_private tombstone refuses its signup writes.
//
// A uid is REVIVED when ALL hold: user_private/{uid}/deleted_at is a number; user_profiles/{uid} EXISTS; the profile carries NO
// sweep claim (deleting_at); and its last_login is STRICTLY after deleted_at (activity after the deletion). For each, --apply clears
// user_private/{uid}/deleted_at and deleted_uids/{uid} when it is not after last_login (each ONE transaction that clears only the
// exact value it saw; the profile is re-checked at apply time). Never touched: truly deleted (no profile), claimed, or no later activity.
//
//   node tools/repair-revived-tombstones.js --project xpizza-delivery            (DRY RUN: prints the count + uids; writes nothing)
//   node tools/repair-revived-tombstones.js --project xpizza-delivery --apply    (OWNER-RUN, before the train that carries r2)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function candidates(rtdb) {
  const rows = (await rtdb.ref('user_private').orderByChild('deleted_at').startAt(0).once('value')).val() || {};
  const out = [];
  for (const [uid, row] of Object.entries(rows)) {
    if (!row || !isNum(row.deleted_at)) continue;
    const prof = (await rtdb.ref(`user_profiles/${uid}`).once('value')).val();
    if (!prof || prof.deleting_at != null || !(isNum(prof.last_login) && prof.last_login > row.deleted_at)) continue;
    out.push({ uid, deleted_at: row.deleted_at, last_login: prof.last_login });
  }
  return out.sort((a, b) => (a.uid < b.uid ? -1 : 1));
}

async function repair({ rtdb, apply = false }) {
  const list = await candidates(rtdb);
  if (!apply) return { ok: true, dryRun: true, count: list.length, uids: list.map((c) => c.uid) };
  let cleared = 0;
  for (const c of list) {
    const prof = (await rtdb.ref(`user_profiles/${c.uid}`).once('value')).val();   // re-checked at apply time
    if (!prof || prof.deleting_at != null || !(isNum(prof.last_login) && prof.last_login > c.deleted_at)) continue;
    const tx = await rtdb.ref(`user_private/${c.uid}`).transaction((cur) => {
      if (cur === null) return null;
      if (cur.deleted_at !== c.deleted_at) return undefined;   // changed since the read → leave it
      const { deleted_at, ...rest } = cur;   // eslint-disable-line no-unused-vars
      return Object.keys(rest).length ? rest : null;
    });
    if (!tx.committed) continue;
    await rtdb.ref(`deleted_uids/${c.uid}`).transaction((cur) => (cur === null ? null : (isNum(cur) && cur <= prof.last_login ? null : undefined)));
    cleared += 1;
  }
  return { ok: true, applied: true, count: list.length, cleared, uids: list.map((c) => c.uid) };
}

module.exports = { candidates, repair };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  (async () => {
    const r = await repair({ rtdb: admin.database(), apply: argv.includes('--apply') });
    for (const u of r.uids) console.log(`  revived: ${u}`);
    console.log(r.dryRun ? `DRY RUN — ${r.count} revived account(s) carry stale tombstones (add --apply)` : `applied — cleared ${r.cleared} of ${r.count}`);
    process.exit(0);
  })().catch((e) => { console.error('repair-revived-tombstones: FAILED —', e && e.code ? e.code : 'error'); process.exit(1); });
}
