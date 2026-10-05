#!/usr/bin/env node
'use strict';
// P-SELFUPDATE — the OWNER's floor CLI. DRY RUN unless --apply.
//
//   node tools/client-floor.js --project <id> kitchen set|raise <N> [--apply] [--force]
//   node tools/client-floor.js --project <id> kitchen delete [--apply]        ← the KITCHEN KILL SWITCH (all restaurants)
//   node tools/client-floor.js --project <id> orders  set|raise <N> [--apply] [--force]
//   node tools/client-floor.js --project <id> orders  delete [--apply]        ← the HTTP floor OFF (instances re-read within one TTL)
//   node tools/client-floor.js --project <id> status                          ← every floor, read-only
//
// Kitchen: ONE multi-path update covering every restaurant (RTDB restaurants with an identity ∪ the registry). Read back
// after writing. Rollback ordering (PLAN §6): to undo D4-c, FIRST restore server/data behaviour compatible with older
// pages, THEN lower or delete floors; the kitchen kill switch may be used at any time if the rule itself misbehaves.
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject();      // FIRST: states the project, before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { planFloor, listRestaurants, readCurrent, applyPlan, ORDERS_PATH } = require('./client-floor-admin');
const { PLATFORM } = require('../platform-manifest');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project') && a !== PROJECT_ID);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const pos = args.filter((a) => !a.startsWith('--'));
const usage = () => { console.error('usage: client-floor.js --project <id> (kitchen|orders) (set|raise <N> | delete) [--apply] [--force] | status'); process.exit(2); };

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();

(async () => {
  const registryIds = await makeFirestoreRegistryReader(admin.firestore())().catch(() => []);
  const rids = await listRestaurants(rtdb, registryIds);
  if (pos[0] === 'status') {
    const k = await readCurrent(rtdb, 'kitchen', rids);
    const o = await readCurrent(rtdb, 'orders', rids);
    console.log(JSON.stringify({ project: PROJECT_ID, kitchen: k, orders: o[ORDERS_PATH], compat: PLATFORM.compat.generations }, null, 2));
    process.exit(0);
  }
  const [kind, op, raw] = pos;
  if (!kind || !op || (op !== 'delete' && raw === undefined)) usage();
  const value = op === 'delete' ? null : Number(raw);
  const current = await readCurrent(rtdb, kind, rids);
  const plan = planFloor({ kind, op, value, current, rids, maxCompat: PLATFORM.maxCompat(kind), force: FORCE });
  if (!plan.ok) { console.error(`client-floor: REFUSED — ${plan.error}`); process.exit(1); }
  console.log(`client-floor ${APPLY ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}, ${kind} ${op}${value === null ? '' : ` ${value}`}`);
  for (const r of plan.rows) console.log(`  ${r.path}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  if (!APPLY) { console.log('(dry run — nothing written; add --apply)'); process.exit(0); }
  const res = await applyPlan(rtdb, plan);
  if (!res.ok) { console.error(`client-floor: READ-BACK MISMATCH — ${res.mismatched.join('; ')}`); process.exit(1); }
  console.log(`client-floor: applied in ONE update and read back (${plan.rows.length} path(s))`);
  process.exit(0);
})().catch((e) => { console.error('client-floor FAILED:', e && e.message); process.exit(1); });
