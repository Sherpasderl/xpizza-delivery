'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.3) — the ONLY kitchen-roster migration path: the reviewed mapping
// {kitchen: {uid: {rids, kind, deployment?}}} → restaurants/{rid}/kitchen_staff/{uid}. The mapping is validated FIRST by the same
// validator the census runs (terminal = exactly one location, deployment context consistent, every id a valid RTDB key — codex
// Q1 r1 P1-2/P2-3) and an invalid mapping is REFUSED before any read of the roster or any write. The plan is the exact diff over
// EVERY actual roster (orphan restaurants included — codex P2-5): adds AND removes, as structured {rid, uid} pairs (never a joined
// string key). DRY RUN unless apply. Apply = ONE multi-path update, then every touched path is read back. The old blanket seed
// (seed-kitchen-staff.mjs: every kitchen uid on every rid) is never a source of authorization.
const { validateMapping, readWorld } = require('./access-census-core');

async function planRoster({ rtdb, mapping, kitchenDeployments, pageSize }) {
  const { locations, rosters } = await readWorld(rtdb, pageSize);
  const errs = validateMapping(mapping, locations, kitchenDeployments);
  if (errs.length) return { errors: errs };
  const want = []; for (const [uid, e] of Object.entries(mapping.kitchen)) for (const rid of e.rids) want.push({ rid, uid });
  const isWanted = (rid, uid) => !!(mapping.kitchen[uid] && mapping.kitchen[uid].rids.includes(rid));
  const isHad = (rid, uid) => (rosters.get(rid) || []).includes(uid);
  const byPair = (a, b) => (a.rid === b.rid ? (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0) : a.rid < b.rid ? -1 : 1);
  const add = want.filter((p) => !isHad(p.rid, p.uid)).sort(byPair);
  const remove = [];
  for (const [rid, uids] of rosters) for (const uid of uids) if (!isWanted(rid, uid)) remove.push({ rid, uid });
  remove.sort(byPair);
  return { add, remove };
}

async function runKitchenRoster({ rtdb, mapping, kitchenDeployments, apply, log, pageSize = 200 }) {
  const plan = await planRoster({ rtdb, mapping, kitchenDeployments, pageSize });
  if (plan.errors) { for (const e of plan.errors) log(`REFUSED — ${e}`); return 2; }
  const at = (p) => `restaurants/${p.rid}/kitchen_staff/${p.uid}`;
  for (const a of plan.add) log(`+ ${at(a)}`);
  for (const r of plan.remove) log(`- ${at(r)}`);
  if (!plan.add.length && !plan.remove.length) { log('roster already equals the mapping — nothing to write'); return 0; }
  if (!apply) { log(`DRY RUN: ${plan.add.length} add, ${plan.remove.length} remove (re-run with --apply)`); return 0; }
  const u = {};   // inline literal-prefixed keys (restaurants/*/kitchen_staff/*) so the R3 write inventory sees the static prefix
  for (const a of plan.add) u[`restaurants/${a.rid}/kitchen_staff/${a.uid}`] = true;
  for (const r of plan.remove) u[`restaurants/${r.rid}/kitchen_staff/${r.uid}`] = null;
  await rtdb.ref().update(u);
  for (const p of [...plan.add.map((x) => [x, true]), ...plan.remove.map((x) => [x, null])]) {
    const got = (await rtdb.ref(at(p[0])).once('value')).val();
    if ((p[1] === true && got !== true) || (p[1] === null && got !== null)) { log(`READ-BACK FAILED at ${at(p[0])}`); return 1; }
  }
  log(`applied: ${plan.add.length} add, ${plan.remove.length} remove (read back)`);
  return 0;
}

module.exports = { planRoster, runKitchenRoster };
