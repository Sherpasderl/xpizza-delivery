'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.3) — the ONLY kitchen-roster migration path: the reviewed mapping
// {kitchen: {uid: {rids, kind, deployment?}}} → restaurants/{rid}/kitchen_staff/{uid}. DRY RUN unless apply: the plan is the exact
// diff (adds AND removes — an extra membership is unintended access). Apply = ONE multi-path update, then every touched path is
// read back. The old blanket seed (seed-kitchen-staff.mjs: every kitchen uid on every rid) is never a source of authorization.
const { validateMapping } = require('./access-census-core');

async function planRoster({ rtdb, mapping, locations, kitchenDeployments }) {
  const errs = validateMapping(mapping, locations, kitchenDeployments);
  if (errs.length) return { errors: errs };
  const want = new Set(); for (const [uid, e] of Object.entries(mapping.kitchen)) for (const r of e.rids) want.add(`${r}|${uid}`);
  const have = new Set();
  for (const rid of locations) for (const uid of Object.keys((await rtdb.ref(`restaurants/${rid}/kitchen_staff`).once('value')).val() || {})) have.add(`${rid}|${uid}`);
  const add = [...want].filter((k) => !have.has(k)).sort().map((k) => { const [rid, uid] = k.split('|'); return { rid, uid }; });
  const remove = [...have].filter((k) => !want.has(k)).sort().map((k) => { const [rid, uid] = k.split('|'); return { rid, uid }; });
  return { add, remove };
}

async function runKitchenRoster({ rtdb, mapping, locations, kitchenDeployments, apply, log }) {
  const plan = await planRoster({ rtdb, mapping, locations, kitchenDeployments });
  if (plan.errors) { for (const e of plan.errors) log(`REFUSED — ${e}`); return 2; }
  for (const a of plan.add) log(`+ restaurants/${a.rid}/kitchen_staff/${a.uid}`);
  for (const r of plan.remove) log(`- restaurants/${r.rid}/kitchen_staff/${r.uid}`);
  if (!plan.add.length && !plan.remove.length) { log('roster already equals the mapping — nothing to write'); return 0; }
  if (!apply) { log(`DRY RUN: ${plan.add.length} add, ${plan.remove.length} remove (re-run with --apply)`); return 0; }
  const u = {};
  for (const a of plan.add) u[`restaurants/${a.rid}/kitchen_staff/${a.uid}`] = true;
  for (const r of plan.remove) u[`restaurants/${r.rid}/kitchen_staff/${r.uid}`] = null;
  await rtdb.ref().update(u);
  for (const [p, v] of Object.entries(u)) {
    const got = (await rtdb.ref(p).once('value')).val();
    if ((v === true && got !== true) || (v === null && got !== null)) { log(`READ-BACK FAILED at ${p}`); return 1; }
  }
  log(`applied: ${plan.add.length} add, ${plan.remove.length} remove (read back)`);
  return 0;
}

module.exports = { planRoster, runKitchenRoster };
